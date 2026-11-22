import type { User } from 'firebase/auth';
import {
  checkIsAdminUser,
  consumeAuthRedirectResult,
  FIREBASE_PROJECT_ID,
  OWNER_EMAIL,
  signInWithGoogle,
  signOutUser,
  subscribeAuth
} from './firebase';
import {
  createSet,
  createTrack,
  deleteSetAndTracks,
  deleteTrack,
  importTracksIntoSet,
  migrateLegacyConfiguration,
  normalizeColor,
  normalizeLyrics,
  reorderSets,
  reorderTracks,
  subscribeToSets,
  subscribeToTracks,
  updateSet,
  updateTrack
} from './store';
import { initThemeSwitcher } from './theme';
import {
  BLUEPRINT_LIMITS,
  TRACK_COLOR_META,
  TRACK_COLORS,
  type LegacyTrackEntry,
  type SetConfig,
  type TrackButton,
  type TrackColor
} from './types';

declare global {
  interface Window {
    __lodgeMusicEditorBooted?: boolean;
  }
}
window.__lodgeMusicEditorBooted = true;

let currentUser: User | null = null;
let isAdmin = false;

let setsList: SetConfig[] = [];
let activeSetId: string | null = null;
let tracksList: TrackButton[] = [];
let selectedTrackId: string | null = null;
let availableAudioFiles: string[] = [];

let unsubscribeSets: (() => void) | null = null;
let unsubscribeTracks: (() => void) | null = null;

let previewAudio: HTMLAudioElement | null = null;
let previewingFile: string | null = null;

let dragSrcIndex: number | null = null;
let dirtyTrackEdits = false;
let pendingDeleteSetConfirm = false;
let pendingDeleteTrackConfirm = false;

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function showToast(message: string, variant: 'info' | 'success' | 'error' = 'info'): void {
  const toast = byId<HTMLDivElement>('editorToast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `editor-toast visible toast-${variant}`;
  window.setTimeout(() => {
    toast.classList.remove('visible');
  }, 3600);
}

function stopAudioPreview(): void {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.currentTime = 0;
    previewAudio = null;
  }
  previewingFile = null;
  const previewBtn = byId<HTMLButtonElement>('btnPreviewAudio');
  if (previewBtn) {
    previewBtn.innerText = '▶ Preview Audio';
  }
}

async function fetchAudioFilesCatalog(): Promise<void> {
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
    tracksList.forEach((t) => {
      if (t.file) discovered.add(t.file);
    });
  }

  availableAudioFiles = Array.from(discovered).sort((a, b) => a.localeCompare(b));
  const datalist = byId<HTMLDataListElement>('audioFilesDatalist');
  if (datalist) {
    datalist.innerHTML = '';
    availableAudioFiles.forEach((f) => {
      const opt = document.createElement('option');
      opt.value = f;
      datalist.appendChild(opt);
    });
  }
  const quickSelect = byId<HTMLSelectElement>('audioFilePickerSelect');
  if (quickSelect) {
    quickSelect.innerHTML = '<option value="">-- Pick an existing file in /audio --</option>';
    availableAudioFiles.forEach((f) => {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f.replace(/^audio\//, '');
      quickSelect.appendChild(opt);
    });
  }
}

function updateSaveIndicator(state: 'clean' | 'dirty' | 'saving' | 'saved'): void {
  const badge = byId<HTMLSpanElement>('saveStateBadge');
  const saveBtn = byId<HTMLButtonElement>('btnSaveTrack');
  if (!badge || !saveBtn) return;

  if (state === 'dirty') {
    dirtyTrackEdits = true;
    badge.textContent = 'Unsaved changes';
    badge.className = 'save-badge badge-dirty';
    saveBtn.disabled = false;
  } else if (state === 'saving') {
    badge.textContent = 'Saving...';
    badge.className = 'save-badge badge-saving';
    saveBtn.disabled = true;
  } else if (state === 'saved') {
    dirtyTrackEdits = false;
    badge.textContent = '✓ Saved to Cloud';
    badge.className = 'save-badge badge-saved';
    saveBtn.disabled = false;
  } else {
    dirtyTrackEdits = false;
    badge.textContent = 'Synced';
    badge.className = 'save-badge badge-clean';
    saveBtn.disabled = false;
  }
}

