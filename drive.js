const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { open, unlink } = require('node:fs/promises');

const deriveKey = promisify(scrypt);
const sessionCookie = 'firesend_session';
const sessionDuration = 7 * 24 * 60 * 60 * 1000;
const usernamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/;
const authWindow = 15 * 60 * 1000;

const previewFormats = new Map(Object.entries({
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain', '.md': 'text/plain', '.csv': 'text/plain', '.tsv': 'text/plain',
  '.json': 'text/plain', '.log': 'text/plain', '.gltf': 'text/plain',
}));
const maxTextPreview = 128 * 1024;

function previewFormat(name) {
  return previewFormats.get(path.extname(name).toLowerCase());
}

function openDrive(data) {
  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(path.join(data, 'drive.sqlite'));
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS drive_accounts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
      disabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drive_sessions (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES drive_accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS drive_sessions_account ON drive_sessions(account_id);
    CREATE INDEX IF NOT EXISTS drive_sessions_expiry ON drive_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS drive_items (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES drive_items(id),
      kind TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      size INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE (parent_id, name_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS drive_category_names ON drive_items(name_key) WHERE parent_id IS NULL;
    CREATE TABLE IF NOT EXISTS drive_categories (
      id TEXT PRIMARY KEY REFERENCES drive_items(id),
      position INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drive_blob_cleanup (id TEXT PRIMARY KEY);
    INSERT OR IGNORE INTO drive_items (id, parent_id, kind, name, name_key, updated_at)
      VALUES ('root', NULL, 'folder', 'Shared drive', 'shared drive', 0);
    INSERT OR IGNORE INTO drive_categories (id, position) VALUES ('root', 0);
  `);
  return db;
}

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

function tokenFrom(req) {
  const cookie = (req.get('cookie') || '').split(';').map((entry) => entry.trim())
    .find((entry) => entry.startsWith(sessionCookie + '='));
  const token = cookie?.slice(sessionCookie.length + 1);
  return /^[a-f0-9]{64}$/.test(token || '') ? token : null;
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const key = await deriveKey(password, salt, 64);
  return salt + ':' + key.toString('hex');
}

function publicAccount(account) {
  return { id: account.id, username: account.username, role: account.role };
}

function itemName(input) {
  if (typeof input !== 'string') return null;
  const name = input.trim().normalize('NFC');
  return name && name.length <= 150 && name !== '.' && name !== '..' && !/[\x00-\x1f\x7f/\\]/.test(name) ? name : null;
}

function createDriveRouter({ data, uploads, upload, removeBlob }) {
  const router = express.Router();
  const db = openDrive(data);
  const getItem = db.prepare('SELECT * FROM drive_items WHERE id = ?');
  const getCategories = db.prepare(`
    SELECT c.id, i.name, c.position
    FROM drive_categories c JOIN drive_items i ON i.id = c.id
    ORDER BY c.position, c.id
  `);
  const getAccount = db.prepare('SELECT * FROM drive_accounts WHERE username = ?');
  const removeSession = db.prepare('DELETE FROM drive_sessions WHERE token_hash = ?');
  const removeExpired = db.prepare('DELETE FROM drive_sessions WHERE expires_at <= ?');
  const insertItem = db.prepare(`
    INSERT INTO drive_items (id, parent_id, kind, name, name_key, size, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (parent_id, name_key) DO NOTHING
  `);
  const getLineage = db.prepare(`
    WITH RECURSIVE lineage(id, parent_id, name, depth) AS (
      SELECT id, parent_id, name, 0 FROM drive_items WHERE id = ?
      UNION ALL
      SELECT i.id, i.parent_id, i.name, l.depth + 1 FROM drive_items i JOIN lineage l ON i.id = l.parent_id
    )
    SELECT id, name FROM lineage ORDER BY depth DESC
  `);

  const descendants = `
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM drive_items WHERE id = ?
      UNION ALL
      SELECT i.id FROM drive_items i JOIN descendants d ON i.parent_id = d.id
    )
  `;
  const queueDeletedFiles = db.prepare(descendants + `
    INSERT OR IGNORE INTO drive_blob_cleanup (id)
    SELECT id FROM drive_items WHERE kind = 'file' AND id IN (SELECT id FROM descendants)
  `);
  const deleteTree = db.prepare(descendants + 'DELETE FROM drive_items WHERE id IN (SELECT id FROM descendants)');
  const pendingCleanup = db.prepare('SELECT id FROM drive_blob_cleanup');
  const finishCleanup = db.prepare('DELETE FROM drive_blob_cleanup WHERE id = ?');
  let cleaning = false;

  async function cleanDeletedFiles() {
    if (cleaning) return;
    cleaning = true;
    try {
      for (const { id } of pendingCleanup.all()) {
        try {
          await unlink(path.join(uploads, id));
        } catch (error) {
          if (error.code !== 'ENOENT') {
            console.error(error);
            continue;
          }
        }
        finishCleanup.run(id);
      }
    } finally {
      cleaning = false;
    }
  }

  cleanDeletedFiles().catch(console.error);
  setInterval(() => cleanDeletedFiles().catch(console.error), 60_000).unref();

  function cookieOptions(req) {
    return { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' };
  }

  function startSession(req, res, account) {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    if (req.driveToken) removeSession.run(hashToken(req.driveToken));
    removeExpired.run(now);
    db.prepare('INSERT INTO drive_sessions VALUES (?, ?, ?)').run(hashToken(token), account.id, now + sessionDuration);
    res.clearCookie(sessionCookie, { ...cookieOptions(req), path: '/api/drive' });
    res.cookie(sessionCookie, token, { ...cookieOptions(req), maxAge: sessionDuration });
  }

  router.use((req, res, next) => {
    const origin = req.get('origin');
    if (!['GET', 'HEAD'].includes(req.method) && origin && origin !== `${req.protocol}://${req.get('host')}`) {
      return res.status(403).json({ error: 'Use the FireSend page to make this change.' });
    }
    readSession(req, res, next);
  });

  function readSession(req, res, next) {
    req.driveToken = tokenFrom(req);
    if (req.driveToken) {
      req.driveAccount = db.prepare(`
        SELECT a.id, a.username, a.role, s.expires_at FROM drive_sessions s
        JOIN drive_accounts a ON a.id = s.account_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND a.disabled = 0
      `).get(hashToken(req.driveToken), Date.now());
    }
    next();
  }

  function requireMember(req, res, next) {
    if (!req.driveAccount) return res.status(401).json({ error: 'Sign in to make this change.' });
    next();
  }

  function requireAdmin(req, res, next) {
    if (req.driveAccount?.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    next();
  }

  const authAttempts = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [address, bucket] of authAttempts) {
      if (bucket.until <= now) authAttempts.delete(address);
    }
  }, authWindow).unref();

  function limitAuth(req, res, next) {
    const address = req.ip;
    const now = Date.now();
    let bucket = authAttempts.get(address);
    if (!bucket || bucket.until <= now) {
      if (!bucket && authAttempts.size >= 4096) {
        return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      }
      bucket = { count: 0, until: now + authWindow };
      authAttempts.set(address, bucket);
    }
    if (++bucket.count > 20) {
      res.set('Retry-After', String(Math.ceil((bucket.until - now) / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    next();
  }

  router.get('/session', (req, res) => {
    if (req.driveAccount) {
      res.clearCookie(sessionCookie, { ...cookieOptions(req), path: '/api/drive' });
      res.cookie(sessionCookie, req.driveToken, { ...cookieOptions(req), expires: new Date(req.driveAccount.expires_at) });
    }
    res.json({ account: req.driveAccount ? publicAccount(req.driveAccount) : null });
  });

  router.post('/register', limitAuth, async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = req.body?.password;
    if (!usernamePattern.test(username) || typeof password !== 'string' || password.length < 10 || password.length > 128) {
      return res.status(400).json({ error: 'Use a 3–32 character username and a 10–128 character password.' });
    }
    const id = randomUUID();
    const passwordHash = await hashPassword(password);
    const account = db.prepare(`
      WITH bootstrap(first_account) AS (SELECT NOT EXISTS (SELECT 1 FROM drive_accounts))
      INSERT INTO drive_accounts (id, username, password_hash, role, disabled, created_at)
      SELECT ?, ?, ?, CASE WHEN first_account THEN 'admin' ELSE 'member' END, 1 - first_account, ?
      FROM bootstrap WHERE true
      ON CONFLICT (username) DO NOTHING
      RETURNING id, username, role, disabled
    `).get(id, username, passwordHash, Date.now());
    if (!account) return res.status(409).json({ error: 'That username is already taken.' });
    if (account.disabled) return res.status(201).json({ status: 'pending-approval' });
    startSession(req, res, account);
    res.status(201).json({ account: publicAccount(account) });
  });

  router.post('/login', limitAuth, async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = req.body?.password;
    if (!usernamePattern.test(username) || typeof password !== 'string' || password.length > 128) {
      return res.status(400).json({ error: 'Enter a valid username and password.' });
    }
    const initialAccount = getAccount.get(username);
    const stored = initialAccount?.password_hash || '00000000000000000000000000000000:' + '0'.repeat(128);
    const actual = await hashPassword(password, stored.split(':', 1)[0]);
    const account = getAccount.get(username);
    if (!timingSafeEqual(Buffer.from(stored), Buffer.from(actual)) || !account || account.disabled || account.password_hash !== stored) {
      return res.status(401).json({ error: 'That username or password is incorrect, or the account is disabled.' });
    }
    startSession(req, res, account);
    res.json({ account: publicAccount(account) });
  });

  router.post('/logout', (req, res) => {
    if (req.driveToken) removeSession.run(hashToken(req.driveToken));
    res.clearCookie(sessionCookie, { ...cookieOptions(req), path: '/api/drive' });
    res.clearCookie(sessionCookie, cookieOptions(req)).sendStatus(204);
  });

  router.use(requireMember);

  router.post('/categories', (req, res) => {
    const name = itemName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Enter a category name of up to 150 characters without slashes.' });
    const id = randomUUID();
    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const result = db.prepare(`
        INSERT INTO drive_items (id, kind, name, name_key, updated_at)
        VALUES (?, 'folder', ?, ?, ?)
        ON CONFLICT (name_key) WHERE parent_id IS NULL DO NOTHING
      `).run(id, name, name.toLowerCase(), Date.now());
      if (!result.changes) return res.status(409).json({ error: 'A category with that name already exists.' });
      db.prepare(`
        INSERT INTO drive_categories (id, position)
        SELECT ?, coalesce(max(position), -1) + 1 FROM drive_categories
      `).run(id);
      db.exec('COMMIT');
      committed = true;
    } finally {
      if (!committed) db.exec('ROLLBACK');
    }
    res.status(201).json({ id });
  });

  router.patch('/categories/:id', (req, res) => {
    const { name: input, direction } = req.body || {};
    const name = itemName(input);
    const renaming = input !== undefined && direction === undefined;
    const reordering = input === undefined && ['up', 'down'].includes(direction);
    if ((!renaming || !name) && !reordering) {
      return res.status(400).json({ error: 'Choose a valid category name or move direction.' });
    }

    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const categories = getCategories.all();
      const index = categories.findIndex(({ id }) => id === req.params.id);
      if (index < 0) return res.status(404).json({ error: 'Category not found.' });
      const category = categories[index];
      if (renaming) {
        const result = db.prepare(`
          UPDATE OR IGNORE drive_items SET name = ?, name_key = ?, updated_at = ? WHERE id = ?
        `).run(name, name.toLowerCase(), Date.now(), category.id);
        if (!result.changes) return res.status(409).json({ error: 'A category with that name already exists.' });
      } else {
        const neighbor = categories[index + (direction === 'up' ? -1 : 1)];
        if (neighbor) {
          const setPosition = db.prepare('UPDATE drive_categories SET position = ? WHERE id = ?');
          setPosition.run(neighbor.position, category.id);
          setPosition.run(category.position, neighbor.id);
        }
      }
      db.exec('COMMIT');
      committed = true;
    } finally {
      if (!committed) db.exec('ROLLBACK');
    }
    res.sendStatus(204);
  });

  router.get('/folders/:id', (req, res) => {
    const folder = getItem.get(req.params.id);
    if (folder?.kind !== 'folder') return res.status(404).json({ error: 'Folder not found.' });
    const items = db.prepare(`
      SELECT id, kind, name, size, updated_at AS updatedAt FROM drive_items
      WHERE parent_id = ? ORDER BY kind DESC, name_key, id
    `).all(folder.id);
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const format = previewFormat(item.name);
      item.preview = format?.split('/')[0] || null;
      item.previewTruncated = item.preview === 'text' && item.size > maxTextPreview;
    }
    const categories = getCategories.all().map(({ id, name }) => ({ id, name }));
    res.json({ id: folder.id, path: getLineage.all(folder.id), items, categories });
  });

  router.post('/folders/:id', (req, res) => {
    const folder = getItem.get(req.params.id);
    if (folder?.kind !== 'folder') return res.status(404).json({ error: 'Folder not found.' });
    const name = itemName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Enter a folder name of up to 150 characters without slashes.' });
    const id = randomUUID();
    if (!insertItem.run(id, folder.id, 'folder', name, name.toLowerCase(), null, Date.now()).changes) {
      return res.status(409).json({ error: 'An item with that name already exists here.' });
    }
    res.status(201).json({ id });
  });

  router.patch('/items/:id', (req, res) => {
    const item = getItem.get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    if (item.parent_id === null) return res.status(400).json({ error: 'Use category controls to rename or reorder this category.' });
    const name = req.body?.name === undefined ? item.name : itemName(req.body.name);
    const parentId = req.body?.parentId === undefined ? item.parent_id : req.body.parentId;
    if (!name || typeof parentId !== 'string') return res.status(400).json({ error: 'Choose a valid name and destination.' });

    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const parent = getItem.get(parentId);
      if (parent?.kind !== 'folder') return res.status(404).json({ error: 'Destination folder not found.' });
      if (item.kind === 'folder' && getLineage.all(parentId).some(({ id }) => id === item.id)) {
        return res.status(400).json({ error: 'A folder cannot be moved into itself or one of its subfolders.' });
      }
      const updated = db.prepare(`
        UPDATE OR IGNORE drive_items SET name = ?, name_key = ?, parent_id = ?, updated_at = ? WHERE id = ?
      `).run(name, name.toLowerCase(), parentId, Date.now(), item.id);
      if (!updated.changes) return res.status(409).json({ error: 'An item with that name already exists there.' });
      db.exec('COMMIT');
      committed = true;
    } finally {
      if (!committed) db.exec('ROLLBACK');
    }
    res.sendStatus(204);
  });

  router.delete('/items/:id', (req, res) => {
    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const item = getItem.get(req.params.id);
      if (!item) return res.status(404).json({ error: 'Item not found.' });
      if (item.parent_id === null) return res.status(400).json({ error: 'Categories cannot be deleted here.' });
      queueDeletedFiles.run(item.id);
      deleteTree.run(item.id);
      db.exec('COMMIT');
      committed = true;
    } finally {
      if (!committed) db.exec('ROLLBACK');
    }
    cleanDeletedFiles().catch(console.error);
    res.sendStatus(204);
  });

  router.post('/folders/:id/files', (req, res, next) => {
    const folder = getItem.get(req.params.id);
    if (folder?.kind !== 'folder') return res.status(404).json({ error: 'Folder not found.' });
    upload(req, res, async (error) => {
      if (error) return next(error);
      if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
      const { filename: id, size, originalname } = req.file;
      const name = itemName(originalname);
      try {
        if (!name) {
          await removeBlob(id);
          return res.status(400).json({ error: 'Use a filename of up to 150 characters without slashes.' });
        }
        if (!getItem.get(folder.id)) {
          await removeBlob(id);
          return res.status(404).json({ error: 'This folder was deleted during the upload.' });
        }
        if (!insertItem.run(id, folder.id, 'file', name, name.toLowerCase(), size, Date.now()).changes) {
          await removeBlob(id);
          return res.status(409).json({ error: 'An item with that name already exists here.' });
        }
      } catch (failure) {
        await removeBlob(id);
        return next(failure);
      }
      res.status(201).json({ id });
    });
  });

  router.get('/files/:id/preview', async (req, res) => {
    const file = getItem.get(req.params.id);
    if (file?.kind !== 'file') return res.status(404).json({ error: 'File not found.' });
    const format = previewFormat(file.name);
    if (!format) return res.status(415).json({ error: 'Preview is unavailable for this file type.' });
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type(format);
    if (format !== 'text/plain') return res.sendFile(file.id, { root: uploads, cacheControl: false });

    const handle = await open(path.join(uploads, file.id), 'r');
    try {
      const buffer = Buffer.alloc(Math.min(file.size, maxTextPreview));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      res.send(buffer.toString('utf8', 0, bytesRead));
    } finally {
      await handle.close();
    }
  });

  router.get('/files/:id/download', (req, res, next) => {
    const file = getItem.get(req.params.id);
    if (file?.kind !== 'file') return res.status(404).json({ error: 'File not found.' });
    res.download(file.id, file.name, { root: uploads, headers: { 'Content-Type': 'application/octet-stream' } }, (error) => {
      if (error) next(error);
    });
  });

  router.get('/admin/accounts', requireAdmin, (req, res) => {
    const accounts = db.prepare(`
      SELECT id, username, role, disabled, created_at AS createdAt
      FROM drive_accounts ORDER BY username
    `).all();
    const storage = db.prepare(`
      SELECT count(*) AS files, coalesce(sum(size), 0) AS bytes FROM drive_items WHERE kind = 'file'
    `).get();
    res.json({ accounts, storage });
  });

  router.patch('/admin/accounts/:id', requireAdmin, (req, res) => {
    const disabled = req.body?.disabled;
    if (typeof disabled !== 'boolean') return res.status(400).json({ error: 'Choose a valid account status.' });
    const target = db.prepare('SELECT role FROM drive_accounts WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'Account not found.' });
    if (target.role === 'admin') return res.status(400).json({ error: 'Administrator accounts are managed on the host.' });
    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      db.prepare("UPDATE drive_accounts SET disabled = ? WHERE id = ? AND role = 'member'").run(Number(disabled), req.params.id);
      if (disabled) db.prepare('DELETE FROM drive_sessions WHERE account_id = ?').run(req.params.id);
      db.exec('COMMIT');
      committed = true;
    } finally {
      if (!committed) db.exec('ROLLBACK');
    }
    res.sendStatus(204);
  });

  router.delete('/admin/accounts/:id', requireAdmin, (req, res) => {
    const id = req.params.id;
    const removed = db.prepare("DELETE FROM drive_accounts WHERE id = ? AND role = 'member'").run(id);
    if (removed.changes) return res.sendStatus(204);
    const exists = db.prepare('SELECT 1 FROM drive_accounts WHERE id = ?').get(id);
    if (!exists) return res.status(404).json({ error: 'Account not found.' });
    res.status(400).json({ error: 'Administrator accounts are managed on the host.' });
  });

  return { router, readSession, requireMember };
}

module.exports = { createDriveRouter, openDrive };
