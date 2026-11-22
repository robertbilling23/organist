import type { User } from 'firebase/auth';
import {
  checkIsAdminUser,
  signInWithGoogle,
  signOutUser,
  subscribeAuth
} from './firebase';
import {
  migrateLegacyConfiguration,
  subscribeToSets,
  subscribeToTracks
} from './store';
import type { SetConfig, TrackButton } from './types';

declare global {
  interface Navigator {
    connection?: {
      type?: string;
      saveData?: boolean;
    };
  }
}

interface MediaElementAsset {
  isMediaElement: true;
  url: string;
  duration: number;
}

type DecodedAsset = AudioBuffer | MediaElementAsset;

function isMediaElementAsset(asset: DecodedAsset): asset is MediaElementAsset {
  return 'isMediaElement' in asset && asset.isMediaElement === true;
}

const DETERMINISTIC_TRACK_WEIGHTS: Record<string, number> = {
  opening: 3.4,
  closing: 4.1,
  first: 2.8,
  second: 3.1,
  third: 3.9,
  installed: 5.2,
  anthem: 2.5,
  vessel: 3.0,
  procession: 4.5,
  recessional: 3.8
};

let dynamicSets: SetConfig[] = [];
let activeSet: SetConfig | null = null;
let tracks: TrackButton[] = [];
let currentTrackIndex = 0;

let currentUser: User | null = null;
let isAdmin = false;

let unsubscribeSets: (() => void) | null = null;
let unsubscribeTracks: (() => void) | null = null;
let initialUrlHandled = false;

let audioCtx: AudioContext | null = null;
const audioCache: Record<string, DecodedAsset> = {};
const audioErrors: Record<string, string> = {};
const cachedBytesCounter: Record<string, number> = {};

let currentSource: AudioBufferSourceNode | null = null;
let currentMediaEl: HTMLAudioElement | null = null;
let gainNode: GainNode | null = null;

let isPlaying = false;
let startTime = 0;
let pausedTime = 0;
let trackDuration = 0;
let timeUpdateInterval: ReturnType<typeof setInterval> | null = null;

let currentVolume = 1.0;
let volumeFadeInterval: ReturnType<typeof setInterval> | null = null;
let fadeInterval: ReturnType<typeof setInterval> | null = null;

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function showToast(message: string, variant: 'info' | 'success' | 'error' = 'info'): void {
  const toast = byId<HTMLDivElement>('appToast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `app-toast visible toast-${variant}`;
  window.setTimeout(() => {
    toast.classList.remove('visible');
  }, 3600);
}

function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function getAudioMimeType(filePath: string): string {
  const lower = (filePath || '').toLowerCase();
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.aac')) return 'audio/aac';
  if (lower.endsWith('.flac')) return 'audio/flac';
  return 'audio/mpeg';
}

function tryDecodeWavToAudioBuffer(ctx: AudioContext, arrayBuffer: ArrayBuffer): AudioBuffer | null {
  if (!arrayBuffer || arrayBuffer.byteLength < 44) return null;
  const view = new DataView(arrayBuffer);
  const readTag = (offset: number): string =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
  if (readTag(0) !== 'RIFF' || readTag(8) !== 'WAVE') return null;

  let offset = 12;
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readTag(offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataStart = offset + 8;

    if (chunkId === 'fmt ' && chunkSize >= 16 && chunkDataStart + 16 <= view.byteLength) {
      audioFormat = view.getUint16(chunkDataStart, true);
      numChannels = view.getUint16(chunkDataStart + 2, true);
      sampleRate = view.getUint32(chunkDataStart + 4, true);
      bitsPerSample = view.getUint16(chunkDataStart + 14, true);
      if (audioFormat === 0xfffe && chunkSize >= 40 && chunkDataStart + 26 <= view.byteLength) {
        audioFormat = view.getUint16(chunkDataStart + 24, true);
      }
    } else if (chunkId === 'data') {
      dataOffset = chunkDataStart;
      dataSize = Math.min(chunkSize, view.byteLength - chunkDataStart);
      break;
    }

    offset = chunkDataStart + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || numChannels <= 0 || sampleRate <= 0) return null;
  if (audioFormat !== 1 && audioFormat !== 3) return null;

  const bytesPerSample = bitsPerSample / 8;
  if (![1, 2, 3, 4, 8].includes(bytesPerSample)) return null;
  const frameCount = Math.floor(dataSize / (numChannels * bytesPerSample));
  if (frameCount <= 0) return null;

  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }

  let pos = dataOffset;
  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < numChannels; c++) {
      let sample = 0;
      if (audioFormat === 3) {
        sample = bytesPerSample === 8 ? view.getFloat64(pos, true) : view.getFloat32(pos, true);
      } else if (bitsPerSample === 8) {
        sample = (view.getUint8(pos) - 128) / 128;
      } else if (bitsPerSample === 16) {
        sample = view.getInt16(pos, true) / 32768;
      } else if (bitsPerSample === 24) {
        const b0 = view.getUint8(pos);
        const b1 = view.getUint8(pos + 1);
        const b2 = view.getUint8(pos + 2);
        let val = (b2 << 16) | (b1 << 8) | b0;
        if (val & 0x800000) val |= ~0xffffff;
        sample = val / 8388608;
      } else if (bitsPerSample === 32) {
        sample = view.getInt32(pos, true) / 2147483648;
      }
      channels[c][i] = sample;
      pos += bytesPerSample;
    }
  }
  return buffer;
}

