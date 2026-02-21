import { useCallback, useEffect, useRef, useState } from 'react';
import { DeskThing } from '@deskthing/client';
import type { SocketData } from '@deskthing/types';
import { useDeskThingSettings } from './settings';
import type {
  MusicAssistantAuthProvider,
  MusicAssistantErrorPayload,
  MusicAssistantImagePayload,
  MusicAssistantLibraryItem,
  MusicAssistantLibraryMediaType,
  MusicAssistantLibraryPayload,
  MusicAssistantOAuthPayload,
  MusicAssistantPlayer,
  MusicAssistantPlayersPayload,
  MusicAssistantQueueItem,
  MusicAssistantStatePayload,
  MusicAssistantStatusPayload,
  NowPlayingSummary,
  VolumeControlScope,
} from './types';

const APP_ID = 'musicassistant-webapp';
const WHEEL_THRESHOLD = 120;
const VOLUME_HUD_TIMEOUT_MS = 1000;
const KEYBOARD_ROWS = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];

const DEFAULT_STATUS: MusicAssistantStatusPayload = {
  state: 'disconnected',
  message: 'Not connected.',
  connected: false,
  authenticated: false,
  selectedPlayerId: null,
  serverInfo: null,
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function sendGet(request: string, payload?: Record<string, unknown>): void {
  DeskThing.send({ app: APP_ID, type: 'get', request, payload });
}

function sendSet(request: string, payload?: Record<string, unknown>): void {
  DeskThing.send({ app: APP_ID, type: 'set', request, payload });
}

function toImageKey(source: string, provider?: string | null): string {
  return `${provider || ''}::${source}`;
}

function parseStatus(payload: unknown): MusicAssistantStatusPayload | null {
  const record = asRecord(payload);
  if (!record) return null;

  const state = record.state;
  const message = record.message;
  const connected = record.connected;
  const authenticated = record.authenticated;
  const authRequired = record.authRequired;
  const selectedPlayerId = record.selectedPlayerId;

  if (
    typeof state !== 'string' ||
    typeof message !== 'string' ||
    typeof connected !== 'boolean' ||
    typeof authenticated !== 'boolean'
  ) {
    return null;
  }

  return {
    state: state as MusicAssistantStatusPayload['state'],
    message,
    connected,
    authenticated,
    authRequired: authRequired === true,
    selectedPlayerId: typeof selectedPlayerId === 'string' ? selectedPlayerId : null,
    serverInfo: asRecord(record.serverInfo),
  };
}

function parsePlayers(payload: unknown): MusicAssistantPlayersPayload | null {
  const record = asRecord(payload);
  if (!record) return null;

  const players = record.players;
  if (!Array.isArray(players)) return null;

  const normalizedPlayers: MusicAssistantPlayer[] = players
    .map((value) => asRecord(value))
    .filter((value): value is Record<string, unknown> => value !== null)
    .map((value) => {
      const playerId = value.player_id;
      return {
        player_id: typeof playerId === 'string' ? playerId : '',
        display_name: typeof value.display_name === 'string' ? value.display_name : undefined,
        available: typeof value.available === 'boolean' ? value.available : undefined,
        powered: typeof value.powered === 'boolean' ? value.powered : undefined,
        state: typeof value.state === 'string' ? value.state : undefined,
        active_source: typeof value.active_source === 'string' ? value.active_source : undefined,
        volume_level:
          typeof value.volume_level === 'number' ? value.volume_level : undefined,
        volume_muted:
          typeof value.volume_muted === 'boolean' ? value.volume_muted : undefined,
        group_members: asStringArray(value.group_members),
        synced_to: typeof value.synced_to === 'string' ? value.synced_to : null,
        active_group: typeof value.active_group === 'string' ? value.active_group : null,
      };
    })
    .filter((player) => player.player_id.length > 0);

  return {
    players: normalizedPlayers,
    selectedPlayerId:
      typeof record.selectedPlayerId === 'string' ? record.selectedPlayerId : null,
  };
}

function parseState(payload: unknown): MusicAssistantStatePayload | null {
  const record = asRecord(payload);
  if (!record) return null;

  const selectedPlayerId =
    typeof record.selectedPlayerId === 'string' ? record.selectedPlayerId : null;

  const player = asRecord(record.player);
  const queue = asRecord(record.queue);
  const nowPlaying = asRecord(record.nowPlaying);
  const queueItems = Array.isArray(record.queueItems) ? record.queueItems : [];

  const normalizedQueueItems: MusicAssistantQueueItem[] = queueItems
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => {
      const mediaItem = asRecord(item.media_item);
      const image = asRecord(item.image);
      const mediaImage = asRecord(mediaItem?.image);

      return {
        queue_item_id:
          typeof item.queue_item_id === 'string' ? item.queue_item_id : undefined,
        name: typeof item.name === 'string' ? item.name : undefined,
        artist_str:
          typeof item.artist_str === 'string' ? item.artist_str : undefined,
        duration:
          typeof item.duration === 'number' ? item.duration : undefined,
        sort_index:
          typeof item.sort_index === 'number' ? item.sort_index : undefined,
        image: image
          ? {
              path: typeof image.path === 'string' ? image.path : undefined,
              url: typeof image.url === 'string' ? image.url : undefined,
            }
          : null,
        media_item: mediaItem
          ? {
              name:
                typeof mediaItem.name === 'string' ? mediaItem.name : undefined,
              artist_str:
                typeof mediaItem.artist_str === 'string'
                  ? mediaItem.artist_str
                  : undefined,
              image: mediaImage
                ? {
                    path:
                      typeof mediaImage.path === 'string'
                        ? mediaImage.path
                        : undefined,
                    url:
                      typeof mediaImage.url === 'string'
                        ? mediaImage.url
                        : undefined,
                  }
                : null,
            }
          : null,
      };
    });

  const normalizedPlayer: MusicAssistantPlayer | null = player
    ? {
        player_id: typeof player.player_id === 'string' ? player.player_id : '',
        display_name:
          typeof player.display_name === 'string' ? player.display_name : undefined,
        available: typeof player.available === 'boolean' ? player.available : undefined,
        powered: typeof player.powered === 'boolean' ? player.powered : undefined,
        state: typeof player.state === 'string' ? player.state : undefined,
        active_source:
          typeof player.active_source === 'string' ? player.active_source : undefined,
        volume_level:
          typeof player.volume_level === 'number' ? player.volume_level : undefined,
        volume_muted:
          typeof player.volume_muted === 'boolean' ? player.volume_muted : undefined,
        group_members: asStringArray(player.group_members),
        synced_to: typeof player.synced_to === 'string' ? player.synced_to : null,
        active_group: typeof player.active_group === 'string' ? player.active_group : null,
      }
    : null;

  const normalizedNowPlaying: NowPlayingSummary | null = nowPlaying
    ? {
        title: typeof nowPlaying.title === 'string' ? nowPlaying.title : '',
        artist: typeof nowPlaying.artist === 'string' ? nowPlaying.artist : '',
        album: typeof nowPlaying.album === 'string' ? nowPlaying.album : '',
        imageUrl: typeof nowPlaying.imageUrl === 'string' ? nowPlaying.imageUrl : null,
        imageProvider:
          typeof nowPlaying.imageProvider === 'string' ? nowPlaying.imageProvider : null,
        duration:
          typeof nowPlaying.duration === 'number' ? nowPlaying.duration : null,
        position:
          typeof nowPlaying.position === 'number' ? nowPlaying.position : null,
        isPlaying: nowPlaying.isPlaying === true,
      }
    : null;

  return {
    selectedPlayerId,
    player:
      normalizedPlayer && normalizedPlayer.player_id ? normalizedPlayer : null,
    queue: queue
      ? {
          queue_id: typeof queue.queue_id === 'string' ? queue.queue_id : '',
          player_id: typeof queue.player_id === 'string' ? queue.player_id : undefined,
          state: typeof queue.state === 'string' ? queue.state : undefined,
          shuffle_enabled:
            typeof queue.shuffle_enabled === 'boolean' ? queue.shuffle_enabled : undefined,
          repeat_mode: typeof queue.repeat_mode === 'string' ? queue.repeat_mode : undefined,
          elapsed_time:
            typeof queue.elapsed_time === 'number' ? queue.elapsed_time : undefined,
          current_item: queue.current_item,
        }
      : null,
    queueItems: normalizedQueueItems,
    nowPlaying: normalizedNowPlaying,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
  };
}

