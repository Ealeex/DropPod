const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { execFile, spawn } = require('node:child_process');
const { createReadStream, createWriteStream, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createGunzip } = require('node:zlib');
const { isIP } = require('node:net');
const path = require('node:path');
const { mkdtemp, open, rm, unlink } = require('node:fs/promises');
const { createMediaPreviews } = require('./media-preview');
const { createOfficePreviews, officeFormats } = require('./office-preview');
const { createDownloads } = require('./downloads');
const { resolveSevenZip } = require('./tool-paths');

const deriveKey = promisify(scrypt);
const sessionCookie = 'firesend_session';
const passphraseCookie = 'firesend_passphrase';
const ipCookie = 'firesend_ip';
const sessionDuration = 7 * 24 * 60 * 60 * 1000;
const usernamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/;
const friendlyNamePattern = /^[^\x00-\x1f\x7f/\\]{1,40}$/;
const authWindow = 15 * 60 * 1000;

const previewFormats = new Map(Object.entries({
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain', '.md': 'text/plain', '.csv': 'text/plain', '.tsv': 'text/plain',
  '.json': 'text/plain', '.log': 'text/plain', '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary', '.stl': 'model/stl',
  '.dae': 'model/vnd.collada+xml', '.obj': 'model/obj', '.mtl': 'text/plain', '.pdf': 'application/pdf',
  '.fbx': 'model/fbx',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}));
const codeLanguages = new Map(Object.entries({
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.py': 'python', '.pyw': 'python', '.rb': 'ruby', '.php': 'php', '.pl': 'perl', '.lua': 'lua',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.cs': 'csharp',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.go': 'go', '.rs': 'rust', '.swift': 'swift', '.m': 'objectivec',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.ps1': 'powershell', '.psm1': 'powershell',
  '.html': 'xml', '.htm': 'xml', '.xml': 'xml', '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.json': 'json', '.jsonc': 'json', '.gltf': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'ini', '.ini': 'ini',
  '.sql': 'sql', '.graphql': 'graphql', '.diff': 'diff', '.patch': 'diff', '.md': 'markdown',
  makefile: 'makefile', dockerfile: 'dockerfile',
}));
const archiveFormats = new Map(Object.entries({ '.zip': 'zip', '.7z': '7z', '.rar': 'rar', '.tar': 'tar', '.tgz': 'tar.gz' }));
const convertedFormats = new Map([
  ...['.mov', '.mkv', '.avi', '.wmv', '.asf', '.flv', '.m4v', '.mpg', '.mpeg', '.m2ts', '.3gp', '.3g2', '.ogv']
    .map((extension) => [extension, 'video']),
  ...['.flac', '.aac', '.aif', '.aiff', '.wma', '.opus', '.oga', '.caf', '.au', '.amr', '.ape', '.ac3', '.eac3', '.wv']
    .map((extension) => [extension, 'audio']),
  ...['.tif', '.tiff', '.heic', '.heif', '.jxl', '.jp2', '.psd', '.qoi']
    .map((extension) => [extension, 'image']),
]);
const compatibleMediaTypes = new Map([['image', 'image/png'], ['audio', 'audio/mp4'], ['video', 'video/mp4']]);
const maxTextPreview = 128 * 1024;
const maxArchiveEntry = 64 * 1024 * 1024;
const maxExpandedTar = 256 * 1024 * 1024;
const maxArchiveEntries = 50_000;

function codeLanguage(name) {
  const lower = name.toLowerCase();
  return codeLanguages.get(lower) || codeLanguages.get(path.extname(lower));
}

function previewFormat(name) {
  return previewFormats.get(path.extname(name).toLowerCase()) || (codeLanguage(name) ? 'text/plain' : null);
}

function archiveFormat(name) {
  const lower = name.toLowerCase();
  return lower.endsWith('.tar.gz') ? 'tar.gz' : archiveFormats.get(path.extname(lower)) || null;
}

function previewKind(name, { archiveEntry = false } = {}) {
  if (archiveFormat(name)) return 'archive';
  const extension = path.extname(name).toLowerCase();
  if (!archiveEntry && officeFormats.has(extension)) return 'office';
  if (extension === '.xlsx') return archiveEntry ? null : 'spreadsheet';
  if (archiveEntry && extension === '.gltf') return 'text';
  const format = previewFormat(name);
  if (!format) return archiveEntry ? null : convertedFormats.get(extension) || null;
  if (format.startsWith('model/')) return 'model';
  if (format === 'application/pdf') return 'pdf';
  return format.split('/')[0];
}

function runSevenZip(command, args, { maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8', maxBuffer, timeout: 60_000, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        error.output = (stderr || stdout || '').trim();
        return reject(error);
      }
      resolve(stdout);
    });
  });
}

