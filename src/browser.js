import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CdpClient } from "./cdp.js";
import { decodePng, encodePng } from "./png.js";

const defaultTimeoutMs = 45000;

export async function capturePage(url, outputPath, options = {}) {
  const browserPath = await findBrowser();
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-"));
  const browser = spawn(browserPath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--hide-scrollbars",
    "--ignore-certificate-errors",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  browser.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const port = await waitForDebugPort(userDataDir, defaultTimeoutMs);
    const target = await createTarget(port, url);
    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.ready;
    const result = await driveCapture(client, url, outputPath, options);
    client.close();
    return { ...result, browserPath };
  } catch (error) {
    const details = stderr.trim().split(/\r?\n/).slice(-6).join(" ");
    error.message = details ? `${error.message} Browser output: ${details}` : error.message;
    throw error;
  } finally {
    browser.kill();
    await waitForExit(browser, 4000);
    await fs.rm(userDataDir, { recursive: true, force: true });
    if (stderr.includes("DevToolsActivePort file doesn't exist")) {
      throw new Error("Browser could not start headless mode.");
    }
  }
}

export async function findBrowser() {
  const candidates = [
    process.env.BROWSER_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not find Edge or Chrome. Set BROWSER_PATH to your browser executable.");
}

async function driveCapture(client, url, outputPath, options) {
  const viewport = options.viewport || { width: 1440, height: 1000 };
  let stage = "initializing";
  try {
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  // The preset width/height are CSS pixels: keep the screenshot output at
  // that same visible size, otherwise high-DPI mobile DPR crops the left edge.
  await client.send("Emulation.setDeviceMetricsOverride", {
    mobile: Boolean(viewport.mobile),
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor || 1,
    screenWidth: viewport.width,
    screenHeight: viewport.height
  });
  if (viewport.touch) {
    await client.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5
    });
  }

  stage = "navigating";
  const loadEvent = client.waitFor("Page.loadEventFired", defaultTimeoutMs).catch(() => null);
  await client.send("Page.navigate", { url });
  await loadEvent;
  await sleep(options.waitAfterLoadMs ?? 2500);
  if (options.dismissPopups !== false) {
    await dismissObstructions(client);
  }

  let scrollInfo = null;
  if (options.fullPage && options.lazyLoadScroll !== false) {
    stage = "scrolling to trigger lazy content";
    scrollInfo = await prepareFullPage(client, options);
    if (options.dismissPopups !== false) {
      await dismissObstructions(client);
    }
  }

  stage = "reading page title";
  const titleResult = await client.send("Runtime.evaluate", {
    expression: "document.title",
    returnByValue: true
  }).catch(() => ({ result: { value: "" } }));

  stage = "measuring page";
  const metrics = await client.send("Page.getLayoutMetrics");
  const contentSize = metrics.cssContentSize || metrics.contentSize || {};
  const pageWidth = Math.max(viewport.width, Math.ceil(contentSize.width || viewport.width));
  const pageHeight = Math.max(viewport.height, Math.ceil(contentSize.height || viewport.height));
  const maxHeight = options.maxFullPageHeight || 16000;
  const clipHeight = options.fullPage ? Math.min(pageHeight, maxHeight) : viewport.height;
  const clipWidth = options.fullPage ? pageWidth : viewport.width;

  stage = "capturing screenshot";
  if (options.fullPage) {
    await captureStitchedScreenshot(client, outputPath, {
      width: clipWidth,
      height: clipHeight,
      viewportHeight: viewport.height,
      stepDelay: options.scrollStepMs ?? 350,
      hideFixedElementsAfterFirstSegment: options.hideFixedElementsAfterFirstSegment !== false
    });
  } else {
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true
    });
    await fs.writeFile(outputPath, screenshot.data, "base64");
  }

  return {
    title: titleResult.result?.value || "",
    width: clipWidth,
    height: clipHeight,
    fullPageHeight: pageHeight,
    truncated: options.fullPage ? pageHeight > clipHeight : false,
    scrollInfo
  };
  } catch (error) {
    error.message = `${error.message} (stage: ${stage})`;
    throw error;
  }
}

async function captureStitchedScreenshot(client, outputPath, options) {
  const width = Math.ceil(options.width);
  const height = Math.ceil(options.height);
  const viewportHeight = Math.max(320, Math.min(Math.ceil(options.viewportHeight), height));
  const rgba = new Uint8Array(width * height * 4);
  const positions = createSegmentPositions(height, viewportHeight);

  for (let index = 0; index < positions.length; index += 1) {
    const y = positions[index];
    if (index > 0 && options.hideFixedElementsAfterFirstSegment) {
      await hideFixedElements(client);
    }
    await dismissObstructions(client);
    await scrollTo(client, y);
    await sleep(Math.max(120, Math.min(700, options.stepDelay)));
    const segmentHeight = Math.min(viewportHeight, height - y);
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y,
        width,
        height: segmentHeight,
        scale: 1
      }
    });
    const image = decodePng(Buffer.from(screenshot.data, "base64"));
    copySegment(image, rgba, width, height, y);
  }

  await fs.writeFile(outputPath, encodePng(width, height, rgba));
}