function parseAuthProviders(payload: unknown): MusicAssistantAuthProvider[] {
  const record = asRecord(payload);
  if (!record) return [];

  const providers = record.providers;
  if (!Array.isArray(providers)) return [];

  return providers
    .map((value) => asRecord(value))
    .filter((value): value is Record<string, unknown> => value !== null)
    .map((provider) => ({
      provider_id: typeof provider.provider_id === 'string' ? provider.provider_id : '',
      provider_type: typeof provider.provider_type === 'string' ? provider.provider_type : '',
      requires_redirect: provider.requires_redirect === true,
    }))
    .filter((provider) => provider.provider_id.length > 0);
}

function parseOAuthPayload(payload: unknown): MusicAssistantOAuthPayload | null {
  const record = asRecord(payload);
  if (!record) return null;

  const phase = record.phase;
  const message = record.message;
  if (typeof phase !== 'string' || typeof message !== 'string') return null;

  return {
    phase: phase as MusicAssistantOAuthPayload['phase'],
    message,
    providerId: typeof record.providerId === 'string' ? record.providerId : undefined,
    authorizationUrl: typeof record.authorizationUrl === 'string' ? record.authorizationUrl : undefined,
    returnUrl: typeof record.returnUrl === 'string' ? record.returnUrl : undefined,
    openedBrowser: typeof record.openedBrowser === 'boolean' ? record.openedBrowser : undefined,
    at: typeof record.at === 'number' ? record.at : undefined,
  };
}

function parseImagePayload(payload: unknown): MusicAssistantImagePayload | null {
  const record = asRecord(payload);
  if (!record) return null;

  const source = record.source;
  const provider = record.provider;
  const dataUri = record.dataUri;
  if (typeof source !== 'string') return null;
  if (dataUri !== null && typeof dataUri !== 'string') return null;

  return {
    source,
    provider: typeof provider === 'string' ? provider : null,
    dataUri,
    error: typeof record.error === 'string' ? record.error : undefined,
    cached: record.cached === true,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : undefined,
  };
}

