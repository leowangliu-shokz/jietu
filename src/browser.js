import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";
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
    await removeTempDir(userDataDir);
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
  const urlCheck = {
    requestedUrl: url,
    finalUrl: "",
    ok: false,
    checks: []
  };
  const deferShokzMobileNavDismiss = options.captureMode === "shokz-products-nav" && Boolean(viewport.mobile);
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
  await verifyCurrentUrl(client, url, "after navigation", urlCheck);
  if (options.dismissPopups !== false && !deferShokzMobileNavDismiss) {
    await dismissObstructions(client);
    if (shouldGuardShokzSearchOverlay(url, viewport, options)) {
      await ensureShokzSearchOverlayClosed(client, "after dismissing popups");
    }
    await verifyCurrentUrl(client, url, "after dismissing popups", urlCheck);
  }

  if (options.captureMode === "shokz-products-nav") {
    stage = "opening Shokz products navigation";
    await openShokzProductsNavigation(client, viewport);
    if (deferShokzMobileNavDismiss) {
      await hideShokzMarketingOverlays(client);
    }
    await verifyCurrentUrl(client, url, "after opening Shokz products navigation", urlCheck);
  }

  if (options.captureMode === "shokz-home-banners" || options.captureMode === "shokz-home-related") {
    stage = "reading page title";
    const titleResult = await readPageTitle(client);
    stage = options.captureMode === "shokz-home-related"
      ? "capturing Shokz home related sections"
      : "capturing Shokz home banners";
    const relatedCapture = options.captureMode === "shokz-home-related"
      ? await captureShokzHomeRelated(client, outputPath, viewport)
      : await captureShokzHomeBanners(client, outputPath, viewport);
    const finalUrl = await verifyCurrentUrl(client, url, "after related capture", urlCheck);
    urlCheck.ok = true;
    return {
      requestedUrl: url,
      finalUrl,
      urlCheck,
      title: titleResult,
      width: relatedCapture.width,
      height: relatedCapture.height,
      fullPageHeight: relatedCapture.height,
      truncated: false,
      scrollInfo: null,
      ...relatedCapture
    };
  }

  let scrollInfo = null;
  if (options.fullPage && options.lazyLoadScroll !== false) {
    stage = "scrolling to trigger lazy content";
    scrollInfo = await prepareFullPage(client, options);
    await verifyCurrentUrl(client, url, "after lazy-load scrolling", urlCheck);
    if (shouldGuardShokzSearchOverlay(url, viewport, options)) {
      await ensureShokzSearchOverlayClosed(client, "after lazy-load scrolling");
    }
    if (options.dismissPopups !== false) {
      await dismissObstructions(client);
      if (shouldGuardShokzSearchOverlay(url, viewport, options)) {
        await ensureShokzSearchOverlayClosed(client, "after post-scroll popup cleanup");
      }
      await verifyCurrentUrl(client, url, "after post-scroll popup cleanup", urlCheck);
    }
  }

  stage = "reading page title";
  const titleResult = await readPageTitle(client);

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
    const guardShokzSearchOverlay = shouldGuardShokzSearchOverlay(url, viewport, options);
    if (guardShokzSearchOverlay) {
      await ensureShokzSearchOverlayClosed(client, "before screenshot capture");
    }
    await captureStitchedScreenshot(client, outputPath, {
      width: clipWidth,
      height: clipHeight,
      viewportHeight: viewport.height,
      stepDelay: options.scrollStepMs ?? 350,
      hideFixedElementsAfterFirstSegment: options.hideFixedElementsAfterFirstSegment !== false,
      beforeFirstSegmentCapture: guardShokzSearchOverlay
        ? () => ensureShokzSearchOverlayClosed(client, "before first segment screenshot capture")
        : null
    });
  } else {
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true
    });
    await fs.writeFile(outputPath, screenshot.data, "base64");
  }
  const finalUrl = await verifyCurrentUrl(client, url, "after screenshot capture", urlCheck);
  urlCheck.ok = true;

  return {
    requestedUrl: url,
    finalUrl,
    urlCheck,
    title: titleResult,
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

async function readPageTitle(client) {
  const titleResult = await client.send("Runtime.evaluate", {
    expression: "document.title",
    returnByValue: true
  }).catch(() => ({ result: { value: "" } }));
  return titleResult.result?.value || "";
}

function shouldGuardShokzSearchOverlay(url, viewport, options = {}) {
  if (viewport.mobile || options.captureMode) {
    return false;
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "") === "shokz.com";
  } catch {
    return false;
  }
}

const homeRelatedSectionDefinitions = [
  {
    key: "product-showcase",
    sectionLabel: "产品橱窗",
    title: "产品橱窗轮播图",
    mode: "tabs-carousel",
    anchors: ["Best Selling", "Sports Headphones", "Workout & Lifestyle Earbuds", "Communication Headsets"],
    tabs: ["Best Selling", "Sports Headphones", "Workout & Lifestyle Earbuds", "Communication Headsets"],
    labelMode: "tab"
  },
  {
    key: "scene-explore",
    sectionLabel: "场景探索区",
    title: "场景探索轮播图",
    mode: "carousel",
    anchors: [
      "How Shokz Makes It Possible",
      "Headphones Built for Sport",
      "Why Open-Ear Listening Matters"
    ],
    labelPrefix: "场景"
  },
  {
    key: "athletes",
    sectionLabel: "运动员区",
    title: "运动员区轮播图",
    mode: "tabs-carousel",
    anchors: ["Trusted by Athletes", "Marathon", "Trail Running", "Triathlon"],
    tabs: ["Marathon", "Trail Running", "Triathlon"],
    labelMode: "tab"
  },
  {
    key: "media",
    sectionLabel: "媒体区",
    title: "媒体区轮播图",
    mode: "carousel",
    anchors: ["Media Reviews"],
    labelPrefix: "媒体"
  },
  {
    key: "voices",
    sectionLabel: "用户心声区",
    title: "用户心声轮播图",
    mode: "carousel",
    anchors: ["Real Stories, Inspiring Moments."],
    labelPrefix: "心声"
  }
];

async function captureShokzHomeRelated(client, outputPath, viewport) {
  await scrollTo(client, 0);
  await sleep(700);
  await primeLazyImages(client);

  const captures = [];
  const sections = [];
  const warnings = [];
  let maxWidth = 0;
  let maxHeight = 0;

  try {
    const bannerCapture = await captureShokzHomeBanners(client, outputPath, viewport);
    captures.push(...bannerCapture.captures);
    maxWidth = Math.max(maxWidth, bannerCapture.width || 0);
    maxHeight = Math.max(maxHeight, bannerCapture.height || 0);
    sections.push({
      sectionKey: "banner",
      sectionLabel: "Banner",
      expectedCount: bannerCapture.bannerInfo?.expectedCount || bannerCapture.captures.length,
      capturedCount: bannerCapture.captures.length,
      savedCount: bannerCapture.captures.filter((item) => !item.isDefaultState).length,
      status: "ok"
    });
  } catch (error) {
    warnings.push({
      sectionKey: "banner",
      sectionLabel: "Banner",
      message: error.message
    });
    sections.push({
      sectionKey: "banner",
      sectionLabel: "Banner",
      expectedCount: 0,
      capturedCount: 0,
      savedCount: 0,
      status: "warning"
    });
  }

  for (const definition of homeRelatedSectionDefinitions) {
    try {
      const sectionCapture = await captureShokzHomeRelatedSection(client, outputPath, viewport, definition);
      captures.push(...sectionCapture.captures);
      warnings.push(...sectionCapture.warnings);
      maxWidth = Math.max(maxWidth, sectionCapture.width || 0);
      maxHeight = Math.max(maxHeight, sectionCapture.height || 0);
      sections.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        expectedCount: sectionCapture.expectedCount,
        capturedCount: sectionCapture.capturedCount,
        savedCount: sectionCapture.captures.length,
        status: sectionCapture.warnings.length ? "warning" : "ok"
      });
    } catch (error) {
      warnings.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        message: error.message
      });
      sections.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        expectedCount: 0,
        capturedCount: 0,
        savedCount: 0,
        status: "warning"
      });
    }
  }

  captures.sort(compareRelatedCaptures);

  return {
    width: maxWidth || viewport.width,
    height: maxHeight || viewport.height,
    captures,
    relatedValidation: {
      status: warnings.length ? "warning" : "ok",
      warnings,
      sections
    }
  };
}

async function captureShokzHomeBanners(client, outputPath, viewport) {
  await scrollTo(client, 0);
  await sleep(700);
  await primeLazyImages(client);

  const plan = await readShokzHomeBannerPlan(client);
  if (!plan.ok || !plan.count) {
    const reason = plan.reason ? ` ${plan.reason}` : "";
    throw new Error(`Could not identify Shokz home banner carousel.${reason}`);
  }

  const captures = [];
  const duplicates = [];
  const seenLogical = new Set();
  const seenVisual = new Set();
  let maxWidth = 0;
  let maxHeight = 0;

  for (let index = 0; index < plan.count; index += 1) {
    const slide = plan.slides[index] || { ordinal: index, realIndex: index, logicalId: `banner-${index}` };
    await activateShokzHomeBanner(client, slide, index);
    await sleep(900);
    await waitForBannerImages(client);
    await dismissObstructions(client, { rounds: 5 });
    await sleep(500);

    const state = await readShokzHomeBannerState(client, index);
    if (!state.ok) {
      throw new Error(state.reason || `Could not read Shokz banner ${index + 1} state.`);
    }

    const clip = normalizeBannerClip(state.clip, viewport);
    if (!clip) {
      throw new Error(`Could not compute a valid crop for Shokz banner ${index + 1}.`);
    }
    await dismissObstructions(client, { rounds: 2 });
    await hideFixedElements(client);
    await sleep(150);

    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip
    });
    const buffer = Buffer.from(screenshot.data, "base64");
    const visualSignature = hashBuffer(buffer);
    const visualHash = visualHashForBuffer(buffer);
    const bannerIndex = bannerIndexForCapture(index, state, slide, plan.count);
    const bannerSignature = state.signature || slide.signature || `banner-${bannerIndex}`;
    const duplicate = seenLogical.has(bannerSignature) || seenVisual.has(visualSignature);

    if (duplicate) {
      duplicates.push({
        bannerIndex,
        bannerSignature,
        visualSignature
      });
      continue;
    }

    seenLogical.add(bannerSignature);
    seenVisual.add(visualSignature);

    const bannerOutput = bannerOutputPath(outputPath, bannerIndex);
    await fs.writeFile(bannerOutput, buffer);
    maxWidth = Math.max(maxWidth, Math.round(clip.width));
    maxHeight = Math.max(maxHeight, Math.round(clip.height));
    captures.push({
      outputPath: bannerOutput,
      width: Math.round(clip.width),
      height: Math.round(clip.height),
      kind: "banner",
      sectionKey: "banner",
      sectionLabel: "Banner",
      sectionTitle: "Banner 轮播图",
      stateIndex: bannerIndex,
      stateCount: plan.count,
      stateLabel: `轮播 ${bannerIndex}`,
      label: `轮播 ${bannerIndex}`,
      logicalSignature: bannerSignature,
      visualHash,
      visualAudit: { status: "ok", visualHash },
      isDefaultState: bannerIndex === 1,
      bannerIndex,
      bannerCount: plan.count,
      bannerSignature,
      visualSignature,
      bannerClip: {
        x: Math.round(clip.x),
        y: Math.round(clip.y),
        width: Math.round(clip.width),
        height: Math.round(clip.height)
      },
      bannerState: {
        activeIndex: state.activeIndex,
        realIndex: state.realIndex,
        text: state.text || "",
        textBlocks: state.textBlocks || [],
        images: state.images || []
      }
    });
  }

  if (!captures.length) {
    throw new Error("Shokz home banner capture found slides but every screenshot looked duplicated.");
  }

  validateBannerCaptureCompleteness(captures, plan.count, duplicates);
  captures.sort((a, b) => Number(a.bannerIndex || 0) - Number(b.bannerIndex || 0));

  return {
    width: maxWidth,
    height: maxHeight,
    captures,
    bannerInfo: {
      expectedCount: plan.count,
      capturedCount: captures.length,
      duplicateCount: duplicates.length,
      duplicates,
      status: "ok",
      slides: plan.slides
    }
  };
}

async function captureShokzHomeRelatedSection(client, outputPath, viewport, definition) {
  await primeLazyImages(client);
  const plan = await readShokzHomeRelatedSectionPlan(client, definition);
  if (!plan.ok || !Array.isArray(plan.states) || !plan.states.length) {
    const warningReason = Array.isArray(plan.warnings) && plan.warnings.length
      ? ` ${plan.warnings.map((warning) => warning.message).filter(Boolean).join(" ")}`
      : "";
    const reason = plan.reason ? ` ${plan.reason}` : warningReason;
    throw new Error(`Could not identify Shokz ${definition.sectionLabel} carousel.${reason}`);
  }

  const captures = [];
  const warnings = Array.isArray(plan.warnings) ? [...plan.warnings] : [];
  const seenLogicalByScope = new Map();
  const seenVisualByScope = new Map();
  const seenHashesByScope = new Map();
  let maxWidth = 0;
  let maxHeight = 0;

  for (const state of plan.states) {
    await activateShokzHomeRelatedState(client, definition, state);
    await sleep(650);
    await waitForRelatedSectionImages(client, definition.key);
    await dismissObstructions(client, { rounds: 2 });
    await hideFixedElements(client);
    await sleep(180);

    const current = await readShokzHomeRelatedState(client, definition, state);
    if (!current.ok) {
      warnings.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        stateLabel: state.stateLabel,
        message: current.reason || `Could not read ${definition.sectionLabel} state.`
      });
      continue;
    }

    const clip = normalizeRelatedClip(current.clip, viewport);
    if (!clip) {
      warnings.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        stateLabel: state.stateLabel,
        message: `Could not compute a valid crop for ${definition.sectionLabel} ${state.stateLabel}.`
      });
      continue;
    }

    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip
    });
    const buffer = Buffer.from(screenshot.data, "base64");
    const visualSignature = hashBuffer(buffer);
    const visualHash = visualHashForBuffer(buffer);
    const logicalSignature = current.logicalSignature || state.logicalSignature || `${definition.key}:${state.stateIndex}`;
    const captureScope = relatedCaptureScopeKey(definition, state);
    const seenLogical = scopedSet(seenLogicalByScope, captureScope);
    const seenVisual = scopedSet(seenVisualByScope, captureScope);
    const seenHashes = scopedList(seenHashesByScope, captureScope);

    if (seenLogical.has(logicalSignature) || seenVisual.has(visualSignature)) {
      warnings.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        stateLabel: state.stateLabel,
        message: `${definition.sectionLabel} ${state.stateLabel} looked duplicated and was not saved.`
      });
      continue;
    }

    const similar = nearestVisualHash(visualHash, seenHashes);
    const visualAudit = similar && similar.distance <= 3
      ? {
          status: "warning",
          visualHash,
          similarTo: similar.label,
          distance: similar.distance,
          message: `视觉签名与 ${similar.label} 非常接近`
        }
      : { status: "ok", visualHash };
    if (visualAudit.status === "warning") {
      warnings.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        stateLabel: state.stateLabel,
        message: visualAudit.message
      });
    }

    seenLogical.add(logicalSignature);
    seenVisual.add(visualSignature);
    seenHashes.push({ hash: visualHash, label: state.stateLabel });

    const relatedOutput = relatedOutputPath(outputPath, definition.key, state.fileId || state.stateIndex);
    await fs.writeFile(relatedOutput, buffer);
    maxWidth = Math.max(maxWidth, Math.round(clip.width));
    maxHeight = Math.max(maxHeight, Math.round(clip.height));
    captures.push({
      outputPath: relatedOutput,
      width: Math.round(clip.width),
      height: Math.round(clip.height),
      kind: state.kind || "carousel",
      sectionKey: definition.key,
      sectionLabel: definition.sectionLabel,
      sectionTitle: definition.title,
      stateIndex: state.stateIndex,
      stateCount: state.pageCount || plan.states.length,
      stateLabel: state.stateLabel,
      label: state.stateLabel,
      tabLabel: state.tabLabel || null,
      tabIndex: state.tabIndex || null,
      pageIndex: state.pageIndex || null,
      productCount: state.productCount || null,
      visibleProductCount: state.visibleProductCount || null,
      visibleProducts: state.visibleProducts || null,
      itemCount: state.itemCount || null,
      visibleItemCount: state.visibleItemCount || null,
      visibleItems: state.visibleItems || null,
      logicalSignature,
      visualSignature,
      visualHash,
      visualAudit,
      clip: {
        x: Math.round(clip.x),
        y: Math.round(clip.y),
        width: Math.round(clip.width),
        height: Math.round(clip.height)
      },
      isDefaultState: false,
      sectionState: {
        text: current.text || "",
        textBlocks: current.textBlocks || [],
        images: current.images || [],
        activeIndex: current.activeIndex ?? state.stateIndex,
        tabLabel: state.tabLabel || null,
        tabIndex: state.tabIndex || null,
        pageIndex: state.pageIndex || null,
        productCount: state.productCount || null,
        visibleProductCount: state.visibleProductCount || null,
        visibleProducts: state.visibleProducts || null,
        itemCount: state.itemCount || null,
        visibleItemCount: state.visibleItemCount || null,
        visibleItems: state.visibleItems || null
      }
    });
  }

  return {
    width: maxWidth,
    height: maxHeight,
    captures,
    warnings,
    expectedCount: plan.states.length,
    capturedCount: captures.length
  };
}