function parseArchiveListing(output) {
  const records = [];
  let record = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      if (record) records.push(record);
      record = null;
      continue;
    }
    const separator = line.indexOf(' = ');
    if (separator < 0) continue;
    record ??= {};
    record[line.slice(0, separator).trim()] = line.slice(separator + 3);
  }
  if (record) records.push(record);

  const entries = [];
  for (const item of records) {
    if (!item.Path) continue;
    const name = item.Path.split(/[\\/]/).pop() || item.Path;
    const folder = item.Folder === '+' || (item.Folder === undefined &&
      (item.Attributes?.startsWith('D') || item.Mode?.startsWith('d')));
    const size = Number(item.Size) || 0;
    const kind = folder ? null : previewKind(name, { archiveEntry: true });
    const preview = kind === 'model' || kind === 'archive' ? null : kind;
    entries.push({
      path: item.Path,
      name,
      folder,
      size,
      modified: item.Modified || null,
      encrypted: item.Encrypted === '+',
      preview,
      ...(preview === 'text' && { language: codeLanguage(name) }),
      previewTruncated: preview === 'text' && size > maxTextPreview,
    });
    if (entries.length >= maxArchiveEntries) break;
  }
  entries.sort((a, b) => (a.folder === b.folder ? a.path.localeCompare(b.path) : a.folder ? -1 : 1));
  return entries;
}