function renderAuthGate(): void {
  const gatePanel = byId<HTMLDivElement>('authGatePanel');
  const studioPanel = byId<HTMLDivElement>('studioWorkspace');
  const userStatus = byId<HTMLDivElement>('headerUserStatus');

  if (!gatePanel || !studioPanel || !userStatus) return;

  if (!currentUser) {
    gatePanel.style.display = 'flex';
    studioPanel.style.display = 'none';
    gatePanel.innerHTML = `
      <div class="auth-card">
        <h2>Owner Sign-In Required</h2>
        <p>Anyone can use the public Digital Organist player without an account. Sign in with the owner Google account (<strong>${OWNER_EMAIL}</strong>) to edit buttons, colors, order, or migrate your configuration.</p>
        <div id="editorAuthErrorBox" style="display:none;background:rgba(243,156,18,0.12);border:1px solid var(--cue-gold);border-radius:8px;padding:12px;text-align:left;font-size:0.88rem;line-height:1.45;color:var(--text-bright);"></div>
        <div class="auth-actions">
          <button type="button" class="btn-utility btn-primary" id="btnGoogleSignIn">Sign in with Google</button>
          <a href="./" class="btn-utility btn-secondary">◀ Back to Public Player</a>
        </div>
      </div>
    `;
    userStatus.innerHTML = '';
    const signInBtn = byId<HTMLButtonElement>('btnGoogleSignIn');
    signInBtn?.addEventListener('click', async () => {
      signInBtn.disabled = true;
      signInBtn.textContent = 'Signing in...';
      try {
        await signInWithGoogle();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Sign-in cancelled.';
        const errBox = byId<HTMLDivElement>('editorAuthErrorBox');
        if (msg.includes('auth/unauthorized-domain')) {
          const host = window.location.hostname || window.location.host;
          if (errBox) {
            errBox.style.display = 'block';
            errBox.innerHTML = `
              <strong style="color:var(--cue-gold);">Domain "${host}" is not authorized yet.</strong><br>
              Add <code>${host}</code> under <strong>Authorized domains</strong> in
              <a href="https://console.firebase.google.com/project/${FIREBASE_PROJECT_ID}/authentication/settings" target="_blank" rel="noopener noreferrer" style="color:var(--active-blue);font-weight:700;">Firebase Authentication Settings</a>.
            `;
          }
          showToast(`Add "${host}" to Firebase Auth Authorized Domains.`, 'error');
        } else {
          if (errBox) {
            errBox.style.display = 'block';
            errBox.textContent = msg;
          }
          showToast(msg, 'error');
        }
      } finally {
        signInBtn.disabled = false;
        signInBtn.textContent = 'Sign in with Google';
      }
    });
    return;
  }

  if (!isAdmin) {
    gatePanel.style.display = 'flex';
    studioPanel.style.display = 'none';
    gatePanel.innerHTML = `
      <div class="auth-card">
        <h2>Read-Only Account</h2>
        <p>You are signed in as <strong>${currentUser.email || 'Unknown'}</strong>. Editing is restricted exclusively to the app owner (<strong>${OWNER_EMAIL}</strong>).</p>
        <div class="auth-actions">
          <a href="./" class="btn-utility btn-primary">◀ Open Public Player</a>
          <button type="button" class="btn-utility btn-secondary" id="btnGateSignOut">Sign Out</button>
        </div>
      </div>
    `;
    userStatus.innerHTML = '';
    byId<HTMLButtonElement>('btnGateSignOut')?.addEventListener('click', () => {
      void signOutUser();
    });
    return;
  }

  gatePanel.style.display = 'none';
  studioPanel.style.display = 'flex';
  userStatus.innerHTML = `
    <span class="owner-pill">Owner: ${currentUser.email || ''}</span>
    <button type="button" class="btn-utility btn-secondary btn-compact" id="btnHeaderSignOut">Sign Out</button>
  `;
  byId<HTMLButtonElement>('btnHeaderSignOut')?.addEventListener('click', () => {
    void signOutUser();
  });

  startAdminDataSync();
}

function startAdminDataSync(): void {
  if (unsubscribeSets) return;
  void fetchAudioFilesCatalog();

  unsubscribeSets = subscribeToSets(
    (sets) => {
      setsList = sets;
      const urlSetParam = new URLSearchParams(window.location.search).get('set');

      if (!activeSetId && setsList.length > 0) {
        const matched = urlSetParam
          ? setsList.find((s) => s.id === urlSetParam || String(s.legacyId) === urlSetParam)
          : null;
        selectSet((matched || setsList[0]).id);
      } else if (activeSetId && !setsList.some((s) => s.id === activeSetId)) {
        activeSetId = setsList[0]?.id || null;
        if (activeSetId) {
          selectSet(activeSetId);
        } else {
          tracksList = [];
          selectedTrackId = null;
          renderTrackList();
          renderPreviewGrid();
          disablePropertiesPanel();
        }
      }

      renderSetSelector();
      renderMigrationEmptyHint();
    },
    (err) => {
      showToast(`Cloud sync error: ${err.message}`, 'error');
    }
  );
}

