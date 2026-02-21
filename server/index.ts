import { createServer, type Server as HttpServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { DeskThing } from '@deskthing/server';
import { DESKTHING_EVENTS, SocketData, type AppSettings } from '@deskthing/types';
import { MusicAssistantClient } from './ma/client';
import type { MAEventMessage, MAPlayer, MAQueue, MAQueueItem } from './ma/types';
import {
  getMusicAssistantSettings,
  initSettings,
  refreshSettings,
  type MusicAssistantSettings,
} from './settings';

type SocketRequest = SocketData & {
  request?: string;
  payload?: unknown;
};

type TransportCommand = 'play' | 'pause' | 'play_pause' | 'next' | 'previous' | 'stop';
type RepeatMode = 'off' | 'one' | 'all';
type VolumeControlScope = 'selected' | 'group';

interface NowPlayingSummary {
  title: string;
  artist: string;
  album: string;
  imageUrl: string | null;
  imageProvider: string | null;
  duration: number | null;
  position: number | null;
  isPlaying: boolean;
}

interface StatePayload {
  selectedPlayerId: string | null;
  player: MAPlayer | null;
  queue: MAQueue | null;
  queueItems: MAQueueItem[];
  nowPlaying: NowPlayingSummary | null;
  updatedAt: number;
}

type LibraryMediaType = 'artists' | 'albums' | 'tracks' | 'playlists';

interface LibraryItemSummary {
  uri: string | null;
  mediaType: LibraryMediaType;
  name: string;
  subtitle: string;
  imageUrl: string | null;
  provider: string | null;
}

interface AuthProvider {
  provider_id: string;
  provider_type: string;
  requires_redirect: boolean;
}

interface AuthorizationUrlResult {
  authorization_url: string;
}

const APP_ID = 'musicassistant-webapp';

const maClient = new MusicAssistantClient();

let started = false;
let pollingTimer: NodeJS.Timeout | null = null;
let scheduledPoll: NodeJS.Timeout | null = null;
let pollInFlight = false;
let pollAgain = false;

let selectedPlayerId: string | null = null;
let playersCache: MAPlayer[] = [];
let queuesCache: MAQueue[] = [];
let queueItemsCache: MAQueueItem[] = [];
let oauthFlowInProgress = false;
let oauthServer: HttpServer | null = null;
let oauthTimeout: NodeJS.Timeout | null = null;
const imageCache = new Map<string, { dataUri: string; fetchedAt: number }>();

const IMAGE_CACHE_TTL_MS = 5 * 60 * 1000;

const unsubscribers: Array<() => void> = [];

function emit(type: string, payload: unknown): void {
  DeskThing.send({ app: APP_ID, type, payload });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readArray(record: Record<string, unknown> | null, key: string): unknown[] {
  if (!record) return [];
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function emitStatus(): void {
  const status = maClient.getStatus();
  emit('maStatus', {
    ...status,
    selectedPlayerId,
    at: Date.now(),
  });
}

function emitError(request: string, message: string): void {
  emit('maError', {
    request,
    message,
    at: Date.now(),
  });
}

function emitOAuthState(
  phase: 'starting' | 'browser_opened' | 'waiting_callback' | 'token_received' | 'success' | 'error',
  message: string,
  extra?: Record<string, unknown>,
): void {
  emit('maOAuth', {
    phase,
    message,
    at: Date.now(),
    ...(extra || {}),
  });
}

function cleanupOAuthFlow(): void {
  if (oauthTimeout) {
    clearTimeout(oauthTimeout);
    oauthTimeout = null;
  }
  if (oauthServer) {
    oauthServer.close();
    oauthServer = null;
  }
  oauthFlowInProgress = false;
}

function findPlayerById(playerId: string | null): MAPlayer | null {
  if (!playerId) return null;
  return playersCache.find((player) => player.player_id === playerId) || null;
}

function normalizePlayerIdList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
}

function resolveControllingPlayer(playerId: string | null): MAPlayer | null {
  let current = findPlayerById(playerId);
  const visited = new Set<string>();

  while (current && !visited.has(current.player_id)) {
    visited.add(current.player_id);
    const parentId =
      (typeof current.synced_to === 'string' && current.synced_to.trim())
      || (typeof current.active_group === 'string' && current.active_group.trim())
      || null;
    if (!parentId || parentId === current.player_id) {
      return current;
    }
    const parent = findPlayerById(parentId);
    if (!parent) {
      return current;
    }
    current = parent;
  }

  return current;
}

function pickSelectedPlayerId(
  players: MAPlayer[],
  preferredPlayerId: string | null,
  defaultPlayerId: string,
): string | null {
  const ids = new Set(players.map((player) => player.player_id));

  if (preferredPlayerId && ids.has(preferredPlayerId)) {
    return preferredPlayerId;
  }

  if (defaultPlayerId && ids.has(defaultPlayerId)) {
    return defaultPlayerId;
  }

  if (players.length > 0) {
    return players[0].player_id;
  }

  return null;
}

function resolveQueueForPlayer(player: MAPlayer | null): MAQueue | null {
  if (!player) return null;

  const byPlayerId = queuesCache.find(
    (queue) => queue.player_id === player.player_id || queue.queue_id === player.player_id,
  );
  if (byPlayerId) return byPlayerId;

  if (player.active_source) {
    const byActiveSource = queuesCache.find(
      (queue) => queue.queue_id === player.active_source,
    );
    if (byActiveSource) return byActiveSource;
  }

  return null;
}

function getTargetQueueId(): string {
  const selectedPlayer = resolveControllingPlayer(selectedPlayerId) || findPlayerById(selectedPlayerId);
  const selectedQueue = resolveQueueForPlayer(selectedPlayer);
  if (selectedQueue?.queue_id) return selectedQueue.queue_id;
  if (selectedPlayer?.player_id) return selectedPlayer.player_id;
  throw new Error('No queue available for selected player.');
}

function getSelectedQueue(): MAQueue {
  const selectedPlayer = resolveControllingPlayer(selectedPlayerId) || findPlayerById(selectedPlayerId);
  const selectedQueue = resolveQueueForPlayer(selectedPlayer);
  if (!selectedQueue) {
    throw new Error('No queue available for selected player.');
  }
  return selectedQueue;
}

function getVolumeTargetPlayerIds(scope: VolumeControlScope, explicitPlayerIds: string[] = []): string[] {
  const explicit = normalizePlayerIdList(explicitPlayerIds);
  if (explicit.length > 0) {
    return Array.from(new Set(explicit));
  }

  const selected = findPlayerById(selectedPlayerId);
  if (!selected) {
    throw new Error('No player selected.');
  }

  if (scope === 'selected') {
    return [selected.player_id];
  }

  const controller = resolveControllingPlayer(selected.player_id) || selected;
  const groupMembers = normalizePlayerIdList(controller.group_members);
  const ids = groupMembers.length > 1
    ? groupMembers
    : normalizePlayerIdList(selected.group_members);
  if (ids.length > 0) {
    return Array.from(new Set(ids));
  }

  return [selected.player_id];
}

function upsertQueue(queue: MAQueue): void {
  const index = queuesCache.findIndex((item) => {
    if (item.queue_id === queue.queue_id) return true;
    if (queue.player_id && item.player_id === queue.player_id) return true;
    return false;
  });

  if (index >= 0) {
    queuesCache[index] = {
      ...queuesCache[index],
      ...queue,
    };
    return;
  }

  queuesCache.push(queue);
}

async function resolveQueueIdForPlayer(playerId: string): Promise<string> {
  const cachedPlayer = findPlayerById(playerId) || { player_id: playerId };
  const cachedQueue = resolveQueueForPlayer(cachedPlayer);
  if (cachedQueue?.queue_id) {
    return cachedQueue.queue_id;
  }

  const queue = await maClient.sendCommand<MAQueue>('player_queues/get_active_queue', {
    player_id: playerId,
  });
  if (!queue || typeof queue.queue_id !== 'string' || !queue.queue_id.trim()) {
    throw new Error(`No queue available for player: ${playerId}`);
  }

  upsertQueue({
    ...queue,
    player_id: queue.player_id || playerId,
  });
  return queue.queue_id;
}

function parseLibraryMediaType(payload: unknown): LibraryMediaType {
  const record = asRecord(payload);
  const value = readString(record, 'mediaType');
  const allowed: LibraryMediaType[] = ['artists', 'albums', 'tracks', 'playlists'];
  if (!value || !allowed.includes(value as LibraryMediaType)) {
    return 'tracks';
  }
  return value as LibraryMediaType;
}

function parseSearchText(payload: unknown): string {
  const record = asRecord(payload);
  return readString(record, 'search') || '';
}

function parseLimit(payload: unknown, fallback: number): number {
  const record = asRecord(payload);
  const value = readNumber(record, 'limit');
  if (value === null) return fallback;
  return Math.min(100, Math.max(1, Math.round(value)));
}

function summarizeLibraryItem(
  value: unknown,
  mediaType: LibraryMediaType,
): LibraryItemSummary | null {
  const record = asRecord(value);
  if (!record) return null;

  const name = readString(record, 'name') || '';
  if (!name) return null;

  const uri = readString(record, 'uri');
  const provider = readString(record, 'provider');
  const artistStr = readString(record, 'artist_str');
  const version = readString(record, 'version');
  const owner = readString(record, 'owner');
  const artists = readArray(record, 'artists')
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => readString(item, 'name'))
    .filter((item): item is string => Boolean(item));
  const image = asRecord(record.image);
  const imageUrl = readString(image, 'url') || readString(image, 'path');

  let subtitle = '';
  if (mediaType === 'tracks' || mediaType === 'albums') {
    subtitle = artistStr || artists.join(', ');
  } else if (mediaType === 'playlists') {
    subtitle = owner || provider || '';
  } else {
    subtitle = provider || '';
  }
  if (version && subtitle) {
    subtitle = `${subtitle} • ${version}`;
  } else if (version) {
    subtitle = version;
  }

  return {
    uri,
    mediaType,
    name,
    subtitle,
    imageUrl,
    provider,
  };
}

async function fetchLibraryItems(
  mediaType: LibraryMediaType,
  search: string,
  limit: number,
): Promise<LibraryItemSummary[]> {
  const args: Record<string, unknown> = {
    limit,
    offset: 0,
    order_by: 'sort_name',
  };
  if (search.trim()) {
    args.search = search.trim();
  }

  const command = `music/${mediaType}/library_items`;
  const results = await maClient.sendCommand<unknown[]>(command, args);
  const list = Array.isArray(results) ? results : [];

  return list
    .map((item) => summarizeLibraryItem(item, mediaType))
    .filter((item): item is LibraryItemSummary => item !== null);
}

function normalizeImageSource(source: string, baseUrl: string): string {
  const trimmed = source.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const base = baseUrl.replace(/\/+$/, '');
  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return `${base}${path}`;
}

function toImageProxyUrl(path: string, provider: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({
    path,
    provider,
  });
  return `${base}/imageproxy?${params.toString()}`;
}

function resolveImageRequestUrl(source: string, provider: string | null, baseUrl: string): string {
  const trimmed = source.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('/imageproxy')) {
    return normalizeImageSource(trimmed, baseUrl);
  }
  if (provider && provider.trim()) {
    return toImageProxyUrl(trimmed, provider.trim(), baseUrl);
  }
  return normalizeImageSource(trimmed, baseUrl);
}

