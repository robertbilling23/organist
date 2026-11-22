import type { User } from 'firebase/auth';
import {
  checkIsAdminUser,
  consumeAuthRedirectResult,
  FIREBASE_PROJECT_ID,
  signInWithGoogle,
  signOutUser,
  subscribeAuth
} from './firebase';
import {
  createTrack,
  deleteTrack,
  migrateLegacyConfiguration,
  normalizeColor,
  normalizeLyrics,
  reorderTracks,
  subscribeToSets,
  subscribeToTracks,
  updateTrack
} from './store';
import { initThemeSwitcher } from './theme';
import {
  BLUEPRINT_LIMITS,
  TRACK_COLOR_META,
  TRACK_COLORS,
  type LegacySetEntry,
  type LegacyTrackEntry,
  type SetConfig,
  type TrackButton,
  type TrackColor
} from './types';

declare global {
  interface Navigator {
    connection?: {
      type?: string;
      saveData?: boolean;
    };
  }
  interface Window {
    __lodgeMusicBooted?: boolean;
  }
}

window.__lodgeMusicBooted = true;

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

let isEditMode = false;
let dirtyInlineEdits = false;
let pendingInlineAction: (() => void) | null = null;
let pendingInlineDeleteConfirm = false;
let inlineDragSrcIndex: number | null = null;
let isReorderingInline = false;
let availableConsoleAudioFiles: string[] = [];
let inlinePreviewAudio: HTMLAudioElement | null = null;
let inlinePreviewingFile: string | null = null;

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
  }, 4200);
}

