const $ = (selector) => document.querySelector(selector);
const icon = (name) => `<svg aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;
const rootId = 'root';
const idPattern = /^(?:root|[a-f0-9-]{36})$/i;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const config = window.FIRESEND_CONFIG || {};
const guestAccount = { id: 'guest', username: 'Guest', role: 'member', anonymous: true };
function loadRenameSplit() {
  try {
    const saved = localStorage.getItem('firesend:rename-split');
    if (saved === 'single') return false;
    if (saved === 'split') return true;
  } catch {
    // Fall back to the default below.
  }
  return true;
}
const state = {
  account: null, folder: null, version: 0, uploading: false, accountReady: false,
  loading: false, preview: null, authMode: config.authMode || 'account',
  passphraseRequired: false, passphraseUnlocked: false,
  ipRegistered: false, ipName: null, ipAddress: null, ipMustChange: false, renameSplit: loadRenameSplit(),
};
const dialog = $('#dialog');
const dialogBody = $('#dialog-body');
const dialogError = $('#dialog-error');
const pageError = $('#page-error');
const previewPanel = $('#preview-panel');
const previewBody = $('#preview-content');
const previewResize = $('#preview-resize');
const contextMenu = $('#context-menu');
let menuTrigger = null;

function showError(element, message = '') {
  element.textContent = message;
  element.hidden = !message;
}

function notice(message) {
  $('#page-status').textContent = message;
}

async function request(path, { method = 'GET', body } = {}) {
  const options = body ? {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : { method };
  const response = await fetch('/api/drive' + path, options);
  if (response.status === 204) return;
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      if (data.passphraseRequired) showPassphraseScreen('Enter the passphrase to continue.');
      else if (data.ipRequired) loadSession().catch(() => {});
      else if (data.signInRequired || state.account) setAccount(null);
    }
    const error = new Error(data.error || 'The request failed.');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function makeButton(text, onClick, className = 'button') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  button.addEventListener('click', onClick);
  return button;
}

function sizeLabel(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

function folderHref(id) {
  return id === rootId ? '/' : `/?folder=${encodeURIComponent(id)}`;
}

function folderLink(id, name) {
  const link = document.createElement('a');
  link.href = folderHref(id);
  link.textContent = name;
  link.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.pushState(null, '', link.href);
    loadFolder(id, { focus: true });
  });
  return link;
}

function currentFolder() {
  const id = new URLSearchParams(location.search).get('folder');
  return id && idPattern.test(id) ? id : rootId;
}

function renderAccount() {
  const controls = $('#account-controls');
  if (!state.accountReady) return;
  if (!state.account) {
    controls.replaceChildren();
    $('#access-actions').replaceChildren(
      makeButton('Sign in', () => accountDialog('login')),
      makeButton('Register', () => accountDialog('register'), 'button primary')
    );
    return;
  }
  $('#access-actions').replaceChildren();
  const badge = document.createElement('span');
  badge.className = 'account-name';
  badge.textContent = state.account.username;
  controls.replaceChildren(badge);
  if (state.account.role === 'admin') {
    const button = makeButton('Admin panel', openAdmin);
    button.insertAdjacentHTML('afterbegin', icon('shield'));
    controls.append(button);
  }
  const settings = action('Settings', 'settings', openSettings);
  settings.setAttribute('aria-haspopup', 'dialog');
  controls.append(settings);
  controls.append(makeButton('Sign out', async () => {
    try {
      await request('/logout', { method: 'POST' });
      await loadSession();
      notice('Signed out.');
    } catch (error) {
      showError(pageError, error.message);
    }
  }));
}

function setAccount(account) {
  const wasSignedIn = Boolean(state.account);
  state.account = account;
  state.accountReady = true;
  $('#access-screen').hidden = Boolean(state.account);
  $('#workspace').hidden = !state.account;
  renderAccount();
  if (!state.account) {
    state.version++;
    state.loading = false;
    state.folder = null;
    if (wasSignedIn && dialog.open) {
      dialog.close();
      dialogBody.replaceChildren();
    }
    closeContextMenu();
    $('#categories').replaceChildren();
    closePreview();
    $('#breadcrumbs').replaceChildren();
    $('#items').replaceChildren();
    return;
  }
  showError($('#access-error'));
  if (!wasSignedIn) loadFolder(currentFolder());
  else renderFolder();
}

function showPassphraseScreen(message = '') {
  state.passphraseRequired = true;
  state.passphraseUnlocked = false;
  state.account = null;
  state.accountReady = false;
  $('#passphrase-screen').hidden = false;
  $('#ip-screen').hidden = true;
  $('#access-screen').hidden = true;
  $('#workspace').hidden = true;
  $('#account-controls').replaceChildren();
  closeContextMenu();
  closePreview();
  const input = $('#passphrase-input');
  input.value = '';
  showError($('#passphrase-error'), message);
  input.focus();
}

function showIpScreen(message = '') {
  state.account = null;
  state.accountReady = false;
  $('#ip-screen').hidden = false;
  $('#passphrase-screen').hidden = true;
  $('#access-screen').hidden = true;
  $('#workspace').hidden = true;
  $('#account-controls').replaceChildren();
  closeContextMenu();
  closePreview();
  if (dialog.open) dialog.close();
  const registered = state.ipRegistered;
  const mustChange = state.ipMustChange;
  $('#ip-title').textContent = mustChange ? 'Change your temporary passphrase'
    : registered ? `Welcome back${state.ipName ? ', ' + state.ipName : ''}` : 'Set up this network';
  $('#ip-copy').textContent = mustChange ? 'An administrator reset your passphrase. Choose a new one to open the drive.'
    : registered ? 'Enter this network’s passphrase to open the shared drive.'
      : 'Choose a friendly name and a passphrase for this network address.';
  $('#ip-address strong').textContent = state.ipAddress || '';
  $('#ip-address').hidden = !state.ipAddress;
  $('#ip-register-form').hidden = registered || mustChange;
  $('#ip-login-form').hidden = !registered || mustChange;
  $('#ip-change-form').hidden = !mustChange;
  $('#ip-register-form').reset();
  $('#ip-login-form').reset();
  $('#ip-change-form').reset();
  showError($('#ip-error'), message);
  (mustChange ? $('#ip-change-form input') : registered ? $('#ip-login-passphrase') : $('#ip-name-input')).focus();
}

async function loadSession() {
  const session = await request('/session');
  state.authMode = session.authMode || 'account';
  state.passphraseRequired = session.passphraseRequired === true;
  state.passphraseUnlocked = session.passphraseUnlocked !== false;
  state.ipRegistered = session.ipRegistered === true;
  state.ipName = session.ipName || null;
  state.ipAddress = session.ipAddress || null;
  state.ipMustChange = session.ipMustChange === true;
  if (state.authMode === 'passphrase' && !state.passphraseUnlocked) {
    showPassphraseScreen();
    return;
  }
  if (state.authMode === 'ip' && (state.ipMustChange || !session.ipUnlocked)) {
    showIpScreen();
    return;
  }
  $('#passphrase-screen').hidden = true;
  $('#ip-screen').hidden = true;
  const account = state.authMode === 'account'
    ? session.account
    : state.authMode === 'ip'
      ? { ...guestAccount, id: state.ipAddress, username: state.ipName || 'Guest', role: session.ipRole || 'member' }
      : { ...guestAccount, username: 'Shared drive' };
  setAccount(account);
}

async function submitPassphrase(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const input = $('#passphrase-input');
  showError($('#passphrase-error'));
  button.disabled = true;
  try {
    await request('/passphrase', { method: 'POST', body: { passphrase: input.value } });
    await loadSession();
    notice('Drive unlocked.');
  } catch (error) {
    showError($('#passphrase-error'), error.message);
    input.select();
  } finally {
    button.disabled = false;
  }
}

async function submitIpRegister(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const nameInput = $('#ip-name-input');
  const passphraseInput = $('#ip-register-passphrase');
  showError($('#ip-error'));
  button.disabled = true;
  try {
    await request('/ip/register', {
      method: 'POST', body: { name: nameInput.value, passphrase: passphraseInput.value },
    });
    await loadSession();
    notice('This network is registered.');
  } catch (error) {
    if (error.data?.needsLogin) {
      state.ipRegistered = true;
      showIpScreen(error.message);
    } else {
      showError($('#ip-error'), error.message);
      (nameInput.value ? passphraseInput : nameInput).focus();
    }
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

async function submitIpLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const passphraseInput = $('#ip-login-passphrase');
  showError($('#ip-error'));
  button.disabled = true;
  try {
    await request('/ip/login', { method: 'POST', body: { passphrase: passphraseInput.value } });
    await loadSession();
    notice('Drive unlocked.');
  } catch (error) {
    if (error.data?.needsRegistration) {
      state.ipRegistered = false;
      showIpScreen('This network is not registered yet. Set it up below.');
    } else {
      showError($('#ip-error'), error.message);
      passphraseInput.select();
    }
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function changePassword(form) {
  const currentPassword = form.elements.currentPassword.value;
  const newPassword = form.elements.newPassword.value;
  if (newPassword !== form.elements.confirmPassword.value) throw new Error('The new entries do not match.');
  return request('/password', { method: 'POST', body: { currentPassword, newPassword } });
}

async function submitIpPasswordChange(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  showError($('#ip-error'));
  button.disabled = true;
  try {
    await changePassword(form);
    await loadSession();
    notice('Passphrase updated.');
  } catch (error) {
    showError($('#ip-error'), error.message);
  } finally {
    button.disabled = false;
  }
}

function action(label, glyph, callback) {
  const button = makeButton('', callback, 'icon-button');
  button.innerHTML = icon(glyph);
  button.setAttribute('aria-label', label);
  button.title = label;
  return button;
}

function downloadLink(item) {
  const link = document.createElement('a');
  link.className = 'icon-button';
  link.href = `/api/drive/files/${encodeURIComponent(item.id)}/download`;
  link.download = item.name;
  link.innerHTML = icon('download');
  link.setAttribute('aria-label', `Download ${item.name}`);
  link.title = 'Download';
  return link;
}

function closePreview({ restoreFocus = false } = {}) {
  const preview = state.preview;
  if (!preview) return;
  preview.dispose?.();
  state.preview = null;
  preview.trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus && preview.trigger.isConnected) preview.trigger.focus();
  previewPanel.classList.remove('is-open');
  previewPanel.inert = true;
  previewPanel.setAttribute('aria-hidden', 'true');
  previewBody.className = 'preview-content';
  previewBody.replaceChildren();
}

function previewMessage(message) {
  const text = document.createElement('p');
  text.className = 'preview-message';
  text.textContent = message;
  previewBody.replaceChildren(text);
}

function renderTextPreview(host, text, item) {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = text;
  pre.append(code);
  host.replaceChildren(pre);
  if (item.previewTruncated) host.append(archiveMessage('Showing the first 128 KB.'));
  if (item.language) colorizeCode(code, item.language);
}

async function colorizeCode(code, language) {
  try {
    const { default: highlighter } = await import('/vendor/highlight/highlight.min.js');
    if (!highlighter.getLanguage(language)) {
      const { default: grammar } = await import(`/vendor/highlight/languages/${encodeURIComponent(language)}.min.js`);
      highlighter.registerLanguage(language, grammar);
    }
    if (!code.isConnected) return;
    code.className = `language-${language}`;
    highlighter.highlightElement(code);
  } catch {
    // Keep the plain text readable when a highlighting module cannot load.
  }
}

function openPdfPreview(host, url) {
  let dispose;
  let closed = false;
  host.replaceChildren(archiveMessage('Loading PDF…'));
  import('./pdf-preview.mjs').then(({ createPdfPreview }) => {
    if (!closed) dispose = createPdfPreview(host, url);
  }).catch(() => {
    if (!closed) host.replaceChildren(archiveMessage('The PDF preview could not be opened.'));
  });
  return () => {
    closed = true;
    dispose?.();
  };
}

const previewWidthKey = 'firesend:preview-width';
let previewWidth = 525;
try {
  const saved = Number(localStorage.getItem(previewWidthKey));
  if (saved > 0 && Number.isFinite(saved)) previewWidth = saved;
} catch {}

function setPreviewWidth(width, save = false) {
  const maximum = document.documentElement.clientWidth;
  const minimum = Math.min(280, maximum);
  previewWidth = Math.round(Math.max(minimum, Math.min(width, maximum)));
  previewPanel.style.setProperty('--preview-width', `${previewWidth}px`);
  previewResize.setAttribute('aria-valuemin', minimum);
  previewResize.setAttribute('aria-valuemax', maximum);
  previewResize.setAttribute('aria-valuenow', previewWidth);
  if (save) {
    try { localStorage.setItem(previewWidthKey, previewWidth); } catch {}
  }
}

let resizeStart;
previewResize.addEventListener('pointerdown', (event) => {
  if (!event.isPrimary || event.button !== 0) return;
  event.preventDefault();
  previewResize.setPointerCapture(event.pointerId);
  resizeStart = { id: event.pointerId, x: event.clientX, width: previewPanel.offsetWidth };
});
previewResize.addEventListener('pointermove', (event) => {
  if (event.pointerId === resizeStart?.id) {
    setPreviewWidth(resizeStart.width + resizeStart.x - event.clientX);
  }
});
previewResize.addEventListener('lostpointercapture', (event) => {
  if (event.pointerId !== resizeStart?.id) return;
  resizeStart = null;
  setPreviewWidth(previewWidth, true);
});
previewResize.addEventListener('keydown', (event) => {
  const widths = { ArrowLeft: previewWidth + 24, ArrowRight: previewWidth - 24, Home: 280, End: Infinity };
  if (!Object.hasOwn(widths, event.key)) return;
  event.preventDefault();
  setPreviewWidth(widths[event.key], true);
});

setPreviewWidth(previewWidth);
window.addEventListener('resize', () => setPreviewWidth(previewWidth));

async function handlePreviewAuth(response) {
  if (response.status !== 401) return false;
  const data = await response.json().catch(() => ({}));
  if (data.passphraseRequired) showPassphraseScreen('Enter the passphrase to continue.');
  else if (data.ipRequired) loadSession().catch(() => {});
  else if (data.signInRequired || state.account) setAccount(null);
  return true;
}

function archiveEntryUrl(item, entry) {
  return `/api/drive/files/${encodeURIComponent(item.id)}/archive/entry?path=${encodeURIComponent(entry.path)}`;
}

function buildArchiveTree(entries) {
  const root = { folders: new Map(), files: [], size: 0 };
  for (const entry of entries) {
    const parts = entry.path.split(/[\\/]/).filter(Boolean);
    if (!parts.length) continue;
    const folders = entry.folder ? parts : parts.slice(0, -1);
    let node = root;
    for (const folder of folders) {
      let child = node.folders.get(folder);
      if (!child) {
        child = { folders: new Map(), files: [], size: 0 };
        node.folders.set(folder, child);
      }
      node = child;
    }
    if (!entry.folder) node.files.push({ ...entry, name: parts.at(-1) });
  }
  const total = (node) => {
    let size = node.files.reduce((sum, file) => sum + file.size, 0);
    for (const child of node.folders.values()) size += total(child);
    node.size = size;
    return size;
  };
  total(root);
  return root;
}

function createArchiveBrowser(item, entries, preview) {
  const root = buildArchiveTree(entries);
  const container = document.createElement('div');
  container.className = 'archive-view';
  const toolbar = document.createElement('div');
  toolbar.className = 'archive-toolbar';
  const content = document.createElement('div');
  content.className = 'archive-content';
  container.append(toolbar, content);

  let path = [];
  let node = root;
  let requestVersion = 0;
  let disposeEntry;

  function showToolbar(back, label) {
    toolbar.replaceChildren();
    if (back) toolbar.append(makeButton('Back', back, 'text-button'));
    const crumb = document.createElement('span');
    crumb.className = 'archive-path';
    crumb.textContent = label;
    toolbar.append(crumb);
  }

  function goTo(nextPath) {
    path = nextPath;
    node = root;
    for (const part of path) node = node.folders.get(part) || node;
    renderFolder();
  }

  function renderFolder() {
    requestVersion += 1;
    disposeEntry?.();
    disposeEntry = null;
    showToolbar(path.length ? () => goTo(path.slice(0, -1)) : null, `/${path.join('/')}`);
    const folders = [...node.folders.entries()].sort(([a], [b]) => a.localeCompare(b));
    const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
    const count = folders.length + files.length;
    const summary = document.createElement('p');
    summary.className = 'archive-summary meta';
    summary.textContent = count ? `${count} item${count === 1 ? '' : 's'} · ${sizeLabel(node.size)}` : 'This folder is empty.';
    const list = document.createElement('ul');
    list.className = 'archive-list';

    for (const [folderName, child] of folders) {
      const row = makeButton('', () => goTo([...path, folderName]), 'archive-row');
      row.title = [...path, folderName].join('/');
      row.innerHTML = `<span class="item-icon folder-icon">${icon('folder')}</span><span class="archive-row-name"></span><span class="archive-row-meta"></span>`;
      row.querySelector('.archive-row-name').textContent = folderName;
      row.querySelector('.archive-row-meta').textContent = sizeLabel(child.size);
      const entry = document.createElement('li');
      entry.append(row);
      list.append(entry);
    }

    for (const file of files) {
      const row = makeButton('', () => openEntry(file), 'archive-row');
      row.title = file.path;
      row.innerHTML = `<span class="item-icon">${icon('file')}</span><span class="archive-row-name"></span><span class="archive-row-meta"></span>`;
      row.querySelector('.archive-row-name').textContent = file.name;
      row.querySelector('.archive-row-meta').textContent = [
        sizeLabel(file.size), file.encrypted ? 'Locked' : '', file.preview ? '' : 'No preview',
      ].filter(Boolean).join(' · ');
      const entry = document.createElement('li');
      entry.append(row);
      list.append(entry);
    }

    content.replaceChildren(summary, list);
  }

  async function openEntry(entry) {
    const version = ++requestVersion;
    disposeEntry?.();
    disposeEntry = null;
    showToolbar(() => renderFolder(), `/${[...path, entry.name].join('/')}`);
    const wrapper = document.createElement('div');
    wrapper.className = 'archive-entry';
    content.replaceChildren(wrapper);

    if (!entry.preview) {
      wrapper.append(archiveMessage('Preview unavailable for this entry.'));
      return;
    }

    const url = archiveEntryUrl(item, entry);
    if (entry.preview === 'pdf') {
      disposeEntry = openPdfPreview(wrapper, url);
      return;
    }
    if (entry.preview === 'text') {
      wrapper.append(archiveMessage('Loading…'));
      try {
        const response = await fetch(url);
        if (version !== requestVersion || state.preview !== preview) return;
        if (!response.ok) {
          if (await handlePreviewAuth(response)) return;
          throw new Error('Archive entry unavailable.');
        }
        const text = await response.text();
        if (version !== requestVersion) return;
        renderTextPreview(wrapper, text, entry);
      } catch {
        if (version === requestVersion) wrapper.replaceChildren(archiveMessage('Preview unavailable for this entry.'));
      }
      return;
    }

    const media = document.createElement(entry.preview === 'image' ? 'img' : entry.preview);
    if (media instanceof HTMLImageElement) media.alt = entry.name;
    else {
      media.controls = true;
      media.preload = 'metadata';
      media.setAttribute('aria-label', entry.name);
    }
    media.addEventListener('error', () => {
      if (version === requestVersion) wrapper.replaceChildren(archiveMessage('Preview unavailable for this entry.'));
    });
    media.src = url;
    wrapper.replaceChildren(media);
  }

  renderFolder();

  return {
    element: container,
    dispose() {
      requestVersion += 1;
      disposeEntry?.();
    },
  };
}

function archiveMessage(message) {
  const text = document.createElement('p');
  text.className = 'preview-message';
  text.textContent = message;
  return text;
}

async function openArchivePreview(item, preview) {
  previewMessage('Loading archive…');
  try {
    const response = await fetch(`/api/drive/files/${encodeURIComponent(item.id)}/archive`);
    if (!response.ok) {
      if (await handlePreviewAuth(response)) return;
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Archive preview unavailable.');
    }
    const data = await response.json();
    if (state.preview !== preview) return;
    const browser = createArchiveBrowser(item, data.entries, preview);
    preview.dispose = () => browser.dispose();
    previewBody.replaceChildren(browser.element);
  } catch (error) {
    if (state.preview === preview) previewMessage(error.message || 'Archive preview unavailable.');
  }
}

async function openModelPreview(item, preview) {
  previewMessage('Loading 3D model…');
  const url = `/api/drive/files/${encodeURIComponent(item.id)}/preview`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      if (await handlePreviewAuth(response)) return;
      throw new Error('Preview unavailable.');
    }
    const text = await response.text();
    if (state.preview !== preview) return;
    const { createModelPreview, loadObjMaterials } = await import('./model-viewer.mjs');
    if (state.preview !== preview) return;
    const files = state.folder?.items?.filter((sibling) => sibling.kind === 'file') || [];
    const materials = /\.obj$/i.test(item.name) ? await loadObjMaterials(text, files) : '';
    if (state.preview !== preview) return;
    const viewer = createModelPreview({ text, name: item.name, files, materials });
    if (state.preview !== preview) {
      viewer.dispose();
      return;
    }
    preview.dispose = () => viewer.dispose();
    previewBody.classList.add('model-mode');
    previewBody.replaceChildren(viewer.element);
  } catch (error) {
    console.error(error);
    if (state.preview === preview) previewMessage('Preview unavailable. The model could not be rendered.');
  }
}

async function openPreview(item, trigger, { focus = true } = {}) {
  closePreview();
  previewBody.className = 'preview-content';
  const preview = { item, trigger };
  state.preview = preview;
  trigger.setAttribute('aria-expanded', 'true');
  $('#preview-name').textContent = item.name;
  $('#preview-meta').textContent = `${sizeLabel(item.size)} · ${dateFormat.format(item.updatedAt)}`;
  const download = downloadLink(item);
  download.className = 'button';
  download.append(' Download');
  $('#preview-actions').replaceChildren(download);
  previewPanel.inert = false;
  previewPanel.removeAttribute('aria-hidden');
  previewPanel.classList.add('is-open');
  if (focus) $('#close-preview').focus();

  const url = `/api/drive/files/${encodeURIComponent(item.id)}/preview`;
  if (item.preview === 'archive') {
    openArchivePreview(item, preview);
    return;
  }
  if (item.preview === 'model') {
    openModelPreview(item, preview);
    return;
  }
  if (item.preview === 'pdf') {
    preview.dispose = openPdfPreview(previewBody, url);
    return;
  }
  if (item.preview === 'text') {
    previewMessage('Loading preview…');
    try {
      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 401) {
          const data = await response.json().catch(() => ({}));
          if (data.passphraseRequired) showPassphraseScreen('Enter the passphrase to continue.');
          else if (data.ipRequired) loadSession().catch(() => {});
          else setAccount(null);
        }
        throw new Error('Preview unavailable.');
      }
      const text = await response.text();
      if (state.preview !== preview) return;
      renderTextPreview(previewBody, text, item);
    } catch (error) {
      if (state.preview === preview) previewMessage('Preview unavailable. Download the file to open it.');
    }
    return;
  }
  if (['image', 'audio', 'video'].includes(item.preview)) {
    const media = document.createElement(item.preview === 'image' ? 'img' : item.preview);
    if (media instanceof HTMLImageElement) media.alt = item.name;
    else {
      media.controls = true;
      media.preload = 'metadata';
      media.setAttribute('aria-label', item.name);
    }
    let converted = Boolean(item.convertPreview);
    let loading;
    function showConversion() {
      loading = archiveMessage('Preparing a compatible preview…');
      loading.setAttribute('role', 'status');
      previewBody.append(loading);
    }
    media.addEventListener(item.preview === 'image' ? 'load' : 'loadedmetadata', () => loading?.remove());
    media.addEventListener('error', () => {
      if (state.preview !== preview) return;
      if (!converted) {
        converted = true;
        showConversion();
        media.src = `${url}?compatible=1`;
        return;
      }
      previewMessage('Preview unavailable. Download the file to open it.');
    });
    previewBody.replaceChildren(media);
    if (converted) showConversion();
    media.src = url;
    return;
  }
  previewMessage('Preview unavailable. Download the file to open it.');
}

function renderItem(item) {
  const row = document.createElement('tr');
  row.dataset.itemId = item.id;
  row.dataset.itemVersion = JSON.stringify(item);
  row.draggable = true;
  if (item.kind === 'folder') {
    row.dataset.dropFolder = item.id;
    row.dataset.dropName = item.name;
  }
  const nameCell = row.insertCell();
  const name = document.createElement('div');
  name.className = 'item-name';
  name.innerHTML = `<span class="item-icon ${item.kind === 'folder' ? 'folder-icon' : ''}">${icon(item.kind === 'folder' ? 'folder' : 'file')}</span>`;
  if (item.kind === 'folder') {
    const link = folderLink(item.id, item.name);
    link.draggable = false;
    name.append(link);
  } else {
    const button = makeButton(item.name, () => openPreview(item, button), 'preview-trigger');
    button.setAttribute('aria-label', `Preview ${item.name}`);
    button.setAttribute('aria-controls', 'preview-panel');
    button.setAttribute('aria-expanded', 'false');
    const iconSlot = name.firstElementChild;
    button.prepend(iconSlot);
    name.append(button);
    if (item.preview === 'image' || item.preview === 'video') {
      const fileUrl = `/api/drive/files/${encodeURIComponent(item.id)}`;
      const thumbnail = document.createElement('img');
      thumbnail.className = 'item-thumbnail';
      thumbnail.alt = '';
      thumbnail.width = 30;
      thumbnail.height = 30;
      thumbnail.draggable = false;
      thumbnail.loading = 'lazy';
      thumbnail.decoding = 'async';
      thumbnail.addEventListener('load', () => iconSlot.classList.add('has-thumbnail'), { once: true });
      let triedOriginal = false;
      thumbnail.addEventListener('error', () => {
        if (item.preview === 'image' && !triedOriginal) {
          triedOriginal = true;
          thumbnail.src = `${fileUrl}/preview`;
          return;
        }
        thumbnail.remove();
      });
      iconSlot.append(thumbnail);
      thumbnail.src = `${fileUrl}/thumbnail`;
    }
  }
  nameCell.append(name);
  const owner = row.insertCell();
  owner.className = 'owner-column meta';
  const ownerName = document.createElement('span');
  ownerName.className = 'owner-name';
  ownerName.textContent = item.createdBy || '—';
  owner.append(ownerName);
  const date = row.insertCell();
  date.className = 'date-column meta';
  date.textContent = dateFormat.format(item.updatedAt);
  const size = row.insertCell();
  size.className = 'size-column meta';
  size.textContent = item.kind === 'file' ? sizeLabel(item.size) : '—';
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  if (item.kind === 'file') actions.append(downloadLink(item));
  if (state.account) {
    actions.append(
      action(`Rename ${item.name}`, 'rename', () => nameDialog('rename', item)),
      action(`Move ${item.name}`, 'arrow', () => moveDialog(item))
    );
  }
  const more = action(`More actions for ${item.name}`, 'more', (event) => showItemMenu(item, row, event.currentTarget));
  more.setAttribute('aria-haspopup', 'menu');
  actions.append(more);
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showItemMenu(item, row, more, event);
  });
  row.insertCell().append(actions);
  return row;
}

function renderParentRow(parent) {
  const row = document.createElement('tr');
  row.className = 'parent-folder-row';
  row.dataset.dropFolder = parent.id;
  row.dataset.dropName = parent.name;
  const cell = row.insertCell();
  cell.colSpan = 5;
  const name = document.createElement('div');
  name.className = 'item-name';
  name.innerHTML = `<span class="item-icon folder-icon">${icon('folder')}</span>`;
  const link = folderLink(parent.id, '..');
  link.draggable = false;
  link.setAttribute('aria-label', `Parent folder: ${parent.name}`);
  link.title = `Parent folder: ${parent.name}`;
  name.append(link);
  cell.append(name);
  return row;
}

function renderFolder(previous) {
  const folder = state.folder;
  $('#new-folder').disabled = !folder;
  $('#upload-button').disabled = !folder || state.uploading;
  $('#manage-categories').disabled = !folder;
  if (!folder) return;

  const categoryChanged = JSON.stringify(previous?.categories) !== JSON.stringify(folder.categories);
  if (categoryChanged) {
    const links = (folder.categories || []).map((category) => {
      const link = folderLink(category.id, category.name);
      link.className = 'drive-link';
      link.title = category.name;
      link.dataset.categoryId = category.id;
      const label = document.createElement('span');
      label.textContent = category.name;
      link.innerHTML = icon('folder');
      link.append(label);
      return link;
    });
    $('#categories').replaceChildren(...links);
    if (dialog.open && $('#category-list')) renderCategoryManager();
  }
  for (const link of $('#categories').children) {
    if (link.dataset.categoryId === folder.path[0].id) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  }

  const pathChanged = JSON.stringify(previous?.path) !== JSON.stringify(folder.path);
  if (pathChanged) {
    document.title = `${folder.path.at(-1).name} · FireSend`;
    const crumbs = $('#breadcrumbs');
    crumbs.replaceChildren();
    for (const [index, crumb] of folder.path.entries()) {
      if (index > 0) {
        const separator = document.createElement('span');
        separator.className = 'separator';
        separator.setAttribute('aria-hidden', 'true');
        separator.textContent = '/';
        crumbs.append(separator);
      }
      if (crumb.id === folder.id) {
        const current = document.createElement('span');
        current.setAttribute('aria-current', 'page');
        current.tabIndex = -1;
        current.textContent = crumb.name;
        crumbs.append(current);
      } else {
        crumbs.append(folderLink(crumb.id, crumb.name));
      }
    }
  }

  const parent = folder.path.at(-2);
  if (pathChanged || JSON.stringify(previous?.items) !== JSON.stringify(folder.items)) renderItems(folder.items, parent);
  const empty = folder.items.length === 0;
  $('#file-table').hidden = empty && !parent;
  $('#empty-state').hidden = !empty;
  $('#empty-state').textContent = 'No files or folders';
}

function renderItems(items, parent) {
  const table = $('#items');
  const existing = new Map([...table.rows].map((row) => [row.dataset.itemId, row]));
  const itemRows = items.map((item) => {
    const row = existing.get(item.id);
    if (row?.dataset.itemVersion === JSON.stringify(item)) {
      existing.delete(item.id);
      return row;
    }
    return renderItem(item);
  });
  const next = [...itemRows];
  if (parent) {
    const row = existing.get(undefined);
    if (row?.dataset.dropFolder === parent.id && row.dataset.dropName === parent.name) {
      existing.delete(undefined);
      next.unshift(row);
    } else {
      next.unshift(renderParentRow(parent));
    }
  }
  const focused = document.activeElement;
  for (const row of existing.values()) row.remove();
  for (const [index, row] of next.entries()) {
    if (table.rows[index] !== row) table.insertBefore(row, table.rows[index] || null);
  }
  if (focused.isConnected && document.activeElement !== focused && !dialog.open) focused.focus({ preventScroll: true });
  if (menuTrigger && !menuTrigger.isConnected) closeContextMenu();
  const preview = state.preview;
  if (preview && !preview.trigger.isConnected) {
    const index = items.findIndex((item) => item.id === preview.item.id);
    if (index < 0) closePreview();
    else openPreview(items[index], itemRows[index].querySelector('.preview-trigger'), { focus: false });
  }
}

async function loadFolder(id, { focus = false, refresh = false, quiet = false } = {}) {
  if (!state.account || (quiet && state.loading)) return;
  const version = ++state.version;
  state.loading = true;
  if (!refresh) {
    closeContextMenu();
    closePreview();
    state.folder = null;
    showError(pageError);
    $('#file-table').hidden = true;
    $('#empty-state').hidden = false;
    $('#empty-state').textContent = 'Loading drive…';
    $('#breadcrumbs').replaceChildren();
    renderFolder();
  }
  try {
    const folder = await request(`/folders/${encodeURIComponent(id)}`);
    if (version !== state.version) return;
    const previous = state.folder;
    state.folder = folder;
    renderFolder(previous);
    if (focus) $('#breadcrumbs [aria-current]').focus();
  } catch (error) {
    if (version !== state.version) return;
    if (error.status === 404 && id !== rootId) {
      history.replaceState(null, '', folderHref(rootId));
      notice('That folder is no longer available.');
      return loadFolder(rootId, { focus: true });
    }
    if (!refresh) $('#empty-state').textContent = 'Folder unavailable';
    if (!quiet) showError(pageError, error.message);
  } finally {
    if (version === state.version) state.loading = false;
  }
}

function syncFolder() {
  if (!document.hidden && state.folder) loadFolder(state.folder.id, { refresh: true, quiet: true });
}

function showDialog(title, markup) {
  $('#dialog-title').textContent = title;
  dialogBody.innerHTML = markup;
  showError(dialogError);
  if (!dialog.open) dialog.showModal();
  const focus = dialogBody.querySelector('[autofocus]');
  if (focus) focus.focus();
}

function submitForm(handler) {
  const form = dialogBody.querySelector('form');
  const submit = form.querySelector('button[type="submit"]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    showError(dialogError);
    submit.disabled = true;
    try {
      await handler(new FormData(form), form);
    } catch (error) {
      if (form.isConnected && dialog.open) showError(dialogError, error.message);
    } finally {
      submit.disabled = false;
    }
  });
}

function accountDialog(mode, afterSignIn) {
  const registering = mode === 'register';
  const title = registering ? 'Register' : 'Sign in';
  showDialog(title, `
    <form class="dialog-form">
      <label>Username<input name="username" autocomplete="username" maxlength="32" required autofocus></label>
      <label>Password<input name="password" type="password" autocomplete="${registering ? 'new-password' : 'current-password'}" maxlength="128" required></label>
      ${registering ? '<p class="hint">Use 3–32 letters, numbers, dots, underscores, or hyphens for your username. Choose a password with at least 10 characters.</p>' : ''}
      <div class="dialog-actions"><button id="switch-account-mode" class="text-button" type="button">${registering ? 'Already registered? Sign in' : 'Create an account'}</button><button class="button primary" type="submit">${title}</button></div>
    </form>`);
  $('#switch-account-mode').addEventListener('click', () => accountDialog(registering ? 'login' : 'register', afterSignIn));
  submitForm(async (fields, form) => {
    const result = await request(registering ? '/register' : '/login', {
      method: 'POST', body: { username: fields.get('username'), password: fields.get('password') },
    });
    if (registering && !result.account) {
      if (form.isConnected && dialog.open) {
        showDialog('Account requested', '<p class="dialog-copy">An admin must enable your account before you can sign in.</p><div class="dialog-actions"><button id="back-to-sign-in" class="button primary" type="button" autofocus>Back to sign in</button></div>');
        $('#back-to-sign-in').addEventListener('click', () => accountDialog('login', afterSignIn));
      }
      return;
    }
    setAccount(result.account);
    notice(`Signed in as ${result.account.username}.`);
    if (form.isConnected && dialog.open) {
      dialog.close();
      if (afterSignIn) afterSignIn();
    }
  });
}

function splitName(name) {
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) return { base: name, ext: '' };
  return { base: name.slice(0, index), ext: name.slice(index + 1) };
}

function extensionValue(value) {
  const ext = (value || '').trim().replace(/\s+/g, '').replace(/^\.+/, '');
  return ext ? '.' + ext : '';
}

function nameDialog(mode, item) {
  const folder = state.folder;
  if (!folder) return;
  if (!state.account) return accountDialog('login', () => nameDialog(mode, item));
  const renaming = mode === 'rename';
  const split = renaming && item.kind === 'file' && state.renameSplit;
  const parts = split ? splitName(item.name) : null;
  showDialog(renaming ? 'Rename item' : 'New folder', `
    <form class="dialog-form">
      ${split ? `<div class="name-split">
        <label>File name<input name="base" maxlength="150" required autofocus></label>
        <label>Extension<input name="ext" maxlength="20" placeholder="txt"></label>
      </div>` : `<label>${renaming ? 'Name' : 'Folder name'}<input name="name" maxlength="150" required autofocus></label>`}
      <div class="dialog-actions"><button type="button" class="button cancel-dialog">Cancel</button><button class="button primary" type="submit">${renaming ? 'Save name' : 'Create folder'}</button></div>
    </form>`);
  if (split) {
    const base = dialogBody.querySelector('input[name="base"]');
    dialogBody.querySelector('input[name="ext"]').value = parts.ext;
    base.value = parts.base;
    base.focus();
    base.select();
  } else if (renaming) {
    const input = dialogBody.querySelector('input');
    input.value = item.name;
    input.select();
  }
  dialogBody.querySelector('.cancel-dialog').addEventListener('click', () => dialog.close());
  submitForm(async (fields, form) => {
    const name = split
      ? `${fields.get('base').trim()}${extensionValue(fields.get('ext'))}`
      : fields.get('name');
    await request(renaming ? `/items/${item.id}` : `/folders/${folder.id}`, {
      method: renaming ? 'PATCH' : 'POST', body: { name },
    });
    if (form.isConnected && dialog.open) dialog.close();
    notice(renaming ? 'Name updated.' : 'Folder created.');
    if (state.folder?.id === folder.id) await loadFolder(folder.id, { refresh: true });
  });
}

function closeContextMenu({ restoreFocus = false } = {}) {
  if (contextMenu.hidden) return;
  const trigger = menuTrigger;
  menuTrigger = null;
  contextMenu.hidden = true;
  contextMenu.replaceChildren();
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
}

function openContextMenu(anchor, groups, event) {
  closeContextMenu();
  menuTrigger = anchor;
  for (const [index, group] of groups.entries()) {
    if (index > 0) {
      const separator = document.createElement('hr');
      separator.setAttribute('role', 'separator');
      contextMenu.append(separator);
    }
    for (const { label, glyph, onClick, link, danger } of group) {
      const item = link || makeButton(label, () => {
        closeContextMenu({ restoreFocus: true });
        onClick();
      });
      item.className = danger ? 'menu-item menu-danger' : 'menu-item';
      item.setAttribute('role', 'menuitem');
      item.tabIndex = -1;
      item.innerHTML = icon(glyph);
      item.append(label);
      if (link) item.addEventListener('click', () => setTimeout(() => closeContextMenu({ restoreFocus: true }), 0));
      contextMenu.append(item);
    }
  }
  const rect = anchor.getBoundingClientRect();
  const x = event?.clientX || rect.left;
  const y = event?.clientY || rect.bottom;
  contextMenu.hidden = false;
  contextMenu.style.left = `${Math.max(6, Math.min(x, innerWidth - contextMenu.offsetWidth - 6))}px`;
  contextMenu.style.top = `${Math.max(6, Math.min(y, innerHeight - contextMenu.offsetHeight - 6))}px`;
  contextMenu.querySelector('[role="menuitem"]').focus({ preventScroll: true });
}

function showItemMenu(item, row, anchor, event) {
  const open = item.kind === 'folder'
    ? [{ label: 'Open folder', glyph: 'folder', onClick: () => row.querySelector('.item-name a').click() }]
    : [
        { label: 'Preview', glyph: 'file', onClick: () => openPreview(item, row.querySelector('.preview-trigger')) },
        { label: 'Download', glyph: 'download', link: downloadLink(item) },
      ];
  openContextMenu(anchor, [
    open,
    [
      { label: 'Rename', glyph: 'rename', onClick: () => nameDialog('rename', item) },
      { label: 'Move', glyph: 'arrow', onClick: () => moveDialog(item) },
    ],
    [{ label: 'Delete', glyph: 'trash', danger: true, onClick: () => deleteItemDialog(item) }],
  ], event);
}

function confirmRemoval(title, message, remove, done, cancel = () => dialog.close()) {
  showDialog(title, `
    <p class="dialog-copy" id="delete-message"></p>
    <form class="dialog-form">
      <div class="dialog-actions">
        <button type="button" class="button cancel-dialog" autofocus>Cancel</button>
        <button type="submit" class="button danger">Delete</button>
      </div>
    </form>`);
  $('#delete-message').textContent = message;
  dialogBody.querySelector('.cancel-dialog').addEventListener('click', cancel);
  submitForm(async (_, form) => {
    await remove();
    done(form.isConnected && dialog.open);
  });
}

function deleteItemDialog(item) {
  const folder = state.folder;
  const isFolder = item.kind === 'folder';
  confirmRemoval(isFolder ? 'Delete folder' : 'Delete file',
    isFolder ? `Permanently delete “${item.name}” and everything inside it?` : `Permanently delete “${item.name}”?`,
    () => request(`/items/${item.id}`, { method: 'DELETE' }),
    (dialogStillOpen) => {
      if (dialogStillOpen) dialog.close();
      notice(isFolder ? 'Folder deleted.' : 'File deleted.');
      if (state.folder?.id === folder.id) loadFolder(folder.id, { refresh: true });
    });
}

function openCategoryManager() {
  showDialog('Categories', `
    <ul id="category-list" class="category-list"></ul>
    <div class="dialog-actions"><button id="new-category" type="button" class="button primary">New category</button></div>`);
  $('#new-category').addEventListener('click', () => categoryNameDialog());
  renderCategoryManager();
}

function renderCategoryManager() {
  const list = $('#category-list');
  const categories = state.folder?.categories || [];
  list.replaceChildren();
  categories.forEach((category, index) => {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = category.name;
    const controls = document.createElement('div');
    controls.className = 'row-actions';
    const rename = action(`Rename ${category.name}`, 'rename', () => categoryNameDialog(category));
    const up = action(`Move ${category.name} up`, 'up', (event) => reorderCategory(category.id, 'up', event.currentTarget));
    const down = action(`Move ${category.name} down`, 'down', (event) => reorderCategory(category.id, 'down', event.currentTarget));
    up.disabled = index === 0;
    down.disabled = index === categories.length - 1;
    controls.append(rename, up, down);
    row.append(name, controls);
    list.append(row);
  });
}

async function reorderCategory(id, direction, button) {
  button.disabled = true;
  showError(dialogError);
  try {
    await request(`/categories/${id}`, { method: 'PATCH', body: { direction } });
    if (state.folder) await loadFolder(state.folder.id, { refresh: true });
  } catch (error) {
    if (button.isConnected && dialog.open) showError(dialogError, error.message);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function categoryNameDialog(category) {
  showDialog(category ? 'Rename category' : 'New category', `
    <form class="dialog-form">
      <label>Category name<input name="name" maxlength="150" required autofocus></label>
      <div class="dialog-actions"><button type="button" class="button cancel-dialog">Cancel</button>
      <button type="submit" class="button primary">${category ? 'Save name' : 'Create category'}</button></div>
    </form>`);
  if (category) {
    const input = dialogBody.querySelector('input');
    input.value = category.name;
    input.select();
  }
  dialogBody.querySelector('.cancel-dialog').addEventListener('click', openCategoryManager);
  submitForm(async (fields, form) => {
    await request(category ? `/categories/${category.id}` : '/categories', {
      method: category ? 'PATCH' : 'POST', body: { name: fields.get('name') },
    });
    if (form.isConnected && dialog.open) openCategoryManager();
    if (state.folder) await loadFolder(state.folder.id, { refresh: true });
  });
}

function moveDialog(item) {
  const source = state.folder;
  showDialog('Move item', `
    <p class="dialog-copy" id="move-copy"></p>
    <div id="move-picker" class="move-picker">
      <nav id="move-path" aria-label="Destination path" class="breadcrumbs"></nav>
      <ul id="move-folders" class="move-folders"></ul>
      <p class="hint" id="move-empty"></p>
    </div>
    <div class="dialog-actions"><button type="button" class="button cancel-dialog">Cancel</button><button type="button" id="move-submit" class="button primary" disabled>Move here</button></div>`);
  $('#move-copy').textContent = `Choose a destination for ${item.name}.`;
  dialogBody.querySelector('.cancel-dialog').addEventListener('click', () => dialog.close());
  const picker = $('#move-picker');
  const crumbs = $('#move-path');
  const choices = $('#move-folders');
  const empty = $('#move-empty');
  const move = $('#move-submit');
  let destination = null;
  let version = 0;

  function renderDestinations(folders) {
    choices.replaceChildren();
    for (const folder of folders) {
      const row = document.createElement('li');
      const button = makeButton(folder.name, () => browse(folder.id), 'picker-option');
      button.insertAdjacentHTML('afterbegin', icon('folder'));
      row.append(button);
      choices.append(row);
    }
  }

  function browseCategories() {
    version++;
    destination = null;
    move.disabled = true;
    showError(dialogError);
    crumbs.textContent = 'Categories';
    empty.textContent = '';
    renderDestinations(state.folder?.categories || []);
  }

  async function browse(id) {
    const requested = ++version;
    showError(dialogError);
    move.disabled = true;
    destination = null;
    empty.textContent = 'Loading folders…';
    choices.replaceChildren();
    try {
      const folder = await request(`/folders/${id}`);
      if (!picker.isConnected || !dialog.open || requested !== version) return;
      destination = folder;
      crumbs.replaceChildren(
        makeButton('Categories', browseCategories, 'text-button'),
        ...folder.path.map((crumb) => makeButton(crumb.name, () => browse(crumb.id), 'text-button'))
      );
      const children = folder.items.filter((child) => child.kind === 'folder' && child.id !== item.id);
      renderDestinations(children);
      empty.textContent = children.length ? '' : 'No subfolders here.';
      move.disabled = folder.id === source.id;
    } catch (error) {
      if (picker.isConnected && dialog.open && requested === version) {
        empty.textContent = '';
        showError(dialogError, error.message);
      }
    }
  }

  move.addEventListener('click', async () => {
    if (!destination) return;
    const folder = destination;
    move.disabled = true;
    showError(dialogError);
    try {
      await request(`/items/${item.id}`, { method: 'PATCH', body: { parentId: folder.id } });
      if (picker.isConnected && dialog.open) dialog.close();
      notice(`Moved to ${folder.path.at(-1).name}.`);
      if (state.folder?.id === source.id) await loadFolder(source.id, { refresh: true });
    } catch (error) {
      if (picker.isConnected && dialog.open) showError(dialogError, error.message);
    } finally {
      move.disabled = destination?.id === source.id || !destination;
    }
  });
  browseCategories();
}

function uploadFile(folderId, file, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/drive/folders/${folderId}/files`);
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) progress.value = event.loaded / event.total;
    });
    xhr.addEventListener('load', () => {
      if (xhr.status === 201) resolve();
      else reject(new Error(xhr.response?.error || 'Upload failed.'));
    });
    xhr.addEventListener('error', () => reject(new Error('Connection lost during upload.')));
    const body = new FormData();
    body.append('file', file);
    xhr.send(body);
  });
}