function getImageCacheKey(source: string, provider: string | null): string {
  const settings = getMusicAssistantSettings();
  return resolveImageRequestUrl(source, provider, settings.baseUrl);
}

function pruneImageCache(now = Date.now()): void {
  for (const [key, value] of imageCache.entries()) {
    if (now - value.fetchedAt > IMAGE_CACHE_TTL_MS) {
      imageCache.delete(key);
    }
  }
}

async function fetchImageDataUri(source: string, provider: string | null): Promise<string> {
  const settings = getMusicAssistantSettings();
  const url = resolveImageRequestUrl(source, provider, settings.baseUrl);
  if (!url) {
    throw new Error('Image source is empty.');
  }

  const headers: Record<string, string> = {};
  if (settings.token) {
    headers.Authorization = `Bearer ${settings.token}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Image request failed (${response.status} ${response.statusText})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const mime = response.headers.get('content-type') || 'image/jpeg';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function firstNonEmpty(values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function extractImageUrl(item: MAQueueItem | null | undefined): string | null {
  const image = extractImage(item);
  if (!image) return null;
  if (image.url) return image.url;
  if (image.path) return image.path;
  return null;
}

function extractImage(item: MAQueueItem | null | undefined): MAQueueItem['image'] | null {
  if (!item) return null;
  const itemImage = item.image;
  if (itemImage?.url || itemImage?.path) return itemImage;
  const mediaImage = item.media_item?.image;
  if (mediaImage?.url || mediaImage?.path) return mediaImage;
  return null;
}

function extractNowPlaying(queue: MAQueue | null): NowPlayingSummary | null {
  if (!queue) return null;

  const currentItem = queue.current_item;
  if (!currentItem) return null;

  const media = currentItem.media_item;

  const title = firstNonEmpty([currentItem.name, media?.name]);
  const artist = firstNonEmpty([currentItem.artist_str, media?.artist_str]);
  const album = firstNonEmpty([media?.album?.name]);

  const image = extractImage(currentItem);
  return {
    title,
    artist,
    album,
    imageUrl: extractImageUrl(currentItem),
    imageProvider: image?.provider || null,
    duration: typeof currentItem.duration === 'number' ? currentItem.duration : null,
    position: typeof queue.elapsed_time === 'number' ? queue.elapsed_time : null,
    isPlaying: (queue.state || '').toLowerCase() === 'playing',
  };
}

function emitPlayersAndState(): void {
  emit('maPlayers', {
    players: playersCache,
    selectedPlayerId,
    updatedAt: Date.now(),
  });

  const selectedPlayer = findPlayerById(selectedPlayerId);
  const selectedQueue = resolveQueueForPlayer(selectedPlayer);
  const nowPlaying = extractNowPlaying(selectedQueue);

  const payload: StatePayload = {
    selectedPlayerId,
    player: selectedPlayer,
    queue: selectedQueue,
    queueItems: queueItemsCache,
    nowPlaying,
    updatedAt: Date.now(),
  };

  emit('maState', payload);
}

async function pollState(): Promise<void> {
  if (pollInFlight) {
    pollAgain = true;
    return;
  }
  if (!maClient.isConnected()) {
    emitStatus();
    return;
  }
  if (!maClient.isAuthenticated()) {
    emitStatus();
    return;
  }

  pollInFlight = true;
  try {
    const settings = getMusicAssistantSettings();
    const [players, queues] = await Promise.all([
      maClient.sendCommand<MAPlayer[]>('players/all'),
      maClient.sendCommand<MAQueue[]>('player_queues/all'),
    ]);

    playersCache = Array.isArray(players) ? players : [];
    queuesCache = Array.isArray(queues) ? queues : [];
    selectedPlayerId = pickSelectedPlayerId(
      playersCache,
      selectedPlayerId,
      settings.defaultPlayerId,
    );

    const selectedPlayer = findPlayerById(selectedPlayerId);
    const selectedQueue = resolveQueueForPlayer(selectedPlayer);
    if (selectedQueue?.queue_id) {
      try {
        const items = await maClient.sendCommand<MAQueueItem[]>('player_queues/items', {
          queue_id: selectedQueue.queue_id,
          limit: 25,
          offset: 0,
        });
        queueItemsCache = Array.isArray(items) ? items : [];
      } catch {
        queueItemsCache = [];
      }
    } else {
      queueItemsCache = [];
    }

    emitPlayersAndState();
    emitStatus();
  } catch (error: unknown) {
    emitError('ma:poll', toErrorMessage(error));
    emitStatus();
  } finally {
    pollInFlight = false;
    if (pollAgain) {
      pollAgain = false;
      void pollState();
    }
  }
}

function schedulePollSoon(delayMs = 250): void {
  if (scheduledPoll) {
    clearTimeout(scheduledPoll);
  }
  scheduledPoll = setTimeout(() => {
    scheduledPoll = null;
    void pollState();
  }, delayMs);
}

function stopPolling(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

function startPolling(intervalMs: number): void {
  stopPolling();
  pollingTimer = setInterval(() => {
    void pollState();
  }, Math.max(1000, intervalMs));
}

async function connectWithSettings(settings: MusicAssistantSettings): Promise<void> {
  maClient.setCredentials(settings.baseUrl, settings.token);

  if (!settings.baseUrl) {
    emitError('ma:connect', 'Music Assistant URL is empty in settings.');
    emitStatus();
    return;
  }

  await maClient.connect();
  startPolling(settings.pollIntervalMs);
  await pollState();
}

async function ensureConnected(settings: MusicAssistantSettings): Promise<void> {
  maClient.setCredentials(settings.baseUrl, settings.token);
  if (!settings.baseUrl) {
    throw new Error('Music Assistant URL is empty in settings.');
  }
  if (!maClient.isConnected()) {
    await maClient.connect();
  }
  if (!pollingTimer) {
    startPolling(settings.pollIntervalMs);
  }
}

async function fetchAuthProviders(): Promise<AuthProvider[]> {
  const providers = await maClient.sendCommand<AuthProvider[]>('auth/providers');
  const providerList = Array.isArray(providers) ? providers : [];
  emit('maAuthProviders', {
    providers: providerList,
    updatedAt: Date.now(),
  });
  return providerList;
}

function getOAuthTokenFromCallback(url: URL): string | null {
  const code = url.searchParams.get('code');
  if (code && code.trim()) return code.trim();

  const token = url.searchParams.get('token');
  if (token && token.trim()) return token.trim();

  const accessToken = url.searchParams.get('access_token');
  if (accessToken && accessToken.trim()) return accessToken.trim();

  return null;
}

async function saveTokenToSettings(token: string): Promise<void> {
  const current = (await DeskThing.getSettings()) as AppSettings | undefined;
  if (!current || !current.ma_token) return;

  const nextSettings: AppSettings = {
    ...current,
    ma_token: {
      ...current.ma_token,
      value: token,
    },
  };

  DeskThing.saveSettings(nextSettings);
}

async function runProviderAuth(requestedProviderId?: string): Promise<void> {
  if (oauthFlowInProgress) {
    throw new Error('Authentication flow already in progress.');
  }
  oauthFlowInProgress = true;

  try {
    emitOAuthState('starting', 'Starting browser authentication...');

    const settings = await refreshSettings(true);
    await ensureConnected(settings);

    const providers = await fetchAuthProviders();
    const providerId =
      requestedProviderId ||
      settings.authProvider ||
      'homeassistant';

    const provider = providers.find((item) => item.provider_id === providerId);
    if (!provider) {
      throw new Error(`Auth provider "${providerId}" not found on server.`);
    }

    const callbackPromise = new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        const path = req.url || '/';
        const callbackUrl = new URL(path, 'http://127.0.0.1');

        if (!callbackUrl.pathname.startsWith('/callback')) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }

        const token = getOAuthTokenFromCallback(callbackUrl);
        if (!token) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2>Music Assistant Login Failed</h2><p>No token/code was received.</p>');
          reject(new Error('OAuth callback did not include a token/code.'));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>Music Assistant Login Complete</h2><p>You can close this window.</p>');
        resolve(token);
      });

      server.on('error', (error) => {
        reject(error);
      });

      server.listen(0, '127.0.0.1', () => {
        oauthServer = server;
      });
    });

    const waitForServerReady = async (): Promise<string> => new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const tick = () => {
        if (oauthServer?.address()) {
          const address = oauthServer.address() as AddressInfo;
          resolve(`http://127.0.0.1:${address.port}/callback`);
          return;
        }
        if (Date.now() - startedAt > 3000) {
          reject(new Error('Unable to start local OAuth callback server.'));
          return;
        }
        setTimeout(tick, 30);
      };
      tick();
    });

    const returnUrl = await waitForServerReady();
    const authUrlResult = await maClient.sendCommand<AuthorizationUrlResult>(
      'auth/authorization_url',
      {
        provider_id: provider.provider_id,
        return_url: returnUrl,
      },
    );

    const authorizationUrl = authUrlResult?.authorization_url;
    if (!authorizationUrl || typeof authorizationUrl !== 'string') {
      throw new Error('Music Assistant did not return an authorization URL.');
    }

    emitOAuthState('waiting_callback', 'Complete sign-in in your browser...', {
      providerId: provider.provider_id,
      authorizationUrl,
      returnUrl,
    });

    let openedBrowser = false;
    try {
      DeskThing.openUrl(authorizationUrl);
      openedBrowser = true;
    } catch {
      openedBrowser = false;
    }

    emitOAuthState('browser_opened', openedBrowser
      ? 'Opened browser for login.'
      : 'Could not auto-open browser. Open the URL manually.', {
      providerId: provider.provider_id,
      authorizationUrl,
      returnUrl,
      openedBrowser,
    });

    const timeoutPromise = new Promise<string>((_resolve, reject) => {
      oauthTimeout = setTimeout(() => {
        reject(new Error('Authentication timed out. Please try again.'));
      }, 5 * 60 * 1000);
    });

    const token = await Promise.race([callbackPromise, timeoutPromise]);
    emitOAuthState('token_received', 'Received auth callback token.');
    await maClient.authenticateWithToken(token);
    await saveTokenToSettings(token);
    emitOAuthState('success', 'Authentication successful. Token saved to settings.');
    await refreshSettings(true);
    schedulePollSoon(0);
  } catch (error: unknown) {
    emitOAuthState('error', toErrorMessage(error));
    throw error;
  } finally {
    cleanupOAuthFlow();
  }
}