async function readShokzHomeRelatedSectionPlan(client, definition) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const definition = ${JSON.stringify(definition)};
      const warnings = [];
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const cleanText = (value, max = 360) => String(value || "")
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, max);
      const isTabbedCardSection = definition.key === "product-showcase" || definition.key === "athletes";
      const classText = (element) => String(element?.className?.baseVal || element?.className || "");
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const intersects = (rect, rootRect) =>
        Math.max(0, Math.min(rect.right, rootRect.right) - Math.max(rect.left, rootRect.left)) *
        Math.max(0, Math.min(rect.bottom, rootRect.bottom) - Math.max(rect.top, rootRect.top));
      const textOf = (element, max = 360) => cleanText([
        element?.innerText,
        element?.textContent,
        element?.getAttribute?.("aria-label"),
        element?.getAttribute?.("title")
      ].filter(Boolean).join(" "), max);
      const backgroundSources = (element) => {
        const sources = [];
        for (const node of [element, ...element.querySelectorAll("*")].slice(0, 180)) {
          const match = getComputedStyle(node).backgroundImage.match(/url\\(["']?([^"')]+)["']?\\)/);
          if (match?.[1]) sources.push(match[1]);
        }
        return sources;
      };
      const visibleSignature = (root) => {
        const rootRect = root.getBoundingClientRect();
        const visibleImages = Array.from(root.querySelectorAll("img, source"))
          .filter((node) => visible(node instanceof HTMLSourceElement ? node.parentElement : node))
          .filter((node) => intersects((node instanceof HTMLSourceElement ? node.parentElement : node).getBoundingClientRect(), rootRect) > 80)
          .flatMap((node) => [
            node.currentSrc,
            node.src,
            node.srcset,
            node.getAttribute("data-src"),
            node.getAttribute("data-srcset"),
            node.getAttribute("data-original"),
            node.getAttribute("data-lazy-src"),
            node.getAttribute("data-lazy-srcset")
          ])
          .filter(Boolean)
          .map((value) => String(value).split(",")[0].trim())
          .slice(0, 20);
        const visibleText = Array.from(root.querySelectorAll("a, button, h1, h2, h3, h4, p, li, article, [class*='card'], [class*='slide']"))
          .filter(visible)
          .filter((node) => intersects(node.getBoundingClientRect(), rootRect) > 80)
          .map((node) => textOf(node, 140))
          .filter(Boolean)
          .filter((value, index, list) => list.indexOf(value) === index)
          .slice(0, 24);
        return JSON.stringify({
          text: visibleText,
          images: visibleImages,
          backgrounds: backgroundSources(root).slice(0, 12)
        });
      };
      const productHref = (element) => {
        try {
          return new URL(element.getAttribute("href") || element.href || "", window.location.href).pathname;
        } catch {
          return element.getAttribute("href") || element.href || "";
        }
      };
      const imageSources = (element) => Array.from(element.querySelectorAll("img, source"))
        .flatMap((node) => [
          node.currentSrc,
          node.src,
          node.srcset,
          node.getAttribute("data-src"),
          node.getAttribute("data-srcset"),
          node.getAttribute("data-original"),
          node.getAttribute("data-lazy-src"),
          node.getAttribute("data-lazy-srcset")
        ])
        .filter(Boolean)
        .map((value) => String(value).split(",")[0].trim())
        .filter(Boolean);
      const productImage = (card) => imageSources(card)[0] || "";
      const productCardForLink = (link) =>
        link.closest("[data-product-card], article, li, [class*='product'][class*='card'], [class*='card'], [class*='slide']") || link;
      const productText = (card) => textOf(card, 220)
        .replace(/\\b\\d+\\s*\\/\\s*\\d+\\b/g, "")
        .replace(/\\s+/g, " ")
        .trim();
      const productCards = (root, options = {}) => {
        const rootRect = root.getBoundingClientRect();
        const cards = Array.from(root.querySelectorAll("a[href*='/products/']"))
          .filter(visible)
          .map((element) => {
            const card = productCardForLink(element);
            const rect = card.getBoundingClientRect();
            const area = Math.max(1, rect.width * rect.height);
            const visibleArea = intersects(rect, rootRect);
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const href = productHref(element);
            const text = productText(card);
            const image = productImage(card);
            return {
              href,
              text,
              image,
              key: href || text,
              rect,
              visibleArea,
              visibleRatio: visibleArea / area,
              centerX,
              centerY
            };
          })
          .filter((item) =>
            item.href &&
            item.rect.width >= 120 &&
            item.rect.height >= 120 &&
            item.centerY >= rootRect.top &&
            item.centerY <= rootRect.bottom &&
            (!options.visibleOnly || (
              item.visibleArea > 800 &&
              item.visibleRatio >= 0.45 &&
              item.rect.left >= rootRect.left + 12 &&
              item.rect.right <= rootRect.right - 12
            ))
          )
          .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
        const deduped = [];
        const seen = new Set();
        for (const item of cards) {
          const key = item.key || item.href;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          deduped.push({
            key,
            href: item.href,
            text: item.text,
            image: item.image
          });
        }
        return deduped;
      };
      const productWindowSignature = (root) => {
        const cards = productCards(root, { visibleOnly: true });
        return cards.length ? JSON.stringify(cards.map((card) => ({
          key: card.key,
          href: card.href
        }))) : "";
      };
      const productCardSignature = (root) => {
        const signature = productWindowSignature(root);
        return signature || "";
      };
      const activeTabbedPanel = (root) =>
        Array.from(root.querySelectorAll("[class*='swiper-container-product-card'], [class*='swiper-container-athlete'], [class*='athlete'][class*='swiper'], .swiper"))
          .filter((element) => visible(element))
          .filter((element) => element.querySelector(".swiper-slide, [class*='swiper-slide']"))
          .sort((a, b) =>
            Number(/active/i.test(classText(b))) - Number(/active/i.test(classText(a))) ||
            b.getBoundingClientRect().width * b.getBoundingClientRect().height -
              a.getBoundingClientRect().width * a.getBoundingClientRect().height
          )[0] || root;
      const athleteTitle = (slide) => cleanText(
        slide.querySelector(".athletes-content-title, [class*='athletes-content-title']")?.innerText ||
        slide.querySelector("h1, h2, h3, h4, p")?.innerText ||
        textOf(slide, 120),
        100
      );
      const athleteSubheader = (slide) => cleanText(
        slide.querySelector(".athletes-subheader, [class*='athletes-subheader']")?.innerText ||
        "",
        140
      );
      const athleteItems = (root, options = {}) => {
        const rootRect = root.getBoundingClientRect();
        const panel = activeTabbedPanel(root);
        const slides = Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide']"))
          .filter(visible)
          .map((slide) => {
            const rect = slide.getBoundingClientRect();
            const area = Math.max(1, rect.width * rect.height);
            const visibleArea = intersects(rect, rootRect);
            const title = athleteTitle(slide);
            const subheader = athleteSubheader(slide);
            const text = textOf(slide, 260)
              .replace(/\\b\\d+\\s*\\/\\s*\\d+\\b/g, "")
              .replace(/\\s+/g, " ")
              .trim();
            const link = Array.from(slide.querySelectorAll("a[href]")).map(productHref).filter(Boolean)[0] || "";
            const image = imageSources(slide)[0] || "";
            const key = [title || text, subheader, link || image].filter(Boolean).join("|");
            return {
              key,
              title,
              subheader,
              text,
              href: link,
              image,
              rect,
              visibleArea,
              visibleRatio: visibleArea / area,
              centerY: rect.top + rect.height / 2
            };
          })
          .filter((item) =>
            item.key &&
            item.rect.width >= 160 &&
            item.rect.height >= 160 &&
            item.centerY >= rootRect.top &&
            item.centerY <= rootRect.bottom &&
            (!options.visibleOnly || (
              item.visibleArea > 800 &&
              item.visibleRatio >= 0.45 &&
              item.rect.left >= rootRect.left + 8 &&
              item.rect.right <= rootRect.right - 8
            ))
          )
          .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
        const deduped = [];
        const seen = new Set();
        for (const item of slides) {
          if (seen.has(item.key)) continue;
          seen.add(item.key);
          deduped.push({
            key: item.key,
            title: item.title,
            subheader: item.subheader,
            text: item.text,
            href: item.href,
            image: item.image
          });
        }
        return deduped;
      };
      const athleteWindowSignature = (root) => {
        const items = athleteItems(root, { visibleOnly: true });
        return items.length ? JSON.stringify(items.map((item) => ({
          key: item.key,
          title: item.title,
          subheader: item.subheader
        }))) : "";
      };
      const pageSignature = (root) => {
        if (definition.key === "product-showcase") {
          return productCardSignature(root) || visibleSignature(root);
        }
        if (definition.key === "athletes") {
          return athleteWindowSignature(root) || visibleSignature(root);
        }
        return visibleSignature(root);
      };
      const findRoots = () => {
        const roots = new Set();
        const baseSelector = [
          "section",
          ".shopify-section",
          "main > div",
          "[class*='section']",
          "[class*='swiper']",
          "[class*='slider']",
          "[class*='carousel']"
        ].join(",");
        document.querySelectorAll(baseSelector).forEach((element) => roots.add(element));
        for (const anchor of definition.anchors || []) {
          for (const element of document.querySelectorAll("body *")) {
            if (!textOf(element, 500).includes(anchor)) continue;
            let current = element;
            for (let depth = 0; current && depth < 6; depth += 1) {
              if (current.matches?.("section, .shopify-section, main > div, [class*='section'], [class*='swiper'], [class*='slider'], [class*='carousel']")) {
                roots.add(current);
              }
              current = current.parentElement;
            }
          }
        }
        return [...roots].filter((root) => {
          if (!root || root === document.body || root === document.documentElement || !visible(root)) return false;
          const rect = root.getBoundingClientRect();
          return rect.width >= Math.min(260, window.innerWidth * 0.45) && rect.height >= 140;
        });
      };
      const anchorHits = (root) => (definition.anchors || [])
        .filter((anchor) => textOf(root, 5000).includes(anchor)).length;
      const findRoot = () => {
        const minHits = Math.min(definition.anchors?.length || 1, definition.mode === "carousel" ? 1 : 2);
        return findRoots()
          .map((root) => {
            const rect = root.getBoundingClientRect();
            const area = rect.width * rect.height;
            const hits = anchorHits(root);
            const className = classText(root);
            const score = hits * 10000 +
              Number(/shopify-section|section|swiper|slider|carousel/i.test(className)) * 120 -
              Math.log(Math.max(area, 1)) * 30 -
              Number(rect.height > window.innerHeight * 3) * 2000;
            return { root, hits, area, score };
          })
          .filter((item) => item.hits >= minHits)
          .sort((a, b) => b.score - a.score || a.area - b.area)[0]?.root || null;
      };
      const clickElement = (element) => {
        const target = element?.closest?.("button, [role='button'], a, [tabindex]") || element;
        if (!target || !visible(target)) return false;
        if (navigatesAway(target)) return false;
        const rect = target.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
        }
        if (typeof target.click === "function") target.click();
        return true;
      };
      const navigatesAway = (target) => {
        const link = target.closest?.("a[href]");
        if (!link) return false;
        const rawHref = String(link.getAttribute("href") || "").trim();
        if (!rawHref || rawHref === "#" || rawHref.startsWith("#") || /^javascript:/i.test(rawHref)) {
          return false;
        }
        try {
          const current = new URL(window.location.href);
          const destination = new URL(rawHref, current);
          return destination.origin !== current.origin ||
            destination.pathname !== current.pathname ||
            destination.search !== current.search;
        } catch {
          return true;
        }
      };
      const tabTextOf = (element) => cleanText([
        element?.innerText,
        element?.textContent,
        element?.getAttribute?.("aria-label"),
        element?.getAttribute?.("title")
      ].filter(Boolean).join(" "), 120);
      const exactTabText = (element, label) => {
        const text = tabTextOf(element);
        return text === label ||
          text === label + " " + label ||
          (text.startsWith(label + " ") && text.length <= label.length * 2 + 6);
      };
      const tabContainerFor = (root) => {
        const rootRect = root.getBoundingClientRect();
        const labels = definition.tabs || [];
        const candidates = new Map();
        for (const element of Array.from(root.querySelectorAll("button, [role='tab'], [role='button'], a, li, span, div, h1, h2, h3, h4, p"))) {
          if (!visible(element) || element.closest("a[href*='/products/']")) continue;
          const matchedLabel = labels.find((label) => exactTabText(element, label));
          if (!matchedLabel) continue;
          let current = element.parentElement;
          for (let depth = 0; current && depth < 5; depth += 1) {
            if (!root.contains(current) || !visible(current)) break;
            const rect = current.getBoundingClientRect();
            if (rect.top > rootRect.top + Math.max(180, rootRect.height * 0.28)) {
              current = current.parentElement;
              continue;
            }
            const foundLabels = labels.filter((label) =>
              Array.from(current.querySelectorAll("button, [role='tab'], [role='button'], a, li, span, div, h1, h2, h3, h4, p"))
                .some((node) => visible(node) && !node.closest("a[href*='/products/']") && exactTabText(node, label))
            );
            if (foundLabels.length >= 2) {
              const key = foundLabels.join("|") + "|" + Math.round(rect.top) + "|" + Math.round(rect.left);
              const score = foundLabels.length * 1000 -
                Math.max(0, rect.height - 120) * 20 -
                Math.max(0, rect.top - rootRect.top);
              const existing = candidates.get(key);
              if (!existing || score > existing.score) {
                candidates.set(key, { element: current, score, rect, labelCount: foundLabels.length });
              }
            }
            current = current.parentElement;
          }
        }
        return [...candidates.values()]
          .sort((a, b) => b.labelCount - a.labelCount || b.score - a.score || a.rect.top - b.rect.top)[0]?.element || null;
      };
      const findProductTabControl = (root, label) => {
        const rootRect = root.getBoundingClientRect();
        const tabContainer = tabContainerFor(root) || root;
        return Array.from(tabContainer.querySelectorAll("button, [role='tab'], [role='button'], a, li, span, div, h1, h2, h3, h4, p"))
          .filter(visible)
          .filter((element) => !element.closest("a[href*='/products/']"))
          .filter((element) => exactTabText(element, label))
          .map((element) => {
            const target = element.closest("button, [role='tab'], [role='button'], a, [tabindex]") || element;
            const rect = target.getBoundingClientRect();
            const role = target.getAttribute?.("role") || "";
            const className = classText(target);
            const score = Number(target.tagName === "BUTTON") * 40 +
              Number(role === "tab") * 35 +
              Number(/tab|active|selected/i.test(className)) * 10 -
              Math.max(0, rect.top - rootRect.top) -
              Math.max(0, rect.height - 80) * 5 -
              Math.max(0, rect.width - 360);
            return { element: target, rect, score };
          })
          .sort((a, b) => b.score - a.score || a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0]?.element || null;
      };
      const clickProductTab = (root, label) => {
        if (!label) return true;
        const oneBasedIndex = (definition.tabs || []).indexOf(label) + 1;
        const clicked = clickElement(findProductTabControl(root, label));
        let activated = false;
        if (oneBasedIndex > 0) {
          for (const item of root.querySelectorAll("[class*='title-item']")) {
            const isTarget = classText(item).split(/\\s+/).includes("title-item-" + oneBasedIndex);
            item.classList.toggle("active", isTarget);
            activated = activated || isTarget;
          }
          for (const item of root.querySelectorAll("[class*='swiper-container-product-card']")) {
            const isTarget = classText(item).split(/\\s+/).includes("swiper-container-product-card-" + oneBasedIndex);
            item.classList.toggle("active", isTarget);
            item.setAttribute("aria-hidden", isTarget ? "false" : "true");
            if (isTarget) {
              item.style.display = "";
              item.style.visibility = "";
            }
            activated = activated || isTarget;
          }
        }
        return clicked || activated;
      };
      const activeProductTabMatches = (root, label) => {
        const oneBasedIndex = (definition.tabs || []).indexOf(label) + 1;
        if (oneBasedIndex > 0) {
          const titleItemMatches = Array.from(root.querySelectorAll("[class*='title-item']"))
            .some((element) =>
              classText(element).split(/\\s+/).includes("title-item-" + oneBasedIndex) &&
              /active/i.test(classText(element)) &&
              exactTabText(element, label)
            );
          if (titleItemMatches) return true;
        }
        const control = findProductTabControl(root, label);
        if (!control) return false;
        const stateText = [
          control.getAttribute?.("aria-selected"),
          control.getAttribute?.("aria-current"),
          control.getAttribute?.("data-active"),
          classText(control)
        ].filter(Boolean).join(" ");
        return /true|page|active|selected|current/i.test(stateText);
      };
      const clickLabel = (root, label) => {
        const choices = Array.from(root.querySelectorAll("button, [role='tab'], [role='button'], a, li, span, div, h1, h2, h3, h4, p"))
          .filter(visible)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const text = textOf(element, 180);
            return { element, text, rect, area: rect.width * rect.height };
          })
          .filter((item) => item.text === label || item.text.startsWith(label + " ") || item.text.includes(label))
          .sort((a, b) =>
            Number(b.text === label) - Number(a.text === label) ||
            a.area - b.area ||
            a.rect.top - b.rect.top ||
            a.rect.left - b.rect.left
          );
        return clickElement(choices[0]?.element);
      };
      const activeTabMatches = (root, label) => {
        if (!label) return true;
        return Array.from(root.querySelectorAll("button, [role='tab'], [role='button'], a, li, span, div, h1, h2, h3, h4, p"))
          .filter(visible)
          .some((element) => {
            const text = textOf(element, 180);
            if (!(text === label || text.startsWith(label + " ") || text.includes(label))) {
              return false;
            }
            const className = classText(element);
            return element.getAttribute?.("aria-selected") === "true" ||
              element.getAttribute?.("aria-current") === "true" ||
              /active|selected|current/i.test(className);
          });
      };
      const activeSwipers = (root) => [root, ...root.querySelectorAll(".swiper, [class*='swiper']")]
        .map((element) => element.swiper)
        .filter((swiper, index, list) => swiper && list.indexOf(swiper) === index);
      const activeProductSwipers = (root) => activeSwipers(root).filter((swiper) => {
        const element = swiper.el || swiper.wrapperEl?.parentElement;
        return !element || (visible(element) && /active/i.test(classText(element)));
      });
      const controlDisabled = (element) =>
        element?.disabled ||
        element?.getAttribute?.("aria-disabled") === "true" ||
        /disabled|lock/i.test(classText(element));
      const resetCarousel = (root) => {
        for (const swiper of activeSwipers(root)) {
          if (swiper.autoplay?.stop) swiper.autoplay.stop();
          if (typeof swiper.slideToLoop === "function") {
            swiper.slideToLoop(0, 0, false);
          } else if (typeof swiper.slideTo === "function") {
            swiper.slideTo(0, 0, false);
          }
          if (typeof swiper.update === "function") swiper.update();
        }
        const firstBullet = root.querySelector(".swiper-pagination-bullet, .slick-dots button, [role='tab'][aria-label*='slide' i]");
        if (firstBullet) clickElement(firstBullet);
      };
      const findPageBullets = (root) => {
        const rootRect = root.getBoundingClientRect();
        return Array.from(root.querySelectorAll(".swiper-pagination-bullet, .slick-dots button, [role='tab'][aria-label*='slide' i]"))
          .filter(visible)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              element,
              rect,
              visibleArea: intersects(rect, rootRect)
            };
          })
          .filter((item) =>
            item.rect.width <= 48 &&
            item.rect.height <= 48 &&
            item.visibleArea >= 12
          )
          .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
          .map((item) => item.element);
      };
      const clickPageBullet = (root, pageIndex) => {
        const bullets = findPageBullets(root);
        const target = bullets[pageIndex - 1];
        return target ? clickElement(target) : false;
      };
      const findNextControl = (root) => {
        const rootRect = root.getBoundingClientRect();
        if (isTabbedCardSection) {
          const pointCandidates = [
            { x: rootRect.right - 18, y: rootRect.bottom - 18 },
            { x: rootRect.right - 54, y: rootRect.bottom - 18 },
            { x: rootRect.right - 18, y: rootRect.bottom - 54 }
          ]
            .map((point) => ({
              x: Math.max(12, Math.min(window.innerWidth - 12, point.x)),
              y: Math.max(12, Math.min(window.innerHeight - 12, point.y))
            }))
            .map((point) => document.elementFromPoint(point.x, point.y))
            .map((element) => element?.closest?.("button, [role='button'], a, .swiper-button-next, .slick-next") || element)
            .filter(Boolean)
            .filter((element, index, list) => list.indexOf(element) === index)
            .filter((element) => visible(element) && !controlDisabled(element) && !navigatesAway(element))
            .map((element) => ({ element, rect: element.getBoundingClientRect() }))
            .sort((a, b) => b.rect.left - a.rect.left || b.rect.top - a.rect.top);
          if (pointCandidates[0]?.element) {
            return pointCandidates[0].element;
          }
        }
        return Array.from(root.querySelectorAll(".swiper-button-next, .slick-next, button, [role='button'], a, [aria-label], [title]"))
          .map((element) => element.closest("button, [role='button'], a, .swiper-button-next, .slick-next") || element)
          .filter((element, index, list) => list.indexOf(element) === index)
          .filter(visible)
          .filter((element) => !navigatesAway(element))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const text = [
              textOf(element, 140),
              element.getAttribute?.("aria-label"),
              element.getAttribute?.("title"),
              element.id,
              classText(element)
            ].filter(Boolean).join(" ");
            const disabled = controlDisabled(element);
            const compact = rect.width <= 130 && rect.height <= 130;
            const rightSide = rect.left >= rootRect.left + rootRect.width * 0.45;
            const nearBottom = rect.top >= rootRect.top + rootRect.height * 0.55;
            const farRight = rect.left >= rootRect.right - Math.max(180, rootRect.width * 0.2);
            const explicit = /next|right|arrow|swiper-button-next|slick-next/i.test(text);
            const score = Number(explicit) * 18 +
              Number(rightSide) * 8 +
              Number(compact) * 5 +
              Number(isTabbedCardSection && farRight) * 18 +
              Number(isTabbedCardSection && nearBottom) * 12 -
              Number(disabled) * 100;
            return { element, score, disabled, rect };
          })
          .filter((item) => item.score >= 10 && !item.disabled)
          .sort((a, b) =>
            b.score - a.score ||
            b.rect.left - a.rect.left ||
            b.rect.top - a.rect.top
          )[0]?.element || null;
      };
      const advance = async (root) => {
        if (isTabbedCardSection) {
          const swipers = activeProductSwipers(root).filter((swiper) => typeof swiper.slideNext === "function");
          if (swipers.length) {
            for (const swiper of swipers) {
              if (swiper.autoplay?.stop) swiper.autoplay.stop();
              swiper.slideNext(0, false);
              if (typeof swiper.update === "function") swiper.update();
            }
            await sleep(520);
            return true;
          }
          const next = findNextControl(root);
          if (next) {
            clickElement(next);
            await sleep(900);
            return true;
          }
        }
        const swipers = activeSwipers(root).filter((swiper) => typeof swiper.slideNext === "function");
        if (swipers.length) {
          for (const swiper of swipers) {
            if (swiper.autoplay?.stop) swiper.autoplay.stop();
            swiper.slideNext(0, false);
            if (typeof swiper.update === "function") swiper.update();
          }
          await sleep(360);
          return true;
        }
        const next = findNextControl(root);
        if (!next) return false;
        clickElement(next);
        await sleep(420);
        return true;
      };
      const collectProductPages = async (root, tabLabel, tabIndex, states) => {
        const clicked = clickProductTab(root, tabLabel);
        await sleep(700);
        if (!clicked) {
          warnings.push({
            sectionKey: definition.key,
            sectionLabel: definition.sectionLabel,
            stateLabel: tabLabel,
            message: "Could not click product showcase tab " + tabLabel + "."
          });
          return;
        }
        resetCarousel(root);
        await sleep(450);

        const allCards = productCards(root);
        const firstWindowCards = productCards(root, { visibleOnly: true });
        const firstWindowSignature = productWindowSignature(root);
        if (!firstWindowCards.length || !firstWindowSignature) {
          warnings.push({
            sectionKey: definition.key,
            sectionLabel: definition.sectionLabel,
            stateLabel: tabLabel,
            message: "Could not read visible product cards for " + tabLabel + "."
          });
          return;
        }

        const tabSetSignature = JSON.stringify(allCards.map((card) => card.key));
        const earlierMatchingTab = states.find((state) => state.tabSetSignature === tabSetSignature);
        if (earlierMatchingTab && !activeProductTabMatches(root, tabLabel)) {
          warnings.push({
            sectionKey: definition.key,
            sectionLabel: definition.sectionLabel,
            stateLabel: tabLabel,
            message: "Product showcase tab " + tabLabel + " did not switch away from " + earlierMatchingTab.tabLabel + "."
          });
          return;
        }

        const seen = new Set();
        const maxPages = Math.max(1, allCards.length || firstWindowCards.length) + 2;
        const lastProductKey = allCards[allCards.length - 1]?.key || "";
        for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
          const visibleCards = productCards(root, { visibleOnly: true });
          const signature = productWindowSignature(root);
          if (!signature || seen.has(signature)) break;
          seen.add(signature);
          const label = tabLabel + " " + pageIndex;
          states.push({
            kind: "tab-carousel",
            sectionKey: definition.key,
            sectionLabel: definition.sectionLabel,
            tabLabel,
            tabIndex: Number.isFinite(tabIndex) ? tabIndex + 1 : null,
            pageIndex,
            stateIndex: states.length + 1,
            stateLabel: label,
            logicalSignature: definition.key + "|" + tabLabel + "|" + pageIndex + "|" + signature,
            windowSignature: signature,
            tabSetSignature,
            productCount: allCards.length,
            visibleProductCount: visibleCards.length,
            visibleProducts: visibleCards,
            fileId: tabLabel + "-" + pageIndex,
            isDefaultState: pageIndex === 1
          });

          if (lastProductKey && visibleCards.some((card) => card.key === lastProductKey)) {
            break;
          }
          const before = signature;
          const moved = await advance(root);
          const after = productWindowSignature(root);
          if (!moved || !after || after === before || seen.has(after)) break;
        }
      };
      const collectAthletePages = async (root, tabLabel, tabIndex, states) => {
        const clicked = clickProductTab(root, tabLabel);
        await sleep(700);
        if (!clicked) {
          warnings.push({
            sectionKey: definition.key,
            sectionLabel: definition.sectionLabel,
            stateLabel: tabLabel,
            message: "Could not click athletes tab " + tabLabel + "."
          });
          return;
        }
        resetCarousel(root);
        await sleep(450);

        const allItems = athleteItems(root);
        const firstWindowItems = athleteItems(root, { visibleOnly: true });
        const firstWindowSignature = athleteWindowSignature(root);
        if (!firstWindowItems.length || !firstWindowSignature) {
          warnings.push({
            sectionKey: definition.key,
            sectionLabel: definition.sectionLabel,
            stateLabel: tabLabel,
            message: "Could not read visible athlete slides for " + tabLabel + "."
          });
          return;
        }

        if (!activeProductTabMatches(root, tabLabel)) {
          warnings.push({
            sectionKey: definition.key,
            sectionLabel: definition.sectionLabel,
            stateLabel: tabLabel,
            message: "Athletes tab " + tabLabel + " did not become active."
          });
          return;
        }

        const tabSetSignature = JSON.stringify(allItems.map((item) => item.key));
        const seen = new Set();
        const maxPages = Math.max(1, allItems.length || firstWindowItems.length) + 2;
        const lastItemKey = allItems[allItems.length - 1]?.key || "";
        for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
          const visibleItems = athleteItems(root, { visibleOnly: true });
          const signature = athleteWindowSignature(root);
          if (!signature || seen.has(signature)) break;
          seen.add(signature);
          const label = tabLabel + " " + pageIndex;
          states.push({
            kind: "tab-carousel",
            sectionKey: definition.key,
            sectionLabel: definition.sectionLabel,
            tabLabel,
            tabIndex: Number.isFinite(tabIndex) ? tabIndex + 1 : null,
            pageIndex,
            stateIndex: states.length + 1,
            stateLabel: label,
            logicalSignature: definition.key + "|" + tabLabel + "|" + pageIndex + "|" + signature,
            windowSignature: signature,
            tabSetSignature,
            itemCount: allItems.length,
            visibleItemCount: visibleItems.length,
            visibleItems,
            fileId: tabLabel + "-" + pageIndex,
            isDefaultState: pageIndex === 1
          });

          if (lastItemKey && visibleItems.some((item) => item.key === lastItemKey)) {
            break;
          }
          const before = signature;
          const moved = await advance(root);
          const after = athleteWindowSignature(root);
          if (!moved || !after || after === before || seen.has(after)) break;
        }
      };
      const collectPages = async (root, tabLabel, tabIndex, states, warnings, knownTabFirstSignatures) => {
        if (definition.key === "product-showcase") {
          await collectProductPages(root, tabLabel, tabIndex, states);
          return;
        }
        if (definition.key === "athletes") {
          await collectAthletePages(root, tabLabel, tabIndex, states);
          return;
        }
        if (tabLabel) {
          const beforeTabSignature = pageSignature(root);
          const clicked = clickLabel(root, tabLabel);
          await sleep(450);
          const afterTabSignature = pageSignature(root);
          const active = activeTabMatches(root, tabLabel);
          if (!clicked) {
            warnings.push({
              sectionKey: definition.key,
              sectionLabel: definition.sectionLabel,
              stateLabel: tabLabel,
              message: 'Could not activate tab "' + tabLabel + '".'
            });
            return;
          }
          if (!afterTabSignature) {
            warnings.push({
              sectionKey: definition.key,
              sectionLabel: definition.sectionLabel,
              stateLabel: tabLabel,
              message: 'Could not verify tab "' + tabLabel + '" after activation.'
            });
            return;
          }
          if (tabIndex > 0 && afterTabSignature === beforeTabSignature && !active) {
            warnings.push({
              sectionKey: definition.key,
              sectionLabel: definition.sectionLabel,
              stateLabel: tabLabel,
              message: 'Tab "' + tabLabel + '" did not show an active or changed state.'
            });
            return;
          }
        }
        resetCarousel(root);
        await sleep(300);
        const seen = new Set();
        const bulletCount = definition.key === "product-showcase" ? findPageBullets(root).length : 0;
        const maxPages = bulletCount > 1 ? bulletCount : 12;
        for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
          if (pageIndex > 1) {
            let moved = false;
            if (definition.key === "product-showcase" && bulletCount > 1) {
              moved = clickPageBullet(root, pageIndex);
              await sleep(450);
            } else {
              moved = await advance(root);
            }
            if (!moved) break;
          }
          const signature = pageSignature(root);
          if (!signature || seen.has(signature)) break;
          if (pageIndex === 1 && tabLabel) {
            if (knownTabFirstSignatures.has(signature)) {
              warnings.push({
                sectionKey: definition.key,
                sectionLabel: definition.sectionLabel,
                stateLabel: tabLabel,
                message: 'Tab "' + tabLabel + '" duplicated a previously captured tab and was skipped.'
              });
              break;
            }
            knownTabFirstSignatures.add(signature);
          }
          seen.add(signature);
          const isDefaultState = pageIndex === 1;
          const label = definition.labelMode === "tab" && tabLabel
            ? tabLabel + " " + pageIndex
            : (definition.labelPrefix || "轮播") + " " + pageIndex;
          states.push({
            kind: definition.mode === "tabs-carousel" ? "tab-carousel" : "carousel",
            sectionKey: definition.key,
            sectionLabel: definition.sectionLabel,
            tabLabel: tabLabel || "",
            tabIndex: Number.isFinite(tabIndex) ? tabIndex + 1 : null,
            pageIndex,
            stateIndex: states.length + 1,
            stateLabel: label,
            logicalSignature: definition.key + "|" + (tabLabel || "") + "|" + pageIndex + "|" + signature,
            fileId: (tabLabel || "state") + "-" + pageIndex,
            isDefaultState
          });
          if (definition.key === "product-showcase" && bulletCount > 1) {
            continue;
          }
          const before = signature;
          const moved = await advance(root);
          const after = pageSignature(root);
          if (!moved || after === before || seen.has(after)) break;
        }
      };

      return (async () => {
        const root = findRoot();
        if (!root) {
          return { ok: false, reason: "No matching homepage section was found." };
        }
        root.scrollIntoView({ block: "center", inline: "nearest" });
        await sleep(450);
        window.__pageShotRelatedSections = window.__pageShotRelatedSections || {};
        window.__pageShotRelatedSections[definition.key] = { root, definition };
        const states = [];
        const knownTabFirstSignatures = new Set();
        if (definition.mode === "tabs-carousel") {
          for (const [tabIndex, tabLabel] of (definition.tabs || []).entries()) {
            const tabStates = [];
            await collectPages(root, tabLabel, tabIndex, tabStates, warnings, knownTabFirstSignatures);
            for (const state of tabStates) {
              state.pageCount = tabStates.length;
              states.push(state);
            }
          }
        } else {
          const pageStates = [];
          await collectPages(root, "", 0, pageStates, warnings, knownTabFirstSignatures);
          for (const state of pageStates) {
            state.pageCount = pageStates.length;
            states.push(state);
          }
        }
        window.__pageShotRelatedSections[definition.key].states = states;
        return {
          ok: true,
          sectionKey: definition.key,
          sectionLabel: definition.sectionLabel,
          count: states.length,
          states,
          warnings,
          rootText: textOf(root, 280),
          rootClass: classText(root).slice(0, 180)
        };
      })();
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    return {
      ok: false,
      reason: result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime evaluation failed."
    };
  }
  return result.result?.value || { ok: false };
}