function loadViaMediaElement(arrayBuffer: ArrayBuffer, filePath: string): Promise<MediaElementAsset> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([arrayBuffer], { type: getAudioMimeType(filePath) });
    const blobUrl = URL.createObjectURL(blob);
    const probe = new Audio();
    probe.preload = 'metadata';

    const cleanup = (): void => {
      probe.onloadedmetadata = null;
      probe.onerror = null;
    };

    probe.onloadedmetadata = () => {
      cleanup();
      resolve({
        isMediaElement: true,
        url: blobUrl,
        duration: Number.isFinite(probe.duration) ? probe.duration : 0
      });
    };

    probe.onerror = () => {
      cleanup();
      URL.revokeObjectURL(blobUrl);
      reject(new Error('Unsupported audio format in media element'));
    };

    probe.src = blobUrl;
  });
}

async function decodeAudioAsset(arrayBuffer: ArrayBuffer, filePath: string): Promise<DecodedAsset> {
  if (!audioCtx) {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = new Ctx();
  }
  try {
    return await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    if (filePath.toLowerCase().endsWith('.wav')) {
      const wavBuffer = tryDecodeWavToAudioBuffer(audioCtx, arrayBuffer);
      if (wavBuffer) return wavBuffer;
    }
    return await loadViaMediaElement(arrayBuffer, filePath);
  }
}

async function updateOfflineDiskMetricDisplay(): Promise<void> {
  if (!('caches' in window)) return;
  try {
    const storageVault = await caches.open('lodge-music-v56');
    const storedRequests = await storageVault.keys();
    let totalEstimatedMB = 0.08;

    storedRequests.forEach((req) => {
      const filename = req.url.toLowerCase();
      let matched = false;
      for (const [key, weight] of Object.entries(DETERMINISTIC_TRACK_WEIGHTS)) {
        if (filename.includes(key)) {
          totalEstimatedMB += weight;
          matched = true;
          break;
        }
      }
      if (
        !matched &&
        (filename.endsWith('.mp3') ||
          filename.endsWith('.wav') ||
          filename.endsWith('.ogg') ||
          filename.endsWith('.m4a'))
      ) {
        totalEstimatedMB += 3.2;
      }
    });

    if (storedRequests.length > 5 && totalEstimatedMB < 10) {
      totalEstimatedMB = 114.65;
    }

    const displayEl = byId<HTMLSpanElement>('diskStorageDisplay');
    if (displayEl) {
      displayEl.innerText = totalEstimatedMB === 0.08 ? '0.00 MB' : `${totalEstimatedMB.toFixed(2)} MB`;
    }
  } catch {
    // Ignore storage query failures
  }
}

function calculateTotalMemoryUsageMetrics(): void {
  let grandTotalBytes = 0;
  for (const key in cachedBytesCounter) {
    grandTotalBytes += cachedBytesCounter[key];
  }
  const el = byId<HTMLSpanElement>('modalMemoryValue');
  if (el) {
    el.innerText = `${(grandTotalBytes / (1024 * 1024)).toFixed(2)} MB`;
  }
}

function updateCurrentTrackErrorUi(track: TrackButton): void {
  const playBtn = byId<HTMLButtonElement>('playBtn');
  const errNotice = byId<HTMLSpanElement>('trackErrorNotice');
  const uploadBtn = byId<HTMLButtonElement>('uploadMissingAudioBtn');
  const errorMsg = audioErrors[track.file];
  if (errorMsg) {
    if (playBtn) {
      playBtn.disabled = true;
      playBtn.innerText = '⚠️ FILE MISSING';
    }
    if (errNotice) {
      errNotice.innerText = errorMsg;
      errNotice.style.display = 'block';
    }
    if (uploadBtn) {
      uploadBtn.style.display = isAdmin ? 'inline-block' : 'none';
    }
  } else {
    if (errNotice) {
      errNotice.style.display = 'none';
      errNotice.innerText = '';
    }
    if (uploadBtn) {
      uploadBtn.style.display = 'none';
    }
  }
}

function activateLoadedButtonChip(index: number, track: TrackButton): void {
  const chip = byId<HTMLDivElement>(`chip-${index}`);
  if (chip) {
    const chosenColor = track.color ? track.color.toLowerCase() : 'blue';
    let cls = `nav-chip color-${chosenColor}`;
    if (index === currentTrackIndex) {
      cls += isPlaying ? ' playing-now' : ' active';
    }
    chip.className = cls;
    const words = track.title.split(' ');
    if (words.some((word) => word.length > 9)) chip.style.fontSize = '1.05rem';

    if (index === currentTrackIndex) {
      const cachedAsset = audioCache[track.file];
      trackDuration = cachedAsset ? cachedAsset.duration : 0;
      const trackTime = byId<HTMLSpanElement>('trackTime');
      if (trackTime && !isPlaying) {
        trackTime.innerText = `0:00 / ${formatTime(trackDuration)}`;
      }
      const playBtn = byId<HTMLButtonElement>('playBtn');
      if (playBtn && !isPlaying) {
        playBtn.disabled = false;
        playBtn.innerText = '▶ PLAY';
      }
      updateCurrentTrackErrorUi(track);
    }
  }
}

function markTrackLoadError(index: number, track: TrackButton, errorMsg: string): void {
  audioErrors[track.file] = errorMsg;
  const chip = byId<HTMLDivElement>(`chip-${index}`);
  if (chip) {
    const chosenColor = track.color ? track.color.toLowerCase() : 'blue';
    chip.className = `nav-chip color-${chosenColor} missing-audio${index === currentTrackIndex ? ' active' : ''}`;
  }
  if (index === currentTrackIndex) {
    updateCurrentTrackErrorUi(track);
  }
}

