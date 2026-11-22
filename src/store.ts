import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  type Unsubscribe
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';
import {
  BLUEPRINT_LIMITS,
  TRACK_COLORS,
  type LegacySetEntry,
  type LegacyTrackEntry,
  type SetConfig,
  type TrackButton,
  type TrackColor
} from './types';

function clampString(value: unknown, maxLen: number, fallback = ''): string {
  const str = typeof value === 'string' ? value.trim() : fallback;
  return str.slice(0, maxLen);
}

export function makeSafeId(prefix: string, seed?: string): string {
  const cleanedSeed = (seed || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const raw = cleanedSeed ? `${prefix}_${cleanedSeed}` : `${prefix}_${suffix}`;
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, BLUEPRINT_LIMITS.ID_MAX);
  return BLUEPRINT_LIMITS.ID_REGEX.test(safe) ? safe : `${prefix}_${suffix}`;
}

export function normalizeColor(rawColor: unknown): TrackColor {
  if (typeof rawColor === 'string') {
    const lower = rawColor.trim().toLowerCase() as TrackColor;
    if ((TRACK_COLORS as readonly string[]).includes(lower)) {
      return lower;
    }
  }
  return 'blue';
}

export function normalizeLyrics(rawLyrics: unknown): string[] {
  if (!Array.isArray(rawLyrics)) return [];
  return rawLyrics
    .filter((line): line is string => typeof line === 'string')
    .map((line) => line.trim().slice(0, BLUEPRINT_LIMITS.TRACK_LYRIC_LINE_MAX))
    .filter((line) => line.length > 0)
    .slice(0, BLUEPRINT_LIMITS.TRACK_LYRICS_MAX_ITEMS);
}

export function normalizeOrder(order: number): number {
  if (!Number.isFinite(order)) return 0;
  return Math.max(0, Math.min(BLUEPRINT_LIMITS.ORDER_MAX, Math.floor(order)));
}

export function subscribeToSets(
  onData: (sets: SetConfig[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const path = 'sets';
  const q = query(collection(db, path), orderBy('order', 'asc'));
  return onSnapshot(
    q,
    (snapshot) => {
      const sets: SetConfig[] = snapshot.docs.map((docSnap) => {
        const d = docSnap.data();
        return {
          id: typeof d.id === 'string' ? d.id : docSnap.id,
          legacyId: typeof d.legacyId === 'number' ? d.legacyId : undefined,
          label: typeof d.label === 'string' ? d.label : 'Untitled Set',
          sourceFile: typeof d.sourceFile === 'string' ? d.sourceFile : undefined,
          order: typeof d.order === 'number' ? d.order : 0,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt
        };
      });
      onData(sets);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) {
          onError(wrapped);
        }
      }
    }
  );
}

export function subscribeToTracks(
  setId: string,
  onData: (tracks: TrackButton[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const path = `sets/${setId}/tracks`;
  const q = query(collection(db, 'sets', setId, 'tracks'), orderBy('order', 'asc'));
  return onSnapshot(
    q,
    (snapshot) => {
      const tracks: TrackButton[] = snapshot.docs.map((docSnap) => {
        const d = docSnap.data();
        return {
          id: typeof d.id === 'string' ? d.id : docSnap.id,
          setId: typeof d.setId === 'string' ? d.setId : setId,
          title: typeof d.title === 'string' ? d.title : 'Untitled Track',
          color: normalizeColor(d.color),
          file: typeof d.file === 'string' ? d.file : 'audio/filename.mp3',
          cue: typeof d.cue === 'string' ? d.cue : '',
          lyrics: Array.isArray(d.lyrics) ? d.lyrics.filter((l): l is string => typeof l === 'string') : [],
          order: typeof d.order === 'number' ? d.order : 0,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt
        };
      });
      onData(tracks);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) {
          onError(wrapped);
        }
      }
    }
  );
}

