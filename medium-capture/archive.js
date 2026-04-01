import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = path.join(__dirname, 'archive');

export function getArchivePath(urlHash) {
  return path.join(ARCHIVE_DIR, urlHash);
}

export async function loadBestHtml(archivePath) {
  const bestPath = path.join(archivePath, 'best.html');
  const metaPath = path.join(archivePath, 'meta.json');

  try {
    const [html, meta] = await Promise.all([
      fs.readFile(bestPath, 'utf-8'),
      fs.readFile(metaPath, 'utf-8'),
    ]);

    return {
      html,
      meta: JSON.parse(meta),
    };
  } catch {
    return null;
  }
}

export async function saveBestHtml(archivePath, html, score) {
  await fs.mkdir(archivePath, { recursive: true });

  const bestPath = path.join(archivePath, 'best.html');
  const metaPath = path.join(archivePath, 'meta.json');

  const meta = {
    score,
    savedAt: new Date().toISOString(),
    htmlLength: html.length,
  };

  await Promise.all([
    fs.writeFile(bestPath, html, 'utf-8'),
    fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8'),
  ]);
}

export async function saveAttempt(archivePath, html, score, worker) {
  const attemptsDir = path.join(archivePath, 'attempts');
  await fs.mkdir(attemptsDir, { recursive: true });

  const timestamp = Date.now();
  const attemptPath = path.join(attemptsDir, `attempt-${timestamp}.html`);
  const metaPath = path.join(attemptsDir, `attempt-${timestamp}.json`);

  const meta = {
    score: score.toFixed(2),
    worker,
    timestamp,
    htmlLength: html.length,
    savedAt: new Date().toISOString(),
  };

  await Promise.all([
    fs.writeFile(attemptPath, html, 'utf-8'),
    fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8'),
  ]);
}

export async function getAttemptsCount(archivePath) {
  const attemptsDir = path.join(archivePath, 'attempts');
  try {
    const files = await fs.readdir(attemptsDir);
    return files.filter((f) => f.startsWith('attempt-') && f.endsWith('.html')).length;
  } catch {
    return 0;
  }
}

export async function getBestScore(archivePath) {
  const cached = await loadBestHtml(archivePath);
  return cached?.meta?.score || 0;
}
