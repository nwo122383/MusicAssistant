export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'authenticating'
  | 'authenticated'
  | 'error';

export interface MusicAssistantPlayer {
  player_id: string;
  display_name?: string;
  available?: boolean;
  powered?: boolean;
  state?: string;
  active_source?: string;
  volume_level?: number;
  volume_muted?: boolean;
  group_members?: string[];
  synced_to?: string | null;
  active_group?: string | null;
}

export interface MusicAssistantQueue {
  queue_id: string;
  player_id?: string;
  state?: string;
  shuffle_enabled?: boolean;
  repeat_mode?: 'off' | 'one' | 'all' | string;
  elapsed_time?: number;
  current_item?: unknown;
}

export interface MusicAssistantImageRef {
  path?: string;
  url?: string;
}

export interface MusicAssistantQueueItem {
  queue_item_id?: string;
  name?: string;
  artist_str?: string;
  duration?: number;
  sort_index?: number;
  image?: MusicAssistantImageRef | null;
  media_item?: {
    name?: string;
    artist_str?: string;
    image?: MusicAssistantImageRef | null;
  } | null;
}

export interface NowPlayingSummary {
  title: string;
  artist: string;
  album: string;
  imageUrl: string | null;
  imageProvider?: string | null;
  duration: number | null;
  position: number | null;
  isPlaying: boolean;
}

export interface MusicAssistantStatusPayload {
  state: ConnectionState;
  message: string;
  connected: boolean;
  authenticated: boolean;
  authRequired?: boolean;
  selectedPlayerId: string | null;
  serverInfo?: {
    server_id?: string;
    server_version?: string;
    schema_version?: number;
  } | null;
}

export interface MusicAssistantPlayersPayload {
  players: MusicAssistantPlayer[];
  selectedPlayerId: string | null;
}

export interface MusicAssistantStatePayload {
  selectedPlayerId: string | null;
  player: MusicAssistantPlayer | null;
  queue: MusicAssistantQueue | null;
  queueItems: MusicAssistantQueueItem[];
  nowPlaying: NowPlayingSummary | null;
  updatedAt: number;
}

export interface MusicAssistantErrorPayload {
  request?: string;
  message: string;
  at?: number;
}

export interface MusicAssistantAuthProvider {
  provider_id: string;
  provider_type: string;
  requires_redirect: boolean;
}

export interface MusicAssistantOAuthPayload {
  phase: 'starting' | 'browser_opened' | 'waiting_callback' | 'token_received' | 'success' | 'error';
  message: string;
  providerId?: string;
  authorizationUrl?: string;
  returnUrl?: string;
  openedBrowser?: boolean;
  at?: number;
}

export interface MusicAssistantImagePayload {
  source: string;
  provider?: string | null;
  dataUri: string | null;
  error?: string;
  cached?: boolean;
  updatedAt?: number;
}

export type MusicAssistantLibraryMediaType =
  | 'artists'
  | 'albums'
  | 'tracks'
  | 'playlists';

export interface MusicAssistantLibraryItem {
  uri: string | null;
  mediaType: MusicAssistantLibraryMediaType;
  name: string;
  subtitle: string;
  imageUrl: string | null;
  provider: string | null;
}

export interface MusicAssistantLibraryPayload {
  mediaType: MusicAssistantLibraryMediaType;
  search: string;
  items: MusicAssistantLibraryItem[];
  updatedAt: number;
}

export interface UISettings {
  darkMode: boolean;
  volumeScrollDelta: number;
}

export type VolumeControlScope = 'selected' | 'group';