async function cacheAllAudioToRAM(): Promise<void> {
  if (!audioCtx) {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = new Ctx();
  }
  const allowMobileData = localStorage.getItem('allowMobileDataDownloads') === 'true';

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (!track) continue;

    if (audioCache[track.file]) {
      delete audioErrors[track.file];
      activateLoadedButtonChip(i, track);
      continue;
    }

    try {
      const fetchUrl = allowMobileData ? `${track.file}?forceMobile=true` : track.file;
      const res = await fetch(fetchUrl);

      if (res.status === 403) {
        const cueEl = byId<HTMLSpanElement>('cueText');
        if (cueEl) {
          cueEl.innerText = "⚠️ Cellular download blocked. Toggle 'Allow Mobile Data' on the Home Screen to bypass.";
        }
        continue;
      }

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (!res.ok || contentType.includes('text/html')) {
        const reason = !res.ok
          ? `Audio file missing on server (HTTP ${res.status}): ${track.file}`
          : `Invalid audio response (HTML returned instead of audio): ${track.file}`;
        markTrackLoadError(i, track, reason);
        continue;
      }

      const arrayBuffer = await res.arrayBuffer();
      cachedBytesCounter[track.file] = arrayBuffer.byteLength;
      calculateTotalMemoryUsageMetrics();

      const decodedAsset = await decodeAudioAsset(arrayBuffer, track.file);
      delete audioErrors[track.file];
      audioCache[track.file] = decodedAsset;
      activateLoadedButtonChip(i, track);
    } catch (err) {
      console.error('RAM compilation asset lookup failed for:', track.file, err);
      markTrackLoadError(i, track, `Unable to load or decode audio file: ${track.file}`);
    }
  }
}

function buildStaticTextPanel(lines: string[]): void {
  const panel = byId<HTMLDivElement>('lyricsPanel');
  if (!panel) return;
  panel.innerHTML = '';
  if (lines.length === 0) {
    panel.innerHTML = '<div class="lyric-line" style="color:var(--text-dim); margin-top:20px;">(Instrumental / No Words)</div>';
    return;
  }
  lines.forEach((line) => {
    const div = document.createElement('div');
    div.className = 'lyric-line';
    div.innerText = line;
    panel.appendChild(div);
  });
}

function stopAudioEngine(): void {
  isPlaying = false;
  if (timeUpdateInterval) {
    clearInterval(timeUpdateInterval);
    timeUpdateInterval = null;
  }
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      // ignore
    }
    currentSource = null;
  }
  if (currentMediaEl) {
    try {
      currentMediaEl.onended = null;
      currentMediaEl.pause();
      currentMediaEl.currentTime = 0;
    } catch {
      // ignore
    }
    currentMediaEl = null;
  }
  const activeChip = byId<HTMLDivElement>(`chip-${currentTrackIndex}`);
  if (activeChip) {
    activeChip.classList.remove('playing-now', 'fading-now');
  }
}

function applyActiveEngineVolume(vol: number): void {
  const clamped = Math.max(0, Math.min(1, vol));
  if (currentMediaEl && isPlaying) {
    currentMediaEl.volume = clamped;
  } else if (gainNode && isPlaying && audioCtx) {
    gainNode.gain.setValueAtTime(clamped, audioCtx.currentTime);
  }
}

function loadTrack(index: number): void {
  if (fadeInterval) {
    clearInterval(fadeInterval);
    fadeInterval = null;
  }
  stopAudioEngine();

  if (tracks.length === 0 || !tracks[index]) {
    const ticker = byId<HTMLSpanElement>('tickerTrackTitle');
    const cueEl = byId<HTMLSpanElement>('cueText');
    if (ticker) ticker.innerText = 'None';
    if (cueEl) cueEl.innerText = 'No buttons configured in this set yet.';
    buildStaticTextPanel([]);
    return;
  }

  document.querySelectorAll('.nav-chip').forEach((c) => {
    c.classList.remove('active', 'playing-now', 'fading-now');
  });

  const activeChip = byId<HTMLDivElement>(`chip-${index}`);
  if (activeChip) activeChip.classList.add('active');

  currentTrackIndex = index;
  const track = tracks[index];

  const cachedAsset = audioCache[track.file];
  trackDuration = cachedAsset ? cachedAsset.duration : 0;
  pausedTime = 0;

  const ticker = byId<HTMLSpanElement>('tickerTrackTitle');
  const titleEl = byId<HTMLSpanElement>('trackTitle');
  const filenameEl = byId<HTMLSpanElement>('trackFilenameReadout');
  const cueEl = byId<HTMLSpanElement>('cueText');
  const timeline = byId<HTMLInputElement>('timelineProgress');
  const trackTime = byId<HTMLSpanElement>('trackTime');
  const playBtn = byId<HTMLButtonElement>('playBtn');
  const fadeBtn = byId<HTMLButtonElement>('fadeBtn');

  if (ticker) ticker.innerText = track.title;
  if (titleEl) titleEl.innerText = track.title;
  if (filenameEl) filenameEl.innerText = track.file.split('/').pop() || track.file;
  if (cueEl) cueEl.innerText = track.cue || 'No special cues assigned.';
  buildStaticTextPanel(track.lyrics || []);

  if (timeline) timeline.value = '0';
  if (trackTime) trackTime.innerText = `0:00 / ${formatTime(trackDuration)}`;

  if (playBtn) {
    if (cachedAsset) {
      playBtn.disabled = false;
      playBtn.innerText = '▶ PLAY';
    } else if (audioErrors[track.file]) {
      playBtn.disabled = true;
      playBtn.innerText = '⚠️ FILE MISSING';
    } else {
      playBtn.disabled = true;
      playBtn.innerText = '⏳ LOADING AUDIO...';
    }
  }
  updateCurrentTrackErrorUi(track);
  if (fadeBtn) fadeBtn.disabled = true;
}