async function uploadFiles(files) {
  if (!state.folder || !files.length || state.uploading) return;
  const { id } = state.folder;
  state.uploading = true;
  $('#upload-button').disabled = true;
  showError(pageError);
  const progress = $('#upload-progress');
  const status = $('#upload-status');
  const errors = [];
  let completed = 0;

  for (const file of files) {
    progress.value = 0;
    $('#upload-label').textContent = `Uploading ${file.name}`;
    status.hidden = false;
    try {
      await uploadFile(id, file, progress);
      completed++;
    } catch (error) {
      errors.push(`${file.name} — ${error.message}`);
    }
  }
  state.uploading = false;
  status.hidden = true;
  $('#upload-button').disabled = !state.folder;
  if (completed) notice(`Uploaded ${completed} ${completed === 1 ? 'file' : 'files'}.`);
  if (errors.length) showError(pageError, errors.join(' '));
  if (state.folder?.id === id) await loadFolder(id, { refresh: true });
}

function applyTheme(theme) {
  const useGraphite = theme === 'graphite' || theme === 'default';
  document.documentElement.dataset.theme = useGraphite ? 'graphite' : 'vista';
  $('meta[name="theme-color"]').content = useGraphite ? '#101112' : '#0b2633';
}

function openSettings() {
  const credential = state.authMode === 'account' ? 'password'
    : state.authMode === 'passphrase' ? 'shared passphrase' : 'passphrase';
  showDialog('Settings', `
    <fieldset class="theme-options">
      <legend>Theme</legend>
      <label class="theme-option">
        <input type="radio" name="drive-theme" value="vista">
        <span class="theme-swatch theme-swatch-vista" aria-hidden="true"></span>
        <span>Vista Glass</span>
      </label>
      <label class="theme-option">
        <input type="radio" name="drive-theme" value="graphite">
        <span class="theme-swatch theme-swatch-graphite" aria-hidden="true"></span>
        <span>Graphite</span>
      </label>
    </fieldset>
    <fieldset class="theme-options">
      <legend>Rename dialog</legend>
      <label class="theme-option">
        <input type="radio" name="rename-mode" value="split">
        <span>File name and extension<small class="hint">Two boxes</small></span>
      </label>
      <label class="theme-option">
        <input type="radio" name="rename-mode" value="single">
        <span>Single name field<small class="hint">One box</small></span>
      </label>
    </fieldset>
    <fieldset class="theme-options">
      <legend>Sign-in</legend>
      <button id="change-password" class="button" type="button">Change ${credential}</button>
    </fieldset>`);
  const activeTheme = document.documentElement.dataset.theme;
  for (const input of dialogBody.querySelectorAll('input[name="drive-theme"]')) {
    input.checked = input.value === activeTheme;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      applyTheme(input.value);
      try {
        localStorage.setItem('firesend:drive-theme', input.value);
      } catch {
        // The selection still applies to this page.
      }
    });
  }
  for (const input of dialogBody.querySelectorAll('input[name="rename-mode"]')) {
    input.checked = input.value === (state.renameSplit ? 'split' : 'single');
    input.addEventListener('change', () => {
      if (!input.checked) return;
      state.renameSplit = input.value === 'split';
      try {
        localStorage.setItem('firesend:rename-split', input.value);
      } catch {
        // The selection still applies to this page.
      }
    });
  }
  $('#change-password').addEventListener('click', () => openPasswordSettings(credential));
  dialogBody.querySelector('input:checked').focus();
}

