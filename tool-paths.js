const { execFile } = require('node:child_process');
const { accessSync, constants, readFileSync, statSync } = require('node:fs');
const path = require('node:path');

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function resolveTool(names, { override, bundled = [], system = [] }) {
  const configured = process.env[override]?.trim();
  if (configured) return configured;

  const nativeBundle = path.join(__dirname, 'tools', `${process.platform}-${process.arch}`);
  const searchPath = (process.env.PATH || '').split(path.delimiter).filter((directory) => path.isAbsolute(directory));
  const homebrew = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [];
  const directories = [...searchPath, ...homebrew, ...system];
  const candidates = [
    ...names.map((name) => path.join(nativeBundle, name)),
    ...bundled,
    ...directories.flatMap((directory) => names.map((name) => path.join(directory, name))),
  ];
  return candidates.find(isExecutable) || names[0];
}

function resolveMediaTool(name) {
  const file = process.platform === 'win32' ? `${name}.exe` : name;
  return resolveTool([file], {
    override: name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH',
    bundled: [path.join(__dirname, 'tools', 'ffmpeg', 'bin', file)],
  });
}

function resolveSevenZip() {
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432];
    return resolveTool(['7z.exe'], {
      override: 'SEVEN_ZIP_PATH',
      bundled: [path.join(__dirname, 'tools', '7z.exe')],
      system: roots.filter(Boolean).map((root) => path.join(root, '7-Zip')),
    });
  }
  return resolveTool(['7zz', '7z'], {
    override: 'SEVEN_ZIP_PATH',
    system: ['/usr/local/bin', '/usr/bin'],
  });
}

function linuxRelease() {
  for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      return Object.fromEntries(lines.flatMap((line) => {
        const match = /^(ID|ID_LIKE|VERSION_ID)=["']?([\w. -]+)["']?$/.exec(line);
        return match ? [[match[1], match[2].trim()]] : [];
      }));
    } catch {
      // Try the fallback location when the release information is unavailable.
    }
  }
  return {};
}

function installInstructions(needsMedia, needsZip) {
  const command = (prefix, media, zip) => [prefix, needsMedia && media, needsZip && zip].filter(Boolean).join(' ');
  const brew = command('brew install', 'ffmpeg', 'sevenzip');
  if (process.platform === 'darwin') return `Install with Homebrew: ${brew}`;

  const { ID, ID_LIKE = '', VERSION_ID } = linuxRelease();
  const families = [ID, ...ID_LIKE.split(/\s+/)];
  if (families.includes('debian') || families.includes('ubuntu')) {
    const version = Number.parseFloat(VERSION_ID);
    const older = (ID === 'debian' && version < 12) || (ID === 'ubuntu' && version < 22.04);
    return `Install with APT: ${command('sudo apt install', 'ffmpeg', older ? 'p7zip-full' : '7zip')}`;
  }
  if (ID === 'fedora') {
    const note = needsMedia ? '\n[FireSend] Fedora’s ffmpeg-free package has limited codec support.' : '';
    return `Install with DNF: ${command('sudo dnf install', 'ffmpeg-free', '7zip')}${note}`;
  }
  if (families.includes('arch')) return `Install with pacman: ${command('sudo pacman -S', 'ffmpeg', '7zip')}`;
  if (ID === 'alpine') return `Install as root with apk: ${command('apk add', 'ffmpeg', '7zip')}`;
  return `Use your Linux distribution’s package manager. With Homebrew, run: ${brew}`;
}

async function warnMissingHostTools() {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return;
  const checks = [
    ['FFmpeg', resolveMediaTool('ffmpeg'), '-version'],
    ['FFprobe', resolveMediaTool('ffprobe'), '-version'],
    ['7-Zip', resolveSevenZip(), 'i'],
  ];
  const missing = await Promise.all(checks.map(([name, executable, argument]) =>
    new Promise((resolve) => {
      execFile(executable, [argument], { timeout: 3000, maxBuffer: 128 * 1024 }, (error) => {
        resolve(error ? name : null);
      });
    })));
  const unavailable = missing.filter(Boolean);
  if (!unavailable.length) return;
  console.warn(`[FireSend] Host tools unavailable: ${unavailable.join(', ')}.`);
  console.warn(`[FireSend] ${installInstructions(Boolean(missing[0] || missing[1]), Boolean(missing[2]))}`);
}

module.exports = { resolveTool, resolveMediaTool, resolveSevenZip, warnMissingHostTools };