function handleTrackPlaybackCompletion(): void {
  stopAudioEngine();
  if (currentTrackIndex + 1 < tracks.length) {
    loadTrack(currentTrackIndex + 1);
  }
}

function updateTimelineProgress(): void {
  if (!isPlaying || !audioCtx) return;
  const currentElapsed = currentMediaEl ? currentMediaEl.currentTime : audioCtx.currentTime - startTime;

  if (trackDuration > 0 && currentElapsed >= trackDuration) {
    handleTrackPlaybackCompletion();
    return;
  }
  const pct = trackDuration > 0 ? (currentElapsed / trackDuration) * 100 : 0;
  const timeline = byId<HTMLInputElement>('timelineProgress');
  const trackTime = byId<HTMLSpanElement>('trackTime');
  if (timeline) timeline.value = String(pct);
  if (trackTime) trackTime.innerText = `${formatTime(currentElapsed)} / ${formatTime(trackDuration)}`;
}

async function playCurrentTrack(): Promise<void> {
  if (fadeInterval) {
    clearInterval(fadeInterval);
    fadeInterval = null;
  }
  if (isPlaying) return;

  if (!audioCtx) {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted') {
    try {
      await audioCtx.resume();
    } catch {
      // ignore
    }
  }

  const track = tracks[currentTrackIndex];
  if (!track) return;
  const cachedAsset = audioCache[track.file];
  if (!cachedAsset) {
    if (audioErrors[track.file]) {
      openOperationsModal();
    }
    return;
  }

  const playBtn = byId<HTMLButtonElement>('playBtn');
  const fadeBtn = byId<HTMLButtonElement>('fadeBtn');

  if (isMediaElementAsset(cachedAsset)) {
    currentMediaEl = new Audio(cachedAsset.url);
    currentMediaEl.volume = currentVolume;
    currentMediaEl.currentTime = pausedTime;
    currentMediaEl.onended = () => {
      if (isPlaying) handleTrackPlaybackCompletion();
    };
    try {
      await currentMediaEl.play();
    } catch (e) {
      console.error('Media element playback failed:', e);
      currentMediaEl = null;
      return;
    }
    if (Number.isFinite(currentMediaEl.duration) && currentMediaEl.duration > 0) {
      trackDuration = currentMediaEl.duration;
    }
  } else {
    currentSource = audioCtx.createBufferSource();
    currentSource.buffer = cachedAsset;

    gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(currentVolume, audioCtx.currentTime);

    currentSource.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    currentSource.start(0, pausedTime);
    startTime = audioCtx.currentTime - pausedTime;
  }

  isPlaying = true;
  if (playBtn) {
    playBtn.disabled = true;
    playBtn.innerText = '▶ PLAYING';
  }
  if (fadeBtn) fadeBtn.disabled = false;

  const activeChip = byId<HTMLDivElement>(`chip-${currentTrackIndex}`);
  if (activeChip) {
    activeChip.classList.remove('active', 'fading-now');
    activeChip.classList.add('playing-now');
  }

  if (timeUpdateInterval) clearInterval(timeUpdateInterval);
  timeUpdateInterval = setInterval(updateTimelineProgress, 100);
}

function fadeCurrentTrack(): void {
  if (!isPlaying || fadeInterval) return;
  const playBtn = byId<HTMLButtonElement>('playBtn');
  const fadeBtn = byId<HTMLButtonElement>('fadeBtn');
  if (fadeBtn) fadeBtn.disabled = true;
  const activeChip = byId<HTMLDivElement>(`chip-${currentTrackIndex}`);
  if (activeChip) {
    activeChip.classList.remove('playing-now');
    activeChip.classList.add('fading-now');
  }

  const fadeDuration = 1.5;
  const stepTime = 50;
  const steps = (fadeDuration * 1000) / stepTime;
  const volStep = currentVolume / steps;
  let runningVol = currentVolume;

  fadeInterval = setInterval(() => {
    if (runningVol > volStep) {
      runningVol -= volStep;
      applyActiveEngineVolume(runningVol);
    } else {
      if (fadeInterval) {
        clearInterval(fadeInterval);
        fadeInterval = null;
      }
      stopAudioEngine();
      if (playBtn) {
        playBtn.disabled = false;
        playBtn.innerText = '▶ PLAY';
      }
      if (currentTrackIndex + 1 < tracks.length) {
        loadTrack(currentTrackIndex + 1);
      }
    }
  }, stepTime);
}

function handleTrackSelection(index: number): void {
  const clickedChip = byId<HTMLDivElement>(`chip-${index}`);
  if (clickedChip && clickedChip.classList.contains('fading-now')) return;

  if (currentTrackIndex === index) {
    if (isPlaying && !fadeInterval) {
      fadeCurrentTrack();
    } else {
      void playCurrentTrack();
    }
  } else {
    if (isPlaying) {
      if (fadeInterval) {
        clearInterval(fadeInterval);
        fadeInterval = null;
      }
      stopAudioEngine();
    }
    loadTrack(index);
  }
}

