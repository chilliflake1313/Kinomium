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
  { name: 'Pre-DOM-Commit', waitUntil: 'commit', snapshots: [0], earlyStop: true, blockAssets: true, timeout: 8000, jsEnabled: true },
  { name: 'Ultra-Early-Multi', waitUntil: 'domcontentloaded', snapshots: [0, 50, 150], earlyStop: true, blockAssets: true, timeout: 10000, jsEnabled: true },
  { name: 'DOM-Progressive', waitUntil: 'domcontentloaded', snapshots: [0, 300, 800], earlyStop: false, blockAssets: false, timeout: 15000, jsEnabled: true },
  { name: 'NoJS-Early', waitUntil: 'domcontentloaded', snapshots: [0], earlyStop: false, blockAssets: false, timeout: 15000, jsEnabled: false },
  { name: 'NetworkIdle-Complete', waitUntil: 'networkidle', snapshots: [0, 500], earlyStop: false, blockAssets: false, timeout: 30000, jsEnabled: true },
];

let memoryUsage = { contexts: 0, pages: 0 };

export async function getBrowserInstance() {
  if (!BROWSER_POOL.instance) {
    BROWSER_POOL.instance = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }
  return BROWSER_POOL.instance;
}

export async function closeBrowserPool() {
  if (BROWSER_POOL.instance) {
    await BROWSER_POOL.instance.close();
    BROWSER_POOL.instance = null;
    memoryUsage = { contexts: 0, pages: 0 };
  }
}

export function getMemoryUsage() {
  return { ...memoryUsage };
}

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getRandomViewport() {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

async function blockNonEssential(page, blockAssets = false) {
  await page.route('**/*', (route) => {
    const url = route.request().url();
    const resourceType = route.request().resourceType();

    const shouldBlock =
      url.includes('analytics') ||
      url.includes('doubleclick') ||
      url.includes('google-analytics') ||
      url.includes('googletagmanager') ||
      url.includes('facebook.com/tr') ||
      url.includes('facebook.com/plugins') ||
      url.includes('tracking') ||
      url.includes('gtag') ||
      url.includes('segment.io') ||
      url.includes('mixpanel') ||
      url.includes('amplitude') ||
      url.includes('hotjar') ||
      url.includes('optimizely') ||
      url.includes('chartbeat') ||
      url.includes('newrelic') ||
      url.includes('quantserve') ||
      url.includes('scorecardresearch') ||
      url.includes('taboola') ||
      url.includes('outbrain') ||
      url.includes('ad-delivery') ||
      url.includes('advertising');

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

async function removeNonEssentialDOM(page) {
  await page.evaluate(() => {
    const selectors = [
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
      'iframe[src*="twitter"]',
      'iframe[src*="instagram"]',
    ];

    selectors.forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((el) => {
          const style = window.getComputedStyle(el);
          const zIndex = parseInt(style.zIndex) || 0;
          const position = style.position;

          if (
            (position === 'fixed' && zIndex > 999) ||
            selector.includes('paywall') ||
            selector.includes('cookie') ||
            selector.includes('newsletter')
          ) {
            el.remove();
          }
        });
      } catch {}
    });

    document.querySelectorAll('script[src*="analytics"]').forEach((el) => el.remove());
    document.querySelectorAll('script[src*="doubleclick"]').forEach((el) => el.remove());
    document.querySelectorAll('script[src*="facebook"]').forEach((el) => el.remove());
    document.querySelectorAll('script[src*="tracking"]').forEach((el) => el.remove());
    document.querySelectorAll('script[src*="ads"]').forEach((el) => el.remove());
  });
}

async function captureSnapshot(page) {
  await removeNonEssentialDOM(page);

  const html = await page.evaluate(() => {
    document.querySelectorAll('script, noscript').forEach((el) => el.remove());
    return document.documentElement.outerHTML;
  });

  return html;
}

export async function captureSingle(url, strategy, browser = null, abortController = null) {
  let page;
  let context;
  const ownBrowser = !browser;

  if (abortController?.signal.aborted) {
    return [];
  }

  if (ownBrowser) {
    browser = await getBrowserInstance();
  }

  try {
    context = await browser.newContext({
      userAgent: getRandomUserAgent(),
      viewport: getRandomViewport(),
      javaScriptEnabled: strategy.jsEnabled,
    });
    memoryUsage.contexts++;

    page = await context.newPage();
    memoryUsage.pages++;

    page.setDefaultTimeout(strategy.timeout);

    const abortListener = () => {
      if (page && !page.isClosed()) {
        page.close().catch(() => {});
      }
    };

    if (abortController) {
      abortController.signal.addEventListener('abort', abortListener);
    }

    await blockNonEssential(page, strategy.blockAssets);

    await page.goto(url, {
      waitUntil: strategy.waitUntil,
      timeout: strategy.timeout,
    });

    if (strategy.earlyStop && strategy.jsEnabled) {
      await page.evaluate(() => window.stop());
    }

    const snapshots = [];

    for (const delayMs of strategy.snapshots) {
      if (abortController?.signal.aborted) break;

      if (delayMs > 0) {
        await page.waitForTimeout(delayMs);
      }

      const html = await captureSnapshot(page);
      const score = scoreHtml(html);
      const metrics = analyzeStructure(html);
      const dominance = analyzeContentDominance(html);

      snapshots.push({
        worker: `${strategy.name}-${delayMs}ms`,
        html,
        score,
        success: true,
        jsEnabled: strategy.jsEnabled,
        delayMs,
        textLength: html.replace(/<[^>]*>/g, '').length,
        ...metrics,
        ...dominance,
      });
    }

    if (abortController) {
      abortController.signal.removeEventListener('abort', abortListener);
    }

    return snapshots;
  } catch (error) {
    return [
      {
        worker: strategy.name,
        html: '',
        score: 0,
        success: false,
        error: error.message,
      },
    ];
  } finally {
    if (page && !page.isClosed()) {
      await page.close().catch(() => {});
      memoryUsage.pages--;
    }
    if (context) {
      await context.close().catch(() => {});
      memoryUsage.contexts--;
    }
  }
}

export async function captureBatch(url, timingVariance = 0, abortController = null) {
  const browser = await getBrowserInstance();

  const strategies = WORKER_STRATEGIES.map((s) => ({
    ...s,
    snapshots: s.snapshots.map((delay) => Math.max(0, delay + timingVariance)),
  }));

  try {
    const promises = strategies.map((strategy) =>
      captureSingle(url, strategy, browser, abortController)
    );

    const results = await Promise.allSettled(promises);

    const allSnapshots = [];
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        allSnapshots.push(...result.value.filter((s) => s.success));
      }
    });

    return allSnapshots;
  } catch (error) {
    console.error(`[BATCH ERROR] ${error.message}`);
    return [];
  }
}

