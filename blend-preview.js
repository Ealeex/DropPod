const { execFile, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createReadStream, createWriteStream, mkdirSync } = require('node:fs');
const { open, rename, stat, unlink } = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const { resolveTool } = require('./tool-paths');

const run = promisify(execFile);
const limit = 128 * 1024 * 1024;
const timeout = 60_000;

function previewError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function removeFile(file) {
  await unlink(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

function selectRunner() {
  const distro = process.env.BLENDER_PREVIEW_WSL_DISTRO?.trim();
  if (process.platform === 'win32' && distro) {
    const script = path.join(__dirname, 'tools', 'blender-preview', 'run-wsl.sh');
    return () => ({
      executable: resolveTool(['wsl.exe'], { override: 'WSL_PATH' }),
      args: ['-d', distro, '--exec', 'bash', '-c', 'exec bash "$(wslpath -a -u "$1")"', 'firesend', script],
      unavailable: 'Blender previews require the configured Ubuntu WSL distribution.',
      setup: 'The Blender preview sandbox could not start. Check the WSL Blender setup.',
      sandboxError: /^(?:bwrap|bash):|WSL_E_/m,
      timedOut: (code) => code === 137,
    });
  }

  const image = process.env.BLENDER_PREVIEW_IMAGE?.trim();
  if (!image) return null;
  const docker = resolveTool([process.platform === 'win32' ? 'docker.exe' : 'docker'], { override: 'DOCKER_PATH' });
  return () => {
    const name = `firesend-blend-${randomUUID()}`;
    return {
      executable: docker,
      args: [
        'run', '--rm', '--interactive', '--pull=never', '--name', name,
        '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges=true',
        '--user=65534:65534', '--cpus=2', '--memory=2g', '--memory-swap=2g', '--pids-limit=128',
        '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=384m,mode=1777',
        '--', image,
      ],
      unavailable: 'Blender previews require Docker on the server.',
      setup: 'The Blender preview container could not start. Check Docker and the configured image.',
      cleanup: () => run(docker, ['rm', '-f', name], { timeout: 5000, windowsHide: true }).catch(() => {}),
    };
  };
}

async function convert(runner, source, destination) {
  const child = spawn(runner.executable, runner.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  let size = 0;
  let diagnostic = '';
  let failure;
  let closed = false;
  function abort(error) {
    failure ||= error;
    if (!closed) child.kill('SIGKILL');
  }
  const timer = setTimeout(() => abort(previewError(504, 'Blender preview conversion timed out.')), timeout);
  const exited = new Promise((resolve) => {
    child.on('error', (error) => {
      failure ||= error.code === 'ENOENT'
        ? previewError(503, runner.unavailable)
        : error;
    });
    child.on('close', (code) => {
      closed = true;
      if (!failure && code !== 0) {
        if (code === 124 || runner.timedOut?.(code)) failure = previewError(504, 'Blender preview conversion timed out.');
        else if (code === 125 || runner.sandboxError?.test(diagnostic)) failure = previewError(503, runner.setup);
        else failure = previewError(422, 'Blender could not export this file for preview.');
      }
      resolve();
    });
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-2048); });
  const limitOutput = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > limit) return callback(previewError(413, 'The exported Blender preview exceeds 128 MiB.'));
      callback(null, chunk);
    },
  });

  try {
    await Promise.all([
      exited,
      pipeline(createReadStream(source), child.stdin).catch((error) => {
        // A runner can close stdin early and report a more useful error on exit.
        if (!['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)) abort(error);
      }),
      pipeline(child.stdout, limitOutput, createWriteStream(destination, { flags: 'wx' })).catch(abort),
    ]);
    if (failure) {
      if (diagnostic && failure.status === 503) console.error('[FireSend] Blender preview:', diagnostic.trim());
      throw failure;
    }
    const file = await open(destination, 'r');
    try {
      const header = Buffer.alloc(12);
      const { bytesRead } = await file.read(header);
      if (bytesRead !== header.length || header.toString('ascii', 0, 4) !== 'glTF'
        || header.readUInt32LE(4) !== 2 || header.readUInt32LE(8) !== size) {
        throw previewError(422, 'Blender did not produce a valid GLB preview.');
      }
    } finally {
      await file.close();
    }
  } finally {
    clearTimeout(timer);
    if (failure) await runner.cleanup?.();
  }
}

function createBlendPreviews(data, uploads) {
  const runner = selectRunner();
  const cache = path.join(data, 'blend-previews');
  const output = (id) => path.join(cache, `${id}.glb`);
  const pending = new Map();
  let queue = Promise.resolve();
  mkdirSync(cache, { recursive: true });

  async function generate(id, target) {
    const source = path.join(uploads, id);
    if ((await stat(source)).size > limit) throw previewError(413, 'Blender preview supports files up to 128 MiB.');
    const temp = `${target}.${randomUUID()}.part`;
    try {
      await convert(runner(), source, temp);
      await rename(temp, target);
      return target;
    } finally {
      await removeFile(temp);
    }
  }

  function get(id) {
    if (!runner) return Promise.reject(previewError(503, 'Blender previews are disabled on this server.'));
    const target = output(id);
    if (pending.has(id)) return pending.get(id);
    return stat(target).then(() => target, (error) => {
      if (error.code !== 'ENOENT') throw error;
      if (pending.has(id)) return pending.get(id);
      if (pending.size >= 4) throw previewError(503, 'Blender preview is busy. Try again shortly.');
      const job = queue.then(() => generate(id, target)).finally(() => pending.delete(id));
      pending.set(id, job);
      queue = job.catch(() => {});
      return job;
    });
  }

  async function remove(id) {
    await pending.get(id)?.catch(() => {});
    await removeFile(output(id));
  }

  return { get, remove };
}

module.exports = { createBlendPreviews };
