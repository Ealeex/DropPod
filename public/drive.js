const $ = (selector) => document.querySelector(selector);
const icon = (name) => `<svg aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;
const rootId = 'root';
const idPattern = /^(?:root|[a-f0-9-]{36})$/i;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const state = { account: null, folder: null, version: 0, uploading: false, accountReady: false, loading: false, preview: null };
const dialog = $('#dialog');
const dialogBody = $('#dialog-body');
const dialogError = $('#dialog-error');
const pageError = $('#page-error');
const previewPanel = $('#preview-panel');
const previewBody = $('#preview-content');
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
    if (response.status === 401 && state.account) setAccount(null);
    const error = new Error(data.error || 'The request failed.');
    error.status = response.status;
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
      setAccount(null);
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
  $('#access-screen').hidden = Boolean(account);
  $('#workspace').hidden = !account;
  renderAccount();
  if (!account) {
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
  state.preview = null;
  preview.trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus && preview.trigger.isConnected) preview.trigger.focus();
  previewPanel.classList.remove('is-open');
  previewPanel.inert = true;
  previewPanel.setAttribute('aria-hidden', 'true');
  previewBody.replaceChildren();
}

function previewMessage(message) {
  const text = document.createElement('p');
  text.className = 'preview-message';
  text.textContent = message;
  previewBody.replaceChildren(text);
}

async function openPreview(item, trigger, { focus = true } = {}) {
  closePreview();
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
  if (item.preview === 'text') {
    previewMessage('Loading preview…');
    try {
      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 401) setAccount(null);
        throw new Error('Preview unavailable.');
      }
      const text = await response.text();
      if (state.preview !== preview) return;
      const content = document.createElement('pre');
      content.textContent = text;
      previewBody.replaceChildren(content);
      if (item.previewTruncated) {
        const note = document.createElement('p');
        note.className = 'preview-message';
        note.textContent = 'Showing the first 128 KB.';
        previewBody.append(note);
      }
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
    media.addEventListener('error', () => {
      if (state.preview === preview) previewMessage('Preview unavailable. Download the file to open it.');
    });
    media.src = url;
    previewBody.replaceChildren(media);
    return;
  }
  previewMessage('Preview unavailable. Download the file to open it.');
}

function renderItem(item) {
  const row = document.createElement('tr');
  row.dataset.itemId = item.id;
  row.dataset.itemVersion = JSON.stringify(item);
  const nameCell = row.insertCell();
  const name = document.createElement('div');
  name.className = 'item-name';
  name.innerHTML = `<span class="item-icon ${item.kind === 'folder' ? 'folder-icon' : ''}">${icon(item.kind === 'folder' ? 'folder' : 'file')}</span>`;
  if (item.kind === 'folder') {
    name.append(folderLink(item.id, item.name));
  } else {
    const button = makeButton(item.name, () => openPreview(item, button), 'preview-trigger');
    button.setAttribute('aria-label', `Preview ${item.name}`);
    button.setAttribute('aria-controls', 'preview-panel');
    button.setAttribute('aria-expanded', 'false');
    name.append(button);
  }
  nameCell.append(name);
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

  if (JSON.stringify(previous?.path) !== JSON.stringify(folder.path)) {
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

  if (JSON.stringify(previous?.items) !== JSON.stringify(folder.items)) renderItems(folder.items);
  const empty = folder.items.length === 0;
  $('#file-table').hidden = empty;
  $('#empty-state').hidden = !empty;
  $('#empty-state').textContent = 'No files or folders';
}

function renderItems(items) {
  const table = $('#items');
  const existing = new Map([...table.rows].map((row) => [row.dataset.itemId, row]));
  const next = items.map((item) => {
    const row = existing.get(item.id);
    if (row?.dataset.itemVersion === JSON.stringify(item)) {
      existing.delete(item.id);
      return row;
    }
    return renderItem(item);
  });
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
    else openPreview(items[index], next[index].querySelector('.preview-trigger'), { focus: false });
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
    if (registering) {
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

function nameDialog(mode, item) {
  const folder = state.folder;
  if (!folder) return;
  if (!state.account) return accountDialog('login', () => nameDialog(mode, item));
  const renaming = mode === 'rename';
  showDialog(renaming ? 'Rename item' : 'New folder', `
    <form class="dialog-form">
      <label>${renaming ? 'Name' : 'Folder name'}<input name="name" maxlength="150" required autofocus></label>
      <div class="dialog-actions"><button type="button" class="button cancel-dialog">Cancel</button><button class="button primary" type="submit">${renaming ? 'Save name' : 'Create folder'}</button></div>
    </form>`);
  if (renaming) {
    const input = dialogBody.querySelector('input');
    input.value = item.name;
    input.select();
  }
  dialogBody.querySelector('.cancel-dialog').addEventListener('click', () => dialog.close());
  submitForm(async (fields, form) => {
    await request(renaming ? `/items/${item.id}` : `/folders/${folder.id}`, {
      method: renaming ? 'PATCH' : 'POST', body: { name: fields.get('name') },
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
  document.documentElement.dataset.theme = theme === 'vista' ? 'vista' : 'default';
}

function openSettings() {
  showDialog('Settings', `
    <fieldset class="theme-options">
      <legend>Theme</legend>
      <label class="theme-option">
        <input type="radio" name="drive-theme" value="default">
        <span class="theme-swatch theme-swatch-default" aria-hidden="true"></span>
        <span>Default</span>
      </label>
      <label class="theme-option">
        <input type="radio" name="drive-theme" value="vista">
        <span class="theme-swatch theme-swatch-vista" aria-hidden="true"></span>
        <span>Vista Glass</span>
      </label>
    </fieldset>`);
  const activeTheme = document.documentElement.dataset.theme || 'default';
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
  dialogBody.querySelector('input:checked').focus();
}

function openAdmin() {
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
        profile.append(name, status);
        row.append(profile);
        if (account.role !== 'admin') {
          const label = account.disabled ? 'Enable' : 'Disable';
          const button = makeButton(label, async () => {
            button.disabled = true;
            showError(dialogError);
            try {
              await request(`/admin/accounts/${account.id}`, { method: 'PATCH', body: { disabled: !account.disabled } });
              await refreshAdmin();
            } catch (error) {
              if (list.isConnected && dialog.open) showError(dialogError, error.message);
            } finally {
              button.disabled = false;
            }
          });
          button.setAttribute('aria-label', `${label} ${account.username}`);
          const actions = document.createElement('div');
          actions.className = 'row-actions';
          const remove = action(`Delete ${account.username}`, 'trash', () => {
            confirmRemoval('Delete account', `Permanently delete the account “${account.username}”? Shared files will stay in the drive.`,
              () => request(`/admin/accounts/${account.id}`, { method: 'DELETE' }),
              (dialogStillOpen) => { if (dialogStillOpen) openAdmin(); }, openAdmin);
          });
          actions.append(button, remove);
          row.append(actions);
        }
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

$('#close-dialog').addEventListener('click', () => dialog.close());
$('#close-preview').addEventListener('click', () => closePreview({ restoreFocus: true }));
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
  if (!hasFiles(event)) return;
  event.preventDefault();
  const canDrop = canDropFiles();
  event.dataTransfer.dropEffect = canDrop ? 'copy' : 'none';
  dropHint.hidden = !canDrop;
});
document.addEventListener('dragleave', () => {
  if (fileDragDepth > 0 && --fileDragDepth === 0) dropHint.hidden = true;
});
document.addEventListener('drop', (event) => {
  clearFileDrag();
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (canDropFiles()) uploadFiles([...event.dataTransfer.files]);
});
document.addEventListener('dragend', clearFileDrag);
window.addEventListener('blur', clearFileDrag);
setInterval(syncFolder, 2500);
document.addEventListener('visibilitychange', syncFolder);
window.addEventListener('popstate', () => loadFolder(currentFolder(), { focus: true }));
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});
try {
  applyTheme(localStorage.getItem('firesend:drive-theme'));
} catch {
  applyTheme('default');
}

request('/session').then(({ account }) => setAccount(account)).catch((error) => {
  setAccount(null);
  showError($('#access-error'), error.message);
});