function renderMigrationEmptyHint(): void {
  const hint = byId<HTMLDivElement>('emptyMigrationBanner');
  if (!hint) return;
  hint.style.display = setsList.length === 0 ? 'flex' : 'none';
}

function renderSetSelector(): void {
  const selector = byId<HTMLSelectElement>('setSelect');
  const renameInput = byId<HTMLInputElement>('setRenameInput');
  const setOrderInfo = byId<HTMLSpanElement>('setOrderInfo');
  const moveLeftBtn = byId<HTMLButtonElement>('btnMoveSetUp');
  const moveRightBtn = byId<HTMLButtonElement>('btnMoveSetDown');
  const deleteSetBtn = byId<HTMLButtonElement>('btnDeleteSet');

  if (!selector) return;
  selector.innerHTML = '';

  if (setsList.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '-- No Sets in Cloud Yet --';
    selector.appendChild(opt);
    if (renameInput) renameInput.value = '';
    if (setOrderInfo) setOrderInfo.textContent = '';
    if (moveLeftBtn) moveLeftBtn.disabled = true;
    if (moveRightBtn) moveRightBtn.disabled = true;
    if (deleteSetBtn) deleteSetBtn.disabled = true;
    return;
  }

  setsList.forEach((s, idx) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${idx + 1}. ${s.label}`;
    if (s.id === activeSetId) opt.selected = true;
    selector.appendChild(opt);
  });

  const activeIdx = setsList.findIndex((s) => s.id === activeSetId);
  const currentSet = activeIdx >= 0 ? setsList[activeIdx] : null;
  if (renameInput && currentSet && document.activeElement !== renameInput) {
    renameInput.value = currentSet.label;
  }
  if (setOrderInfo) {
    setOrderInfo.textContent = currentSet ? `Set ${activeIdx + 1} of ${setsList.length}` : '';
  }
  if (moveLeftBtn) moveLeftBtn.disabled = activeIdx <= 0;
  if (moveRightBtn) moveRightBtn.disabled = activeIdx < 0 || activeIdx >= setsList.length - 1;
  if (deleteSetBtn) deleteSetBtn.disabled = !currentSet;
}

function selectSet(setId: string): void {
  if (unsubscribeTracks) {
    unsubscribeTracks();
    unsubscribeTracks = null;
  }
  activeSetId = setId;
  selectedTrackId = null;
  pendingDeleteSetConfirm = false;
  pendingDeleteTrackConfirm = false;
  renderDeleteSetConfirmUI();
  stopAudioPreview();
  disablePropertiesPanel();
  renderSetSelector();

  const listContainer = byId<HTMLDivElement>('trackListContainer');
  if (listContainer) {
    listContainer.innerHTML = '<div class="empty-placeholder">Loading buttons from cloud...</div>';
  }

  unsubscribeTracks = subscribeToTracks(
    setId,
    (loaded) => {
      tracksList = loaded;
      renderTrackList();
      renderPreviewGrid();

      if (selectedTrackId) {
        const stillExists = tracksList.find((t) => t.id === selectedTrackId);
        if (!stillExists) {
          selectedTrackId = null;
          disablePropertiesPanel();
        } else if (!dirtyTrackEdits) {
          populatePropertiesForm(stillExists);
        }
      }
    },
    (err) => {
      showToast(`Failed to load buttons: ${err.message}`, 'error');
    }
  );
}

function renderPreviewGrid(): void {
  const previewGrid = byId<HTMLDivElement>('liveGridPreview');
  if (!previewGrid) return;
  previewGrid.innerHTML = '';

  if (tracksList.length === 0) {
    previewGrid.innerHTML = '<div class="empty-placeholder" style="grid-column: 1/-1;">No buttons in this set yet.</div>';
    return;
  }

  tracksList.forEach((track) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `preview-chip color-${track.color}${track.id === selectedTrackId ? ' selected' : ''}`;
    chip.textContent = track.title;
    const words = track.title.split(' ');
    if (words.some((w) => w.length > 9)) chip.style.fontSize = '0.9rem';
    chip.onclick = () => {
      selectTrackForEditing(track.id);
    };
    previewGrid.appendChild(chip);
  });
}

function renderTrackList(): void {
  const container = byId<HTMLDivElement>('trackListContainer');
  const countBadge = byId<HTMLSpanElement>('trackCountBadge');
  if (countBadge) countBadge.textContent = `${tracksList.length} button${tracksList.length === 1 ? '' : 's'}`;
  if (!container) return;
  container.innerHTML = '';

  if (!activeSetId) {
    container.innerHTML = '<div class="empty-placeholder">Select or create a set above to manage buttons.</div>';
    return;
  }

  if (tracksList.length === 0) {
    container.innerHTML = '<div class="empty-placeholder">No buttons in this set. Click "+ Add Button" to create one.</div>';
    return;
  }

  tracksList.forEach((track, idx) => {
    const row = document.createElement('div');
    row.className = `track-item${selectedTrackId === track.id ? ' selected' : ''}`;
    row.draggable = true;
    row.dataset.index = String(idx);

    row.innerHTML = `
      <div class="track-row-left">
        <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
        <span class="color-swatch-dot color-${track.color}"></span>
        <div class="track-meta">
          <span class="track-title-text"><span class="order-num">#${idx + 1}</span> ${escapeHtml(track.title)}</span>
          <span class="track-file-subtext">${escapeHtml(track.file)}</span>
        </div>
      </div>
      <div class="track-order-actions">
        <button type="button" class="btn-order" title="Move Up" data-action="up" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="btn-order" title="Move Down" data-action="down" ${idx === tracksList.length - 1 ? 'disabled' : ''}>▼</button>
      </div>
    `;

    row.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('button[data-action]') as HTMLButtonElement | null;
      if (btn) {
        e.stopPropagation();
        const dir = btn.dataset.action === 'up' ? -1 : 1;
        void moveTrack(idx, dir);
        return;
      }
      selectTrackForEditing(track.id);
    });

    row.addEventListener('dragstart', (e) => {
      dragSrcIndex = idx;
      row.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(idx));
      }
    });

    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      document.querySelectorAll('.track-item.drag-over').forEach((el) => el.classList.remove('drag-over'));
    });

    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('drag-over');
    });

    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      if (dragSrcIndex === null || dragSrcIndex === idx) return;
      void reorderTrackByDrag(dragSrcIndex, idx);
      dragSrcIndex = null;
    });

    container.appendChild(row);
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function selectTrackForEditing(trackId: string): void {
  const track = tracksList.find((t) => t.id === trackId);
  if (!track) return;
  selectedTrackId = trackId;
  pendingDeleteTrackConfirm = false;
  renderDeleteTrackConfirmUI();
  stopAudioPreview();
  populatePropertiesForm(track);
  renderTrackList();
  renderPreviewGrid();
}

function populatePropertiesForm(track: TrackButton): void {
  const panel = byId<HTMLDivElement>('propertiesPanel');
  if (panel) {
    panel.style.opacity = '1';
    panel.style.pointerEvents = 'auto';
  }

  const titleInput = byId<HTMLInputElement>('editTitle');
  const fileInput = byId<HTMLInputElement>('editFile');
  const cueInput = byId<HTMLInputElement>('editCue');
  const lyricsInput = byId<HTMLTextAreaElement>('editLyrics');
  const quickSelect = byId<HTMLSelectElement>('audioFilePickerSelect');

  if (titleInput) titleInput.value = track.title;
  if (fileInput) fileInput.value = track.file;
  if (cueInput) cueInput.value = track.cue;
  if (lyricsInput) lyricsInput.value = (track.lyrics || []).join('\n');
  if (quickSelect) {
    quickSelect.value = availableAudioFiles.includes(track.file) ? track.file : '';
  }

  setActiveColorSwatch(track.color);
  updateButtonPreviewPill(track.title, track.color);
  updateSaveIndicator('clean');
}

function disablePropertiesPanel(): void {
  const panel = byId<HTMLDivElement>('propertiesPanel');
  if (panel) {
    panel.style.opacity = '0.45';
    panel.style.pointerEvents = 'none';
  }
  const titleInput = byId<HTMLInputElement>('editTitle');
  const fileInput = byId<HTMLInputElement>('editFile');
  const cueInput = byId<HTMLInputElement>('editCue');
  const lyricsInput = byId<HTMLTextAreaElement>('editLyrics');
  if (titleInput) titleInput.value = '';
  if (fileInput) fileInput.value = '';
  if (cueInput) cueInput.value = '';
  if (lyricsInput) lyricsInput.value = '';
  setActiveColorSwatch('blue');
  updateButtonPreviewPill('Select a button', 'blue');
  updateSaveIndicator('clean');
}

function renderColorSwatches(): void {
  const container = byId<HTMLDivElement>('colorSwatchGrid');
  if (!container) return;
  container.innerHTML = '';

  TRACK_COLORS.forEach((color) => {
    const meta = TRACK_COLOR_META[color];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `color-swatch-btn color-${color}`;
    btn.dataset.color = color;
    btn.innerHTML = `<span>${meta.label}</span>`;
    btn.onclick = () => {
      setActiveColorSwatch(color);
      const titleVal = byId<HTMLInputElement>('editTitle')?.value || 'Button';
      updateButtonPreviewPill(titleVal, color);
      updateSaveIndicator('dirty');
    };
    container.appendChild(btn);
  });
}

function getSelectedColorSwatch(): TrackColor {
  const active = document.querySelector<HTMLButtonElement>('.color-swatch-btn.active');
  return normalizeColor(active?.dataset.color || 'blue');
}

function setActiveColorSwatch(color: TrackColor): void {
  document.querySelectorAll<HTMLButtonElement>('.color-swatch-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.color === color);
  });
}

function updateButtonPreviewPill(title: string, color: TrackColor): void {
  const pill = byId<HTMLDivElement>('buttonLiveSample');
  if (!pill) return;
  pill.className = `button-live-sample color-${color}`;
  pill.textContent = title.trim() || '(Untitled Button)';
}

async function saveCurrentTrackEdits(): Promise<void> {
  if (!activeSetId || !selectedTrackId) return;

  const title = (byId<HTMLInputElement>('editTitle')?.value || '').trim().slice(0, BLUEPRINT_LIMITS.TRACK_TITLE_MAX);
  const file = (byId<HTMLInputElement>('editFile')?.value || '').trim().slice(0, BLUEPRINT_LIMITS.TRACK_FILE_MAX);
  const cue = (byId<HTMLInputElement>('editCue')?.value || '').trim().slice(0, BLUEPRINT_LIMITS.TRACK_CUE_MAX);
  const lyricsText = byId<HTMLTextAreaElement>('editLyrics')?.value || '';
  const color = getSelectedColorSwatch();

  if (!title) {
    showToast('Button text cannot be empty.', 'error');
    return;
  }
  if (!file) {
    showToast('Audio file path cannot be empty.', 'error');
    return;
  }

  const lyrics = normalizeLyrics(lyricsText.split('\n'));
  updateSaveIndicator('saving');

  try {
    await updateTrack(activeSetId, selectedTrackId, {
      title,
      color,
      file,
      cue,
      lyrics
    });
    updateSaveIndicator('saved');
    showToast('Button saved to cloud!', 'success');
  } catch (err) {
    updateSaveIndicator('dirty');
    showToast(err instanceof Error ? err.message : 'Failed to save button.', 'error');
  }
}

async function handleAddNewButton(): Promise<void> {
  if (!activeSetId) {
    showToast('Create or select a set first.', 'error');
    return;
  }
  try {
    const created = await createTrack(activeSetId, {
      title: 'New Button',
      color: 'blue',
      file: availableAudioFiles[0] || 'audio/1-Open-1st-SMIB-Faster.mp3',
      cue: 'Enter cue directive here...',
      lyrics: [],
      order: tracksList.length
    });
    selectedTrackId = created.id;
    dirtyTrackEdits = false;
    populatePropertiesForm(created);
    showToast('New button added!', 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Failed to add button.', 'error');
  }
}

async function moveTrack(index: number, direction: -1 | 1): Promise<void> {
  if (!activeSetId) return;
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= tracksList.length) return;

  const reordered = [...tracksList];
  const [moved] = reordered.splice(index, 1);
  reordered.splice(targetIndex, 0, moved);

  tracksList = reordered.map((t, idx) => ({ ...t, order: idx }));
  renderTrackList();
  renderPreviewGrid();

  try {
    await reorderTracks(
      activeSetId,
      reordered.map((t) => t.id)
    );
    showToast('Button order updated!', 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Failed to update order.', 'error');
  }
}

async function reorderTrackByDrag(fromIdx: number, toIdx: number): Promise<void> {
  if (!activeSetId) return;
  const reordered = [...tracksList];
  const [moved] = reordered.splice(fromIdx, 1);
  reordered.splice(toIdx, 0, moved);

  tracksList = reordered.map((t, idx) => ({ ...t, order: idx }));
  renderTrackList();
  renderPreviewGrid();

  try {
    await reorderTracks(
      activeSetId,
      reordered.map((t) => t.id)
    );
    showToast('Button order updated!', 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Failed to reorder buttons.', 'error');
  }
}

function renderDeleteTrackConfirmUI(): void {
  const normalBtn = byId<HTMLButtonElement>('btnDeleteTrack');
  const confirmBox = byId<HTMLDivElement>('deleteTrackConfirmBox');
  if (!normalBtn || !confirmBox) return;
  if (pendingDeleteTrackConfirm) {
    normalBtn.style.display = 'none';
    confirmBox.style.display = 'flex';
  } else {
    normalBtn.style.display = 'inline-flex';
    confirmBox.style.display = 'none';
  }
}

function renderDeleteSetConfirmUI(): void {
  const normalBtn = byId<HTMLButtonElement>('btnDeleteSet');
  const confirmBox = byId<HTMLDivElement>('deleteSetConfirmBox');
  if (!normalBtn || !confirmBox) return;
  if (pendingDeleteSetConfirm) {
    normalBtn.style.display = 'none';
    confirmBox.style.display = 'flex';
  } else {
    normalBtn.style.display = 'inline-flex';
    confirmBox.style.display = 'none';
  }
}

async function handleCreateNewSet(): Promise<void> {
  const input = byId<HTMLInputElement>('newSetLabelInput');
  const label = (input?.value || '').trim();
  if (!label) {
    showToast('Enter a name for the new set.', 'error');
    return;
  }
  try {
    const created = await createSet(label, setsList.length);
    if (input) input.value = '';
    selectSet(created.id);
    showToast(`Created set "${created.label}"!`, 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Failed to create set.', 'error');
  }
}

async function handleRenameCurrentSet(): Promise<void> {
  if (!activeSetId) return;
  const input = byId<HTMLInputElement>('setRenameInput');
  const newLabel = (input?.value || '').trim();
  if (!newLabel) {
    showToast('Set name cannot be empty.', 'error');
    return;
  }
  try {
    await updateSet(activeSetId, { label: newLabel });
    showToast('Set renamed!', 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Failed to rename set.', 'error');
  }
}

async function handleMoveSetOrder(direction: -1 | 1): Promise<void> {
  if (!activeSetId) return;
  const idx = setsList.findIndex((s) => s.id === activeSetId);
  const targetIdx = idx + direction;
  if (idx < 0 || targetIdx < 0 || targetIdx >= setsList.length) return;

  const reordered = [...setsList];
  const [moved] = reordered.splice(idx, 1);
  reordered.splice(targetIdx, 0, moved);

  try {
    await reorderSets(reordered.map((s) => s.id));
    showToast('Set order updated!', 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Failed to reorder sets.', 'error');
  }
}

async function handleUploadNewAudioForButton(inputEl: HTMLInputElement): Promise<void> {
  const file = inputEl.files?.[0];
  if (!file) return;
  const safeName = file.name.replace(/[^a-zA-Z0-9._ -]/g, '_');
  const targetPath = `audio/Custom/${safeName}`;

  try {
    const buffer = await file.arrayBuffer();
    const res = await fetch(`./api/upload-audio?path=${encodeURIComponent(targetPath)}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'audio/mpeg' },
      body: buffer
    });
    if (!res.ok) {
      if (res.status === 404 || res.status === 405) {
        throw new Error('Direct upload requires the Node server. Add the audio file to your GitHub /audio folder and enter its path above.');
      }
      const errJson = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(errJson.error || `Upload failed (${res.status})`);
    }
    const fileInput = byId<HTMLInputElement>('editFile');
    if (fileInput) {
      fileInput.value = targetPath;
      updateSaveIndicator('dirty');
    }
    await fetchAudioFilesCatalog();
    showToast(`Uploaded ${safeName} to ${targetPath}!`, 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Failed to upload audio file.', 'error');
  } finally {
    inputEl.value = '';
  }
}

