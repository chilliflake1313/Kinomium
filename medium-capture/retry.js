import { captureMultiBatch, scoreHtml, validateContent } from './capture.js';
import { loadBestHtml, saveBestHtml, saveAttempt, getArchivePath } from './archive.js';

const retrySchedules = new Map();

export function scheduleRetries(url, urlHash, archivePath, scoreThreshold) {
  if (retrySchedules.has(urlHash)) {
    return;
  }

  const schedules = [
    { delayMs: 10000, label: '+10s', batchCount: 3, variance: 250 },
    { delayMs: 60000, label: '+1min', batchCount: 4, variance: 300 },
    { delayMs: 300000, label: '+5min', batchCount: 5, variance: 350 },
  ];

  const timeoutIds = [];

  schedules.forEach(({ delayMs, label, batchCount, variance }) => {
    const id = setTimeout(async () => {
      await performRetry(url, urlHash, archivePath, scoreThreshold, batchCount, variance);
      console.log(`[RETRY COMPLETE] ${urlHash.substring(0, 8)} | Scheduled ${label}`);
    }, delayMs);

    timeoutIds.push(id);
  });

  retrySchedules.set(urlHash, timeoutIds);
}

async function performRetry(url, urlHash, archivePath, scoreThreshold, batchCount, variance) {
  try {
    const current = await loadBestHtml(archivePath);
    const currentScore = current?.meta?.score || 0;

    console.log(
      `[RETRY RUN] ${urlHash.substring(0, 8)} | Current score: ${currentScore.toFixed(2)} | Batches: ${batchCount}`
    );

    // Run multi-batch with increased variance
    const results = await captureMultiBatch(url, batchCount);

    if (results.length === 0) {
      console.log(`[RETRY FAILED] ${urlHash.substring(0, 8)} | No successful attempts`);
      return;
    }

    // Filter valid content
    const validResults = results.filter((r) => validateContent(r.html));

    if (validResults.length === 0) {
      console.log(`[RETRY FAILED] ${urlHash.substring(0, 8)} | No valid content`);
      return;
    }

    validResults.sort((a, b) => b.score - a.score);
    const best = validResults[0];

    console.log(
      `[RETRY RESULT] ${urlHash.substring(0, 8)} | New score: ${best.score.toFixed(2)} | ` +
      `Previous: ${currentScore.toFixed(2)} | Worker: ${best.worker}`
    );

    if (best.score > currentScore) {
      console.log(
        `[RETRY IMPROVED] ${urlHash.substring(0, 8)} | Score improved from ${currentScore.toFixed(2)} to ${best.score.toFixed(2)}`
      );

      await Promise.all(
        validResults.map((result) =>
          saveAttempt(archivePath, result.html, result.score, result.worker)
        )
      );
      await saveBestHtml(archivePath, best.html, best.score);

      // Continue retrying if still below threshold
      if (best.score < scoreThreshold) {
        scheduleRetries(url, urlHash, archivePath, scoreThreshold);
      } else {
        console.log(
          `[RETRY STOPPED] ${urlHash.substring(0, 8)} | Score ${best.score.toFixed(2)} above threshold`
        );
        cancelRetries(urlHash);
      }
    } else {
      console.log(
        `[RETRY NO IMPROVE] ${urlHash.substring(0, 8)} | Score ${best.score.toFixed(2)} not better than ${currentScore.toFixed(2)}`
      );
    }
  } catch (error) {
    console.error(`[RETRY ERROR] ${urlHash.substring(0, 8)} | ${error.message}`);
  }
}

export function cancelRetries(urlHash) {
  const timeoutIds = retrySchedules.get(urlHash);
  if (timeoutIds) {
    timeoutIds.forEach((id) => clearTimeout(id));
    retrySchedules.delete(urlHash);
  }
}
