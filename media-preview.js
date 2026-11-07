const { execFile } = require('node:child_process');
const { existsSync, mkdirSync } = require('node:fs');
const { rename, stat, unlink } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
const inputOptions = [
  '-protocol_whitelist', 'file',
  '-format_whitelist', [
    'mov', 'matroska', 'webm', 'avi', 'asf', 'flv', 'mpeg', 'mpegts', 'mpegvideo', 'm4v', 'ogg', 'gif',
    'mp3', 'wav', 'aiff', 'flac', 'ape', 'caf', 'au', 'amr', 'amrnb', 'amrwb', 'aac', 'ac3', 'eac3', 'wv', 'w64',
    'jpeg_pipe', 'png_pipe', 'bmp_pipe', 'webp_pipe', 'tiff_pipe', 'jpegxl_pipe', 'j2k_pipe', 'psd_pipe', 'qoi_pipe',
  ].join(','),
];
const outputs = { thumbnail: 'jpg', image: 'png', audio: 'm4a', video: 'mp4' };

function executable(name) {
  const file = process.platform === 'win32' ? `${name}.exe` : name;
  const bundled = path.join(__dirname, 'tools', 'ffmpeg', 'bin', file);
  return existsSync(bundled) ? bundled : file;
}

function removeIfPresent(file) {
  return unlink(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

function createMediaPreviews(data, uploads) {
  const cache = path.join(data, 'media-previews');
  mkdirSync(cache, { recursive: true });
  const ffmpeg = executable('ffmpeg');
  const ffprobe = executable('ffprobe');
  const pending = new Map();
  const queues = { thumbnail: Promise.resolve(), preview: Promise.resolve() };

  function cachePath(id, type) {
    return path.join(cache, `${id}-${type}.${outputs[type]}`);
  }

  async function generate(id, type, kind, output) {
    const source = path.join(uploads, id);
    const temp = `${output}.part`;
    let seek = [];
    if (type === 'thumbnail' && kind === 'video') {
      const { stdout } = await run(ffprobe, [
        '-v', 'error', ...inputOptions, '-select_streams', 'V:0',
        '-show_entries', 'stream=duration:format=duration', '-of', 'json', source,
      ], { windowsHide: true, timeout: 30_000 });
      const { streams, format } = JSON.parse(stdout);
      const duration = [streams?.[0]?.duration, format?.duration].map(Number).find((value) => value > 0 && Number.isFinite(value));
      if (duration) seek = ['-ss', (duration / 4).toFixed(6)];
    }

    const stream = kind === 'video' ? '0:V:0' : '0:v:0';
    const still = type === 'thumbnail' || type === 'image';
    let options;
    if (type === 'thumbnail') {
      options = ['-vf', 'scale=64:64:force_original_aspect_ratio=decrease', '-c:v', 'mjpeg', '-q:v', '4'];
    } else if (type === 'image') {
      options = ['-vf', "scale=w='min(2560,iw)':h='min(2560,ih)':force_original_aspect_ratio=decrease", '-c:v', 'png'];
    } else if (type === 'audio') {
      options = ['-map', '0:a:0', '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4'];
    } else {
      options = [
        '-map', stream, '-map', '0:a:0?',
        '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4',
      ];
    }
    if (still) options.push('-map', stream, '-frames:v', '1', '-f', 'image2', '-update', '1');

    async function convert(position) {
      await run(ffmpeg, [
        '-v', 'error', '-nostdin', '-y', '-filter_threads', '2', '-threads', '2',
        ...inputOptions, ...position, '-i', source, ...options, '-threads', '2', temp,
      ], { windowsHide: true, timeout: still ? 30_000 : 15 * 60_000 });
      const result = await stat(temp).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      return result?.size > 0;
    }

    try {
      await removeIfPresent(temp);
      let produced = await convert(seek);
      // A very short clip may have no frame at or after the requested timestamp.
      if (!produced && seek.length) produced = await convert([]);
      if (!produced) throw new Error('No preview was produced.');
      await rename(temp, output);
      return output;
    } finally {
      await removeIfPresent(temp);
    }
  }

  function get(id, type, kind) {
    const output = cachePath(id, type);
    if (existsSync(output)) return Promise.resolve(output);
    if (pending.has(output)) return pending.get(output);
    const queue = type === 'thumbnail' ? 'thumbnail' : 'preview';
    const job = queues[queue].then(() => generate(id, type, kind, output)).finally(() => pending.delete(output));
    pending.set(output, job);
    queues[queue] = job.catch(() => {});
    return job;
  }

  async function remove(id) {
    const files = Object.keys(outputs).map((type) => cachePath(id, type));
    await Promise.allSettled(files.map((file) => pending.get(file)));
    await Promise.all(files.flatMap((file) => [removeIfPresent(file), removeIfPresent(`${file}.part`)]));
  }

  return { get, remove };
}

module.exports = { createMediaPreviews };
