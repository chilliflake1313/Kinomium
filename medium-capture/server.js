import express from 'express';
import { chromium } from 'playwright';
import { parse } from 'node-html-parser';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TRACKER_HOSTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'facebook.net',
  'segment.io',
  'hotjar.com',
  'mixpanel.com',
  'adservice.google.com',
  'taboola.com',
  'outbrain.com'
];

let browserPromise;

app.use(express.static(__dirname));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/capture', async (req, res) => {
  let target;
  try {
    target = normalizeUrl(req.query.url);
  } catch (error) {
    return res.status(400).type('text/plain').send(error.message);
  }

  try {
    const browser = await getBrowser();
    const configs = [
      { name: 'w1', waitUntil: 'domcontentloaded', stopAfterMs: 0, mode: 'stop' },
      { name: 'w2', waitUntil: 'domcontentloaded', stopAfterMs: 300, mode: 'stop' },
      { name: 'w3', waitUntil: 'domcontentloaded', stopAfterMs: 800, mode: 'stop' },
      { name: 'w4', waitUntil: 'networkidle', stopAfterMs: null, mode: 'plain' },
      { name: 'w5', waitUntil: 'load', stopAfterMs: null, mode: 'overlay' }
    ];

    let best = await captureAndSelect(browser, target, configs);

    if (!best || looksLikeMediumErrorPage(best.html) || !isQuality(best.html)) {
      const retryConfigs = [
        { name: 'r1', waitUntil: 'domcontentloaded', stopAfterMs: 1200, mode: 'stop' },
        { name: 'r2', waitUntil: 'domcontentloaded', stopAfterMs: 2000, mode: 'stop' },
        { name: 'r3', waitUntil: 'load', stopAfterMs: null, mode: 'overlay' },
        { name: 'r4', waitUntil: 'networkidle', stopAfterMs: null, mode: 'plain' },
        { name: 'r5', waitUntil: 'load', stopAfterMs: null, mode: 'plain' }
      ];
      const retryBest = await captureAndSelect(browser, target, retryConfigs);
      if (retryBest) {
        best = retryBest;
      }
    }

    if (!best) {
      return res.status(502).type('text/plain').send('Capture failed');
    }

    return res.type('html').send(best.html);
  } catch (error) {
    return res.status(500).type('text/plain').send(`Capture failed: ${error.message}`);
  }
});

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    throw new Error('Missing url query parameter');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('Only http/https URLs are allowed');
  }
  parsed.hash = '';
  return parsed.toString();
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

async function runWorker(browser, url, config) {
  const work = async () => {
    let freezeAfterStop = false;
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1440, height: 2200 }
    });

    await context.route('**/*', (route) => {
      const req = route.request();
      const reqUrl = req.url();
      const type = req.resourceType();

      if (TRACKER_HOSTS.some((host) => reqUrl.includes(host))) {
        return route.abort();
      }

      if (config.mode === 'stop' && freezeAfterStop && (type === 'script' || type === 'xhr' || type === 'fetch' || type === 'websocket')) {
        return route.abort();
      }

      if (type === 'media') {
        return route.abort();
      }

      if (config.mode === 'stop' && !freezeAfterStop && type === 'script') {
        return route.continue();
      }

      if (type === 'document' || type === 'stylesheet' || type === 'font' || type === 'script' || type === 'xhr' || type === 'fetch' || type === 'image') {
        return route.continue();
      }

      if (type === 'websocket') {
        return route.abort();
      }

      return route.continue();
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: config.waitUntil, timeout: 45000 });

    if (config.mode === 'stop') {
      if (config.stopAfterMs && config.stopAfterMs > 0) {
        await page.waitForTimeout(config.stopAfterMs);
      }
      await page.evaluate(() => window.stop());
      freezeAfterStop = true;
    }

    if (config.mode === 'overlay') {
      await page.evaluate(() => {
        const selectors = [
          '[data-testid="paywall"]',
          'div[role="dialog"]',
          '[data-testid="meteredContent"]',
          '[data-testid="headerSignUpButton"]',
          '[class*="overlay"]',
          '[id*="overlay"]',
          '[class*="modal"]',
          '[id*="modal"]',
          '[class*="paywall"]',
          '[id*="paywall"]',
          '[aria-modal="true"]'
        ];
        for (const selector of selectors) {
          document.querySelectorAll(selector).forEach((n) => n.remove());
        }

        document.querySelectorAll('*').forEach((el) => {
          const style = window.getComputedStyle(el);
          if (style.position === 'fixed' && Number(style.zIndex || '0') >= 1000) {
            el.remove();
          }
        });
      });
    }

    const html = await page.evaluate(() => document.documentElement.outerHTML);
    await page.close();
    await context.close();
    return { worker: config.name, html };
  };

  try {
    return await withTimeout(work(), 60000);
  } catch {
    return { worker: config.name, html: '' };
  }
}

