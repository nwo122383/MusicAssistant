import { DeskThing } from '@deskthing/server';
import { AppSettings, SETTING_TYPES } from '@deskthing/types';

export interface MusicAssistantSettings {
  baseUrl: string;
  token: string;
  authProvider: string;
  defaultPlayerId: string;
  volumeScrollDelta: number;
  darkMode: boolean;
  pollIntervalMs: number;
}

type SettingEntry = { value?: unknown } | undefined;
type RawSettings = Record<string, SettingEntry> | undefined;
const DEFAULT_BASE_URL = 'http://homeassistant.local:8095';

const state: MusicAssistantSettings = {
  baseUrl: '',
  token: '',
  authProvider: 'homeassistant',
  defaultPlayerId: '',
  volumeScrollDelta: 2,
  darkMode: true,
  pollIntervalMs: 2000,
};

let lastLoadedAt = 0;

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed) || /^wss?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, '');
  }
  return `http://${trimmed.replace(/\/+$/, '')}`;
}

function toNumber(input: unknown, fallback: number): number {
  const value = Number(input);
  return Number.isFinite(value) ? value : fallback;
}

function toBool(input: unknown, fallback: boolean): boolean {
  if (typeof input === 'boolean') return input;
  if (typeof input === 'string') {
    const normalized = input.toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function readValue(entry: SettingEntry): unknown {
  return entry?.value;
}

function applySettings(raw: RawSettings): void {
  const baseUrlRaw = readValue(raw?.ma_url);
  const tokenRaw = readValue(raw?.ma_token);
  const authProviderRaw = readValue(raw?.ma_auth_provider);
  const defaultPlayerIdRaw = readValue(raw?.ma_default_player_id);
  const scrollDeltaRaw = readValue(raw?.volume_scroll_delta);
  const darkModeRaw = readValue(raw?.dark_mode);
  const pollIntervalRaw = readValue(raw?.poll_interval_ms);

  state.baseUrl = normalizeBaseUrl(String(baseUrlRaw ?? DEFAULT_BASE_URL));
  if (!state.baseUrl) {
    state.baseUrl = DEFAULT_BASE_URL;
  }
  state.token = String(tokenRaw ?? '').trim();
  state.authProvider = String(authProviderRaw ?? 'homeassistant').trim() || 'homeassistant';
  state.defaultPlayerId = String(defaultPlayerIdRaw ?? '').trim();
  state.volumeScrollDelta = Math.max(1, Math.round(toNumber(scrollDeltaRaw, 2)));
  state.darkMode = toBool(darkModeRaw, true);
  state.pollIntervalMs = Math.max(1000, Math.round(toNumber(pollIntervalRaw, 2000)));
}

export async function initSettings(): Promise<void> {
  const settings: AppSettings = {
    ma_url: {
      id: 'ma_url',
      label: 'Music Assistant URL',
      description: 'Base URL for Music Assistant, e.g. http://homeassistant.local:8095',
      type: SETTING_TYPES.STRING,
      value: state.baseUrl || DEFAULT_BASE_URL,
    },
    ma_token: {
      id: 'ma_token',
      label: 'Music Assistant Token',
      description: 'Long-lived token used for Music Assistant authentication.',
      type: SETTING_TYPES.STRING,
      value: state.token,
    },
    ma_auth_provider: {
      id: 'ma_auth_provider',
      label: 'OAuth Provider',
      description: 'Provider id used when starting browser login (e.g. homeassistant).',
      type: SETTING_TYPES.STRING,
      value: state.authProvider || 'homeassistant',
    },
    ma_default_player_id: {
      id: 'ma_default_player_id',
      label: 'Default Player ID',
      description: 'Optional player_id to auto-select on startup.',
      type: SETTING_TYPES.STRING,
      value: state.defaultPlayerId,
    },
    volume_scroll_delta: {
      id: 'volume_scroll_delta',
      label: 'Scroll Volume Delta',
      description: 'Volume step used by wheel scrolling.',
      type: SETTING_TYPES.NUMBER,
      value: state.volumeScrollDelta,
    },
    dark_mode: {
      id: 'dark_mode',
      label: 'Dark Mode',
      description: 'Enable dark theme in the webapp.',
      type: SETTING_TYPES.BOOLEAN,
      value: state.darkMode,
    },
    poll_interval_ms: {
      id: 'poll_interval_ms',
      label: 'Poll Interval (ms)',
      description: 'How often player/queue state refreshes.',
      type: SETTING_TYPES.NUMBER,
      value: state.pollIntervalMs,
    },
  };

  DeskThing.initSettings(settings);
  await refreshSettings(true);
}

export async function refreshSettings(force = false): Promise<MusicAssistantSettings> {
  const now = Date.now();
  if (!force && now - lastLoadedAt < 1500) {
    return { ...state };
  }

  const saved = (await DeskThing.getSettings()) as RawSettings;
  applySettings(saved);
  lastLoadedAt = Date.now();
  return { ...state };
}

export function getMusicAssistantSettings(): MusicAssistantSettings {
  return { ...state };
}
