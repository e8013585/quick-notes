/**
 * popup.js
 * Handles all popup UI interactions and communicates
 * with the content script via chrome.tabs.sendMessage.
 */

'use strict';

/* ─── Localization ────────────────────────────────────────────── */
function localizePage() {
  const pattern = /__MSG_(\w+)__/g;
  function walk(node) {
    if (node.nodeType === 3) {
      node.textContent = node.textContent.replace(pattern, (_, key) => chrome.i18n.getMessage(key) || '');
    } else if (node.nodeType === 1 && node.nodeName !== 'SCRIPT') {
      for (const attr of node.attributes) {
        if (attr.value && attr.value.includes('__MSG_')) {
          attr.value = attr.value.replace(pattern, (_, key) => chrome.i18n.getMessage(key) || '');
        }
      }
      for (const child of node.childNodes) walk(child);
    }
  }
  walk(document.body);
}

/* ─── State ──────────────────────────────────────────────────── */
let selectedColor = 'yellow';
let currentTabId = null;

/* ─── DOM References ─────────────────────────────────────────── */
const newNoteBtn       = document.getElementById('newNoteBtn');
const visibilityToggle = document.getElementById('visibilityToggle');
const noteCountBadge   = document.getElementById('noteCount');
const colorSwatches    = document.querySelectorAll('.swatch');
const errorBanner      = document.getElementById('popupError');

/* ─── Helpers ────────────────────────────────────────────────── */

/**
 * Send a message to the content script on the active tab.
 * Returns a Promise that resolves with the response (or null on error).
 */
async function sendToContent(message) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    currentTabId = tab.id;

    // Inject content script if not already present (handles edge cases
    // like extension reload or pages opened before extension install)
    try {
      const response = await chrome.tabs.sendMessage(tab.id, message);
      return response;
    } catch (err) {
      // Content script not ready — try injecting it first
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content.css']
      });
      // Retry after a short delay
      await new Promise(r => setTimeout(r, 150));
      return await chrome.tabs.sendMessage(tab.id, message);
    }
  } catch (err) {
    console.warn('Quick Notes: Could not send message to content script.', err);
    showError();
    return null;
  }
}

/** Show the error banner and disable interactive elements */
function showError() {
  errorBanner.hidden = false;
  newNoteBtn.disabled = true;
  visibilityToggle.disabled = true;
  colorSwatches.forEach(s => s.style.pointerEvents = 'none');
}

/** Update the note count badge from content script */
async function refreshNoteCount() {
  const response = await sendToContent({ action: 'getNoteCount' });
  if (response !== null && typeof response.count === 'number') {
    noteCountBadge.textContent = response.count;
  }
}

/** Load the persisted visibility state for this tab's URL */
async function loadVisibilityState() {
  const response = await sendToContent({ action: 'getVisibility' });
  if (response !== null && typeof response.visible === 'boolean') {
    visibilityToggle.checked = response.visible;
  }
}

/* ─── Event Listeners ────────────────────────────────────────── */

/** New Note button */
newNoteBtn.addEventListener('click', async () => {
  newNoteBtn.disabled = true;

  const response = await sendToContent({
    action: 'createNote',
    color: selectedColor
  });

  if (response?.success) {
    noteCountBadge.textContent = response.count;
    // Brief feedback then close popup
    setTimeout(() => window.close(), 120);
  } else {
    newNoteBtn.disabled = false;
  }
});

/** Visibility toggle */
visibilityToggle.addEventListener('change', async () => {
  const visible = visibilityToggle.checked;
  await sendToContent({ action: 'setVisibility', visible });
});

/** Color swatches */
colorSwatches.forEach(swatch => {
  swatch.addEventListener('click', () => {
    colorSwatches.forEach(s => s.classList.remove('active'));
    swatch.classList.add('active');
    selectedColor = swatch.dataset.color;

    // Persist selected color preference
    chrome.storage.local.set({ preferredColor: selectedColor });
  });
});

/* ─── Initialization ─────────────────────────────────────────── */

async function init() {
  localizePage();
  // Restore preferred color
  const stored = await chrome.storage.local.get('preferredColor');
  if (stored.preferredColor) {
    selectedColor = stored.preferredColor;
    colorSwatches.forEach(s => {
      s.classList.toggle('active', s.dataset.color === selectedColor);
    });
  }

  // Load state from content script
  await loadVisibilityState();
  await refreshNoteCount();
}

init();