async function activateShokzHomeRelatedState(client, definition, state) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const definition = ${JSON.stringify(definition)};
      const state = ${JSON.stringify(state)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const cleanText = (value, max = 240) => String(value || "")
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, max);
      const isTabbedCardSection = definition.key === "product-showcase" || definition.key === "athletes";
      const classText = (element) => String(element?.className?.baseVal || element?.className || "");
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const textOf = (element, max = 220) => cleanText([
        element?.innerText,
        element?.textContent,
        element?.getAttribute?.("aria-label"),
        element?.getAttribute?.("title")
      ].filter(Boolean).join(" "), max);
      const root = window.__pageShotRelatedSections?.[definition.key]?.root;
      if (!root) return { ok: false, reason: "Related section root is not available." };
      const intersects = (rect, rootRect) =>
        Math.max(0, Math.min(rect.right, rootRect.right) - Math.max(rect.left, rootRect.left)) *
        Math.max(0, Math.min(rect.bottom, rootRect.bottom) - Math.max(rect.top, rootRect.top));
      const productHref = (element) => {
        try {
          return new URL(element.getAttribute("href") || element.href || "", window.location.href).pathname;
        } catch {
          return element.getAttribute("href") || element.href || "";
        }
      };
      const productImage = (card) => {
        const image = card.querySelector("img, source");
        return [
          image?.currentSrc,
          image?.src,
          image?.srcset,
          image?.getAttribute?.("data-src"),
          image?.getAttribute?.("data-srcset")
        ].filter(Boolean).map((value) => String(value).split(",")[0].trim())[0] || "";
      };
      const productCardForLink = (link) =>
        link.closest("[data-product-card], article, li, [class*='product'][class*='card'], [class*='card'], [class*='slide']") || link;
      const productText = (card) => textOf(card, 220)
        .replace(/\\b\\d+\\s*\\/\\s*\\d+\\b/g, "")
        .replace(/\\s+/g, " ")
        .trim();
      const productCards = () => {
        const rootRect = root.getBoundingClientRect();
        const cards = Array.from(root.querySelectorAll("a[href*='/products/']"))
          .filter(visible)
          .map((element) => {
            const card = productCardForLink(element);
            const rect = card.getBoundingClientRect();
            const area = Math.max(1, rect.width * rect.height);
            const visibleArea = intersects(rect, rootRect);
            const href = productHref(element);
            const text = productText(card);
            const image = productImage(card);
            return {
              key: href || text,
              href,
              text,
              image,
              rect,
              visibleArea,
              visibleRatio: visibleArea / area,
              centerY: rect.top + rect.height / 2
            };
          })
          .filter((item) =>
            item.href &&
            item.rect.width >= 120 &&
            item.rect.height >= 120 &&
            item.visibleArea > 800 &&
            item.visibleRatio >= 0.45 &&
            item.rect.left >= rootRect.left + 12 &&
            item.rect.right <= rootRect.right - 12 &&
            item.centerY >= rootRect.top &&
            item.centerY <= rootRect.bottom
          )
          .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
        const deduped = [];
        const seen = new Set();
        for (const item of cards) {
          const key = item.key || item.href;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          deduped.push({ key, href: item.href, text: item.text, image: item.image });
        }
        return deduped;
      };
      const productWindowSignature = () => {
        const cards = productCards();
        return cards.length ? JSON.stringify(cards.map((card) => ({
          key: card.key,
          href: card.href
        }))) : "";
      };
      const imageSources = (element) => Array.from(element.querySelectorAll("img, source"))
        .flatMap((node) => [
          node.currentSrc,
          node.src,
          node.srcset,
          node.getAttribute("data-src"),
          node.getAttribute("data-srcset"),
          node.getAttribute("data-original"),
          node.getAttribute("data-lazy-src"),
          node.getAttribute("data-lazy-srcset")
        ])
        .filter(Boolean)
        .map((value) => String(value).split(",")[0].trim())
        .filter(Boolean);
      const activeTabbedPanel = () =>
        Array.from(root.querySelectorAll("[class*='swiper-container-product-card'], [class*='swiper-container-athlete'], [class*='athlete'][class*='swiper'], .swiper"))
          .filter((element) => visible(element))
          .filter((element) => element.querySelector(".swiper-slide, [class*='swiper-slide']"))
          .sort((a, b) =>
            Number(/active/i.test(classText(b))) - Number(/active/i.test(classText(a))) ||
            b.getBoundingClientRect().width * b.getBoundingClientRect().height -
              a.getBoundingClientRect().width * a.getBoundingClientRect().height
          )[0] || root;
      const athleteTitle = (slide) => cleanText(
        slide.querySelector(".athletes-content-title, [class*='athletes-content-title']")?.innerText ||
        slide.querySelector("h1, h2, h3, h4, p")?.innerText ||
        textOf(slide, 120),
        100
      );
      const athleteSubheader = (slide) => cleanText(
        slide.querySelector(".athletes-subheader, [class*='athletes-subheader']")?.innerText ||
        "",
        140
      );
      const athleteItems = () => {
        const rootRect = root.getBoundingClientRect();
        const panel = activeTabbedPanel();
        const slides = Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide']"))
          .filter(visible)
          .map((slide) => {
            const rect = slide.getBoundingClientRect();
            const area = Math.max(1, rect.width * rect.height);
            const visibleArea = intersects(rect, rootRect);
            const title = athleteTitle(slide);
            const subheader = athleteSubheader(slide);
            const text = textOf(slide, 220)
              .replace(/\\b\\d+\\s*\\/\\s*\\d+\\b/g, "")
              .replace(/\\s+/g, " ")
              .trim();
            const link = Array.from(slide.querySelectorAll("a[href]")).map(productHref).filter(Boolean)[0] || "";
            const image = imageSources(slide)[0] || "";
            const key = [title || text, subheader, link || image].filter(Boolean).join("|");
            return {
              key,
              title,
              subheader,
              rect,
              visibleArea,
              visibleRatio: visibleArea / Math.max(1, rect.width * rect.height),
              centerY: rect.top + rect.height / 2
            };
          })
          .filter((item) =>
            item.key &&
            item.rect.width >= 160 &&
            item.rect.height >= 160 &&
            item.visibleArea > 800 &&
            item.visibleRatio >= 0.45 &&
            item.rect.left >= rootRect.left + 8 &&
            item.rect.right <= rootRect.right - 8 &&
            item.centerY >= rootRect.top &&
            item.centerY <= rootRect.bottom
          )
          .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
        const deduped = [];
        const seen = new Set();
        for (const item of slides) {
          if (seen.has(item.key)) continue;
          seen.add(item.key);
          deduped.push({ key: item.key, title: item.title, subheader: item.subheader });
        }
        return deduped;
      };
      const athleteWindowSignature = () => {
        const items = athleteItems();
        return items.length ? JSON.stringify(items.map((item) => ({
          key: item.key,
          title: item.title,
          subheader: item.subheader
        }))) : "";
      };
      const clickElement = (element) => {
        const target = element?.closest?.("button, [role='button'], a, [tabindex]") || element;
        if (!target || !visible(target)) return false;
        if (navigatesAway(target)) return false;
        const rect = target.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
        }
        if (typeof target.click === "function") target.click();
        return true;
      };
      const navigatesAway = (target) => {
        const link = target.closest?.("a[href]");
        if (!link) return false;
        const rawHref = String(link.getAttribute("href") || "").trim();
        if (!rawHref || rawHref === "#" || rawHref.startsWith("#") || /^javascript:/i.test(rawHref)) {
          return false;
        }
        try {
          const current = new URL(window.location.href);
          const destination = new URL(rawHref, current);
          return destination.origin !== current.origin ||
            destination.pathname !== current.pathname ||
            destination.search !== current.search;
        } catch {
          return true;
        }
      };
      const tabTextOf = (element) => cleanText([
        element?.innerText,
        element?.textContent,
        element?.getAttribute?.("aria-label"),
        element?.getAttribute?.("title")
      ].filter(Boolean).join(" "), 120);
      const exactTabText = (element, label) => {
        const text = tabTextOf(element);
        return text === label ||
          text === label + " " + label ||
          (text.startsWith(label + " ") && text.length <= label.length * 2 + 6);
      };
      const tabContainerFor = () => {
        const rootRect = root.getBoundingClientRect();
        const labels = definition.tabs || [];
        const candidates = new Map();
        for (const element of Array.from(root.querySelectorAll("button, [role='tab'], [role='button'], a, li, span, div, h1, h2, h3, h4, p"))) {
          if (!visible(element) || element.closest("a[href*='/products/']")) continue;
          const matchedLabel = labels.find((label) => exactTabText(element, label));
          if (!matchedLabel) continue;
          let current = element.parentElement;
          for (let depth = 0; current && depth < 5; depth += 1) {
            if (!root.contains(current) || !visible(current)) break;
            const rect = current.getBoundingClientRect();
            if (rect.top > rootRect.top + Math.max(180, rootRect.height * 0.28)) {
              current = current.parentElement;
              continue;
            }
            const foundLabels = labels.filter((label) =>
              Array.from(current.querySelectorAll("button, [role='tab'], [role='button'], a, li, span, div, h1, h2, h3, h4, p"))
                .some((node) => visible(node) && !node.closest("a[href*='/products/']") && exactTabText(node, label))
            );
            if (foundLabels.length >= 2) {
              const key = foundLabels.join("|") + "|" + Math.round(rect.top) + "|" + Math.round(rect.left);
              const score = foundLabels.length * 1000 -
                Math.max(0, rect.height - 120) * 20 -
                Math.max(0, rect.top - rootRect.top);
              const existing = candidates.get(key);
              if (!existing || score > existing.score) {
                candidates.set(key, { element: current, score, rect, labelCount: foundLabels.length });
              }
            }
            current = current.parentElement;
          }
        }
        return [...candidates.values()]
          .sort((a, b) => b.labelCount - a.labelCount || b.score - a.score || a.rect.top - b.rect.top)[0]?.element || null;
      };
      const findProductTabControl = (label) => {
        const rootRect = root.getBoundingClientRect();
        const tabContainer = tabContainerFor() || root;
        return Array.from(tabContainer.querySelectorAll("button, [role='tab'], [role='button'], a, li, span, div, h1, h2, h3, h4, p"))
          .filter(visible)
          .filter((element) => !element.closest("a[href*='/products/']"))
          .filter((element) => exactTabText(element, label))
          .map((element) => {
            const target = element.closest("button, [role='tab'], [role='button'], a, [tabindex]") || element;
            const rect = target.getBoundingClientRect();
            const role = target.getAttribute?.("role") || "";
            const className = classText(target);
            const score = Number(target.tagName === "BUTTON") * 40 +
              Number(role === "tab") * 35 +
              Number(/tab|active|selected/i.test(className)) * 10 -
              Math.max(0, rect.top - rootRect.top) -
              Math.max(0, rect.height - 80) * 5 -
              Math.max(0, rect.width - 360);
            return { element: target, rect, score };
          })
          .sort((a, b) => b.score - a.score || a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0]?.element || null;
      };
      const clickProductTab = (label) => {
        if (!label) return true;
        const oneBasedIndex = (definition.tabs || []).indexOf(label) + 1;
        const clicked = clickElement(findProductTabControl(label));
        let activated = false;
        if (oneBasedIndex > 0) {
          for (const item of root.querySelectorAll("[class*='title-item']")) {
            const isTarget = classText(item).split(/\\s+/).includes("title-item-" + oneBasedIndex);
            item.classList.toggle("active", isTarget);
            activated = activated || isTarget;
          }
          for (const item of root.querySelectorAll("[class*='swiper-container-product-card']")) {
            const isTarget = classText(item).split(/\\s+/).includes("swiper-container-product-card-" + oneBasedIndex);
            item.classList.toggle("active", isTarget);
            item.setAttribute("aria-hidden", isTarget ? "false" : "true");
            if (isTarget) {
              item.style.display = "";
              item.style.visibility = "";
            }
            activated = activated || isTarget;
          }
        }
        return clicked || activated;
      };
      const clickLabel = (label) => {
        if (!label) return true;
        const choices = Array.from(root.querySelectorAll("button, [role='tab'], [role='button'], a, li, span, div, h1, h2, h3, h4, p"))
          .filter(visible)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const text = textOf(element);
            return { element, text, rect, area: rect.width * rect.height };
          })
          .filter((item) => item.text === label || item.text.startsWith(label + " ") || item.text.includes(label))
          .sort((a, b) =>
            Number(b.text === label) - Number(a.text === label) ||
            a.area - b.area ||
            a.rect.top - b.rect.top ||
            a.rect.left - b.rect.left
          );
        return clickElement(choices[0]?.element);
      };
      const activeSwipers = () => [root, ...root.querySelectorAll(".swiper, [class*='swiper']")]
        .map((element) => element.swiper)
        .filter((swiper, index, list) => swiper && list.indexOf(swiper) === index);
      const activeProductSwipers = () => activeSwipers().filter((swiper) => {
        const element = swiper.el || swiper.wrapperEl?.parentElement;
        return !element || (visible(element) && /active/i.test(classText(element)));
      });
      const controlDisabled = (element) =>
        element?.disabled ||
        element?.getAttribute?.("aria-disabled") === "true" ||
        /disabled|lock/i.test(classText(element));
      const resetCarousel = () => {
        for (const swiper of activeSwipers()) {
          if (swiper.autoplay?.stop) swiper.autoplay.stop();
          if (typeof swiper.slideToLoop === "function") {
            swiper.slideToLoop(0, 0, false);
          } else if (typeof swiper.slideTo === "function") {
            swiper.slideTo(0, 0, false);
          }
          if (typeof swiper.update === "function") swiper.update();
        }
        const firstBullet = root.querySelector(".swiper-pagination-bullet, .slick-dots button, [role='tab'][aria-label*='slide' i]");
        if (firstBullet) clickElement(firstBullet);
      };
      const findPageBullets = () => {
        const rootRect = root.getBoundingClientRect();
        return Array.from(root.querySelectorAll(".swiper-pagination-bullet, .slick-dots button, [role='tab'][aria-label*='slide' i]"))
          .filter(visible)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              element,
              rect,
              visibleArea: Math.max(0, Math.min(rect.right, rootRect.right) - Math.max(rect.left, rootRect.left)) *
                Math.max(0, Math.min(rect.bottom, rootRect.bottom) - Math.max(rect.top, rootRect.top))
            };
          })
          .filter((item) =>
            item.rect.width <= 48 &&
            item.rect.height <= 48 &&
            item.visibleArea >= 12
          )
          .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
          .map((item) => item.element);
      };
      const clickPageBullet = (pageIndex) => {
        const bullets = findPageBullets();
        const target = bullets[pageIndex - 1];
        return target ? clickElement(target) : false;
      };
      const findNextControl = () => {
        const rootRect = root.getBoundingClientRect();
        if (isTabbedCardSection) {
          const pointCandidates = [
            { x: rootRect.right - 18, y: rootRect.bottom - 18 },
            { x: rootRect.right - 54, y: rootRect.bottom - 18 },
            { x: rootRect.right - 18, y: rootRect.bottom - 54 }
          ]
            .map((point) => ({
              x: Math.max(12, Math.min(window.innerWidth - 12, point.x)),
              y: Math.max(12, Math.min(window.innerHeight - 12, point.y))
            }))
            .map((point) => document.elementFromPoint(point.x, point.y))
            .map((element) => element?.closest?.("button, [role='button'], a, .swiper-button-next, .slick-next") || element)
            .filter(Boolean)
            .filter((element, index, list) => list.indexOf(element) === index)
            .filter((element) => visible(element) && !controlDisabled(element) && !navigatesAway(element))
            .map((element) => ({ element, rect: element.getBoundingClientRect() }))
            .sort((a, b) => b.rect.left - a.rect.left || b.rect.top - a.rect.top);
          if (pointCandidates[0]?.element) {
            return pointCandidates[0].element;
          }
        }
        return Array.from(root.querySelectorAll(".swiper-button-next, .slick-next, button, [role='button'], a, [aria-label], [title]"))
          .map((element) => element.closest("button, [role='button'], a, .swiper-button-next, .slick-next") || element)
          .filter((element, index, list) => list.indexOf(element) === index)
          .filter(visible)
          .filter((element) => !navigatesAway(element))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const text = [textOf(element), element.getAttribute?.("aria-label"), element.getAttribute?.("title"), element.id, classText(element)]
              .filter(Boolean).join(" ");
            const disabled = controlDisabled(element);
            const compact = rect.width <= 130 && rect.height <= 130;
            const rightSide = rect.left >= rootRect.left + rootRect.width * 0.45;
            const nearBottom = rect.top >= rootRect.top + rootRect.height * 0.55;
            const farRight = rect.left >= rootRect.right - Math.max(180, rootRect.width * 0.2);
            const explicit = /next|right|arrow|swiper-button-next|slick-next/i.test(text);
            const score = Number(explicit) * 18 +
              Number(rightSide) * 8 +
              Number(compact) * 5 +
              Number(isTabbedCardSection && farRight) * 18 +
              Number(isTabbedCardSection && nearBottom) * 12 -
              Number(disabled) * 100;
            return { element, score, disabled, rect };
          })
          .filter((item) => item.score >= 10 && !item.disabled)
          .sort((a, b) =>
            b.score - a.score ||
            b.rect.left - a.rect.left ||
            b.rect.top - a.rect.top
          )[0]?.element || null;
      };
      const advance = async () => {
        if (isTabbedCardSection) {
          const swipers = activeProductSwipers().filter((swiper) => typeof swiper.slideNext === "function");
          if (swipers.length) {
            for (const swiper of swipers) {
              if (swiper.autoplay?.stop) swiper.autoplay.stop();
              swiper.slideNext(0, false);
              if (typeof swiper.update === "function") swiper.update();
            }
            await sleep(520);
            return true;
          }
          const next = findNextControl();
          if (next) {
            clickElement(next);
            await sleep(900);
            return true;
          }
        }
        const swipers = activeSwipers().filter((swiper) => typeof swiper.slideNext === "function");
        if (swipers.length) {
          for (const swiper of swipers) {
            if (swiper.autoplay?.stop) swiper.autoplay.stop();
            swiper.slideNext(0, false);
            if (typeof swiper.update === "function") swiper.update();
          }
          await sleep(340);
          return true;
        }
        const next = findNextControl();
        if (!next) return false;
        clickElement(next);
        await sleep(420);
        return true;
      };
      return (async () => {
        root.scrollIntoView({ block: "center", inline: "nearest" });
        await sleep(260);
        if (isTabbedCardSection) {
          if (state.tabLabel) {
            const clicked = clickProductTab(state.tabLabel);
            await sleep(700);
            if (!clicked) {
              return { ok: false, reason: "Could not activate " + definition.sectionLabel + " tab " + state.tabLabel + "." };
            }
          }
          resetCarousel();
          await sleep(450);
          const targetSignature = state.windowSignature || "";
          const currentWindowSignature = () => definition.key === "athletes"
            ? athleteWindowSignature()
            : productWindowSignature();
          const maxAttempts = Math.max(12, Number(state.pageIndex || 1) + 4);
          for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            const currentSignature = currentWindowSignature();
            if (targetSignature && currentSignature === targetSignature) {
              root.scrollIntoView({ block: "center", inline: "nearest" });
              await sleep(260);
              return { ok: true };
            }
            if (!targetSignature && attempt >= Math.max(0, Number(state.pageIndex || 1) - 1)) {
              root.scrollIntoView({ block: "center", inline: "nearest" });
              await sleep(260);
              return { ok: true };
            }
            const before = currentSignature;
            const moved = await advance();
            const after = currentWindowSignature();
            if (!moved || !after || after === before) break;
          }
          return { ok: false, reason: "Could not activate " + definition.sectionLabel + " window " + state.stateLabel + "." };
        }
        if (state.tabLabel) {
          const clicked = clickLabel(state.tabLabel);
          await sleep(420);
          if (!clicked) {
            return { ok: false, reason: 'Could not activate tab "' + state.tabLabel + '".' };
          }
        }
        resetCarousel();
        await sleep(260);
        if (definition.key === "product-showcase" && Number(state.pageIndex || 1) > 1 && clickPageBullet(Number(state.pageIndex || 1))) {
          await sleep(450);
        } else {
          const clicks = Math.max(0, Number(state.pageIndex || 1) - 1);
          for (let index = 0; index < clicks; index += 1) {
            await advance();
          }
        }
        root.scrollIntoView({ block: "center", inline: "nearest" });
        await sleep(260);
        return { ok: true };
      })();
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  const value = result.result?.value || {};
  if (!value.ok) {
    throw new Error(value.reason || `Could not activate ${definition.sectionLabel} ${state.stateLabel}.`);
  }
  return value;
}

