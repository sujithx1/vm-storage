import path from 'node:path';
import { fail, q, run, checkSudo, execStream, type Session } from './ssh';
import { findIndex, indexedDirs, forgetBytes } from './scan';

const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 3000;
const SEP = '__VMSTORAGE_SEP__';

// Deleting any of these exact paths is refused, even with sudo.
const PROTECTED = new Set([
  '/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/media',
  '/mnt', '/opt', '/proc', '/root', '/run', '/sbin', '/snap', '/srv', '/sys', '/tmp',
  '/usr', '/var', '/var/lib', '/var/log', '/usr/bin', '/usr/lib', '/usr/local',
]);

export async function disks(s: Session) {
  const { stdout } = await run(s, 'df -kP 2>/dev/null');
  const list = stdout.trim().split('\n').slice(1).map((line) => {
    const parts = line.trim().split(/\s+/);
    const [fs, total, used, avail] = parts;
    return { fs, total: +total * 1024, used: +used * 1024, avail: +avail * 1024, mount: parts.slice(5).join(' ') };
  }).filter((d) => d.mount === '/' || (d.total > 0 && !/^(tmpfs|devtmpfs|udev|overlay|shm|none|map |devfs)/.test(d.fs) && !d.fs.startsWith('/dev/loop')));
  list.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)));
  s.mounts = list.map((d) => d.mount);
  return list;
}

