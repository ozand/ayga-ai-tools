import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

export const EXCLUDED_PATTERNS = [
  /^\.git(\/|\\|$)/,
  /^\.pi(\/|\\|$)/,
  /^test(\/|\\|$)/,
  /^docs(\/|\\|$)/,
  /^PROJECT_PLAN\.md$/,
  /\.zip$/i,
  /^\.artifact-.*\.png$/i,
  /\/\.artifact-.*\.png$/i,
  /\\\.artifact-.*\.png$/i,
  /\.DS_Store$/i,
  /^node_modules(\/|\\|$)/
];

export function isPathExcluded(relPath) {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function findZipTool() {
  const candidates = ['zip', '7z', '7zz'];
  for (const cmd of candidates) {
    try {
      const res = spawnSync(cmd, ['--help'], { stdio: 'ignore', shell: false });
      if (res.status === 0 || (res.status === null && !res.error)) {
        return cmd;
      }
    } catch {
      // try next
    }
  }
  // Try with shell: true without deprecated args style if on Windows
  for (const cmd of candidates) {
    try {
      const res = spawnSync(cmd + ' --help', { stdio: 'ignore', shell: true });
      if (res.status === 0 || (res.status === null && !res.error)) {
        return cmd;
      }
    } catch {
      // try next
    }
  }
  return null;
}

export function createPackage(targetZip = 'extension.zip', baseDir = rootDir) {
  const zipTool = findZipTool();
  if (!zipTool) {
    throw new Error('No zip or 7z/7zz tool found in PATH to create package.');
  }

  const zipPath = path.resolve(baseDir, targetZip);
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }

  if (zipTool === 'zip') {
    const args = [
      '-r',
      '-FS',
      targetZip,
      '.',
      '-x',
      '*.git*',
      '*.DS_Store',
      '*.zip',
      'node_modules*',
      'test*',
      '.pi*',
      'docs*',
      'PROJECT_PLAN.md',
      '*.artifact-*.png',
      '.artifact-*.png'
    ];
    execFileSync('zip', args, { cwd: baseDir, stdio: 'pipe' });
  } else {
    // 7z or 7zz
    const args = [
      'a',
      '-tzip',
      '-mx=9',
      targetZip,
      '.',
      '-xr!.git',
      '-xr!.pi',
      '-xr!test',
      '-xr!docs',
      '-x!PROJECT_PLAN.md',
      '-x!*.zip',
      '-xr!.artifact-*.png',
      '-xr!.DS_Store',
      '-xr!node_modules'
    ];
    execFileSync(zipTool, args, { cwd: baseDir, stdio: 'pipe' });
  }

  return { tool: zipTool, zipPath };
}

export function listZipEntries(targetZip = 'extension.zip', baseDir = rootDir) {
  const zipPath = path.resolve(baseDir, targetZip);
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Archive not found: ${zipPath}`);
  }

  const zipTool = findZipTool();
  if (zipTool === '7z' || zipTool === '7zz') {
    const output = execFileSync(zipTool, ['l', '-ba', '-slt', targetZip], {
      cwd: baseDir,
      encoding: 'utf8'
    });
    const paths = [];
    const blocks = output.split(/\r?\n\r?\n/);
    for (const block of blocks) {
      let currentPath = null;
      let isFolder = false;
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('Path = ')) {
          currentPath = line.substring('Path = '.length).trim();
        } else if (line.startsWith('Folder = +')) {
          isFolder = true;
        } else if (line.startsWith('Attributes = D')) {
          isFolder = true;
        }
      }
      if (currentPath && currentPath !== targetZip && !isFolder) {
        paths.push(currentPath.replace(/\\/g, '/'));
      }
    }
    return paths.sort();
  }

  if (zipTool === 'zip') {
    const output = execFileSync('unzip', ['-Z', '-1', targetZip], {
      cwd: baseDir,
      encoding: 'utf8'
    });
    return output
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !s.endsWith('/'))
      .sort();
  }

  throw new Error('Cannot inspect zip archive without 7z/7zz/unzip');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    const res = createPackage();
    console.log(`Successfully packaged extension using ${res.tool} into ${path.basename(res.zipPath)}`);
  } catch (err) {
    console.error('Packaging error:', err.message);
    process.exit(1);
  }
}