async function waitForRelatedSectionImages(client, sectionKey) {
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const sectionKey = ${JSON.stringify(sectionKey)};
      const root = window.__pageShotRelatedSections?.[sectionKey]?.root || document;
      const images = Array.from(root.querySelectorAll("img")).filter((img) => img.currentSrc || img.src);
      return Promise.all(images.map((img) => {
        if (img.complete && img.naturalWidth > 0) return true;
        return new Promise((resolve) => {
          const done = () => resolve(true);
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", done, { once: true });
          setTimeout(done, 1800);
        });
      }));
    })()`,
    awaitPromise: true,
    returnByValue: true
  }).catch(() => null);
}

async function readShokzHomeRelatedState(client, definition, state) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const definition = ${JSON.stringify(definition)};
      const state = ${JSON.stringify(state)};
      const root = window.__pageShotRelatedSections?.[definition.key]?.root;
      if (!root) return { ok: false, reason: "Related section root is not available." };
      const cleanText = (value, max = 360) => String(value || "")
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, max);
      const classText = (element) => String(element?.className?.baseVal || element?.className || "");
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const intersects = (rect, rootRect) =>
        Math.max(0, Math.min(rect.right, rootRect.right) - Math.max(rect.left, rootRect.left)) *
        Math.max(0, Math.min(rect.bottom, rootRect.bottom) - Math.max(rect.top, rootRect.top));
      const imageSourcesForNode = (node) => [
          node.currentSrc,
          node.src,
          node.srcset,
          node.getAttribute("data-src"),
          node.getAttribute("data-srcset"),
          node.getAttribute("data-original"),
          node.getAttribute("data-lazy-src"),
          node.getAttribute("data-lazy-srcset")
        ]
        .filter(Boolean)
        .map((value) => String(value).split(",")[0].trim())
        .filter(Boolean);
      const visibleImageSources = (root, rootRect) => {
        const seen = new Set();
        const sources = [];
        for (const node of Array.from(root.querySelectorAll("img, source"))) {
          const visualNode = node instanceof HTMLSourceElement ? node.parentElement : node;
          if (!visualNode || !visible(visualNode)) continue;
          if (intersects(visualNode.getBoundingClientRect(), rootRect) <= 80) continue;
          for (const source of imageSourcesForNode(node)) {
            if (seen.has(source)) continue;
            seen.add(source);
            sources.push(source);
            if (sources.length >= 24) return sources;
          }
        }
        return sources;
      };
      const productHref = (element) => {
        try {
          return new URL(element.getAttribute("href") || element.href || "", window.location.href).pathname;
        } catch {
          return element.getAttribute("href") || element.href || "";
        }
      };
      const productImage = (card) => {
        const image = card.querySelector("img, source");
        return image ? imageSourcesForNode(image)[0] || "" : "";
      };
      const productText = (card) => cleanText([card.innerText, card.textContent].filter(Boolean).join(" "), 220)
        .replace(/\\b\\d+\\s*\\/\\s*\\d+\\b/g, "")
        .replace(/\\s+/g, " ")
        .trim();
      const productCardSignature = (root) => {
        const rootRect = root.getBoundingClientRect();
        const visibleLinks = Array.from(root.querySelectorAll("a[href*='/products/']"))
          .filter(visible)
          .map((element) => {
            const card = element.closest("[data-product-card], article, li, [class*='product'][class*='card'], [class*='card'], [class*='slide']") || element;
            const rect = card.getBoundingClientRect();
            const area = Math.max(1, rect.width * rect.height);
            const visibleArea = intersects(rect, rootRect);
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const href = productHref(element);
            const text = productText(card);
            const image = productImage(card);
            return {
              href,
              text,
              image,
              key: href || text,
              rect,
              visibleArea,
              visibleRatio: visibleArea / area,
              centerX,
              centerY
            };
          })
          .filter((item) =>
            item.href &&
            item.rect.width >= 120 &&
            item.rect.height >= 120 &&
            item.visibleArea > 800 &&
            item.visibleRatio >= 0.55 &&
            item.rect.left >= rootRect.left + 12 &&
            item.rect.right <= rootRect.right - 12 &&
            item.centerY >= rootRect.top &&
            item.centerY <= rootRect.bottom
          )
          .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
        const deduped = [];
        const seen = new Set();
        for (const item of visibleLinks) {
          const key = item.key || item.href;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          deduped.push({
            key,
            href: item.href
          });
        }
        return deduped.length ? JSON.stringify(deduped) : "";
      };
      const activeTabbedPanel = (root) =>
        Array.from(root.querySelectorAll("[class*='swiper-container-product-card'], [class*='swiper-container-athlete'], [class*='athlete'][class*='swiper'], .swiper"))
          .filter((element) => visible(element))
          .filter((element) => element.querySelector(".swiper-slide, [class*='swiper-slide']"))
          .sort((a, b) =>
            Number(/active/i.test(classText(b))) - Number(/active/i.test(classText(a))) ||
            b.getBoundingClientRect().width * b.getBoundingClientRect().height -
              a.getBoundingClientRect().width * a.getBoundingClientRect().height
          )[0] || root;
      const athleteWindowSignature = (root) => {
        const rootRect = root.getBoundingClientRect();
        const panel = activeTabbedPanel(root);
        const slides = Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide']"))
          .filter(visible)
          .map((slide) => {
            const rect = slide.getBoundingClientRect();
            const area = Math.max(1, rect.width * rect.height);
            const visibleArea = intersects(rect, rootRect);
            const title = cleanText(
              slide.querySelector(".athletes-content-title, [class*='athletes-content-title']")?.innerText ||
              slide.querySelector("h1, h2, h3, h4, p")?.innerText ||
              [slide.innerText, slide.textContent].filter(Boolean).join(" "),
              100
            );
            const subheader = cleanText(
              slide.querySelector(".athletes-subheader, [class*='athletes-subheader']")?.innerText ||
              "",
              140
            );
            const text = cleanText([slide.innerText, slide.textContent].filter(Boolean).join(" "), 220)
              .replace(/\\b\\d+\\s*\\/\\s*\\d+\\b/g, "")
              .replace(/\\s+/g, " ")
              .trim();
            const link = Array.from(slide.querySelectorAll("a[href]")).map(productHref).filter(Boolean)[0] || "";
            const imageNode = slide.querySelector("img, source");
            const image = imageNode ? imageSourcesForNode(imageNode)[0] || "" : "";
            const key = [title || text, subheader, link || image].filter(Boolean).join("|");
            return {
              key,
              title,
              subheader,
              rect,
              visibleArea,
              visibleRatio: visibleArea / area,
              centerY: rect.top + rect.height / 2
            };
          })
          .filter((item) =>
            item.key &&
            item.rect.width >= 160 &&
            item.rect.height >= 160 &&
            item.visibleArea > 800 &&
            item.visibleRatio >= 0.45 &&
            item.rect.left >= rootRect.left + 8 &&
            item.rect.right <= rootRect.right - 8 &&
            item.centerY >= rootRect.top &&
            item.centerY <= rootRect.bottom
          )
          .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
        const deduped = [];
        const seen = new Set();
        for (const item of slides) {
          if (!item.key || seen.has(item.key)) continue;
          seen.add(item.key);
          deduped.push({
            key: item.key,
            title: item.title,
            subheader: item.subheader
          });
        }
        return deduped.length ? JSON.stringify(deduped) : "";
      };
      const rootRect = root.getBoundingClientRect();
      const textNodes = Array.from(root.querySelectorAll("a, button, h1, h2, h3, h4, p, li, article, [class*='card'], [class*='slide']"))
        .filter(visible)
        .filter((node) => intersects(node.getBoundingClientRect(), rootRect) > 80);
      const seenText = new Set();
      const textBlocks = [];
      for (const node of textNodes) {
        const text = cleanText([node.innerText, node.textContent].filter(Boolean).join(" "), 140);
        if (!text || seenText.has(text)) continue;
        seenText.add(text);
        const rect = node.getBoundingClientRect();
        textBlocks.push({
          text,
          x: Math.round(rect.left - rootRect.left),
          y: Math.round(rect.top - rootRect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        });
        if (textBlocks.length >= 24) break;
      }
      const visibleText = textBlocks.map((block) => block.text);
      const images = visibleImageSources(root, rootRect).slice(0, 24);
      const top = Math.max(0, rootRect.top + window.scrollY);
      const left = Math.max(0, rootRect.left + window.scrollX);
      const clip = {
        x: left,
        y: top,
        width: Math.min(rootRect.width, document.documentElement.scrollWidth, window.innerWidth * 1.4),
        height: rootRect.height
      };
      const productSignature = definition.key === "product-showcase" ? productCardSignature(root) : "";
      const athleteSignature = definition.key === "athletes" ? athleteWindowSignature(root) : "";
      if (definition.key === "product-showcase" && state.windowSignature && productSignature !== state.windowSignature) {
        return {
          ok: false,
          reason: "Visible products did not match planned product showcase window " + state.stateLabel + "."
        };
      }
      if (definition.key === "athletes" && state.windowSignature && athleteSignature !== state.windowSignature) {
        return {
          ok: false,
          reason: "Visible athletes did not match planned athletes window " + state.stateLabel + "."
        };
      }
      return {
        ok: true,
        clip,
        text: visibleText.join(" "),
        textBlocks,
        images,
        logicalSignature: definition.key === "product-showcase"
          ? productSignature || state.logicalSignature
          : (definition.key === "athletes" ? athleteSignature || state.logicalSignature : state.logicalSignature),
        activeIndex: state.stateIndex
      };
    })()`,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    return {
      ok: false,
      reason: result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime evaluation failed."
    };
  }
  return result.result?.value || { ok: false };
}