function eventShouldTriggerRefresh(event: MAEventMessage): boolean {
  const normalized = event.event.toLowerCase();
  return normalized.includes('player') || normalized.includes('queue');
}

function getTargetPlayerId(): string {
  const targetPlayer = resolveControllingPlayer(selectedPlayerId) || findPlayerById(selectedPlayerId);
  if (!targetPlayer?.player_id) {
    throw new Error('No player selected.');
  }
  return targetPlayer.player_id;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

async function getCurrentVolume(playerId: string): Promise<number> {
  const fromCache = findPlayerById(playerId)?.volume_level;
  if (typeof fromCache === 'number' && Number.isFinite(fromCache)) {
    return fromCache;
  }

  const fresh = await maClient.sendCommand<MAPlayer>('players/get', {
    player_id: playerId,
    raise_unavailable: true,
  });
  if (typeof fresh.volume_level === 'number' && Number.isFinite(fresh.volume_level)) {
    return fresh.volume_level;
  }
  return 0;
}

async function setVolumeAbsolute(
  volume: number,
  scope: VolumeControlScope = 'selected',
  explicitPlayerIds: string[] = [],
): Promise<void> {
  const volumeLevel = clamp(Math.round(volume));
  const targetPlayerIds = getVolumeTargetPlayerIds(scope, explicitPlayerIds);

  await Promise.all(targetPlayerIds.map((playerId) => maClient.sendCommand<void>('players/cmd/volume_set', {
    player_id: playerId,
    volume_level: volumeLevel,
  })));

  schedulePollSoon();
}

async function adjustVolume(
  delta: number,
  scope: VolumeControlScope = 'selected',
  explicitPlayerIds: string[] = [],
): Promise<void> {
  const targetPlayerIds = getVolumeTargetPlayerIds(scope, explicitPlayerIds);
  const uniqueIds = Array.from(new Set(targetPlayerIds));
  const volumeDelta = Math.round(delta);

  await Promise.all(uniqueIds.map(async (playerId) => {
    const currentVolume = await getCurrentVolume(playerId);
    const nextVolume = clamp(currentVolume + volumeDelta);
    await maClient.sendCommand<void>('players/cmd/volume_set', {
      player_id: playerId,
      volume_level: nextVolume,
    });
  }));

  schedulePollSoon();
}

function parseTransportCommand(payload: unknown): TransportCommand | null {
  const record = asRecord(payload);
  const command = readString(record, 'command');
  const allowed: TransportCommand[] = ['play', 'pause', 'play_pause', 'next', 'previous', 'stop'];
  return command && allowed.includes(command as TransportCommand)
    ? (command as TransportCommand)
    : null;
}

function parsePlayerId(payload: unknown): string | null {
  const record = asRecord(payload);
  return readString(record, 'playerId');
}

function parseTargetPlayerId(payload: unknown): string | null {
  const record = asRecord(payload);
  return readString(record, 'targetPlayerId') || readString(record, 'playerId');
}

function parseDelta(payload: unknown): number | null {
  const record = asRecord(payload);
  return readNumber(record, 'delta');
}

function parseVolume(payload: unknown): number | null {
  const record = asRecord(payload);
  return readNumber(record, 'volume');
}

function parseVolumeScope(payload: unknown): VolumeControlScope {
  const record = asRecord(payload);
  const scope = readString(record, 'scope');
  return scope === 'group' ? 'group' : 'selected';
}

function parseVolumePlayerIds(payload: unknown): string[] {
  const record = asRecord(payload);
  if (!record) return [];

  const single = readString(record, 'playerId');
  const multiple = normalizePlayerIdList(record.playerIds);
  if (multiple.length > 0) {
    return multiple;
  }
  return single ? [single] : [];
}

function parseProviderId(payload: unknown): string | null {
  const record = asRecord(payload);
  return readString(record, 'providerId');
}

function parseImageSource(payload: unknown): string | null {
  const record = asRecord(payload);
  return readString(record, 'source');
}

function parseImageProvider(payload: unknown): string | null {
  const record = asRecord(payload);
  return readString(record, 'provider');
}

function parseMediaUri(payload: unknown): string | null {
  const record = asRecord(payload);
  return readString(record, 'uri');
}

function parseShuffleEnabled(payload: unknown): boolean | null {
  const record = asRecord(payload);
  if (!record) return null;
  const value = record.shuffleEnabled;
  return typeof value === 'boolean' ? value : null;
}

function parseRepeatMode(payload: unknown): RepeatMode | null {
  const record = asRecord(payload);
  const value = readString(record, 'repeatMode')?.toLowerCase();
  const allowed: RepeatMode[] = ['off', 'one', 'all'];
  return value && allowed.includes(value as RepeatMode) ? (value as RepeatMode) : null;
}

async function handleGet(socketData: SocketRequest): Promise<void> {
  const request = socketData.request;

  switch (request) {
    case 'ma:status':
      emitStatus();
      return;

    case 'ma:players':
    case 'ma:state':
      await pollState();
      return;

    case 'ma:authProviders': {
      try {
        const settings = await refreshSettings();
        await ensureConnected(settings);
        await fetchAuthProviders();
      } catch (error: unknown) {
        emitError(request, toErrorMessage(error));
      }
      return;
    }

    case 'ma:reloadSettings': {
      try {
        const settings = await refreshSettings(true);
        await connectWithSettings(settings);
      } catch (error: unknown) {
        emitError(request, toErrorMessage(error));
      }
      return;
    }

    case 'ma:library': {
      try {
        const settings = await refreshSettings();
        await ensureConnected(settings);
        if (!maClient.isAuthenticated()) {
          throw new Error('Authenticate first to browse your library.');
        }

        const mediaType = parseLibraryMediaType(socketData.payload);
        const search = parseSearchText(socketData.payload);
        const limit = parseLimit(socketData.payload, 50);
        const items = await fetchLibraryItems(mediaType, search, limit);
        emit('maLibrary', {
          mediaType,
          search,
          items,
          updatedAt: Date.now(),
        });
      } catch (error: unknown) {
        emitError(request, toErrorMessage(error));
      }
      return;
    }

    case 'ma:image': {
      const source = parseImageSource(socketData.payload);
      const provider = parseImageProvider(socketData.payload);
      if (!source) {
        emitError(request, 'Missing image source.');
        return;
      }

      try {
        const now = Date.now();
        pruneImageCache(now);
        const cacheKey = getImageCacheKey(source, provider);
        const cached = imageCache.get(cacheKey);
        if (cached && now - cached.fetchedAt < IMAGE_CACHE_TTL_MS) {
          emit('maImage', {
            source,
            provider,
            dataUri: cached.dataUri,
            cached: true,
            updatedAt: now,
          });
          return;
        }

        const dataUri = await fetchImageDataUri(source, provider);
        imageCache.set(cacheKey, { dataUri, fetchedAt: now });
        emit('maImage', {
          source,
          provider,
          dataUri,
          cached: false,
          updatedAt: now,
        });
      } catch (error: unknown) {
        const message = toErrorMessage(error);
        emitError(request, message);
        emit('maImage', {
          source,
          provider,
          dataUri: null,
          error: message,
          updatedAt: Date.now(),
        });
      }
      return;
    }

    default:
      return;
  }
}

async function handleSet(socketData: SocketRequest): Promise<void> {
  const request = socketData.request;
  const payload = socketData.payload;

  try {
    switch (request) {
      case 'ma:connect': {
        const settings = await refreshSettings(true);
        await connectWithSettings(settings);
        return;
      }

      case 'ma:startProviderAuth': {
        const providerId = parseProviderId(payload) || undefined;
        await runProviderAuth(providerId);
        return;
      }

      case 'ma:disconnect':
        stopPolling();
        maClient.disconnect('Disconnected by user.');
        emitStatus();
        return;

      case 'ma:selectPlayer': {
        const playerId = parsePlayerId(payload);
        if (!playerId) throw new Error('Missing playerId in request payload.');
        const exists = playersCache.some((player) => player.player_id === playerId);
        if (!exists) {
          throw new Error(`Player not found: ${playerId}`);
        }
        if (playerId === selectedPlayerId) {
          schedulePollSoon(0);
          return;
        }

        selectedPlayerId = playerId;
        queueItemsCache = [];
        emitPlayersAndState();
        schedulePollSoon(0);
        return;
      }

      case 'ma:transport': {
        const command = parseTransportCommand(payload);
        if (!command) throw new Error('Invalid transport command.');

        const playerId = getTargetPlayerId();
        await maClient.sendCommand<void>(`players/cmd/${command}`, {
          player_id: playerId,
        });

        schedulePollSoon(0);
        return;
      }

      case 'ma:adjustVolume': {
        const delta = parseDelta(payload);
        if (delta === null) throw new Error('Missing numeric delta in payload.');
        const scope = parseVolumeScope(payload);
        const playerIds = parseVolumePlayerIds(payload);

        await adjustVolume(delta, scope, playerIds);
        return;
      }

      case 'ma:setVolume': {
        const volume = parseVolume(payload);
        if (volume === null) throw new Error('Missing numeric volume in payload.');
        const scope = parseVolumeScope(payload);
        const playerIds = parseVolumePlayerIds(payload);

        await setVolumeAbsolute(volume, scope, playerIds);
        return;
      }

      case 'ma:refresh':
        schedulePollSoon(0);
        return;

      case 'ma:playMedia': {
        const uri = parseMediaUri(payload);
        if (!uri) throw new Error('Missing media uri in payload.');
        const queueId = getTargetQueueId();

        await maClient.sendCommand<void>('player_queues/play_media', {
          queue_id: queueId,
          media: uri,
        });

        schedulePollSoon(0);
        return;
      }

      case 'ma:setShuffle': {
        const shuffleEnabled = parseShuffleEnabled(payload);
        if (shuffleEnabled === null) throw new Error('Missing shuffleEnabled in payload.');
        const queue = getSelectedQueue();

        await maClient.sendCommand<void>('player_queues/shuffle', {
          queue_id: queue.queue_id,
          shuffle_enabled: shuffleEnabled,
        });

        schedulePollSoon(0);
        return;
      }

      case 'ma:setRepeat': {
        const repeatMode = parseRepeatMode(payload);
        if (!repeatMode) throw new Error('Missing repeatMode in payload.');
        const queue = getSelectedQueue();

        await maClient.sendCommand<void>('player_queues/repeat', {
          queue_id: queue.queue_id,
          repeat_mode: repeatMode,
        });

        schedulePollSoon(0);
        return;
      }

      case 'ma:groupPlayer': {
        const leaderPlayerId = getTargetPlayerId();
        const targetPlayerId = parseTargetPlayerId(payload);
        if (!targetPlayerId) throw new Error('Missing targetPlayerId in payload.');
        if (targetPlayerId === leaderPlayerId) {
          throw new Error('Cannot join a player to itself.');
        }

        const targetPlayer = findPlayerById(targetPlayerId);
        const existingParentId =
          (typeof targetPlayer?.synced_to === 'string' && targetPlayer.synced_to.trim())
          || (typeof targetPlayer?.active_group === 'string' && targetPlayer.active_group.trim())
          || null;
        if (existingParentId && existingParentId !== leaderPlayerId) {
          await maClient.sendCommand<void>('players/cmd/ungroup', {
            player_id: targetPlayerId,
          });
        }

        await maClient.sendCommand<void>('players/cmd/set_members', {
          target_player: leaderPlayerId,
          player_ids_to_add: [targetPlayerId],
        });

        selectedPlayerId = leaderPlayerId;
        emitPlayersAndState();
        schedulePollSoon(0);
        return;
      }

      case 'ma:ungroupPlayer': {
        const playerId = parseTargetPlayerId(payload) || getTargetPlayerId();

        await maClient.sendCommand<void>('players/cmd/ungroup', {
          player_id: playerId,
        });

        schedulePollSoon(0);
        return;
      }

      case 'ma:ungroupAll': {
        const leaderPlayerId = getTargetPlayerId();
        const leaderPlayer = findPlayerById(leaderPlayerId);
        const memberIds = normalizePlayerIdList(leaderPlayer?.group_members)
          .filter((playerId) => playerId !== leaderPlayerId);

        if (memberIds.length === 0) {
          schedulePollSoon(0);
          return;
        }

        await maClient.sendCommand<void>('players/cmd/set_members', {
          target_player: leaderPlayerId,
          player_ids_to_remove: memberIds,
        });

        selectedPlayerId = leaderPlayerId;
        emitPlayersAndState();
        schedulePollSoon(0);
        return;
      }

      case 'ma:transferQueue': {
        const targetPlayerId = parseTargetPlayerId(payload);
        if (!targetPlayerId) throw new Error('Missing targetPlayerId in payload.');

        const sourceQueueId = getTargetQueueId();
        const targetQueueId = await resolveQueueIdForPlayer(targetPlayerId);
        if (sourceQueueId === targetQueueId) {
          selectedPlayerId = targetPlayerId;
          schedulePollSoon(0);
          return;
        }

        await maClient.sendCommand<void>('player_queues/transfer', {
          source_queue_id: sourceQueueId,
          target_queue_id: targetQueueId,
          auto_play: true,
        });

        selectedPlayerId = targetPlayerId;
        queueItemsCache = [];
        emitPlayersAndState();
        schedulePollSoon(0);
        return;
      }

      default:
        return;
    }
  } catch (error: unknown) {
    emitError(request || 'ma:set', toErrorMessage(error));
  }
}

const start = async (): Promise<void> => {
  if (started) return;
  started = true;

  await initSettings();
  const settings = await refreshSettings(true);
  selectedPlayerId = settings.defaultPlayerId || null;

  unsubscribers.push(
    maClient.onStatusChange(() => {
      emitStatus();
    }),
  );

  unsubscribers.push(
    maClient.onEvent((event) => {
      if (eventShouldTriggerRefresh(event)) {
        schedulePollSoon();
      }
    }),
  );

  DeskThing.on('get', handleGet);
  DeskThing.on('set', handleSet);

  if (settings.baseUrl) {
    try {
      await connectWithSettings(settings);
    } catch (error: unknown) {
      emitError('ma:start', toErrorMessage(error));
    }
  }

  emitStatus();
};

const stop = async (): Promise<void> => {
  stopPolling();
  cleanupOAuthFlow();

  if (scheduledPoll) {
    clearTimeout(scheduledPoll);
    scheduledPoll = null;
  }

  for (const unsubscribe of unsubscribers.splice(0, unsubscribers.length)) {
    unsubscribe();
  }

  maClient.disconnect('App stopped.');
  started = false;
};

DeskThing.on(DESKTHING_EVENTS.START, start);
DeskThing.on(DESKTHING_EVENTS.STOP, stop);