export async function captureMultiBatch(url, batchCount = 4, dynamicThreshold = null) {
  const allResults = [];
  const abortController = new AbortController();

  const batchPromises = [];

  for (let i = 0; i < batchCount; i++) {
    const variance = Math.floor(Math.random() * 150) - 75;

    const batchPromise = (async () => {
      if (abortController.signal.aborted) {
        return [];
      }

      const batchResults = await captureBatch(url, variance, abortController);

      if (batchResults.length > 0 && dynamicThreshold) {
        const maxScore = Math.max(...batchResults.map((r) => r.score));
        if (maxScore >= dynamicThreshold) {
          abortController.abort();
          console.log(`[EARLY EXIT] Score ${maxScore.toFixed(2)} >= ${dynamicThreshold}`);
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
  const mainContentLength = mainMatch ? mainMatch[1].replace(/<[^>]*>/g, '').length : 0;

  return {
    textToHtmlRatio,
    hasArticleTag,
    articleContentLength,
    hasMainTag,
    mainContentLength,
  };
}

function analyzeContentDominance(html) {
  const totalText = html.replace(/<[^>]*>/g, '').length;

  const navMatch = html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/gi);
  const navText = navMatch
    ? navMatch.map((n) => n.replace(/<[^>]*>/g, '')).join('').length
    : 0;

  const headerMatch = html.match(/<header[^>]*>([\s\S]*?)<\/header>/gi);
  const headerText = headerMatch
    ? headerMatch.map((h) => h.replace(/<[^>]*>/g, '')).join('').length
    : 0;

  const footerMatch = html.match(/<footer[^>]*>([\s\S]*?)<\/footer>/gi);
  const footerText = footerMatch
    ? footerMatch.map((f) => f.replace(/<[^>]*>/g, '')).join('').length
    : 0;

  const noiseText = navText + headerText + footerText;
  const contentText = totalText - noiseText;

  const contentDominanceRatio = totalText > 0 ? contentText / totalText : 0;

  return {
    contentDominanceRatio,
    noiseText,
    contentText,
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

  score += Math.min(textLength / 2500, 50);

  const pCount = (html.match(/<p[^>]*>/gi) || []).length;
  if (pCount < 3) {
    score -= 25;
  } else {
    score += Math.min(pCount * 2.5, 35);
  }

  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    const articleText = articleMatch[1].replace(/<[^>]*>/g, '').trim();
    const articleLength = articleText.length;

    if (articleLength > 2000) {
      score += 30;
    } else if (articleLength > 1000) {
      score += 20;
    } else if (articleLength > 500) {
      score += 10;
    }
  }

  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) {
    const mainText = mainMatch[1].replace(/<[^>]*>/g, '').trim();
    if (mainText.length > 1000) {
      score += 15;
    }
  }

  const semanticCount = (html.match(/<(article|section|main|header|footer|nav)[^>]*>/gi) || []).length;
  score += Math.min(semanticCount * 2.5, 20);

  const headingCount = (html.match(/<h[1-6][^>]*>/gi) || []).length;
  score += Math.min(headingCount * 1.5, 15);

  const textToHtmlRatio = htmlLength > 0 ? textLength / htmlLength : 0;
  if (textToHtmlRatio > 0.18) {
    score += 25;
  } else if (textToHtmlRatio > 0.12) {
    score += 15;
  } else if (textToHtmlRatio > 0.08) {
    score += 5;
  }

  const navText = (html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/gi) || [])
    .map((n) => n.replace(/<[^>]*>/g, ''))
    .join('').length;

  const contentDominance = textLength > 0 ? (textLength - navText) / textLength : 0;
  if (contentDominance > 0.85) {
    score += 20;
  } else if (contentDominance > 0.70) {
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
    'continue reading',
    'upgrade to continue',
  ];

  strongPenaltyKeywords.forEach((keyword) => {
    if (lowerText.includes(keyword)) {
      score -= 70;
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
      score -= 30;
    }
  });

  const divCount = (html.match(/<div[^>]*>/gi) || []).length;
  if (divCount > 600) {
    score -= 15;
  }

  if (html.includes('<script')) {
    score -= 25;
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

export function calculateDynamicThreshold(historicalScores = []) {
  if (historicalScores.length === 0) {
    return 130;
  }

  const avg = historicalScores.reduce((sum, s) => sum + s, 0) / historicalScores.length;
  const max = Math.max(...historicalScores);

  return Math.min(max * 0.95, avg * 1.3, 150);
}
