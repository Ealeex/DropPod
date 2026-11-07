const { execFile } = require('node:child_process');
const { existsSync, mkdirSync } = require('node:fs');
const { copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const { resolveTool } = require('./tool-paths');

const run = promisify(execFile);
const officeFormats = new Set(['.docx', '.pptx']);
const maxOfficeBytes = 32 * 1024 * 1024;
const maxQueuedConversions = 4;
const profileSettings = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
    <prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
  </item>
  <item oor:path="/org.openoffice.Office.Writer/Content/Update">
    <prop oor:name="Link" oor:op="fuse"><value>2</value></prop>
  </item>
</oor:items>`;

function previewError(status, message) {
  return Object.assign(new Error(message), { status });
}

function createOfficePreviews(data, uploads) {
  const cache = path.join(data, 'office-previews');
  mkdirSync(cache, { recursive: true });
  const isWindows = process.platform === 'win32';
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432];
  const system = isWindows
    ? roots.filter(Boolean).map((root) => path.join(root, 'LibreOffice', 'program'))
    : ['/Applications/LibreOffice.app/Contents/MacOS', '/usr/bin'];
  const soffice = resolveTool(isWindows ? ['soffice.com'] : ['soffice', 'libreoffice'], {
    override: 'SOFFICE_PATH', system,
  });
  const pending = new Map();
  let queue = Promise.resolve();
  const outputPath = (id) => path.join(cache, `${id}.pdf`);

  async function convert(file, destination) {
    const scratch = await mkdtemp(path.join(cache, '.convert-'));
    try {
      const profile = path.join(scratch, 'profile');
      const user = path.join(profile, 'user');
      await mkdir(user, { recursive: true });
      await writeFile(path.join(user, 'registrymodifications.xcu'), profileSettings);
      const extension = path.extname(file.name).toLowerCase();
      const input = path.join(scratch, `document${extension}`);
      await copyFile(path.join(uploads, file.id), input);
      const word = extension === '.docx';
      const inputFilter = word ? 'Office Open XML Text' : 'Impress MS PowerPoint 2007 XML';
      const filter = word ? 'writer_pdf_Export' : 'impress_pdf_Export';
      try {
        await run(soffice, [
          `-env:UserInstallation=${pathToFileURL(profile).href}`,
          '--headless', '--nologo', '--nodefault', '--norestore',
          '--infilter=' + inputFilter, '--convert-to', `pdf:${filter}`,
          '--outdir', scratch, input,
        ], { cwd: scratch, windowsHide: true, timeout: 60_000, maxBuffer: 128 * 1024, killSignal: 'SIGKILL' });
      } catch (error) {
        if (error.code === 'ENOENT') throw previewError(503, 'Word and PowerPoint previews require LibreOffice on the server.');
        throw error;
      }
      const generated = path.join(scratch, 'document.pdf');
      const info = await stat(generated);
      if (!info.size || info.size > maxOfficeBytes) throw previewError(413, 'The generated PDF exceeds the preview limit.');
      await rename(generated, destination);
      return destination;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  return {
    async get(file) {
      if (file.size > maxOfficeBytes) throw previewError(413, 'Office previews are limited to 32 MiB.');
      const destination = outputPath(file.id);
      if (existsSync(destination)) return destination;
      if (pending.has(file.id)) return pending.get(file.id);
      if (pending.size >= maxQueuedConversions) throw previewError(503, 'Office previews are busy. Try again shortly.');
      const job = queue.then(() => convert(file, destination)).finally(() => pending.delete(file.id));
      pending.set(file.id, job);
      queue = job.catch(() => {});
      return job;
    },
    async remove(id) {
      await Promise.allSettled([pending.get(id)]);
      await rm(outputPath(id), { force: true });
    },
  };
}

module.exports = { createOfficePreviews, officeFormats };
