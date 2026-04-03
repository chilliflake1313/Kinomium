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

export async function saveBestHtml(archivePath, html, score, worker, metrics = {}) {
  await fs.mkdir(archivePath, { recursive: true });

  const bestPath = path.join(archivePath, 'best.html');
  const metaPath = path.join(archivePath, 'meta.json');

  const meta = {
    score,
    worker,
    savedAt: new Date().toISOString(),
    htmlLength: html.length,
    textLength: html.replace(/<[^>]*>/g, '').length,
    ...metrics,
  };

  await Promise.all([
    fs.writeFile(bestPath, html, 'utf-8'),
    fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8'),
  ]);
}

export async function saveAttempt(archivePath, html, score, worker, metrics = {}) {
  const attemptsDir = path.join(archivePath, 'attempts');
  await fs.mkdir(attemptsDir, { recursive: true });

  const timestamp = Date.now();
  const attemptPath = path.join(attemptsDir, `attempt-${timestamp}.html`);
  const metaPath = path.join(attemptsDir, `attempt-${timestamp}.json`);

  const meta = {
    score: parseFloat(score.toFixed(2)),
    worker,
    timestamp,
    htmlLength: html.length,
    textLength: html.replace(/<[^>]*>/g, '').length,
    savedAt: new Date().toISOString(),
    ...metrics,
  };

  await Promise.all([
    fs.writeFile(attemptPath, html, 'utf-8'),
    fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8'),
  ]);
}

export async function getHistoricalScores(archivePath) {
  const attemptsDir = path.join(archivePath, 'attempts');

  try {
    const files = await fs.readdir(attemptsDir);
    const metaFiles = files.filter((f) => f.startsWith('attempt-') && f.endsWith('.json'));

    const scores = await Promise.all(
      metaFiles.map(async (file) => {
        const content = await fs.readFile(path.join(attemptsDir, file), 'utf-8');
        const meta = JSON.parse(content);
        return meta.score;
      })
    );

    return scores;
  } catch {
    return [];
  }
}


export async function getHistoricalBest(archivePath) {
  const attemptsDir = path.join(archivePath, 'attempts');

  try {
    const files = await fs.readdir(attemptsDir);
    const metaFiles = files.filter((f) => f.startsWith('attempt-') && f.endsWith('.json'));

    const allAttempts = await Promise.all(
      metaFiles.map(async (file) => {
        const content = await fs.readFile(path.join(attemptsDir, file), 'utf-8');
        return JSON.parse(content);
      })
    );

    allAttempts.sort((a, b) => b.score - a.score);

    return {
      count: allAttempts.length,
      bestScore: allAttempts[0]?.score || 0,
      averageScore: allAttempts.reduce((sum, a) => sum + a.score, 0) / allAttempts.length || 0,
      workers: [...new Set(allAttempts.map((a) => a.worker))],
    };
  } catch {
    return null;
  }
}