function bannerIndexForCapture(loopIndex, state, slide, bannerCount) {
  for (const value of [state.realIndex, slide.realIndex]) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    const realIndex = Number(value);
    if (Number.isInteger(realIndex) && realIndex >= 0 && realIndex < bannerCount) {
      return realIndex + 1;
    }
  }
  return loopIndex + 1;
}

function validateBannerCaptureCompleteness(captures, bannerCount, duplicates) {
  const expected = Array.from({ length: bannerCount }, (_, index) => index + 1);
  const counts = new Map();
  for (const capture of captures) {
    const bannerIndex = Number(capture.bannerIndex);
    counts.set(bannerIndex, (counts.get(bannerIndex) || 0) + 1);
  }

  const missing = expected.filter((bannerIndex) => !counts.has(bannerIndex));
  const repeated = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([bannerIndex]) => bannerIndex);
  const invalid = [...counts.keys()].filter((bannerIndex) =>
    !Number.isInteger(bannerIndex) || bannerIndex < 1 || bannerIndex > bannerCount
  );

  if (missing.length || repeated.length || invalid.length) {
    const duplicateText = duplicates.length ? ` Duplicates: ${JSON.stringify(duplicates)}` : "";
    throw new Error(
      `Shokz home banner capture is incomplete. Missing banner indexes: ${missing.join(", ") || "none"}. ` +
      `Repeated: ${repeated.join(", ") || "none"}. Invalid: ${invalid.join(", ") || "none"}.${duplicateText}`
    );
  }
}

async function primeLazyImages(client) {
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      document.querySelectorAll("img[loading='lazy']").forEach((img) => {
        img.loading = "eager";
      });
      for (const img of document.querySelectorAll("img")) {
        for (const attr of ["data-src", "data-original", "data-lazy-src"]) {
          const value = img.getAttribute(attr);
          if (value && !img.getAttribute("src")) img.setAttribute("src", value);
        }
        for (const attr of ["data-srcset", "data-lazy-srcset"]) {
          const value = img.getAttribute(attr);
          if (value && !img.getAttribute("srcset")) img.setAttribute("srcset", value);
        }
      }
      return true;
    })()`,
    returnByValue: true
  }).catch(() => null);
}

async function readShokzHomeBannerPlan(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const cleanText = (value, max = 220) => String(value || "")
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, max);
      const classText = (element) => String(element?.className?.baseVal || element?.className || "");
      const imageSources = (element) => Array.from(element.querySelectorAll("img, source"))
        .flatMap((node) => [
          node.currentSrc,
          node.src,
          node.srcset,
          node.getAttribute("data-src"),
          node.getAttribute("data-srcset"),
          node.getAttribute("data-original"),
          node.getAttribute("data-lazy-src"),
          node.getAttribute("data-lazy-srcset")
        ])
        .filter(Boolean)
        .map((value) => String(value).split(",")[0].trim())
        .filter(Boolean);
      const backgroundSources = (element) => {
        const sources = [];
        for (const node of [element, ...element.querySelectorAll("*")].slice(0, 120)) {
          const match = getComputedStyle(node).backgroundImage.match(/url\\(["']?([^"')]+)["']?\\)/);
          if (match?.[1]) sources.push(match[1]);
        }
        return sources;
      };
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const intersects = (rect, clipRect) =>
        Math.max(0, Math.min(rect.right, clipRect.right) - Math.max(rect.left, clipRect.left)) *
        Math.max(0, Math.min(rect.bottom, clipRect.bottom) - Math.max(rect.top, clipRect.top));
      const textOf = (element) => cleanText([
        element.innerText,
        element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title")
      ].filter(Boolean).join(" "), 260);
      const signatureFor = (element, ordinal) => JSON.stringify({
        ordinal,
        realIndex: element.getAttribute?.("data-swiper-slide-index") || "",
        text: textOf(element),
        images: imageSources(element).slice(0, 8),
        backgrounds: backgroundSources(element).slice(0, 6)
      });
      const rootVisible = (element) => {
        if (!element || element === document.body || element === document.documentElement) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width >= Math.min(240, window.innerWidth * 0.55) &&
          rect.height >= 120 &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight * 1.15 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const findSwiper = (root) => [root, ...root.querySelectorAll(".swiper, [class*='swiper']")]
        .find((element) => element.swiper)?.swiper;
      const bulletsFor = (root) => Array.from(root.querySelectorAll(
        ".swiper-pagination-bullet, .slick-dots button, [role='tab'], button[aria-label*='slide' i], button[aria-label*='banner' i]"
      ));
      const fractionCountFor = (root) => {
        const text = cleanText(root.innerText || root.textContent || "", 1400);
        const matches = Array.from(text.matchAll(/(^|\\D)(\\d{1,2})\\s*\\/\\s*(\\d{1,2})(\\D|$)/g));
        return matches
          .map((match) => Number(match[3]))
          .filter((count) => count >= 2 && count <= 12)
          .sort((a, b) => b - a)[0] || 0;
      };
      const collectSlides = (root, bullets, swiper) => {
        const swiperSlides = swiper?.slides ? Array.from(swiper.slides).filter((slide) => slide instanceof Element) : [];
        const preferredSlides = Array.from(root.querySelectorAll("[data-swiper-slide-index], .swiper-slide"));
        const fallbackSlides = Array.from(root.querySelectorAll(".slick-slide"));
        let rawSlides = swiperSlides.length ? swiperSlides : preferredSlides;
        if (!rawSlides.length) rawSlides = fallbackSlides;
        const rawSet = new Set(rawSlides);
        rawSlides = rawSlides.filter((slide) => !rawSlides.some((other) =>
          other !== slide && rawSet.has(other) && other.contains(slide)
        ));
        const unique = new Map();
        const elements = [];
        rawSlides.forEach((slide, ordinal) => {
          if (!(slide instanceof Element)) return;
          const realIndex = slide.getAttribute("data-swiper-slide-index");
          const className = classText(slide);
          if ((/swiper-slide-duplicate|slick-cloned/i.test(className) || slide.getAttribute("aria-hidden") === "true") &&
            (realIndex === null || realIndex === "")) {
            return;
          }
          const signature = signatureFor(slide, ordinal);
          const hasContent = imageSources(slide).length > 0 || backgroundSources(slide).length > 0 || textOf(slide).length > 0;
          if (!hasContent) return;
          const logicalId = realIndex !== null && realIndex !== "" ? "swiper:" + realIndex : "sig:" + signature;
          if (!unique.has(logicalId)) {
            const elementIndex = elements.length;
            elements.push(slide);
            unique.set(logicalId, {
              ordinal: unique.size,
              elementIndex,
              realIndex: realIndex !== null && realIndex !== "" ? Number(realIndex) : unique.size,
              logicalId,
              signature,
              text: textOf(slide, 160),
              images: imageSources(slide).slice(0, 8)
            });
          }
        });
        return { slides: Array.from(unique.values()), elements };
      };
      const fillSlides = (slides, count) => {
        const filled = slides.slice(0, count);
        for (let index = filled.length; index < count; index += 1) {
          filled.push({
            ordinal: index,
            realIndex: index,
            logicalId: "bullet:" + index,
            signature: "bullet:" + index,
            text: "",
            images: []
          });
        }
        return filled;
      };

      const roots = new Set();
      const selectors = [
        ".swiper",
        "[class*='swiper']",
        "[class*='slideshow']",
        "[class*='slider']",
        "[class*='carousel']",
        "[class*='hero']",
        "[class*='banner']"
      ];
      for (const element of document.querySelectorAll(selectors.join(","))) {
        roots.add(element);
        const section = element.closest("section, [class*='hero'], [class*='banner']");
        if (section) roots.add(section);
      }

      const candidates = Array.from(roots)
        .filter(rootVisible)
        .map((root) => {
          const rect = root.getBoundingClientRect();
          const className = classText(root);
          const bullets = bulletsFor(root).filter((item) => item.getBoundingClientRect().width >= 1);
          const swiper = findSwiper(root);
          if (swiper?.autoplay?.stop) swiper.autoplay.stop();
          const collected = collectSlides(root, bullets, swiper);
          const fractionCount = fractionCountFor(root);
          const count = Math.max(collected.slides.length, bullets.length, fractionCount);
          const slides = fillSlides(collected.slides, count);
          const rootText = cleanText(root.innerText || root.textContent || "", 1200);
          const keywordScore = /hero|banner|swiper|slideshow|slider|carousel/i.test(className) ? 35 : 0;
          const hasHeroAction = /shop now|learn more/i.test(rootText);
          const firstScreenHero = rect.top <= Math.max(260, window.innerHeight * 0.32) && hasHeroAction;
          const topScore = Math.max(0, 900 - Math.abs(rect.top)) / 18;
          const sizeScore = Math.min(55, (rect.width * rect.height) / 22000);
          const swiperScore = swiper ? 35 : 0;
          const score = count * 28 + bullets.length * 4 + keywordScore + topScore + sizeScore + swiperScore +
            Number(firstScreenHero) * 140;
          return {
            root,
            slides,
            slideElements: collected.elements,
            count,
            score,
            rect,
            className,
            bulletCount: bullets.length,
            fractionCount,
            hasSwiper: Boolean(swiper),
            firstScreenHero
          };
        })
        .filter((candidate) => candidate.count >= 2 && candidate.firstScreenHero)
        .sort((a, b) => b.score - a.score);

      const best = candidates[0];
      if (!best) {
        return { ok: false, reason: "No visible carousel with two or more logical slides was found." };
      }

      const logicalSlides = best.slides.slice(0, best.count).sort((a, b) =>
        Number(a.realIndex ?? a.ordinal ?? 0) - Number(b.realIndex ?? b.ordinal ?? 0) ||
        Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0)
      );
      window.__pageShotBannerRoot = best.root;
      window.__pageShotBannerSlides = logicalSlides;
      window.__pageShotBannerElements = best.slideElements.slice(0, best.count);
      return {
        ok: true,
        count: best.count,
        slides: window.__pageShotBannerSlides,
        rootClass: best.className.slice(0, 240),
        bulletCount: best.bulletCount,
        hasSwiper: best.hasSwiper,
        score: best.score
      };
    })()`,
    returnByValue: true
  });
  return result.result?.value || { ok: false };
}

