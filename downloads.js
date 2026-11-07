const { spawn } = require('node:child_process');
const { copyFile, link, mkdir, mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');

function archiveName(name, used = new Set()) {
  let safe = name.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '');
  if (!safe || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?: *\.|$)/i.test(safe)) safe = '_' + safe;
  const extension = path.extname(safe);
  const base = safe.slice(0, safe.length - extension.length);
  let candidate = safe;
  for (let suffix = 2; used.has(candidate.toLowerCase()); suffix++) {
    candidate = `${base} (${suffix})${extension}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

async function stageFolder(workspace, item, entries, uploads, signal) {
  const children = new Map();
  for (const entry of entries) {
    if (entry.id === item.id) continue;
    if (!children.has(entry.parent_id)) children.set(entry.parent_id, []);
    children.get(entry.parent_id).push(entry);
  }

  const root = archiveName(item.name);
  const pending = [{ id: item.id, directory: path.join(workspace, root) }];
  while (pending.length) {
    signal.throwIfAborted();
    const { id, directory } = pending.pop();
    await mkdir(directory);
    const used = new Set();
    const siblings = children.get(id) || [];
    // Reserve ordinary names first so substitutions cannot displace them.
    const names = new Map(siblings.filter(({ name }) => archiveName(name) === name)
      .map(({ id, name }) => [id, archiveName(name, used)]));
    for (const entry of siblings) {
      signal.throwIfAborted();
      const target = path.join(directory, names.get(entry.id) || archiveName(entry.name, used));
      if (entry.kind === 'folder') {
        pending.push({ id: entry.id, directory: target });
      } else {
        const source = path.join(uploads, entry.id);
        await link(source, target).catch((error) => {
          if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EMLINK'].includes(error.code)) throw error;
          return copyFile(source, target);
        });
      }
    }
  }
  return root;
}

function compressFolder(sevenZip, directory, output, folder, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZip, [
      'a', '-tzip', '-mx=5', '-mcu=on', '-bsp1', '-bso0', '-bse2', '-sccUTF-8', '-spd', '-y', '--', output, folder,
    ], { cwd: directory, windowsHide: true, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let errorText = '';
    let failure;
    let percent = 0;
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      const output = tail + chunk;
      for (const match of output.matchAll(/(?<!\d)(\d{1,3})%/g)) {
        const next = Number(match[1]);
        if (next > percent && next <= 100) {
          percent = next;
          onProgress(percent / 100);
        }
      }
      tail = output.match(/\d{1,3}$/)?.[0] || '';
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { errorText = (errorText + chunk).slice(-4096); });
    child.on('error', (error) => { failure = error; });
    child.on('close', (code) => {
      if (failure?.code === 'ENOENT') {
        return reject(Object.assign(new Error('Folder downloads require 7-Zip on the server.'), { status: 501 }));
      }
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(errorText.trim() || `7-Zip exited with code ${code}.`));
      resolve();
    });
  });
}

function sendAttachment(res, source, name, options, update) {
  return new Promise((resolve, reject) => {
    res.once('pipe', (stream) => {
      const total = Number(res.getHeader('Content-Length'));
      let sent = 0;
      update('downloading', total > 0 ? 0 : null);
      if (total > 0) stream.on('data', (chunk) => {
        sent += chunk.length;
        update('downloading', Math.min(sent / total, 1));
      });
    });
    res.download(source, name, { cacheControl: false, ...options }, (error) => {
      if (error) return reject(error);
      if (res.writableFinished) return resolve();
      res.once('finish', resolve);
      res.once('close', () => res.writableFinished ? resolve() : reject(new Error('Download interrupted.')));
    });
  });
}

function createDownloads({ data, uploads, sevenZip }) {
  const transfers = new Map();
  let activeArchives = 0;
  setInterval(() => {
    for (const [id, transfer] of transfers) {
      if (transfer.finishedAt && transfer.finishedAt < Date.now() - 5 * 60_000) transfers.delete(id);
    }
  }, 60_000).unref();

  async function send(req, res, item, getEntries, track = false) {
    const id = req.query.transfer;
    const transfer = track && req.method === 'GET' && typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)
      && !transfers.has(id) && transfers.size < 4096 ? {} : null;
    if (transfer) transfers.set(id, transfer);
    function update(phase, progress = null, error) {
      if (!transfer) return;
      if (transfer.phase !== phase) transfer.startedAt = Date.now();
      Object.assign(transfer, { phase, progress, error });
      if (phase === 'done' || phase === 'error') transfer.finishedAt = Date.now();
    }

    update('preparing');
    let workspace;
    let archived = false;
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      if (item.kind === 'file') {
        await sendAttachment(res, item.id, item.name, {
          root: uploads, headers: { 'Content-Type': 'application/octet-stream' },
        }, update);
      } else {
        const name = `${item.name}.zip`;
        if (req.method === 'HEAD') return res.attachment(name).end();
        if (activeArchives >= 2) {
          throw Object.assign(new Error('The server is handling other folder downloads. Try again shortly.'), { status: 503 });
        }
        activeArchives++;
        archived = true;
        workspace = await mkdtemp(path.join(data, 'download-'));
        const staging = path.join(workspace, 'files');
        await mkdir(staging);
        const root = await stageFolder(staging, item, getEntries(item.id), uploads, controller.signal);
        const archive = 'folder.zip';
        update('compressing', 0);
        await compressFolder(sevenZip, staging, path.join(workspace, archive), root, controller.signal,
          (fraction) => update('compressing', fraction));
        controller.signal.throwIfAborted();
        await sendAttachment(res, archive, name, { root: workspace, acceptRanges: false }, update);
      }
      update('done', 1);
    } catch (error) {
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
      const message = controller.signal.aborted ? 'Download interrupted.'
        : status === 404 ? 'A file is no longer available.'
          : status === 500 ? 'The download could not be prepared.' : error.message;
      update('error', null, message);
      if (status === 500 && !controller.signal.aborted) console.error(error);
      if (!res.destroyed) {
        if (res.headersSent) res.destroy(error);
        else {
          res.removeHeader('Content-Disposition');
          res.removeHeader('Content-Length');
          res.status(status).type('json').json({ error: message });
        }
      }
    } finally {
      if (archived) activeArchives--;
      if (workspace) await rm(workspace, { recursive: true, force: true, maxRetries: 3 }).catch(console.error);
    }
  }
  return { send, status: (id) => transfers.get(id) };
}

module.exports = { createDownloads };