function showSignInErrorNotice(err: unknown): void {
  const code = (err as { code?: string })?.code || '';
  const msg = err instanceof Error ? err.message : String(err || 'Sign-in cancelled.');

  if (code === 'auth/popup-closed-by-user' || msg.includes('auth/popup-closed-by-user')) {
    showToast('Sign-in was cancelled.', 'info');
    return;
  }

  if (code === 'auth/unauthorized-domain' || msg.includes('auth/unauthorized-domain')) {
    const host = window.location.hostname || window.location.host;
    const existing = byId<HTMLDivElement>('authHelpOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'authHelpOverlay';
    overlay.style.cssText =
      'position:fixed;inset:0;background:var(--modal-overlay-bg);display:flex;align-items:center;justify-content:center;padding:16px;z-index:3000;';
    overlay.innerHTML = `
      <div style="background:var(--modal-bg);border:2px solid var(--cue-gold);border-radius:12px;max-width:480px;width:100%;padding:20px;color:var(--text-bright);display:flex;flex-direction:column;gap:12px;box-shadow:0 12px 32px rgba(0,0,0,0.45);">
        <div style="font-size:1.15rem;font-weight:900;color:var(--cue-gold);">Authorize This Domain for Sign-In</div>
        <div style="font-size:0.95rem;line-height:1.45;color:var(--text-dim);">
          Google Sign-In is blocked from <strong style="color:var(--active-blue);">${host}</strong> because this hostname is not yet listed in Firebase Authentication Authorized Domains.
        </div>
        <ol style="margin:0;padding-left:20px;font-size:0.9rem;line-height:1.5;color:var(--text-dim);">
          <li>Open <a href="https://console.firebase.google.com/project/${FIREBASE_PROJECT_ID}/authentication/settings" target="_blank" rel="noopener noreferrer" style="color:var(--active-blue);font-weight:700;">Firebase Authentication Settings</a>.</li>
          <li>Under <strong>Authorized domains</strong>, click <strong>Add domain</strong>.</li>
          <li>Enter <code style="background:var(--surface-subtle);padding:2px 6px;border-radius:4px;color:var(--play-green);">${host}</code> and save.</li>
        </ol>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;">
          <button type="button" id="copyUnauthorizedHostBtn" style="flex:1;min-width:140px;background:var(--active-blue);color:var(--btn-primary-text);border:none;border-radius:8px;padding:10px 12px;font-weight:900;cursor:pointer;">📋 Copy "${host}"</button>
          <button type="button" id="closeAuthHelpBtn" style="background:var(--surface-elevated);color:var(--text-bright);border:1px solid var(--panel-border);border-radius:8px;padding:10px 16px;font-weight:800;cursor:pointer;">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    byId<HTMLButtonElement>('copyUnauthorizedHostBtn')?.addEventListener('click', () => {
      void navigator.clipboard?.writeText(host).then(() => {
        showToast(`Copied "${host}" to clipboard!`, 'success');
      });
    });
    byId<HTMLButtonElement>('closeAuthHelpBtn')?.addEventListener('click', () => {
      overlay.remove();
    });
    return;
  }

  showToast(msg, 'error');
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
    const storageVault = await caches.open('lodge-music-v59');
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
  if (isEditMode) {
    if (index === currentTrackIndex) return;
    requestGuardedEditAction(() => {
      selectTrackInEditMode(index);
    });
    return;
  }

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
    grid.innerHTML = `<div style="grid-column: 1 / -1; text-align:center; padding: 18px; color: var(--text-dim);">No buttons in this set yet.${canEditActiveSet() ? ' Tap ✏️ Edit below or 🎛️ Studio above to add buttons.' : ''}</div>`;
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

    if (isEditMode) {
      chip.classList.add('edit-mode-chip');
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

    if (isEditMode) {
      chip.draggable = true;
      chip.addEventListener('dragstart', (e) => {
        inlineDragSrcIndex = index;
        chip.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(index));
        }
      });
      chip.addEventListener('dragend', () => {
        chip.classList.remove('dragging');
        inlineDragSrcIndex = null;
        document.querySelectorAll('.nav-chip.drag-over').forEach((el) => el.classList.remove('drag-over'));
      });
      chip.addEventListener('dragover', (e) => {
        if (inlineDragSrcIndex === null || inlineDragSrcIndex === index) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        chip.classList.add('drag-over');
      });
      chip.addEventListener('dragleave', () => {
        chip.classList.remove('drag-over');
      });
      chip.addEventListener('drop', (e) => {
        e.preventDefault();
        chip.classList.remove('drag-over');
        const fromIdx = inlineDragSrcIndex;
        inlineDragSrcIndex = null;
        if (fromIdx === null || fromIdx === index) return;
        void reorderInlineTracks(fromIdx, index);
      });
    }

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
        const storageVault = await caches.open('lodge-music-v59');
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
      await fetch(`./api/upload-audio?path=${encodeURIComponent(track.file)}`, {
        method: 'POST',
        headers: { 'Content-Type': getAudioMimeType(track.file) },
        body: arrayBuffer
      });
    } catch {
      // ignore if offline or static hosting
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
  if (set.id.startsWith('local_') && set.sourceFile) {
    void loadLocalFallbackTracks(set).then((loadedTracks) => {
      tracks = loadedTracks;
      currentTrackIndex = 0;
      buildPlaylistGrid(true);
      if (tracks.length > 0) {
        loadTrack(0);
        void cacheAllAudioToRAM();
      } else {
        loadTrack(0);
      }
    });
    return;
  }

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
        if (isEditMode) {
          if (dirtyInlineEdits) {
            applyInlineChipPreview();
            const heading = byId<HTMLSpanElement>('inlineEditorHeading');
            const activeTitle = (byId<HTMLInputElement>('inlineEditTitle')?.value || '').trim() || tracks[currentTrackIndex]?.title || 'Button';
            if (heading) heading.textContent = `Edit #${currentTrackIndex + 1}: ${activeTitle}`;
            updateInlineReorderButtons();
          } else {
            syncInlineEditorToCurrentTrack();
          }
          if (!isPlaying) {
            syncPlayModeDisplay(tracks[currentTrackIndex]);
          }
        } else if (!isPlaying) {
          loadTrack(currentTrackIndex);
        } else {
          syncPlayModeDisplay(tracks[currentTrackIndex]);
        }
        void cacheAllAudioToRAM();
      } else {
        if (isEditMode) {
          syncInlineEditorToCurrentTrack();
        }
        if (!isPlaying) {
          loadTrack(0);
        }
      }
      firstLoad = false;
    },
    (err) => {
      console.error('Failed to sync tracks:', err);
      if (set.sourceFile) {
        void loadLocalFallbackTracks(set).then((fallbackTracks) => {
          tracks = fallbackTracks;
          currentTrackIndex = 0;
          buildPlaylistGrid(true);
          loadTrack(0);
          if (tracks.length > 0) void cacheAllAudioToRAM();
        });
      } else if (cueEl) {
        cueEl.innerText = 'Unable to load set configuration from cloud.';
      }
    }
  );
}

async function loadLocalFallbackSets(): Promise<SetConfig[]> {
  const res = await fetch('./sets.json?v=' + Date.now());
  if (!res.ok) throw new Error('Unable to load local sets.json');
  const legacySets = (await res.json()) as LegacySetEntry[];
  return legacySets.map((s, idx) => ({
    id: `local_${String(s.id)}`,
    legacyId: typeof s.id === 'number' ? s.id : Number.parseInt(String(s.id), 10) || idx + 1,
    label: s.label || `Set ${idx + 1}`,
    sourceFile: s.file,
    order: idx
  }));
}

