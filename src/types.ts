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
  darkblue: { label: 'Dark Blue', hex: '#26354a', border: '#384a66' },
  blue: { label: 'Blue', hex: '#4a6785', border: '#5c7fa3' },
  yellow: { label: 'Gold / Yellow', hex: '#7a5a13', border: '#a87d1c' },
  green: { label: 'Green', hex: '#1b4f2e', border: '#277042' },
  red: { label: 'Red', hex: '#661a1a', border: '#8f2626' },
  orange: { label: 'Orange', hex: '#7a3711', border: '#a84b18' },
  purple: { label: 'Purple', hex: '#3f1b69', border: '#592891' }
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
}
