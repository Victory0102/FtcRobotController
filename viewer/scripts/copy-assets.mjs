#!/usr/bin/env node
/**
 * Copies the viewer build (TypeScript → JavaScript) plus the static index.html
 * and styles.css into the TeamCode/src/main/assets/runhealth directory so the
 * Run Health Control Hub handler can serve them.  Also writes a manifest
 * file documenting the bundled version.
 */
import { promises as fs } from 'fs';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const VIEWER_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(VIEWER_ROOT, 'dist');
const STATIC_DIR = path.join(VIEWER_ROOT, 'src');
const OUT_BASE = path.resolve(VIEWER_ROOT, '..', 'TeamCode', 'src', 'main', 'assets', 'runhealth');
const OUT_DIR = path.join(OUT_BASE, 'assets');

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function copyDir(src, dst) {
  await ensureDir(dst);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const sp = path.join(src, e.name);
    const dp = path.join(dst, e.name);
    if (e.isDirectory()) {
      await copyDir(sp, dp);
    } else {
      await fs.copyFile(sp, dp);
    }
  }
}

async function main() {
  await rmrf(OUT_DIR);
  await ensureDir(OUT_BASE);
  // Static index.html and styles.css live alongside main.ts in src/.  Copy them
  // directly into the assets root.
  if (await fileExists(path.join(STATIC_DIR, 'index.html'))) {
    await fs.copyFile(
      path.join(STATIC_DIR, 'index.html'),
      path.join(OUT_BASE, 'index.html'));
  }
  if (await fileExists(path.join(STATIC_DIR, 'styles.css'))) {
    await fs.copyFile(
      path.join(STATIC_DIR, 'styles.css'),
      path.join(OUT_BASE, 'styles.css'));
  }

  if (await fileExists(DIST_DIR)) {
    await copyDir(DIST_DIR, OUT_DIR);
    console.log('Copied viewer dist to', OUT_DIR);
  } else {
    console.log('No viewer dist at', DIST_DIR, '- skipping JS assets.');
    console.log('Run "npm run build" first.');
  }
  await fs.writeFile(
    path.join(OUT_BASE, 'manifest.json'),
    JSON.stringify({
      name: 'ftc-run-health-viewer',
      version: '1.0.0',
      schema_version: '1',
      built_at: new Date().toISOString(),
    }, null, 2));
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
