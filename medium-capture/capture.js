import { chromium } from 'playwright';

const BROWSER_POOL = {
  instance: null,
};

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
];

const WORKER_STRATEGIES = [
  { name: 'Pre-DOM-Commit', waitUntil: 'commit', delayMs: 0, earlyStop: true, blockAssets: true },
  { name: 'Ultra-Early-50ms', waitUntil: 'domcontentloaded', delayMs: 0, earlyStop: true, blockAssets: true },
  { name: 'Ultra-Early-150ms', waitUntil: 'domcontentloaded', delayMs: 0, earlyStop: true, blockAssets: false },
  { name: 'DOMContentLoaded-300ms', waitUntil: 'domcontentloaded', delayMs: 300, earlyStop: false, blockAssets: false },
  { name: 'NetworkIdle-800ms', waitUntil: 'networkidle', delayMs: 800, earlyStop: false, blockAssets: false },
];

export async function getBrowserInstance() {
  if (!BROWSER_POOL.instance) {
    BROWSER_POOL.instance = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
  }
  return BROWSER_POOL.instance;
}

export async function closeBrowserPool() {
  if (BROWSER_POOL.instance) {
    await BROWSER_POOL.instance.close();
    BROWSER_POOL.instance = null;
  }
}

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getRandomViewport() {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

function blockTracking(page, blockAssets = false) {
  return page.route('**/*', (route) => {
    const url = route.request().url();
    const resourceType = route.request().resourceType();

    const shouldBlock =
      url.includes('analytics') ||
      url.includes('doubleclick') ||
      url.includes('google-analytics') ||
      url.includes('facebook.com/tr') ||
      url.includes('tracking') ||
      url.includes('gtag') ||
      url.includes('segment.io') ||
      url.includes('mixpanel') ||
      url.includes('amplitude') ||
      url.includes('hotjar') ||
      url.includes('optimizely') ||
      url.includes('chartbeat') ||
      url.includes('newrelic');

    if (shouldBlock) {
      return route.abort('blockedbyclient');
    }

    if (blockAssets) {
      if (resourceType === 'image' || resourceType === 'font' || resourceType === 'media') {
        return route.abort('blockedbyclient');
      }
    }

    route.continue();
  });
}

async function performEarlyCleanup(page) {
  await page.evaluate(() => {
    const overlaySelectors = [
      '[role="dialog"][style*="position: fixed"]',
      '[role="dialog"][style*="z-index"]',
      '.modal[style*="z-index"]',
      '.overlay[style*="position: fixed"]',
      '.paywall',
      '.cookie-banner',
      '.newsletter-popup',
      '[class*="paywall"]',
      '[class*="cookie"][style*="position: fixed"]',
      '[class*="newsletter"][style*="position: fixed"]',
      '[class*="subscription"][style*="z-index"]',
      '[class*="membership"][style*="z-index"]',
      'iframe[src*="doubleclick"]',
      'iframe[src*="facebook"]',
      'div[style*="position: fixed"][style*="z-index: 9"]',
      'div[style*="position: fixed"][style*="inset: 0"]',
    ];

    overlaySelectors.forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((el) => {
          const style = window.getComputedStyle(el);
          const zIndex = parseInt(style.zIndex) || 0;
          const position = style.position;

          if (position === 'fixed' && zIndex > 999) {
            el.remove();
          } else if (selector.includes('paywall') || selector.includes('cookie') || selector.includes('newsletter')) {
            el.remove();
          }
        });
      } catch {}
    });

    document.querySelectorAll('script[src*="analytics"]').forEach((el) => el.remove());
    document.querySelectorAll('script[src*="doubleclick"]').forEach((el) => el.remove());
    document.querySelectorAll('script[src*="facebook"]').forEach((el) => el.remove());
  });
}