function extractArchiveEntry(command, archivePath, entry) {
  return new Promise((resolve, reject) => {
    const maxBytes = entry.preview === 'text' ? maxTextPreview : maxArchiveEntry;
    const child = spawn(command, [
      'x', '-so', '-bd', '-y', '-spd', '-sccUTF-8', '--', archivePath, entry.path,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let errorText = '';
    let reachedLimit = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 60_000);

    child.stdout.on('data', (chunk) => {
      if (reachedLimit) return;
      const remaining = maxBytes - size;
      const piece = chunk.subarray(0, remaining);
      chunks.push(piece);
      size += piece.length;
      if (chunk.length > remaining) {
        reachedLimit = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { errorText = (errorText + chunk).slice(-4096); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) return reject(new Error('7-Zip extraction timed out.'));
      if (reachedLimit && !entry.previewTruncated) return reject(new Error('Archive entry exceeded the preview limit.'));
      if (code === 0 || reachedLimit) return resolve(Buffer.concat(chunks, size));
      const detail = errorText.trim().split(/\r?\n/).filter(Boolean).at(-1);
      reject(new Error(detail || `7-Zip exited with code ${code}.`));
    });
  });
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
    CREATE TABLE IF NOT EXISTS drive_ip_users (
      ip TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      passphrase_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
      must_change INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drive_shared_auth (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      passphrase_hash TEXT
    );
    INSERT OR IGNORE INTO drive_shared_auth (id) VALUES (1);
    CREATE TABLE IF NOT EXISTS drive_items (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES drive_items(id),
      kind TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      size INTEGER,
      created_by TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE (parent_id, name_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS drive_category_names ON drive_items(name_key) WHERE parent_id IS NULL;
    CREATE TABLE IF NOT EXISTS drive_share_links (
      token_hash TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES drive_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS drive_share_links_item ON drive_share_links(item_id);
    CREATE TABLE IF NOT EXISTS drive_categories (
      id TEXT PRIMARY KEY REFERENCES drive_items(id),
      position INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drive_blob_cleanup (id TEXT PRIMARY KEY);
    INSERT OR IGNORE INTO drive_items (id, parent_id, kind, name, name_key, updated_at)
      VALUES ('root', NULL, 'folder', 'Shared drive', 'shared drive', 0);
    INSERT OR IGNORE INTO drive_categories (id, position) VALUES ('root', 0);
  `);
  const itemColumns = db.prepare('PRAGMA table_info(drive_items)').all();
  if (!itemColumns.some((column) => column.name === 'created_by')) {
    db.exec('ALTER TABLE drive_items ADD COLUMN created_by TEXT');
  }
  const ipColumns = () => new Set(db.prepare('PRAGMA table_info(drive_ip_users)').all().map(({ name }) => name));
  const columns = ipColumns();
  if (!columns.has('role') || !columns.has('must_change')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = ipColumns();
      if (!current.has('role')) {
        db.exec(`
          ALTER TABLE drive_ip_users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin'));
          UPDATE drive_ip_users SET role = 'admin'
          WHERE ip = (SELECT ip FROM drive_ip_users ORDER BY created_at, ip LIMIT 1);
        `);
      }
      if (!current.has('must_change')) db.exec('ALTER TABLE drive_ip_users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return db;
}

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

function cookieFrom(req, name) {
  const cookie = (req.get('cookie') || '').split(';').map((entry) => entry.trim())
    .find((entry) => entry.startsWith(name + '='));
  return cookie?.slice(name.length + 1) || null;
}

function tokenFrom(req) {
  const token = cookieFrom(req, sessionCookie);
  return /^[a-f0-9]{64}$/.test(token || '') ? token : null;
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const key = await deriveKey(password, salt, 64);
  return salt + ':' + key.toString('hex');
}

async function matchesPassword(password, stored) {
  const actual = await hashPassword(password, stored.split(':', 1)[0]);
  return timingSafeEqual(Buffer.from(stored), Buffer.from(actual));
}

function friendlyName(input) {
  const name = typeof input === 'string' ? input.trim().normalize('NFC') : '';
  return friendlyNamePattern.test(name) ? name : null;
}

function publicAccount(account) {
  return { id: account.id, username: account.username, role: account.role };
}

function itemName(input) {
  if (typeof input !== 'string') return null;
  const name = input.trim().normalize('NFC');
  return name && name.length <= 150 && name !== '.' && name !== '..' && !/[\x00-\x1f\x7f/\\]/.test(name) ? name : null;
}

function createDriveRouter({ data, uploads, upload, removeBlob, authMode = 'account', passphrase = '' }) {
  const accountsEnabled = authMode === 'account';
  const passphraseRequired = authMode === 'passphrase';
  const ipMode = authMode === 'ip';
  const passphraseSessions = new Map();
  const ipSessions = new Map();
  const router = express.Router();
  const db = openDrive(data);
  const mediaPreviews = createMediaPreviews(data, uploads);
  const officePreviews = createOfficePreviews(data, uploads);
  const getItem = db.prepare('SELECT * FROM drive_items WHERE id = ?');
  const findChildFolder = db.prepare("SELECT id FROM drive_items WHERE parent_id = ? AND name_key = ? AND kind = 'folder'");
  const getCategories = db.prepare(`
    SELECT c.id, i.name, c.position
    FROM drive_categories c JOIN drive_items i ON i.id = c.id
    ORDER BY c.position, c.id
  `);
  const getAccount = db.prepare('SELECT * FROM drive_accounts WHERE username = ?');
  const getAccountById = db.prepare('SELECT * FROM drive_accounts WHERE id = ?');
  const getIpUser = db.prepare('SELECT * FROM drive_ip_users WHERE ip = ?');
  const getSharedAuth = db.prepare('SELECT passphrase_hash FROM drive_shared_auth WHERE id = 1');
  const removeSession = db.prepare('DELETE FROM drive_sessions WHERE token_hash = ?');
  const removeExpired = db.prepare('DELETE FROM drive_sessions WHERE expires_at <= ?');
  const insertItem = db.prepare(`
    INSERT INTO drive_items (id, parent_id, kind, name, name_key, size, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (parent_id, name_key) DO NOTHING
  `);
  const getLineage = db.prepare(`
    WITH RECURSIVE lineage(id, parent_id, name, depth) AS (
      SELECT id, parent_id, name, 0 FROM drive_items WHERE id = ?
      UNION ALL
      SELECT i.id, i.parent_id, i.name, l.depth + 1 FROM drive_items i JOIN lineage l ON i.id = l.parent_id
    )
    SELECT id, name FROM lineage ORDER BY depth DESC
  `);
  const sevenZip = resolveSevenZip();
  const downloads = createDownloads({ data, uploads, sevenZip });
  const sharedItem = db.prepare(`
    SELECT i.* FROM drive_share_links s JOIN drive_items i ON i.id = s.item_id WHERE s.token_hash = ?
  `);
  const saveShareLink = db.prepare('INSERT INTO drive_share_links (token_hash, item_id) SELECT ?, id FROM drive_items WHERE id = ?');

  async function filePreview(file) {
    const extension = path.extname(file.name).toLowerCase();
    if (extension === '.ts' || extension === '.mts') {
      // These extensions also identify MPEG transport streams. Check three packet sync bytes.
      const handle = await open(path.join(uploads, file.id), 'r').catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (handle) {
        try {
          const header = Buffer.alloc(409);
          await handle.read(header);
          const video = [[188, 0], [192, 4], [204, 0]].some(([stride, start]) =>
            header[start] === 0x47 && header[start + stride] === 0x47 && header[start + stride * 2] === 0x47);
          if (video) return { kind: 'video', format: null };
        } finally {
          await handle.close();
        }
      }
    }
    return { kind: previewKind(file.name), format: previewFormat(file.name) };
  }

  async function withArchive(file, inspect) {
    const source = path.join(uploads, file.id);
    if (archiveFormat(file.name) !== 'tar.gz') return inspect(source);
    const directory = await mkdtemp(path.join(tmpdir(), 'droppod-tar-'));
    const tar = path.join(directory, 'archive.tar');
    let size = 0;
    try {
      const limit = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          if (size > maxExpandedTar) {
            return callback(Object.assign(new Error('TAR preview is limited to 256 MiB after decompression.'), { status: 413 }));
          }
          callback(null, chunk);
        },
      });
      await pipeline(createReadStream(source), createGunzip(), limit, createWriteStream(tar), {
        signal: AbortSignal.timeout(60_000),
      });
      return await inspect(tar);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function listArchive(source) {
    const output = await runSevenZip(sevenZip, ['l', '-slt', '-ba', '-sccUTF-8', '--', source]);
    return parseArchiveListing(output);
  }

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
  const folderEntries = db.prepare(descendants + 'SELECT * FROM drive_items WHERE id IN (SELECT id FROM descendants)');
  const readFolderEntries = (id) => folderEntries.all(id);
  const deleteTree = db.prepare(descendants + 'DELETE FROM drive_items WHERE id IN (SELECT id FROM descendants)');
  const removeCategory = db.prepare('DELETE FROM drive_categories WHERE id = ?');
  const pendingCleanup = db.prepare('SELECT id FROM drive_blob_cleanup');
  const finishCleanup = db.prepare('DELETE FROM drive_blob_cleanup WHERE id = ?');
  let cleaning = false;
  let cleanupRequested = false;

  async function cleanDeletedFiles() {
    cleanupRequested = true;
    if (cleaning) return;
    cleaning = true;
    try {
      do {
        cleanupRequested = false;
        for (const { id } of pendingCleanup.all()) {
          try {
            await Promise.all([mediaPreviews.remove(id), officePreviews.remove(id)]);
            await unlink(path.join(uploads, id)).catch((error) => {
              if (error.code !== 'ENOENT') throw error;
            });
          } catch (error) {
            console.error(error);
            continue;
          }
          finishCleanup.run(id);
        }
      } while (cleanupRequested);
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

  function clientIp(req) {
    const peer = req.socket.remoteAddress;
    const trustProxy = req.app.get('trust proxy fn');
    // Express resolves X-Forwarded-For through the configured proxy chain.
    const realIp = !req.get('X-Forwarded-For') && peer && trustProxy?.(peer, 0) ? req.get('X-Real-IP') : null;
    const address = [realIp, req.ip, peer].find((value) => value && isIP(value)) || 'unknown';
    const ipv4 = /^::ffff:(.+)$/i.exec(address)?.[1];
    return ipv4 && isIP(ipv4) === 4 ? ipv4 : address;
  }

  function actorName(req) {
    if (accountsEnabled) return req.driveAccount?.username || 'Unknown';
    if (ipMode) return getIpUser.get(clientIp(req))?.name || 'Unknown';
    return 'Shared drive';
  }

  function hasPassphrase(req) {
    if (!passphraseRequired) return true;
    const token = cookieFrom(req, passphraseCookie);
    const session = token && passphraseSessions.get(token);
    return Boolean(session && session.expiresAt > Date.now() && session.hash === getSharedAuth.get().passphrase_hash);
  }

  async function matchesSharedPassphrase(provided, stored) {
    if (stored) return matchesPassword(provided, stored);
    const digest = (value) => createHash('sha256').update(value).digest();
    return timingSafeEqual(digest(passphrase), digest(provided));
  }

  function startPassphraseSession(req, res, hash) {
    const token = randomBytes(32).toString('hex');
    passphraseSessions.set(token, { hash, expiresAt: Date.now() + sessionDuration });
    res.cookie(passphraseCookie, token, { ...cookieOptions(req), maxAge: sessionDuration });
  }

  function hasIpSession(req) {
    if (!ipMode) return true;
    const token = cookieFrom(req, ipCookie);
    const session = token ? ipSessions.get(token) : null;
    return Boolean(session && session.expiresAt > Date.now() && session.ip === clientIp(req)
      && session.hash === req.driveIpUser?.passphrase_hash);
  }

  function startIpSession(req, res, hash) {
    const token = randomBytes(32).toString('hex');
    ipSessions.set(token, { ip: clientIp(req), hash, expiresAt: Date.now() + sessionDuration });
    res.cookie(ipCookie, token, { ...cookieOptions(req), maxAge: sessionDuration });
  }

  function revokeIpSessions(ip) {
    for (const [token, session] of ipSessions) {
      if (session.ip === ip) ipSessions.delete(token);
    }
  }

  setInterval(() => {
    const now = Date.now();
    for (const [token, session] of passphraseSessions) {
      if (session.expiresAt <= now) passphraseSessions.delete(token);
    }
    for (const [token, session] of ipSessions) {
      if (session.expiresAt <= now) ipSessions.delete(token);
    }
  }, 60_000).unref();

  router.use((req, res, next) => {
    const origin = req.get('origin');
    if (!['GET', 'HEAD'].includes(req.method) && origin && origin !== `${req.protocol}://${req.get('host')}`) {
      return res.status(403).json({ error: 'Use the FireSend page to make this change.' });
    }
    readSession(req, res, next);
  });

  function readSession(req, res, next) {
    req.driveToken = tokenFrom(req);
    if (ipMode) req.driveIpUser = getIpUser.get(clientIp(req));
    if (accountsEnabled && req.driveToken) {
      req.driveAccount = db.prepare(`
        SELECT a.id, a.username, a.role, s.expires_at FROM drive_sessions s
        JOIN drive_accounts a ON a.id = s.account_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND a.disabled = 0
      `).get(hashToken(req.driveToken), Date.now());
    }
    next();
  }

  function requireAccess(req, res, next) {
    if (passphraseRequired && !hasPassphrase(req)) {
      return res.status(401).json({ error: 'Enter the passphrase to access the drive.', authMode, passphraseRequired: true });
    }
    if (ipMode && !hasIpSession(req)) {
      return res.status(401).json({ error: 'Register or enter your passphrase to access the drive.', authMode, ipRequired: true });
    }
    if (ipMode && req.driveIpUser.must_change) {
      return res.status(401).json({ error: 'Change your temporary passphrase to access the drive.', authMode, ipRequired: true });
    }
    if (accountsEnabled && !req.driveAccount) {
      return res.status(401).json({ error: 'Sign in to access the drive.', authMode, signInRequired: true });
    }
    next();
  }

  function requireAccounts(req, res, next) {
    if (!accountsEnabled) return res.status(404).json({ error: 'Accounts are disabled.' });
    next();
  }

  function requireAdmin(req, res, next) {
    const role = ipMode ? req.driveIpUser?.role : req.driveAccount?.role;
    if (role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
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
    const address = clientIp(req);
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
    if (accountsEnabled && req.driveAccount) {
      res.clearCookie(sessionCookie, { ...cookieOptions(req), path: '/api/drive' });
      res.cookie(sessionCookie, req.driveToken, { ...cookieOptions(req), expires: new Date(req.driveAccount.expires_at) });
    }
    const ipAddress = ipMode ? clientIp(req) : null;
    const ipUser = req.driveIpUser;
    const ipUnlocked = ipMode ? hasIpSession(req) : true;
    res.json({
      authMode,
      account: accountsEnabled && req.driveAccount ? publicAccount(req.driveAccount) : null,
      passphraseRequired,
      passphraseUnlocked: passphraseRequired ? hasPassphrase(req) : true,
      ipRegistered: Boolean(ipUser),
      ipAddress,
      ipName: ipUser?.name || null,
      ipUnlocked: ipUnlocked && !ipUser?.must_change,
      ipRole: ipMode && ipUnlocked ? ipUser.role : null,
      ipMustChange: Boolean(ipMode && ipUnlocked && ipUser.must_change),
    });
  });

  router.post('/passphrase', limitAuth, async (req, res) => {
    if (!passphraseRequired) return res.status(404).json({ error: 'Passphrase access is disabled.' });
    const provided = typeof req.body?.passphrase === 'string' ? req.body.passphrase : '';
    const stored = getSharedAuth.get().passphrase_hash;
    if (!await matchesSharedPassphrase(provided, stored) || getSharedAuth.get().passphrase_hash !== stored) {
      return res.status(401).json({ error: 'That passphrase is incorrect.' });
    }
    startPassphraseSession(req, res, stored);
    res.json({ unlocked: true });
  });

  router.post('/ip/register', limitAuth, async (req, res) => {
    if (!ipMode) return res.status(404).json({ error: 'Network registration is disabled.' });
    const ip = clientIp(req);
    if (getIpUser.get(ip)) {
      return res.status(409).json({ error: 'This network is already registered. Enter its passphrase.', needsLogin: true });
    }
    const name = friendlyName(req.body?.name);
    const provided = req.body?.passphrase;
    if (!name || typeof provided !== 'string' || provided.length < 6 || provided.length > 128) {
      return res.status(400).json({ error: 'Choose a name of up to 40 characters and a passphrase of at least 6 characters.' });
    }
    const passphraseHash = await hashPassword(provided);
    const inserted = db.prepare(`
      INSERT INTO drive_ip_users (ip, name, passphrase_hash, role, created_at)
      VALUES (?, ?, ?, CASE WHEN NOT EXISTS (SELECT 1 FROM drive_ip_users) THEN 'admin' ELSE 'member' END, ?)
      ON CONFLICT (ip) DO NOTHING
    `).run(ip, name, passphraseHash, Date.now());
    if (!inserted.changes) {
      return res.status(409).json({ error: 'This network is already registered. Enter its passphrase.', needsLogin: true });
    }
    startIpSession(req, res, passphraseHash);
    res.status(201).json({ ipName: name });
  });

  router.post('/ip/login', limitAuth, async (req, res) => {
    if (!ipMode) return res.status(404).json({ error: 'Network sign-in is disabled.' });
    const user = req.driveIpUser;
    if (!user) return res.status(404).json({ error: 'This network has not been registered yet.', needsRegistration: true });
    const provided = typeof req.body?.passphrase === 'string' ? req.body.passphrase : '';
    if (!await matchesPassword(provided, user.passphrase_hash)
      || getIpUser.get(user.ip)?.passphrase_hash !== user.passphrase_hash) {
      return res.status(401).json({ error: 'That passphrase is incorrect.' });
    }
    startIpSession(req, res, user.passphrase_hash);
    res.json({ ipName: user.name });
  });

  router.post('/logout', (req, res) => {
    if (req.driveToken) removeSession.run(hashToken(req.driveToken));
    const passphraseToken = cookieFrom(req, passphraseCookie);
    if (passphraseToken) passphraseSessions.delete(passphraseToken);
    const ipToken = cookieFrom(req, ipCookie);
    if (ipToken) ipSessions.delete(ipToken);
    res.clearCookie(sessionCookie, { ...cookieOptions(req), path: '/api/drive' });
    res.clearCookie(passphraseCookie, cookieOptions(req));
    res.clearCookie(ipCookie, cookieOptions(req));
    res.clearCookie(sessionCookie, cookieOptions(req)).sendStatus(204);
  });

  router.post('/register', requireAccounts, limitAuth, async (req, res) => {
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

  router.post('/login', requireAccounts, limitAuth, async (req, res) => {
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

  router.post('/password', limitAuth, async (req, res) => {
    const authorized = ipMode ? hasIpSession(req) : passphraseRequired ? hasPassphrase(req) : req.driveAccount;
    if (!authorized) return requireAccess(req, res, () => res.sendStatus(401));
    const { currentPassword, newPassword } = req.body || {};
    const minimum = accountsEnabled ? 10 : 6;
    const label = accountsEnabled ? 'password' : 'passphrase';
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string'
      || newPassword.length < minimum || newPassword.length > 128) {
      return res.status(400).json({ error: `Enter your current ${label} and choose a new one with ${minimum}–128 characters.` });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: `Choose a different ${label}.` });
    }

    const account = accountsEnabled ? getAccountById.get(req.driveAccount.id) : req.driveIpUser;
    const stored = passphraseRequired ? getSharedAuth.get().passphrase_hash : account?.password_hash || account?.passphrase_hash;
    const matches = passphraseRequired
      ? await matchesSharedPassphrase(currentPassword, stored)
      : stored && await matchesPassword(currentPassword, stored);
    if (!matches) return res.status(403).json({ error: `The current ${label} is incorrect.` });

    const hash = await hashPassword(newPassword);
    const changed = () => res.status(409).json({ error: 'Your sign-in changed. Sign in again and retry.' });
    if (ipMode) {
      if (!hasIpSession(req) || !db.prepare(`
        UPDATE drive_ip_users SET passphrase_hash = ?, must_change = 0 WHERE ip = ? AND passphrase_hash = ?
      `).run(hash, account.ip, stored).changes) return changed();
      revokeIpSessions(account.ip);
      startIpSession(req, res, hash);
    } else if (passphraseRequired) {
      if (!hasPassphrase(req) || !db.prepare(`
        UPDATE drive_shared_auth SET passphrase_hash = ? WHERE id = 1 AND passphrase_hash IS ?
      `).run(hash, stored).changes) return changed();
      passphraseSessions.clear();
      startPassphraseSession(req, res, hash);
    } else {
      db.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        const updated = db.prepare(`
          UPDATE drive_accounts SET password_hash = ? WHERE id = ? AND password_hash = ? AND disabled = 0
          AND EXISTS (SELECT 1 FROM drive_sessions WHERE token_hash = ? AND expires_at > ?)
        `).run(hash, account.id, stored, hashToken(req.driveToken), Date.now());
        if (!updated.changes) return changed();
        db.prepare('DELETE FROM drive_sessions WHERE account_id = ?').run(account.id);
        db.exec('COMMIT');
        committed = true;
      } finally {
        if (!committed) db.exec('ROLLBACK');
      }
      startSession(req, res, account);
    }
    res.sendStatus(204);
  });

  router.use(requireAccess);

  router.post('/categories', (req, res) => {
    const name = itemName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Enter a category name of up to 150 characters without slashes.' });
    const id = randomUUID();
    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const result = db.prepare(`
        INSERT INTO drive_items (id, kind, name, name_key, created_by, updated_at)
        VALUES (?, 'folder', ?, ?, ?, ?)
        ON CONFLICT (name_key) WHERE parent_id IS NULL DO NOTHING
      `).run(id, name, name.toLowerCase(), actorName(req), Date.now());
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

  router.get('/folders/:id', async (req, res) => {
    const folder = getItem.get(req.params.id);
    if (folder?.kind !== 'folder') return res.status(404).json({ error: 'Folder not found.' });
    const items = db.prepare(`
      SELECT id, kind, name, size, created_by AS createdBy, updated_at AS updatedAt FROM drive_items
      WHERE parent_id = ? ORDER BY kind DESC, name_key, id
    `).all(folder.id);
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const { kind, format } = await filePreview(item);
      item.preview = kind;
      if (!format && compatibleMediaTypes.has(kind)) item.convertPreview = true;
      if (kind === 'text') item.language = codeLanguage(item.name);
      item.previewTruncated = kind === 'text' && item.size > maxTextPreview;
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
    const nameKey = name.toLowerCase();
    if (!insertItem.run(id, folder.id, 'folder', name, nameKey, null, actorName(req), Date.now()).changes) {
      if (req.body?.reuseExisting === true) {
        const existing = findChildFolder.get(folder.id, nameKey);
        if (existing) return res.json({ id: existing.id, reused: true });
      }
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

  function deleteItem(req, res, category) {
    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const item = getItem.get(req.params.id);
      if (category) {
        if (item?.id === 'root') return res.status(400).json({ error: 'The default drive category cannot be deleted.' });
        if (!item || !removeCategory.run(item.id).changes) {
          return res.status(404).json({ error: 'Category not found.' });
        }
      } else {
        if (!item) return res.status(404).json({ error: 'Item not found.' });
        if (item.parent_id === null) return res.status(400).json({ error: 'Categories cannot be deleted here.' });
      }
      queueDeletedFiles.run(item.id);
      deleteTree.run(item.id);
      db.exec('COMMIT');
      committed = true;
    } finally {
      if (!committed) db.exec('ROLLBACK');
    }
    cleanDeletedFiles().catch(console.error);
    res.sendStatus(204);
  }

  router.delete('/items/:id', (req, res) => deleteItem(req, res, false));
  router.delete('/categories/:id', (req, res) => deleteItem(req, res, true));

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
        if (!insertItem.run(id, folder.id, 'file', name, name.toLowerCase(), size, actorName(req), Date.now()).changes) {
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

  router.get('/files/:id/archive', async (req, res) => {
    const file = getItem.get(req.params.id);
    if (file?.kind !== 'file') return res.status(404).json({ error: 'File not found.' });
    const format = archiveFormat(file.name);
    if (!format) return res.status(415).json({ error: 'Archive preview is unavailable for this file type.' });
    try {
      const entries = await withArchive(file, listArchive);
      const totalSize = entries.reduce((sum, entry) => sum + (entry.folder ? 0 : entry.size), 0);
      res.json({ format, entries, totalSize });
    } catch (error) {
      if (error.status === 413) return res.status(413).json({ error: error.message });
      if (error.code === 'ENOENT') {
        return res.status(501).json({ error: 'Archive viewing requires 7-Zip on the server.' });
      }
      console.error(error);
      res.status(422).json({ error: 'This archive could not be read. It may be encrypted or damaged.' });
    }
  });

  router.get('/files/:id/archive/entry', async (req, res) => {
    const file = getItem.get(req.params.id);
    if (file?.kind !== 'file') return res.status(404).json({ error: 'File not found.' });
    if (!archiveFormat(file.name)) return res.status(415).json({ error: 'Archive preview is unavailable for this file type.' });
    const entryPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!entryPath || entryPath.length > 4096 || /[\x00\r\n]/.test(entryPath)) {
      return res.status(400).json({ error: 'Choose a valid archive entry.' });
    }
    try {
      const result = await withArchive(file, async (source) => {
        const entries = await listArchive(source);
        const entry = entries.find((candidate) => !candidate.folder && candidate.path === entryPath);
        if (!entry) return { status: 404, error: 'Archive entry not found.' };
        if (entry.encrypted) return { status: 422, error: 'This archive entry is encrypted.' };
        if (entry.preview !== 'text' && entry.size > maxArchiveEntry) {
          return { status: 413, error: 'This archive entry is too large to preview.' };
        }
        const buffer = await extractArchiveEntry(sevenZip, source, entry);
        const type = entry.preview === 'text' ? 'text/plain' : previewFormat(entry.name);
        return { buffer, type };
      });
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
      res.type(result.type || 'application/octet-stream');
      res.send(result.buffer);
    } catch (error) {
      if (error.status === 413) return res.status(413).json({ error: error.message });
      if (error.code === 'ENOENT') {
        return res.status(501).json({ error: 'Archive viewing requires 7-Zip on the server.' });
      }
      console.error(error);
      res.status(422).json({ error: 'This archive entry could not be read.' });
    }
  });

  async function sendMediaPreview(res, file, type, kind, contentType) {
    try {
      const generated = await mediaPreviews.get(file.id, type, kind);
      if (res.destroyed) return;
      if (!getItem.get(file.id)) return res.sendStatus(404);
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
      res.type(contentType);
      res.sendFile(path.basename(generated), { root: path.dirname(generated), cacheControl: false });
    } catch (error) {
      if (res.destroyed) return;
      if (error.code === 'ENOENT') return res.status(503).json({ error: 'Media conversion requires FFmpeg and FFprobe.' });
      res.status(422).json({ error: 'This media file could not be converted for preview.' });
    }
  }

  router.get('/files/:id/thumbnail', async (req, res) => {
    const file = getItem.get(req.params.id);
    if (file?.kind !== 'file') return res.sendStatus(404);
    const { kind, format } = await filePreview(file);
    if (format === 'image/svg+xml') {
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
      res.type(format);
      return res.sendFile(file.id, { root: uploads, cacheControl: false });
    }
    if (kind !== 'image' && kind !== 'video') return res.sendStatus(415);
    await sendMediaPreview(res, file, 'thumbnail', kind, 'image/jpeg');
  });

  router.get('/files/:id/model-buffer', (req, res) => {
    const file = getItem.get(req.params.id);
    if (file?.kind !== 'file' || !/\.bin$/i.test(file.name)) return res.sendStatus(404);
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type('application/octet-stream');
    res.sendFile(file.id, { root: uploads, cacheControl: false });
  });

  router.get('/files/:id/preview', async (req, res) => {
    const file = getItem.get(req.params.id);
    if (file?.kind !== 'file') return res.status(404).json({ error: 'File not found.' });
    const { kind, format } = await filePreview(file);
    if (kind === 'office') {
      try {
        const generated = await officePreviews.get(file);
        if (res.destroyed) return;
        if (!getItem.get(file.id)) return res.sendStatus(404);
        res.set('Content-Security-Policy', "default-src 'none'; sandbox");
        res.type('application/pdf');
        return res.sendFile(path.basename(generated), { root: path.dirname(generated), cacheControl: false });
      } catch (error) {
        if (res.destroyed) return;
        return res.status(error.status || 422).json({
          error: error.status ? error.message : 'This Office file could not be converted for preview.',
        });
      }
    }
    if ((!format || req.query.compatible === '1') && compatibleMediaTypes.has(kind)) {
      return sendMediaPreview(res, file, kind, kind, compatibleMediaTypes.get(kind));
    }
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

  router.get('/files/:id/download', (req, res) => {
    const file = getItem.get(req.params.id);
    if (file?.kind !== 'file') return res.status(404).json({ error: 'File not found.' });
    return downloads.send(req, res, file, readFolderEntries, true);
  });

  router.get('/folders/:id/download', (req, res) => {
    const folder = getItem.get(req.params.id);
    if (folder?.kind !== 'folder') return res.status(404).json({ error: 'Folder not found.' });
    return downloads.send(req, res, folder, readFolderEntries, true);
  });

  router.get('/transfers/:id', (req, res) => {
    const transfer = downloads.status(req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found.' });
    res.json({ ...transfer, elapsed: Date.now() - transfer.startedAt });
  });

  router.post('/items/:id/share', (req, res) => {
    const token = randomBytes(32).toString('base64url');
    if (!saveShareLink.run(hashToken(token), req.params.id).changes) return res.status(404).json({ error: 'Item not found.' });
    res.status(201).json({ path: `/share/${token}` });
  });

  function downloadShare(req, res) {
    res.set('Cache-Control', 'no-store');
    const { token } = req.params;
    const item = /^[A-Za-z0-9_-]{43}$/.test(token) ? sharedItem.get(hashToken(token)) : null;
    if (!item) return res.status(404).type('text/plain').send('This share link is unavailable.');
    return downloads.send(req, res, item, readFolderEntries);
  }

  router.get('/admin/accounts', requireAdmin, (req, res) => {
    const accounts = ipMode ? db.prepare(`
      SELECT ip AS id, ip, name AS username, role, must_change AS resetRequired
      FROM drive_ip_users ORDER BY name COLLATE NOCASE, ip
    `).all() : db.prepare(`
      SELECT id, username, role, disabled, created_at AS createdAt
      FROM drive_accounts ORDER BY username
    `).all();
    const storage = db.prepare(`
      SELECT count(*) AS files, coalesce(sum(size), 0) AS bytes FROM drive_items WHERE kind = 'file'
    `).get();
    res.json({ accounts, storage });
  });

  router.patch('/admin/accounts/:id', requireAdmin, (req, res) => {
    if (ipMode) {
      const name = friendlyName(req.body?.name);
      if (!name) return res.status(400).json({ error: 'Choose a friendly name of up to 40 characters.' });
      if (!db.prepare('UPDATE drive_ip_users SET name = ? WHERE ip = ?').run(name, req.params.id).changes) {
        return res.status(404).json({ error: 'Account not found.' });
      }
      return res.sendStatus(204);
    }
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

  router.post('/admin/accounts/:id/reset-passphrase', requireAdmin, async (req, res) => {
    if (!ipMode) return res.status(404).json({ error: 'Network accounts are disabled.' });
    const target = getIpUser.get(req.params.id);
    if (!target) return res.status(404).json({ error: 'Account not found.' });
    if (target.role === 'admin') return res.status(400).json({ error: 'Change your own passphrase in Settings.' });
    const { passphrase } = req.body || {};
    if (typeof passphrase !== 'string' || passphrase.length < 6 || passphrase.length > 128) {
      return res.status(400).json({ error: 'Choose a temporary passphrase with 6–128 characters.' });
    }
    const hash = await hashPassword(passphrase);
    if (!hasIpSession(req)) return res.status(401).json({ error: 'Sign in again.', ipRequired: true });
    const updated = db.prepare(`
      UPDATE drive_ip_users SET passphrase_hash = ?, must_change = 1
      WHERE ip = ? AND role = 'member' AND passphrase_hash = ?
    `).run(hash, target.ip, target.passphrase_hash);
    if (!updated.changes) return res.status(409).json({ error: 'This account changed. Refresh the admin panel and retry.' });
    revokeIpSessions(target.ip);
    res.sendStatus(204);
  });

  router.delete('/admin/accounts/:id', requireAdmin, (req, res) => {
    const id = req.params.id;
    if (ipMode) {
      if (db.prepare("DELETE FROM drive_ip_users WHERE ip = ? AND role = 'member'").run(id).changes) {
        revokeIpSessions(id);
        return res.sendStatus(204);
      }
      if (!getIpUser.get(id)) return res.status(404).json({ error: 'Account not found.' });
      return res.status(400).json({ error: 'The network administrator cannot be deleted.' });
    }
    const removed = db.prepare("DELETE FROM drive_accounts WHERE id = ? AND role = 'member'").run(id);
    if (removed.changes) return res.sendStatus(204);
    const exists = db.prepare('SELECT 1 FROM drive_accounts WHERE id = ?').get(id);
    if (!exists) return res.status(404).json({ error: 'Account not found.' });
    res.status(400).json({ error: 'Administrator accounts are managed on the host.' });
  });

  return { router, readSession, downloadShare };
}

module.exports = { createDriveRouter, openDrive };