function openPasswordSettings(credential) {
  const minimum = state.authMode === 'account' ? 10 : 6;
  showDialog(`Change ${credential}`, `
    <form class="dialog-form">
      ${state.authMode === 'passphrase' ? '<p class="dialog-copy">This updates the passphrase for everyone and signs out other sessions.</p>' : ''}
      <label>Current ${credential}<input name="currentPassword" type="password" autocomplete="current-password" required autofocus></label>
      <label>New ${credential}<input name="newPassword" type="password" minlength="${minimum}" maxlength="128" autocomplete="new-password" required></label>
      <label>Confirm new ${credential}<input name="confirmPassword" type="password" minlength="${minimum}" maxlength="128" autocomplete="new-password" required></label>
      <div class="dialog-actions">
        <button class="button cancel-dialog" type="button">Back</button>
        <button class="button primary" type="submit">Save</button>
      </div>
    </form>`);
  $('.cancel-dialog').addEventListener('click', openSettings);
  submitForm(async (_, form) => {
    await changePassword(form);
    form.reset();
    if (form.isConnected && dialog.open) dialog.close();
    notice('Sign-in credentials updated.');
  });
}

function editIpAccount(account, resetPassphrase) {
  const title = resetPassphrase ? 'Set temporary passphrase' : 'Rename network account';
  showDialog(title, `
    <form class="dialog-form">
      <p id="edit-ip-account" class="dialog-copy"></p>
      ${resetPassphrase
        ? '<label>Temporary passphrase<input name="value" type="password" minlength="6" maxlength="128" autocomplete="new-password" required autofocus></label>'
        : '<label>Friendly name<input name="value" maxlength="40" required autofocus></label>'}
      <div class="dialog-actions">
        <button class="button cancel-dialog" type="button">Back</button>
        <button class="button primary" type="submit">Save</button>
      </div>
    </form>`);
  $('#edit-ip-account').textContent = resetPassphrase
    ? `Give the temporary passphrase to ${account.username}. They’ll use it to sign in and choose a new one.`
    : `Change the name shown for ${account.ip}.`;
  if (!resetPassphrase) dialogBody.querySelector('input[name="value"]').value = account.username;
  $('.cancel-dialog').addEventListener('click', openAdmin);
  const url = `/admin/accounts/${encodeURIComponent(account.id)}`;
  submitForm(async (formData, form) => {
    const value = formData.get('value');
    if (resetPassphrase) {
      await request(`${url}/reset-passphrase`, { method: 'POST', body: { passphrase: value } });
      form.reset();
      notice('Temporary passphrase set.');
    } else {
      await request(url, { method: 'PATCH', body: { name: value } });
      if (account.id === state.account?.id) await loadSession();
    }
    if (form.isConnected && dialog.open) openAdmin();
  });
}