async function dismissObstructions(client) {
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const clicked = [];
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (element) => [
        element.innerText,
        element.textContent,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.value,
        element.id,
        element.className
      ].filter(Boolean).join(" ").trim();
      const clickMatches = [
        /accept all/i,
        /agree/i,
        /allow all/i,
        /got it/i,
        /use necessary cookies only/i,
        /no thanks/i,
        /not now/i
      ];
      const closeMatches = [
        /close/i,
        /dismiss/i,
        /关闭/,
        /×/,
        /^x$/i
      ];
      const candidates = Array.from(document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit'], a, [aria-label], [title], [class], [id]"));
      for (const matcherSet of [clickMatches, closeMatches]) {
        for (const element of candidates) {
          if (!visible(element)) continue;
          const text = textOf(element);
          if (matcherSet.some((matcher) => matcher.test(text))) {
            const target = element.closest("button, [role='button'], a") || element;
            target.click();
            clicked.push(text || element.tagName);
          }
        }
      }
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return clicked;
    })()`,
    returnByValue: true
  }).catch(() => null);
  await sleep(700);
}

async function hideFixedElements(client) {
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      let hidden = 0;
      for (const element of document.querySelectorAll("body *")) {
        if (element.dataset.pageShotHidden === "true") continue;
        const style = getComputedStyle(element);
        const zIndex = Number.parseInt(style.zIndex, 10);
        if (style.position !== "fixed" && style.position !== "sticky" && !(Number.isFinite(zIndex) && zIndex >= 1000)) continue;
        const rect = element.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area < 400) continue;
        element.dataset.pageShotHidden = "true";
        element.style.setProperty("visibility", "hidden", "important");
        hidden += 1;
      }
      return hidden;
    })()`,
    returnByValue: true
  }).catch(() => null);
}

function createSegmentPositions(height, segmentHeight) {
  const positions = [];
  for (let y = 0; y < height; y += segmentHeight) {
    positions.push(y);
  }
  const finalStart = Math.max(0, height - segmentHeight);
  if (!positions.includes(finalStart)) {
    positions.push(finalStart);
  }
  return positions.sort((a, b) => a - b);
}

function copySegment(image, target, targetWidth, targetHeight, targetY) {
  const copyWidth = Math.min(image.width, targetWidth);
  const copyHeight = Math.min(image.height, targetHeight - targetY);
  for (let row = 0; row < copyHeight; row += 1) {
    const sourceStart = row * image.width * 4;
    const targetStart = (targetY + row) * targetWidth * 4;
    target.set(
      image.rgba.subarray(sourceStart, sourceStart + copyWidth * 4),
      targetStart
    );
  }
}

async function prepareFullPage(client, options) {
  const stepDelay = options.scrollStepMs ?? 350;
  const maxHeight = options.maxFullPageHeight || 16000;
  await client.send("Runtime.evaluate", {
    expression: `
      document.querySelectorAll("img[loading='lazy']").forEach((img) => {
        img.loading = "eager";
      });

      document.querySelectorAll("img").forEach((img) => {
        for (const attr of ["data-src", "data-original", "data-lazy-src"]) {
          const value = img.getAttribute(attr);
          if (value && !img.getAttribute("src")) {
            img.setAttribute("src", value);
          }
        }
        for (const attr of ["data-srcset", "data-lazy-srcset"]) {
          const value = img.getAttribute(attr);
          if (value && !img.getAttribute("srcset")) {
            img.setAttribute("srcset", value);
          }
        }
      });
    `
  });

  let state = await getPageState(client);
  let y = 0;
  let lastHeight = state.height;
  let stableRounds = 0;
  let scrolls = 0;
  const step = Math.max(360, Math.min(1400, Math.floor((state.viewportHeight || 1000) * 0.65)));
  const maxY = Math.min(maxHeight, 60000);
  const startedAt = Date.now();

  while (stableRounds < 3 && scrolls < 160 && Date.now() - startedAt < 90000) {
    await scrollTo(client, y);
    await sleep(stepDelay);
    state = await getPageState(client);
    scrolls += 1;

    if (state.height === lastHeight && y + state.viewportHeight >= state.height - 8) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }

    lastHeight = state.height;
    y += step;
    if (y > Math.min(state.height, maxY)) {
      y = state.height;
    }
  }

  await scrollTo(client, state.height);
  await sleep(Math.max(stepDelay, 700));
  await scrollTo(client, 0);
  await sleep(Math.max(stepDelay, 1200));
  state = await getPageState(client);

  return { ...state, scrolls };
}

async function getPageState(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const height = Math.max(
        document.body?.scrollHeight || 0,
        document.body?.offsetHeight || 0,
        document.documentElement?.clientHeight || 0,
        document.documentElement?.scrollHeight || 0,
        document.documentElement?.offsetHeight || 0
      );
      return {
        height,
        y: window.scrollY,
        viewportHeight: window.innerHeight,
        images: document.images.length,
        incompleteImages: Array.from(document.images || []).filter((img) => !img.complete).length
      };
    })()`,
    returnByValue: true
  });
  return result.result?.value || { height: 0, viewportHeight: 1000, images: 0, incompleteImages: 0 };
}

async function scrollTo(client, y) {
  await client.send("Runtime.evaluate", {
    expression: `window.scrollTo(0, ${Math.max(0, Math.floor(y))}); window.dispatchEvent(new Event("scroll"));`
  });
}

async function waitForDebugPort(userDataDir, timeoutMs) {
  const file = path.join(userDataDir, "DevToolsActivePort");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const content = await fs.readFile(file, "utf8");
      const [port] = content.trim().split(/\r?\n/);
      if (port) {
        return port;
      }
    } catch {
      await sleep(100);
    }
  }
  throw new Error("Timed out waiting for browser debugging port.");
}

async function createTarget(port, url) {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`Could not create browser target: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return;
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs)
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
