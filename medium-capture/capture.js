import { chromium } from 'playwright';

const BROWSER_POOL = {
  instance: null,
  contextCount: 0,
  maxContexts: 5,
};

const WORKER_STRATEGIES = [
  { name: 'Ultra-Early-50ms', waitUntil: 'domcontentloaded', delayMs: 50, earlyStop: true },
  { name: 'Ultra-Early-150ms', waitUntil: 'domcontentloaded', delayMs: 150, earlyStop: true },
  { name: 'DOMContentLoaded-Immediate', waitUntil: 'domcontentloaded', delayMs: 0, earlyStop: true },
  { name: 'DOMContentLoaded-300ms', waitUntil: 'domcontentloaded', delayMs: 300, earlyStop: false },
  { name: 'NetworkIdle-800ms', waitUntil: 'networkidle', delayMs: 800, earlyStop: false },
];

export async function getBrowserInstance() {
  if (!BROWSER_POOL.instance) {
    BROWSER_POOL.instance = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
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

function blockTracking(page) {
  return page.route('**/*', (route) => {
    const url = route.request().url();
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
      url.includes('optimizely');

    if (shouldBlock) {
      return route.abort('blockedbyclient');
    }
    route.continue();
  });
}

async function performEarlyCleanup(page) {
  await page.evaluate(() => {
    const overlaySelectors = [
      '[role="dialog"]',
      '.modal',
      '.overlay',
      '.paywall',
      '.cookie-banner',
      '.newsletter-popup',
      '[class*="advertisement"]',
      '[class*="modal"]',
      '[class*="overlay"]',
      '[class*="paywall"]',
      '[class*="cookie"]',
      '[class*="newsletter"]',
      '[class*="subscription"]',
      '[class*="membership"]',
      'iframe[src*="doubleclick"]',
      'iframe[src*="facebook"]',
      'iframe[src*="google"]',
      'div[style*="position: fixed"]',
      'div[style*="position: sticky"]',
    ];

    overlaySelectors.forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((el) => el.remove());
      } catch {}
    });

    document.querySelectorAll('script[src*="analytics"]').forEach((el) => el.remove());
    document.querySelectorAll('script[src*="doubleclick"]').forEach((el) => el.remove());
    document.querySelectorAll('script[src*="facebook"]').forEach((el) => el.remove());
  });
}

export async function captureSingle(url, strategy, browser = null, abortSignal = null) {
  let page;
  const ownBrowser = !browser;

  if (ownBrowser) {
    browser = await getBrowserInstance();
  }

  try {
    const context = await browser.createIncognitoBrowserContext();
    page = await context.newPage();
    await page.setDefaultTimeout(30000);

    await blockTracking(page);

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

    const html = await page.content();

    const cleanedHtml = await page.evaluate((rawHtml) => {
      document.querySelectorAll('script, noscript').forEach((el) => el.remove());
      return document.documentElement.outerHTML;
    }, html);

    const score = scoreHtml(cleanedHtml);

    return {
      worker: strategy.name,
      html: cleanedHtml,
      score,
      success: true,
      textLength: cleanedHtml.replace(/<[^>]*>/g, '').length,
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
    if (ownBrowser) {
    }
  }
}

export async function captureBatch(url, timingVariance = 0) {
  const browser = await getBrowserInstance();

  const strategies = WORKER_STRATEGIES.map((s) => ({
    ...s,
    delayMs: s.delayMs > 0 ? Math.max(0, s.delayMs + timingVariance) : s.delayMs,
  }));

  try {
    const promises = strategies.map((strategy) =>
      captureSingle(url, strategy, browser)
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

export async function captureMultiBatch(url, batchCount = 4) {
  const allResults = [];
  const batchPromises = [];

  for (let i = 0; i < batchCount; i++) {
    const variance = Math.floor(Math.random() * 200) - 100;

    const batchPromise = (async () => {
      const batchResults = await captureBatch(url, variance);
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

export function scoreHtml(html) {
  let score = 100;

  const textContent = html.replace(/<[^>]*>/g, '').trim();
  const textLength = textContent.length;
  const lowerText = html.toLowerCase();

  if (textLength < 500) {
    score -= 40;
  } else if (textLength < 2000) {
    score += Math.min(textLength / 500, 20);
  } else {
    score += Math.min(textLength / 5000, 40);
  }

  const pCount = (html.match(/<p[^>]*>/gi) || []).length;
  if (pCount < 3) {
    score -= 15;
  } else {
    score += Math.min(pCount * 2, 25);
  }

  const semanticCount = (html.match(/<(article|section|main|header|footer|nav)[^>]*>/gi) || []).length;
  score += Math.min(semanticCount * 3, 15);

  const headingCount = (html.match(/<h[1-6][^>]*>/gi) || []).length;
  score += Math.min(headingCount, 10);

  const strongPenaltyKeywords = [
    'join medium',
    'get unlimited access',
    'already a member',
    'subscribe now',
    'sign in',
    'log in',
    'member only',
    'member exclusive',
    'subscribe to read',
    'paywall',
    'premium content',
    'exclusive content',
  ];

  strongPenaltyKeywords.forEach((keyword) => {
    if (lowerText.includes(keyword)) {
      score -= 50;
    }
  });

  const mediumPenaltyKeywords = ['sign up', 'subscribe', 'membership', 'upgrade'];
  mediumPenaltyKeywords.forEach((keyword) => {
    if (lowerText.includes(keyword)) {
      score -= 20;
    }
  });

  const divCount = (html.match(/<div[^>]*>/gi) || []).length;
  if (divCount > 500) {
    score -= 10;
  }

  if (html.includes('<script')) {
    score -= 15;
  }

  const inlineStyleCount = (html.match(/style="/gi) || []).length;
  if (inlineStyleCount > 150) {
    score -= 5;
  }

  return Math.max(score, 0);
}

export function validateContent(html, minTextLength = 500, minParagraphs = 2) {
  const textLength = html.replace(/<[^>]*>/g, '').length;
  const pCount = (html.match(/<p[^>]*>/gi) || []).length;

  return textLength >= minTextLength && pCount >= minParagraphs;
}