async function activateShokzHomeBanner(client, slide, ordinal) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const slide = ${JSON.stringify(slide)};
      const ordinal = ${Number(ordinal)};
      const root = window.__pageShotBannerRoot;
      if (!root) return { ok: false, reason: "Banner carousel root is not available." };
      const swiperElement = [root, ...root.querySelectorAll(".swiper, [class*='swiper']")]
        .find((element) => element.swiper);
      const swiper = swiperElement?.swiper;
      if (swiper) {
        if (swiper.autoplay?.stop) swiper.autoplay.stop();
        window.__pageShotBannerActiveElement = null;
        const realIndex = Number.isFinite(Number(slide.realIndex)) ? Number(slide.realIndex) : ordinal;
        if (typeof swiper.slideToLoop === "function") {
          swiper.slideToLoop(realIndex, 0, false);
        } else if (typeof swiper.slideTo === "function") {
          swiper.slideTo(realIndex, 0, false);
        }
        if (typeof swiper.update === "function") swiper.update();
        return { ok: true, method: "swiper", realIndex };
      }

      const bullets = Array.from(root.querySelectorAll(
        ".swiper-pagination-bullet, .slick-dots button, [role='tab'], button[aria-label*='slide' i], button[aria-label*='banner' i]"
      ));
      const target = bullets[ordinal];
      if (target) {
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        window.__pageShotBannerActiveElement = null;
        return { ok: true, method: "bullet", ordinal };
      }
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const textOf = (element) => [
        element.innerText,
        element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title"),
        element.id,
        String(element.className || "")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const rootRect = root.getBoundingClientRect();
      const nextControls = Array.from(root.querySelectorAll(
        ".swiper-button-next, .slick-next, [aria-label*='next' i], [title*='next' i], button, [role='button'], a"
      ))
        .map((element) => element.closest("button, [role='button'], a, .swiper-button-next, .slick-next") || element)
        .filter((element, index, list) => list.indexOf(element) === index)
        .filter(visible)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = textOf(element);
          const rightSide = rect.left >= rootRect.left + rootRect.width * 0.45;
          const lowerHalf = rect.top >= rootRect.top + rootRect.height * 0.38;
          const explicit = /next|arrow|right|swiper-button-next|slick-next/i.test(text);
          const compact = rect.width <= 120 && rect.height <= 120;
          return { element, score: Number(explicit) * 10 + Number(rightSide) * 4 + Number(lowerHalf) * 3 + Number(compact) * 2 };
        })
        .filter((item) => item.score >= 5)
        .sort((a, b) => b.score - a.score);
      if (ordinal === 0) {
        window.__pageShotBannerActiveElement = null;
        return { ok: true, method: "initial", ordinal };
      }
      const nextControl = nextControls[0]?.element;
      if (nextControl) {
        const rect = nextControl.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        const clicks = Math.max(1, ordinal);
        for (let index = 0; index < clicks; index += 1) {
          nextControl.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
          nextControl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
          nextControl.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
          nextControl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
          nextControl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
        }
        window.__pageShotBannerActiveElement = null;
        return { ok: true, method: "next-control", ordinal };
      }
      const domSlides = Array.isArray(window.__pageShotBannerElements)
        ? window.__pageShotBannerElements.filter((element) => element instanceof Element)
        : [];
      const forcedIndex = Number.isInteger(Number(slide.elementIndex)) ? Number(slide.elementIndex) : ordinal;
      const forced = domSlides[forcedIndex];
      if (forced) {
        const track = forced.parentElement;
        if (track) {
          track.style.setProperty("transition", "none", "important");
          track.style.setProperty("transform", "none", "important");
        }
        for (const element of domSlides) {
          element.style.setProperty("transition", "none", "important");
          element.style.setProperty("transform", "none", "important");
          if (element === forced) {
            element.style.setProperty("display", "block", "important");
            element.style.setProperty("visibility", "visible", "important");
            element.style.setProperty("opacity", "1", "important");
            element.style.setProperty("position", "relative", "important");
            element.style.setProperty("left", "0", "important");
            element.style.setProperty("top", "0", "important");
            element.classList.add("swiper-slide-active");
          } else {
            element.style.setProperty("display", "none", "important");
            element.style.setProperty("visibility", "hidden", "important");
            element.style.setProperty("opacity", "0", "important");
            element.classList.remove("swiper-slide-active");
          }
        }
        window.__pageShotBannerActiveElement = forced;
        return { ok: true, method: "dom-force", ordinal };
      }
      return { ok: false, reason: "No Swiper instance, pagination bullet, or slide element could switch the banner." };
    })()`,
    returnByValue: true
  });
  const value = result.result?.value || {};
  if (!value.ok) {
    throw new Error(value.reason || `Could not activate Shokz banner ${ordinal + 1}.`);
  }
  return value;
}

async function waitForBannerImages(client) {
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const root = window.__pageShotBannerRoot || document;
      const active = root.querySelector(".swiper-slide-active, .slick-active") || root;
      const images = Array.from(active.querySelectorAll("img")).filter((img) => img.currentSrc || img.src);
      return Promise.all(images.map((img) => {
        if (img.complete && img.naturalWidth > 0) return true;
        return new Promise((resolve) => {
          const done = () => resolve(true);
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", done, { once: true });
          setTimeout(done, 1800);
        });
      }));
    })()`,
    awaitPromise: true,
    returnByValue: true
  }).catch(() => null);
}

async function readShokzHomeBannerState(client, ordinal) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const ordinal = ${Number(ordinal)};
      const root = window.__pageShotBannerRoot;
      if (!root) return { ok: false, reason: "Banner carousel root is not available." };
      const cleanText = (value, max = 220) => String(value || "")
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, max);
      const imageSources = (element) => Array.from(element.querySelectorAll("img, source"))
        .flatMap((node) => [
          node.currentSrc,
          node.src,
          node.srcset,
          node.getAttribute("data-src"),
          node.getAttribute("data-srcset"),
          node.getAttribute("data-original"),
          node.getAttribute("data-lazy-src"),
          node.getAttribute("data-lazy-srcset")
        ])
        .filter(Boolean)
        .map((value) => String(value).split(",")[0].trim())
        .filter(Boolean);
      const backgroundSources = (element) => {
        const sources = [];
        for (const node of [element, ...element.querySelectorAll("*")].slice(0, 120)) {
          const match = getComputedStyle(node).backgroundImage.match(/url\\(["']?([^"')]+)["']?\\)/);
          if (match?.[1]) sources.push(match[1]);
        }
        return sources;
      };
      const signatureFor = (element) => JSON.stringify({
        ordinal,
        realIndex: element.getAttribute?.("data-swiper-slide-index") || "",
        text: cleanText([element.innerText, element.textContent].filter(Boolean).join(" "), 260),
        images: imageSources(element).slice(0, 8),
        backgrounds: backgroundSources(element).slice(0, 6)
      });
      const rootRect = root.getBoundingClientRect();
      const slides = Array.from(root.querySelectorAll("[data-swiper-slide-index], .swiper-slide, .slick-slide, [class*='slide']"));
      const areaInRoot = (element) => {
        const rect = element.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.right, rootRect.right) - Math.max(rect.left, rootRect.left));
        const y = Math.max(0, Math.min(rect.bottom, rootRect.bottom) - Math.max(rect.top, rootRect.top));
        return x * y;
      };
      const active = window.__pageShotBannerActiveElement ||
        root.querySelector(".swiper-slide-active:not(.swiper-slide-duplicate), .slick-active") ||
        slides.sort((a, b) => areaInRoot(b) - areaInRoot(a))[0] ||
        root;
      const activeRect = active.getBoundingClientRect();
      const visibleTop = Math.max(0, rootRect.top);
      const visibleBottom = Math.min(window.innerHeight, rootRect.bottom);
      const fallbackHeight = Math.min(rootRect.height, window.innerHeight * 0.95);
      const height = Math.max(1, visibleBottom > visibleTop ? visibleBottom - visibleTop : fallbackHeight);
      const clip = {
        x: Math.max(0, rootRect.left + window.scrollX),
        y: Math.max(0, visibleTop + window.scrollY),
        width: Math.min(rootRect.width, document.documentElement.clientWidth || window.innerWidth),
        height
      };
      const clipRect = {
        left: rootRect.left,
        top: visibleTop,
        right: rootRect.left + clip.width,
        bottom: visibleTop + clip.height
      };
      const seenText = new Set();
      const textBlocks = [];
      for (const node of [active, ...active.querySelectorAll("a, button, h1, h2, h3, h4, p, li, article, [class*='card'], [class*='slide']")]) {
        if (!visible(node)) continue;
        const rect = node.getBoundingClientRect();
        if (intersects(rect, clipRect) <= 80) continue;
        const text = cleanText([node.innerText, node.textContent].filter(Boolean).join(" "), 160);
        if (!text || seenText.has(text)) continue;
        seenText.add(text);
        textBlocks.push({
          text,
          x: Math.round(rect.left - rootRect.left),
          y: Math.round(rect.top - visibleTop),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        });
        if (textBlocks.length >= 18) break;
      }
      return {
        ok: true,
        clip,
        signature: signatureFor(active),
        text: cleanText([active.innerText, active.textContent].filter(Boolean).join(" "), 220),
        textBlocks,
        images: imageSources(active).slice(0, 8),
        activeIndex: ordinal,
        realIndex: active.getAttribute?.("data-swiper-slide-index") || "",
        activeRect: {
          x: activeRect.left,
          y: activeRect.top,
          width: activeRect.width,
          height: activeRect.height
        }
      };
    })()`,
    returnByValue: true
  });
  return result.result?.value || { ok: false };
}

function normalizeBannerClip(inputClip, viewport) {
  if (!inputClip) {
    return null;
  }
  const maxWidth = Math.max(1, Math.min(6000, Number(viewport.width || 1920) * 3));
  const maxHeight = Math.max(1, Math.min(4000, Number(viewport.height || 1080) * 2));
  const x = Math.max(0, Math.floor(Number(inputClip.x) || 0));
  const y = Math.max(0, Math.floor(Number(inputClip.y) || 0));
  const width = Math.max(1, Math.min(maxWidth, Math.ceil(Number(inputClip.width) || 0)));
  const height = Math.max(1, Math.min(maxHeight, Math.ceil(Number(inputClip.height) || 0)));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) {
    return null;
  }
  return { x, y, width, height, scale: 1 };
}

function normalizeRelatedClip(inputClip, viewport) {
  if (!inputClip) {
    return null;
  }
  const maxWidth = Math.max(1, Math.min(6000, Number(viewport.width || 1920) * 3));
  const maxHeight = Math.max(220, Math.min(3200, Number(viewport.height || 1080) * 2.4));
  const x = Math.max(0, Math.floor(Number(inputClip.x) || 0));
  const y = Math.max(0, Math.floor(Number(inputClip.y) || 0));
  const width = Math.max(1, Math.min(maxWidth, Math.ceil(Number(inputClip.width) || 0)));
  const height = Math.max(1, Math.min(maxHeight, Math.ceil(Number(inputClip.height) || 0)));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) {
    return null;
  }
  return { x, y, width, height, scale: 1 };
}

function bannerOutputPath(outputPath, bannerIndex) {
  return outputPath.replace(/\.png$/i, `-banner-${bannerIndex}.png`);
}

function relatedOutputPath(outputPath, sectionKey, stateId) {
  const safeSection = safeFilePart(sectionKey);
  const safeState = safeFilePart(stateId);
  return outputPath.replace(/\.png$/i, `-${safeSection}-${safeState}.png`);
}

function relatedCaptureScopeKey(definition, state) {
  if (definition.mode === "tabs-carousel") {
    return `${definition.key}|${state.tabIndex || state.tabLabel || "tab"}`;
  }
  return definition.key;
}

function scopedSet(map, key) {
  if (!map.has(key)) {
    map.set(key, new Set());
  }
  return map.get(key);
}

function scopedList(map, key) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  return map.get(key);
}

function hashBuffer(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex");
}

function visualHashForBuffer(buffer) {
  try {
    const image = decodePng(buffer);
    const samples = [];
    for (let y = 0; y < 8; y += 1) {
      const sourceY = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / 8));
      for (let x = 0; x < 8; x += 1) {
        const sourceX = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / 8));
        const offset = (sourceY * image.width + sourceX) * 4;
        const gray = Math.round(
          image.rgba[offset] * 0.299 +
          image.rgba[offset + 1] * 0.587 +
          image.rgba[offset + 2] * 0.114
        );
        samples.push(gray);
      }
    }
    const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    let bits = "";
    for (const value of samples) {
      bits += value >= average ? "1" : "0";
    }
    let hex = "";
    for (let index = 0; index < bits.length; index += 4) {
      hex += Number.parseInt(bits.slice(index, index + 4), 2).toString(16);
    }
    return hex;
  } catch {
    return hashBuffer(buffer).slice(0, 16);
  }
}

function visualHashDistance(a, b) {
  if (!a || !b || a.length !== b.length) {
    return Number.POSITIVE_INFINITY;
  }
  let distance = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = Number.parseInt(a[index], 16);
    const right = Number.parseInt(b[index], 16);
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      return Number.POSITIVE_INFINITY;
    }
    distance += bitCount(left ^ right);
  }
  return distance;
}

function nearestVisualHash(hash, previous) {
  return previous
    .map((item) => ({ ...item, distance: visualHashDistance(hash, item.hash) }))
    .sort((a, b) => a.distance - b.distance)[0] || null;
}

function bitCount(value) {
  let count = 0;
  let number = value;
  while (number) {
    count += number & 1;
    number >>= 1;
  }
  return count;
}

function safeFilePart(value) {
  return String(value || "state")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "state";
}

function compareRelatedCaptures(a, b) {
  const sectionOrder = ["banner", ...homeRelatedSectionDefinitions.map((definition) => definition.key)];
  const sectionA = sectionOrder.indexOf(a.sectionKey);
  const sectionB = sectionOrder.indexOf(b.sectionKey);
  const orderA = sectionA === -1 ? 1000 : sectionA;
  const orderB = sectionB === -1 ? 1000 : sectionB;
  return orderA - orderB ||
    Number(a.tabIndex || 0) - Number(b.tabIndex || 0) ||
    Number(a.pageIndex || 0) - Number(b.pageIndex || 0) ||
    Number(a.stateIndex || a.bannerIndex || 0) - Number(b.stateIndex || b.bannerIndex || 0) ||
    String(a.label || "").localeCompare(String(b.label || ""), "zh-CN");
}

async function openShokzProductsNavigation(client, viewport) {
  await scrollTo(client, 0);
  if (!viewport.mobile) {
    await closeShokzSearchOverlay(client);
  }
  await sleep(700);

  let state = null;
  let mobileClick = null;
  if (viewport.mobile) {
    mobileClick = await clickShokzMobileMenu(client);
    await returnShokzMobileMenuToTopLevel(client);
    state = await ensureShokzMobileMenuVisible(client);
  } else {
    await hoverShokzProductsMenu(client);
    state = await waitForShokzProductsNavigation(client, false);
  }

  if (!state.ok) {
    const visibleText = state.visibleText ? ` Visible text: ${state.visibleText}` : "";
    const clickText = mobileClick ? ` click=${mobileClick.clickMethod || "unknown"} "${String(mobileClick.text || mobileClick.meta || "").slice(0, 120)}"` : "";
    const drawerText = state.drawerText ? ` drawer="${state.drawerText}"` : "";
    const details = ` hits=${state.categoryHits || 0}/${state.taxonomyHits || 0} search=${Boolean(state.searchOpen)} cart=${Boolean(state.cartOpen)} drawer=${Boolean(state.drawerVisible)} scrollY=${Math.round(state.scrollY || 0)}${clickText}${drawerText}`;
    throw new Error(`Shokz products navigation did not open.${details}${visibleText}`);
  }
}

async function hoverShokzProductsMenu(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const textOf = (element) => [
        element.innerText,
        element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title"),
        element.id,
        String(element.className || "")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const interactive = Array.from(document.querySelectorAll("a, button, [role='button'], [aria-label], [title], [tabindex], li, summary"));
      const products = interactive
        .filter(visible)
        .map((element) => ({ element, text: textOf(element).slice(0, 220), rect: element.getBoundingClientRect() }))
        .filter((item) => /^products(?:\\s+products){0,3}(?:\\s|$)/i.test(item.text) && !/all products/i.test(item.text))
        .filter((item) =>
          item.rect.top >= 32 &&
          item.rect.top < Math.max(150, window.innerHeight * 0.22) &&
          item.rect.left > 100 &&
          item.rect.left < window.innerWidth - 220 &&
          item.rect.width >= 50 &&
          item.rect.width <= 180 &&
          item.rect.height >= 16 &&
          item.rect.height <= 96
        )
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
      const target = products[0]?.element;
      if (!target) {
        const candidates = interactive
          .filter(visible)
          .map((element) => ({ text: textOf(element).slice(0, 120), rect: element.getBoundingClientRect() }))
          .filter((item) => item.rect.top >= 0 && item.rect.top < 180)
          .slice(0, 12)
          .map((item) => item.text + " @ " + Math.round(item.rect.left) + "," + Math.round(item.rect.top) + " " + Math.round(item.rect.width) + "x" + Math.round(item.rect.height));
        return { ok: false, reason: "Products trigger not found: " + candidates.join(" | ") };
      }
      const rect = target.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      for (const element of [target, target.parentElement, target.closest("li"), target.closest("nav")].filter(Boolean)) {
        for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]) {
          element.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            view: window
          }));
        }
      }
      return { ok: true, x, y, text: textOf(target) };
    })()`,
    returnByValue: true
  });
  const value = result.result?.value || {};
  if (!value.ok) {
    throw new Error(value.reason || "Products trigger not found.");
  }

  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: value.x,
    y: value.y,
    button: "none"
  });
  await sleep(900);
}

