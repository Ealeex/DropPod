import { button, fetchPreview, showMessage } from './common.mjs';
import { renderPreview } from './index.mjs';

export async function render(context) {
  const { host, item, signal } = context;
  showMessage(host, 'Loading archive…');
  const url = '/api/drive/files/' + encodeURIComponent(item.id) + '/archive';
  const response = await fetchPreview({ ...context, url }, 'Archive preview unavailable.', true);
  const data = await response.json();
  signal.throwIfAborted();
  const browser = createArchiveBrowser(context, data.entries);
  host.replaceChildren(browser.element);
  return browser.dispose;
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

function createArchiveBrowser(context, entries) {
  const { item, icon, sizeLabel } = context;
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
  let entryController;
  let disposeEntry;

  function showToolbar(back, label) {
    toolbar.replaceChildren();
    if (back) toolbar.append(button('Back', back, 'text-button'));
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
    closeEntry();
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
      const row = button('', () => goTo([...path, folderName]), 'archive-row');
      row.title = [...path, folderName].join('/');
      row.innerHTML = `<span class="item-icon folder-icon">${icon('folder')}</span><span class="archive-row-name"></span><span class="archive-row-meta"></span>`;
      row.querySelector('.archive-row-name').textContent = folderName;
      row.querySelector('.archive-row-meta').textContent = sizeLabel(child.size);
      const entry = document.createElement('li');
      entry.append(row);
      list.append(entry);
    }

    for (const file of files) {
      const row = button('', () => openEntry(file), 'archive-row');
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

  function closeEntry() {
    entryController?.abort();
    disposeEntry?.();
    disposeEntry = undefined;
  }

  async function openEntry(entry) {
    closeEntry();
    entryController = new AbortController();
    const { signal } = entryController;
    showToolbar(() => renderFolder(), `/${[...path, entry.name].join('/')}`);
    const host = document.createElement('div');
    host.className = 'archive-entry';
    content.replaceChildren(host);
    const dispose = await renderPreview({
      ...context, item: entry, host, url: archiveEntryUrl(item, entry), signal, archiveEntry: true,
    });
    if (signal.aborted) dispose?.();
    else disposeEntry = dispose;
  }

  renderFolder();

  return {
    element: container,
    dispose: closeEntry,
  };
}