function openAdmin() {
  if (state.account?.role !== 'admin') return;
  const ipMode = state.authMode === 'ip';
  showDialog('Admin panel', `
    <p id="admin-summary" class="dialog-copy">Loading accounts…</p>
    <ul id="admin-list" class="admin-list"></ul>`);
  const summary = $('#admin-summary');
  const list = $('#admin-list');
  async function refreshAdmin() {
    try {
      const { accounts, storage } = await request('/admin/accounts');
      if (!list.isConnected || !dialog.open) return;
      summary.textContent = `${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'} · ${storage.files} ${storage.files === 1 ? 'file' : 'files'} · ${sizeLabel(storage.bytes)} used`;
      list.replaceChildren();
      for (const account of accounts) {
        const row = document.createElement('li');
        const profile = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = account.username;
        const status = document.createElement('p');
        status.textContent = account.role === 'admin' ? 'Administrator' : account.disabled ? 'Disabled' : 'Member';
        if (ipMode) {
          status.textContent = [status.textContent, account.ip, account.resetRequired ? 'Passphrase change required' : '']
            .filter(Boolean).join(' · ');
        }
        profile.append(name, status);
        row.append(profile);
        const actions = document.createElement('div');
        actions.className = 'row-actions';
        const url = `/admin/accounts/${encodeURIComponent(account.id)}`;
        if (ipMode) {
          const rename = makeButton('Rename', () => editIpAccount(account, false));
          rename.setAttribute('aria-label', `Rename ${account.username}`);
          actions.append(rename);
        }
        if (account.role !== 'admin') {
          if (ipMode) {
            const reset = makeButton('Reset passphrase', () => editIpAccount(account, true));
            reset.setAttribute('aria-label', `Reset passphrase for ${account.username}`);
            actions.append(reset);
          } else {
            const label = account.disabled ? 'Enable' : 'Disable';
            const button = makeButton(label, async () => {
              button.disabled = true;
              showError(dialogError);
              try {
                await request(url, { method: 'PATCH', body: { disabled: !account.disabled } });
                await refreshAdmin();
              } catch (error) {
                if (list.isConnected && dialog.open) showError(dialogError, error.message);
              } finally {
                button.disabled = false;
              }
            });
            button.setAttribute('aria-label', `${label} ${account.username}`);
            actions.append(button);
          }
          const remove = action(`Delete ${account.username}`, 'trash', () => {
            confirmRemoval('Delete account', `Permanently delete the account “${account.username}”? Shared files will stay in the drive.`,
              () => request(url, { method: 'DELETE' }),
              (dialogStillOpen) => { if (dialogStillOpen) openAdmin(); }, openAdmin);
          });
          actions.append(remove);
        }
        if (actions.childElementCount) row.append(actions);
        list.append(row);
      }
    } catch (error) {
      if (list.isConnected && dialog.open) {
        summary.textContent = '';
        showError(dialogError, error.message);
      }
    }
  }
  refreshAdmin();
}

