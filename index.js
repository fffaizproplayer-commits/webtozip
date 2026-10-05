const express = require("express");
const puppeteer = require("puppeteer");
const JSZip = require("jszip");
const axios = require("axios");
const { URL } = require("url");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

// ─── Helpers ─────────────────────────────────────────────────

function sanitizePath(urlStr) {
  try {
    const u = new URL(urlStr);
    let p = u.pathname + u.search;
    p = p.replace(/^\//, "").replace(/[?#]/g, "_").replace(/[<>:"/\\|*]/g, "_");
    if (!p || p === "" || p.endsWith("/")) p += "index.html";
    if (!path.extname(p)) p += ".html";
    return p || "index.html";
  } catch {
    return "file_" + Date.now();
  }
}

function isAsset(urlStr) {
  const ext = path.extname(new URL(urlStr).pathname).toLowerCase();
  return [".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
          ".ico", ".woff", ".woff2", ".ttf", ".eot", ".otf", ".mp4", ".webm",
          ".json", ".xml", ".pdf"].includes(ext);
}

function isSameDomain(base, target) {
  try {
    return new URL(target).hostname === new URL(base).hostname;
  } catch {
    return false;
  }
}

function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch {
    return null;
  }
}

// ─── Download asset via axios (fallback dari browser) ─────────

async function downloadAsset(url, headers) {
  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": new URL(url).origin,
        ...headers,
      },
      maxRedirects: 5,
    });
    return Buffer.from(res.data);
  } catch {
    return null;
  }
}

// ─── Main scrape function ─────────────────────────────────────

async function scrapeWebsite(targetUrl, onProgress) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--window-size=1366,768",
      "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    ],
  });

  const zip = new JSZip();
  const visited = new Set();
  const queue = [targetUrl];
  let processed = 0;
  let total = 1;

  try {
    const page = await browser.newPage();

    // Bypass bot detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    });

    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    });

    const collectAssets = new Set();

    // Intercept network untuk catat semua asset
    await page.setRequestInterception(true);
    page.on("request", (req) => req.continue());
    page.on("response", async (res) => {
      const url = res.url();
      if (isSameDomain(targetUrl, url) && !visited.has(url)) {
        const ct = res.headers()["content-type"] || "";
        if (!ct.includes("text/html")) {
          collectAssets.add(url);
        }
      }
    });

    // ── Loop crawl halaman ──
    while (queue.length > 0) {
      const currentUrl = queue.shift();
      if (visited.has(currentUrl)) continue;
      visited.add(currentUrl);

      try {
        onProgress?.({ type: "page", url: currentUrl, processed: ++processed, total });

        await page.goto(currentUrl, { waitUntil: "networkidle2", timeout: 30000 });
        await new Promise((r) => setTimeout(r, 800)); // tunggu lazy load

        const html = await page.content();
        const filePath = sanitizePath(currentUrl);
        zip.file(filePath, html);

        // Ambil semua link di halaman
        const links = await page.evaluate(() =>
          [...document.querySelectorAll("a[href]")].map((a) => a.href)
        );

        for (const link of links) {
          const resolved = resolveUrl(currentUrl, link);
          if (resolved && isSameDomain(targetUrl, resolved) && !visited.has(resolved) && !queue.includes(resolved)) {
            queue.push(resolved);
            total++;
          }
        }

        // Kumpulkan asset dari HTML
        const assetSelectors = await page.evaluate(() => {
          const assets = [];
          document.querySelectorAll("link[href]").forEach((el) => assets.push(el.href));
          document.querySelectorAll("script[src]").forEach((el) => assets.push(el.src));
          document.querySelectorAll("img[src]").forEach((el) => assets.push(el.src));
          document.querySelectorAll("[style]").forEach((el) => {
            const match = el.style.backgroundImage?.match(/url\(["']?(.+?)["']?\)/);
            if (match) assets.push(match[1]);
          });
          return assets;
        });

        for (const a of assetSelectors) {
          const resolved = resolveUrl(currentUrl, a);
          if (resolved && isSameDomain(targetUrl, resolved)) collectAssets.add(resolved);
        }
      } catch (err) {
        console.error("Error crawling:", currentUrl, err.message);
      }
    }

    // ── Download semua asset ──
    const assetList = [...collectAssets].filter((u) => !visited.has(u));
    total += assetList.length;

    for (const assetUrl of assetList) {
      if (visited.has(assetUrl)) continue;
      visited.add(assetUrl);
      onProgress?.({ type: "asset", url: assetUrl, processed: ++processed, total });

      const data = await downloadAsset(assetUrl);
      if (data) {
        const filePath = sanitizePath(assetUrl);
        zip.file(filePath, data);
      }
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    return zipBuffer;
  } finally {
    await browser.close();
  }
}

// ─── Routes ───────────────────────────────────────────────────

// SSE progress endpoint
app.get("/api/scrape", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "URL required" });

  let targetUrl;
  try {
    targetUrl = new URL(url.startsWith("http") ? url : "https://" + url).href;
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    send({ type: "start", message: "Browser started..." });

    const zipBuffer = await scrapeWebsite(targetUrl, (progress) => send(progress));

    // Simpan zip sementara di memory, kirim sebagai base64
    const b64 = zipBuffer.toString("base64");
    send({ type: "done", zip: b64, size: zipBuffer.length });
  } catch (err) {
    send({ type: "error", message: err.message });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => console.log(`Web-to-ZIP running on port ${PORT}`));