function cleanupHtml(html) {
  const root = parse(String(html || ''));
  root.querySelectorAll('script').forEach((n) => n.remove());
  root.querySelectorAll('dialog').forEach((n) => n.remove());
  root.querySelectorAll('[role="dialog"]').forEach((n) => n.remove());
  root.querySelectorAll('[data-testid="paywall"]').forEach((n) => n.remove());
  root.querySelectorAll('[data-testid="meteredContent"]').forEach((n) => n.remove());
  root.querySelectorAll('[aria-modal="true"]').forEach((n) => n.remove());
  root.querySelectorAll('[class*="overlay"],[id*="overlay"],[class*="modal"],[id*="modal"],[class*="paywall"],[id*="paywall"]').forEach((n) => n.remove());
  return root.toString();
}

function scoreHtml(html) {
  const root = parse(String(html || ''));
  const text = root.textContent || '';
  const pCount = root.querySelectorAll('p').length;
  const lower = text.toLowerCase();
  let penalty = 0;
  if (lower.includes('sign up')) {
    penalty += 12000;
  }
  if (lower.includes('member only')) {
    penalty += 16000;
  }
  if (lower.includes('subscribe')) {
    penalty += 12000;
  }
  if (lower.includes('for members')) {
    penalty += 16000;
  }
  if (lower.includes('become a member')) {
    penalty += 16000;
  }
  if (lower.includes('paywall')) {
    penalty += 20000;
  }
  if (lower.includes('apologies, but something went wrong on our end')) {
    penalty += 30000;
  }
  if (lower.includes('check medium\'s site status')) {
    penalty += 30000;
  }
  if (lower.includes('find something interesting to read')) {
    penalty += 30000;
  }
  return text.length + pCount * 200 - penalty;
}

function isQuality(html) {
  const root = parse(String(html || ''));
  const textLength = (root.textContent || '').length;
  const pCount = root.querySelectorAll('p').length;
  return textLength >= 1200 && pCount >= 4 && !looksLikeMediumErrorPage(html);
}

async function captureAndSelect(browser, target, configs) {
  const results = await Promise.all(configs.map((cfg) => runWorker(browser, target, cfg)));
  const cleaned = results
    .filter((r) => r && r.html)
    .map((r) => {
      const html = cleanupHtml(r.html);
      const score = scoreHtml(html);
      return { ...r, html, score };
    });

  if (cleaned.length === 0) {
    return null;
  }

  const quality = cleaned.filter((r) => isQuality(r.html));
  const pool = quality.length > 0 ? quality : cleaned.filter((r) => !looksLikeMediumErrorPage(r.html));
  const finalPool = pool.length > 0 ? pool : cleaned;
  finalPool.sort((a, b) => b.score - a.score);
  return finalPool[0] || null;
}

function looksLikeMediumErrorPage(html) {
  const lower = String(html || '').toLowerCase();
  return (
    lower.includes('apologies, but something went wrong on our end') ||
    lower.includes('check medium\'s site status') ||
    lower.includes('find something interesting to read') ||
    lower.includes('error') && lower.includes('medium') && lower.includes('site status')
  );
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT} - server.js:247`);
});