async function hideShokzMarketingOverlays(client) {
  for (let round = 0; round < 3; round += 1) {
    const result = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const hidden = [];
        const clicked = [];
        const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
        const visible = (element) => {
          if (!element || !(element instanceof Element)) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.left < window.innerWidth &&
            rect.top < window.innerHeight &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            Number(style.opacity || 1) > 0.01;
        };
        const textOf = (element) => element ? [
          element.innerText || element.textContent,
          element.getAttribute?.("aria-label"),
          element.getAttribute?.("title"),
          element.id,
          String(element.className || "")
        ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim() : "";
        const marketing = /privacy|cookie|newsletter|subscribe|don't miss|dont miss|great deals|email|phone number|sms|offer|discount|coupon/i;
        const closeText = /close|dismiss|no thanks|not now|icon-close|\\u00d7|^x$/i;
        const hideElement = (element, reason) => {
          if (!visible(element) || element.closest?.("#menu-drawer, .menu-drawer")) return false;
          element.dataset.pageShotHidden = "true";
          element.style.setProperty("display", "none", "important");
          element.style.setProperty("visibility", "hidden", "important");
          element.style.setProperty("pointer-events", "none", "important");
          hidden.push(reason || textOf(element).slice(0, 80) || element.tagName);
          return true;
        };
        const clickElement = (element, reason) => {
          const target = element?.closest?.("button, [role='button'], a, [tabindex]") || element;
          if (!visible(target) || target.closest?.("#menu-drawer, .menu-drawer")) return false;
          const link = target.closest?.("a[href]");
          const href = link?.getAttribute("href") || "";
          if (href && href !== "#" && !href.startsWith("#") && !/^javascript:/i.test(href)) return false;
          if (typeof target.click === "function") {
            target.click();
          } else {
            target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          }
          clicked.push(reason || textOf(target).slice(0, 80) || target.tagName);
          return true;
        };
        const layers = Array.from(document.querySelectorAll("body *"))
          .filter((element) => {
            if (!visible(element) || element.closest?.("#menu-drawer, .menu-drawer")) return false;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const area = rect.width * rect.height;
            const zIndex = Number.parseInt(style.zIndex, 10);
            const positioned = ["fixed", "sticky", "absolute"].includes(style.position) || (Number.isFinite(zIndex) && zIndex >= 20);
            return positioned &&
              area >= Math.min(viewportArea * 0.03, 60000) &&
              marketing.test(textOf(element));
          })
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return (br.width * br.height) - (ar.width * ar.height);
          });
        for (const layer of layers) {
          const layerRect = layer.getBoundingClientRect();
          const controls = Array.from(layer.querySelectorAll("button, [role='button'], a, [aria-label], [title], svg, [class], [id]"));
          let closed = false;
          for (const control of controls) {
            if (!visible(control)) continue;
            const rect = control.getBoundingClientRect();
            const text = textOf(control);
            const nearTopRight = rect.width <= 80 &&
              rect.height <= 80 &&
              rect.left >= layerRect.right - Math.max(120, layerRect.width * 0.35) &&
              rect.top <= layerRect.top + Math.max(120, layerRect.height * 0.35);
            if (closeText.test(text) || nearTopRight) {
              closed = clickElement(control, text || "marketing close");
              if (closed) break;
            }
          }
          if (!closed) {
            hideElement(layer, "marketing overlay");
          }
        }
        document.body.classList.remove("overflow-hidden");
        return { hidden, clicked };
      })()`,
      returnByValue: true
    }).catch(() => null);
    const value = result?.result?.value || {};
    const changed = (value.hidden?.length || 0) + (value.clicked?.length || 0);
    await sleep(changed ? 450 : 150);
    if (!changed) {
      return;
    }
  }
}

async function closeShokzSearchOverlay(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < Math.max(180, window.innerHeight * 0.25) &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const textOf = (element) => element ? [
        element.innerText,
        element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title"),
        element.id,
        String(element.className || "")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim() : "";
      const searchLike = (element) => /search/i.test([
        element?.type,
        element?.placeholder,
        element?.getAttribute?.("aria-label"),
        element?.getAttribute?.("title"),
        element?.id,
        String(element?.className || "")
      ].filter(Boolean).join(" "));
      const modalLike = (element) => /search-modal|search__|predictive-search|modal-search/i.test([
        element?.id,
        String(element?.className || ""),
        element?.getAttribute?.("aria-label"),
        element?.getAttribute?.("role")
      ].filter(Boolean).join(" "));
      const searchInput = Array.from(document.querySelectorAll("input"))
        .find((input) => {
          if (!visible(input)) return false;
          const rect = input.getBoundingClientRect();
          return rect.width > 120 && (searchLike(input) || input.closest(".search-modal, [class*='search-modal'], details[open]"));
        });
      const controls = Array.from(document.querySelectorAll("button, [role='button'], a, [aria-label], [title], svg, [class]"))
        .filter(visible)
        .map((element) => {
          const target = element.closest("button, [role='button'], a, [tabindex]") || element;
          const rect = target.getBoundingClientRect();
          const text = [
            target.innerText,
            target.textContent,
            target.getAttribute?.("aria-label"),
            target.getAttribute?.("title"),
            target.id,
            String(target.className || "")
          ].filter(Boolean).join(" ");
          const closeLike = /search-modal__close-button|modal__close-button|close|dismiss|icon-close/i.test(text);
          return { target, rect, closeLike };
        })
        .filter((item) =>
          item.closeLike &&
          item.rect.width <= 96 &&
          item.rect.height <= 96 &&
          item.rect.left > window.innerWidth - 160
        )
        .sort((a, b) => a.rect.top - b.rect.top || b.rect.left - a.rect.left);
      const target = controls[0]?.target;
      const hidden = [];
      const clicked = [];
      if (target) {
        const rect = target.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          target.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            view: window
          }));
        }
        if (typeof target.click === "function") {
          target.click();
        }
        clicked.push(textOf(target) || "search close control");
      }
      for (const details of document.querySelectorAll("details[open]")) {
        if (modalLike(details) || details.contains(searchInput)) {
          details.removeAttribute("open");
          hidden.push("open search details");
        }
      }
      for (const modal of document.querySelectorAll(".search-modal, [class*='search-modal']")) {
        if (visible(modal) || modalLike(modal)) {
          modal.dataset.pageShotHidden = "true";
          modal.style.setProperty("display", "none", "important");
          modal.style.setProperty("visibility", "hidden", "important");
          modal.style.setProperty("pointer-events", "none", "important");
          hidden.push(textOf(modal).slice(0, 80) || "search modal");
        }
      }
      document.body.classList.remove("overflow-hidden", "overflow-hidden-tablet", "overflow-hidden-desktop");
      document.documentElement.classList.remove("overflow-hidden", "overflow-hidden-tablet", "overflow-hidden-desktop");
      return { ok: Boolean(clicked.length || hidden.length), clicked, hidden };
    })()`,
    returnByValue: true
  }).catch(() => null);
  const value = result?.result?.value || {};
  if (value.ok) {
    await sleep(500);
  }
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27
  }).catch(() => null);
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27
  }).catch(() => null);
}

async function ensureShokzSearchOverlayClosed(client, stage) {
  await closeShokzSearchOverlay(client);
  await sleep(250);
  let state = await readShokzSearchOverlayState(client);
  if (state.open) {
    await closeShokzSearchOverlay(client);
    await sleep(500);
    state = await readShokzSearchOverlayState(client);
  }
  if (state.open) {
    const details = state.reason ? ` ${state.reason}` : "";
    throw new Error(`Shokz search overlay is still open before screenshot capture.${details}`);
  }
  return { ok: true, stage };
}

async function readShokzSearchOverlayState(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.left < window.innerWidth &&
          rect.top < Math.max(260, window.innerHeight * 0.35) &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const searchLike = (element) => /search/i.test([
        element?.type,
        element?.placeholder,
        element?.getAttribute?.("aria-label"),
        element?.getAttribute?.("title"),
        element?.id,
        String(element?.className || "")
      ].filter(Boolean).join(" "));
      const modalLike = (element) => /search-modal|search__|predictive-search|modal-search/i.test([
        element?.id,
        String(element?.className || ""),
        element?.getAttribute?.("aria-label"),
        element?.getAttribute?.("role")
      ].filter(Boolean).join(" "));
      const topSearchInput = Array.from(document.querySelectorAll("input"))
        .find((input) => {
          const rect = input.getBoundingClientRect();
          return visible(input) &&
            rect.width > 120 &&
            (searchLike(input) || input.closest(".search-modal, [class*='search-modal'], details[open]"));
        });
      const searchModal = Array.from(document.querySelectorAll(".search-modal, [class*='search-modal']"))
        .find((element) => visible(element));
      const searchDetails = Array.from(document.querySelectorAll("details[open]"))
        .find((element) => modalLike(element) || element.contains(topSearchInput));
      const rightClose = Array.from(document.querySelectorAll("button, [role='button'], a, [aria-label], [title], svg, [class]"))
        .find((element) => {
          if (!visible(element)) return false;
          const target = element.closest("button, [role='button'], a, [tabindex]") || element;
          const rect = target.getBoundingClientRect();
          const text = [
            target.innerText,
            target.textContent,
            target.getAttribute?.("aria-label"),
            target.getAttribute?.("title"),
            target.id,
            String(target.className || "")
          ].filter(Boolean).join(" ");
          return /search-modal__close-button|modal__close-button|close|dismiss|icon-close/i.test(text) &&
            rect.width <= 96 &&
            rect.height <= 96 &&
            rect.left > window.innerWidth - 180;
        });
      const open = Boolean(topSearchInput || searchModal || searchDetails || rightClose);
      const reason = [
        topSearchInput ? "top search input visible" : "",
        searchModal ? "search modal visible" : "",
        searchDetails ? "search details open" : "",
        rightClose ? "right close control visible" : ""
      ].filter(Boolean).join(", ");
      return { open, reason };
    })()`,
    returnByValue: true
  }).catch(() => ({ result: { value: { open: false, reason: "" } } }));
  return result.result?.value || { open: false, reason: "" };
}

async function clickShokzMobileMenu(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      document.querySelectorAll("[data-page-shot-mobile-menu-target]").forEach((element) => {
        element.removeAttribute("data-page-shot-mobile-menu-target");
      });
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.left < window.innerWidth &&
          rect.top < Math.max(180, window.innerHeight * 0.3) &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const textOf = (element) => element ? [
        element.innerText,
        element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title"),
        element.id,
        String(element.className || "")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim() : "";
      const targetOf = (element) => element?.closest?.("summary, button, [role='button'], a, label, [tabindex]") || element;
      const htmlOf = (element) => String(element?.outerHTML || "").slice(0, 900);
      const usableRect = (element) => {
        if (!element || !(element instanceof Element)) return null;
        const direct = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const onscreen = direct.bottom > 0 &&
          direct.right > 0 &&
          direct.left < window.innerWidth &&
          direct.top < Math.max(180, window.innerHeight * 0.3) &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
        if (onscreen && direct.width >= 8 && direct.height >= 8) {
          return direct;
        }
        for (const child of element.querySelectorAll?.("span, svg, path, use, .svg-wrapper, [class*='icon']") || []) {
          const childRect = child.getBoundingClientRect();
          const childStyle = getComputedStyle(child);
          const childOnscreen = childRect.width >= 8 &&
            childRect.height >= 8 &&
            childRect.bottom > 0 &&
            childRect.right > 0 &&
            childRect.left < window.innerWidth &&
            childRect.top < Math.max(180, window.innerHeight * 0.3) &&
            childStyle.visibility !== "hidden" &&
            childStyle.display !== "none" &&
            Number(childStyle.opacity || 1) > 0.01;
          if (childOnscreen) {
            return childRect;
          }
        }
        return null;
      };
      const contextOf = (element) => {
        const context = element?.closest?.("details, nav, [class*='menu'], [class*='drawer'], [id*='menu'], [id*='drawer']");
        return [
          context?.tagName,
          context?.id,
          String(context?.className || "")
        ].filter(Boolean).join(" ");
      };
      const metaOf = (element) => [
        textOf(element),
        htmlOf(element),
        contextOf(element)
      ].filter(Boolean).join(" ");
      const badTarget = (text) => /cart|bag|search|account|user|login|learn|feedback|chat|wishlist/i.test(text);
      const menuTarget = (text) => /menu|hamburger|drawer|header__icon--menu|icon-menu|menu-drawer/i.test(text) && !badTarget(text);
      const makeCandidate = (element, source) => {
        const target = targetOf(element);
        if (!target) return null;
        const rect = usableRect(target) || usableRect(element);
        if (!rect) return null;
        const text = textOf(target);
        const ownMeta = [text, htmlOf(target)].filter(Boolean).join(" ");
        const meta = metaOf(target);
        if (badTarget(ownMeta)) return null;
        const rightZone = rect.left >= window.innerWidth * 0.56 || rect.right >= window.innerWidth - 72;
        const topZone = rect.top >= 42 && rect.top <= Math.max(150, window.innerHeight * 0.22);
        const compact = rect.width >= 8 && rect.height >= 8 && rect.width <= 112 && rect.height <= 112;
        if (!rightZone || !topZone || !compact) return null;
        const menuLike = menuTarget(meta);
        const score =
          Number(menuLike) * 100 +
          Number(target.tagName.toLowerCase() === "summary") * 24 +
          Number(/header__icon--menu|menu-drawer|hamburger/i.test(meta)) * 40 +
          Number(source === "direct") * 12 +
          Math.max(0, rect.right - window.innerWidth * 0.65) / 10 -
          Math.abs((rect.top + rect.height / 2) - 104) / 25;
        return { target, rect, text, meta: meta.slice(0, 220), source, menuLike, score };
      };
      const directSelectors = [
        "summary.header__icon--menu",
        "header summary[class*='menu']",
        "header button[class*='menu']",
        "header [aria-label*='menu' i]",
        "summary[aria-label*='menu' i]",
        "button[aria-label*='menu' i]",
        "[role='button'][aria-label*='menu' i]",
        "[class*='hamburger']",
        "[class*='menu-drawer'] summary",
        "details > summary"
      ];
      const seen = new Set();
      const candidates = [];
      for (const selector of directSelectors) {
        for (const element of document.querySelectorAll(selector)) {
          const candidate = makeCandidate(element, "direct");
          if (!candidate || seen.has(candidate.target)) continue;
          seen.add(candidate.target);
          candidates.push(candidate);
        }
      }
      const interactiveSelector = "summary, button, [role='button'], a, label, [aria-label], [title], [tabindex], svg, [class*='menu'], [class*='drawer']";
      for (const element of document.querySelectorAll(interactiveSelector)) {
        const candidate = makeCandidate(element, "scan");
        if (!candidate || seen.has(candidate.target)) continue;
        seen.add(candidate.target);
        candidates.push(candidate);
      }
      let target = candidates
        .filter((item) => item.menuLike)
        .sort((a, b) => b.score - a.score || b.rect.right - a.rect.right || a.rect.top - b.rect.top)[0]?.target;
      let clickMethod = "menu-candidate";
      let forcedPoint = null;
      if (!target) {
        const fallback = candidates
          .filter((item) => item.rect.right >= window.innerWidth - 82)
          .sort((a, b) => b.score - a.score || b.rect.right - a.rect.right || a.rect.top - b.rect.top)[0];
        if (fallback) {
          target = fallback.target;
          clickMethod = "rightmost-header-control";
        }
      }
      if (!target) {
        const yValues = [96, 104, 112, 88, 120, 80, 128];
        const xValues = [28, 34, 40, 46, 52, 60].map((offset) => Math.round(window.innerWidth - offset));
        for (const y of yValues) {
          for (const x of xValues) {
            const pointElement = document.elementFromPoint(x, y);
            const candidate = makeCandidate(targetOf(pointElement), "point");
            if (candidate && !badTarget(candidate.meta)) {
              target = candidate.target;
              clickMethod = "geometry";
              forcedPoint = { x, y };
              break;
            }
          }
          if (target) break;
        }
      }
      if (!target) {
        const debug = candidates
          .slice(0, 10)
          .map((item) => item.text.slice(0, 100) + " @ " + Math.round(item.rect.left) + "," + Math.round(item.rect.top) + " " + Math.round(item.rect.width) + "x" + Math.round(item.rect.height) + " " + item.meta.slice(0, 80));
        return { ok: false, reason: "Mobile menu trigger not found: " + debug.join(" | ") };
      }
      target.setAttribute("data-page-shot-mobile-menu-target", "true");
      const rect = target.getBoundingClientRect();
      const x = forcedPoint?.x ?? Math.round(rect.left + rect.width / 2);
      const y = forcedPoint?.y ?? Math.round(rect.top + rect.height / 2);
      if (typeof target.click === "function") {
        target.click();
      } else {
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
      }
      return { ok: true, x, y, text: textOf(target), clickMethod, meta: metaOf(target).slice(0, 220) };
    })()`,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      "unknown evaluation error";
    throw new Error(`Mobile menu trigger evaluation failed: ${details}`);
  }
  const value = result.result?.value || {};
  if (!value.ok) {
    throw new Error(value.reason || "Mobile menu trigger not found.");
  }
  await sleep(900);
  return value;
}