$('#passphrase-form').addEventListener('submit', submitPassphrase);
$('#ip-register-form').addEventListener('submit', submitIpRegister);
$('#ip-login-form').addEventListener('submit', submitIpLogin);
$('#ip-change-form').addEventListener('submit', submitIpPasswordChange);
$('#ip-change-back').addEventListener('click', async () => {
  try {
    await request('/logout', { method: 'POST' });
    await loadSession();
  } catch (error) {
    showError($('#ip-error'), error.message);
  }
});
$('#close-dialog').addEventListener('click', () => dialog.close());
$('#close-preview').addEventListener('click', () => closePreview({ restoreFocus: true }));
document.addEventListener('click', (event) => {
  if (state.preview && !previewPanel.contains(event.target)) closePreview();
}, { capture: true });
contextMenu.addEventListener('keydown', (event) => {
  const items = [...contextMenu.querySelectorAll('[role="menuitem"]')];
  const index = items.indexOf(document.activeElement);
  const next = {
    ArrowDown: (index + 1) % items.length,
    ArrowUp: (index - 1 + items.length) % items.length,
    Home: 0,
    End: items.length - 1,
  }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  items[next].focus({ preventScroll: true });
});
document.addEventListener('keydown', (event) => {
  if (!contextMenu.hidden && ['Escape', 'Tab'].includes(event.key)) {
    if (event.key === 'Escape') event.preventDefault();
    closeContextMenu({ restoreFocus: true });
    return;
  }
  if (event.key === 'Escape' && state.preview && !dialog.open) closePreview({ restoreFocus: true });
});
document.addEventListener('pointerdown', (event) => {
  if (!contextMenu.contains(event.target)) closeContextMenu();
});
window.addEventListener('resize', () => closeContextMenu({ restoreFocus: true }));
window.addEventListener('scroll', () => closeContextMenu({ restoreFocus: true }), { passive: true });
$('#manage-categories').addEventListener('click', openCategoryManager);
$('#new-folder').addEventListener('click', () => nameDialog('create'));
const picker = $('#file-picker');
$('#upload-button').addEventListener('click', () => picker.click());
picker.addEventListener('change', () => {
  const files = [...picker.files];
  picker.value = '';
  uploadFiles(files);
});
const panel = $('.file-panel');
panel.addEventListener('contextmenu', (event) => {
  if (!state.folder) return;
  event.preventDefault();
  const entries = [{ label: 'New folder', glyph: 'folder-plus', onClick: () => nameDialog('create') }];
  if (!state.uploading) entries.push({ label: 'Upload files', glyph: 'upload', onClick: () => picker.click() });
  openContextMenu($('#new-folder'), [entries], event);
});
let fileDragDepth = 0;
const dropHint = $('#drop-hint');
const hasFiles = (event) => event.dataTransfer?.types.includes('Files');
const canDropFiles = () => Boolean(state.account && state.folder && !state.uploading);
const itemDragType = 'application/x-firesend-item';
let draggedItem;
let dropTarget;

