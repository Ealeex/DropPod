const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const { DatabaseSync } = require('node:sqlite');
const { randomInt, randomUUID } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const { unlink } = require('node:fs/promises');
const { networkInterfaces } = require('node:os');
const path = require('node:path');

const app = express();
const port = 3001;
const data = path.resolve(process.env.FIRESEND_DATA_DIR || path.join(__dirname, '.data'));
const uploads = path.join(data, 'uploads');
const lifetime = 24 * 60 * 60 * 1000;
const maxFileSize = 500 * 1024 * 1024;
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

mkdirSync(uploads, { recursive: true });
const db = new DatabaseSync(path.join(data, 'firesend.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, ownerKey TEXT NOT NULL,
    public INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, code TEXT NOT NULL REFERENCES rooms(code),
    name TEXT NOT NULL, size INTEGER NOT NULL, uploadedAt INTEGER NOT NULL
  );
`);

const upload = multer({
  storage: multer.diskStorage({
    destination: uploads,
    filename: (req, file, done) => done(null, randomUUID()),
  }),
  defParamCharset: 'utf8',
  limits: { fileSize: maxFileSize + 1, files: 1, fields: 0, parts: 2 },
}).single('file');

function removeBlob(id) {
  return unlink(path.join(uploads, id)).catch((error) => {
    if (error.code !== 'ENOENT') console.error(error);
  });
}

async function purgeExpired() {
  const now = Date.now();
  const expired = db.prepare('SELECT id FROM files JOIN rooms USING(code) WHERE expiresAt <= ?').all(now);
  await Promise.all(expired.map(({ id }) => removeBlob(id)));
  db.prepare('DELETE FROM files WHERE code IN (SELECT code FROM rooms WHERE expiresAt <= ?)').run(now);
  db.prepare('DELETE FROM rooms WHERE expiresAt <= ?').run(now);
}

purgeExpired().catch(console.error);
setInterval(() => purgeExpired().catch(console.error), 60_000).unref();

function findRoom(req, res, next) {
  const code = req.params.code.toUpperCase();
  const room = db.prepare('SELECT * FROM rooms WHERE code = ? AND expiresAt > ?').get(code, Date.now());
  if (!room) return res.status(404).json({ error: 'That room does not exist or has expired.' });
  req.room = room;
  next();
}

function roomDetails({ code, expiresAt, public: isPublic }) {
  const files = db.prepare('SELECT id, name, size, uploadedAt FROM files WHERE code = ? ORDER BY uploadedAt DESC').all(code);
  return { code, expiresAt, public: Boolean(isPublic), files };
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  next();
});
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.get('Sec-Fetch-Site') === 'cross-site') return res.sendStatus(403);
  next();
});
app.use(express.json({ limit: '2kb' }));

app.post('/api/rooms', (req, res) => {
  const expiresAt = Date.now() + lifetime;
  const ownerKey = randomUUID();
  const insert = db.prepare('INSERT OR IGNORE INTO rooms (code, expiresAt, ownerKey) VALUES (?, ?, ?)');
  let code;
  do {
    code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
  } while (insert.run(code, expiresAt, ownerKey).changes === 0);
  res.status(201).json({ code, expiresAt, ownerKey });
});

app.get('/api/public-rooms', (req, res) => {
  res.json(db.prepare(`
    SELECT code, expiresAt, (SELECT count(*) FROM files WHERE files.code = rooms.code) AS fileCount
    FROM rooms WHERE public = 1 AND expiresAt > ? ORDER BY expiresAt DESC LIMIT 100
  `).all(Date.now()));
});

app.get('/api/network', (req, res) => {
  const addresses = Object.values(networkInterfaces()).flat()
    .filter((address) => address.family === 'IPv4' && !address.internal)
    .map((address) => address.address);
  res.json([...new Set(addresses)]);
});

app.get('/api/rooms/:code', findRoom, (req, res) => res.json(roomDetails(req.room)));

app.patch('/api/rooms/:code', findRoom, (req, res) => {
  if (req.get('X-Room-Key') !== req.room.ownerKey) return res.status(403).json({ error: 'Only the room creator can change visibility.' });
  if (typeof req.body?.public !== 'boolean') return res.status(400).json({ error: 'Choose a room visibility.' });
  db.prepare('UPDATE rooms SET public = ? WHERE code = ?').run(Number(req.body.public), req.room.code);
  res.json(roomDetails({ ...req.room, public: req.body.public }));
});

app.get('/api/rooms/:code/qr', findRoom, async (req, res) => {
  const host = typeof req.query.host === 'string' ? req.query.host : req.get('host');
  const url = new URL(`/room/${req.room.code}`, `${req.protocol}://${host}`);
  const svg = await QRCode.toString(url.href, { type: 'svg', margin: 2 });
  res.type('svg').send(svg);
});

app.post('/api/rooms/:code/files', findRoom, (req, res, next) => {
  upload(req, res, async (error) => {
    try {
      if (error) return next(error);
      if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
      if (req.file.size > maxFileSize) {
        await removeBlob(req.file.filename);
        return res.status(413).json({ error: 'Files must be 500 MB or smaller.' });
      }
      if (req.room.expiresAt <= Date.now()) {
        await removeBlob(req.file.filename);
        return res.status(404).json({ error: 'This room has expired.' });
      }
      const file = {
        id: req.file.filename,
        name: req.file.originalname.replace(/[\x00-\x1f\x7f]/g, '').trim() || 'download',
        size: req.file.size,
        uploadedAt: Date.now(),
      };
      db.prepare('INSERT INTO files (id, code, name, size, uploadedAt) VALUES (?, ?, ?, ?, ?)')
        .run(file.id, req.room.code, file.name, file.size, file.uploadedAt);
      res.status(201).json(file);
    } catch (uploadError) {
      if (req.file) await removeBlob(req.file.filename);
      next(uploadError);
    }
  });
});

app.get('/api/rooms/:code/files/:id', findRoom, (req, res, next) => {
  const file = db.prepare('SELECT id, name FROM files WHERE code = ? AND id = ?').get(req.room.code, req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found.' });
  res.download(path.join(uploads, file.id), file.name, { headers: { 'Content-Type': 'application/octet-stream' } }, (error) => {
    if (error) next(error);
  });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get(['/room/:code', '/public-rooms', '/guide', '/tv'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'Files must be 500 MB or smaller.' : 'Send one file per upload.' });
  }
  if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ error: 'The request could not be processed.' });
  console.error(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(port, '0.0.0.0', () => console.log(`FireSend is running at http://localhost:${port}`));