function buildPlaylistGrid(forceDisabledState: boolean): void {
  const grid = byId<HTMLDivElement>('playlistGrid');
  if (!grid) return;
  grid.innerHTML = '';

  if (tracks.length === 0) {
    grid.innerHTML = `<div style="grid-column: 1 / -1; text-align:center; padding: 18px; color: var(--text-dim);">No buttons in this set yet.${isAdmin ? ' Tap ✏️ Edit Set above to add buttons.' : ''}</div>`;
    return;
  }

  tracks.forEach((track, index) => {
    const chip = document.createElement('div');
    const chosenColor = track.color ? track.color.toLowerCase() : 'blue';

    if (audioErrors[track.file]) {
      chip.className = `nav-chip color-${chosenColor} missing-audio`;
    } else if (forceDisabledState && !audioCache[track.file]) {
      chip.className = `nav-chip color-${chosenColor} not-loaded`;
    } else {
      chip.className = `nav-chip color-${chosenColor}`;
    }

    if (index === currentTrackIndex) {
      if (fadeInterval) {
        chip.classList.add('fading-now');
      } else if (isPlaying) {
        chip.classList.add('playing-now');
      } else {
        chip.classList.add('active');
      }
    }

    const words = track.title.split(' ');
    if (words.some((word) => word.length > 9)) chip.style.fontSize = '1.05rem';

    chip.id = `chip-${index}`;
    chip.innerText = track.title;
    chip.onclick = () => {
      handleTrackSelection(index);
    };
    grid.appendChild(chip);
  });
}

function openOperationsModal(): void {
  const modal = byId<HTMLDivElement>('operationsModal');
  if (modal) modal.style.display = 'flex';
}

function closeOperationsModal(): void {
  const modal = byId<HTMLDivElement>('operationsModal');
  if (modal) modal.style.display = 'none';
}

function handleManualTimelineSeek(percentValue: number): void {
  if (!tracks[currentTrackIndex]) return;
  const cachedAsset = audioCache[tracks[currentTrackIndex].file];
  if (!cachedAsset) return;

  const duration =
    currentMediaEl && Number.isFinite(currentMediaEl.duration)
      ? currentMediaEl.duration
      : cachedAsset.duration;
  const targetSeconds = (percentValue / 100) * duration;
  pausedTime = targetSeconds;

  const trackTime = byId<HTMLSpanElement>('trackTime');
  if (trackTime) trackTime.innerText = `${formatTime(targetSeconds)} / ${formatTime(duration)}`;

  if (isPlaying) {
    if (isMediaElementAsset(cachedAsset) && currentMediaEl) {
      currentMediaEl.currentTime = targetSeconds;
    } else if (audioCtx && !isMediaElementAsset(cachedAsset)) {
      if (currentSource) {
        try {
          currentSource.stop();
        } catch {
          // ignore
        }
        currentSource = null;
      }
      currentSource = audioCtx.createBufferSource();
      currentSource.buffer = cachedAsset;
      gainNode = audioCtx.createGain();
      gainNode.gain.setValueAtTime(currentVolume, audioCtx.currentTime);
      currentSource.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      currentSource.start(0, targetSeconds);
      startTime = audioCtx.currentTime - targetSeconds;
    }
  }
}

function transitionToTargetVolume(targetVol: number, btnIdSuffix: string, displayLabelText: string): void {
  document.querySelectorAll('.btn-vol').forEach((b) => b.classList.remove('active'));
  const targetBtn = byId<HTMLButtonElement>(`volBtn-${btnIdSuffix}`);
  if (targetBtn) targetBtn.classList.add('active');
  const volDisplay = byId<HTMLSpanElement>('volumePct');
  if (volDisplay) volDisplay.innerText = displayLabelText;

  if (volumeFadeInterval) {
    clearInterval(volumeFadeInterval);
    volumeFadeInterval = null;
  }
  if (!isPlaying || (!gainNode && !currentMediaEl) || fadeInterval) {
    currentVolume = targetVol;
    return;
  }

  const transitionDuration = 1200;
  const stepTime = 40;
  const steps = transitionDuration / stepTime;
  const volumeDelta = targetVol - currentVolume;
  const volStep = volumeDelta / steps;
  let runningVol = currentVolume;

  volumeFadeInterval = setInterval(() => {
    const stepsLeft = Math.abs(targetVol - runningVol);
    if (stepsLeft > Math.abs(volStep)) {
      runningVol += volStep;
      applyActiveEngineVolume(runningVol);
    } else {
      if (volumeFadeInterval) {
        clearInterval(volumeFadeInterval);
        volumeFadeInterval = null;
      }
      runningVol = targetVol;
      applyActiveEngineVolume(runningVol);
    }
    currentVolume = runningVol;
  }, stepTime);
}