async function ensureShokzMobileMenuVisible(client) {
  return waitForShokzProductsNavigation(client, true);
}

async function returnShokzMobileMenuToTopLevel(client) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const visible = (element) => {
          if (!element || !(element instanceof Element)) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.left < window.innerWidth &&
            rect.top < window.innerHeight &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            Number(style.opacity || 1) > 0.01;
        };
        const textOf = (element) => element ? [
          element.innerText || element.textContent,
          element.getAttribute?.("aria-label"),
          element.getAttribute?.("title"),
          element.id,
          String(element.className || "")
        ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim() : "";
        const usableRect = (element) => {
          if (!element || !(element instanceof Element)) return null;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.left < window.innerWidth &&
            rect.top < window.innerHeight &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            Number(style.opacity || 1) > 0.01) {
            return rect;
          }
          return null;
        };
        const drawer = document.querySelector("#menu-drawer, .menu-drawer");
        if (!visible(drawer)) return { ok: true, moved: false, reason: "drawer-not-visible" };
        const controls = Array.from(document.querySelectorAll("button, [role='button'], a, summary, svg, [class*='close-button'], [class*='arrow']"))
          .map((element) => {
            const target = element.closest?.("button, [role='button'], a, summary") || element;
            const rect = usableRect(target) || usableRect(element) || target.getBoundingClientRect();
            const text = textOf(target) + " " + String(target.outerHTML || "").slice(0, 500);
            return { target, rect, text };
          })
          .filter((item) =>
            item.rect.width > 0 &&
            item.rect.height > 0 &&
            item.rect.left >= 0 &&
            item.rect.left < Math.max(90, window.innerWidth * 0.25) &&
            item.rect.top >= 40 &&
            item.rect.top < 170 &&
            item.rect.width <= 120 &&
            item.rect.height <= 80 &&
            /menu-drawer__close-button|back|arrow|icon-arrow|chevron/i.test(item.text) &&
            !/icon-close|modal__close|search/i.test(item.text)
          )
          .sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);
        const target = controls[0]?.target;
        if (!target) return { ok: true, moved: false, reason: "back-button-not-visible" };
        if (typeof target.click === "function") {
          target.click();
        } else {
          target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        }
        return { ok: true, moved: true, text: textOf(target).slice(0, 120) };
      })()`,
      returnByValue: true
    }).catch(() => null);
    const value = result?.result?.value || {};
    if (!value.moved) {
      return;
    }
    await sleep(650);
  }
}

async function waitForShokzProductsNavigation(client, mobile) {
  let lastState = { ok: false };
  for (let attempt = 0; attempt < 12; attempt += 1) {
    lastState = await readShokzProductsNavigationState(client, mobile);
    if (lastState.ok) {
      return lastState;
    }
    await sleep(350);
  }
  return lastState;
}

async function readShokzProductsNavigationState(client, mobile) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const mobile = ${mobile ? "true" : "false"};
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight &&
          rect.height <= window.innerHeight + 260 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const textOf = (element) => element ? [
        element.innerText || element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim() : "";
      const comparableText = (value) => String(value || "")
        .toLowerCase()
        .replace(/s/g, "")
        .replace(/[^a-z0-9]+/g, "");
      const includesLabel = (text, label) => comparableText(text).includes(comparableText(label));
      const categories = ["Sports Headphones", "Workout & Lifestyle Earbuds", "Communication Headsets"];
      const desktopTaxonomy = ["Open-Ear Headphones", "Bone Conduction Sports Headphones", "Workout & Lifestyle Open Earbuds"];
      const utilityLinks = ["Accessories", "Refurbished", "Buy In Bulk", "Compare Products", "All Products"];
      const mobileTopLevel = ["Support", "Technology"];
      const searchOpen = Array.from(document.querySelectorAll("input"))
        .some((input) => {
          if (!visible(input)) return false;
          const rect = input.getBoundingClientRect();
          const hint = [input.type, input.placeholder, input.getAttribute("aria-label"), input.id, String(input.className || "")].filter(Boolean).join(" ");
          return rect.width > 120 && rect.top < 160 && /search/i.test(hint);
        });
      const cartOpen = Array.from(document.querySelectorAll("body *"))
        .some((element) => {
          if (!visible(element)) return false;
          const rect = element.getBoundingClientRect();
          const text = textOf(element);
          return rect.top < 100 && rect.height <= 120 && /^YOUR CART/i.test(text);
        });
      const layers = Array.from(document.querySelectorAll("body *"))
        .filter(visible)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const text = textOf(element);
          const meta = [
            element.id,
            String(element.className || ""),
            textOf(element.closest?.("details, header, nav, [class*='menu'], [class*='drawer'], [id*='menu'], [id*='drawer']"))
          ].filter(Boolean).join(" ");
          const categoryHits = categories.filter((value) => includesLabel(text, value)).length;
          const taxonomyHits = desktopTaxonomy.filter((value) => includesLabel(text, value)).length;
          const utilityHits = utilityLinks.filter((value) => includesLabel(text, value)).length;
          const topLevelHits = mobileTopLevel.filter((value) => includesLabel(text, value)).length;
          const positioned = ["fixed", "absolute", "sticky"].includes(style.position) ||
            (Number.parseInt(style.zIndex, 10) || 0) >= 10;
          const anchoredPanel = rect.top < 180 &&
            rect.left <= Math.max(80, window.innerWidth * 0.18) &&
            rect.right >= window.innerWidth * 0.65 &&
            rect.height > window.innerHeight * 0.35;
          const menuMeta = /menu|drawer|navigation|nav|header/i.test(meta);
          const productListLike = /OPENRUN|OPENSWIM|OPENMOVE|OPENFIT|Flagship/i.test(text) &&
            /Bone Conduction|Bluetooth|Premium Sound|Budget-Friendly/i.test(text);
          const panelLike = positioned || anchoredPanel;
          const mobilePanelLike = anchoredPanel &&
            (menuMeta || categoryHits >= 3) &&
            !/YOUR CART/i.test(text) &&
            !/Search results|Search for/i.test(text) &&
            !productListLike;
          return {
            text,
            categoryHits,
            taxonomyHits,
            utilityHits,
            topLevelHits,
            panelLike,
            mobilePanelLike,
            rect: {
              top: rect.top,
              left: rect.left,
              right: rect.right,
              height: rect.height,
              width: rect.width
            }
          };
        })
        .filter((item) => item.text.length > 0 && item.text.length < 8000)
        .sort((a, b) => {
          const scoreA = a.categoryHits * 5 + a.taxonomyHits * 3 + a.utilityHits * 2 + a.topLevelHits * 3 + Number(a.panelLike) + Number(a.mobilePanelLike) * 4;
          const scoreB = b.categoryHits * 5 + b.taxonomyHits * 3 + b.utilityHits * 2 + b.topLevelHits * 3 + Number(b.panelLike) + Number(b.mobilePanelLike) * 4;
          return scoreB - scoreA;
        });
      const empty = { text: "", categoryHits: 0, taxonomyHits: 0, utilityHits: 0, topLevelHits: 0, panelLike: false, mobilePanelLike: false };
      const desktopBest = layers[0] || empty;
      const mobileBest = layers
        .filter((item) =>
          item.mobilePanelLike &&
          includesLabel(item.text, "Products") &&
          item.categoryHits >= 3 &&
          item.topLevelHits >= 1
        )[0] || empty;
      const best = mobile ? mobileBest : desktopBest;
      const mobileOk = !searchOpen &&
        !cartOpen &&
        window.scrollY < 20 &&
        includesLabel(best.text, "Products") &&
        best.categoryHits >= 3 &&
        best.topLevelHits >= 1 &&
        best.mobilePanelLike;
      const desktopOk = !searchOpen &&
        !cartOpen &&
        window.scrollY < 20 &&
        includesLabel(best.text, "Products") &&
        best.categoryHits >= 2 &&
        (best.taxonomyHits >= 1 || best.panelLike);
      const drawer = document.querySelector("#menu-drawer, .menu-drawer");
      const drawerVisible = Boolean(drawer && visible(drawer));
      const drawerText = drawer ? textOf(drawer).slice(0, 220) : "";
      return {
        ok: mobile ? mobileOk : desktopOk,
        visibleText: best.text.slice(0, 260),
        categoryHits: best.categoryHits,
        taxonomyHits: best.taxonomyHits,
        utilityHits: best.utilityHits,
        topLevelHits: best.topLevelHits,
        panelLike: best.panelLike,
        mobilePanelLike: best.mobilePanelLike,
        searchOpen,
        cartOpen,
        drawerVisible,
        drawerText,
        scrollY: window.scrollY
      };
    })()`,
    returnByValue: true
  }).catch(() => ({ result: { value: { ok: false } } }));
  return result.result?.value || { ok: false };
}

async function verifyCurrentUrl(client, requestedUrl, stage, urlCheck) {
  const finalUrl = await readCurrentUrl(client);
  const ok = urlsEquivalent(requestedUrl, finalUrl);
  urlCheck.finalUrl = finalUrl;
  urlCheck.checks.push({ stage, url: finalUrl, ok });
  if (!ok) {
    const error = new Error(
      `URL check failed ${stage}: requested ${requestedUrl} but browser is at ${finalUrl || "an empty URL"}.`
    );
    error.requestedUrl = requestedUrl;
    error.finalUrl = finalUrl;
    error.urlCheck = urlCheck;
    throw error;
  }
  return finalUrl;
}

async function readCurrentUrl(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: "window.location.href",
    returnByValue: true
  }).catch(() => ({ result: { value: "" } }));
  return result.result?.value || "";
}

function urlsEquivalent(requestedUrl, finalUrl) {
  const requested = comparableUrl(requestedUrl);
  const final = comparableUrl(finalUrl);
  return Boolean(requested && final && requested === final);
}

function comparableUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    url.protocol = "https:";
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = normalizePathname(url.pathname);
    return url.toString();
  } catch {
    return null;
  }
}

function normalizePathname(pathname) {
  const clean = pathname.replace(/\/+$/g, "");
  return clean || "/";
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
    await scrollTo(client, y);
    await sleep(Math.max(120, Math.min(700, options.stepDelay)));
    await dismissObstructions(client, { rounds: index === 0 ? 4 : 2 });
    await sleep(160);
    if (index === 0 && typeof options.beforeFirstSegmentCapture === "function") {
      await options.beforeFirstSegmentCapture();
    }
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

async function dismissObstructions(client, options = {}) {
  const rounds = Math.max(1, Math.min(6, options.rounds ?? 3));
  for (let round = 0; round < rounds; round += 1) {
    const result = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const clicked = [];
        const hidden = [];
        const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
        const visible = (element) => {
          if (!element || !(element instanceof Element)) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            Number(style.opacity || 1) > 0.01;
        };
        const textOf = (element) => [
          element.innerText,
          element.textContent,
          element.getAttribute?.("aria-label"),
          element.getAttribute?.("title"),
          element.getAttribute?.("name"),
          element.value,
          element.id,
          String(element.className || "")
        ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
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
        const popupMatches = [
          /newsletter/i,
          /subscribe/i,
          /sign up/i,
          /email/i,
          /don't miss/i,
          /dont miss/i,
          /great deals/i,
          /discount/i,
          /offer/i,
          /coupon/i,
          /popup/i,
          /modal/i,
          /dialog/i,
          /sms/i,
          /phone number/i
        ];
        const clickableSelector = "button, [role='button'], input[type='button'], input[type='submit'], a, [aria-label], [title], [tabindex]";
        const clickCandidateSelector = "button, [role='button'], input[type='button'], input[type='submit'], [aria-label], [title], [tabindex]";
        const interactiveSelector = "button, [role='button'], input, a, [aria-label], [title], [tabindex]";
        const navigatesAway = (target) => {
          const link = target.closest?.("a[href]");
          if (!link) return false;
          const rawHref = String(link.getAttribute("href") || "").trim();
          if (!rawHref || rawHref === "#" || rawHref.startsWith("#") || /^javascript:/i.test(rawHref)) {
            return false;
          }
          try {
            const current = new URL(window.location.href);
            const destination = new URL(rawHref, current);
            if (!["http:", "https:"].includes(destination.protocol)) {
              return true;
            }
            return destination.origin !== current.origin ||
              destination.pathname !== current.pathname ||
              destination.search !== current.search;
          } catch {
            return true;
          }
        };
        const clickElement = (element, reason) => {
          if (!visible(element)) return false;
          const target = element.closest?.(interactiveSelector) || element;
          if (!visible(target)) return false;
          if (!target.matches?.(interactiveSelector)) return false;
          if (navigatesAway(target)) return false;
          if (typeof target.click === "function") {
            target.click();
          } else {
            target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          }
          clicked.push(reason || textOf(target) || target.tagName);
          return true;
        };
        const hideElement = (element, reason) => {
          if (!visible(element) || element === document.body || element === document.documentElement) return false;
          element.dataset.pageShotHidden = "true";
          element.style.setProperty("visibility", "hidden", "important");
          element.style.setProperty("pointer-events", "none", "important");
          hidden.push(reason || textOf(element).slice(0, 80) || element.tagName);
          return true;
        };
        const candidates = Array.from(document.querySelectorAll(clickCandidateSelector));
        for (const matcherSet of [clickMatches, closeMatches]) {
          for (const element of candidates) {
            if (!visible(element)) continue;
            const text = textOf(element);
            if (!text || text.length > 240) continue;
            if (matcherSet.some((matcher) => matcher.test(text))) {
              clickElement(element, text || "matched close control");
            }
          }
        }

        const layers = Array.from(document.querySelectorAll("body *"))
          .filter((element) => {
            if (!visible(element) || element.dataset.pageShotHidden === "true") return false;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            const zIndex = Number.parseInt(style.zIndex, 10);
            const area = rect.width * rect.height;
            const positioned = ["fixed", "sticky"].includes(style.position) || (Number.isFinite(zIndex) && zIndex >= 1000);
            return positioned && area >= Math.min(viewportArea * 0.08, 120000);
          })
          .sort((a, b) => {
            const az = Number.parseInt(getComputedStyle(a).zIndex, 10) || 0;
            const bz = Number.parseInt(getComputedStyle(b).zIndex, 10) || 0;
            return bz - az;
          });

        for (const layer of layers) {
          const layerRect = layer.getBoundingClientRect();
          const layerText = textOf(layer);
          const popupLike = popupMatches.some((matcher) => matcher.test(layerText));
          const closeControls = Array.from(layer.querySelectorAll(clickableSelector + ", svg, [class], [id]"));
          let closed = false;
          for (const control of closeControls) {
            if (!visible(control)) continue;
            const rect = control.getBoundingClientRect();
            const text = textOf(control);
            const nearTopRight = rect.width <= 96 &&
              rect.height <= 96 &&
              rect.left >= layerRect.right - Math.max(140, layerRect.width * 0.3) &&
              rect.top <= layerRect.top + Math.max(140, layerRect.height * 0.3);
            const iconLike = nearTopRight && (control.matches(clickableSelector) || control.querySelector?.("svg,path") || control.tagName.toLowerCase() === "svg");
            const explicitClose = closeMatches.some((matcher) => matcher.test(text));
            if (explicitClose || (popupLike && iconLike)) {
              closed = clickElement(control, text || "top-right popup control");
              if (closed) break;
            }
          }
          if (!closed && popupLike) {
            hideElement(layer, "popup layer fallback");
          }
        }

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return { clicked, hidden };
      })()`,
      returnByValue: true
    }).catch(() => null);
    const value = result?.result?.value || {};
    const changed = (value.clicked?.length || 0) + (value.hidden?.length || 0);
    await sleep(changed ? 450 : 250);
  }
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

async function removeTempDir(dir) {
  try {
    await fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 250
    });
  } catch (error) {
    if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code)) {
      throw error;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