function toggleAudioPreview(): void {
  const filePath = (byId<HTMLInputElement>('editFile')?.value || '').trim();
  const previewBtn = byId<HTMLButtonElement>('btnPreviewAudio');
  if (!filePath) {
    showToast('Enter an audio file path first.', 'error');
    return;
  }

  if (previewAudio && previewingFile === filePath) {
    stopAudioPreview();
    return;
  }

  stopAudioPreview();
  previewingFile = filePath;
  previewAudio = new Audio(filePath);
  if (previewBtn) previewBtn.innerText = '■ Stop Preview';
  previewAudio.onended = () => {
    stopAudioPreview();
  };
  previewAudio.onerror = () => {
    stopAudioPreview();
    showToast(`Could not play ${filePath}. Verify the file exists.`, 'error');
  };
  void previewAudio.play().catch((err) => {
    stopAudioPreview();
    showToast(err instanceof Error ? err.message : 'Audio preview failed.', 'error');
  });
}

async function handleLegacyMigration(mode: 'merge' | 'replace'): Promise<void> {
  const includeFiller = byId<HTMLInputElement>('chkIncludeFiller')?.checked ?? false;
  const includeMark = byId<HTMLInputElement>('chkIncludeMark')?.checked ?? false;
  const statusEl = byId<HTMLSpanElement>('migrationStatusText');

  if (statusEl) statusEl.textContent = 'Importing configuration to cloud...';

  try {
    const result = await migrateLegacyConfiguration({
      mode,
      includeFiller,
      includeMark
    });
    const msg = `Imported ${result.setsImported} set(s) and ${result.tracksImported} button(s)${
      result.setsSkipped > 0 ? ` (${result.setsSkipped} already in cloud)` : ''
    }.`;
    if (statusEl) statusEl.textContent = msg;
    showToast(msg, 'success');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Migration failed.';
    if (statusEl) statusEl.textContent = msg;
    showToast(msg, 'error');
  }
}