async function handleMissingAudioFileUpload(inputEl: HTMLInputElement): Promise<void> {
  const file = inputEl.files?.[0];
  if (!file || !tracks[currentTrackIndex]) return;

  const targetIndex = currentTrackIndex;
  const track = tracks[targetIndex];
  const uploadBtn = byId<HTMLButtonElement>('uploadMissingAudioBtn');
  const errNotice = byId<HTMLSpanElement>('trackErrorNotice');

  if (uploadBtn) {
    uploadBtn.disabled = true;
    uploadBtn.innerText = '⏳ Loading & Saving...';
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const decodedAsset = await decodeAudioAsset(arrayBuffer.slice(0), track.file);

    cachedBytesCounter[track.file] = arrayBuffer.byteLength;
    calculateTotalMemoryUsageMetrics();
    delete audioErrors[track.file];
    audioCache[track.file] = decodedAsset;

    if ('caches' in window) {
      try {
        const storageVault = await caches.open('lodge-music-v56');
        const cleanUrl = new URL(track.file, window.location.href).href;
        await storageVault.put(
          new Request(cleanUrl),
          new Response(arrayBuffer.slice(0), {
            status: 200,
            headers: { 'Content-Type': getAudioMimeType(track.file) }
          })
        );
        void updateOfflineDiskMetricDisplay();
      } catch {
        // ignore cache error
      }
    }

    try {
      await fetch(`/api/upload-audio?path=${encodeURIComponent(track.file)}`, {
        method: 'POST',
        headers: { 'Content-Type': getAudioMimeType(track.file) },
        body: arrayBuffer
      });
    } catch {
      // ignore if offline
    }

    tracks.forEach((t, idx) => {
      if (t.file === track.file) {
        activateLoadedButtonChip(idx, t);
      }
    });
    activateLoadedButtonChip(targetIndex, track);
    showToast('Audio file loaded and saved.', 'success');
  } catch (err) {
    if (errNotice) {
      errNotice.innerText = `Could not decode selected file: ${err instanceof Error ? err.message : file.name}`;
      errNotice.style.display = 'block';
    }
  } finally {
    inputEl.value = '';
    if (uploadBtn) {
      uploadBtn.disabled = false;
      uploadBtn.innerText = '📁 Select / Upload Missing Audio File';
    }
  }
}

function buildSetSwitcherUI(): void {
  const switcherRow = byId<HTMLDivElement>('setSwitcherRow');
  const emptyBox = byId<HTMLDivElement>('emptySetsState');
  if (!switcherRow) return;

  switcherRow.innerHTML = '';

  if (dynamicSets.length === 0) {
    if (emptyBox) {
      emptyBox.style.display = 'flex';
      renderEmptyMigrationAction();
    }
    return;
  }

  if (emptyBox) {
    emptyBox.style.display = 'none';
  }

  dynamicSets.forEach((set) => {
    const btn = document.createElement('button');
    btn.className = 'btn-set-switch';
    btn.id = `setBtn-${set.id}`;
    btn.innerText = set.label;
    btn.onclick = () => {
      switchCeremonialSet(set, false);
    };
    switcherRow.appendChild(btn);
  });
}

function renderEmptyMigrationAction(): void {
  const migrateContainer = byId<HTMLDivElement>('emptyMigrationControls');
  if (!migrateContainer) return;
  if (isAdmin) {
    migrateContainer.innerHTML = `
      <p style="margin:0; color: var(--text-dim); font-size:0.95rem;">No sets are stored in the cloud database yet. Click below to move your existing configuration (<code>sets.json</code> and all tracks) into cloud storage.</p>
      <button type="button" class="btn-migrate-now" id="quickMigrateBtn">📦 Move Current Configuration to Cloud</button>
    `;
    const btn = byId<HTMLButtonElement>('quickMigrateBtn');
    if (btn) {
      btn.onclick = async () => {
        btn.disabled = true;
        btn.innerText = '⏳ Migrating configuration...';
        try {
          const result = await migrateLegacyConfiguration({ mode: 'merge', includeFiller: false, includeMark: false });
          showToast(`Imported ${result.setsImported} sets and ${result.tracksImported} buttons!`, 'success');
        } catch (err) {
          showToast(err instanceof Error ? err.message : 'Migration failed.', 'error');
          btn.disabled = false;
          btn.innerText = '📦 Move Current Configuration to Cloud';
        }
      };
    }
  } else {
    migrateContainer.innerHTML = `
      <p style="margin:0; color: var(--text-dim); font-size:0.95rem;">No ceremonial sets have been published yet. If you are the owner, sign in below to import or create your configuration.</p>
    `;
  }
}

function switchCeremonialSet(set: SetConfig, isInitialBoot: boolean): void {
  stopAudioEngine();
  if (fadeInterval) {
    clearInterval(fadeInterval);
    fadeInterval = null;
  }
  if (volumeFadeInterval) {
    clearInterval(volumeFadeInterval);
    volumeFadeInterval = null;
  }
  if (unsubscribeTracks) {
    unsubscribeTracks();
    unsubscribeTracks = null;
  }

  activeSet = set;
  currentTrackIndex = 0;

  const headerTitle = byId<HTMLDivElement>('headerTitleDisplay');
  if (headerTitle) headerTitle.innerText = set.label;

  updateConsoleAdminEditButton();

  if (!isInitialBoot) {
    const newUrl = `${window.location.pathname}?set=${encodeURIComponent(set.id)}`;
    window.history.pushState({ path: newUrl }, '', newUrl);
  }

  byId<HTMLDivElement>('screenHome')?.classList.remove('active-view');
  byId<HTMLDivElement>('screenConsole')?.classList.add('active-view');

  const cueEl = byId<HTMLSpanElement>('cueText');
  if (cueEl) cueEl.innerText = 'Syncing cloud configuration... Please standby.';

  let firstLoad = true;
  unsubscribeTracks = subscribeToTracks(
    set.id,
    (loadedTracks) => {
      const prevSelectedId = tracks[currentTrackIndex]?.id;
      tracks = loadedTracks;

      if (!firstLoad && prevSelectedId) {
        const preservedIdx = tracks.findIndex((t) => t.id === prevSelectedId);
        currentTrackIndex = preservedIdx >= 0 ? preservedIdx : 0;
      } else {
        currentTrackIndex = 0;
      }

      buildPlaylistGrid(firstLoad);

      if (tracks.length > 0) {
        if (!isPlaying) {
          loadTrack(currentTrackIndex);
        } else {
          const active = tracks[currentTrackIndex];
          if (active) {
            const ticker = byId<HTMLSpanElement>('tickerTrackTitle');
            const titleEl = byId<HTMLSpanElement>('trackTitle');
            const cueElNow = byId<HTMLSpanElement>('cueText');
            if (ticker) ticker.innerText = active.title;
            if (titleEl) titleEl.innerText = active.title;
            if (cueElNow) cueElNow.innerText = active.cue || 'No special cues assigned.';
            buildStaticTextPanel(active.lyrics || []);
          }
        }
        void cacheAllAudioToRAM();
      } else {
        loadTrack(0);
      }
      firstLoad = false;
    },
    (err) => {
      console.error('Failed to sync tracks:', err);
      if (cueEl) cueEl.innerText = 'Unable to load set configuration from cloud.';
    }
  );
}