function showDropTarget(target = null) {
  if (dropTarget === target) return;
  dropTarget?.classList.remove('is-drop-target');
  dropTarget = target;
  dropTarget?.classList.add('is-drop-target');
}

function itemDropTarget(event) {
  if (!draggedItem || state.folder?.id !== draggedItem.source || !event.dataTransfer.types.includes(itemDragType)) {
    return null;
  }
  const row = event.target.closest('[data-drop-folder]');
  return row && row.dataset.dropFolder !== draggedItem.id ? row : null;
}

$('#items').addEventListener('dragstart', (event) => {
  const id = event.target.closest('tr[draggable="true"]')?.dataset.itemId;
  if (!id || !state.folder || event.target.closest('a')) return;
  draggedItem = { id, source: state.folder.id };
  event.dataTransfer.setData(itemDragType, id);
  event.dataTransfer.effectAllowed = 'move';
});

async function moveDroppedItem(item, target) {
  try {
    showError(pageError);
    await request(`/items/${encodeURIComponent(item.id)}`, {
      method: 'PATCH', body: { parentId: target.dataset.dropFolder },
    });
    notice(`Moved to ${target.dataset.dropName}.`);
    if (state.folder?.id === item.source) await loadFolder(item.source, { refresh: true });
  } catch (error) {
    showError(pageError, error.message);
  }
}