async function loadLocalFallbackTracks(set: SetConfig): Promise<TrackButton[]> {
  if (!set.sourceFile) return [];
  const res = await fetch('./' + set.sourceFile + '?v=' + Date.now());
  if (!res.ok) return [];
  const raw = (await res.json()) as LegacyTrackEntry[];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => t && (t.title || t.file))
    .map((t, idx) => ({
      id: `local_trk_${idx}`,
      setId: set.id,
      title: t.title || 'Untitled Track',
      color: normalizeColor(t.color),
      file: t.file || 'audio/filename.mp3',
      cue: t.cue || '',
      lyrics: normalizeLyrics(t.lyrics),
      order: idx
    }));
}

function navigateToHomeScreen(): void {
  exitEditMode(true);
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
  updateConsoleAdminEditButton();
  void updateOfflineDiskMetricDisplay();
  window.dispatchEvent(new Event('resize'));
}

function getPublicShareBaseUrl(): string {
  const host = window.location.hostname.startsWith('ais-dev-')
    ? window.location.hostname.replace(/^ais-dev-/, 'ais-pre-')
    : window.location.hostname;
  const port = window.location.port ? `:${window.location.port}` : '';
  return `${window.location.protocol}//${host}${port}${window.location.pathname}`;
}

async function shareLodgeMusicApp(): Promise<void> {
  const baseUrl = getPublicShareBaseUrl();
  const shareUrl = activeSet ? `${baseUrl}?set=${encodeURIComponent(activeSet.id)}` : baseUrl;
  const shareTitle = activeSet ? `Digital Organist — ${activeSet.label}` : 'Digital Organist';
  const shareText = 'Here is the Digital Organist app for running ceremonial audio straight from your phone or tablet.';

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

function canEditActiveSet(): boolean {
  return isAdmin && Boolean(activeSet) && !activeSet!.id.startsWith('local_');
}

function syncPlayModeDisplay(active: TrackButton | undefined): void {
  if (!active) return;
  const ticker = byId<HTMLSpanElement>('tickerTrackTitle');
  const titleEl = byId<HTMLSpanElement>('trackTitle');
  const filenameEl = byId<HTMLSpanElement>('trackFilenameReadout');
  const cueElNow = byId<HTMLSpanElement>('cueText');
  if (ticker) ticker.innerText = active.title;
  if (titleEl) titleEl.innerText = active.title;
  if (filenameEl) filenameEl.innerText = active.file.split('/').pop() || active.file;
  if (cueElNow) cueElNow.innerText = active.cue || 'No special cues assigned.';
  buildStaticTextPanel(active.lyrics || []);
}

function stopInlineAudioPreview(): void {
  if (inlinePreviewAudio) {
    inlinePreviewAudio.pause();
    inlinePreviewAudio.currentTime = 0;
    inlinePreviewAudio = null;
  }
  inlinePreviewingFile = null;
  const previewBtn = byId<HTMLButtonElement>('btnInlinePreviewAudio');
  if (previewBtn) {
    previewBtn.innerText = '▶ Test';
  }
}

function toggleInlineAudioPreview(): void {
  const filePath = (byId<HTMLInputElement>('inlineEditFile')?.value || '').trim();
  const previewBtn = byId<HTMLButtonElement>('btnInlinePreviewAudio');
  if (!filePath) {
    showToast('Enter an audio file path first.', 'error');
    return;
  }

  if (inlinePreviewAudio && inlinePreviewingFile === filePath) {
    stopInlineAudioPreview();
    return;
  }

  stopInlineAudioPreview();
  inlinePreviewingFile = filePath;
  inlinePreviewAudio = new Audio(filePath);
  if (previewBtn) previewBtn.innerText = '■ Stop';
  inlinePreviewAudio.onended = () => {
    stopInlineAudioPreview();
  };
  inlinePreviewAudio.onerror = () => {
    stopInlineAudioPreview();
    showToast(`Could not play ${filePath}. Verify the file exists.`, 'error');
  };
  void inlinePreviewAudio.play().catch((err) => {
    stopInlineAudioPreview();
    showToast(err instanceof Error ? err.message : 'Audio preview failed.', 'error');
  });
}

async function fetchConsoleAudioFilesCatalog(): Promise<void> {
  const discovered = new Set<string>();
  try {
    const res = await fetch('./api/audio-files');
    if (res.ok) {
      const data = (await res.json()) as { files?: string[] };
      if (Array.isArray(data.files)) {
        data.files.forEach((f) => discovered.add(f));
      }
    }
  } catch {
    // static hosting fallback below
  }

  if (discovered.size === 0) {
    const jsonFiles = ['craft.json', 'ea.json', 'fc.json', 'mm.json', 'installation.json', 'filler.json', 'mark.json'];
    await Promise.all(
      jsonFiles.map(async (jf) => {
        try {
          const r = await fetch('./' + jf);
          if (!r.ok) return;
          const arr = (await r.json()) as Array<{ file?: string }>;
          if (Array.isArray(arr)) {
            arr.forEach((item) => {
              if (item && typeof item.file === 'string' && item.file.trim()) {
                discovered.add(item.file.trim());
              }
            });
          }
        } catch {
          // ignore
        }
      })
    );
  }

  tracks.forEach((t) => {
    if (t.file) discovered.add(t.file);
  });

  availableConsoleAudioFiles = Array.from(discovered).sort((a, b) => a.localeCompare(b));
  const datalist = byId<HTMLDataListElement>('consoleAudioFilesDatalist');
  if (datalist) {
    datalist.innerHTML = '';
    availableConsoleAudioFiles.forEach((f) => {
      const opt = document.createElement('option');
      opt.value = f;
      datalist.appendChild(opt);
    });
  }

  const picker = byId<HTMLSelectElement>('inlineAudioPicker');
  if (picker) {
    const currentFile = byId<HTMLInputElement>('inlineEditFile')?.value || '';
    picker.innerHTML = '<option value="">-- Pick an existing file in /audio --</option>';
    availableConsoleAudioFiles.forEach((f) => {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f.replace(/^audio\//, '');
      picker.appendChild(opt);
    });
    picker.value = availableConsoleAudioFiles.includes(currentFile) ? currentFile : '';
  }
}

function renderInlineColorSwatches(): void {
  const container = byId<HTMLDivElement>('inlineColorSwatches');
  if (!container) return;
  container.innerHTML = '';

  TRACK_COLORS.forEach((color) => {
    const meta = TRACK_COLOR_META[color];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `inline-color-btn color-${color}`;
    btn.dataset.color = color;
    btn.textContent = meta.label;
    btn.onclick = () => {
      setInlineActiveColor(color);
      applyInlineChipPreview();
      setInlineSaveStatus('dirty');
    };
    container.appendChild(btn);
  });
}

function getInlineSelectedColor(): TrackColor {
  const active = document.querySelector<HTMLButtonElement>('#inlineColorSwatches .inline-color-btn.active');
  return normalizeColor(active?.dataset.color || 'blue');
}

function setInlineActiveColor(color: TrackColor): void {
  document.querySelectorAll<HTMLButtonElement>('#inlineColorSwatches .inline-color-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.color === color);
  });
}

function setInlineSaveStatus(state: 'clean' | 'dirty' | 'saving' | 'saved'): void {
  const statusEl = byId<HTMLSpanElement>('inlineSaveStatus');
  const saveBtn = byId<HTMLButtonElement>('btnInlineSaveTrack');
  if (!statusEl || !saveBtn) return;

  if (state === 'dirty') {
    dirtyInlineEdits = true;
    statusEl.textContent = 'Unsaved';
    statusEl.className = 'inline-save-status dirty';
    saveBtn.disabled = tracks.length === 0;
  } else if (state === 'saving') {
    statusEl.textContent = 'Saving...';
    statusEl.className = 'inline-save-status';
    saveBtn.disabled = true;
  } else if (state === 'saved') {
    dirtyInlineEdits = false;
    statusEl.textContent = '✓ Saved';
    statusEl.className = 'inline-save-status saved';
    saveBtn.disabled = true;
  } else {
    dirtyInlineEdits = false;
    statusEl.textContent = 'Synced';
    statusEl.className = 'inline-save-status';
    saveBtn.disabled = true;
  }
}

function renderInlineDeleteConfirmUI(): void {
  const delBtn = byId<HTMLButtonElement>('btnInlineDeleteTrack');
  const confirmBox = byId<HTMLDivElement>('inlineDeleteConfirmBox');
  if (!delBtn || !confirmBox) return;
  if (pendingInlineDeleteConfirm) {
    delBtn.style.display = 'none';
    confirmBox.style.display = 'flex';
  } else {
    delBtn.style.display = tracks.length > 0 ? 'inline-flex' : 'none';
    confirmBox.style.display = 'none';
  }
}

function hideUnsavedPrompt(): void {
  pendingInlineAction = null;
  const banner = byId<HTMLDivElement>('inlineUnsavedBanner');
  if (banner) banner.style.display = 'none';
}

function requestGuardedEditAction(action: () => void): void {
  if (!dirtyInlineEdits) {
    action();
    return;
  }
  pendingInlineAction = action;
  const currentTrack = tracks[currentTrackIndex];
  const msgEl = byId<HTMLSpanElement>('inlineUnsavedText');
  if (msgEl) {
    msgEl.textContent = currentTrack
      ? `Save changes to "${currentTrack.title}" before leaving?`
      : 'You have unsaved changes to this button.';
  }
  const banner = byId<HTMLDivElement>('inlineUnsavedBanner');
  if (banner) banner.style.display = 'flex';
}

function applyInlineChipPreview(): void {
  const chip = byId<HTMLDivElement>(`chip-${currentTrackIndex}`);
  if (!chip) return;
  const titleVal = (byId<HTMLInputElement>('inlineEditTitle')?.value || '').trim() || '(Untitled)';
  const chosenColor = getInlineSelectedColor();
  const track = tracks[currentTrackIndex];

  let cls = `nav-chip color-${chosenColor}`;
  if (track && audioErrors[track.file]) cls += ' missing-audio';
  if (isEditMode) cls += ' edit-mode-chip';
  if (fadeInterval) cls += ' fading-now';
  else if (isPlaying) cls += ' playing-now';
  else cls += ' active';

  chip.className = cls;
  chip.innerText = titleVal;
  const words = titleVal.split(' ');
  chip.style.fontSize = words.some((word) => word.length > 9) ? '1.05rem' : '';
}

function restoreChipFromSavedTrack(index: number): void {
  const track = tracks[index];
  const chip = byId<HTMLDivElement>(`chip-${index}`);
  if (!track || !chip) return;

  const chosenColor = track.color ? track.color.toLowerCase() : 'blue';
  let cls = `nav-chip color-${chosenColor}`;
  if (audioErrors[track.file]) cls += ' missing-audio';
  if (isEditMode) cls += ' edit-mode-chip';
  if (index === currentTrackIndex) {
    if (fadeInterval) cls += ' fading-now';
    else if (isPlaying) cls += ' playing-now';
    else cls += ' active';
  }
  chip.className = cls;
  chip.innerText = track.title;
  const words = track.title.split(' ');
  chip.style.fontSize = words.some((word) => word.length > 9) ? '1.05rem' : '';
}

function updateInlineReorderButtons(): void {
  const earlierBtn = byId<HTMLButtonElement>('btnInlineMoveEarlier');
  const laterBtn = byId<HTMLButtonElement>('btnInlineMoveLater');
  if (earlierBtn) {
    earlierBtn.disabled = isReorderingInline || tracks.length <= 1 || currentTrackIndex <= 0;
  }
  if (laterBtn) {
    laterBtn.disabled = isReorderingInline || tracks.length <= 1 || currentTrackIndex >= tracks.length - 1;
  }
}

async function reorderInlineTracks(fromIdx: number, toIdx: number): Promise<void> {
  if (!activeSet || isReorderingInline) return;
  if (fromIdx < 0 || fromIdx >= tracks.length || toIdx < 0 || toIdx >= tracks.length || fromIdx === toIdx) {
    return;
  }

  const prevTracks = [...tracks];
  const prevIndex = currentTrackIndex;
  const selectedId = tracks[currentTrackIndex]?.id;

  const reordered = [...tracks];
  const [moved] = reordered.splice(fromIdx, 1);
  reordered.splice(toIdx, 0, moved);

  tracks = reordered.map((t, idx) => ({ ...t, order: idx }));
  if (selectedId) {
    const nextIdx = tracks.findIndex((t) => t.id === selectedId);
    currentTrackIndex = nextIdx >= 0 ? nextIdx : 0;
  }

  isReorderingInline = true;
  buildPlaylistGrid(false);
  if (dirtyInlineEdits) {
    applyInlineChipPreview();
  }
  const heading = byId<HTMLSpanElement>('inlineEditorHeading');
  const currentTrack = tracks[currentTrackIndex];
  if (heading && currentTrack) {
    const displayTitle = dirtyInlineEdits
      ? (byId<HTMLInputElement>('inlineEditTitle')?.value || '').trim() || currentTrack.title
      : currentTrack.title;
    heading.textContent = `Edit #${currentTrackIndex + 1}: ${displayTitle}`;
  }
  updateInlineReorderButtons();

  try {
    await reorderTracks(
      activeSet.id,
      tracks.map((t) => t.id)
    );
    showToast('Button order updated!', 'success');
  } catch (err) {
    tracks = prevTracks;
    currentTrackIndex = prevIndex;
    buildPlaylistGrid(false);
    if (dirtyInlineEdits) {
      applyInlineChipPreview();
    } else {
      syncInlineEditorToCurrentTrack();
    }
    showToast(err instanceof Error ? err.message : 'Failed to update button order.', 'error');
  } finally {
    isReorderingInline = false;
    updateInlineReorderButtons();
  }
}

function syncInlineEditorToCurrentTrack(): void {
  const heading = byId<HTMLSpanElement>('inlineEditorHeading');
  const emptyState = byId<HTMLDivElement>('inlineEmptyState');
  const formBody = byId<HTMLDivElement>('inlineEditorFormBody');
  const titleInput = byId<HTMLInputElement>('inlineEditTitle');
  const fileInput = byId<HTMLInputElement>('inlineEditFile');
  const picker = byId<HTMLSelectElement>('inlineAudioPicker');
  const cueInput = byId<HTMLInputElement>('inlineEditCue');
  const lyricsInput = byId<HTMLTextAreaElement>('inlineEditLyrics');

  pendingInlineDeleteConfirm = false;
  renderInlineDeleteConfirmUI();
  hideUnsavedPrompt();

  const track = tracks[currentTrackIndex];
  if (!track) {
    if (heading) heading.textContent = 'No Buttons';
    if (emptyState) emptyState.style.display = 'flex';
    if (formBody) formBody.style.display = 'none';
    setInlineSaveStatus('clean');
    updateInlineReorderButtons();
    return;
  }

  if (emptyState) emptyState.style.display = 'none';
  if (formBody) formBody.style.display = 'flex';
  if (heading) heading.textContent = `Edit #${currentTrackIndex + 1}: ${track.title}`;

  if (titleInput) titleInput.value = track.title;
  if (fileInput) fileInput.value = track.file;
  if (picker) picker.value = availableConsoleAudioFiles.includes(track.file) ? track.file : '';
  if (cueInput) cueInput.value = track.cue;
  if (lyricsInput) lyricsInput.value = (track.lyrics || []).join('\n');

  setInlineActiveColor(track.color);
  setInlineSaveStatus('clean');
  updateInlineReorderButtons();
}

function selectTrackInEditMode(index: number): void {
  if (index < 0 || index >= tracks.length) return;
  stopInlineAudioPreview();
  restoreChipFromSavedTrack(currentTrackIndex);
  currentTrackIndex = index;

  document.querySelectorAll('.nav-chip').forEach((c) => {
    c.classList.remove('active');
  });
  const activeChip = byId<HTMLDivElement>(`chip-${index}`);
  if (activeChip && !activeChip.classList.contains('playing-now') && !activeChip.classList.contains('fading-now')) {
    activeChip.classList.add('active');
  }

  syncInlineEditorToCurrentTrack();
}

async function saveInlineTrackEdits(): Promise<boolean> {
  const track = tracks[currentTrackIndex];
  if (!activeSet || !track) return false;

  const title = (byId<HTMLInputElement>('inlineEditTitle')?.value || '')
    .trim()
    .slice(0, BLUEPRINT_LIMITS.TRACK_TITLE_MAX);
  const file = (byId<HTMLInputElement>('inlineEditFile')?.value || '')
    .trim()
    .slice(0, BLUEPRINT_LIMITS.TRACK_FILE_MAX);
  const cue = (byId<HTMLInputElement>('inlineEditCue')?.value || '')
    .trim()
    .slice(0, BLUEPRINT_LIMITS.TRACK_CUE_MAX);
  const lyricsText = byId<HTMLTextAreaElement>('inlineEditLyrics')?.value || '';
  const color = getInlineSelectedColor();

  if (!title) {
    showToast('Button label cannot be empty.', 'error');
    return false;
  }
  if (!file) {
    showToast('Audio file path cannot be empty.', 'error');
    return false;
  }

  const fileChanged = file !== track.file;
  const lyrics = normalizeLyrics(lyricsText.split('\n'));
  setInlineSaveStatus('saving');

  try {
    await updateTrack(activeSet.id, track.id, {
      title,
      color,
      file,
      cue,
      lyrics
    });
    if (fileChanged) {
      delete audioErrors[file];
    }
    tracks[currentTrackIndex] = { ...track, title, color, file, cue, lyrics };
    restoreChipFromSavedTrack(currentTrackIndex);
    syncPlayModeDisplay(tracks[currentTrackIndex]);
    const heading = byId<HTMLSpanElement>('inlineEditorHeading');
    if (heading) heading.textContent = `Edit #${currentTrackIndex + 1}: ${title}`;
    setInlineSaveStatus('saved');
    showToast('Button saved to cloud!', 'success');
    return true;
  } catch (err) {
    setInlineSaveStatus('dirty');
    showToast(err instanceof Error ? err.message : 'Failed to save button.', 'error');
    return false;
  }
}

async function handleInlineAddTrack(): Promise<void> {
  if (!activeSet) return;
  try {
    const created = await createTrack(activeSet.id, {
      title: 'New Button',
      color: 'blue',
      file: availableConsoleAudioFiles[0] || 'audio/1-Open-1st-SMIB-Faster.mp3',
      cue: 'Enter cue directive here...',
      lyrics: [],
      order: tracks.length
    });
    tracks = [...tracks, created];
    currentTrackIndex = tracks.length - 1;
    buildPlaylistGrid(false);
    syncInlineEditorToCurrentTrack();
    byId<HTMLInputElement>('inlineEditTitle')?.focus();
    byId<HTMLInputElement>('inlineEditTitle')?.select();
    showToast('New button added!', 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Failed to add button.', 'error');
  }
}

async function handleInlineConfirmDelete(): Promise<void> {
  const track = tracks[currentTrackIndex];
  if (!activeSet || !track) return;
  try {
    await deleteTrack(activeSet.id, track.id);
    dirtyInlineEdits = false;
    pendingInlineDeleteConfirm = false;
    tracks = tracks.filter((t) => t.id !== track.id);
    if (currentTrackIndex >= tracks.length) {
      currentTrackIndex = Math.max(0, tracks.length - 1);
    }
    buildPlaylistGrid(false);
    syncInlineEditorToCurrentTrack();
    showToast('Button deleted.', 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Failed to delete button.', 'error');
  }
}

function enterEditMode(): void {
  if (!canEditActiveSet()) return;
  isEditMode = true;
  byId<HTMLDivElement>('screenConsole')?.classList.add('edit-mode-active');
  updateConsoleAdminEditButton();
  buildPlaylistGrid(false);
  void fetchConsoleAudioFilesCatalog();
  syncInlineEditorToCurrentTrack();
}

function exitEditMode(force = false): void {
  if (!isEditMode) return;
  if (!force && dirtyInlineEdits) {
    requestGuardedEditAction(() => {
      exitEditMode(true);
    });
    return;
  }

  stopInlineAudioPreview();
  hideUnsavedPrompt();
  pendingInlineDeleteConfirm = false;
  dirtyInlineEdits = false;
  isEditMode = false;
  byId<HTMLDivElement>('screenConsole')?.classList.remove('edit-mode-active');
  updateConsoleAdminEditButton();
  buildPlaylistGrid(false);
  if (tracks.length > 0) {
    if (!isPlaying) {
      loadTrack(currentTrackIndex);
    } else {
      syncPlayModeDisplay(tracks[currentTrackIndex]);
    }
  }
}

function updateConsoleAdminEditButton(): void {
  const studioBtn = byId<HTMLButtonElement>('btnConsoleEditSet');
  const toggleBtn = byId<HTMLButtonElement>('btnToggleEditMode');

  if (isAdmin && activeSet) {
    if (studioBtn) {
      studioBtn.style.display = 'inline-flex';
      studioBtn.onclick = () => {
        window.location.href = `./edit.html?set=${encodeURIComponent(activeSet!.id)}`;
      };
    }
  } else if (studioBtn) {
    studioBtn.style.display = 'none';
  }

  if (!toggleBtn) return;
  if (canEditActiveSet()) {
    toggleBtn.style.display = 'inline-flex';
    toggleBtn.classList.toggle('active', isEditMode);
    toggleBtn.setAttribute('aria-pressed', isEditMode ? 'true' : 'false');
    toggleBtn.innerText = isEditMode ? '✓ Done' : '✏️ Edit';
  } else {
    toggleBtn.style.display = 'none';
    if (isEditMode) {
      exitEditMode(true);
    }
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
        <a href="./edit.html" class="btn-owner-edit">✏️ Edit Buttons &amp; Order</a>
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
  initThemeSwitcher();
  renderInlineColorSwatches();

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
  byId<HTMLButtonElement>('btnBackHome')?.addEventListener('click', () => {
    if (isEditMode && dirtyInlineEdits) {
      requestGuardedEditAction(() => {
        navigateToHomeScreen();
      });
      return;
    }
    navigateToHomeScreen();
  });
  byId<HTMLButtonElement>('btnToggleEditMode')?.addEventListener('click', () => {
    if (isEditMode) {
      exitEditMode(false);
    } else {
      enterEditMode();
    }
  });

  byId<HTMLInputElement>('inlineEditTitle')?.addEventListener('input', () => {
    applyInlineChipPreview();
    setInlineSaveStatus('dirty');
  });
  byId<HTMLInputElement>('inlineEditFile')?.addEventListener('input', () => {
    const picker = byId<HTMLSelectElement>('inlineAudioPicker');
    const val = byId<HTMLInputElement>('inlineEditFile')?.value || '';
    if (picker) {
      picker.value = availableConsoleAudioFiles.includes(val) ? val : '';
    }
    setInlineSaveStatus('dirty');
  });
  byId<HTMLSelectElement>('inlineAudioPicker')?.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value;
    const fileInput = byId<HTMLInputElement>('inlineEditFile');
    if (val && fileInput) {
      fileInput.value = val;
      setInlineSaveStatus('dirty');
    }
  });
  byId<HTMLInputElement>('inlineEditCue')?.addEventListener('input', () => {
    setInlineSaveStatus('dirty');
  });
  byId<HTMLTextAreaElement>('inlineEditLyrics')?.addEventListener('input', () => {
    setInlineSaveStatus('dirty');
  });

  byId<HTMLButtonElement>('btnInlinePreviewAudio')?.addEventListener('click', toggleInlineAudioPreview);
  byId<HTMLButtonElement>('btnInlineSaveTrack')?.addEventListener('click', () => {
    void saveInlineTrackEdits();
  });
  byId<HTMLButtonElement>('btnInlineRevertTrack')?.addEventListener('click', () => {
    restoreChipFromSavedTrack(currentTrackIndex);
    syncInlineEditorToCurrentTrack();
  });
  byId<HTMLButtonElement>('btnInlineMoveEarlier')?.addEventListener('click', () => {
    void reorderInlineTracks(currentTrackIndex, currentTrackIndex - 1);
  });
  byId<HTMLButtonElement>('btnInlineMoveLater')?.addEventListener('click', () => {
    void reorderInlineTracks(currentTrackIndex, currentTrackIndex + 1);
  });
  byId<HTMLButtonElement>('btnInlineAddTrack')?.addEventListener('click', () => {
    requestGuardedEditAction(() => {
      void handleInlineAddTrack();
    });
  });
  byId<HTMLButtonElement>('btnInlineEmptyAddTrack')?.addEventListener('click', () => {
    void handleInlineAddTrack();
  });
  byId<HTMLButtonElement>('btnInlineDeleteTrack')?.addEventListener('click', () => {
    pendingInlineDeleteConfirm = true;
    renderInlineDeleteConfirmUI();
  });
  byId<HTMLButtonElement>('btnInlineCancelDelete')?.addEventListener('click', () => {
    pendingInlineDeleteConfirm = false;
    renderInlineDeleteConfirmUI();
  });
  byId<HTMLButtonElement>('btnInlineConfirmDelete')?.addEventListener('click', () => {
    void handleInlineConfirmDelete();
  });

  byId<HTMLButtonElement>('btnInlineConfirmSave')?.addEventListener('click', async () => {
    const action = pendingInlineAction;
    const ok = await saveInlineTrackEdits();
    if (ok) {
      hideUnsavedPrompt();
      if (action) action();
    }
  });
  byId<HTMLButtonElement>('btnInlineConfirmDiscard')?.addEventListener('click', () => {
    const action = pendingInlineAction;
    restoreChipFromSavedTrack(currentTrackIndex);
    dirtyInlineEdits = false;
    hideUnsavedPrompt();
    if (action) action();
  });
  byId<HTMLButtonElement>('btnInlineConfirmCancel')?.addEventListener('click', hideUnsavedPrompt);

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

  const signInBtn = byId<HTMLButtonElement>('ownerSignInBtn');
  signInBtn?.addEventListener('click', async () => {
    signInBtn.disabled = true;
    const prevText = signInBtn.innerText;
    signInBtn.innerText = 'signing in...';
    try {
      await signInWithGoogle();
    } catch (err) {
      showSignInErrorNotice(err);
    } finally {
      signInBtn.disabled = false;
      signInBtn.innerText = prevText;
    }
  });

  void consumeAuthRedirectResult().catch((err) => {
    showSignInErrorNotice(err);
  });

  const switcherRow = byId<HTMLDivElement>('setSwitcherRow');
  if (switcherRow) {
    switcherRow.innerHTML = '<div style="grid-column: 1 / -1; text-align:center; padding: 18px; color: var(--text-dim);">Loading sets...</div>';
  }

  subscribeAuth(async (user) => {
    currentUser = user;
    isAdmin = await checkIsAdminUser(user);
    renderAuthControls();
  });

  const handleSetUrlRouting = (): void => {
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
  };

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

      handleSetUrlRouting();
    },
    (err) => {
      console.error('Failed to load ceremonial sets from cloud:', err);
      void loadLocalFallbackSets()
        .then((localSets) => {
          if (dynamicSets.length === 0) {
            dynamicSets = localSets;
            buildSetSwitcherUI();
            handleSetUrlRouting();
            showToast('Loaded offline local setlists (cloud unavailable).', 'info');
          }
        })
        .catch(() => {
          const row = byId<HTMLDivElement>('setSwitcherRow');
          if (row) {
            row.innerHTML = '<div style="grid-column: 1 / -1; text-align:center; padding: 18px; color: var(--error-text);">Unable to reach cloud configuration. Check your connection and reload.</div>';
          }
          showToast('Failed to load configuration from cloud.', 'error');
        });
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
    stopInlineAudioPreview();
  });
}

window.addEventListener('DOMContentLoaded', initConsole);
