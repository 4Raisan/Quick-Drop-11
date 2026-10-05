/**
 * Temp-Transfer - Community Synchronized Text Transfer
 * Real-time community shared clipboard with 11-hour auto-clear
 */

(function () {
  'use strict';

  // --- Constants & Config ---
  const STORAGE_KEY = 'temptransfer_shared_cache';
  const OUTBOX_KEY = 'temptransfer_shared_outbox';
  const THEME_KEY = 'temptransfer_theme';
  // Preserve device-local state from the previous app name.
  
  const EXPIRATION_MS = 11 * 60 * 60 * 1000; // Exactly 11 hours

  // --- DOM Elements ---
  const textInput = document.getElementById('textInput');
  const textStats = document.getElementById('textStats');
  const addBtn = document.getElementById('addBtn');
  const clearInputBtn = document.getElementById('clearInputBtn');
  const pasteBtn = document.getElementById('pasteBtn');
  const textList = document.getElementById('textList');
  const emptyState = document.getElementById('emptyState');
  const textCountBadge = document.getElementById('textCountBadge');
  const sectionActions = document.getElementById('sectionActions');
  const searchInput = document.getElementById('searchInput');
  const clearAllBtn = document.getElementById('clearAllBtn');
  const themeToggle = document.getElementById('themeToggle');
  const toastContainer = document.getElementById('toastContainer');
  const qrModal = document.getElementById('qrModal');
  const qrContainer = document.getElementById('qrContainer');
  const closeModalBtn = document.getElementById('closeModalBtn');
  const fileInput = document.getElementById('fileInput');
  const fileHint = document.getElementById('fileHint');
  let selectedAttachment = null;
  const dropZone = document.getElementById('dropZone');

  let storageMode = null;
  let currentSearchQuery = '';
  let communityTexts = [];
  let isFetching = false;
  let isWriting = false; // Tracks if a POST/DELETE is in flight
  let pollIntervalId = null;
  let clockOffset = 0; // serverTime - clientTime offset

  // Sequential upload queue to handle rapid fast pasting without race conditions
  const uploadQueue = [];
  let mutationVersion = 0;
  let qrReturnFocus = null;
  let transferShown = false;

  function saveOutbox() {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(uploadQueue));
  }

  async function apiFetch(url, options = {}) {
    return fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  }

  function setConnection(message) {
    const badge = document.querySelector('.live-text');
    if (badge) badge.textContent = message;
  }
  let isProcessingQueue = false;
  const pendingOptimisticItems = new Map(); // tempId -> item

  // --- Local Cache Helpers ---
  function getCachedTexts() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || (localStorage.getItem('temptransfer_community_cache'));
      if (!raw) return [];
      const list = JSON.parse(raw);
      return Array.isArray(list) ? purgeExpired(list) : [];
    } catch (e) {
      return [];
    }
  }

  function setCachedTexts(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (e) {}
  }

  function purgeExpired(list) {
    const now = Date.now() + clockOffset;
    return list.filter(item => {
      const expires = item.expiresAt || (item.createdAt + EXPIRATION_MS);
      return expires > now;
    });
  }

  // Merges server-authoritative texts with any still-pending optimistic items
  function mergeServerTexts(serverTexts) {
    const valid = purgeExpired(serverTexts || []);

    // Build unified list: unconfirmed pending items first, then server items
    const stillPending = Array.from(pendingOptimisticItems.values());
    const combined = [...stillPending];
    for (const item of valid) {
      if (!combined.some(c => c.id === item.id)) {
        combined.push(item);
      }
    }

    const hasChanged = JSON.stringify(combined) !== JSON.stringify(communityTexts);
    if (hasChanged) {
      communityTexts = combined;
      setCachedTexts(communityTexts);
      renderTexts();
    }
  }

  // --- Community API Sync ---

  async function fetchCommunityTexts(silent = true) {
    if (isFetching || isWriting || isProcessingQueue) return; // Don't poll while uploads are in flight
    isFetching = true;
    const version = mutationVersion;
    const query = currentSearchQuery;
    try {
      const res = await apiFetch(`/api/texts?q=${encodeURIComponent(query)}&id=${encodeURIComponent(new URLSearchParams(location.hash.slice(1)).get('text') || '')}&_t=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (res.ok && version === mutationVersion && query === currentSearchQuery) {
        const data = await res.json();
        if (data && Array.isArray(data.texts)) {
          if (data.serverTime) {
            clockOffset = data.serverTime - Date.now();
          }
          storageMode = data.mode; mergeServerTexts(data.texts);
          setConnection(data.mode === 'local' ? 'Local preview' : 'Connected');
          const transferId = new URLSearchParams(location.hash.slice(1)).get('text');
          if (transferId && !transferShown) {
            transferShown = true;
            const item = data.texts.find(t => t.id === transferId);
            if (item) { textInput.value = item.text; updateInputStats(); textInput.focus(); showToast(item.file ? 'Transfer found — use the file link to download' : 'Transfer found — use Copy to copy the text', 'success'); }
            else showToast('This snippet has expired or was deleted', 'warning');
          }
        }
      } else if (!res.ok) { setConnection('Connection unavailable'); }
    } catch (err) {
      setConnection('Offline — uploads will retry');
      if (!silent) console.warn('Could not reach community server:', err.message);
    } finally {
      isFetching = false;
      if (query !== currentSearchQuery) fetchCommunityTexts(true);
    }
  }

  function queueNewText(content, file = null) {
    const now = Date.now();
    const requestId = crypto.randomUUID();
    const tempId = 'temp_' + requestId;
    const optimisticItem = {
      id: tempId,
      text: content,
      createdAt: now,
      expiresAt: now + EXPIRATION_MS,
      isPending: true,
      file: file ? { name: file.name, type: file.type, size: Math.floor(file.base64.length * 3 / 4) } : undefined
    };

    // Add to optimistic map and UI immediately
    pendingOptimisticItems.set(tempId, optimisticItem);
    communityTexts.unshift(optimisticItem);
    renderTexts();
    showToast('Adding to the shared feed...', 'success');

    // Enqueue task for sequential upload
    uploadQueue.push({ tempId, content, requestId, createdAt: now, file });
    try { saveOutbox(); } catch (err) {
      uploadQueue.pop(); pendingOptimisticItems.delete(tempId);
      communityTexts = communityTexts.filter(t => t.id !== tempId); renderTexts();
      showToast('Device storage is full; transfer was not queued. Keep the input or select a smaller file.', 'danger');
      return false;
    }
    processUploadQueue();
    return true;
  }

  async function processUploadQueue() {
    if (isProcessingQueue || isWriting || !uploadQueue.length) return;
    isProcessingQueue = true;
    isWriting = true;
    mutationVersion++;
    try {
      while (uploadQueue.length) {
        const task = uploadQueue[0];
        try {
          if (task.file && !storageMode && window.transferUploads) { const modeResponse = await apiFetch('/api/stats'); if (!modeResponse.ok) throw new Error('Storage unavailable'); storageMode = (await modeResponse.json()).mode; }
          const res = task.file && storageMode === 'community' && window.transferUploads ? await window.transferUploads.share(task) : await apiFetch('/api/texts', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: task.content, requestId: task.requestId, file: task.file })
          });
          const data = await res.json();
          if (res.status >= 500 || res.status === 429) throw new Error(data.error || 'Server unavailable');
          if (!res.ok) {
            textInput.value = task.content; updateInputStats();
            showToast(data.error || 'Upload rejected — text restored to input', 'danger');
          } else {
            communityTexts = communityTexts.filter(t => t.id !== task.tempId && t.id !== data.item.id);
            communityTexts.unshift(data.item);
            showToast('Shared — ID ' + data.item.id, 'success');
          }
          uploadQueue.splice(uploadQueue.indexOf(task), 1);
          pendingOptimisticItems.delete(task.tempId);
          communityTexts = communityTexts.filter(t => t.id !== task.tempId);
          saveOutbox(); setCachedTexts(communityTexts); renderTexts();
        } catch (err) {
          setConnection('Waiting to reconnect');
          showToast('Upload pending on this device; retrying when connected', 'warning');
          break;
        }
      }
    } finally {
      isWriting = false;
      isProcessingQueue = false;
    }
    fetchCommunityTexts(true);
  }

  async function deleteTextItem(id) {
    if (isWriting) { showToast('Please wait for the current operation', 'warning'); return false; }
    if (id.startsWith('temp_')) {
      const index = uploadQueue.findIndex(t => t.tempId === id);
      if (index !== -1) uploadQueue.splice(index, 1);
      pendingOptimisticItems.delete(id); saveOutbox();
      communityTexts = communityTexts.filter(t => t.id !== id);
      setCachedTexts(communityTexts); renderTexts(); return true;
    }
    isWriting = true;
    mutationVersion++;
    try {
      const res = await apiFetch(`/api/texts?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      communityTexts = communityTexts.filter(t => t.id !== id);
      setCachedTexts(communityTexts); renderTexts();
      return true;
    } catch (err) {
      showToast('Delete failed — text was kept', 'danger'); return false;
    } finally { isWriting = false; }
  }

  async function clearAllTexts() {
    if (isWriting || !communityTexts.length) return;
    if (!confirm('Delete all visible snippets from the shared feed?')) return;
    const ids = communityTexts.map(t => t.id);
    let deleted = 0;
    for (const id of ids) { if (await deleteTextItem(id)) deleted++; }
    showToast(`Deleted ${deleted} of ${ids.length} snippets`, deleted === ids.length ? 'success' : 'warning');
    await fetchCommunityTexts(true);
  }

  // --- UI Helpers ---

  function escapeHtml(str) {
    // Escape all HTML-significant characters including quotes
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function linkify(str) {
    const escaped = escapeHtml(str);
    // Match URLs but exclude trailing punctuation and quotes
    const urlPattern = /(https?:\/\/[^\s<>&"']+)/g;
    return escaped.replace(urlPattern, function(url) {
      // Sanitize: only allow http/https URLs
      if (!/^https?:\/\//i.test(url)) return url;
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
    });
  }

  function formatTimeRemaining(ms) {
    if (ms <= 0) return 'Expired';
    const totalSecs = Math.floor(ms / 1000);
    const hours = Math.floor(totalSecs / 3600);
    const minutes = Math.floor((totalSecs % 3600) / 60);
    const seconds = totalSecs % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m left`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s left`;
    } else {
      return `${seconds}s left`;
    }
  }

  function getExpiryStatusClass(ms) {
    const oneHour = 60 * 60 * 1000;
    const sixHours = 6 * oneHour;
    if (ms > sixHours) return 'expiry-safe';
    if (ms > oneHour) return 'expiry-warning';
    return 'expiry-danger';
  }

  function formatRelativeTime(timestamp) {
    const diff = (Date.now() + clockOffset) - timestamp;
    const sec = Math.floor(diff / 1000);
    if (sec < 45) return 'Just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hours = Math.floor(min / 60);
    return `${hours}h ago`;
  }

  function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let iconSvg = '';
    if (type === 'success') {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--success-color)"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else if (type === 'warning') {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--warning-color)"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
    } else {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--danger-color)"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    }

    toast.innerHTML = `${iconSvg}<span>${escapeHtml(message)}</span>`;
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.25s ease';
      setTimeout(() => toast.remove(), 250);
    }, 2800);
  }

  // --- Copy Directly to Clipboard ---
  function copyTextToClipboard(text, btnElement) {
    if (!text) return;

    const onSuccess = () => {
      showToast('Copied to clipboard!', 'success');
      if (btnElement) {
        const originalHtml = btnElement.innerHTML;
        btnElement.classList.add('copied');
        btnElement.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          Copied!
        `;

        setTimeout(() => {
          btnElement.classList.remove('copied');
          btnElement.innerHTML = originalHtml;
        }, 2000);
      }
    };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(onSuccess).catch(() => {
        fallbackCopy(text, onSuccess);
      });
    } else {
      fallbackCopy(text, onSuccess);
    }
  }

  function fallbackCopy(text, onSuccess) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '0';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);

    // iOS Safari requires specific selection approach
    if (navigator.userAgent.match(/ipad|ipod|iphone/i)) {
      textArea.contentEditable = true;
      textArea.readOnly = false;
      const range = document.createRange();
      range.selectNodeContents(textArea);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      textArea.setSelectionRange(0, 999999);
    } else {
      textArea.focus();
      textArea.select();
    }

    try {
      if (!document.execCommand('copy')) throw new Error('Copy denied');
      onSuccess();
    } catch (err) {
      showToast('Unable to copy text directly', 'danger');
    }
    document.body.removeChild(textArea);
  }

  // --- Add Text Button ---
  async function handleAddText() {
    if (addBtn.disabled) return;
    const raw = textInput.value;
    const content = raw.trim();

    if (!content && !selectedAttachment) {
      showToast('Please type or paste some text first', 'danger');
      textInput.focus();
      return;
    }

    if (content.length > 10000) {
      showToast('Text too long (max 10,000 characters)', 'danger');
      return;
    }

    let file = null;
    if (selectedAttachment) {
      const selected = selectedAttachment;
      if (selected.size > 5 * 1024 * 1024 || !['image/png','image/jpeg','image/webp','application/pdf'].includes(selected.type)) {
        showToast('Choose a PNG, JPEG, WebP or PDF up to 5 MB', 'danger'); return;
      }
      addBtn.disabled = true;
      try {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = reject; reader.readAsDataURL(selected);
        });
        file = { name: selected.name, type: selected.type, base64 };
      } catch { showToast('Could not read this file', 'danger'); return; }
      finally { addBtn.disabled = false; }
    }
    if (!queueNewText(content, file)) return;
    clearAttachment();

    // Clear input box
    textInput.value = '';
    updateInputStats();
    textInput.focus();
  }

  // --- Clear Input Box Button ---
  function handleClearInput() {
    if (!textInput.value && !selectedAttachment) return;
    textInput.value = '';
    clearAttachment();
    updateInputStats();
    showToast('Input box cleared', 'success');
    textInput.focus();
  }

  // --- Update Statistics ---
  function updateInputStats() {
    const val = textInput.value;
    const charCount = val.length;
    const lines = val ? val.split('\n').length : 0;
    textStats.textContent = `${charCount} char${charCount === 1 ? '' : 's'} • ${lines} line${lines === 1 ? '' : 's'}`;
  }

  // --- Render Text Cards ---
  function renderTexts() {
    const valid = purgeExpired(communityTexts);
    const totalCount = valid.length;
    textCountBadge.textContent = totalCount;

    if (totalCount === 0) {
      emptyState.style.display = 'flex';
      textList.innerHTML = '';
      sectionActions.style.display = 'flex';
      return;
    }

    emptyState.style.display = 'none';
    sectionActions.style.display = 'flex';

    let filtered = valid;
    if (currentSearchQuery) {
      const q = currentSearchQuery.toLowerCase();
      filtered = valid.filter(item => (item.id + ' ' + item.text + ' ' + (item.file?.name || '')).toLowerCase().includes(q));
    }

    if (filtered.length === 0) {
      textList.innerHTML = `
        <div class="empty-state" style="padding: 2rem;">
          <p>No transfers match "${escapeHtml(currentSearchQuery)}"</p>
        </div>
      `;
      return;
    }

    const now = Date.now() + clockOffset;
    textList.innerHTML = filtered.map(item => {
      const remainingMs = Math.max(0, item.expiresAt - now);
      const expiryText = formatTimeRemaining(remainingMs);
      const statusClass = getExpiryStatusClass(remainingMs);
      const relativeTime = formatRelativeTime(item.createdAt);
      const exactTime = new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const charCount = item.text.length;
      const lines = item.text ? item.text.split('\n').length : 0;

      const isPending = item.isPending;
      const pendingBadge = isPending 
        ? `<span class="badge" style="background: rgba(59, 130, 246, 0.15); color: #3b82f6; border: 1px solid rgba(59, 130, 246, 0.3); font-size: 0.72rem; padding: 0.1rem 0.5rem; margin-left: 0.4rem;">Syncing...</span>` 
        : '';

      return `
        <article class="text-card compact-card" data-id="${escapeHtml(item.id)}" data-expires="${item.expiresAt}" data-created="${item.createdAt}">
          <div class="compact-heading">
            <div class="share-heading-left"><span class="share-id">${item.isPending ? 'Sending…' : '#' + escapeHtml(item.id)}</span><span class="card-time-text">${relativeTime}</span></div>
            <div class="share-heading-right">
              ${!item.file ? '<button class="btn-copy" data-action="copy" aria-label="Copy this text snippet to clipboard">Copy</button>' : ''}
              <button class="btn-card-action symbol-button" data-action="qr" title="Show QR code" aria-label="Generate QR code for this transfer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><path d="M15 15h3v3h3v3h-6v-3m6-3v-3m-9-9v9H3m9 3v6"/></svg></button>
              <span class="card-expiry-badge ${statusClass}"><span class="countdown-text">${expiryText}</span></span>
              <button class="btn-card-action btn-card-danger symbol-button" data-action="delete" title="Delete share" aria-label="Delete this transfer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></button>
            </div>
          </div>
          <div class="compact-content">
            ${item.file ? renderAttachment(item) : `<div class="card-text">${linkify(item.text)}</div>`}
            ${item.file && item.text ? `<div class="file-caption">${linkify(item.text)}</div>` : ''}
          </div>
        </article>
      `;
    }).join('');
  }

  // --- Real-Time Countdown & Relative Time Update ---
  function updateCountdowns() {
    const cards = textList.querySelectorAll('.text-card');
    const now = Date.now() + clockOffset;
    let hasExpired = false;

    cards.forEach(card => {
      const expiresAt = parseInt(card.getAttribute('data-expires'), 10);
      const createdAt = parseInt(card.getAttribute('data-created'), 10);
      const remainingMs = expiresAt - now;

      if (remainingMs <= 0) {
        hasExpired = true;
      } else {
        const badge = card.querySelector('.card-expiry-badge');
        const textSpan = card.querySelector('.countdown-text');
        if (badge && textSpan) {
          textSpan.textContent = formatTimeRemaining(remainingMs);
          badge.className = `card-expiry-badge ${getExpiryStatusClass(remainingMs)}`;
        }

        // Update relative time ("Added X ago")
        const timeText = card.querySelector('.card-time-text');
        if (timeText && createdAt) {
          const exactTime = new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          timeText.textContent = formatRelativeTime(createdAt);
        }
      }
    });

    if (hasExpired) {
      communityTexts = purgeExpired(communityTexts);
      renderTexts();
    }
  }

  // --- QR Code Modal ---
  function openQrModal(item) {
    if (!qrContainer) return;
    qrContainer.innerHTML = '';

    if (typeof QRCode !== 'undefined') {
      try {
        // Encode to handle multi-byte UTF-8 characters
        if (item.isPending) { showToast('Wait for this snippet to finish saving', 'warning'); return; }
        const safeText = location.origin + '/#text=' + encodeURIComponent(item.id);
        qrReturnFocus = document.activeElement;
        new QRCode(qrContainer, {
          text: safeText,
          width: 200,
          height: 200,
          colorDark: '#0f172a',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.L
        });
        qrModal.classList.add('show');
        qrModal.setAttribute('aria-hidden', 'false');

        // Trap focus in modal
        closeModalBtn.focus();
      } catch (e) {
        showToast('Text too large or complex for QR code', 'danger');
      }
    } else {
      showToast('QR code library not loaded', 'danger');
    }
  }

  function closeQrModal() {
    qrModal.classList.remove('show');
    qrModal.setAttribute('aria-hidden', 'true');
    if (qrReturnFocus && qrReturnFocus.isConnected) qrReturnFocus.focus();
  }

  // --- Event Delegation ---
  textList.addEventListener('click', (e) => {
    const target = e.target.closest('button');
    if (!target) return;

    const action = target.getAttribute('data-action');
    const card = target.closest('.text-card');
    if (!card) return;

    const id = card.getAttribute('data-id');
    const item = communityTexts.find(t => t.id === id);
    if (!item) return;

    if (action === 'copy') {
      copyTextToClipboard(item.text, target);
    } else if (action === 'qr') {
      openQrModal(item);
    } else if (action === 'delete') {
      deleteTextItem(id);
    }
  });

  // --- Input & Keyboard Shortcuts ---
  textInput.addEventListener('input', updateInputStats);

  textInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleAddText();
    }
  });

  addBtn.addEventListener('click', handleAddText);
  clearInputBtn.addEventListener('click', handleClearInput);

  if (pasteBtn) {
    pasteBtn.addEventListener('click', async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          const clipText = await navigator.clipboard.readText();
          if (clipText) {
            textInput.value = clipText;
            updateInputStats();
            showToast('Pasted from clipboard', 'success');
            textInput.focus();
          } else {
            showToast('Clipboard is empty', 'danger');
          }
        } else {
          showToast('Clipboard read not supported', 'danger');
        }
      } catch (err) {
        showToast('Please press Ctrl+V to paste', 'danger');
      }
    });
  }

  let searchTimer;
  searchInput.addEventListener('input', (e) => {
    currentSearchQuery = e.target.value.trim();
    renderTexts();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => fetchCommunityTexts(false), 300);
  });

  clearAllBtn.addEventListener('click', clearAllTexts);

  closeModalBtn.addEventListener('click', closeQrModal);
  qrModal.addEventListener('click', (e) => {
    if (e.target === qrModal) closeQrModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && qrModal.classList.contains('show')) { e.preventDefault(); closeModalBtn.focus(); }
    if (e.key === 'Escape' && qrModal.classList.contains('show')) {
      closeQrModal();
    }
  });

  // --- Theme Toggle ---
  function initTheme() {
    let saved;
    try { saved = localStorage.getItem(THEME_KEY); } catch (err) {}
    if (saved === 'light') {
      document.body.classList.remove('dark-theme');
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.add('dark-theme');
      document.body.classList.remove('light-theme');
    }
  }

  themeToggle.addEventListener('click', () => {
    const isLight = document.body.classList.toggle('light-theme');
    document.body.classList.toggle('dark-theme', !isLight);
    try { localStorage.setItem(THEME_KEY, isLight ? 'light' : 'dark'); } catch (err) {}
  });

  function renderAttachment(item) {
    const file = item.file;
    const name = escapeHtml(file.name);
    if (item.isPending || !file.url) return `<div class="attachment">Attachment pending: ${name}</div>`;
    let safeUrl;
    try {
      const parsed = new URL(file.url, location.origin);
      if (parsed.protocol !== 'https:' && parsed.origin !== location.origin) return '';
      safeUrl = escapeHtml(parsed.href);
    } catch { return ''; }
    const image = file.type.startsWith('image/') ? `<img class="attachment-image" src="${safeUrl}" alt="${name}" loading="lazy">` : '<span class="file-icon">PDF</span>';
    return `<div class="attachment">${image}<a class="attachment-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer" download="${name}">${name} · ${Math.ceil(file.size / 1024)} KB ↗</a></div>`;
  }

  document.getElementById('refreshBtn').addEventListener('click', () => fetchCommunityTexts(false));
  function clearAttachment() {
    selectedAttachment = null;
    fileInput.value = '';
    fileHint.textContent = 'Images or PDF · 5 MB max · Drop a file here';
    document.getElementById('removeFileBtn').hidden = true;
    dropZone.classList.remove('has-attachment');
  }
  function selectAttachment(files) {
    if (addBtn.disabled) { showToast('Wait for the current file to finish reading', 'warning'); return false; }
    if (!files?.length) return false;
    if (files.length !== 1) { showToast('Add one image or PDF per share', 'danger'); return false; }
    const file = files[0];
    if (file.size > 5 * 1024 * 1024 || !['image/png','image/jpeg','image/webp','application/pdf'].includes(file.type)) {
      showToast('Choose a PNG, JPEG, WebP or PDF up to 5 MB', 'danger'); fileInput.value = ''; return false;
    }
    selectedAttachment = file;
    fileHint.textContent = file.name + ' · ' + Math.ceil(file.size / 1024) + ' KB';
    document.getElementById('removeFileBtn').hidden = false;
    dropZone.classList.add('has-attachment');
    return true;
  }
  fileInput.addEventListener('change', () => { if (!fileInput.files?.length) return; selectAttachment(fileInput.files); });
  document.getElementById('removeFileBtn').addEventListener('click', clearAttachment);
  let dragDepth = 0;
  dropZone.addEventListener('dragenter', event => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault(); dragDepth++; dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragover', event => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
  });
  dropZone.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropZone.classList.remove('drag-over'); } });
  dropZone.addEventListener('drop', event => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault(); event.stopPropagation(); dragDepth = 0; dropZone.classList.remove('drag-over');
    selectAttachment(event.dataTransfer.files);
  });
  // Files dropped elsewhere must not replace the page with a local document.
  document.addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); });
  document.addEventListener('drop', event => { if (event.dataTransfer?.files?.length) event.preventDefault(); });
  textInput.addEventListener('paste', event => {
    if (event.clipboardData?.files?.length) { event.preventDefault(); selectAttachment(event.clipboardData.files); }
  });
  // --- Init ---
  initTheme();
  communityTexts = getCachedTexts().filter(t => !t.isPending);
  try {
    const jobs = JSON.parse(localStorage.getItem(OUTBOX_KEY) || (localStorage.getItem('temptransfer_outbox_v2')) || '[]');
    if (Array.isArray(jobs)) for (const task of jobs) {
      if (typeof task.content !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(task.requestId) || !Number.isFinite(task.createdAt)) continue;
      if (Date.now() - task.createdAt >= EXPIRATION_MS) continue;
      uploadQueue.push(task);
      const item = { id: task.tempId, text: task.content, createdAt: task.createdAt, expiresAt: task.createdAt + EXPIRATION_MS, isPending: true, file: task.file ? { name: task.file.name, type: task.file.type } : undefined };
      pendingOptimisticItems.set(task.tempId, item); communityTexts.unshift(item);
    }
  } catch (err) {}
  processUploadQueue();
  window.addEventListener('online', processUploadQueue);
  setInterval(() => { if (navigator.onLine && uploadQueue.length) processUploadQueue(); }, 15000);
  renderTexts();
  updateInputStats();

  // Initial fetch from community backend
  fetchCommunityTexts(false);

  // Expiry countdowns run locally; refresh the feed on demand.
  setInterval(updateCountdowns, 1000);

})();