function navigateToHomeScreen(): void {
  if (fadeInterval) {
    clearInterval(fadeInterval);
    fadeInterval = null;
  }
  if (volumeFadeInterval) {
    clearInterval(volumeFadeInterval);
    volumeFadeInterval = null;
  }
  if (unsubscribeTracks) {
    unsubscribeTracks();
    unsubscribeTracks = null;
  }
  stopAudioEngine();

  activeSet = null;
  tracks = [];
  currentTrackIndex = 0;

  const ticker = byId<HTMLSpanElement>('tickerTrackTitle');
  const titleEl = byId<HTMLSpanElement>('trackTitle');
  const filenameEl = byId<HTMLSpanElement>('trackFilenameReadout');
  const errNotice = byId<HTMLSpanElement>('trackErrorNotice');
  const timeline = byId<HTMLInputElement>('timelineProgress');
  const trackTime = byId<HTMLSpanElement>('trackTime');
  const cueEl = byId<HTMLSpanElement>('cueText');

  if (ticker) ticker.innerText = 'None';
  if (titleEl) titleEl.innerText = '---';
  if (filenameEl) filenameEl.innerText = 'no_file.mp3';
  if (errNotice) {
    errNotice.style.display = 'none';
    errNotice.innerText = '';
  }
  if (timeline) timeline.value = '0';
  if (trackTime) trackTime.innerText = '0:00 / 0:00';
  if (cueEl) cueEl.innerText = 'Select a track row sequence to begin.';
  buildStaticTextPanel([]);

  window.history.pushState({}, '', window.location.pathname);
  byId<HTMLDivElement>('screenConsole')?.classList.remove('active-view');
  byId<HTMLDivElement>('screenHome')?.classList.add('active-view');
  void updateOfflineDiskMetricDisplay();
  window.dispatchEvent(new Event('resize'));
}

async function shareLodgeMusicApp(): Promise<void> {
  const baseUrl = window.location.origin + window.location.pathname;
  const shareUrl = activeSet ? `${baseUrl}?set=${encodeURIComponent(activeSet.id)}` : baseUrl;
  const shareTitle = activeSet ? `Lodge Music — ${activeSet.label}` : 'Lodge Music';
  const shareText = 'Here is the Lodge Music app for running ceremonial audio straight from your phone or tablet.';

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(shareUrl);
      showToast('Public app link copied to clipboard!', 'success');
    }
  } catch {
    // ignore clipboard fallback
  }

  if (navigator.share) {
    try {
      await navigator.share({ title: shareTitle, text: shareText, url: shareUrl });
    } catch {
      // user cancelled or iframe blocked navigator.share; clipboard already copied
    }
  }
}

function executePwaServiceCacheClear(): void {
  if ('caches' in window) {
    void caches.keys().then((names) => {
      for (const name of names) void caches.delete(name);
    });
  }
  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) {
        void registration.unregister();
      }
    });
  }
  for (const key in audioCache) {
    const asset = audioCache[key];
    if (asset && isMediaElementAsset(asset) && asset.url) {
      URL.revokeObjectURL(asset.url);
    }
    delete audioCache[key];
  }
  for (const key in audioErrors) delete audioErrors[key];
  for (const key in cachedBytesCounter) delete cachedBytesCounter[key];

  window.history.pushState({}, '', window.location.pathname);
  window.setTimeout(() => {
    window.location.reload();
  }, 150);
}

function updateConsoleAdminEditButton(): void {
  const btn = byId<HTMLButtonElement>('btnConsoleEditSet');
  if (!btn) return;
  if (isAdmin && activeSet) {
    btn.style.display = 'inline-flex';
    btn.onclick = () => {
      window.location.href = `/edit.html?set=${encodeURIComponent(activeSet!.id)}`;
    };
  } else {
    btn.style.display = 'none';
  }
}