async function handleImportJsonFileIntoSet(inputEl: HTMLInputElement): Promise<void> {
  const file = inputEl.files?.[0];
  if (!file || !activeSetId) return;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error('JSON file must contain an array of button objects.');
    }
    const count = await importTracksIntoSet(
      activeSetId,
      parsed as LegacyTrackEntry[],
      'append',
      tracksList.length
    );
    showToast(`Appended ${count} buttons from ${file.name}!`, 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Invalid JSON file.', 'error');
  } finally {
    inputEl.value = '';
  }
}

function handleDownloadCurrentSetJson(): void {
  if (!activeSetId) return;
  const currentSet = setsList.find((s) => s.id === activeSetId);
  const exported = tracksList.map((t) => ({
    id: t.id,
    title: t.title,
    color: t.color,
    file: t.file,
    cue: t.cue,
    lyrics: t.lyrics
  }));
  const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(currentSet?.label || activeSetId).toLowerCase().replace(/[^a-z0-9]+/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function wireEventListeners(): void {
  renderColorSwatches();

  byId<HTMLSelectElement>('setSelect')?.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value;
    if (val) selectSet(val);
  });

  byId<HTMLButtonElement>('btnCreateSet')?.addEventListener('click', () => {
    void handleCreateNewSet();
  });
  byId<HTMLButtonElement>('btnRenameSet')?.addEventListener('click', () => {
    void handleRenameCurrentSet();
  });
  byId<HTMLButtonElement>('btnMoveSetUp')?.addEventListener('click', () => {
    void handleMoveSetOrder(-1);
  });
  byId<HTMLButtonElement>('btnMoveSetDown')?.addEventListener('click', () => {
    void handleMoveSetOrder(1);
  });

  byId<HTMLButtonElement>('btnDeleteSet')?.addEventListener('click', () => {
    pendingDeleteSetConfirm = true;
    renderDeleteSetConfirmUI();
  });
  byId<HTMLButtonElement>('btnCancelDeleteSet')?.addEventListener('click', () => {
    pendingDeleteSetConfirm = false;
    renderDeleteSetConfirmUI();
  });
  byId<HTMLButtonElement>('btnConfirmDeleteSet')?.addEventListener('click', async () => {
    if (!activeSetId) return;
    try {
      await deleteSetAndTracks(activeSetId);
      pendingDeleteSetConfirm = false;
      renderDeleteSetConfirmUI();
      showToast('Set deleted from cloud.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete set.', 'error');
    }
  });

  byId<HTMLButtonElement>('btnAddTrack')?.addEventListener('click', () => {
    void handleAddNewButton();
  });
  byId<HTMLButtonElement>('btnSaveTrack')?.addEventListener('click', () => {
    void saveCurrentTrackEdits();
  });

  byId<HTMLButtonElement>('btnDeleteTrack')?.addEventListener('click', () => {
    if (!selectedTrackId) return;
    pendingDeleteTrackConfirm = true;
    renderDeleteTrackConfirmUI();
  });
  byId<HTMLButtonElement>('btnCancelDeleteTrack')?.addEventListener('click', () => {
    pendingDeleteTrackConfirm = false;
    renderDeleteTrackConfirmUI();
  });
  byId<HTMLButtonElement>('btnConfirmDeleteTrack')?.addEventListener('click', async () => {
    if (!activeSetId || !selectedTrackId) return;
    try {
      await deleteTrack(activeSetId, selectedTrackId);
      selectedTrackId = null;
      pendingDeleteTrackConfirm = false;
      renderDeleteTrackConfirmUI();
      disablePropertiesPanel();
      showToast('Button deleted.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete button.', 'error');
    }
  });

  byId<HTMLInputElement>('editTitle')?.addEventListener('input', (e) => {
    const val = (e.target as HTMLInputElement).value;
    updateButtonPreviewPill(val, getSelectedColorSwatch());
    updateSaveIndicator('dirty');
  });
  byId<HTMLInputElement>('editFile')?.addEventListener('input', () => {
    updateSaveIndicator('dirty');
  });
  byId<HTMLInputElement>('editCue')?.addEventListener('input', () => {
    updateSaveIndicator('dirty');
  });
  byId<HTMLTextAreaElement>('editLyrics')?.addEventListener('input', () => {
    updateSaveIndicator('dirty');
  });

  byId<HTMLSelectElement>('audioFilePickerSelect')?.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value;
    const fileInput = byId<HTMLInputElement>('editFile');
    if (val && fileInput) {
      fileInput.value = val;
      updateSaveIndicator('dirty');
    }
  });

  byId<HTMLButtonElement>('btnUploadAudioAsset')?.addEventListener('click', () => {
    byId<HTMLInputElement>('uploadAudioAssetInput')?.click();
  });
  byId<HTMLInputElement>('uploadAudioAssetInput')?.addEventListener('change', (e) => {
    void handleUploadNewAudioForButton(e.target as HTMLInputElement);
  });

  byId<HTMLButtonElement>('btnPreviewAudio')?.addEventListener('click', toggleAudioPreview);

  byId<HTMLButtonElement>('btnMigrateMerge')?.addEventListener('click', () => {
    void handleLegacyMigration('merge');
  });
  byId<HTMLButtonElement>('btnEmptyMigrateNow')?.addEventListener('click', () => {
    void handleLegacyMigration('merge');
  });
  byId<HTMLButtonElement>('btnMigrateReplace')?.addEventListener('click', () => {
    const confirmBox = byId<HTMLDivElement>('replaceConfirmBox');
    if (confirmBox) confirmBox.style.display = 'flex';
  });
  byId<HTMLButtonElement>('btnCancelReplace')?.addEventListener('click', () => {
    const confirmBox = byId<HTMLDivElement>('replaceConfirmBox');
    if (confirmBox) confirmBox.style.display = 'none';
  });
  byId<HTMLButtonElement>('btnConfirmReplace')?.addEventListener('click', async () => {
    const confirmBox = byId<HTMLDivElement>('replaceConfirmBox');
    if (confirmBox) confirmBox.style.display = 'none';
    await handleLegacyMigration('replace');
  });

  byId<HTMLButtonElement>('btnImportJsonToSet')?.addEventListener('click', () => {
    byId<HTMLInputElement>('importJsonFileInput')?.click();
  });
  byId<HTMLInputElement>('importJsonFileInput')?.addEventListener('change', (e) => {
    void handleImportJsonFileIntoSet(e.target as HTMLInputElement);
  });
  byId<HTMLButtonElement>('btnExportSetJson')?.addEventListener('click', handleDownloadCurrentSetJson);

  byId<HTMLButtonElement>('btnToggleMigrationPanel')?.addEventListener('click', () => {
    const body = byId<HTMLDivElement>('migrationPanelBody');
    if (!body) return;
    body.style.display = body.style.display === 'none' ? 'flex' : 'none';
  });
}

window.addEventListener('DOMContentLoaded', () => {
  initThemeSwitcher();
  wireEventListeners();
  void consumeAuthRedirectResult().catch((err) => {
    const msg = err instanceof Error ? err.message : 'Sign-in redirect failed.';
    showToast(msg, 'error');
  });
  subscribeAuth(async (user) => {
    currentUser = user;
    isAdmin = await checkIsAdminUser(user);
    renderAuthGate();
  });
});

window.addEventListener('beforeunload', () => {
  if (unsubscribeSets) unsubscribeSets();
  if (unsubscribeTracks) unsubscribeTracks();
  stopAudioPreview();
});