/** Folders and files directly inside `dir`, biggest first. */
export async function contents(s: Session, dir: string, sudo: boolean) {
  const index = findIndex(s, dir);
  // GNU find: size in KB, type, mtime, name, NUL-separated so odd file names survive.
  const files = `find . -mindepth 1 -maxdepth 1 ! -type d -printf '%k\\t%y\\t%T@\\t%P\\0' 2>/dev/null`;
  const cmd = index
    ? `cd ${q(dir)} || exit 3; ${files}`
    : `cd ${q(dir)} || exit 3; du -xk -d 1 . 2>&1; echo ${SEP}; ${files}`;
  const { code, stdout, stderr } = await run(s, cmd, { sudo });
  checkSudo(stderr);
  if (code === 3) throw fail(404, `Cannot open ${dir}: ${stderr.trim() || 'no such folder or permission denied'}`);

  let dirs: { name: string; path: string; size: number; mount: boolean; incomplete: boolean; hasChildren: boolean }[];
  let size: number;
  let denied = 0;
  let filesOut = stdout;
  if (index) {
    dirs = indexedDirs(s, index, dir);
    size = index.sizes.get(dir)!;
  } else {
    const [duOut, rest = ''] = stdout.split(`${SEP}\n`);
    filesOut = rest;
    size = 0;
    dirs = [];
    for (const line of duOut.split('\n')) {
      if (!/^\d+\t/.test(line)) { if (/denied/i.test(line)) denied++; continue; }
      const tab = line.indexOf('\t');
      const bytes = Number(line.slice(0, tab)) * 1024;
      const name = line.slice(tab + 1).replace(/^\.\//, '');
      if (name === '.') { size = bytes; continue; }
      const p = dir === '/' ? `/${name}` : `${dir}/${name}`;
      dirs.push({ name, path: p, size: bytes, mount: s.mounts.includes(p), incomplete: false, hasChildren: true });
    }
    dirs.sort((a, b) => b.size - a.size);
  }

  const fileList = filesOut.split('\0').filter(Boolean).map((rec) => {
    const [kb, type, mtime, ...name] = rec.split('\t');
    const n = name.join('\t');
    return {
      name: n,
      path: dir === '/' ? `/${n}` : `${dir}/${n}`,
      size: Number(kb) * 1024,
      type: type === 'l' ? 'link' : type === 'f' ? 'file' : 'other',
      mtime: Math.round(Number(mtime) * 1000),
    };
  }).sort((a, b) => b.size - a.size);

  return {
    path: dir,
    size,
    indexed: !!index,
    stale: index?.stale ?? false,
    incomplete: index ? index.incomplete.has(dir) : denied > 0,
    denied: index ? 0 : denied,
    dirs,
    files: fileList.slice(0, MAX_FILES),
    fileCount: fileList.length,
    filesSize: fileList.reduce((n, f) => n + f.size, 0),
  };
}

export async function largest(s: Session, dir: string, minMb: number, sudo: boolean) {
  const cmd = `find ${q(dir)} -xdev -type f -size +${minMb}M -printf '%k\\t%T@\\t%p\\0' 2>/dev/null`;
  const { stdout, stderr } = await run(s, cmd, { sudo });
  checkSudo(stderr);
  return stdout.split('\0').filter(Boolean).map((rec) => {
    const [kb, mtime, ...p] = rec.split('\t');
    return { size: Number(kb) * 1024, mtime: Math.round(Number(mtime) * 1000), path: p.join('\t') };
  }).sort((a, b) => b.size - a.size).slice(0, 100);
}

export async function readText(s: Session, file: string, sudo: boolean) {
  const { code, stdout, stderr } = await run(s, `[ -f ${q(file)} ] || exit 3; head -c ${MAX_EDIT_BYTES + 1} ${q(file)}`, { sudo });
  checkSudo(stderr);
  if (code === 3) throw fail(400, 'Not a regular file');
  if (code !== 0) throw fail(400, stderr.trim() || 'Cannot read file');
  if (Buffer.byteLength(stdout) > MAX_EDIT_BYTES) throw fail(413, 'File is larger than 2 MB, too big to edit in the browser');
  if (stdout.includes('\u0000')) throw fail(415, 'This looks like a binary file and cannot be edited as text');
  return stdout;
}

export async function writeText(s: Session, file: string, content: string, sudo: boolean) {
  const { code, stderr } = await run(s, `cat > ${q(file)}`, { sudo, stdin: content });
  checkSudo(stderr);
  if (code !== 0) throw fail(400, stderr.trim() || 'Write failed');
}

export async function remove(s: Session, target: string, sudo: boolean) {
  if (PROTECTED.has(target)) throw fail(400, `Refusing to delete protected system path ${target}`);
  if (s.mounts.includes(target)) throw fail(400, `${target} is a mounted disk. Delete what is inside it instead.`);
  const { code, stdout, stderr } = await run(s, `du -sk -- ${q(target)} 2>/dev/null | cut -f1; rm -rf -- ${q(target)}`, { sudo });
  checkSudo(stderr);
  if (code !== 0) throw fail(400, stderr.trim() || 'Delete failed');
  const freed = (Number(stdout.trim()) || 0) * 1024;
  forgetBytes(s, target, freed, true);
  return freed;
}

/**
 * What a download of `target` will be. Always runs as the SSH user (no sudo), so only
 * files that user can read are offered. A folder link is resolved to the real folder.
 */
export async function downloadInfo(s: Session, target: string) {
  const p = q(target);
  const { code, stdout } = await run(s,
    `if [ -d ${p} ]; then cd -P -- ${p} 2>/dev/null && [ -r . ] || exit 4; echo dir; pwd -P; ` +
    `elif [ -f ${p} ]; then [ -r ${p} ] || exit 4; stat -L -c %s -- ${p}; else exit 3; fi`);
  if (code === 3) throw fail(404, `${target} is not a file or folder`);
  if (code === 4) throw fail(403, `This user cannot read ${target}. Only files readable without sudo can be downloaded.`);
  if (code !== 0) throw fail(400, `Cannot read ${target}`);
  const [first, real] = stdout.trim().split('\n');
  if (first !== 'dir') return { kind: 'file' as const, path: target, size: Number(first), filename: path.posix.basename(target) };
  if (real === '/') throw fail(400, 'Pick a folder to download, not the whole disk');
  return { kind: 'dir' as const, path: real, size: null, filename: `${path.posix.basename(real)}.tar.gz` };
}

/** A file as-is, or a folder packed with tar + gzip on the VM, streamed without buffering. */
export async function download(s: Session, target: string) {
  const info = await downloadInfo(s, target);
  const cmd = info.kind === 'file'
    ? `cat -- ${q(info.path)}`
    : `cd -- ${q(path.posix.dirname(info.path))} && exec tar -czf - ${q('./' + path.posix.basename(info.path))} 2>/dev/null`;
  return { ...info, body: await execStream(s, cmd) };
}

// Empty a file in place: the right way to free space from a log a running process still writes to.
export async function truncate(s: Session, target: string, sudo: boolean) {
  const { code, stdout, stderr } = await run(s, `[ -f ${q(target)} ] || exit 3; du -k -- ${q(target)} | cut -f1; : > ${q(target)}`, { sudo });
  checkSudo(stderr);
  if (code === 3) throw fail(400, 'Not a regular file');
  if (code !== 0) throw fail(400, stderr.trim() || 'Truncate failed');
  const freed = (Number(stdout.trim()) || 0) * 1024;
  forgetBytes(s, target, freed, false);
  return freed;
}