export async function fetchSetsOnce(): Promise<SetConfig[]> {
  const path = 'sets';
  try {
    const snap = await getDocs(query(collection(db, path), orderBy('order', 'asc')));
    return snap.docs.map((docSnap) => {
      const d = docSnap.data();
      return {
        id: typeof d.id === 'string' ? d.id : docSnap.id,
        legacyId: typeof d.legacyId === 'number' ? d.legacyId : undefined,
        label: typeof d.label === 'string' ? d.label : 'Untitled Set',
        sourceFile: typeof d.sourceFile === 'string' ? d.sourceFile : undefined,
        order: typeof d.order === 'number' ? d.order : 0,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt
      };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function fetchTracksOnce(setId: string): Promise<TrackButton[]> {
  const path = `sets/${setId}/tracks`;
  try {
    const snap = await getDocs(query(collection(db, 'sets', setId, 'tracks'), orderBy('order', 'asc')));
    return snap.docs.map((docSnap) => {
      const d = docSnap.data();
      return {
        id: typeof d.id === 'string' ? d.id : docSnap.id,
        setId: typeof d.setId === 'string' ? d.setId : setId,
        title: typeof d.title === 'string' ? d.title : 'Untitled Track',
        color: normalizeColor(d.color),
        file: typeof d.file === 'string' ? d.file : 'audio/filename.mp3',
        cue: typeof d.cue === 'string' ? d.cue : '',
        lyrics: Array.isArray(d.lyrics) ? d.lyrics.filter((l): l is string => typeof l === 'string') : [],
        order: typeof d.order === 'number' ? d.order : 0,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt
      };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function createSet(
  label: string,
  order: number,
  options?: { id?: string; legacyId?: number; sourceFile?: string }
): Promise<SetConfig> {
  const cleanLabel = clampString(label, BLUEPRINT_LIMITS.SET_LABEL_MAX) || 'New Ceremonial Set';
  const id = options?.id && BLUEPRINT_LIMITS.ID_REGEX.test(options.id)
    ? options.id.slice(0, BLUEPRINT_LIMITS.ID_MAX)
    : makeSafeId('set', `${cleanLabel}_${Date.now().toString(36)}`);
  const path = `sets/${id}`;

  const payload: Record<string, unknown> = {
    id,
    label: cleanLabel,
    order: normalizeOrder(order),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  if (typeof options?.legacyId === 'number' && Number.isInteger(options.legacyId) && options.legacyId >= 0) {
    payload.legacyId = options.legacyId;
  }
  if (options?.sourceFile) {
    payload.sourceFile = clampString(options.sourceFile, BLUEPRINT_LIMITS.SOURCE_FILE_MAX);
  }

  try {
    await setDoc(doc(db, 'sets', id), payload);
    return {
      id,
      label: cleanLabel,
      legacyId: options?.legacyId,
      sourceFile: options?.sourceFile,
      order: normalizeOrder(order)
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateSet(
  setId: string,
  updates: { label?: string; order?: number }
): Promise<void> {
  const path = `sets/${setId}`;
  const payload: Record<string, unknown> = {
    updatedAt: serverTimestamp()
  };
  if (updates.label !== undefined) {
    const cleanLabel = clampString(updates.label, BLUEPRINT_LIMITS.SET_LABEL_MAX);
    if (!cleanLabel) {
      throw new Error('Set label cannot be empty.');
    }
    payload.label = cleanLabel;
  }
  if (updates.order !== undefined) {
    payload.order = normalizeOrder(updates.order);
  }

  try {
    await updateDoc(doc(db, 'sets', setId), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function reorderSets(orderedSetIds: string[]): Promise<void> {
  const path = 'sets';
  try {
    const batch = writeBatch(db);
    orderedSetIds.forEach((setId, idx) => {
      batch.update(doc(db, 'sets', setId), {
        order: normalizeOrder(idx),
        updatedAt: serverTimestamp()
      });
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteSetAndTracks(setId: string): Promise<void> {
  const path = `sets/${setId}`;
  try {
    const existingTracks = await fetchTracksOnce(setId);
    const chunkSize = 400;
    for (let i = 0; i < existingTracks.length; i += chunkSize) {
      const batch = writeBatch(db);
      const chunk = existingTracks.slice(i, i + chunkSize);
      chunk.forEach((track) => {
        batch.delete(doc(db, 'sets', setId, 'tracks', track.id));
      });
      if (i + chunkSize >= existingTracks.length) {
        batch.delete(doc(db, 'sets', setId));
      }
      await batch.commit();
    }
    if (existingTracks.length === 0) {
      await deleteDoc(doc(db, 'sets', setId));
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function createTrack(
  setId: string,
  input: {
    id?: string;
    title: string;
    color: TrackColor | string;
    file: string;
    cue: string;
    lyrics: string[];
    order: number;
  }
): Promise<TrackButton> {
  const id = input.id && BLUEPRINT_LIMITS.ID_REGEX.test(input.id)
    ? input.id.slice(0, BLUEPRINT_LIMITS.ID_MAX)
    : makeSafeId('track');
  const path = `sets/${setId}/tracks/${id}`;

  const cleanTitle = clampString(input.title, BLUEPRINT_LIMITS.TRACK_TITLE_MAX) || 'New Track';
  const cleanColor = normalizeColor(input.color);
  const cleanFile = clampString(input.file, BLUEPRINT_LIMITS.TRACK_FILE_MAX) || 'audio/filename.mp3';
  const cleanCue = clampString(input.cue, BLUEPRINT_LIMITS.TRACK_CUE_MAX);
  const cleanLyrics = normalizeLyrics(input.lyrics);
  const cleanOrder = normalizeOrder(input.order);

  try {
    await setDoc(doc(db, 'sets', setId, 'tracks', id), {
      id,
      setId,
      title: cleanTitle,
      color: cleanColor,
      file: cleanFile,
      cue: cleanCue,
      lyrics: cleanLyrics,
      order: cleanOrder,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return {
      id,
      setId,
      title: cleanTitle,
      color: cleanColor,
      file: cleanFile,
      cue: cleanCue,
      lyrics: cleanLyrics,
      order: cleanOrder
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateTrack(
  setId: string,
  trackId: string,
  updates: Partial<Pick<TrackButton, 'title' | 'color' | 'file' | 'cue' | 'lyrics' | 'order'>>
): Promise<void> {
  const path = `sets/${setId}/tracks/${trackId}`;
  const payload: Record<string, unknown> = {
    updatedAt: serverTimestamp()
  };

  if (updates.title !== undefined) {
    const cleanTitle = clampString(updates.title, BLUEPRINT_LIMITS.TRACK_TITLE_MAX);
    if (!cleanTitle) {
      throw new Error('Button text cannot be empty.');
    }
    payload.title = cleanTitle;
  }
  if (updates.color !== undefined) {
    payload.color = normalizeColor(updates.color);
  }
  if (updates.file !== undefined) {
    const cleanFile = clampString(updates.file, BLUEPRINT_LIMITS.TRACK_FILE_MAX);
    if (!cleanFile) {
      throw new Error('Audio file path cannot be empty.');
    }
    payload.file = cleanFile;
  }
  if (updates.cue !== undefined) {
    payload.cue = clampString(updates.cue, BLUEPRINT_LIMITS.TRACK_CUE_MAX);
  }
  if (updates.lyrics !== undefined) {
    payload.lyrics = normalizeLyrics(updates.lyrics);
  }
  if (updates.order !== undefined) {
    payload.order = normalizeOrder(updates.order);
  }

  try {
    await updateDoc(doc(db, 'sets', setId, 'tracks', trackId), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function reorderTracks(setId: string, orderedTrackIds: string[]): Promise<void> {
  const path = `sets/${setId}/tracks`;
  try {
    const chunkSize = 400;
    for (let i = 0; i < orderedTrackIds.length; i += chunkSize) {
      const batch = writeBatch(db);
      const chunk = orderedTrackIds.slice(i, i + chunkSize);
      chunk.forEach((trackId, offset) => {
        batch.update(doc(db, 'sets', setId, 'tracks', trackId), {
          order: normalizeOrder(i + offset),
          updatedAt: serverTimestamp()
        });
      });
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteTrack(setId: string, trackId: string): Promise<void> {
  const path = `sets/${setId}/tracks/${trackId}`;
  try {
    await deleteDoc(doc(db, 'sets', setId, 'tracks', trackId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function importTracksIntoSet(
  setId: string,
  legacyTracks: LegacyTrackEntry[],
  mode: 'append' | 'replace',
  startingOrder = 0
): Promise<number> {
  const path = `sets/${setId}/tracks`;
  try {
    if (mode === 'replace') {
      const existingTracks = await fetchTracksOnce(setId);
      const chunkSize = 400;
      for (let i = 0; i < existingTracks.length; i += chunkSize) {
        const batch = writeBatch(db);
        existingTracks.slice(i, i + chunkSize).forEach((t) => {
          batch.delete(doc(db, 'sets', setId, 'tracks', t.id));
        });
        await batch.commit();
      }
    }

    const validTracks = legacyTracks.filter((t) => t && (t.title || t.file));
    const chunkSize = 400;
    for (let i = 0; i < validTracks.length; i += chunkSize) {
      const batch = writeBatch(db);
      const chunk = validTracks.slice(i, i + chunkSize);
      chunk.forEach((raw, offset) => {
        const order = normalizeOrder((mode === 'replace' ? 0 : startingOrder) + i + offset);
        const trackId = makeSafeId('trk', `${order}_${Date.now().toString(36)}_${offset}_${raw.title || 'item'}`);
        batch.set(doc(db, 'sets', setId, 'tracks', trackId), {
          id: trackId,
          setId,
          title: clampString(raw.title, BLUEPRINT_LIMITS.TRACK_TITLE_MAX, 'Untitled Button') || 'Untitled Button',
          color: normalizeColor(raw.color),
          file: clampString(raw.file, BLUEPRINT_LIMITS.TRACK_FILE_MAX, 'audio/filename.mp3') || 'audio/filename.mp3',
          cue: clampString(raw.cue, BLUEPRINT_LIMITS.TRACK_CUE_MAX, ''),
          lyrics: normalizeLyrics(raw.lyrics),
          order,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      });
      await batch.commit();
    }
    return validTracks.length;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export interface MigrationResult {
  setsImported: number;
  tracksImported: number;
  setsSkipped: number;
}

export async function migrateLegacyConfiguration(options: {
  mode: 'merge' | 'replace';
  includeFiller?: boolean;
  includeMark?: boolean;
}): Promise<MigrationResult> {
  const setsResponse = await fetch('/sets.json?v=' + Date.now());
  if (!setsResponse.ok) {
    throw new Error('Could not load sets.json from server.');
  }
  const legacySets = (await setsResponse.json()) as LegacySetEntry[];

  const allEntries: Array<{
    setId: string;
    legacyId?: number;
    label: string;
    sourceFile: string;
  }> = legacySets.map((s) => {
    const fileBase = (s.file || '').replace(/\.json$/i, '');
    const setId = makeSafeId('set', fileBase || String(s.id));
    const numericId = typeof s.id === 'number' ? s.id : Number.parseInt(String(s.id), 10);
    return {
      setId,
      legacyId: Number.isInteger(numericId) && numericId >= 0 ? numericId : undefined,
      label: clampString(s.label, BLUEPRINT_LIMITS.SET_LABEL_MAX, 'Untitled Set') || 'Untitled Set',
      sourceFile: clampString(s.file, BLUEPRINT_LIMITS.SOURCE_FILE_MAX)
    };
  });

  if (options.includeFiller) {
    allEntries.push({
      setId: 'set_filler',
      label: 'Filler Music',
      sourceFile: 'filler.json'
    });
  }
  if (options.includeMark) {
    allEntries.push({
      setId: 'set_mark',
      label: 'Mark Degree',
      sourceFile: 'mark.json'
    });
  }

  const existingSets = await fetchSetsOnce();

  if (options.mode === 'replace') {
    for (const existingSet of existingSets) {
      await deleteSetAndTracks(existingSet.id);
    }
  }

  const existingIds = new Set(options.mode === 'replace' ? [] : existingSets.map((s) => s.id));
  const existingFiles = new Set(
    options.mode === 'replace' ? [] : existingSets.map((s) => s.sourceFile).filter(Boolean)
  );

  let setsImported = 0;
  let tracksImported = 0;
  let setsSkipped = 0;
  let nextOrder = options.mode === 'replace' ? 0 : existingSets.length;

  for (const entry of allEntries) {
    if (options.mode === 'merge' && (existingIds.has(entry.setId) || existingFiles.has(entry.sourceFile))) {
      setsSkipped++;
      continue;
    }

    let rawTracks: LegacyTrackEntry[] = [];
    try {
      const trackRes = await fetch('/' + entry.sourceFile + '?v=' + Date.now());
      if (trackRes.ok) {
        const parsed = await trackRes.json();
        if (Array.isArray(parsed)) {
          rawTracks = parsed as LegacyTrackEntry[];
        }
      }
    } catch {
      rawTracks = [];
    }

    // Write set and its tracks atomically in batches (using existsAfter in rules!)
    const validTracks = rawTracks.filter((t) => t && (t.title || t.file));
    const setPayload: Record<string, unknown> = {
      id: entry.setId,
      label: entry.label,
      sourceFile: entry.sourceFile,
      order: normalizeOrder(nextOrder),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };
    if (entry.legacyId !== undefined) {
      setPayload.legacyId = entry.legacyId;
    }

    try {
      const firstBatch = writeBatch(db);
      firstBatch.set(doc(db, 'sets', entry.setId), setPayload);

      const firstChunk = validTracks.slice(0, 350);
      firstChunk.forEach((raw, idx) => {
        const trackId = makeSafeId('trk', `${idx}_${raw.title || 'item'}`);
        firstBatch.set(doc(db, 'sets', entry.setId, 'tracks', trackId), {
          id: trackId,
          setId: entry.setId,
          title: clampString(raw.title, BLUEPRINT_LIMITS.TRACK_TITLE_MAX, 'Untitled Button') || 'Untitled Button',
          color: normalizeColor(raw.color),
          file: clampString(raw.file, BLUEPRINT_LIMITS.TRACK_FILE_MAX, 'audio/filename.mp3') || 'audio/filename.mp3',
          cue: clampString(raw.cue, BLUEPRINT_LIMITS.TRACK_CUE_MAX, ''),
          lyrics: normalizeLyrics(raw.lyrics),
          order: normalizeOrder(idx),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      });

      await firstBatch.commit();

      if (validTracks.length > 350) {
        for (let i = 350; i < validTracks.length; i += 400) {
          const batch = writeBatch(db);
          const chunk = validTracks.slice(i, i + 400);
          chunk.forEach((raw, offset) => {
            const idx = i + offset;
            const trackId = makeSafeId('trk', `${idx}_${raw.title || 'item'}`);
            batch.set(doc(db, 'sets', entry.setId, 'tracks', trackId), {
              id: trackId,
              setId: entry.setId,
              title: clampString(raw.title, BLUEPRINT_LIMITS.TRACK_TITLE_MAX, 'Untitled Button') || 'Untitled Button',
              color: normalizeColor(raw.color),
              file: clampString(raw.file, BLUEPRINT_LIMITS.TRACK_FILE_MAX, 'audio/filename.mp3') || 'audio/filename.mp3',
              cue: clampString(raw.cue, BLUEPRINT_LIMITS.TRACK_CUE_MAX, ''),
              lyrics: normalizeLyrics(raw.lyrics),
              order: normalizeOrder(idx),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
          });
          await batch.commit();
        }
      }

      setsImported++;
      tracksImported += validTracks.length;
      nextOrder++;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `sets/${entry.setId}`);
    }
  }

  return { setsImported, tracksImported, setsSkipped };
}