export async function captureSingle(url, strategy, browser = null, earlyExitSignal = null) {
  let page;
  const ownBrowser = !browser;

  if (earlyExitSignal && earlyExitSignal.shouldStop) {
    return {
      worker: strategy.name,
      html: '',
      score: 0,
      success: false,
      skipped: true,
    };
  }

  if (ownBrowser) {
    browser = await getBrowserInstance();
  }

  try {
    const context = await browser.newContext();
    page = await context.newPage();

    await page.setViewportSize(getRandomViewport());
    await page.setExtraHTTPHeaders({
      'User-Agent': getRandomUserAgent(),
      'Accept-Language': 'en-US,en;q=0.9',
    });

    await page.setDefaultTimeout(30000);
    await blockTracking(page, strategy.blockAssets);

    if (strategy.earlyStop && strategy.delayMs === 0) {
      await page.goto(url, {
        waitUntil: strategy.waitUntil,
        timeout: 30000,
      });

      await page.evaluate(() => window.stop());
      await performEarlyCleanup(page);
    } else {
      await page.goto(url, {
        waitUntil: strategy.waitUntil,
        timeout: 30000,
      });

      if (strategy.earlyStop) {
        await page.evaluate(() => window.stop());
      }

      await performEarlyCleanup(page);

      if (strategy.delayMs > 0) {
        await page.waitForTimeout(strategy.delayMs);
      }
    }

    const html = await page.evaluate(() => {
      document.querySelectorAll('script, noscript').forEach((el) => el.remove());
      return document.documentElement.outerHTML;
    });

    const score = scoreHtml(html);
    const structuralMetrics = analyzeStructure(html);

    return {
      worker: strategy.name,
      html,
      score,
      success: true,
      textLength: html.replace(/<[^>]*>/g, '').length,
      ...structuralMetrics,
    };
  } catch (error) {
    return {
      worker: strategy.name,
      html: '',
      score: 0,
      success: false,
      error: error.message,
    };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

export async function captureBatch(url, timingVariance = 0, earlyExitSignal = null) {
  const browser = await getBrowserInstance();

  const strategies = WORKER_STRATEGIES.map((s) => ({
    ...s,
    delayMs: s.delayMs > 0 ? Math.max(0, s.delayMs + timingVariance) : s.delayMs,
  }));

  try {
    const promises = strategies.map((strategy) =>
      captureSingle(url, strategy, browser, earlyExitSignal)
    );

    const results = await Promise.allSettled(promises);

    return results
      .filter((r) => r.status === 'fulfilled' && r.value.success)
      .map((r) => r.value);
  } catch (error) {
    console.error(`[BATCH ERROR] ${error.message}`);
    return [];
  }
}

export async function captureMultiBatch(url, batchCount = 4, scoreThreshold = 120) {
  const allResults = [];
  const earlyExitSignal = { shouldStop: false };

  const batchPromises = [];

  for (let i = 0; i < batchCount; i++) {
    const variance = Math.floor(Math.random() * 250) - 125;

    const batchPromise = (async () => {
      if (earlyExitSignal.shouldStop) {
        return [];
      }

      const batchResults = await captureBatch(url, variance, earlyExitSignal);

      if (batchResults.length > 0) {
        const maxScore = Math.max(...batchResults.map((r) => r.score));
        if (maxScore >= scoreThreshold) {
          earlyExitSignal.shouldStop = true;
          console.log(`[EARLY EXIT] Score ${maxScore.toFixed(2)} >= ${scoreThreshold}`);
        }
      }

      return batchResults;
    })();

    batchPromises.push(batchPromise);
  }

  const batchResults = await Promise.allSettled(batchPromises);

  batchResults.forEach((result) => {
    if (result.status === 'fulfilled') {
      allResults.push(...result.value);
    }
  });

  return allResults;
}

function analyzeStructure(html) {
  const textContent = html.replace(/<[^>]*>/g, '');
  const htmlLength = html.length;
  const textLength = textContent.length;

  const textToHtmlRatio = htmlLength > 0 ? textLength / htmlLength : 0;

  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const hasArticleTag = !!articleMatch;
  const articleContentLength = articleMatch ? articleMatch[1].replace(/<[^>]*>/g, '').length : 0;

  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const hasMainTag = !!mainMatch;

  return {
    textToHtmlRatio,
    hasArticleTag,
    articleContentLength,
    hasMainTag,
  };
}

export function scoreHtml(html) {
  let score = 0;

  const textContent = html.replace(/<[^>]*>/g, '').trim();
  const textLength = textContent.length;
  const lowerText = html.toLowerCase();
  const htmlLength = html.length;

  if (textLength < 500) {
    return 0;
  }

  score += Math.min(textLength / 3000, 50);

  const pCount = (html.match(/<p[^>]*>/gi) || []).length;
  if (pCount < 3) {
    score -= 20;
  } else {
    score += Math.min(pCount * 2.5, 30);
  }

  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    const articleText = articleMatch[1].replace(/<[^>]*>/g, '').trim();
    const articleLength = articleText.length;

    if (articleLength > 1000) {
      score += 25;
    } else if (articleLength > 500) {
      score += 15;
    }
  }

  const semanticCount = (html.match(/<(article|section|main|header|footer|nav)[^>]*>/gi) || []).length;
  score += Math.min(semanticCount * 3, 20);

  const headingCount = (html.match(/<h[1-6][^>]*>/gi) || []).length;
  score += Math.min(headingCount * 1.5, 15);

  const textToHtmlRatio = htmlLength > 0 ? textLength / htmlLength : 0;
  if (textToHtmlRatio > 0.15) {
    score += 20;
  } else if (textToHtmlRatio > 0.10) {
    score += 10;
  }

  const strongPenaltyKeywords = [
    'join medium',
    'get unlimited access',
    'already a member',
    'subscribe now',
    'sign in to read',
    'log in to continue',
    'member only',
    'member exclusive',
    'subscribe to read',
    'paywall',
    'premium content',
    'exclusive to members',
    'read the full story',
  ];

  strongPenaltyKeywords.forEach((keyword) => {
    if (lowerText.includes(keyword)) {
      score -= 60;
    }
  });

  const mediumPenaltyKeywords = [
    'sign up',
    'subscribe',
    'membership',
    'upgrade',
    'become a member',
    'get access',
  ];

  mediumPenaltyKeywords.forEach((keyword) => {
    if (lowerText.includes(keyword)) {
      score -= 25;
    }
  });

  const divCount = (html.match(/<div[^>]*>/gi) || []).length;
  if (divCount > 600) {
    score -= 15;
  }

  if (html.includes('<script')) {
    score -= 20;
  }

  const inlineStyleCount = (html.match(/style="/gi) || []).length;
  if (inlineStyleCount > 200) {
    score -= 10;
  }

  return Math.max(score, 0);
}

export function validateContent(html, minTextLength = 500, minParagraphs = 2) {
  const textLength = html.replace(/<[^>]*>/g, '').length;
  const pCount = (html.match(/<p[^>]*>/gi) || []).length;

  return textLength >= minTextLength && pCount >= minParagraphs;
}
