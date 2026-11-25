export const TRACK_COLORS = [
  'darkblue',
  'blue',
  'yellow',
  'green',
  'red',
  'orange',
  'purple'
] as const;

export type TrackColor = (typeof TRACK_COLORS)[number];

export const TRACK_COLOR_META: Record<TrackColor, { label: string; hex: string; border: string }> = {
  darkblue: { label: 'Dark Blue', hex: '#1d4ed8', border: '#60a5fa' },
  blue: { label: 'Blue', hex: '#0284c7', border: '#38bdf8' },
  yellow: { label: 'Gold / Yellow', hex: '#b45309', border: '#fcd34d' },
  green: { label: 'Green', hex: '#047857', border: '#34d399' },
  red: { label: 'Red', hex: '#dc2626', border: '#ff7b89' },
  orange: { label: 'Orange', hex: '#c2410c', border: '#fb923c' },
  purple: { label: 'Purple', hex: '#7e22ce', border: '#c084fc' }
};

export const BLUEPRINT_LIMITS = {
  ID_REGEX: /^[a-zA-Z0-9_-]+$/,
  ID_MAX: 128,
  SET_LABEL_MAX: 80,
  SOURCE_FILE_MAX: 120,
  TRACK_TITLE_MAX: 100,
  TRACK_FILE_MAX: 300,
  TRACK_CUE_MAX: 500,
  TRACK_LYRICS_MAX_ITEMS: 100,
  TRACK_LYRIC_LINE_MAX: 1000,
  ORDER_MAX: 10000
} as const;

export interface SetConfig {
  id: string;
  legacyId?: number;
  label: string;
  sourceFile?: string;
  order: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface TrackButton {
  id: string;
  setId: string;
  title: string;
  color: TrackColor;
  file: string;
  cue: string;
  lyrics: string[];
  order: number;
  lockedTop?: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface LegacySetEntry {
  id: number | string;
  label: string;
  file: string;
}

export interface LegacyTrackEntry {
  id?: string;
  title?: string;
  color?: string;
  file?: string;
  cue?: string;
  lyrics?: string[];
  lockedTop?: boolean;
}
