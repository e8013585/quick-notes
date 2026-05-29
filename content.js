/**
 * content.js
 * ─────────────────────────────────────────────────────────────
 * Quick Notes — Content Script
 * Handles: note creation, rendering, drag, resize, storage,
 * visibility toggle, and message handling from popup.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   Constants & Config
═══════════════════════════════════════════════════════════════ */

const STORAGE_KEY_NOTES      = 'qn_notes';
const STORAGE_KEY_VISIBILITY = 'qn_visibility';
const SAVE_DEBOUNCE_MS       = 400;
const NOTE_MIN_W             = 160;
const NOTE_MIN_H             = 100;

/** Color map: name → swatch class */
const COLOR_DEFS = {
  yellow : { swatchClass: 'qn-swatch-yellow' },
  blue   : { swatchClass: 'qn-swatch-blue'   },
  green  : { swatchClass: 'qn-swatch-green'  },
  pink   : { swatchClass: 'qn-swatch-pink'   },
  purple : { swatchClass: 'qn-swatch-purple' },
};

const COLOR_MSG_KEYS = {
  yellow: 'colorYellow',
  blue:   'colorBlue',
  green:  'colorGreen',
  pink:   'colorPink',
  purple: 'colorPurple',
};

const COLORS_ORDER = ['yellow', 'blue', 'green', 'pink', 'purple'];

function t(msgKey) {
  return chrome.i18n.getMessage(msgKey);
}

/* ═══════════════════════════════════════════════════════════════
   State
═══════════════════════════════════════════════════════════════ */

/** @type {Map<string, NoteData>} */
let notesMap = new Map();

/** Current page key used for storage partitioning */
const PAGE_KEY = location.href;

/** Whether notes are globally visible */
let notesVisible = true;

/** Debounce timer handle */
let saveTimer = null;

/* ═══════════════════════════════════════════════════════════════
   Data Structures
═══════════════════════════════════════════════════════════════ */

/**
 * @typedef {Object} NoteData
 * @property {string}  id      - Unique ID
 * @property {number}  x       - Left position (px, fixed)
 * @property {number}  y       - Top position (px, fixed)
 * @property {number}  w       - Width (px)
 * @property {number}  h       - Height (px)
 * @property {string}  color   - Color key
 * @property {string}  text    - Note content (plain text)
 * @property {number}  zIndex  - Stacking order
 */

let topZ = 2147483640;

function nextZ() {
  return ++topZ;
}

/* ═══════════════════════════════════════════════════════════════
   Storage Helpers
═══════════════════════════════════════════════════════════════ */

/** Load all notes for this URL from chrome.storage.local */
async function loadNotes() {
  return new Promise(resolve => {
    chrome.storage.local.get([STORAGE_KEY_NOTES, STORAGE_KEY_VISIBILITY], result => {
      const allNotes = result[STORAGE_KEY_NOTES] || {};
      const pageNotes = allNotes[PAGE_KEY] || [];

      notesMap.clear();
      pageNotes.forEach(note => notesMap.set(note.id, note));

      // Visibility: default true
      notesVisible = result[STORAGE_KEY_VISIBILITY]?.[PAGE_KEY] ?? true;

      resolve();
    });
  });
}

/** Persist current note state to storage (debounced) */
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNotes, SAVE_DEBOUNCE_MS);
}

function saveNotes() {
  chrome.storage.local.get(STORAGE_KEY_NOTES, result => {
    const allNotes = result[STORAGE_KEY_NOTES] || {};
    allNotes[PAGE_KEY] = [...notesMap.values()];
    chrome.storage.local.set({ [STORAGE_KEY_NOTES]: allNotes });
  });
}

/** Persist visibility state */
function saveVisibility() {
  chrome.storage.local.get(STORAGE_KEY_VISIBILITY, result => {
    const allVis = result[STORAGE_KEY_VISIBILITY] || {};
    allVis[PAGE_KEY] = notesVisible;
    chrome.storage.local.set({ [STORAGE_KEY_VISIBILITY]: allVis });
  });
}

/* ═══════════════════════════════════════════════════════════════
   Note Factory
═══════════════════════════════════════════════════════════════ */

/**
 * Create a new note data object with sensible defaults.
 * @param {Partial<NoteData>} overrides
 * @returns {NoteData}
 */
