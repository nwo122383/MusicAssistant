export interface MAServerInfoMessage {
  server_id: string;
  server_version: string;
  schema_version: number;
  min_supported_schema_version?: number;
}

export interface MAEventMessage {
  event: string;
  object_id?: string;
  data?: unknown;
}

export interface MAResultSuccessMessage {
  message_id: string;
  result: unknown;
  partial?: boolean;
}

export interface MAResultErrorMessage {
  message_id: string;
  error_code: string;
  details?: string;
}

export interface MAPlayer {
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

export interface MAImage {
  path?: string;
  url?: string;
  provider?: string;
}

export interface MAMediaAlbum {
  name?: string;
}

export interface MAMediaItem {
  name?: string;
  artist_str?: string;
  album?: MAMediaAlbum;
  image?: MAImage | null;
}

export interface MAQueueItem {
  queue_item_id?: string;
  name?: string;
  artist_str?: string;
  duration?: number;
  sort_index?: number;
  image?: MAImage | null;
  media_item?: MAMediaItem | null;
}

export interface MAQueue {
  queue_id: string;
  player_id?: string;
  state?: string;
  shuffle_enabled?: boolean;
  repeat_mode?: string;
  elapsed_time?: number;
  current_item?: MAQueueItem | null;
}
