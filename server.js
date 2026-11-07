const express = require('express');
const multer = require('multer');
const { createHash, randomUUID } = require('node:crypto');
const { mkdirSync, readFileSync } = require('node:fs');
const { unlink } = require('node:fs/promises');
const path = require('node:path');
const { loadConfig } = require('./config-loader');
const { createDriveRouter } = require('./drive');

const app = express();
const port = Number(process.env.PORT) || 3001;
const data = path.resolve(process.env.FIRESEND_DATA_DIR || path.join(__dirname, '.data'));
const uploads = path.join(data, 'uploads');
const driveHtml = path.join(__dirname, 'public', 'drive.html');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') console.error('Could not read .env:', error.message);
}

const { defaultTheme, authMode } = loadConfig();
const passphrase = process.env.PASSPHRASE || '';
if (authMode === 'passphrase' && !passphrase) {
  console.error('PASSPHRASE must be set in .env (or the environment) when auth-mode is "passphrase".');
  process.exit(1);
}

const contentSecurityPolicy = (() => {
  const base = "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  try {
    const html = readFileSync(driveHtml, 'utf8').replace(/\r\n?/g, '\n');
    const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1];
    if (!importMap) return base;
    const hash = createHash('sha256').update(importMap).digest('base64');
    return `default-src 'self'; script-src 'self' 'sha256-${hash}'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
  } catch (error) {
    console.error('Could not prepare the page security policy:', error.message);
    return base;
  }
})();

mkdirSync(uploads, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploads,
    filename: (req, file, done) => done(null, randomUUID()),
  }),
  defParamCharset: 'utf8',
  limits: { files: 1, fields: 0, parts: 2 },
}).single('file');

function removeBlob(id) {
  return unlink(path.join(uploads, id)).catch((error) => {
    if (error.code !== 'ENOENT') console.error(error);
  });
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', contentSecurityPolicy);
  next();
});
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.get('Sec-Fetch-Site') === 'cross-site') return res.sendStatus(403);
  next();
});
app.use(express.json({ limit: '2kb' }));
const drive = createDriveRouter({ data, uploads, upload, removeBlob, authMode, passphrase });
app.use('/api/drive', drive.router);

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(`(function () {
  var config = ${JSON.stringify({ defaultTheme, authMode })};
  window.FIRESEND_CONFIG = config;
  var theme = config.defaultTheme;
  try {
    var saved = localStorage.getItem('firesend:drive-theme');
    if (saved === 'graphite' || saved === 'vista') theme = saved;
  } catch (error) {}
  document.documentElement.dataset.theme = theme;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'graphite' ? '#101112' : '#0b2633';
})();`);
});
app.get('/', (req, res) => res.sendFile(driveHtml));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three'), { maxAge: '1h' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: 'Send one file per upload.' });
  }
  if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ error: 'The request could not be processed.' });
  console.error(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const server = app.listen(port, '0.0.0.0', () => console.log(`FireSend is running at http://localhost:${port}`));
server.requestTimeout = 0;
