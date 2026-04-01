import express from 'express';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  captureMultiBatch,
  validateContent,
  closeBrowserPool,
} from './capture.js';
import {
  getArchivePath,
  loadBestHtml,
  saveBestHtml,
  saveAttempt,
  getHistoricalBest,
} from './archive.js';
import { scheduleRetries } from './retry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const SCORE_THRESHOLD = 50;
const EARLY_EXIT_THRESHOLD = 130;
const CONCURRENT_LIMIT = 5;
const MIN_TEXT_LENGTH = 500;
const MIN_PARAGRAPHS = 2;

let activeRequests = 0;

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    let normalized = u.origin + u.pathname;

    const params = new URLSearchParams(u.search);
    const trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
      'fbclid', 'gclid', 'msclkid', '_ga', 'mc_cid', 'mc_eid',
    ];

    trackingParams.forEach((param) => params.delete(param));

    const cleanSearch = params.toString();
    if (cleanSearch) {
      normalized += '?' + cleanSearch;
    }

    return normalized;
  } catch {
    return url;
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/capture', async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  if (activeRequests >= CONCURRENT_LIMIT) {
    return res.status(503).json({ error: 'Server at capacity, retry later' });
  }

  activeRequests++;
  const startTime = Date.now();

  try {
    const normalized = normalizeUrl(url);
    const urlHash = createHash('sha256').update(normalized).digest('hex');
    const archivePath = getArchivePath(urlHash);

    const cached = await loadBestHtml(archivePath);
    if (cached) {
      const elapsed = Date.now() - startTime;
      console.log(
        `[CACHE HIT] ${urlHash.substring(0, 8)} | Score: ${cached.meta.score.toFixed(2)} | ` +
        `Worker: ${cached.meta.worker} | ${elapsed}ms`
      );
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('X-Cache', 'HIT');
      res.set('X-Score', cached.meta.score.toFixed(2));
      return res.send(cached.html);
    }

    console.log(`[CAPTURE START] ${urlHash.substring(0, 8)} | URL: ${url}`);

    const results = await captureMultiBatch(url, 4, EARLY_EXIT_THRESHOLD);

    if (results.length === 0) {
      console.log(`[CAPTURE FAILED] ${urlHash.substring(0, 8)} | No successful attempts`);
      return res.status(500).json({ error: 'Failed to capture URL' });
    }

    const validResults = results.filter((r) =>
      validateContent(r.html, MIN_TEXT_LENGTH, MIN_PARAGRAPHS)
    );

    if (validResults.length === 0) {
      console.log(`[CAPTURE NO VALID] ${urlHash.substring(0, 8)} | No valid content found`);
      return res.status(500).json({ error: 'No valid content captured' });
    }

    validResults.sort((a, b) => b.score - a.score);
    const best = validResults[0];

    const elapsed = Date.now() - startTime;

    console.log(
      `[CAPTURE COMPLETE] ${urlHash.substring(0, 8)} | Score: ${best.score.toFixed(2)} | ` +
      `Valid: ${validResults.length}/${results.length} | Worker: ${best.worker} | ${elapsed}ms`
    );

    await Promise.all(
      validResults.slice(0, 15).map((result) =>
        saveAttempt(archivePath, result.html, result.score, result.worker, {
          textToHtmlRatio: result.textToHtmlRatio,
          hasArticleTag: result.hasArticleTag,
          articleContentLength: result.articleContentLength,
        })
      )
    );

    await saveBestHtml(archivePath, best.html, best.score, best.worker, {
      textToHtmlRatio: best.textToHtmlRatio,
      hasArticleTag: best.hasArticleTag,
      articleContentLength: best.articleContentLength,
    });

    if (best.score < SCORE_THRESHOLD) {
      console.log(
        `[RETRY SCHEDULED] ${urlHash.substring(0, 8)} | Score ${best.score.toFixed(2)} below threshold ${SCORE_THRESHOLD}`
      );
      scheduleRetries(url, urlHash, archivePath, SCORE_THRESHOLD);
    }

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('X-Cache', 'MISS');
    res.set('X-Score', best.score.toFixed(2));
    res.set('X-Worker', best.worker);
    res.send(best.html);
  } catch (error) {
    console.error(`[ERROR] ${error.message}`);
    res.status(500).json({ error: error.message });
  } finally {
    activeRequests--;
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeRequests,
    concurrencyLimit: CONCURRENT_LIMIT,
    scoreThreshold: SCORE_THRESHOLD,
    earlyExitThreshold: EARLY_EXIT_THRESHOLD,
  });
});

app.get('/stats/:hash', async (req, res) => {
  const { hash } = req.params;
  const archivePath = getArchivePath(hash);

  try {
    const best = await loadBestHtml(archivePath);
    if (!best) {
      return res.status(404).json({ error: 'No archive found' });
    }

    const historical = await getHistoricalBest(archivePath);

    res.json({
      hash,
      bestScore: best.meta.score,
      bestWorker: best.meta.worker,
      bestSavedAt: best.meta.savedAt,
      htmlLength: best.meta.htmlLength,
      textLength: best.meta.textLength,
      historical,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`[SERVER START] Listening on http://localhost:${PORT}`);
  console.log(
    `[CONFIG] Score threshold: ${SCORE_THRESHOLD} | Concurrency limit: ${CONCURRENT_LIMIT} | Early exit: ${EARLY_EXIT_THRESHOLD}`
  );
});

process.on('SIGTERM', async () => {
  console.log('[SHUTDOWN] Closing browser pool...');
  await closeBrowserPool();
  server.close(() => {
    console.log('[SHUTDOWN] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('[SHUTDOWN] Closing browser pool...');
  await closeBrowserPool();
  server.close(() => {
    console.log('[SHUTDOWN] Server closed');
    process.exit(0);
  });
});