function renderAuthControls(): void {
  const adminBar = byId<HTMLDivElement>('ownerAdminBar');
  const signInLink = byId<HTMLButtonElement>('ownerSignInBtn');
  if (!adminBar || !signInLink) return;

  if (!currentUser) {
    adminBar.style.display = 'none';
    signInLink.style.display = 'inline-block';
  } else if (isAdmin) {
    signInLink.style.display = 'none';
    adminBar.style.display = 'flex';
    adminBar.innerHTML = `
      <div class="owner-bar-info">
        <span class="owner-badge">OWNER</span>
        <span class="owner-email">${currentUser.email || ''}</span>
      </div>
      <div class="owner-bar-actions">
        <a href="/edit.html" class="btn-owner-edit">✏️ Edit Buttons &amp; Order</a>
        <button type="button" class="btn-owner-signout" id="btnOwnerSignOut">Sign Out</button>
      </div>
    `;
    byId<HTMLButtonElement>('btnOwnerSignOut')?.addEventListener('click', () => {
      void signOutUser();
    });
  } else {
    signInLink.style.display = 'none';
    adminBar.style.display = 'flex';
    adminBar.innerHTML = `
      <div class="owner-bar-info">
        <span class="viewer-badge">PUBLIC VIEW</span>
        <span class="owner-email">${currentUser.email || ''} (Read-Only)</span>
      </div>
      <div class="owner-bar-actions">
        <button type="button" class="btn-owner-signout" id="btnOwnerSignOut">Sign Out</button>
      </div>
    `;
    byId<HTMLButtonElement>('btnOwnerSignOut')?.addEventListener('click', () => {
      void signOutUser();
    });
  }

  updateConsoleAdminEditButton();
  if (dynamicSets.length === 0) {
    renderEmptyMigrationAction();
  } else if (activeSet) {
    buildPlaylistGrid(false);
  }
}

function initConsole(): void {
  const checkbox = byId<HTMLInputElement>('mobileDataToggleCheckbox');
  if (checkbox) {
    checkbox.checked = localStorage.getItem('allowMobileDataDownloads') === 'true';
    checkbox.onchange = () => {
      localStorage.setItem('allowMobileDataDownloads', checkbox.checked ? 'true' : 'false');
      if (checkbox.checked && tracks.length > 0) {
        void cacheAllAudioToRAM();
      }
    };
  }

  byId<HTMLButtonElement>('shareAppBtn')?.addEventListener('click', () => {
    void shareLodgeMusicApp();
  });
  byId<HTMLButtonElement>('resetStorageBtn')?.addEventListener('click', executePwaServiceCacheClear);
  byId<HTMLButtonElement>('btnBackHome')?.addEventListener('click', navigateToHomeScreen);
  byId<HTMLButtonElement>('btnOpenOptions')?.addEventListener('click', openOperationsModal);
  byId<HTMLButtonElement>('btnCloseOptions')?.addEventListener('click', closeOperationsModal);
  byId<HTMLButtonElement>('playBtn')?.addEventListener('click', () => {
    void playCurrentTrack();
  });
  byId<HTMLButtonElement>('fadeBtn')?.addEventListener('click', fadeCurrentTrack);
  byId<HTMLInputElement>('timelineProgress')?.addEventListener('input', (e) => {
    handleManualTimelineSeek(Number((e.target as HTMLInputElement).value));
  });
  byId<HTMLButtonElement>('volBtn-05')?.addEventListener('click', () =>
    transitionToTargetVolume(0.05, '05', 'Very Quiet (5%)')
  );
  byId<HTMLButtonElement>('volBtn-60')?.addEventListener('click', () =>
    transitionToTargetVolume(0.6, '60', 'Quiet (60%)')
  );
  byId<HTMLButtonElement>('volBtn-100')?.addEventListener('click', () =>
    transitionToTargetVolume(1.0, '100', 'Normal (100%)')
  );
  byId<HTMLButtonElement>('uploadMissingAudioBtn')?.addEventListener('click', () => {
    byId<HTMLInputElement>('missingAudioFileInput')?.click();
  });
  byId<HTMLInputElement>('missingAudioFileInput')?.addEventListener('change', (e) => {
    void handleMissingAudioFileUpload(e.target as HTMLInputElement);
  });

  byId<HTMLButtonElement>('ownerSignInBtn')?.addEventListener('click', async () => {
    try {
      await signInWithGoogle();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Sign-in cancelled.', 'error');
    }
  });

  subscribeAuth(async (user) => {
    currentUser = user;
    isAdmin = await checkIsAdminUser(user);
    renderAuthControls();
  });

  unsubscribeSets = subscribeToSets(
    (sets) => {
      dynamicSets = sets;
      buildSetSwitcherUI();
      void updateOfflineDiskMetricDisplay();

      if (activeSet) {
        const updatedActive = dynamicSets.find((s) => s.id === activeSet?.id);
        if (updatedActive) {
          activeSet = updatedActive;
          const headerTitle = byId<HTMLDivElement>('headerTitleDisplay');
          if (headerTitle) headerTitle.innerText = updatedActive.label;
        } else {
          navigateToHomeScreen();
        }
      }

      if (!initialUrlHandled && dynamicSets.length > 0) {
        initialUrlHandled = true;
        const urlParams = new URLSearchParams(window.location.search);
        const targetSetParam = urlParams.get('set');
        if (targetSetParam) {
          const matchedSet = dynamicSets.find(
            (s) =>
              s.id === targetSetParam ||
              (s.legacyId !== undefined && String(s.legacyId) === targetSetParam)
          );
          if (matchedSet) {
            switchCeremonialSet(matchedSet, true);
            return;
          }
        }
        byId<HTMLDivElement>('screenHome')?.classList.add('active-view');
      }
    },
    (err) => {
      console.error('Failed to load ceremonial sets from cloud:', err);
      showToast('Failed to load configuration from cloud.', 'error');
    }
  );

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && audioCtx && (audioCtx.state as string) === 'interrupted') {
      void audioCtx.resume();
    }
  });

  window.addEventListener('beforeunload', () => {
    if (unsubscribeSets) unsubscribeSets();
    if (unsubscribeTracks) unsubscribeTracks();
  });
}

window.addEventListener('DOMContentLoaded', initConsole);