function parseLibraryPayload(payload: unknown): MusicAssistantLibraryPayload | null {
  const record = asRecord(payload);
  if (!record) return null;

  const mediaType = record.mediaType;
  const search = record.search;
  const items = record.items;
  const updatedAt = record.updatedAt;

  const allowed: MusicAssistantLibraryMediaType[] = [
    'artists',
    'albums',
    'tracks',
    'playlists',
  ];

  if (
    typeof mediaType !== 'string'
    || !allowed.includes(mediaType as MusicAssistantLibraryMediaType)
    || typeof search !== 'string'
    || !Array.isArray(items)
    || typeof updatedAt !== 'number'
  ) {
    return null;
  }

  const normalizedItems: MusicAssistantLibraryItem[] = items
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      uri: typeof item.uri === 'string' ? item.uri : null,
      mediaType:
        typeof item.mediaType === 'string'
        && allowed.includes(item.mediaType as MusicAssistantLibraryMediaType)
          ? (item.mediaType as MusicAssistantLibraryMediaType)
          : (mediaType as MusicAssistantLibraryMediaType),
      name: typeof item.name === 'string' ? item.name : '',
      subtitle: typeof item.subtitle === 'string' ? item.subtitle : '',
      imageUrl: typeof item.imageUrl === 'string' ? item.imageUrl : null,
      provider: typeof item.provider === 'string' ? item.provider : null,
    }))
    .filter((item) => item.name.length > 0);

  return {
    mediaType: mediaType as MusicAssistantLibraryMediaType,
    search,
    items: normalizedItems,
    updatedAt,
  };
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function statusTone(state: MusicAssistantStatusPayload['state']): string {
  if (state === 'authenticated') return 'status-ok';
  if (state === 'error') return 'status-error';
  return 'status-busy';
}

function queueItemTitle(item: MusicAssistantQueueItem): string {
  if (item.name && item.name.trim()) return item.name;
  if (item.media_item?.name && item.media_item.name.trim()) return item.media_item.name;
  return 'Unknown title';
}

function queueItemArtist(item: MusicAssistantQueueItem): string {
  if (item.artist_str && item.artist_str.trim()) return item.artist_str;
  if (item.media_item?.artist_str && item.media_item.artist_str.trim()) {
    return item.media_item.artist_str;
  }
  return 'Unknown artist';
}

function playerLabel(player: MusicAssistantPlayer): string {
  return player.display_name || player.player_id;
}