function clearFileDrag() {
  fileDragDepth = 0;
  dropHint.hidden = true;
}

document.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  fileDragDepth++;
  dropHint.hidden = !canDropFiles();
});
document.addEventListener('dragover', (event) => {
  if (draggedItem) {
    const target = itemDropTarget(event);
    showDropTarget(target);
    if (target) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
    return;
  }
  if (!hasFiles(event)) return;
  event.preventDefault();
  const canDrop = canDropFiles();
  event.dataTransfer.dropEffect = canDrop ? 'copy' : 'none';
  dropHint.hidden = !canDrop;
});
document.addEventListener('dragleave', (event) => {
  if (dropTarget?.contains(event.target) && !dropTarget.contains(event.relatedTarget)) showDropTarget();
  if (fileDragDepth > 0 && --fileDragDepth === 0) dropHint.hidden = true;
});
document.addEventListener('drop', (event) => {
  clearFileDrag();
  if (draggedItem) {
    const target = itemDropTarget(event);
    const item = draggedItem;
    draggedItem = null;
    showDropTarget();
    if (target && event.dataTransfer.getData(itemDragType) === item.id) {
      event.preventDefault();
      moveDroppedItem(item, target);
    }
    return;
  }
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (canDropFiles()) uploadFiles([...event.dataTransfer.files]);
});
document.addEventListener('dragend', () => {
  clearFileDrag();
  draggedItem = null;
  showDropTarget();
});
window.addEventListener('blur', clearFileDrag);
setInterval(syncFolder, 2500);
document.addEventListener('visibilitychange', syncFolder);
window.addEventListener('popstate', () => loadFolder(currentFolder(), { focus: true }));
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});
try {
  applyTheme(localStorage.getItem('firesend:drive-theme') || config.defaultTheme);
} catch {
  applyTheme(config.defaultTheme);
}

loadSession().catch((error) => {
  if (state.authMode === 'passphrase') showPassphraseScreen(error.message);
  else if (state.authMode === 'ip') showIpScreen(error.message);
  else {
    setAccount(null);
    showError($('#access-error'), error.message);
  }
});
