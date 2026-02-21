import { useEffect, useState } from 'react';
import { DeskThing } from '@deskthing/client';
import type { UISettings } from './types';

const DEFAULT_SETTINGS: UISettings = {
  darkMode: true,
  volumeScrollDelta: 2,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readValue(raw: Record<string, unknown> | null, key: string): unknown {
  if (!raw) return undefined;
  const entry = raw[key];
  if (typeof entry === 'object' && entry !== null && 'value' in entry) {
    return (entry as { value?: unknown }).value;
  }
  return entry;
}

function parseBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

function parseNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSettings(raw: unknown): UISettings {
  const settings = asRecord(raw);
  return {
    darkMode: parseBool(readValue(settings, 'dark_mode'), DEFAULT_SETTINGS.darkMode),
    volumeScrollDelta: Math.max(
      1,
      Math.round(
        parseNumber(readValue(settings, 'volume_scroll_delta'), DEFAULT_SETTINGS.volumeScrollDelta),
      ),
    ),
  };
}

export function useDeskThingSettings(): UISettings {
  const [settings, setSettings] = useState<UISettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      const raw = await DeskThing.getSettings();
      if (mounted) {
        setSettings(normalizeSettings(raw));
      }
    };

    void load();

    const offSettings = DeskThing.on('settings', (data) => {
      setSettings(normalizeSettings(data.payload));
    });

    const offSettingsUpdated = DeskThing.on('settingsUpdated', (data) => {
      setSettings(normalizeSettings(data.payload));
    });

    return () => {
      mounted = false;
      offSettings();
      offSettingsUpdated();
    };
  }, []);

  return settings;
}
