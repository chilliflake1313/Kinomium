import { captureMultiBatch, validateContent, calculateDynamicThreshold } from './capture.js';
import { loadBestHtml, saveBestHtml, saveAttempt, getHistoricalScores, getHistoricalBest } from './archive.js';

const retrySchedules = new Map();

export function scheduleRetries(url, urlHash, archivePath, scoreThreshold) {
  if (retrySchedules.has(urlHash)) {
    return;
  }

  const schedules = [
    { delayMs: 10000, label: '+10s', batchCount: 3 },
    { delayMs: 60000, label: '+1min', batchCount: 4 },
    { delayMs: 300000, label: '+5min', batchCount: 5 },
  ];

  const timeoutIds = [];

  schedules.forEach(({ delayMs, label, batchCount }) => {
    const id = setTimeout(async () => {
      await performRetry(url, urlHash, archivePath, scoreThreshold, batchCount);
      console.log(`[RETRY COMPLETE] ${urlHash.substring(0, 8)} | Scheduled ${label}`);
    }, delayMs);

    timeoutIds.push(id);
  });

  retrySchedules.set(urlHash, timeoutIds);
}

async function performRetry(url, urlHash, archivePath, scoreThreshold, batchCount) {
  try {
    const current = await loadBestHtml(archivePath);
    const currentScore = current?.meta?.score || 0;

    const historicalScores = await getHistoricalScores(archivePath);
    const dynamicThreshold = calculateDynamicThreshold(historicalScores);

    console.log(
      `[RETRY RUN] ${urlHash.substring(0, 8)} | Current: ${currentScore.toFixed(2)} | ` +
      `Dynamic threshold: ${dynamicThreshold.toFixed(2)} | Batches: ${batchCount}`
    );

    const results = await captureMultiBatch(url, batchCount, dynamicThreshold);

    if (results.length === 0) {
      console.log(`[RETRY FAILED] ${urlHash.substring(0, 8)} | No successful attempts`);
      return;
    }

    const validResults = results.filter((r) => validateContent(r.html));

    if (validResults.length === 0) {
      console.log(`[RETRY FAILED] ${urlHash.substring(0, 8)} | No valid content`);
      return;
    }

    validResults.sort((a, b) => b.score - a.score);
    const best = validResults[0];

    console.log(
      `[RETRY RESULT] ${urlHash.substring(0, 8)} | New: ${best.score.toFixed(2)} | ` +
      `Previous: ${currentScore.toFixed(2)} | Worker: ${best.worker}${best.jsEnabled === false ? ' (NoJS)' : ''}`
    );

    if (best.score > currentScore) {
      const improvement = best.score - currentScore;
      console.log(
        `[RETRY IMPROVED] ${urlHash.substring(0, 8)} | +${improvement.toFixed(2)} points ` +
        `(${currentScore.toFixed(2)} → ${best.score.toFixed(2)})`
      );

      await Promise.all(
        validResults.slice(0, 10).map((result) =>
          saveAttempt(archivePath, result.html, result.score, result.worker, {
            textToHtmlRatio: result.textToHtmlRatio,
            hasArticleTag: result.hasArticleTag,
            articleContentLength: result.articleContentLength,
            contentDominanceRatio: result.contentDominanceRatio,
            jsEnabled: result.jsEnabled,
          })
        )
      );

      await saveBestHtml(archivePath, best.html, best.score, best.worker, {
        textToHtmlRatio: best.textToHtmlRatio,
        hasArticleTag: best.hasArticleTag,
        articleContentLength: best.articleContentLength,
        contentDominanceRatio: best.contentDominanceRatio,
        jsEnabled: best.jsEnabled,
      });

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
        `[RETRY NO IMPROVE] ${urlHash.substring(0, 8)} | Best: ${best.score.toFixed(2)}`
      );
    }

    const historical = await getHistoricalBest(archivePath);
    if (historical) {
      console.log(
        `[RETRY STATS] ${urlHash.substring(0, 8)} | Total: ${historical.count} | ` +
        `Avg: ${historical.averageScore.toFixed(2)} | Best: ${historical.bestScore.toFixed(2)}`
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