function createNoteData(overrides = {}) {
  const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `qn-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Spawn near centre of viewport with a little randomness
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = 240;
  const h = 200;
  const x = Math.max(20, Math.min(vw - w - 20, Math.round(vw / 2 - w / 2 + (Math.random() - 0.5) * 160)));
  const y = Math.max(20, Math.min(vh - h - 20, Math.round(vh / 2 - h / 2 + (Math.random() - 0.5) * 120)));

  return {
    id,
    x,
    y,
    w,
    h,
    color : 'yellow',
    text  : '',
    zIndex: nextZ(),
    ...overrides
  };
}

/* ═══════════════════════════════════════════════════════════════
   DOM Builder
═══════════════════════════════════════════════════════════════ */

/**
 * Build and return the DOM element for a note.
 * Does NOT inject it into the DOM.
 * @param {NoteData} data
 * @returns {HTMLElement}
 */
function buildNoteElement(data) {
  /* ── Outer wrapper ─────────────────────────────────────────── */
  const note = document.createElement('div');
  note.className = `qn-note qn-color-${data.color} ${notesVisible ? 'qn-visible' : 'qn-hidden'}`;
  note.dataset.id = data.id;
  note.style.cssText = `
    left: ${data.x}px;
    top: ${data.y}px;
    width: ${data.w}px;
    height: ${data.h}px;
    z-index: ${data.zIndex};
  `;
  note.setAttribute('role', 'note');
  note.setAttribute('aria-label', t('stickyNoteAriaLabel'));

  /* ── Header ────────────────────────────────────────────────── */
  const header = document.createElement('div');
  header.className = 'qn-header';
  header.setAttribute('title', t('dragToMoveTitle'));

  // Color swatches
  const swatchesEl = document.createElement('div');
  swatchesEl.className = 'qn-color-swatches';

  COLORS_ORDER.forEach(colorKey => {
    const sw = document.createElement('button');
    sw.className = `qn-swatch qn-swatch-${colorKey}${colorKey === data.color ? ' qn-swatch-active' : ''}`;
    sw.setAttribute('title', t(COLOR_MSG_KEYS[colorKey]));
    sw.setAttribute('aria-label', t(COLOR_MSG_KEYS[colorKey]));
    sw.dataset.color = colorKey;

    sw.addEventListener('click', e => {
      e.stopPropagation();
      changeNoteColor(data.id, colorKey);
    });
    swatchesEl.appendChild(sw);
  });

  // Delete button
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'qn-delete-btn';
  deleteBtn.setAttribute('title', t('deleteNoteTitle'));
  deleteBtn.setAttribute('aria-label', t('deleteNoteTitle'));
  deleteBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"
         viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>`;

  deleteBtn.addEventListener('click', e => {
    e.stopPropagation();
    deleteNote(data.id);
  });

  header.appendChild(swatchesEl);
  header.appendChild(deleteBtn);

  /* ── Body ──────────────────────────────────────────────────── */
  const body = document.createElement('div');
  body.className = 'qn-body';
  body.contentEditable = 'true';
  body.spellcheck = true;
  body.dataset.placeholder = t('notePlaceholder');
  body.setAttribute('aria-label', t('noteTextAriaLabel'));
  body.setAttribute('aria-multiline', 'true');

  // Set initial text content
  if (data.text) {
    body.textContent = data.text;
  }

  // Save on input
  body.addEventListener('input', () => {
    data.text = body.textContent;
    scheduleSave();
  });

  // Prevent drag from firing when user clicks into body
  body.addEventListener('mousedown', e => e.stopPropagation());
  body.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });

  /* ── Resize Handle ─────────────────────────────────────────── */
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'qn-resize-handle';
  resizeHandle.setAttribute('title', t('resizeNoteTitle'));
  resizeHandle.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"
         viewBox="0 0 10 10">
      <path d="M9 1 L1 9 M9 5 L5 9 M9 9 L9 9" 
            stroke="currentColor" stroke-width="1.5" 
            stroke-linecap="round" opacity="0.6"/>
    </svg>`;

  /* ── Assemble ──────────────────────────────────────────────── */
  note.appendChild(header);
  note.appendChild(body);
  note.appendChild(resizeHandle);

  /* ── Interaction setup ─────────────────────────────────────── */
  setupDrag(note, header, data);
  setupResize(note, resizeHandle, data);
  setupBringToFront(note, data);

  return note;
}

/* ═══════════════════════════════════════════════════════════════
   Drag Interaction
═══════════════════════════════════════════════════════════════ */

/**
 * Attach mouse & touch drag behaviour to a note's header.
 * @param {HTMLElement} noteEl
 * @param {HTMLElement} handleEl  - The drag handle (header)
 * @param {NoteData}    data
 */
function setupDrag(noteEl, handleEl, data) {
  let startX, startY, startLeft, startTop, isDragging = false;

  function onDragStart(e) {
    // Ignore right-click
    if (e.button !== undefined && e.button !== 0) return;

    isDragging = false;

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    startX    = clientX;
    startY    = clientY;
    startLeft = data.x;
    startTop  = data.y;

    bringToFront(noteEl, data);

    document.addEventListener('mousemove', onDragMove, { passive: true });
    document.addEventListener('mouseup',   onDragEnd);
    document.addEventListener('touchmove', onDragMove, { passive: true });
    document.addEventListener('touchend',  onDragEnd);

    // Prevent text selection during drag
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
  }

  function onDragMove(e) {
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const dx = clientX - startX;
    const dy = clientY - startY;

    // Only mark as dragging after 4px threshold
    if (!isDragging && Math.hypot(dx, dy) > 4) {
      isDragging = true;
      noteEl.classList.add('qn-dragging');
    }

    if (!isDragging) return;

    // Clamp within viewport
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w  = noteEl.offsetWidth;
    const h  = noteEl.offsetHeight;

    const newLeft = Math.max(0, Math.min(vw - w, startLeft + dx));
    const newTop  = Math.max(0, Math.min(vh - 40, startTop + dy));

    noteEl.style.left = `${newLeft}px`;
    noteEl.style.top  = `${newTop}px`;

    data.x = newLeft;
    data.y = newTop;
  }

  function onDragEnd() {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup',   onDragEnd);
    document.removeEventListener('touchmove', onDragMove);
    document.removeEventListener('touchend',  onDragEnd);

    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';

    noteEl.classList.remove('qn-dragging');

    if (isDragging) {
      scheduleSave();
    }
    isDragging = false;
  }

  handleEl.addEventListener('mousedown',  onDragStart);
  handleEl.addEventListener('touchstart', onDragStart, { passive: true });
}

/* ═══════════════════════════════════════════════════════════════
   Resize Interaction
═══════════════════════════════════════════════════════════════ */

/**
 * Attach resize behaviour to the bottom-right corner handle.
 * @param {HTMLElement} noteEl
 * @param {HTMLElement} handleEl
 * @param {NoteData}    data
 */
function setupResize(noteEl, handleEl, data) {
  let startX, startY, startW, startH;

  function onResizeStart(e) {
    e.stopPropagation();
    e.preventDefault();

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    startX = clientX;
    startY = clientY;
    startW = noteEl.offsetWidth;
    startH = noteEl.offsetHeight;

    bringToFront(noteEl, data);

    document.addEventListener('mousemove', onResizeMove, { passive: true });
    document.addEventListener('mouseup',   onResizeEnd);
    document.addEventListener('touchmove', onResizeMove, { passive: false });
    document.addEventListener('touchend',  onResizeEnd);

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'nwse-resize';
  }

  function onResizeMove(e) {
    if (e.cancelable) e.preventDefault();

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const newW = Math.max(NOTE_MIN_W, startW + (clientX - startX));
    const newH = Math.max(NOTE_MIN_H, startH + (clientY - startY));

    noteEl.style.width  = `${newW}px`;
    noteEl.style.height = `${newH}px`;

    data.w = newW;
    data.h = newH;
  }

  function onResizeEnd() {
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup',   onResizeEnd);
    document.removeEventListener('touchmove', onResizeMove);
    document.removeEventListener('touchend',  onResizeEnd);

    document.body.style.userSelect = '';
    document.body.style.cursor = '';

    scheduleSave();
  }

  handleEl.addEventListener('mousedown',  onResizeStart);
  handleEl.addEventListener('touchstart', onResizeStart, { passive: false });
}

/* ═══════════════════════════════════════════════════════════════
   Z-Index Management
═══════════════════════════════════════════════════════════════ */

function bringToFront(noteEl, data) {
  const z = nextZ();
  noteEl.style.zIndex = z;
  data.zIndex = z;
}

function setupBringToFront(noteEl, data) {
  noteEl.addEventListener('mousedown', () => bringToFront(noteEl, data));
  noteEl.addEventListener('touchstart', () => bringToFront(noteEl, data), { passive: true });
}

/* ═══════════════════════════════════════════════════════════════
   Note Lifecycle
═══════════════════════════════════════════════════════════════ */

/**
 * Create a brand-new note, add to DOM and storage.
 * @param {string} color
 * @returns {NoteData}
 */
function addNote(color = 'yellow') {
  const data = createNoteData({ color });
  notesMap.set(data.id, data);

  const el = buildNoteElement(data);
  el.classList.add('qn-note-entering');
  document.body.appendChild(el);

  // Remove entering class after animation
  setTimeout(() => el.classList.remove('qn-note-entering'), 300);

  // If notes are hidden, immediately hide the new one too
  if (!notesVisible) {
    el.classList.remove('qn-visible');
    el.classList.add('qn-hidden');
  }

  scheduleSave();
  return data;
}

/**
 * Remove a note from DOM and storage.
 * @param {string} id
 */
function deleteNote(id) {
  const el = document.querySelector(`.qn-note[data-id="${id}"]`);
  if (el) {
    el.classList.add('qn-note-leaving');
    setTimeout(() => el.remove(), 200);
  }
  notesMap.delete(id);
  scheduleSave();
}

/**
 * Change a note's color.
 * @param {string} id
 * @param {string} newColor
 */
function changeNoteColor(id, newColor) {
  const data = notesMap.get(id);
  if (!data) return;

  data.color = newColor;

  const el = document.querySelector(`.qn-note[data-id="${id}"]`);
  if (el) {
    // Remove all color classes and add new one
    COLORS_ORDER.forEach(c => el.classList.remove(`qn-color-${c}`));
    el.classList.add(`qn-color-${newColor}`);

    // Update swatch active state
    el.querySelectorAll('.qn-swatch').forEach(sw => {
      sw.classList.toggle('qn-swatch-active', sw.dataset.color === newColor);
    });
  }

  scheduleSave();
}

/* ═══════════════════════════════════════════════════════════════
   Visibility Toggle
═══════════════════════════════════════════════════════════════ */

/**
 * Show or hide all notes on the page.
 * @param {boolean} visible
 */
function setNotesVisibility(visible) {
  notesVisible = visible;
  document.querySelectorAll('.qn-note').forEach(el => {
    if (visible) {
      el.classList.remove('qn-hidden');
      el.classList.add('qn-visible');
    } else {
      el.classList.remove('qn-visible');
      el.classList.add('qn-hidden');
    }
  });
  saveVisibility();
}

/* ═══════════════════════════════════════════════════════════════
   Render All Saved Notes
═══════════════════════════════════════════════════════════════ */

function renderAllNotes() {
  // Remove any existing note elements first (avoid duplicates on re-init)
  document.querySelectorAll('.qn-note').forEach(el => el.remove());

  notesMap.forEach(data => {
    // Recompute topZ to be above all existing notes
    if (data.zIndex >= topZ) topZ = data.zIndex;

    const el = buildNoteElement(data);
    document.body.appendChild(el);
  });

  // Apply current visibility state
  setNotesVisibility(notesVisible);
}

/* ═══════════════════════════════════════════════════════════════
   Message Handler (from popup)
═══════════════════════════════════════════════════════════════ */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.action) {

    case 'createNote': {
      const data = addNote(message.color || 'yellow');
      sendResponse({ success: true, id: data.id, count: notesMap.size });
      break;
    }

    case 'setVisibility': {
      setNotesVisibility(!!message.visible);
      sendResponse({ success: true, visible: notesVisible });
      break;
    }

    case 'getVisibility': {
      sendResponse({ visible: notesVisible });
      break;
    }

    case 'getNoteCount': {
      sendResponse({ count: notesMap.size });
      break;
    }

    default:
      sendResponse({ error: 'Unknown action' });
  }

  // Return true to allow async sendResponse (required even if sync here)
  return true;
});

/* ═══════════════════════════════════════════════════════════════
   Initialization
═══════════════════════════════════════════════════════════════ */

/**
 * Guard against running multiple times if the content script
 * is somehow injected more than once.
 */
if (!window.__quickNotesInitialized) {
  window.__quickNotesInitialized = true;

  async function init() {
    await loadNotes();
    renderAllNotes();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}