function App(): JSX.Element {
  const uiSettings = useDeskThingSettings();

  const [status, setStatus] = useState<MusicAssistantStatusPayload>(DEFAULT_STATUS);
  const [players, setPlayers] = useState<MusicAssistantPlayer[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [activePlayer, setActivePlayer] = useState<MusicAssistantPlayer | null>(null);
  const [activeQueue, setActiveQueue] = useState<MusicAssistantStatePayload['queue']>(null);
  const [playerPickerOpen, setPlayerPickerOpen] = useState(false);
  const [nowPlaying, setNowPlaying] = useState<NowPlayingSummary | null>(null);
  const [queueItems, setQueueItems] = useState<MusicAssistantQueueItem[]>([]);
  const [imageSources, setImageSources] = useState<Record<string, string>>({});
  const [libraryMediaType, setLibraryMediaType] = useState<MusicAssistantLibraryMediaType>('tracks');
  const [librarySearchInput, setLibrarySearchInput] = useState('');
  const [librarySearch, setLibrarySearch] = useState('');
  const [libraryItems, setLibraryItems] = useState<MusicAssistantLibraryItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [volumeControlScope, setVolumeControlScope] = useState<VolumeControlScope>('selected');
  const [volumeTargetPlayerId, setVolumeTargetPlayerId] = useState<string | null>(null);
  const [authProviders, setAuthProviders] = useState<MusicAssistantAuthProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>('homeassistant');
  const [oauthState, setOAuthState] = useState<MusicAssistantOAuthPayload | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [volumeHudValue, setVolumeHudValue] = useState<number | null>(null);

  const volumeHudTimer = useRef<number | null>(null);
  const wheelAccumulator = useRef(0);

  const currentPlayer =
    players.find((player) => player.player_id === selectedPlayerId) || activePlayer || null;
  const controllingPlayerId =
    currentPlayer?.synced_to || currentPlayer?.active_group || currentPlayer?.player_id || null;
  const controllingPlayer =
    players.find((player) => player.player_id === controllingPlayerId) || currentPlayer || null;
  const currentGroupMembers = controllingPlayer?.group_members?.length
    ? controllingPlayer.group_members
    : currentPlayer?.group_members || [];
  const groupedPlayers = Array.from(new Set(currentGroupMembers))
    .map((playerId) => players.find((player) => player.player_id === playerId))
    .filter((player): player is MusicAssistantPlayer => Boolean(player));
  const effectiveGroupedPlayers =
    groupedPlayers.length > 0
      ? groupedPlayers
      : controllingPlayer
        ? [controllingPlayer]
        : currentPlayer
          ? [currentPlayer]
          : [];
  const hasGroupedTargets =
    currentGroupMembers.length > 1 || Boolean(currentPlayer?.synced_to || currentPlayer?.active_group);
  const resolvedVolumeTargetId =
    volumeTargetPlayerId && players.some((player) => player.player_id === volumeTargetPlayerId)
      ? volumeTargetPlayerId
      : selectedPlayerId;
  const effectiveVolumeScope: VolumeControlScope =
    volumeControlScope === 'group' && hasGroupedTargets ? 'group' : 'selected';
  const selectedVolumeTargetPlayer =
    players.find((player) => player.player_id === resolvedVolumeTargetId) || activePlayer || null;
  const selectedVolumeLevel = typeof selectedVolumeTargetPlayer?.volume_level === 'number'
    ? clamp(Math.round(selectedVolumeTargetPlayer.volume_level))
    : 0;
  const groupedVolumeLevels = effectiveGroupedPlayers
    .map((player) => player.volume_level)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const groupVolumeLevel = groupedVolumeLevels.length > 0
    ? clamp(Math.round(groupedVolumeLevels.reduce((total, value) => total + value, 0) / groupedVolumeLevels.length))
    : selectedVolumeLevel;
  const currentVolume = effectiveVolumeScope === 'group' ? groupVolumeLevel : selectedVolumeLevel;
  const displayVolume = volumeHudValue ?? currentVolume;

  const showVolumeHud = useCallback((value: number) => {
    setVolumeHudValue(clamp(Math.round(value)));
    if (volumeHudTimer.current !== null) {
      window.clearTimeout(volumeHudTimer.current);
    }
    volumeHudTimer.current = window.setTimeout(() => {
      setVolumeHudValue(null);
      volumeHudTimer.current = null;
    }, VOLUME_HUD_TIMEOUT_MS);
  }, []);

  useEffect(() => {
    const body = document.body;
    body.classList.toggle('theme-light', !uiSettings.darkMode);
    body.classList.toggle('theme-dark', uiSettings.darkMode);
  }, [uiSettings.darkMode]);

  useEffect(() => {
    const offStatus = DeskThing.on('maStatus', (data: SocketData) => {
      if (data.type !== 'maStatus') return;
      const parsed = parseStatus(data.payload);
      if (!parsed) return;
      setStatus(parsed);
      if (parsed.selectedPlayerId) {
        setSelectedPlayerId(parsed.selectedPlayerId);
      }
    });

    const offPlayers = DeskThing.on('maPlayers', (data: SocketData) => {
      if (data.type !== 'maPlayers') return;
      const parsed = parsePlayers(data.payload);
      if (!parsed) return;

      setPlayers(parsed.players);
      if (parsed.selectedPlayerId) {
        setSelectedPlayerId(parsed.selectedPlayerId);
      }
    });

    const offState = DeskThing.on('maState', (data: SocketData) => {
      if (data.type !== 'maState') return;
      const parsed = parseState(data.payload);
      if (!parsed) return;

      setSelectedPlayerId(parsed.selectedPlayerId);
      setActivePlayer(parsed.player);
      setActiveQueue(parsed.queue);
      setQueueItems(parsed.queueItems);
      setNowPlaying(parsed.nowPlaying);
    });

    const offError = DeskThing.on('maError', (data: SocketData) => {
      if (data.type !== 'maError') return;
      const payload = asRecord(data.payload) as MusicAssistantErrorPayload | null;
      if (!payload?.message) return;
      setErrorMessage(payload.message);
      if (payload.request === 'ma:library') {
        setLibraryLoading(false);
      }
    });

    const offAuthProviders = DeskThing.on('maAuthProviders', (data: SocketData) => {
      if (data.type !== 'maAuthProviders') return;
      const parsed = parseAuthProviders(data.payload);
      setAuthProviders(parsed);

      if (parsed.length > 0) {
        setSelectedProviderId((previous) => {
          const hasSelected = parsed.some((provider) => provider.provider_id === previous);
          if (hasSelected) return previous;
          const preferred = parsed.find((provider) => provider.provider_id === 'homeassistant');
          return (preferred || parsed[0]).provider_id;
        });
      }
    });

    const offOAuth = DeskThing.on('maOAuth', (data: SocketData) => {
      if (data.type !== 'maOAuth') return;
      const parsed = parseOAuthPayload(data.payload);
      if (!parsed) return;
      setOAuthState(parsed);
      if (parsed.phase === 'success') {
        setErrorMessage(null);
        sendGet('ma:state');
      }
    });

    const offImage = DeskThing.on('maImage', (data: SocketData) => {
      if (data.type !== 'maImage') return;
      const parsed = parseImagePayload(data.payload);
      if (!parsed) return;
      if (!parsed.dataUri) return;

      setImageSources((previous) => {
        const key = toImageKey(parsed.source, parsed.provider);
        if (previous[key] === parsed.dataUri) return previous;
        const next: Record<string, string> = {
          ...previous,
          [key]: parsed.dataUri,
        };

        const keys = Object.keys(next);
        if (keys.length > 80) {
          const keyToDrop = keys[0];
          delete next[keyToDrop];
        }

        return next;
      });
    });

    const offLibrary = DeskThing.on('maLibrary', (data: SocketData) => {
      if (data.type !== 'maLibrary') return;
      const parsed = parseLibraryPayload(data.payload);
      if (!parsed) return;
      setLibraryItems(parsed.items);
      setLibraryLoading(false);
    });

    sendSet('ma:connect');
    sendGet('ma:status');
    sendGet('ma:state');

    return () => {
      offStatus();
      offPlayers();
      offState();
      offError();
      offAuthProviders();
      offOAuth();
      offImage();
      offLibrary();
      if (volumeHudTimer.current !== null) {
        window.clearTimeout(volumeHudTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (!status.authenticated) return;
      if (!selectedPlayerId) return;

      const dominant =
        Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (dominant === 0) return;

      wheelAccumulator.current += dominant;
      if (Math.abs(wheelAccumulator.current) < WHEEL_THRESHOLD) return;

      const direction = wheelAccumulator.current > 0 ? 1 : -1;
      wheelAccumulator.current = 0;

      const delta = direction * uiSettings.volumeScrollDelta;
      const optimistic = clamp(currentVolume + delta);
      showVolumeHud(optimistic);

      sendSet('ma:adjustVolume', {
        delta,
        scope: effectiveVolumeScope,
        playerId: effectiveVolumeScope === 'selected' ? resolvedVolumeTargetId : undefined,
      });
      event.preventDefault();
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('wheel', onWheel);
    };
  }, [
    currentVolume,
    effectiveVolumeScope,
    resolvedVolumeTargetId,
    selectedPlayerId,
    showVolumeHud,
    status.authenticated,
    uiSettings.volumeScrollDelta,
  ]);

  useEffect(() => {
    if (!activePlayer && selectedPlayerId) {
      const fallback = players.find((player) => player.player_id === selectedPlayerId) || null;
      setActivePlayer(fallback);
    }
  }, [activePlayer, players, selectedPlayerId]);

  useEffect(() => {
    if (!selectedPlayerId) return;
    if (volumeTargetPlayerId && players.some((player) => player.player_id === volumeTargetPlayerId)) {
      return;
    }
    setVolumeTargetPlayerId(selectedPlayerId);
  }, [players, selectedPlayerId, volumeTargetPlayerId]);

  useEffect(() => {
    const source = nowPlaying?.imageUrl;
    if (!source) return;
    const key = toImageKey(source, nowPlaying?.imageProvider);
    if (imageSources[key]) return;
    sendGet('ma:image', {
      source,
      provider: nowPlaying?.imageProvider || undefined,
    });
  }, [imageSources, nowPlaying?.imageProvider, nowPlaying?.imageUrl]);

  useEffect(() => {
    if (!status.connected || status.authenticated) return;
    if (authProviders.length > 0) return;
    sendGet('ma:authProviders');
  }, [authProviders.length, status.authenticated, status.connected]);

  useEffect(() => {
    if (!status.authenticated) {
      setLibraryItems([]);
      setLibraryLoading(false);
      return;
    }
    setLibraryLoading(true);
    sendGet('ma:library', {
      mediaType: libraryMediaType,
      search: librarySearch,
      limit: 50,
    });
  }, [libraryMediaType, librarySearch, status.authenticated]);

  const handleConnect = useCallback(() => {
    setErrorMessage(null);
    sendSet('ma:connect');
  }, []);

  const handleDisconnect = useCallback(() => {
    sendSet('ma:disconnect');
  }, []);

  const handleProviderChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedProviderId(event.target.value);
  }, []);

  const handleProviderLogin = useCallback(() => {
    setErrorMessage(null);
    setOAuthState({
      phase: 'starting',
      message: 'Requesting authorization URL...',
    });
    sendSet('ma:startProviderAuth', { providerId: selectedProviderId });
  }, [selectedProviderId]);

  const handleSelectPlayerId = useCallback((playerId: string) => {
    if (!playerId) return;
    if (playerId === selectedPlayerId) return;
    setSelectedPlayerId(playerId);
    setVolumeTargetPlayerId(playerId);
    setPlayerPickerOpen(false);
    sendSet('ma:selectPlayer', { playerId });
  }, [selectedPlayerId]);

  const handleJoinToPlayer = useCallback((targetPlayerId: string) => {
    if (!status.authenticated) return;
    if (!selectedPlayerId) return;
    if (!targetPlayerId || targetPlayerId === selectedPlayerId) return;
    setErrorMessage(null);
    sendSet('ma:groupPlayer', { targetPlayerId });
  }, [selectedPlayerId, status.authenticated]);

  const handleUngroupPlayer = useCallback((playerId: string) => {
    if (!status.authenticated) return;
    if (!playerId) return;
    setErrorMessage(null);
    sendSet('ma:ungroupPlayer', { playerId });
  }, [status.authenticated]);

  const handleUngroupSelectedPlayer = useCallback(() => {
    if (!selectedPlayerId) return;
    handleUngroupPlayer(selectedPlayerId);
  }, [handleUngroupPlayer, selectedPlayerId]);

  const handleUngroupAllPlayers = useCallback(() => {
    if (!status.authenticated) return;
    if (!hasGroupedTargets) return;
    setErrorMessage(null);
    sendSet('ma:ungroupAll');
  }, [hasGroupedTargets, status.authenticated]);

  const handleTransferToPlayer = useCallback((targetPlayerId: string) => {
    if (!status.authenticated) return;
    if (!selectedPlayerId) return;
    if (!targetPlayerId || targetPlayerId === selectedPlayerId) return;
    setErrorMessage(null);
    setSelectedPlayerId(targetPlayerId);
    setPlayerPickerOpen(false);
    sendSet('ma:transferQueue', { targetPlayerId });
  }, [selectedPlayerId, status.authenticated]);

  const cyclePlayer = useCallback((direction: 1 | -1) => {
    if (players.length === 0) return;
    const currentIndex = players.findIndex((player) => player.player_id === selectedPlayerId);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (safeIndex + direction + players.length) % players.length;
    const nextPlayer = players[nextIndex];
    if (nextPlayer) {
      handleSelectPlayerId(nextPlayer.player_id);
    }
  }, [handleSelectPlayerId, players, selectedPlayerId]);

  const handleLibraryTypeChange = useCallback((type: MusicAssistantLibraryMediaType) => {
    setLibraryMediaType(type);
  }, []);

  const handleLibrarySearchInput = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setLibrarySearchInput(event.target.value);
    },
    [],
  );

  const applyLibrarySearch = useCallback(() => {
    setLibrarySearch(librarySearchInput.trim());
    setKeyboardOpen(false);
  }, [librarySearchInput]);

  const clearLibrarySearch = useCallback(() => {
    setLibrarySearchInput('');
    setLibrarySearch('');
    setKeyboardOpen(false);
  }, []);

  const appendSearchText = useCallback((value: string) => {
    setLibrarySearchInput((previous) => `${previous}${value}`);
  }, []);

  const backspaceSearchText = useCallback(() => {
    setLibrarySearchInput((previous) => previous.slice(0, Math.max(0, previous.length - 1)));
  }, []);

  const handlePlayLibraryItem = useCallback((uri: string | null) => {
    if (!uri) return;
    setErrorMessage(null);
    setLibraryOpen(false);
    setKeyboardOpen(false);
    sendSet('ma:playMedia', { uri });
  }, []);

  const handleSetVolumeTargetPlayer = useCallback((playerId: string) => {
    if (!playerId) return;
    setVolumeControlScope('selected');
    setVolumeTargetPlayerId(playerId);
  }, []);

  const adjustMemberVolume = useCallback((playerId: string, delta: number) => {
    if (!playerId) return;
    sendSet('ma:adjustVolume', {
      delta,
      scope: 'selected',
      playerId,
    });
  }, []);

  const setShuffle = useCallback((enabled: boolean) => {
    sendSet('ma:setShuffle', { shuffleEnabled: enabled });
  }, []);

  const cycleRepeat = useCallback(() => {
    const rawMode = typeof activeQueue?.repeat_mode === 'string'
      ? activeQueue.repeat_mode.toLowerCase()
      : 'off';
    const currentMode = rawMode === 'all' || rawMode === 'one' ? rawMode : 'off';
    const nextMode = currentMode === 'off' ? 'all' : currentMode === 'all' ? 'one' : 'off';
    sendSet('ma:setRepeat', { repeatMode: nextMode });
  }, [activeQueue?.repeat_mode]);

  const sendTransport = useCallback((command: string) => {
    sendSet('ma:transport', { command });
  }, []);

  const refreshState = useCallback(() => {
    sendSet('ma:refresh');
    sendGet('ma:authProviders');
    if (status.authenticated) {
      setLibraryLoading(true);
      sendGet('ma:library', {
        mediaType: libraryMediaType,
        search: librarySearch,
        limit: 50,
      });
    }
  }, [libraryMediaType, librarySearch, status.authenticated]);

  const requiresAuthentication =
    status.authRequired === true || (status.connected && !status.authenticated);
  const statusLabel = status.authenticated
    ? 'Connected'
    : status.connected
      ? 'Auth Needed'
      : status.state === 'connecting'
        ? 'Connecting'
        : status.state === 'error'
          ? 'Error'
          : 'Offline';
  const proxiedAlbumArt =
    nowPlaying?.imageUrl && imageSources[toImageKey(nowPlaying.imageUrl, nowPlaying.imageProvider)]
      ? imageSources[toImageKey(nowPlaying.imageUrl, nowPlaying.imageProvider)]
      : null;
  const currentGroupLeaderId = controllingPlayer?.player_id || null;
  const currentGroupMemberSet = new Set(effectiveGroupedPlayers.map((player) => player.player_id));
  const shuffleEnabled = activeQueue?.shuffle_enabled === true;
  const repeatMode =
    typeof activeQueue?.repeat_mode === 'string' ? activeQueue.repeat_mode.toLowerCase() : 'off';
  const repeatLabel = repeatMode === 'all' ? 'Repeat all' : repeatMode === 'one' ? 'Repeat 1' : 'Repeat';

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="library-toggle-btn" onClick={() => setLibraryOpen(true)}>
          Library
        </button>
        <div className="topbar-actions">
          <span className={`status-pill ${statusTone(status.state)}`}>{statusLabel}</span>
          <button className="ghost-btn" onClick={refreshState} aria-label="Refresh">↻</button>
          {status.connected ? (
            <button className="ghost-btn" onClick={handleDisconnect}>Disconnect</button>
          ) : (
            <button className="primary-btn" onClick={handleConnect}>Connect</button>
          )}
        </div>
      </header>

      {requiresAuthentication && (
        <section className="panel auth-panel">
          <strong>Authentication Required</strong>
          <p className="hint">
            Use OAuth provider login. The backend will open your host browser and capture the callback token.
          </p>
          <div className="auth-row">
            <label htmlFor="provider-select">Provider</label>
            <select
              id="provider-select"
              value={selectedProviderId}
              onChange={handleProviderChange}
              disabled={authProviders.length === 0}
            >
              {authProviders.length === 0 && <option value="homeassistant">homeassistant</option>}
              {authProviders.map((provider) => (
                <option key={provider.provider_id} value={provider.provider_id}>
                  {provider.provider_id}
                </option>
              ))}
            </select>
            <button className="primary-btn" onClick={handleProviderLogin}>Login With Provider</button>
          </div>
          {oauthState?.message && (
            <p className="hint">
              OAuth: {oauthState.message}
            </p>
          )}
          {oauthState?.authorizationUrl && (
            <p className="hint auth-url">
              URL: {oauthState.authorizationUrl}
            </p>
          )}
        </section>
      )}

      <section className="panel now-playing-panel">
        <div className="cover-wrap">
          {proxiedAlbumArt || nowPlaying?.imageUrl ? (
            <img src={proxiedAlbumArt || nowPlaying?.imageUrl || ''} alt="Album art" className="cover" />
          ) : (
            <div className="cover placeholder">No Art</div>
          )}
        </div>
        <div className="track-meta">
          <h2>{nowPlaying?.title || 'Nothing Playing'}</h2>
          <p>{nowPlaying?.artist || '—'}</p>
          <p>{nowPlaying?.album || '—'}</p>
          <p>
            {formatDuration(nowPlaying?.position ?? null)} / {formatDuration(nowPlaying?.duration ?? null)}
          </p>
          <p>{nowPlaying?.isPlaying ? 'Playing' : 'Paused/Idle'}</p>
        </div>
      </section>

      <section className="panel controls-panel">
        <div className="player-picker-row">
          <button
            onClick={() => cyclePlayer(-1)}
            disabled={!status.authenticated || players.length < 2}
            aria-label="Previous player"
          >
            ◀
          </button>
          <button
            className="player-picker-btn"
            onClick={() => setPlayerPickerOpen(true)}
            disabled={!status.authenticated || players.length === 0}
          >
            {currentPlayer ? playerLabel(currentPlayer) : 'No players found'}
          </button>
          <button
            onClick={() => cyclePlayer(1)}
            disabled={!status.authenticated || players.length < 2}
            aria-label="Next player"
          >
            ▶
          </button>
        </div>

        <div className="player-summary">
          <span>Player state: {activePlayer?.state || 'unknown'}</span>
          <span>Available: {activePlayer?.available === false ? 'No' : 'Yes'}</span>
          <span>Powered: {activePlayer?.powered === false ? 'No' : 'Yes'}</span>
        </div>

        <div className="transport-row">
          <button className="icon-btn" onClick={() => sendTransport('previous')} aria-label="Previous" disabled={!status.authenticated}>◁◁</button>
          <button className="icon-btn" onClick={() => sendTransport('play_pause')} aria-label="Play Pause" disabled={!status.authenticated}>▷∥</button>
          <button className="icon-btn" onClick={() => sendTransport('next')} aria-label="Next" disabled={!status.authenticated}>▷▷</button>
          <button className="icon-btn" onClick={() => sendTransport('stop')} aria-label="Stop" disabled={!status.authenticated}>◼</button>
          <button
            onClick={() => setShuffle(!shuffleEnabled)}
            aria-label="Shuffle"
            title="Shuffle"
            disabled={!status.authenticated || !activeQueue}
            className={shuffleEnabled ? 'mode-btn toggle-on' : 'mode-btn'}
          >
            Shuffle
          </button>
          <button
            onClick={cycleRepeat}
            aria-label="Repeat"
            title={repeatLabel}
            disabled={!status.authenticated || !activeQueue}
            className={repeatMode !== 'off' ? 'mode-btn toggle-on' : 'mode-btn'}
          >
            {repeatLabel}
          </button>
        </div>

        <div className="volume-block">
          <div className="volume-label">
            <span>Volume</span>
            <strong>{displayVolume}%</strong>
          </div>
          <div className="volume-scope-row">
            <button
              className={effectiveVolumeScope === 'selected' ? 'icon-btn toggle-on' : 'icon-btn'}
              onClick={() => {
                setVolumeControlScope('selected');
                if (selectedPlayerId) setVolumeTargetPlayerId(selectedPlayerId);
              }}
              title="Control selected speaker volume"
              aria-label="Volume target selected speaker"
              disabled={!status.authenticated}
            >
              ◉
            </button>
            <button
              className={effectiveVolumeScope === 'group' ? 'icon-btn toggle-on' : 'icon-btn'}
              onClick={() => {
                setVolumeControlScope('group');
                setVolumeTargetPlayerId(null);
              }}
              title="Control joined group speaker volumes"
              aria-label="Volume target grouped speakers"
              disabled={!status.authenticated || !hasGroupedTargets}
            >
              ◉◉
            </button>
          </div>
          <div className="volume-track">
            <div className="volume-fill" style={{ width: `${displayVolume}%` }} />
          </div>
          <p className="hint">
            {status.authenticated
              ? `Use the wheel to adjust ${effectiveVolumeScope === 'group' ? 'group' : 'selected'} volume (${uiSettings.volumeScrollDelta} per step).`
              : 'Authenticate first to enable wheel volume control.'}
          </p>
          {effectiveGroupedPlayers.length > 0 && (
            <div className="group-volume-list">
              {effectiveGroupedPlayers.map((player) => {
                const playerVolume = typeof player.volume_level === 'number'
                  ? clamp(Math.round(player.volume_level))
                  : 0;
                const isVolumeTarget =
                  effectiveVolumeScope === 'selected'
                  && player.player_id === resolvedVolumeTargetId;

                return (
                  <div key={`vol-${player.player_id}`} className="group-volume-item">
                    <button
                      className={isVolumeTarget ? 'group-volume-target active' : 'group-volume-target'}
                      onClick={() => handleSetVolumeTargetPlayer(player.player_id)}
                      disabled={!status.authenticated}
                    >
                      {playerLabel(player)}
                    </button>
                    <span>{playerVolume}%</span>
                    <button
                      className="group-volume-step"
                      onClick={() => adjustMemberVolume(player.player_id, -uiSettings.volumeScrollDelta)}
                      disabled={!status.authenticated}
                    >
                      −
                    </button>
                    <button
                      className="group-volume-step"
                      onClick={() => adjustMemberVolume(player.player_id, uiSettings.volumeScrollDelta)}
                      disabled={!status.authenticated}
                    >
                      +
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="panel queue-panel">
        <div className="queue-header">
          <strong>Up Next</strong>
          <span>{queueItems.length} items</span>
        </div>
        {queueItems.length === 0 ? (
          <p className="hint">Queue is empty or unavailable for this player.</p>
        ) : (
          <div className="queue-list">
            {queueItems.slice(0, 10).map((item, index) => (
              <div
                key={item.queue_item_id || `${item.sort_index ?? index}-${queueItemTitle(item)}`}
                className="queue-item"
              >
                <span className="queue-index">{index + 1}</span>
                <div className="queue-text">
                  <strong>{queueItemTitle(item)}</strong>
                  <span>{queueItemArtist(item)}</span>
                </div>
                <span className="queue-duration">{formatDuration(item.duration ?? null)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <aside className={playerPickerOpen ? 'player-drawer open' : 'player-drawer'}>
        <div className="player-drawer-header">
          <strong>Select Player</strong>
          <div className="player-drawer-actions">
            <button
              className="ghost-btn"
              onClick={handleUngroupAllPlayers}
              disabled={!status.authenticated || !hasGroupedTargets}
            >
              Unjoin All
            </button>
            <button className="ghost-btn" onClick={() => setPlayerPickerOpen(false)}>
              Close
            </button>
          </div>
        </div>
        <p className="hint">
          Select a player to control. Add joins a speaker into the selected speaker group.
          Transfer moves playback to the target player. Unjoin removes a grouped speaker.
        </p>
        <div className="player-drawer-list">
          {players.length === 0 ? (
            <p className="hint">No players discovered.</p>
          ) : (
            players.map((player) => {
              const isSelected = player.player_id === selectedPlayerId;
              const isInCurrentGroup = currentGroupMemberSet.has(player.player_id);
              const isGroupLeader =
                currentGroupLeaderId === player.player_id
                && currentGroupMemberSet.size > 1;
              const canAddToGroup = !isSelected && !isInCurrentGroup;
              const canUngroupThisPlayer = isInCurrentGroup && !isGroupLeader && !isSelected;
              return (
                <div
                  key={player.player_id}
                  className={isSelected ? 'player-item selected' : 'player-item'}
                >
                  <button
                    className="player-item-main"
                    onClick={() => handleSelectPlayerId(player.player_id)}
                    disabled={!status.authenticated}
                  >
                    <strong>{playerLabel(player)}</strong>
                    <span>{player.player_id}</span>
                    <span className="player-tags">
                      {isSelected && <span className="tag-item active">Selected</span>}
                      {isGroupLeader && <span className="tag-item">Leader</span>}
                      {!isGroupLeader && isInCurrentGroup && <span className="tag-item">Grouped</span>}
                    </span>
                  </button>
                  <div className="player-item-actions">
                    {canAddToGroup && (
                      <button
                        onClick={() => handleJoinToPlayer(player.player_id)}
                        disabled={!status.authenticated}
                      >
                        Add
                      </button>
                    )}
                    {!isSelected && (
                      <button
                        onClick={() => handleTransferToPlayer(player.player_id)}
                        disabled={!status.authenticated}
                      >
                        Transfer
                      </button>
                    )}
                    {canUngroupThisPlayer && (
                      <button
                        onClick={() => handleUngroupPlayer(player.player_id)}
                        disabled={!status.authenticated}
                      >
                        Unjoin
                      </button>
                    )}
                    {isSelected && (
                      <button
                        onClick={handleUngroupSelectedPlayer}
                        disabled={!status.authenticated || currentGroupMemberSet.size <= 1}
                      >
                        Unjoin
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      <aside className={libraryOpen ? 'library-drawer open' : 'library-drawer'}>
        <div className="library-drawer-header">
          <strong>Music Library</strong>
          <button className="ghost-btn" onClick={() => {
            setLibraryOpen(false);
            setKeyboardOpen(false);
          }}>
            Close
          </button>
        </div>
        <section className="panel library-panel">
          <div className="library-header">
            <strong>Library</strong>
            <span>{libraryItems.length} items</span>
          </div>
          <div className="library-tabs">
            {(['tracks', 'artists', 'albums', 'playlists'] as MusicAssistantLibraryMediaType[]).map((type) => (
              <button
                key={type}
                className={type === libraryMediaType ? 'tab-btn active' : 'tab-btn'}
                onClick={() => handleLibraryTypeChange(type)}
                disabled={!status.authenticated}
              >
                {type}
              </button>
            ))}
          </div>
          <div className="library-search">
            <input
              value={librarySearchInput}
              onChange={handleLibrarySearchInput}
              onFocus={() => setKeyboardOpen(true)}
              placeholder={`Search ${libraryMediaType}`}
              disabled={!status.authenticated}
            />
            <button onClick={() => setKeyboardOpen((previous) => !previous)} disabled={!status.authenticated}>
              {keyboardOpen ? 'Hide Keys' : 'Keyboard'}
            </button>
            <button onClick={applyLibrarySearch} disabled={!status.authenticated}>
              Search
            </button>
            <button onClick={clearLibrarySearch} disabled={!status.authenticated}>
              Clear
            </button>
          </div>
          {keyboardOpen && status.authenticated && (
            <div className="keyboard-panel">
              {KEYBOARD_ROWS.map((row) => (
                <div key={row} className="keyboard-row">
                  {row.split('').map((key) => (
                    <button key={`${row}-${key}`} onClick={() => appendSearchText(key)}>
                      {key}
                    </button>
                  ))}
                </div>
              ))}
              <div className="keyboard-row keyboard-row-wide">
                <button onClick={() => appendSearchText(' ')}>Space</button>
                <button onClick={backspaceSearchText}>Backspace</button>
                <button onClick={applyLibrarySearch}>Enter</button>
                <button onClick={() => setKeyboardOpen(false)}>Close</button>
              </div>
            </div>
          )}
          {!status.authenticated ? (
            <p className="hint">Authenticate first to browse your library.</p>
          ) : libraryLoading ? (
            <p className="hint">Loading library…</p>
          ) : libraryItems.length === 0 ? (
            <p className="hint">No library items found for this filter.</p>
          ) : (
            <div className="library-list">
              {libraryItems.map((item) => (
                <div key={`${item.mediaType}-${item.uri || item.name}`} className="library-item">
                  <div className="library-text">
                    <strong>{item.name}</strong>
                    <span>{item.subtitle || item.provider || '—'}</span>
                  </div>
                  <button
                    onClick={() => handlePlayLibraryItem(item.uri)}
                    disabled={!status.authenticated || !item.uri}
                  >
                    Play
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </aside>
      {(libraryOpen || playerPickerOpen) && (
        <button
          className="library-backdrop"
          onClick={() => {
            setLibraryOpen(false);
            setKeyboardOpen(false);
            setPlayerPickerOpen(false);
          }}
          aria-label="Close open panel"
        />
      )}

      {errorMessage && (
        <section className="panel error-panel">
          <strong>Error:</strong> {errorMessage}
        </section>
      )}
    </div>
  );
}

export default App;
