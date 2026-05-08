import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CdpClient } from "./cdp.js";
import { decodePng, encodePng } from "./png.js";

const defaultTimeoutMs = 45000;
const shokzNavigationTopLabels = ["Products", "Support", "Technology", "About Us"];
const shokzProductsNavigationCategoryLabels = [
  "Sports Headphones",
  "Workout & Lifestyle Earbuds",
  "Communication Headsets"
];

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
  const cleanShokzKnownPopups = shouldCleanShokzKnownPopups(url, options);
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
    if (cleanShokzKnownPopups) {
      await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 3 });
    } else {
      await dismissObstructions(client);
    }
    if (shouldGuardShokzSearchOverlay(url, viewport, options)) {
      await ensureShokzSearchOverlayClosed(client, "after dismissing popups");
    }
    await verifyCurrentUrl(client, url, "after dismissing popups", urlCheck);
  }

  if (options.captureMode === "shokz-products-nav") {
    stage = "opening Shokz products navigation";
    await openShokzProductsNavigation(client, viewport);
    if (deferShokzMobileNavDismiss) {
      await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 3, hideOnly: true });
    }
    await verifyCurrentUrl(client, url, "after opening Shokz products navigation", urlCheck);
  }

  if (
    options.captureMode === "shokz-home-banners" ||
    options.captureMode === "shokz-home-related" ||
    options.captureMode === "shokz-products-nav-related"
  ) {
    stage = "reading page title";
    const titleResult = await readPageTitle(client);
    stage = options.captureMode === "shokz-products-nav-related"
      ? "capturing Shokz products navigation states"
      : options.captureMode === "shokz-home-related"
        ? "capturing Shokz home related sections"
        : "capturing Shokz home banners";
    const relatedCapture = options.captureMode === "shokz-products-nav-related"
      ? await captureShokzProductsNavigationRelated(client, outputPath, viewport)
      : options.captureMode === "shokz-home-related"
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
      if (cleanShokzKnownPopups) {
        await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 3 });
      } else {
        await dismissObstructions(client);
      }
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
    const beforeSegmentCapture = () => prepareForScreenshotCapture(client, {
      rounds: 2,
      shokzKnownPopups: cleanShokzKnownPopups,
      guardSearchOverlay: guardShokzSearchOverlay,
      stage: "before stitched segment screenshot capture"
    });
    if (viewport.mobile) {
      await beforeSegmentCapture();
      await materializeFullPageContent(client);
      await captureFullPageClipScreenshot(client, outputPath, {
        width: clipWidth,
        height: clipHeight
      });
    } else {
      await captureStitchedScreenshot(client, outputPath, {
        width: clipWidth,
        height: clipHeight,
        viewportHeight: viewport.height,
        stepDelay: options.scrollStepMs ?? 350,
        dismissObstructionsBeforeSegment: !cleanShokzKnownPopups,
        hideFixedElementsAfterFirstSegment: options.hideFixedElementsAfterFirstSegment !== false,
        beforeSegmentCapture,
        beforeFirstSegmentCapture: guardShokzSearchOverlay
          ? () => ensureShokzSearchOverlayClosed(client, "before first segment screenshot capture")
          : null
      });
    }
  } else {
    if (options.captureMode === "shokz-products-nav") {
      await prepareShokzNavigationMainScreenshot(client, viewport);
    } else {
      await prepareForScreenshotCapture(client, {
        rounds: 2,
        shokzKnownPopups: cleanShokzKnownPopups,
        guardSearchOverlay: shouldGuardShokzSearchOverlay(url, viewport, options),
        stage: "before screenshot capture"
      });
    }
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

function shouldCleanShokzKnownPopups(url, options = {}) {
  if (String(options.captureMode || "").startsWith("shokz-")) {
    return true;
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
      savedCount: bannerCapture.captures.length,
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

async function captureShokzProductsNavigationRelated(client, outputPath, viewport) {
  await scrollTo(client, 0);
  await sleep(700);
  await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 3, hideOnly: true });

  if (viewport.mobile) {
    return {
      width: viewport.width,
      height: viewport.height,
      captures: [],
      relatedValidation: {
        status: "ok",
        warnings: [],
        sections: [{
          sectionKey: "navigation",
          sectionLabel: "Navigation",
          expectedCount: 0,
          capturedCount: 0,
          savedCount: 0,
          status: "ok"
        }]
      }
    };
  }

  const plan = await readShokzNavigationTopLevelItems(client);
  if (!plan.ok || !Array.isArray(plan.items) || !plan.items.length) {
    throw new Error(plan.reason || "Could not identify Shokz top-level navigation items.");
  }

  const captures = [];
  const warnings = [];
  const seenVisual = new Set();
  const mainSeed = await visualSeedForFile(outputPath);
  let expectedCount = 0;
  const topItemsByLabel = new Map();
  for (const [index, label] of shokzNavigationTopLabels.entries()) {
    const item = plan.items.find((candidate) =>
      comparableNavigationLabel(candidate.label) === comparableNavigationLabel(label)
    );
    if (item) {
      topItemsByLabel.set(label, { ...item, label, index: index + 1 });
    } else {
      warnings.push({
        sectionKey: "navigation",
        sectionLabel: "Navigation",
        stateLabel: label,
        message: `Could not identify ${label} top-level navigation item.`
      });
    }
  }
  const productsTopItem = topItemsByLabel.get("Products") || {
    index: 1,
    label: "Products",
    hoverPoint: null,
    rect: null
  };

  try {
    let productOpenError = null;
    try {
      await openShokzProductsNavigation(client, viewport);
    } catch (error) {
      productOpenError = error;
      await hoverShokzNavigationPoint(client, productsTopItem.hoverPoint);
    }
    await sleep(750);
    await primeLazyImages(client);
    const productsSecondaryPlan = await readShokzProductsNavigationCategoryItems(client, productsTopItem);
    if (!productsSecondaryPlan.items?.length && productOpenError) {
      throw productOpenError;
    }
    if (!productsSecondaryPlan.ok) {
      warnings.push({
        sectionKey: "navigation",
        sectionLabel: "Navigation",
        stateLabel: productsTopItem.label,
        message: productsSecondaryPlan.reason || "Could not identify Products secondary navigation items."
      });
    }

    for (const secondaryItem of productsSecondaryPlan.items || []) {
      expectedCount += 1;
      await hoverShokzNavigationPoint(client, secondaryItem.hoverPoint);
      await sleep(650);
      await primeLazyImages(client);
      await saveShokzNavigationCapture(client, outputPath, viewport, {
        navigationLevel: "secondary",
        topLevelLabel: productsTopItem.label,
        topLevelIndex: productsTopItem.index,
        tabLabel: productsTopItem.label,
        tabIndex: productsTopItem.index,
        hoverItemKey: `secondary:${productsTopItem.index}:${secondaryItem.index}`,
        hoverItemLabel: secondaryItem.label,
        hoverItemRect: secondaryItem.rect || null,
        hoverPoint: secondaryItem.hoverPoint || null,
        hoverIndex: secondaryItem.index,
        stateLabel: `${productsTopItem.label} / ${secondaryItem.label}`,
        fileId: `top-${productsTopItem.index}-secondary-${secondaryItem.index}-${secondaryItem.label}`,
        skipMainDuplicate: false
      }, { captures, warnings, seenVisual, mainSeed });
    }
  } catch (error) {
    warnings.push({
      sectionKey: "navigation",
      sectionLabel: "Navigation",
      stateLabel: productsTopItem.label,
      message: error.message
    });
  }

  for (const label of shokzNavigationTopLabels.filter((itemLabel) => !isProductsNavigationLabel(itemLabel))) {
    const topItem = topItemsByLabel.get(label);
    if (!topItem) {
      continue;
    }

    await hoverShokzNavigationPoint(client, topItem.hoverPoint);
    await sleep(750);
    await primeLazyImages(client);

    expectedCount += 1;
    await saveShokzNavigationCapture(client, outputPath, viewport, {
      navigationLevel: "primary",
      topLevelLabel: topItem.label,
      topLevelIndex: topItem.index,
      tabLabel: topItem.label,
      tabIndex: topItem.index,
      hoverItemKey: `primary:${topItem.index}`,
      hoverItemLabel: topItem.label,
      hoverItemRect: topItem.rect || null,
      hoverPoint: topItem.hoverPoint || null,
      hoverIndex: 0,
      stateLabel: `Primary ${topItem.label}`,
      fileId: `top-${topItem.index}-${topItem.label}`,
      skipMainDuplicate: false
    }, { captures, warnings, seenVisual, mainSeed });
  }

  captures.forEach((capture, index) => {
    capture.stateIndex = index + 1;
    capture.stateCount = captures.length;
    if (capture.sectionState) {
      capture.sectionState.activeIndex = index + 1;
    }
  });

  return {
    width: captures.reduce((max, capture) => Math.max(max, capture.width || 0), viewport.width),
    height: captures.reduce((max, capture) => Math.max(max, capture.height || 0), viewport.height),
    captures: captures.sort(compareRelatedCaptures),
    relatedValidation: {
      status: warnings.length ? "warning" : "ok",
      warnings,
      sections: [{
        sectionKey: "navigation",
        sectionLabel: "Navigation",
        expectedCount,
        capturedCount: captures.length,
        savedCount: captures.length,
        status: warnings.length ? "warning" : "ok"
      }]
    }
  };
}

async function saveShokzNavigationCapture(client, outputPath, viewport, state, context) {
  await prepareShokzNavigationRelatedScreenshot(client, state, viewport);
  let current = await readShokzNavigationSnapshotState(client, state);
  if (!current.ok) {
    await restoreShokzNavigationHover(client, state, viewport);
    await sleep(700);
    current = await readShokzNavigationSnapshotState(client, state);
  }
  if (!current.ok) {
    context.warnings.push({
      sectionKey: "navigation",
      sectionLabel: "Navigation",
      stateLabel: state.stateLabel,
      message: current.reason || `Could not read navigation state ${state.stateLabel}.`
    });
    return false;
  }

  const cleanup = await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 4, hideOnly: true });
  if (!cleanup.ok) {
    context.warnings.push({
      sectionKey: "navigation",
      sectionLabel: "Navigation",
      stateLabel: state.stateLabel,
      message: `Known popup remained before screenshot: ${formatKnownPopupRemaining(cleanup)}.`
    });
    return false;
  }
  await restoreShokzNavigationHover(client, state, viewport);
  current = await readShokzNavigationSnapshotState(client, state);
  if (!current.ok) {
    await restoreShokzNavigationHover(client, state, viewport);
    await sleep(700);
    current = await readShokzNavigationSnapshotState(client, state);
  }
  if (!current.ok) {
    context.warnings.push({
      sectionKey: "navigation",
      sectionLabel: "Navigation",
      stateLabel: state.stateLabel,
      message: current.reason || `Could not read navigation state ${state.stateLabel} after popup cleanup.`
    });
    return false;
  }

  const finalCleanup = await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 5, hideOnly: true });
  if (!finalCleanup.ok) {
    context.warnings.push({
      sectionKey: "navigation",
      sectionLabel: "Navigation",
      stateLabel: state.stateLabel,
      message: `Known popup remained immediately before screenshot: ${formatKnownPopupRemaining(finalCleanup)}.`
    });
    return false;
  }
  if ((finalCleanup.hidden.length || finalCleanup.clicked.length) && (state.hoverPoint || state.hoverItemRect)) {
    await restoreShokzNavigationHover(client, state, viewport);
  }

  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true
  });
  const buffer = Buffer.from(screenshot.data, "base64");
  const visualSignature = hashBuffer(buffer);
  const visualHash = visualHashForBuffer(buffer);
  const visualAudit = visualAuditForBuffer(buffer, visualHash);
  const mainDuplicate = Boolean(
    state.skipMainDuplicate &&
    context.mainSeed?.visualHash &&
    visualHashDistance(visualHash, context.mainSeed.visualHash) <= 2
  );

  if (context.seenVisual.has(visualSignature) || mainDuplicate) {
    context.warnings.push({
      sectionKey: "navigation",
      sectionLabel: "Navigation",
      stateLabel: state.stateLabel,
      message: `${state.stateLabel} looked duplicated and was not saved.`
    });
    return false;
  }

  context.seenVisual.add(visualSignature);
  const relatedOutput = relatedOutputPath(outputPath, "navigation", state.fileId);
  await fs.writeFile(relatedOutput, buffer);
  const imageSize = pngSizeForBuffer(buffer, viewport);
  const stateIndex = context.captures.length + 1;
  const capture = {
    outputPath: relatedOutput,
    width: imageSize.width,
    height: imageSize.height,
    kind: `navigation-${state.navigationLevel}`,
    sectionKey: "navigation",
    sectionLabel: "Navigation",
    sectionTitle: "Navigation hierarchy",
    stateIndex,
    stateCount: null,
    stateLabel: state.stateLabel,
    label: state.stateLabel,
    tabLabel: state.tabLabel,
    tabIndex: state.tabIndex,
    pageIndex: null,
    interactionState: "hover",
    navigationLevel: state.navigationLevel,
    topLevelLabel: state.topLevelLabel,
    topLevelIndex: state.topLevelIndex,
    hoverItemKey: state.hoverItemKey,
    hoverItemLabel: state.hoverItemLabel,
    hoverItemRect: current.hoverItemRect || state.hoverItemRect || null,
    basePageIndex: null,
    hoverIndex: state.hoverIndex,
    trackLabel: state.tabLabel,
    trackIndex: state.tabIndex,
    itemCount: current.itemCount || null,
    visibleItemCount: current.visibleItemCount || null,
    visibleItems: current.visibleItems || null,
    itemRects: current.itemRects || null,
    windowSignature: current.panelSignature || null,
    logicalSignature: `navigation|top:${state.topLevelIndex}|${state.navigationLevel}|${state.hoverItemKey}`,
    visualSignature,
    visualHash,
    visualAudit,
    clip: {
      x: 0,
      y: 0,
      width: imageSize.width,
      height: imageSize.height
    },
    isDefaultState: false,
    sectionState: {
      text: current.text || "",
      textBlocks: current.textBlocks || [],
      images: current.images || [],
      activeIndex: stateIndex,
      tabLabel: state.tabLabel,
      tabIndex: state.tabIndex,
      pageIndex: null,
      interactionState: "hover",
      navigationLevel: state.navigationLevel,
      topLevelLabel: state.topLevelLabel,
      topLevelIndex: state.topLevelIndex,
      hoverItemKey: state.hoverItemKey,
      hoverItemLabel: state.hoverItemLabel,
      hoverItemRect: current.hoverItemRect || state.hoverItemRect || null,
      hoverIndex: state.hoverIndex,
      trackLabel: state.tabLabel,
      trackIndex: state.tabIndex,
      visibleItemCount: current.visibleItemCount || null,
      visibleItems: current.visibleItems || null,
      itemRects: current.itemRects || null,
      windowSignature: current.panelSignature || null
    }
  };
  context.captures.push(capture);
  return true;
}

async function prepareForScreenshotCapture(client, options = {}) {
  const cleanShokzKnownPopups = Boolean(options.shokzKnownPopups || options.shokzMarketing);
  if (cleanShokzKnownPopups) {
    const cleanup = await dismissShokzKnownPopupsBeforeScreenshot(client, {
      rounds: Math.max(3, options.rounds || 2),
      hideOnly: Boolean(options.hideOnly)
    });
    if (!cleanup.ok) {
      throw new Error(`Known popup remained ${options.stage || "before screenshot capture"}: ${formatKnownPopupRemaining(cleanup)}.`);
    }
  }
  if (options.dismissObstructions !== false && !options.hideOnly && !cleanShokzKnownPopups) {
    await dismissObstructions(client, { rounds: options.rounds || 2 });
  }
  if (options.guardSearchOverlay) {
    await ensureShokzSearchOverlayClosed(client, options.stage || "before screenshot capture");
  }
}

function formatKnownPopupRemaining(cleanup) {
  const remaining = Array.isArray(cleanup?.remaining) ? cleanup.remaining : [];
  if (!remaining.length) {
    return (cleanup?.remainingKinds || []).join(", ") || "unknown";
  }
  return remaining
    .slice(0, 4)
    .map((item) => {
      const rect = item.rect
        ? `@${item.rect.left},${item.rect.top} ${item.rect.width}x${item.rect.height}`
        : "";
      const text = item.text ? ` "${String(item.text).slice(0, 80)}"` : "";
      return `${item.kind || "unknown"}${rect}${text}`;
    })
    .join("; ");
}

async function prepareShokzNavigationMainScreenshot(client, viewport) {
  let cleanup = await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 4, hideOnly: true });
  if (!cleanup.ok) {
    throw new Error(`Known popup remained before Shokz navigation screenshot: ${formatKnownPopupRemaining(cleanup)}.`);
  }
  const state = await waitForShokzProductsNavigation(client, Boolean(viewport.mobile));
  if (!state.ok) {
    await openShokzProductsNavigation(client, viewport);
  }
  cleanup = await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 4, hideOnly: true });
  if (!cleanup.ok) {
    throw new Error(`Known popup remained before Shokz navigation screenshot: ${formatKnownPopupRemaining(cleanup)}.`);
  }
  const finalState = await waitForShokzProductsNavigation(client, Boolean(viewport.mobile));
  if (!finalState.ok) {
    await openShokzProductsNavigation(client, viewport);
  }
  await sleep(250);
  cleanup = await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 5, hideOnly: true });
  if (!cleanup.ok) {
    throw new Error(`Known popup remained immediately before Shokz navigation screenshot: ${formatKnownPopupRemaining(cleanup)}.`);
  }
}

async function prepareShokzNavigationRelatedScreenshot(client, state, viewport) {
  await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 4, hideOnly: true });
  await restoreShokzNavigationHover(client, state, viewport);
}

async function restoreShokzNavigationHover(client, state, viewport = null) {
  if (state.navigationLevel === "secondary" && isProductsNavigationLabel(state.topLevelLabel || state.tabLabel) && state.hoverItemLabel) {
    await hoverShokzTopNavigationLabel(client, "Products");
    const activated = await hoverShokzProductsSecondaryLabel(client, state.hoverItemLabel);
    if (activated?.ok) {
      return;
    }
    if (viewport) {
      await openShokzProductsNavigation(client, viewport);
      const openedActivation = await hoverShokzProductsSecondaryLabel(client, state.hoverItemLabel);
      if (openedActivation?.ok) {
        return;
      }
    }
  }
  if (state.navigationLevel === "primary" && state.hoverItemLabel) {
    const activated = await hoverShokzTopNavigationLabel(client, state.hoverItemLabel);
    if (activated?.ok) {
      return;
    }
  }
  const hoverPoint = state.hoverPoint || pointFromRect(state.hoverItemRect);
  if (hoverPoint) {
    await hoverShokzNavigationPoint(client, hoverPoint);
    await sleep(650);
    await primeLazyImages(client);
  }
}

async function hoverShokzTopNavigationLabel(client, label) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 4,
    y: 4,
    button: "none"
  }).catch(() => null);
  await sleep(160);
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const targetLabel = ${JSON.stringify(label)};
      const comparable = (value) => String(value || "")
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]+/g, "");
      const targetKey = comparable(targetLabel);
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
      const compactRepeatedLabel = (value) => {
        const clean = String(value || "").replace(/\\s+/g, " ").trim();
        const words = clean.split(" ").filter(Boolean);
        if (words.length && words.length % 2 === 0) {
          const midpoint = words.length / 2;
          const left = words.slice(0, midpoint).join(" ");
          const right = words.slice(midpoint).join(" ");
          if (left === right) return left;
        }
        return clean;
      };
      const candidates = Array.from(document.querySelectorAll("header a, header button, header summary, nav a, nav button, nav summary, a, button, summary"))
        .filter(visible)
        .map((element) => ({ element, text: compactRepeatedLabel(textOf(element)), rect: element.getBoundingClientRect() }))
        .filter((item) =>
          comparable(item.text) === targetKey &&
          item.rect.top >= 32 &&
          item.rect.top < Math.max(150, window.innerHeight * 0.22) &&
          item.rect.left > 80 &&
          item.rect.left < window.innerWidth - 180 &&
          item.rect.width >= 36 &&
          item.rect.width <= 240 &&
          item.rect.height >= 14 &&
          item.rect.height <= 110
        )
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
      const target = candidates[0]?.element;
      if (!target) {
        return { ok: false, reason: "top navigation label not found" };
      }
      const rect = target.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const targets = [target, target.parentElement, target.closest("li"), target.closest("nav"), target.closest("header")].filter(Boolean);
      for (const element of targets) {
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
  }).catch(() => ({ result: { value: { ok: false } } }));
  const value = result.result?.value || {};
  if (!value.ok) {
    return value;
  }
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: value.x,
    y: value.y,
    button: "none"
  });
  await sleep(900);
  await primeLazyImages(client);
  return value;
}

async function hoverShokzProductsSecondaryLabel(client, label) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const targetLabel = ${JSON.stringify(label)};
      const comparable = (value) => String(value || "")
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]+/g, "");
      const targetKey = comparable(targetLabel);
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const directText = (element) => Array.from(element.childNodes || [])
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join(" ")
        .replace(/\\s+/g, " ")
        .trim();
      const textOf = (element) => element ? [
        directText(element),
        element.innerText || element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim() : "";
      const roots = Array.from(document.querySelectorAll([
        ".mega-menu__content .left-wrapper",
        ".product_mega_menu .left-wrapper",
        ".product_mega_menu-wrapper .left-wrapper",
        "[class*='mega'] [class*='left']"
      ].join(","))).filter(visible);
      const candidates = [];
      for (const root of roots) {
        for (const element of Array.from(root.querySelectorAll(".ga4-pc-nav-title, a, button, [role='button'], div, span"))) {
          if (!visible(element)) continue;
          const text = directText(element) || (element.children.length <= 1 ? textOf(element) : "");
          if (comparable(text) !== targetKey) continue;
          const rect = element.getBoundingClientRect();
          if (rect.width < 36 || rect.height < 14 || rect.height > 90) continue;
          candidates.push({ element, rect, text });
        }
      }
      candidates.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
      const target = candidates[0]?.element;
      if (!target) {
        return { ok: false, reason: "secondary label not found" };
      }
      const rect = target.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const targets = [target, target.parentElement, target.closest("a, button, [role='button'], li, div"), target.closest(".left-wrapper")].filter(Boolean);
      for (const element of targets) {
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
  }).catch(() => ({ result: { value: { ok: false } } }));
  const value = result.result?.value || {};
  if (!value.ok) {
    return value;
  }
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: value.x,
    y: value.y,
    button: "none"
  });
  await sleep(650);
  await primeLazyImages(client);
  return value;
}

function pointFromRect(rect) {
  if (!rect) {
    return null;
  }
  const left = Number(rect.left ?? rect.x);
  const top = Number(rect.top ?? rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![left, top, width, height].every(Number.isFinite)) {
    return null;
  }
  return {
    x: Math.round(left + width / 2),
    y: Math.round(top + height / 2)
  };
}

async function readShokzNavigationTopLevelItems(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const topLabels = ["Products", "Support", "Technology", "About Us"];
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const comparable = (value) => String(value || "")
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]+/g, "");
      const directText = (element) => Array.from(element.childNodes || [])
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join(" ")
        .replace(/\\s+/g, " ")
        .trim();
      const compactRepeatedLabel = (value) => {
        const clean = String(value || "").replace(/\\s+/g, " ").trim();
        const words = clean.split(" ").filter(Boolean);
        if (words.length && words.length % 2 === 0) {
          const midpoint = words.length / 2;
          const left = words.slice(0, midpoint).join(" ");
          const right = words.slice(midpoint).join(" ");
          if (left === right) return left;
        }
        return clean;
      };
      const textOf = (element) => element ? [
        directText(element),
        element.innerText || element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim() : "";
      const labelFor = (text) => {
        const normalized = comparable(text);
        return topLabels.find((label) => {
          const target = comparable(label);
          return normalized === target || normalized.startsWith(target);
        }) || "";
      };
      const candidates = Array.from(document.querySelectorAll([
        "header a",
        "header button",
        "header summary",
        "header [role='button']",
        "header li",
        "nav a",
        "nav button",
        "nav summary",
        "nav [role='button']",
        "nav li"
      ].join(",")))
        .filter(visible)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = textOf(element).slice(0, 260);
          const primaryText = directText(element) || text;
          const label = labelFor(primaryText);
          const topContext = textOf(element.closest?.("header, nav")).slice(0, 500);
          const exactText = comparable(primaryText) === comparable(label);
          return {
            element,
            label,
            text,
            exactText,
            inHeader: Boolean(element.closest?.("header")),
            inNav: Boolean(element.closest?.("nav")),
            rect: {
              top: rect.top,
              left: rect.left,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height
            },
            topContext
          };
        })
        .filter((item) =>
          item.label &&
          item.rect.top >= 34 &&
          item.rect.top < Math.max(150, window.innerHeight * 0.22) &&
          item.rect.left > 80 &&
          item.rect.left < window.innerWidth - 180 &&
          item.rect.width >= 36 &&
          item.rect.width <= 240 &&
          item.rect.height >= 14 &&
          item.rect.height <= 110 &&
          !/learn more|search|account|cart|sign in/i.test(item.text)
        )
        .map((item) => ({
          ...item,
          score:
            (item.exactText ? 20 : 0) +
            (item.inNav ? 8 : 0) +
            (item.inHeader ? 4 : 0) +
            (item.topContext && topLabels.every((label) => item.topContext.includes(label)) ? 4 : 0) -
            Math.abs(item.rect.top - 76) / 20
        }))
        .sort((a, b) => b.score - a.score || a.rect.top - b.rect.top || a.rect.left - b.rect.left);
      const best = new Map();
      for (const item of candidates) {
        if (!best.has(item.label)) {
          best.set(item.label, item);
        }
      }
      const items = [...best.values()]
        .sort((a, b) => a.rect.left - b.rect.left)
        .map((item, index) => ({
          index: index + 1,
          key: "top:" + (index + 1),
          label: item.label,
          text: item.text,
          rect: item.rect,
          hoverPoint: {
            x: Math.round(item.rect.left + item.rect.width / 2),
            y: Math.round(item.rect.top + item.rect.height / 2)
          }
        }));
      if (!items.length) {
        const visibleTop = Array.from(document.querySelectorAll("header a, header button, header summary, nav a, nav button, nav summary"))
          .filter(visible)
          .slice(0, 16)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return textOf(element).slice(0, 60) + " @ " + Math.round(rect.left) + "," + Math.round(rect.top);
          });
        return { ok: false, reason: "Top navigation candidates not found: " + visibleTop.join(" | ") };
      }
      return { ok: true, items };
    })()`,
    returnByValue: true
  }).catch(() => ({ result: { value: { ok: false, reason: "Could not read top navigation items." } } }));
  return result.result?.value || { ok: false, reason: "Could not read top navigation items." };
}

async function readShokzProductsNavigationCategoryItems(client, topItem) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const topItem = ${JSON.stringify(topItem)};
      const allowedLabels = ${JSON.stringify(shokzProductsNavigationCategoryLabels)};
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const comparable = (value) => String(value || "")
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]+/g, "");
      const allowedComparables = new Set(allowedLabels.map(comparable));
      const directText = (element) => Array.from(element.childNodes || [])
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join(" ")
        .replace(/\\s+/g, " ")
        .trim();
      const compactRepeatedLabel = (value) => {
        const clean = String(value || "").replace(/\\s+/g, " ").trim();
        const words = clean.split(" ").filter(Boolean);
        if (words.length && words.length % 2 === 0) {
          const midpoint = words.length / 2;
          const left = words.slice(0, midpoint).join(" ");
          const right = words.slice(midpoint).join(" ");
          if (left === right) return left;
        }
        return clean;
      };
      const textOf = (element) => element ? [
        directText(element),
        element.innerText || element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim() : "";
      const rectOf = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height
        };
      };
      const roots = Array.from(document.querySelectorAll([
        ".mega-menu__content .left-wrapper",
        ".product_mega_menu .left-wrapper",
        ".product_mega_menu-wrapper .left-wrapper",
        "[class*='mega'] [class*='left']"
      ].join(","))).filter(visible);
      const root = roots
        .map((element) => ({ element, rect: rectOf(element), text: textOf(element) }))
        .filter((item) =>
          item.text.length > 20 &&
          item.rect.top >= 90 &&
          item.rect.height >= 180 &&
          item.rect.width >= 160 &&
          allowedLabels.some((label) => comparable(item.text).includes(comparable(label)))
        )
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0];
      if (!root) {
        return { ok: true, items: [] };
      }
      const rejectText = /product$|compare products|all products|shop now|learn more|view all|search|account|cart|close|feedback/i;
      const raw = Array.from(root.element.querySelectorAll(".ga4-pc-nav-title, a, button, [role='button'], div, span"))
        .filter(visible)
        .map((element) => {
          const rect = rectOf(element);
          const label = compactRepeatedLabel(directText(element) || (element.children.length <= 1 ? textOf(element) : ""));
          return { element, label, rect };
        })
        .filter((item) => {
          const normalized = comparable(item.label);
          return normalized.length >= 3 &&
            item.label.length <= 72 &&
            item.rect.top >= root.rect.top + 20 &&
            item.rect.bottom <= root.rect.bottom + 12 &&
            item.rect.left >= root.rect.left - 4 &&
            item.rect.right <= root.rect.right + 4 &&
            item.rect.width >= 36 &&
            item.rect.height >= 14 &&
            item.rect.height <= 80 &&
            allowedComparables.has(normalized) &&
            !rejectText.test(item.label);
        })
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
      const byLabel = new Map();
      for (const item of raw) {
        const key = comparable(item.label);
        if (!byLabel.has(key)) {
          byLabel.set(key, item);
        }
      }
      const items = allowedLabels
        .map((label, index) => {
          const item = byLabel.get(comparable(label));
          if (!item) return null;
          return {
            index: index + 1,
            key: "secondary:" + topItem.index + ":" + (index + 1),
            label,
            text: item.label,
            rect: item.rect,
            hoverPoint: {
              x: Math.round(item.rect.left + item.rect.width / 2),
              y: Math.round(item.rect.top + item.rect.height / 2)
            }
          };
        })
        .filter(Boolean);
      return {
        ok: true,
        panelRect: root.rect,
        items
      };
    })()`,
    returnByValue: true
  }).catch(() => ({ result: { value: { ok: false, reason: "Could not read Products secondary navigation items." } } }));
  return result.result?.value || { ok: false, reason: "Could not read Products secondary navigation items." };
}

async function readShokzNavigationSecondaryItems(client, topItem) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const topItem = ${JSON.stringify(topItem)};
      const topLabels = ["Products", "Support", "Technology", "About Us"];
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const comparable = (value) => String(value || "")
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]+/g, "");
      const directText = (element) => Array.from(element.childNodes || [])
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join(" ")
        .replace(/\\s+/g, " ")
        .trim();
      const compactRepeatedLabel = (value) => {
        const clean = String(value || "").replace(/\\s+/g, " ").trim();
        const words = clean.split(" ").filter(Boolean);
        if (words.length && words.length % 2 === 0) {
          const midpoint = words.length / 2;
          const left = words.slice(0, midpoint).join(" ");
          const right = words.slice(midpoint).join(" ");
          if (left === right) return left;
        }
        return clean;
      };
      const textOf = (element) => element ? [
        directText(element),
        element.innerText || element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim() : "";
      const rectOf = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height
        };
      };
      const findPanel = () => {
        const candidates = Array.from(document.querySelectorAll("body *"))
          .filter(visible)
          .map((element) => {
            const rect = rectOf(element);
            const style = getComputedStyle(element);
            const text = textOf(element);
            const topHit = comparable(text).includes(comparable(topItem.label));
            const categoryHits = [
              "Sports Headphones",
              "Workout & Lifestyle Earbuds",
              "Communication Headsets",
              "Accessories",
              "Refurbished",
              "Warranty",
              "Contact Us",
              "Support",
              "Technology",
              "About Us"
            ].filter((label) => comparable(text).includes(comparable(label))).length;
            const positioned = ["fixed", "absolute", "sticky"].includes(style.position) ||
              (Number.parseInt(style.zIndex, 10) || 0) >= 10;
            return {
              element,
              text,
              rect,
              explicitPanel,
              score:
                Number(topHit) * 4 +
                categoryHits * 3 +
                Number(positioned) * 2 +
                Math.min(rect.width / Math.max(1, window.innerWidth), 1) * 4 +
                Math.min(rect.height / Math.max(1, window.innerHeight), 1) * 2
            };
          })
          .filter((item) =>
            item.text.length > 16 &&
            item.text.length < 12000 &&
            item.rect.top >= 70 &&
            item.rect.top < Math.max(280, window.innerHeight * 0.35) &&
            item.rect.height >= 80 &&
            item.rect.width >= Math.min(360, window.innerWidth * 0.35) &&
            item.rect.left < window.innerWidth * 0.8 &&
            item.rect.right > window.innerWidth * 0.2 &&
            !/^Mother.?s Day Sale/i.test(item.text) &&
            !/Don.?t Miss Out|email address|Subscribe Now|Privacy Policy|Giveaway Terms/i.test(item.text) &&
            !/^Feedback$/i.test(item.text)
          )
          .sort((a, b) => b.score - a.score || (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
        return candidates[0] || null;
      };
      const panel = findPanel();
      if (!panel) {
        return { ok: true, items: [] };
      }
      const rejectText = /shop now|learn more|compare products|all products|view all|search|account|cart|close|feedback|subscribe now|privacy policy|giveaway terms/i;
      const productCardText = /OPENRUN|OPENSWIM|OPENMOVE|OPENFIT|Bone Conduction|Premium Sound|Budget-Friendly|Flagship/i;
      const topComparables = new Set(topLabels.map(comparable));
      const raw = Array.from(panel.element.querySelectorAll("a, button, [role='button'], summary, li, div, span, p"))
        .filter(visible)
        .map((element) => {
          const rect = rectOf(element);
          const text = textOf(element).slice(0, 220);
          const label = compactRepeatedLabel(directText(element) || (element.children.length <= 2 ? text : ""));
          return { element, label, text, rect };
        })
        .filter((item) => {
          const normalized = comparable(item.label);
          const inPanel = item.rect.top >= Math.max(105, panel.rect.top + 8) &&
            item.rect.bottom <= Math.min(window.innerHeight + 40, panel.rect.bottom + 40) &&
            item.rect.left >= Math.max(0, panel.rect.left - 6) &&
            item.rect.right <= Math.min(window.innerWidth + 6, panel.rect.right + 6);
          return inPanel &&
            normalized.length >= 3 &&
            item.label.length <= 72 &&
            item.rect.width >= 36 &&
            item.rect.height >= 14 &&
            item.rect.height <= 110 &&
            !topComparables.has(normalized) &&
            !rejectText.test(item.label) &&
            !productCardText.test(item.text);
        })
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
      const seen = new Set();
      const items = [];
      for (const item of raw) {
        const key = comparable(item.label);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          index: items.length + 1,
          key: "secondary:" + topItem.index + ":" + (items.length + 1),
          label: item.label,
          text: item.text,
          rect: item.rect,
          hoverPoint: {
            x: Math.round(item.rect.left + item.rect.width / 2),
            y: Math.round(item.rect.top + item.rect.height / 2)
          }
        });
      }
      return {
        ok: true,
        panelRect: panel.rect,
        items: items.slice(0, 12)
      };
    })()`,
    returnByValue: true
  }).catch(() => ({ result: { value: { ok: false, reason: "Could not read secondary navigation items." } } }));
  return result.result?.value || { ok: false, reason: "Could not read secondary navigation items." };
}

async function readShokzNavigationSnapshotState(client, state) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const state = ${JSON.stringify(state)};
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const comparable = (value) => String(value || "")
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]+/g, "");
      const directText = (element) => Array.from(element.childNodes || [])
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join(" ")
        .replace(/\\s+/g, " ")
        .trim();
      const textOf = (element) => element ? [
        directText(element),
        element.innerText || element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim() : "";
      const rectOf = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      };
      const findPanel = () => {
        const candidates = Array.from(document.querySelectorAll("body *"))
          .filter(visible)
          .map((element) => {
            const rect = rectOf(element);
            const style = getComputedStyle(element);
            const text = textOf(element).slice(0, 12000);
            const explicitPanel = element.matches([
              "#menu-drawer",
              ".menu-drawer",
              ".mega-menu__content",
              ".product_mega_menu",
              ".product_mega_menu-wrapper",
              "[class*='mega']",
              "[class*='menu-drawer']"
            ].join(","));
            const topHit = comparable(text).includes(comparable(state.topLevelLabel));
            const itemHit = comparable(text).includes(comparable(state.hoverItemLabel));
            const categoryHits = [
              "Sports Headphones",
              "Workout & Lifestyle Earbuds",
              "Communication Headsets",
              "Accessories",
              "Refurbished",
              "Support",
              "Technology",
              "About Us",
              "OPENRUN",
              "OPENSWIM",
              "OPENFIT"
            ].filter((label) => comparable(text).includes(comparable(label))).length;
            const positioned = ["fixed", "absolute", "sticky"].includes(style.position) ||
              (Number.parseInt(style.zIndex, 10) || 0) >= 10;
            return {
              element,
              text,
              rect,
              score:
                Number(topHit) * 4 +
                Number(itemHit) * 4 +
                categoryHits * 3 +
                Number(explicitPanel) * 10 +
                Number(positioned) * 2 +
                Math.min(rect.width / Math.max(1, window.innerWidth), 1) * 4 +
                Math.min(rect.height / Math.max(1, window.innerHeight), 1) * 2
            };
          })
          .filter((item) =>
            item.text.length > 16 &&
            item.text.length <= 12000 &&
            (item.rect.top >= 70 || item.explicitPanel) &&
            item.rect.top < Math.max(280, window.innerHeight * 0.35) &&
            item.rect.height >= 80 &&
            item.rect.width >= Math.min(220, window.innerWidth * 0.2) &&
            item.rect.left < window.innerWidth * 0.8 &&
            item.rect.right > window.innerWidth * 0.2 &&
            !/^Mother.?s Day Sale/i.test(item.text) &&
            !/Don.?t Miss Out|email address|Subscribe Now|Privacy Policy|Giveaway Terms/i.test(item.text) &&
            !/^Feedback$/i.test(item.text)
          )
          .sort((a, b) => b.score - a.score || (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
        if (candidates[0]) {
          return candidates[0];
        }
        return null;
      };
      const panel = findPanel();
      if (!panel) {
        return { ok: false, reason: "No visible navigation panel was found." };
      }
      const text = panel.text.replace(/\\s+/g, " ").trim();
      const textBlocks = [];
      const seenBlocks = new Set();
      for (const element of Array.from(panel.element.querySelectorAll("h1, h2, h3, h4, p, a, button, span, li"))) {
        if (!visible(element)) continue;
        const rect = rectOf(element);
        if (
          rect.top < Math.max(80, panel.rect.top - 4) ||
          rect.left < Math.max(0, panel.rect.left - 4) ||
          rect.right > Math.min(window.innerWidth + 4, panel.rect.right + 4)
        ) {
          continue;
        }
        const blockText = (directText(element) || textOf(element)).replace(/\\s+/g, " ").trim();
        if (!blockText || blockText.length > 180) continue;
        const key = blockText + "|" + rect.x + "|" + rect.y + "|" + rect.width + "|" + rect.height;
        if (seenBlocks.has(key)) continue;
        seenBlocks.add(key);
        textBlocks.push({
          text: blockText,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        });
        if (textBlocks.length >= 80) break;
      }
      const images = Array.from(panel.element.querySelectorAll("img, picture img"))
        .filter(visible)
        .map((image) => ({
          src: image.currentSrc || image.src || "",
          alt: image.alt || "",
          rect: rectOf(image)
        }))
        .filter((image) => image.src)
        .slice(0, 60);
      const visibleItems = Array.from(panel.element.querySelectorAll("a, button, [role='button'], summary, li"))
        .filter(visible)
        .map((element, index) => {
          const rect = rectOf(element);
          const label = (directText(element) || textOf(element)).replace(/\\s+/g, " ").trim();
          return {
            key: comparable(label) || "item-" + index,
            label,
            text: label,
            rect
          };
        })
        .filter((item) =>
          item.label &&
          item.label.length <= 120 &&
          item.rect.top >= Math.max(90, panel.rect.top - 4) &&
          item.rect.bottom <= Math.min(window.innerHeight + 40, panel.rect.bottom + 40)
        )
        .slice(0, 80);
      const itemRects = visibleItems.map((item) => ({
        key: item.key,
        label: item.label,
        rect: item.rect
      }));
      return {
        ok: true,
        text,
        textBlocks,
        images,
        visibleItems,
        itemRects,
        itemCount: visibleItems.length,
        visibleItemCount: visibleItems.length,
        hoverItemRect: state.hoverItemRect || null,
        panelRect: panel.rect,
        panelSignature: comparable(text).slice(0, 240)
      };
    })()`,
    returnByValue: true
  }).catch(() => ({ result: { value: { ok: false, reason: "Could not read navigation state." } } }));
  return result.result?.value || { ok: false, reason: "Could not read navigation state." };
}

async function hoverShokzNavigationPoint(client, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return;
  }
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const x = ${Math.round(point.x)};
      const y = ${Math.round(point.y)};
      const start = document.elementFromPoint(x, y);
      const targets = [];
      let current = start;
      while (current && current instanceof Element && targets.length < 5) {
        targets.push(current);
        if (current.matches?.("a, button, [role='button'], li, summary, nav, header")) {
          const closest = current.closest?.("a, button, [role='button'], li, summary, nav, header");
          if (closest && !targets.includes(closest)) {
            targets.push(closest);
          }
        }
        current = current.parentElement;
      }
      for (const element of targets) {
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
      return { ok: Boolean(start), text: start?.innerText || start?.textContent || "" };
    })()`,
    returnByValue: true
  }).catch(() => null);
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: Math.round(point.x),
    y: Math.round(point.y),
    button: "none"
  });
}

async function visualSeedForFile(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    return {
      visualSignature: hashBuffer(buffer),
      visualHash: visualHashForBuffer(buffer)
    };
  } catch {
    return null;
  }
}

function pngSizeForBuffer(buffer, fallback) {
  try {
    const image = decodePng(buffer);
    return { width: image.width, height: image.height };
  } catch {
    return { width: fallback.width, height: fallback.height };
  }
}

function isProductsNavigationLabel(label) {
  return comparableNavigationLabel(label) === "products";
}

function comparableNavigationLabel(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
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
    await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 5 });
    await sleep(500);

    const state = await readShokzHomeBannerState(client, index);
    if (!state.ok) {
      throw new Error(state.reason || `Could not read Shokz banner ${index + 1} state.`);
    }

    const clip = normalizeBannerClip(state.clip, viewport);
    if (!clip) {
      throw new Error(`Could not compute a valid crop for Shokz banner ${index + 1}.`);
    }
    await sleep(150);
    await prepareForScreenshotCapture(client, {
      rounds: 2,
      shokzKnownPopups: true,
      stage: `before Shokz banner ${index + 1} screenshot capture`
    });

    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip
    });
    const buffer = Buffer.from(screenshot.data, "base64");
    const visualSignature = hashBuffer(buffer);
    const visualHash = visualHashForBuffer(buffer);
    const visualAudit = visualAuditForBuffer(buffer, visualHash);
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
      visualAudit,
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
  const plan = await readShokzHomeRelatedSectionPlan(client, definition, viewport);
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
    await clearRelatedHover(client);
    const useDirectState = definition.key === "scene-explore" && state.directClip;
    const skipActivation = useDirectState && !state.requiresActivation;
    const activation = skipActivation
      ? { ok: true }
      : await activateShokzHomeRelatedState(client, definition, state);
    await sleep(650);
    await waitForRelatedSectionImages(client, definition.key);
    await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 2 });
    if (activation?.hoverPoint) {
      await moveMouseToPoint(client, activation.hoverPoint);
      await waitForRelatedHoverSettled(client, definition, state);
      await suppressRelatedHoverDefaultLayer(client, definition, state);
      await sleep(120);
    }
    await sleep(180);

    const current = useDirectState
      ? directRelatedStateForCapture(state)
      : await readShokzHomeRelatedState(client, definition, state);
    if (!current.ok) {
      warnings.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        stateLabel: state.stateLabel,
        message: current.reason || `Could not read ${definition.sectionLabel} state.`
      });
      await clearRelatedHover(client);
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
      await clearRelatedHover(client);
      continue;
    }

    await prepareForScreenshotCapture(client, {
      rounds: 2,
      shokzKnownPopups: true,
      stage: `before Shokz ${definition.sectionLabel} screenshot capture`
    });
    if (activation?.hoverPoint) {
      await moveMouseToPoint(client, activation.hoverPoint);
      await waitForRelatedHoverSettled(client, definition, state);
      await sleep(120);
    }
    const finalCleanup = await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 5, hideOnly: Boolean(activation?.hoverPoint) });
    if (!finalCleanup.ok) {
      warnings.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        stateLabel: state.stateLabel,
        message: `Known popup remained immediately before ${definition.sectionLabel} screenshot: ${formatKnownPopupRemaining(finalCleanup)}.`
      });
      await clearRelatedHover(client);
      continue;
    }
    if ((finalCleanup.hidden.length || finalCleanup.clicked.length) && activation?.hoverPoint) {
      await moveMouseToPoint(client, activation.hoverPoint);
      await waitForRelatedHoverSettled(client, definition, state);
      await sleep(120);
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
        message: definition.key === "scene-explore" && state.directClip
          ? `${definition.sectionLabel} ${state.stateLabel} looked duplicated and was saved with a warning.`
          : `${definition.sectionLabel} ${state.stateLabel} looked duplicated and was not saved.`
      });
      if (!(definition.key === "scene-explore" && state.directClip)) {
        await clearRelatedHover(client);
        continue;
      }
    }

    const similar = nearestVisualHash(visualHash, seenHashes);
    const visualAudit = visualAuditForBuffer(buffer, visualHash, similar);
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
      interactionState: state.interactionState || "default",
      hoverItemKey: state.hoverItemKey || null,
      hoverItemLabel: state.hoverItemLabel || null,
      hoverItemRect: current.hoverItemRect || state.hoverItemRect || null,
      basePageIndex: state.basePageIndex || null,
      hoverIndex: state.hoverIndex || null,
      trackLabel: state.trackLabel || state.tabLabel || null,
      trackIndex: state.trackIndex || state.tabIndex || null,
      productCount: state.productCount || null,
      visibleProductCount: state.visibleProductCount || null,
      visibleProducts: state.visibleProducts || null,
      itemCount: state.itemCount || null,
      visibleItemCount: current.visibleItemCount || state.visibleItemCount || null,
      visibleItems: current.visibleItems || state.visibleItems || null,
      itemRects: current.itemRects || state.itemRects || null,
      windowSignature: state.windowSignature || null,
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
      isDefaultState: Boolean(state.isDefaultState),
      coverageKey: relatedCoverageKeyForState(state),
      sectionState: {
        text: current.text || "",
        textBlocks: current.textBlocks || [],
        images: current.images || [],
        activeIndex: current.activeIndex ?? state.stateIndex,
        tabLabel: state.tabLabel || null,
        tabIndex: state.tabIndex || null,
        pageIndex: state.pageIndex || null,
        interactionState: state.interactionState || "default",
        hoverItemKey: state.hoverItemKey || null,
        hoverItemLabel: state.hoverItemLabel || null,
        hoverItemRect: current.hoverItemRect || state.hoverItemRect || null,
        basePageIndex: state.basePageIndex || null,
        hoverIndex: state.hoverIndex || null,
        hoveredProduct: current.hoveredProduct || state.hoveredProduct || null,
        trackLabel: state.trackLabel || state.tabLabel || null,
        trackIndex: state.trackIndex || state.tabIndex || null,
        productCount: state.productCount || null,
        visibleProductCount: state.visibleProductCount || null,
        visibleProducts: state.visibleProducts || null,
        itemCount: state.itemCount || null,
        visibleItemCount: current.visibleItemCount || state.visibleItemCount || null,
        visibleItems: current.visibleItems || state.visibleItems || null,
        itemRects: current.itemRects || state.itemRects || null,
        windowSignature: state.windowSignature || null
      }
    });
    await clearRelatedHover(client);
  }

  warnings.push(...relatedSectionCoverageWarnings(definition, plan.states, captures));

  return {
    width: maxWidth,
    height: maxHeight,
    captures,
    warnings,
    expectedCount: plan.states.length,
    capturedCount: captures.length
  };
}

function relatedSectionCoverageWarnings(definition, plannedStates, captures) {
  const warnings = [];
  const expected = new Map();
  for (const state of plannedStates || []) {
    expected.set(relatedCoverageKeyForState(state), state);
  }

  const counts = new Map();
  for (const capture of captures || []) {
    const key = capture.coverageKey || relatedCoverageKeyForState(capture);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const missing = [...expected.entries()]
    .filter(([key]) => !counts.has(key))
    .map(([, state]) => state.stateLabel || state.label || state.fileId || state.logicalSignature)
    .filter(Boolean);
  const repeated = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => expected.get(key)?.stateLabel || key);

  if (missing.length) {
    warnings.push({
      sectionKey: definition.key,
      sectionLabel: definition.sectionLabel,
      message: `${definition.sectionLabel} missing planned screenshots: ${missing.join(", ")}.`
    });
  }
  if (repeated.length) {
    warnings.push({
      sectionKey: definition.key,
      sectionLabel: definition.sectionLabel,
      message: `${definition.sectionLabel} repeated planned screenshots: ${repeated.join(", ")}.`
    });
  }

  return warnings;
}

function relatedCoverageKeyForState(state) {
  return [
    state?.sectionKey || "",
    state?.tabIndex || state?.tabLabel || "",
    state?.interactionState || "default",
    state?.hoverItemKey || state?.hoverIndex || "",
    state?.pageIndex || state?.stateIndex || "",
    state?.fileId || state?.logicalSignature || state?.stateLabel || ""
  ].join("|");
}

function directRelatedStateForCapture(state) {
  const directItems = state.directItem ? [state.directItem] : state.visibleItems || null;
  return {
    ok: true,
    clip: state.directClip,
    text: state.text || "",
    textBlocks: state.textBlocks || [],
    images: state.images || [],
    logicalSignature: state.logicalSignature || state.fileId || state.stateLabel,
    activeIndex: state.stateIndex,
    visibleItemCount: Array.isArray(directItems) ? directItems.length : state.visibleItemCount || null,
    visibleItems: directItems,
    itemRects: Array.isArray(directItems)
      ? directItems.map((item) => ({
          sceneItemId: item.sceneItemId,
          key: item.key,
          label: item.label,
          rect: item.rect || null
        }))
      : state.itemRects || null,
    interactionState: state.interactionState || "default",
    hoverItemRect: state.hoverItemRect || null,
    hoveredProduct: state.hoveredProduct || null
  };
}

async function readShokzHomeRelatedSectionPlan(client, definition, viewport = {}) {
  const runtimeDefinition = {
    ...definition,
    captureHover: definition.key === "product-showcase" &&
      !viewport.mobile &&
      !viewport.touch
  };
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const definition = ${JSON.stringify(runtimeDefinition)};
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
      const productLabel = (card, text) => cleanText(
        card.querySelector("h1, h2, h3, h4, [class*='title'], [class*='name']")?.innerText ||
        String(text || "").split(/\\$|From\\b|\\d+\\.\\d{2}/i)[0] ||
        text,
        90
      );
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
            const label = productLabel(card, text);
            const clippedLeft = Math.max(rect.left, rootRect.left);
            const clippedTop = Math.max(rect.top, rootRect.top);
            const clippedRight = Math.min(rect.right, rootRect.right);
            const clippedBottom = Math.min(rect.bottom, rootRect.bottom);
            return {
              href,
              text,
              label,
              image,
              key: href || text,
              rect,
              rectRelative: {
                x: Math.round(Math.max(0, clippedLeft - rootRect.left)),
                y: Math.round(Math.max(0, clippedTop - rootRect.top)),
                width: Math.round(Math.max(0, clippedRight - clippedLeft)),
                height: Math.round(Math.max(0, clippedBottom - clippedTop))
              },
              hoverPoint: {
                x: Math.round(Math.max(2, Math.min(window.innerWidth - 2, centerX))),
                y: Math.round(Math.max(2, Math.min(window.innerHeight - 2, centerY)))
              },
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
            label: item.label,
            image: item.image,
            rect: item.rectRelative,
            hoverPoint: item.hoverPoint
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
      const scenePanel = (root) =>
        [root, ...root.querySelectorAll(".swiper, [class*='swiper']")]
          .filter((element) => visible(element) && element.querySelector(".swiper-slide, [class*='swiper-slide']"))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const text = textOf(element, 2400);
            const hits = (definition.anchors || []).filter((anchor) => text.includes(anchor)).length;
            const className = classText(element);
            const score = hits * 1000 +
              Number(/scene|swiper|carousel|slider/i.test(className)) * 80 +
              Math.min(rect.width * rect.height / 1000, 500);
            return { element, rect, score };
          })
          .sort((a, b) => b.score - a.score || b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0]?.element || root;
      const sceneImageFamily = (source) => {
        const first = String(source || "").split(",")[0].trim().split(/\s+/)[0];
        if (!first) return "";
        try {
          const url = new URL(first, window.location.href);
          return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "")
            .toLowerCase()
            .replace(/\.(avif|webp|png|jpe?g|gif|svg)$/i, "")
            .replace(/@[\dx]+$/i, "")
            .replace(/[-_]\d{2,5}w$/i, "")
            .replace(/[-_]\d+x\d+$/i, "")
            .replace(/^m[-_]/i, "")
            .replace(/[-_](mb|mobile|desktop|pc)$/i, "");
        } catch {
          return first.toLowerCase();
        }
      };
      const sceneTitle = (slide) => {
        const text = textOf(slide, 500);
        const anchor = (definition.anchors || []).find((item) => text.includes(item));
        return anchor || cleanText(slide.querySelector("h1, h2, h3, h4, [class*='title']")?.innerText || text, 120);
      };
      const sceneDescription = (slide, title) => {
        const text = textOf(slide, 500).replace(title || "", "").replace(/\bLearn More\b/ig, "").trim();
        return cleanText(slide.querySelector("p, [class*='desc'], [class*='content']")?.innerText || text, 160);
      };
      const sceneItems = (root, options = {}) => {
        const panel = scenePanel(root);
        const rootRect = root.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const rootCenterX = rootRect.left + rootRect.width / 2;
        const slides = Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide']"))
          .filter(visible)
          .map((slide, domIndex) => {
            const rect = slide.getBoundingClientRect();
            const area = Math.max(1, rect.width * rect.height);
            const visibleArea = intersects(rect, rootRect);
            const title = sceneTitle(slide);
            const description = sceneDescription(slide, title);
            const href = Array.from(slide.querySelectorAll("a[href]")).map(productHref).filter(Boolean)[0] || "";
            const image = imageSources(slide)[0] || "";
            const imageFamily = sceneImageFamily(image);
            const rawSlideIndex = Number(slide.getAttribute("data-swiper-slide-index"));
            const slideIndex = Number.isFinite(rawSlideIndex) ? rawSlideIndex : null;
            const anchorIndex = (definition.anchors || []).indexOf(title);
            const position = slidePosition(slide);
            const order = anchorIndex >= 0
              ? anchorIndex
              : (Number.isFinite(slideIndex) ? slideIndex : (Number(position.index) || domIndex));
            const key = [
              title || "",
              href ? "href:" + href : "",
              imageFamily ? "img:" + imageFamily : "",
              !title && !href && !imageFamily ? "dom:" + order : ""
            ].filter(Boolean).join("|");
            const clippedLeft = Math.max(rect.left, rootRect.left);
            const clippedTop = Math.max(rect.top, rootRect.top);
            const clippedRight = Math.min(rect.right, rootRect.right);
            const clippedBottom = Math.min(rect.bottom, rootRect.bottom);
            const centerX = rect.left + rect.width / 2;
            const absoluteClip = {
              x: Math.max(0, Math.round(rect.left + window.scrollX)),
              y: Math.max(0, Math.round(rect.top + window.scrollY)),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            };
            const activeScore = Number(/swiper-slide-active|active|current/i.test(classText(slide))) * 10000 +
              visibleArea -
              Math.abs(centerX - rootCenterX) * 3;
            return {
              sceneItemId: key,
              key,
              label: title || "场景 " + (order + 1),
              title,
              description,
              href,
              image,
              imageFamily,
              slideIndex,
              order,
              rect,
              visibleArea,
              visibleRatio: visibleArea / area,
              centerY: rect.top + rect.height / 2,
              activeScore,
              rectRelative: {
                x: Math.round(Math.max(0, clippedLeft - rootRect.left)),
                y: Math.round(Math.max(0, clippedTop - rootRect.top)),
                width: Math.round(Math.max(0, clippedRight - clippedLeft)),
                height: Math.round(Math.max(0, clippedBottom - clippedTop))
              },
              directClip: absoluteClip
            };
          })
          .filter((item) =>
            item.key &&
            item.rect.width >= 180 &&
            item.rect.height >= 120 &&
            item.centerY >= panelRect.top - 40 &&
            item.centerY <= panelRect.bottom + 40 &&
            (!options.visibleOnly || (
              item.visibleArea > 600 &&
              item.visibleRatio >= 0.2 &&
              item.rect.right > rootRect.left + 12 &&
              item.rect.left < rootRect.right - 12
            ))
          );
        const bestByKey = new Map();
        for (const item of slides) {
          const existing = bestByKey.get(item.key);
          if (!existing || item.activeScore > existing.activeScore || item.visibleArea > existing.visibleArea) {
            bestByKey.set(item.key, item);
          }
        }
        return [...bestByKey.values()]
          .sort((a, b) => a.order - b.order || a.rect.left - b.rect.left)
          .map((item) => ({
            sceneItemId: item.sceneItemId,
            key: item.key,
            label: item.label,
            title: item.title,
            description: item.description,
            href: item.href,
            image: item.image,
            imageFamily: item.imageFamily,
            slideIndex: item.slideIndex,
            order: item.order,
            rect: item.rectRelative,
            directClip: item.directClip,
            activeScore: item.activeScore
          }));
      };
      const sceneActiveItem = (root) =>
        sceneItems(root, { visibleOnly: true })
          .sort((a, b) => b.activeScore - a.activeScore || a.order - b.order)[0] || null;
      const sceneWindowSignature = (root) => {
        const active = sceneActiveItem(root);
        const items = sceneItems(root, { visibleOnly: true });
        return active && items.length ? JSON.stringify({
          active: active.key,
          visible: items.map((item) => item.key)
        }) : "";
      };
      const sceneExpectedItems = (root, allItems) => {
        const anchors = (definition.anchors || []).map((anchor) => cleanText(anchor, 180)).filter(Boolean);
        if (!anchors.length) {
          return allItems;
        }
        const baseClip = allItems.find((item) => item.directClip)?.directClip || null;
        const used = new Set();
        return anchors.map((anchor, index) => {
          const normalizedAnchor = anchor.toLowerCase();
          const match = allItems.find((item) => {
            if (used.has(item.key)) return false;
            const text = cleanText([
              item.title,
              item.label,
              item.description,
              item.href,
              item.imageFamily
            ].filter(Boolean).join(" "), 500).toLowerCase();
            return Boolean(text) && (text.includes(normalizedAnchor) || normalizedAnchor.includes(text));
          });
          if (match) {
            used.add(match.key);
            return {
              ...match,
              expectedAnchor: anchor,
              expectedIndex: index
            };
          }
          return {
            sceneItemId: "anchor:" + anchor,
            key: "anchor:" + anchor,
            label: anchor,
            title: anchor,
            description: "",
            href: "",
            image: "",
            imageFamily: "",
            slideIndex: null,
            order: index,
            rect: null,
            directClip: baseClip ? { ...baseClip } : null,
            requiresActivation: Boolean(baseClip),
            forceIndex: index,
            activeScore: 0,
            expectedAnchor: anchor,
            expectedIndex: index
          };
        });
      };
      const mediaTrackDefinitions = [
        {
          key: "pioneer",
          label: "Shokz | Open-Ear Audio Pioneer",
          selector: ".co-number-swiper",
          rootSelector: ".co-number-box-banner, section, .shopify-section"
        },
        {
          key: "awards",
          label: "Sports partnership & Awards",
          selector: ".co-brand-swiper-left",
          rootSelector: ".co-brand-box"
        },
        {
          key: "reviews",
          label: "Media Reviews",
          selector: ".co-brand-swiper-right",
          rootSelector: ".co-brand-box"
        }
      ];
      const mediaTrackForLabel = (label) =>
        mediaTrackDefinitions.find((track) => track.label === label) || null;
      const mediaTrackPanel = (track) => track ? document.querySelector(track.selector) : null;
      const mediaTrackRoot = (track) => {
        const panel = mediaTrackPanel(track);
        return panel?.closest(track.rootSelector) || panel;
      };
      const firstImageSource = (element) => imageSources(element)[0] || "";
      const mediaImageFamily = (source) => {
        const first = String(source || "").split(",")[0].trim().split(/\\s+/)[0];
        if (!first) return "";
        try {
          const url = new URL(first, window.location.href);
          return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "")
            .toLowerCase()
            .replace(/\\.(avif|webp|png|jpe?g|gif|svg)$/i, "")
            .replace(/@[\dx]+$/i, "")
            .replace(/[-_]\\d{2,5}w$/i, "")
            .replace(/[-_]\\d+x\\d+$/i, "")
            .replace(/^m[-_]/i, "")
            .replace(/[-_](mb|mobile|desktop|pc)$/i, "");
        } catch {
          return first.toLowerCase();
        }
      };
      const dedupeRepeatedText = (value, max = 220) => {
        let text = cleanText(value, max)
          .replace(/\\s+\\d+\\s*\\/\\s*\\d+\\s*$/g, "")
          .trim();
        const midpoint = Math.floor(text.length / 2);
        if (midpoint > 0 && text.length % 2 === 0) {
          const left = text.slice(0, midpoint).trim();
          const right = text.slice(midpoint).trim();
          if (left && left === right) {
            text = left;
          }
        }
        return text;
      };
      const slidePosition = (slide) => {
        const label = [
          slide.getAttribute?.("aria-label"),
          textOf(slide, 120)
        ].filter(Boolean).join(" ");
        const match = label.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
        return match ? {
          index: Number(match[1]),
          total: Number(match[2])
        } : { index: null, total: null };
      };
      const mediaItemLabel = (slide, track, imageFamily, position) => {
        if (track.key === "pioneer") {
          const value = dedupeRepeatedText(slide.querySelector(".co-number-title")?.innerText || "", 80);
          const description = dedupeRepeatedText(slide.querySelector(".co-number-content")?.innerText || "", 140);
          return [value, description].filter(Boolean).join(" ");
        }
        if (track.key === "reviews") {
          const quote = dedupeRepeatedText(slide.querySelector("p")?.innerText || textOf(slide, 220), 180);
          const image = imageFamily ? imageFamily.replace(/[-_]+/g, " ") : "";
          return [image, quote].filter(Boolean).join(" | ");
        }
        const altText = cleanText(slide.querySelector("img")?.getAttribute("alt") || "", 120);
        return altText || imageFamily.replace(/[-_]+/g, " ") || (position.index ? track.label + " " + position.index : track.label);
      };
      const mediaItems = (track, options = {}) => {
        const panel = mediaTrackPanel(track);
        const trackRoot = mediaTrackRoot(track);
        if (!panel || !trackRoot) return [];
        const panelRect = panel.getBoundingClientRect();
        const rootRect = trackRoot.getBoundingClientRect();
        const slides = Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide']"))
          .filter((slide) => visible(slide))
          .map((slide, domIndex) => {
            const rect = slide.getBoundingClientRect();
            const area = Math.max(1, rect.width * rect.height);
            const visibleArea = intersects(rect, panelRect);
            const position = slidePosition(slide);
            const image = firstImageSource(slide);
            const imageFamily = mediaImageFamily(image);
            const label = mediaItemLabel(slide, track, imageFamily, position);
            const text = dedupeRepeatedText(textOf(slide, 260), 220);
            const keySeed = [
              track.key,
              position.index ? "pos:" + position.index : "",
              imageFamily ? "img:" + imageFamily : "",
              label ? "label:" + label : "",
              !position.index && !imageFamily ? "dom:" + domIndex : ""
            ].filter(Boolean).join("|");
            const clippedLeft = Math.max(rect.left, rootRect.left);
            const clippedTop = Math.max(rect.top, rootRect.top);
            const clippedRight = Math.min(rect.right, rootRect.right);
            const clippedBottom = Math.min(rect.bottom, rootRect.bottom);
            return {
              mediaItemId: keySeed,
              key: keySeed,
              label,
              text,
              image,
              imageFamily,
              position: position.index,
              positionTotal: position.total,
              rect,
              visibleArea,
              visibleRatio: visibleArea / area,
              centerY: rect.top + rect.height / 2,
              rectRelative: {
                x: Math.round(Math.max(0, clippedLeft - rootRect.left)),
                y: Math.round(Math.max(0, clippedTop - rootRect.top)),
                width: Math.round(Math.max(0, clippedRight - clippedLeft)),
                height: Math.round(Math.max(0, clippedBottom - clippedTop))
              }
            };
          })
          .filter((item) =>
            item.key &&
            item.rect.width >= 24 &&
            item.rect.height >= 18 &&
            item.centerY >= panelRect.top - 20 &&
            item.centerY <= panelRect.bottom + 20 &&
            (!options.visibleOnly || (
              item.visibleArea > 120 &&
              item.visibleRatio >= 0.55 &&
              item.rect.right > panelRect.left + 4 &&
              item.rect.left < panelRect.right - 4
            ))
          )
          .sort((a, b) =>
            Number(a.position || 0) - Number(b.position || 0) ||
            a.rect.left - b.rect.left ||
            a.rect.top - b.rect.top
          );
        const deduped = [];
        const seen = new Set();
        for (const item of slides) {
          if (seen.has(item.key)) continue;
          seen.add(item.key);
          deduped.push({
            mediaItemId: item.mediaItemId,
            key: item.key,
            label: item.label,
            text: item.text,
            image: item.image,
            imageFamily: item.imageFamily,
            position: item.position,
            positionTotal: item.positionTotal,
            rect: item.rectRelative
          });
        }
        return deduped;
      };
      const mediaWindowSignature = (track) => {
        const items = mediaItems(track, { visibleOnly: true });
        return items.length ? JSON.stringify(items.map((item) => ({
          key: item.key,
          label: item.label,
          imageFamily: item.imageFamily
        }))) : "";
      };
      const resetMediaTrack = async (track) => {
        const panel = mediaTrackPanel(track);
        const swiper = panel?.swiper;
        if (swiper?.autoplay?.stop) swiper.autoplay.stop();
        if (swiper && typeof swiper.slideToLoop === "function") {
          swiper.slideToLoop(0, 0, false);
        } else if (swiper && typeof swiper.slideTo === "function") {
          swiper.slideTo(0, 0, false);
        }
        if (swiper && typeof swiper.update === "function") swiper.update();
        await sleep(260);
      };
      const advanceMediaTrack = async (track) => {
        const panel = mediaTrackPanel(track);
        const swiper = panel?.swiper;
        if (swiper && typeof swiper.slideNext === "function") {
          if (swiper.autoplay?.stop) swiper.autoplay.stop();
          swiper.slideNext(0, false);
          if (typeof swiper.update === "function") swiper.update();
          await sleep(380);
          return true;
        }
        return false;
      };
      const pageSignature = (root) => {
        if (definition.key === "product-showcase") {
          return productCardSignature(root) || visibleSignature(root);
        }
        if (definition.key === "scene-explore") {
          return sceneWindowSignature(root) || visibleSignature(root);
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
      const controlSearchRoot = (root) =>
        definition.key === "scene-explore"
          ? root.closest("section, .shopify-section, main > div, [class*='section']") || root.parentElement || root
          : root;
      const findPageBullets = (root) => {
        const searchRoot = controlSearchRoot(root);
        const rootRect = searchRoot.getBoundingClientRect();
        return Array.from(searchRoot.querySelectorAll(".swiper-pagination-bullet, .slick-dots button, [role='tab'][aria-label*='slide' i]"))
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
      const sceneSlideElements = (root) => {
        const panel = scenePanel(root);
        return Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"))
          .filter((slide) => {
            const rect = slide.getBoundingClientRect();
            return rect.width >= 120 && rect.height >= 80 && textOf(slide, 500);
          });
      };
      const forceSceneSlideToIndex = async (root, index, item = null) => {
        const panel = scenePanel(root);
        const slides = sceneSlideElements(root);
        const targetText = cleanText(item?.expectedAnchor || item?.title || item?.label || "", 180).toLowerCase();
        const target = (targetText
          ? slides.find((slide) => textOf(slide, 700).toLowerCase().includes(targetText))
          : null) ||
          slides[Math.max(0, Math.min(slides.length - 1, Number(index || 0)))];
        if (!target) return false;
        const wrapper = target.parentElement;
        const panelRect = panel.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const targetLeft = Math.max(0, target.offsetLeft || Math.round(targetRect.left - panelRect.left));
        const targetDelta = Math.round(targetRect.left - panelRect.left);
        const scrollers = [panel, wrapper, ...panel.querySelectorAll("*")]
          .filter((element, elementIndex, list) =>
            element &&
            list.indexOf(element) === elementIndex &&
            element.scrollWidth > element.clientWidth + 8
          );
        for (const scroller of scrollers) {
          scroller.scrollLeft = Math.max(0, scroller.scrollLeft + targetDelta - Math.max(0, (scroller.clientWidth - target.clientWidth) / 2));
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
        if (wrapper && /swiper-wrapper|slick-track|slider|carousel|track|wrapper/i.test(classText(wrapper))) {
          wrapper.style.transitionDuration = "0ms";
          wrapper.style.transform = "translate3d(" + (-targetLeft) + "px, 0px, 0px)";
        }
        target.scrollIntoView({ block: "nearest", inline: "center" });
        await sleep(560);
        return true;
      };
      const findNextControl = (root) => {
        const searchRoot = controlSearchRoot(root);
        const rootRect = searchRoot.getBoundingClientRect();
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
        return Array.from(searchRoot.querySelectorAll(".swiper-button-next, .slick-next, button, [role='button'], a, [aria-label], [title]"))
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
      const activeSceneSwiper = (root) => {
        const panel = scenePanel(root);
        const panelSwiper = panel?.swiper;
        if (panelSwiper) return panelSwiper;
        return activeSwipers(controlSearchRoot(root)).find((swiper) => {
          const element = swiper.el || swiper.wrapperEl?.parentElement;
          return !element || element === panel || panel.contains(element) || element.contains(panel);
        }) || null;
      };
      const activateSceneItem = async (root, item, fallbackIndex) => {
        const swiper = activeSceneSwiper(root);
        const targetIndex = Number.isFinite(Number(item?.slideIndex))
          ? Number(item.slideIndex)
          : Number(fallbackIndex || 0);
        if (swiper) {
          if (swiper.autoplay?.stop) swiper.autoplay.stop();
          if (typeof swiper.slideToLoop === "function") {
            swiper.slideToLoop(targetIndex, 0, false);
          } else if (typeof swiper.slideTo === "function") {
            swiper.slideTo(targetIndex, 0, false);
          } else {
            return false;
          }
          if (typeof swiper.update === "function") swiper.update();
          await sleep(420);
          return true;
        }
        if (fallbackIndex === 0) {
          resetCarousel(root);
          await sleep(420);
          return true;
        }
        if (clickPageBullet(root, fallbackIndex + 1)) {
          await sleep(450);
          return true;
        }
        return forceSceneSlideToIndex(root, fallbackIndex, item);
      };
      const collectScenePages = async (root, states) => {
        resetCarousel(root);
        await sleep(500);

        const allItems = sceneItems(root);
        const expectedItems = sceneExpectedItems(root, allItems);
        const firstWindowItems = sceneItems(root, { visibleOnly: true });
        const firstWindowSignature = sceneWindowSignature(root);
        if (!expectedItems.length || !firstWindowItems.length || !firstWindowSignature) {
          warnings.push({
            sectionKey: definition.key,
            sectionLabel: definition.sectionLabel,
            stateLabel: definition.labelPrefix || "场景",
            message: "Could not read visible scene exploration slides."
          });
          return;
        }

        const seen = new Set();
        for (const [index, item] of expectedItems.entries()) {
          const activated = await activateSceneItem(root, item, index);
          if (!activated && index > 0) {
            const before = sceneWindowSignature(root);
            const moved = await advance(root);
            const after = sceneWindowSignature(root);
            if (!moved || !after || after === before) {
              warnings.push({
                sectionKey: definition.key,
                sectionLabel: definition.sectionLabel,
                stateLabel: (definition.labelPrefix || "场景") + " " + (index + 1),
                message: "Could not activate scene exploration slide " + (item.label || index + 1) + "."
              });
              if (!item.directClip) {
                continue;
              }
            }
          }

          const visibleItems = sceneItems(root, { visibleOnly: true });
          const activeItem = sceneActiveItem(root) || (item.directClip ? item : null);
          const signature = sceneWindowSignature(root);
          if (!signature || !activeItem) {
            warnings.push({
              sectionKey: definition.key,
              sectionLabel: definition.sectionLabel,
              stateLabel: (definition.labelPrefix || "场景") + " " + (index + 1),
              message: "Could not verify scene exploration slide " + (item.label || index + 1) + "."
            });
            if (!item.directClip) {
              continue;
            }
          }
          const signatureKey = item.directClip ? "direct:" + item.key : signature;
          if (seen.has(signatureKey)) {
            warnings.push({
              sectionKey: definition.key,
              sectionLabel: definition.sectionLabel,
              stateLabel: (definition.labelPrefix || "场景") + " " + (index + 1),
              message: "Scene exploration slide " + (item.label || index + 1) + " looked duplicated and was skipped."
            });
            continue;
          }
          seen.add(signatureKey);

          const pageIndex = states.length + 1;
          const label = (definition.labelPrefix || "场景") + " " + pageIndex;
          const directItem = {
            sceneItemId: item.sceneItemId,
            key: item.key,
            label: item.label,
            title: item.title,
            description: item.description,
            href: item.href,
            image: item.image,
            imageFamily: item.imageFamily,
            slideIndex: item.slideIndex,
            order: item.order,
            rect: item.rect
          };
          states.push({
            kind: "carousel",
            sectionKey: definition.key,
            sectionLabel: definition.sectionLabel,
            tabLabel: "",
            tabIndex: null,
            pageIndex,
            stateIndex: states.length + 1,
            stateLabel: label,
            logicalSignature: definition.key + "|" + (item.directClip ? item.key : activeItem.key) + "|" + (item.directClip ? "direct" : signature),
            windowSignature: item.directClip ? "" : signature,
            itemCount: expectedItems.length,
            discoveredItemCount: allItems.length,
            directClip: item.directClip || null,
            directItem,
            requiresActivation: Boolean(item.requiresActivation),
            forceIndex: item.forceIndex ?? index,
            expectedAnchor: item.expectedAnchor || null,
            text: [item.title, item.description].filter(Boolean).join(" "),
            textBlocks: [
              { text: item.title || item.label || label, x: 0, y: 0, width: item.rect?.width || null, height: null },
              item.description ? { text: item.description, x: 0, y: null, width: item.rect?.width || null, height: null } : null
            ].filter(Boolean),
            images: item.image ? [item.image] : [],
            visibleItemCount: item.directClip ? 1 : visibleItems.length,
            visibleItems: item.directClip ? [directItem] : visibleItems,
            itemRects: (item.directClip ? [directItem] : visibleItems).map((visibleItem) => ({
              sceneItemId: visibleItem.sceneItemId,
              key: visibleItem.key,
              label: visibleItem.label,
              rect: visibleItem.rect
            })),
            activeItemKey: activeItem.key,
            fileId: "state-" + pageIndex,
            isDefaultState: pageIndex === 1
          });
        }
      };
      const supportsProductHover = () =>
        Boolean(definition.captureHover) &&
        (!window.matchMedia || window.matchMedia("(hover: hover) and (pointer: fine)").matches);
      const productHoverLabel = (card) =>
        cleanText(card?.label || card?.text || card?.href || "Product", 90);
      const productHoverFileId = (tabLabel, hoverIndex) =>
        tabLabel + "-hover-" + hoverIndex;
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
        const hoverEnabled = supportsProductHover();
        const hoverStates = [];
        const hoverSeen = new Set();
        const maxPages = Math.max(1, allCards.length || firstWindowCards.length) + 2;
        const lastProductKey = allCards[allCards.length - 1]?.key || "";
        for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
          const visibleCards = productCards(root, { visibleOnly: true });
          const signature = productWindowSignature(root);
          if (!signature || seen.has(signature)) break;
          seen.add(signature);
          const label = tabLabel + " " + pageIndex;
          const defaultState = {
            kind: "tab-carousel",
            interactionState: "default",
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
          };
          states.push(defaultState);

          if (hoverEnabled) {
            for (const card of visibleCards) {
              const hoverKey = card.key || card.href || card.text;
              if (!hoverKey || hoverSeen.has(hoverKey)) continue;
              hoverSeen.add(hoverKey);
              const hoverIndex = hoverStates.length + 1;
              const hoverLabel = productHoverLabel(card);
              hoverStates.push({
                kind: "product-hover",
                interactionState: "hover",
                sectionKey: definition.key,
                sectionLabel: definition.sectionLabel,
                tabLabel,
                tabIndex: Number.isFinite(tabIndex) ? tabIndex + 1 : null,
                pageIndex,
                basePageIndex: pageIndex,
                hoverIndex,
                stateIndex: 0,
                stateLabel: "Hover " + hoverLabel,
                logicalSignature: definition.key + "|" + tabLabel + "|hover|" + hoverKey + "|" + signature,
                windowSignature: signature,
                tabSetSignature,
                productCount: allCards.length,
                visibleProductCount: visibleCards.length,
                visibleProducts: visibleCards,
                hoverItemKey: hoverKey,
                hoverItemLabel: hoverLabel,
                hoverItemRect: card.rect || null,
                hoveredProduct: {
                  key: hoverKey,
                  label: hoverLabel,
                  href: card.href || "",
                  text: card.text || "",
                  image: card.image || "",
                  rect: card.rect || null
                },
                fileId: productHoverFileId(tabLabel, hoverIndex),
                isDefaultState: false
              });
            }
          }

          if (lastProductKey && visibleCards.some((card) => card.key === lastProductKey)) {
            break;
          }
          const before = signature;
          const moved = await advance(root);
          const after = productWindowSignature(root);
          if (!moved || !after || after === before || seen.has(after)) break;
        }
        for (const hoverState of hoverStates) {
          hoverState.stateIndex = states.length + 1;
          states.push(hoverState);
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
      const collectMediaPages = async (states) => {
        for (const [trackIndex, track] of mediaTrackDefinitions.entries()) {
          const trackRoot = mediaTrackRoot(track);
          if (!trackRoot) {
            warnings.push({
              sectionKey: definition.key,
              sectionLabel: definition.sectionLabel,
              stateLabel: track.label,
              message: "Could not find media track " + track.label + "."
            });
            continue;
          }
          trackRoot.scrollIntoView({ block: "center", inline: "nearest" });
          await sleep(420);
          await resetMediaTrack(track);

          const allItems = mediaItems(track);
          const firstWindowItems = mediaItems(track, { visibleOnly: true });
          const firstWindowSignature = mediaWindowSignature(track);
          if (!allItems.length || !firstWindowItems.length || !firstWindowSignature) {
            warnings.push({
              sectionKey: definition.key,
              sectionLabel: definition.sectionLabel,
              stateLabel: track.label,
              message: "Could not read visible media items for " + track.label + "."
            });
            continue;
          }

          const seen = new Set();
          const covered = new Set();
          const maxPages = Math.max(1, allItems.length) + 2;
          for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
            const visibleItems = mediaItems(track, { visibleOnly: true });
            const signature = mediaWindowSignature(track);
            if (!signature || seen.has(signature)) break;
            seen.add(signature);
            for (const item of visibleItems) covered.add(item.key);

            const label = track.label + " " + pageIndex;
            states.push({
              kind: "tab-carousel",
              sectionKey: definition.key,
              sectionLabel: definition.sectionLabel,
              tabLabel: track.label,
              tabIndex: trackIndex + 1,
              trackLabel: track.label,
              trackIndex: trackIndex + 1,
              pageIndex,
              stateIndex: states.length + 1,
              stateLabel: label,
              logicalSignature: definition.key + "|" + track.label + "|" + pageIndex + "|" + signature,
              windowSignature: signature,
              itemCount: allItems.length,
              visibleItemCount: visibleItems.length,
              visibleItems,
              itemRects: visibleItems.map((item) => ({
                mediaItemId: item.mediaItemId,
                key: item.key,
                label: item.label,
                rect: item.rect
              })),
              fileId: track.label + "-" + pageIndex,
              isDefaultState: pageIndex === 1
            });

            if (allItems.every((item) => covered.has(item.key))) {
              break;
            }
            const before = signature;
            const moved = await advanceMediaTrack(track);
            const after = mediaWindowSignature(track);
            if (!moved || !after || after === before || seen.has(after)) break;
          }
        }
      };
      const collectPages = async (root, tabLabel, tabIndex, states, warnings, knownTabFirstSignatures) => {
        if (definition.key === "scene-explore") {
          await collectScenePages(root, states);
          return;
        }
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
        if (definition.key === "media") {
          await collectMediaPages(states);
          for (const state of states) {
            const tabCount = states.filter((item) => item.tabIndex === state.tabIndex).length;
            state.pageCount = tabCount || states.length;
          }
        } else if (definition.mode === "tabs-carousel") {
          for (const [tabIndex, tabLabel] of (definition.tabs || []).entries()) {
            const tabStates = [];
            await collectPages(root, tabLabel, tabIndex, tabStates, warnings, knownTabFirstSignatures);
            const defaultCount = tabStates.filter((item) => item.interactionState !== "hover").length || tabStates.length;
            const hoverCount = tabStates.filter((item) => item.interactionState === "hover").length;
            for (const state of tabStates) {
              state.pageCount = state.interactionState === "hover"
                ? (hoverCount || tabStates.length)
                : defaultCount;
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
      const productLabel = (card, text) => cleanText(
        card.querySelector("h1, h2, h3, h4, [class*='title'], [class*='name']")?.innerText ||
        String(text || "").split(/\\$|From\\b|\\d+\\.\\d{2}/i)[0] ||
        text,
        90
      );
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
            const label = productLabel(card, text);
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const clippedLeft = Math.max(rect.left, rootRect.left);
            const clippedTop = Math.max(rect.top, rootRect.top);
            const clippedRight = Math.min(rect.right, rootRect.right);
            const clippedBottom = Math.min(rect.bottom, rootRect.bottom);
            return {
              key: href || text,
              href,
              text,
              label,
              image,
              rect,
              rectRelative: {
                x: Math.round(Math.max(0, clippedLeft - rootRect.left)),
                y: Math.round(Math.max(0, clippedTop - rootRect.top)),
                width: Math.round(Math.max(0, clippedRight - clippedLeft)),
                height: Math.round(Math.max(0, clippedBottom - clippedTop))
              },
              hoverPoint: {
                x: Math.round(Math.max(2, Math.min(window.innerWidth - 2, centerX))),
                y: Math.round(Math.max(2, Math.min(window.innerHeight - 2, centerY)))
              },
              visibleArea,
              visibleRatio: visibleArea / area,
              centerY
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
          deduped.push({
            key,
            href: item.href,
            text: item.text,
            label: item.label,
            image: item.image,
            rect: item.rectRelative,
            hoverPoint: item.hoverPoint
          });
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
      const scenePanel = () =>
        [root, ...root.querySelectorAll(".swiper, [class*='swiper']")]
          .filter((element) => visible(element) && element.querySelector(".swiper-slide, [class*='swiper-slide']"))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const text = textOf(element, 1600);
            const hits = (definition.anchors || []).filter((anchor) => text.includes(anchor)).length;
            const score = hits * 1000 + Math.min(rect.width * rect.height / 1000, 500);
            return { element, rect, score };
          })
          .sort((a, b) => b.score - a.score || b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0]?.element || root;
      const sceneImageFamily = (source) => {
        const first = String(source || "").split(",")[0].trim().split(/\s+/)[0];
        if (!first) return "";
        try {
          const url = new URL(first, window.location.href);
          return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "")
            .toLowerCase()
            .replace(/\.(avif|webp|png|jpe?g|gif|svg)$/i, "")
            .replace(/@[\dx]+$/i, "")
            .replace(/[-_]\d{2,5}w$/i, "")
            .replace(/[-_]\d+x\d+$/i, "")
            .replace(/^m[-_]/i, "")
            .replace(/[-_](mb|mobile|desktop|pc)$/i, "");
        } catch {
          return first.toLowerCase();
        }
      };
      const sceneTitle = (slide) => {
        const text = textOf(slide, 500);
        return (definition.anchors || []).find((item) => text.includes(item)) ||
          cleanText(slide.querySelector("h1, h2, h3, h4, [class*='title']")?.innerText || text, 120);
      };
      const sceneItems = () => {
        const panel = scenePanel();
        const rootRect = root.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const rootCenterX = rootRect.left + rootRect.width / 2;
        const slides = Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide']"))
          .filter(visible)
          .map((slide, domIndex) => {
            const rect = slide.getBoundingClientRect();
            const area = Math.max(1, rect.width * rect.height);
            const visibleArea = intersects(rect, rootRect);
            const title = sceneTitle(slide);
            const href = Array.from(slide.querySelectorAll("a[href]")).map(productHref).filter(Boolean)[0] || "";
            const image = imageSources(slide)[0] || "";
            const imageFamily = sceneImageFamily(image);
            const rawSlideIndex = Number(slide.getAttribute("data-swiper-slide-index"));
            const slideIndex = Number.isFinite(rawSlideIndex) ? rawSlideIndex : null;
            const anchorIndex = (definition.anchors || []).indexOf(title);
            const position = slidePosition(slide);
            const order = anchorIndex >= 0
              ? anchorIndex
              : (Number.isFinite(slideIndex) ? slideIndex : (Number(position.index) || domIndex));
            const key = [
              title || "",
              href ? "href:" + href : "",
              imageFamily ? "img:" + imageFamily : "",
              !title && !href && !imageFamily ? "dom:" + order : ""
            ].filter(Boolean).join("|");
            const centerX = rect.left + rect.width / 2;
            const activeScore = Number(/swiper-slide-active|active|current/i.test(classText(slide))) * 10000 +
              visibleArea -
              Math.abs(centerX - rootCenterX) * 3;
            return {
              key,
              label: title || "场景 " + (order + 1),
              title,
              href,
              image,
              imageFamily,
              slideIndex,
              order,
              rect,
              visibleArea,
              visibleRatio: visibleArea / area,
              centerY: rect.top + rect.height / 2,
              activeScore
            };
          })
          .filter((item) =>
            item.key &&
            item.rect.width >= 180 &&
            item.rect.height >= 120 &&
            item.visibleArea > 600 &&
            item.visibleRatio >= 0.2 &&
            item.rect.right > rootRect.left + 12 &&
            item.rect.left < rootRect.right - 12 &&
            item.centerY >= panelRect.top - 40 &&
            item.centerY <= panelRect.bottom + 40
          );
        const bestByKey = new Map();
        for (const item of slides) {
          const existing = bestByKey.get(item.key);
          if (!existing || item.activeScore > existing.activeScore || item.visibleArea > existing.visibleArea) {
            bestByKey.set(item.key, item);
          }
        }
        return [...bestByKey.values()]
          .sort((a, b) => a.order - b.order || a.rect.left - b.rect.left)
          .map((item) => ({
            key: item.key,
            label: item.label,
            title: item.title,
            href: item.href,
            image: item.image,
            imageFamily: item.imageFamily,
            slideIndex: item.slideIndex,
            order: item.order,
            activeScore: item.activeScore
          }));
      };
      const sceneActiveItem = () =>
        sceneItems().sort((a, b) => b.activeScore - a.activeScore || a.order - b.order)[0] || null;
      const sceneWindowSignature = () => {
        const active = sceneActiveItem();
        const items = sceneItems();
        return active && items.length ? JSON.stringify({
          active: active.key,
          visible: items.map((item) => item.key)
        }) : "";
      };
      const mediaTrackDefinitions = [
        { key: "pioneer", label: "Shokz | Open-Ear Audio Pioneer", selector: ".co-number-swiper", rootSelector: ".co-number-box-banner, section, .shopify-section" },
        { key: "awards", label: "Sports partnership & Awards", selector: ".co-brand-swiper-left", rootSelector: ".co-brand-box" },
        { key: "reviews", label: "Media Reviews", selector: ".co-brand-swiper-right", rootSelector: ".co-brand-box" }
      ];
      const mediaTrackForState = () =>
        mediaTrackDefinitions.find((track) =>
          track.label === state.tabLabel ||
          track.label === state.trackLabel ||
          mediaTrackDefinitions.indexOf(track) + 1 === Number(state.tabIndex || state.trackIndex || 0)
        ) || null;
      const mediaTrackPanel = (track) => track ? document.querySelector(track.selector) : null;
      const mediaTrackRoot = (track) => {
        const panel = mediaTrackPanel(track);
        return panel?.closest(track.rootSelector) || panel;
      };
      const mediaImageFamily = (source) => {
        const first = String(source || "").split(",")[0].trim().split(/\\s+/)[0];
        if (!first) return "";
        try {
          const url = new URL(first, window.location.href);
          return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "")
            .toLowerCase()
            .replace(/\\.(avif|webp|png|jpe?g|gif|svg)$/i, "")
            .replace(/@[\dx]+$/i, "")
            .replace(/[-_]\\d{2,5}w$/i, "")
            .replace(/[-_]\\d+x\\d+$/i, "")
            .replace(/^m[-_]/i, "")
            .replace(/[-_](mb|mobile|desktop|pc)$/i, "");
        } catch {
          return first.toLowerCase();
        }
      };
      const dedupeRepeatedText = (value, max = 220) => {
        let text = cleanText(value, max).replace(/\\s+\\d+\\s*\\/\\s*\\d+\\s*$/g, "").trim();
        const midpoint = Math.floor(text.length / 2);
        if (midpoint > 0 && text.length % 2 === 0) {
          const left = text.slice(0, midpoint).trim();
          const right = text.slice(midpoint).trim();
          if (left && left === right) text = left;
        }
        return text;
      };
      const slidePosition = (slide) => {
        const label = [slide.getAttribute?.("aria-label"), textOf(slide, 120)].filter(Boolean).join(" ");
        const match = label.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
        return match ? { index: Number(match[1]), total: Number(match[2]) } : { index: null, total: null };
      };
      const mediaItemLabel = (slide, track, imageFamily, position) => {
        if (track.key === "pioneer") {
          return [
            dedupeRepeatedText(slide.querySelector(".co-number-title")?.innerText || "", 80),
            dedupeRepeatedText(slide.querySelector(".co-number-content")?.innerText || "", 140)
          ].filter(Boolean).join(" ");
        }
        if (track.key === "reviews") {
          return [
            imageFamily ? imageFamily.replace(/[-_]+/g, " ") : "",
            dedupeRepeatedText(slide.querySelector("p")?.innerText || textOf(slide, 220), 180)
          ].filter(Boolean).join(" | ");
        }
        return cleanText(slide.querySelector("img")?.getAttribute("alt") || "", 120) ||
          imageFamily.replace(/[-_]+/g, " ") ||
          (position.index ? track.label + " " + position.index : track.label);
      };
      const mediaItems = (track) => {
        const panel = mediaTrackPanel(track);
        if (!panel) return [];
        const panelRect = panel.getBoundingClientRect();
        const slides = Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide']"))
          .filter(visible)
          .map((slide, domIndex) => {
            const rect = slide.getBoundingClientRect();
            const area = Math.max(1, rect.width * rect.height);
            const visibleArea = intersects(rect, panelRect);
            const position = slidePosition(slide);
            const image = imageSources(slide)[0] || "";
            const imageFamily = mediaImageFamily(image);
            const label = mediaItemLabel(slide, track, imageFamily, position);
            const key = [
              track.key,
              position.index ? "pos:" + position.index : "",
              imageFamily ? "img:" + imageFamily : "",
              label ? "label:" + label : "",
              !position.index && !imageFamily ? "dom:" + domIndex : ""
            ].filter(Boolean).join("|");
            return {
              key,
              label,
              imageFamily,
              rect,
              visibleArea,
              visibleRatio: visibleArea / area,
              centerY: rect.top + rect.height / 2
            };
          })
          .filter((item) =>
            item.key &&
            item.rect.width >= 24 &&
            item.rect.height >= 18 &&
            item.visibleArea > 120 &&
            item.visibleRatio >= 0.55 &&
            item.rect.right > panelRect.left + 4 &&
            item.rect.left < panelRect.right - 4 &&
            item.centerY >= panelRect.top - 20 &&
            item.centerY <= panelRect.bottom + 20
          )
          .sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);
        const deduped = [];
        const seen = new Set();
        for (const item of slides) {
          if (seen.has(item.key)) continue;
          seen.add(item.key);
          deduped.push(item);
        }
        return deduped;
      };
      const mediaWindowSignature = (track) => {
        const items = mediaItems(track);
        return items.length ? JSON.stringify(items.map((item) => ({
          key: item.key,
          label: item.label,
          imageFamily: item.imageFamily
        }))) : "";
      };
      const resetMediaTrack = async (track) => {
        const swiper = mediaTrackPanel(track)?.swiper;
        if (swiper?.autoplay?.stop) swiper.autoplay.stop();
        if (swiper && typeof swiper.slideToLoop === "function") {
          swiper.slideToLoop(0, 0, false);
        } else if (swiper && typeof swiper.slideTo === "function") {
          swiper.slideTo(0, 0, false);
        }
        if (swiper && typeof swiper.update === "function") swiper.update();
        await sleep(260);
      };
      const advanceMediaTrack = async (track) => {
        const swiper = mediaTrackPanel(track)?.swiper;
        if (!swiper || typeof swiper.slideNext !== "function") return false;
        if (swiper.autoplay?.stop) swiper.autoplay.stop();
        swiper.slideNext(0, false);
        if (typeof swiper.update === "function") swiper.update();
        await sleep(380);
        return true;
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
      const activeSwipers = (searchRoot = root) => [searchRoot, ...searchRoot.querySelectorAll(".swiper, [class*='swiper']")]
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
      const controlSearchRoot = () =>
        definition.key === "scene-explore"
          ? root.closest("section, .shopify-section, main > div, [class*='section']") || root.parentElement || root
          : root;
      const findPageBullets = () => {
        const searchRoot = controlSearchRoot();
        const rootRect = searchRoot.getBoundingClientRect();
        return Array.from(searchRoot.querySelectorAll(".swiper-pagination-bullet, .slick-dots button, [role='tab'][aria-label*='slide' i]"))
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
      const sceneSlideElements = () => {
        const panel = scenePanel();
        return Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"))
          .filter((slide) => {
            const rect = slide.getBoundingClientRect();
            return rect.width >= 120 && rect.height >= 80 && textOf(slide, 500);
          });
      };
      const forceSceneSlideToIndex = async (index, item = null) => {
        const panel = scenePanel();
        const slides = sceneSlideElements();
        const targetText = cleanText(item?.expectedAnchor || item?.title || item?.label || "", 180).toLowerCase();
        const target = (targetText
          ? slides.find((slide) => textOf(slide, 700).toLowerCase().includes(targetText))
          : null) ||
          slides[Math.max(0, Math.min(slides.length - 1, Number(index || 0)))];
        if (!target) return false;
        const wrapper = target.parentElement;
        const panelRect = panel.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const targetLeft = Math.max(0, target.offsetLeft || Math.round(targetRect.left - panelRect.left));
        const targetDelta = Math.round(targetRect.left - panelRect.left);
        const scrollers = [panel, wrapper, ...panel.querySelectorAll("*")]
          .filter((element, elementIndex, list) =>
            element &&
            list.indexOf(element) === elementIndex &&
            element.scrollWidth > element.clientWidth + 8
          );
        for (const scroller of scrollers) {
          scroller.scrollLeft = Math.max(0, scroller.scrollLeft + targetDelta - Math.max(0, (scroller.clientWidth - target.clientWidth) / 2));
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
        if (wrapper && /swiper-wrapper|slick-track|slider|carousel|track|wrapper/i.test(classText(wrapper))) {
          wrapper.style.transitionDuration = "0ms";
          wrapper.style.transform = "translate3d(" + (-targetLeft) + "px, 0px, 0px)";
        }
        target.scrollIntoView({ block: "nearest", inline: "center" });
        await sleep(560);
        return true;
      };
      const findNextControl = () => {
        const searchRoot = controlSearchRoot();
        const rootRect = searchRoot.getBoundingClientRect();
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
        return Array.from(searchRoot.querySelectorAll(".swiper-button-next, .slick-next, button, [role='button'], a, [aria-label], [title]"))
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
      const activeSceneSwiper = () => {
        const panel = scenePanel();
        if (panel?.swiper) return panel.swiper;
        return activeSwipers(controlSearchRoot()).find((swiper) => {
          const element = swiper.el || swiper.wrapperEl?.parentElement;
          return !element || element === panel || panel.contains(element) || element.contains(panel);
        }) || null;
      };
      const activateSceneItem = async (item, fallbackIndex) => {
        const swiper = activeSceneSwiper();
        const targetIndex = Number.isFinite(Number(item?.slideIndex))
          ? Number(item.slideIndex)
          : Number(fallbackIndex || 0);
        if (!swiper) {
          if (clickPageBullet(fallbackIndex + 1)) {
            await sleep(450);
            return true;
          }
          return forceSceneSlideToIndex(fallbackIndex, item);
        }
        if (swiper.autoplay?.stop) swiper.autoplay.stop();
        if (typeof swiper.slideToLoop === "function") {
          swiper.slideToLoop(targetIndex, 0, false);
        } else if (typeof swiper.slideTo === "function") {
          swiper.slideTo(targetIndex, 0, false);
        } else {
          return false;
        }
        if (typeof swiper.update === "function") swiper.update();
        await sleep(420);
        return true;
      };
      return (async () => {
        root.scrollIntoView({ block: "center", inline: "nearest" });
        await sleep(260);
        if (definition.key === "media") {
          const track = mediaTrackForState();
          const trackRoot = mediaTrackRoot(track);
          if (!track || !trackRoot) {
            return { ok: false, reason: "Could not find media track " + (state.tabLabel || state.trackLabel || state.stateLabel) + "." };
          }
          trackRoot.scrollIntoView({ block: "center", inline: "nearest" });
          await sleep(360);
          await resetMediaTrack(track);
          const targetSignature = state.windowSignature || "";
          const maxAttempts = Math.max(12, Number(state.pageIndex || 1) + Number(state.itemCount || 0) + 2);
          for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            const currentSignature = mediaWindowSignature(track);
            if (targetSignature && currentSignature === targetSignature) {
              trackRoot.scrollIntoView({ block: "center", inline: "nearest" });
              await sleep(220);
              return { ok: true };
            }
            if (!targetSignature && attempt >= Math.max(0, Number(state.pageIndex || 1) - 1)) {
              trackRoot.scrollIntoView({ block: "center", inline: "nearest" });
              await sleep(220);
              return { ok: true };
            }
            const before = currentSignature;
            const moved = await advanceMediaTrack(track);
            const after = mediaWindowSignature(track);
            if (!moved || !after || after === before) break;
          }
          return { ok: false, reason: "Could not activate media window " + state.stateLabel + "." };
        }
        if (definition.key === "scene-explore") {
          resetCarousel();
          await sleep(450);
          const targetSignature = state.windowSignature || "";
          const allItems = sceneItems();
          const targetItem = allItems.find((item) => item.key === state.activeItemKey) ||
            allItems[Math.max(0, Number(state.pageIndex || 1) - 1)] ||
            (state.expectedAnchor ? state : null);
          if (targetItem) {
            await activateSceneItem(targetItem, Number(state.forceIndex ?? Math.max(0, Number(state.pageIndex || 1) - 1)));
          }
          const maxAttempts = Math.max(8, Number(state.itemCount || allItems.length || 0) + 3);
          for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            const currentSignature = sceneWindowSignature();
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
            const after = sceneWindowSignature();
            if (!moved || !after || after === before) break;
          }
          return { ok: false, reason: "Could not activate scene exploration window " + state.stateLabel + "." };
        }
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
          const hoverActivation = () => {
            if (definition.key !== "product-showcase" || state.interactionState !== "hover") {
              return null;
            }
            const cards = productCards();
            const target = cards.find((card) =>
              card.key === state.hoverItemKey ||
              card.href === state.hoverItemKey ||
              card.label === state.hoverItemLabel ||
              card.text === state.hoverItemLabel
            );
            if (!target?.hoverPoint) {
              return {
                ok: false,
                reason: "Could not find hover product " + (state.hoverItemLabel || state.hoverItemKey || state.stateLabel) + "."
              };
            }
            return {
              ok: true,
              hoverPoint: target.hoverPoint,
              hoverItemKey: target.key,
              hoverItemLabel: target.label || state.hoverItemLabel || target.text,
              hoverItemRect: target.rect || state.hoverItemRect || null
            };
          };
          const maxAttempts = Math.max(12, Number(state.pageIndex || 1) + 4);
          for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            const currentSignature = currentWindowSignature();
            if (targetSignature && currentSignature === targetSignature) {
              root.scrollIntoView({ block: "center", inline: "nearest" });
              await sleep(260);
              const hover = hoverActivation();
              if (hover) return hover;
              return { ok: true };
            }
            if (!targetSignature && attempt >= Math.max(0, Number(state.pageIndex || 1) - 1)) {
              root.scrollIntoView({ block: "center", inline: "nearest" });
              await sleep(260);
              const hover = hoverActivation();
              if (hover) return hover;
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

async function moveMouseToPoint(client, point) {
  const x = Math.round(Number(point?.x));
  const y = Math.round(Number(point?.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return;
  }
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    pointerType: "mouse"
  }).catch(() => null);
}

async function waitForRelatedHoverSettled(client, definition, state) {
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const definition = ${JSON.stringify(definition)};
      const state = ${JSON.stringify(state)};
      const cleanText = (value, max = 220) => String(value || "")
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, max);
      const root = window.__pageShotRelatedSections?.[definition.key]?.root || document;
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
      const productHref = (element) => {
        try {
          return new URL(element.getAttribute("href") || element.href || "", window.location.href).pathname;
        } catch {
          return element.getAttribute("href") || element.href || "";
        }
      };
      const productText = (card) => cleanText([card.innerText, card.textContent].filter(Boolean).join(" "), 220)
        .replace(/\\b\\d+\\s*\\/\\s*\\d+\\b/g, "")
        .replace(/\\s+/g, " ")
        .trim();
      const productLabel = (card, text) => cleanText(
        card.querySelector("h1, h2, h3, h4, [class*='title'], [class*='name']")?.innerText ||
        String(text || "").split(/\\$|From\\b|\\d+\\.\\d{2}/i)[0] ||
        text,
        90
      );
      const cardForLink = (link) =>
        link.closest("[data-product-card], article, li, [class*='product'][class*='card'], [class*='card'], [class*='slide']") || link;
      const cards = Array.from(root.querySelectorAll("a[href*='/products/']"))
        .filter(visible)
        .map((link) => {
          const card = cardForLink(link);
          const href = productHref(link);
          const text = productText(card);
          return { card, href, text, label: productLabel(card, text), key: href || text };
        });
      const target = cards.find((item) =>
        item.key === state.hoverItemKey ||
        item.href === state.hoverItemKey ||
        item.label === state.hoverItemLabel ||
        item.text === state.hoverItemLabel
      )?.card || root;
      const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(true)));
      const decodeImages = async () => {
        const images = Array.from(target.querySelectorAll("img")).filter((img) => img.currentSrc || img.src);
        await Promise.all(images.map((img) => {
          if (img.complete && img.naturalWidth > 0) return true;
          if (typeof img.decode === "function") {
            return Promise.race([
              img.decode().catch(() => true),
              new Promise((resolve) => setTimeout(resolve, 900))
            ]);
          }
          return new Promise((resolve) => {
            const done = () => resolve(true);
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
            setTimeout(done, 900);
          });
        }));
      };
      const hasRunningAnimations = () => {
        if (typeof document.getAnimations !== "function") return false;
        return document.getAnimations({ subtree: true }).some((animation) => {
          const targetElement = animation.effect?.target;
          if (!(targetElement instanceof Element)) return false;
          if (targetElement !== target && !target.contains(targetElement)) return false;
          return animation.playState === "running" || animation.playState === "pending";
        });
      };
      return (async () => {
        await decodeImages();
        let stableFrames = 0;
        const started = performance.now();
        while (performance.now() - started < 2400 && stableFrames < 8) {
          await waitFrame();
          if (hasRunningAnimations()) {
            stableFrames = 0;
          } else {
            stableFrames += 1;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 260));
        return { ok: true };
      })();
    })()`,
    awaitPromise: true,
    returnByValue: true
  }).catch(() => null);
}

async function suppressRelatedHoverDefaultLayer(client, definition, state) {
  if (definition.key !== "product-showcase" || state.interactionState !== "hover") {
    return;
  }
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const definition = ${JSON.stringify(definition)};
      const state = ${JSON.stringify(state)};
      const cleanText = (value, max = 220) => String(value || "")
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, max);
      const root = window.__pageShotRelatedSections?.[definition.key]?.root || document;
      window.__pageShotSuppressedHoverLayers = window.__pageShotSuppressedHoverLayers || [];
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
      const imageSource = (node) => [
        node.currentSrc,
        node.src,
        node.srcset,
        node.getAttribute?.("data-src"),
        node.getAttribute?.("data-srcset"),
        node.getAttribute?.("data-original"),
        node.getAttribute?.("data-lazy-src")
      ].filter(Boolean).map((value) => String(value).split(",")[0].trim())[0] || "";
      const productHref = (element) => {
        try {
          return new URL(element.getAttribute("href") || element.href || "", window.location.href).pathname;
        } catch {
          return element.getAttribute("href") || element.href || "";
        }
      };
      const productText = (card) => cleanText([card.innerText, card.textContent].filter(Boolean).join(" "), 220)
        .replace(/\\b\\d+\\s*\\/\\s*\\d+\\b/g, "")
        .replace(/\\s+/g, " ")
        .trim();
      const productLabel = (card, text) => cleanText(
        card.querySelector("h1, h2, h3, h4, [class*='title'], [class*='name']")?.innerText ||
        String(text || "").split(/\\$|From\\b|\\d+\\.\\d{2}/i)[0] ||
        text,
        90
      );
      const cardForLink = (link) =>
        link.closest("[data-product-card], article, li, [class*='product'][class*='card'], [class*='card'], [class*='slide']") || link;
      const cards = Array.from(root.querySelectorAll("a[href*='/products/']"))
        .filter(visible)
        .map((link) => {
          const card = cardForLink(link);
          const href = productHref(link);
          const text = productText(card);
          return { card, href, text, label: productLabel(card, text), key: href || text };
        });
      const target = cards.find((item) =>
        item.key === state.hoverItemKey ||
        item.href === state.hoverItemKey ||
        item.label === state.hoverItemLabel ||
        item.text === state.hoverItemLabel
      )?.card;
      if (!target) return { ok: false, reason: "hover target missing" };
      const plannedImage = String(state.hoveredProduct?.image || "").split(",")[0].trim();
      const largeImages = Array.from(target.querySelectorAll("img"))
        .filter((img) => {
          if (!visible(img)) return false;
          const rect = img.getBoundingClientRect();
          return rect.width >= 80 && rect.height >= 80;
        })
        .map((img, index) => ({ img, index, source: imageSource(img), rect: img.getBoundingClientRect() }));
      const exactMatches = plannedImage
        ? largeImages.filter((item) => item.source && (item.source === plannedImage || item.source.includes(plannedImage) || plannedImage.includes(item.source)))
        : [];
      const targets = exactMatches.length ? exactMatches : largeImages.slice(0, 1);
      for (const item of targets) {
        const element = item.img;
        if (element.dataset.pageShotHoverSuppressed === "true") continue;
        window.__pageShotSuppressedHoverLayers.push({
          element,
          opacity: element.style.opacity,
          transition: element.style.transition
        });
        element.dataset.pageShotHoverSuppressed = "true";
        element.style.setProperty("transition", "none", "important");
        element.style.setProperty("opacity", "0", "important");
      }
      return { ok: true, hiddenCount: targets.length };
    })()`,
    returnByValue: true
  }).catch(() => null);
}

async function restoreRelatedHoverSuppressedLayers(client) {
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const records = window.__pageShotSuppressedHoverLayers || [];
      for (const record of records) {
        const element = record?.element;
        if (!element || !(element instanceof Element)) continue;
        element.style.opacity = record.opacity || "";
        element.style.transition = record.transition || "";
        delete element.dataset.pageShotHoverSuppressed;
      }
      window.__pageShotSuppressedHoverLayers = [];
      return true;
    })()`,
    returnByValue: true
  }).catch(() => null);
}

async function clearRelatedHover(client) {
  await restoreRelatedHoverSuppressedLayers(client);
  await moveMouseToPoint(client, { x: 2, y: 2 });
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
      const productLabel = (card, text) => cleanText(
        card.querySelector("h1, h2, h3, h4, [class*='title'], [class*='name']")?.innerText ||
        String(text || "").split(/\\$|From\\b|\\d+\\.\\d{2}/i)[0] ||
        text,
        90
      );
      const productVisibleCards = (root) => {
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
            const label = productLabel(card, text);
            const clippedLeft = Math.max(rect.left, rootRect.left);
            const clippedTop = Math.max(rect.top, rootRect.top);
            const clippedRight = Math.min(rect.right, rootRect.right);
            const clippedBottom = Math.min(rect.bottom, rootRect.bottom);
            return {
              href,
              text,
              label,
              image,
              key: href || text,
              rect,
              rectRelative: {
                x: Math.round(Math.max(0, clippedLeft - rootRect.left)),
                y: Math.round(Math.max(0, clippedTop - rootRect.top)),
                width: Math.round(Math.max(0, clippedRight - clippedLeft)),
                height: Math.round(Math.max(0, clippedBottom - clippedTop))
              },
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
            href: item.href,
            text: item.text,
            label: item.label,
            image: item.image,
            rect: item.rectRelative
          });
        }
        return deduped;
      };
      const productCardSignature = (root) => {
        const cards = productVisibleCards(root);
        return cards.length ? JSON.stringify(cards.map((card) => ({
          key: card.key,
          href: card.href
        }))) : "";
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
      const scenePanel = (root) =>
        [root, ...root.querySelectorAll(".swiper, [class*='swiper']")]
          .filter((element) => visible(element) && element.querySelector(".swiper-slide, [class*='swiper-slide']"))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const text = cleanText([element.innerText, element.textContent].filter(Boolean).join(" "), 1600);
            const hits = (definition.anchors || []).filter((anchor) => text.includes(anchor)).length;
            const score = hits * 1000 + Math.min(rect.width * rect.height / 1000, 500);
            return { element, rect, score };
          })
          .sort((a, b) => b.score - a.score || b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0]?.element || root;
      const sceneImageFamily = (source) => {
        const first = String(source || "").split(",")[0].trim().split(/\s+/)[0];
        if (!first) return "";
        try {
          const url = new URL(first, window.location.href);
          return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "")
            .toLowerCase()
            .replace(/\.(avif|webp|png|jpe?g|gif|svg)$/i, "")
            .replace(/@[\dx]+$/i, "")
            .replace(/[-_]\d{2,5}w$/i, "")
            .replace(/[-_]\d+x\d+$/i, "")
            .replace(/^m[-_]/i, "")
            .replace(/[-_](mb|mobile|desktop|pc)$/i, "");
        } catch {
          return first.toLowerCase();
        }
      };
      const sceneTitle = (slide) => {
        const text = cleanText([slide.innerText, slide.textContent].filter(Boolean).join(" "), 500);
        return (definition.anchors || []).find((item) => text.includes(item)) ||
          cleanText(slide.querySelector("h1, h2, h3, h4, [class*='title']")?.innerText || text, 120);
      };
      const sceneDescription = (slide, title) => {
        const text = cleanText([slide.innerText, slide.textContent].filter(Boolean).join(" "), 500)
          .replace(title || "", "")
          .replace(/\bLearn More\b/ig, "")
          .trim();
        return cleanText(slide.querySelector("p, [class*='desc'], [class*='content']")?.innerText || text, 160);
      };
      const sceneItems = (root) => {
        const panel = scenePanel(root);
        const rootRect = root.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const rootCenterX = rootRect.left + rootRect.width / 2;
        const slides = Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide']"))
          .filter(visible)
          .map((slide, domIndex) => {
            const rect = slide.getBoundingClientRect();
            const area = Math.max(1, rect.width * rect.height);
            const visibleArea = intersects(rect, rootRect);
            const title = sceneTitle(slide);
            const description = sceneDescription(slide, title);
            const link = Array.from(slide.querySelectorAll("a[href]")).map(productHref).filter(Boolean)[0] || "";
            const image = imageSourcesForElement(slide)[0] || "";
            const imageFamily = sceneImageFamily(image);
            const rawSlideIndex = Number(slide.getAttribute("data-swiper-slide-index"));
            const slideIndex = Number.isFinite(rawSlideIndex) ? rawSlideIndex : null;
            const anchorIndex = (definition.anchors || []).indexOf(title);
            const position = slidePosition(slide);
            const order = anchorIndex >= 0
              ? anchorIndex
              : (Number.isFinite(slideIndex) ? slideIndex : (Number(position.index) || domIndex));
            const key = [
              title || "",
              link ? "href:" + link : "",
              imageFamily ? "img:" + imageFamily : "",
              !title && !link && !imageFamily ? "dom:" + order : ""
            ].filter(Boolean).join("|");
            const clippedLeft = Math.max(rect.left, rootRect.left);
            const clippedTop = Math.max(rect.top, rootRect.top);
            const clippedRight = Math.min(rect.right, rootRect.right);
            const clippedBottom = Math.min(rect.bottom, rootRect.bottom);
            const centerX = rect.left + rect.width / 2;
            const activeScore = Number(/swiper-slide-active|active|current/i.test(classText(slide))) * 10000 +
              visibleArea -
              Math.abs(centerX - rootCenterX) * 3;
            return {
              sceneItemId: key,
              key,
              label: title || "场景 " + (order + 1),
              title,
              description,
              href: link,
              image,
              imageFamily,
              slideIndex,
              order,
              rect,
              visibleArea,
              visibleRatio: visibleArea / area,
              centerY: rect.top + rect.height / 2,
              activeScore,
              rectRelative: {
                x: Math.round(Math.max(0, clippedLeft - rootRect.left)),
                y: Math.round(Math.max(0, clippedTop - rootRect.top)),
                width: Math.round(Math.max(0, clippedRight - clippedLeft)),
                height: Math.round(Math.max(0, clippedBottom - clippedTop))
              }
            };
          })
          .filter((item) =>
            item.key &&
            item.rect.width >= 180 &&
            item.rect.height >= 120 &&
            item.visibleArea > 600 &&
            item.visibleRatio >= 0.2 &&
            item.rect.right > rootRect.left + 12 &&
            item.rect.left < rootRect.right - 12 &&
            item.centerY >= panelRect.top - 40 &&
            item.centerY <= panelRect.bottom + 40
          );
        const bestByKey = new Map();
        for (const item of slides) {
          const existing = bestByKey.get(item.key);
          if (!existing || item.activeScore > existing.activeScore || item.visibleArea > existing.visibleArea) {
            bestByKey.set(item.key, item);
          }
        }
        return [...bestByKey.values()]
          .sort((a, b) => a.order - b.order || a.rect.left - b.rect.left)
          .map((item) => ({
            sceneItemId: item.sceneItemId,
            key: item.key,
            label: item.label,
            title: item.title,
            description: item.description,
            href: item.href,
            image: item.image,
            imageFamily: item.imageFamily,
            slideIndex: item.slideIndex,
            order: item.order,
            rect: item.rectRelative,
            activeScore: item.activeScore
          }));
      };
      const sceneActiveItem = (root) =>
        sceneItems(root).sort((a, b) => b.activeScore - a.activeScore || a.order - b.order)[0] || null;
      const sceneWindowSignature = (root) => {
        const active = sceneActiveItem(root);
        const items = sceneItems(root);
        return active && items.length ? JSON.stringify({
          active: active.key,
          visible: items.map((item) => item.key)
        }) : "";
      };
      const mediaTrackDefinitions = [
        { key: "pioneer", label: "Shokz | Open-Ear Audio Pioneer", selector: ".co-number-swiper", rootSelector: ".co-number-box-banner, section, .shopify-section" },
        { key: "awards", label: "Sports partnership & Awards", selector: ".co-brand-swiper-left", rootSelector: ".co-brand-box" },
        { key: "reviews", label: "Media Reviews", selector: ".co-brand-swiper-right", rootSelector: ".co-brand-box" }
      ];
      const mediaTrackForState = () =>
        mediaTrackDefinitions.find((track) =>
          track.label === state.tabLabel ||
          track.label === state.trackLabel ||
          mediaTrackDefinitions.indexOf(track) + 1 === Number(state.tabIndex || state.trackIndex || 0)
        ) || null;
      const mediaTrackPanel = (track) => track ? document.querySelector(track.selector) : null;
      const mediaTrackRoot = (track) => {
        const panel = mediaTrackPanel(track);
        return panel?.closest(track.rootSelector) || panel;
      };
      const imageSourcesForElement = (element) => Array.from(element.querySelectorAll("img, source"))
        .flatMap((node) => imageSourcesForNode(node))
        .filter(Boolean);
      const mediaImageFamily = (source) => {
        const first = String(source || "").split(",")[0].trim().split(/\\s+/)[0];
        if (!first) return "";
        try {
          const url = new URL(first, window.location.href);
          return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "")
            .toLowerCase()
            .replace(/\\.(avif|webp|png|jpe?g|gif|svg)$/i, "")
            .replace(/@[\dx]+$/i, "")
            .replace(/[-_]\\d{2,5}w$/i, "")
            .replace(/[-_]\\d+x\\d+$/i, "")
            .replace(/^m[-_]/i, "")
            .replace(/[-_](mb|mobile|desktop|pc)$/i, "");
        } catch {
          return first.toLowerCase();
        }
      };
      const dedupeRepeatedText = (value, max = 220) => {
        let text = cleanText(value, max).replace(/\\s+\\d+\\s*\\/\\s*\\d+\\s*$/g, "").trim();
        const midpoint = Math.floor(text.length / 2);
        if (midpoint > 0 && text.length % 2 === 0) {
          const left = text.slice(0, midpoint).trim();
          const right = text.slice(midpoint).trim();
          if (left && left === right) text = left;
        }
        return text;
      };
      const slidePosition = (slide) => {
        const label = [slide.getAttribute?.("aria-label"), cleanText([slide.innerText, slide.textContent].filter(Boolean).join(" "), 120)].filter(Boolean).join(" ");
        const match = label.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
        return match ? { index: Number(match[1]), total: Number(match[2]) } : { index: null, total: null };
      };
      const mediaItemLabel = (slide, track, imageFamily, position) => {
        if (track.key === "pioneer") {
          return [
            dedupeRepeatedText(slide.querySelector(".co-number-title")?.innerText || "", 80),
            dedupeRepeatedText(slide.querySelector(".co-number-content")?.innerText || "", 140)
          ].filter(Boolean).join(" ");
        }
        if (track.key === "reviews") {
          return [
            imageFamily ? imageFamily.replace(/[-_]+/g, " ") : "",
            dedupeRepeatedText(slide.querySelector("p")?.innerText || [slide.innerText, slide.textContent].filter(Boolean).join(" "), 180)
          ].filter(Boolean).join(" | ");
        }
        return cleanText(slide.querySelector("img")?.getAttribute("alt") || "", 120) ||
          imageFamily.replace(/[-_]+/g, " ") ||
          (position.index ? track.label + " " + position.index : track.label);
      };
      const mediaItems = (track) => {
        const panel = mediaTrackPanel(track);
        const trackRoot = mediaTrackRoot(track);
        if (!panel || !trackRoot) return [];
        const panelRect = panel.getBoundingClientRect();
        const rootRect = trackRoot.getBoundingClientRect();
        const slides = Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide']"))
          .filter(visible)
          .map((slide, domIndex) => {
            const rect = slide.getBoundingClientRect();
            const area = Math.max(1, rect.width * rect.height);
            const visibleArea = intersects(rect, panelRect);
            const position = slidePosition(slide);
            const image = imageSourcesForElement(slide)[0] || "";
            const imageFamily = mediaImageFamily(image);
            const label = mediaItemLabel(slide, track, imageFamily, position);
            const key = [
              track.key,
              position.index ? "pos:" + position.index : "",
              imageFamily ? "img:" + imageFamily : "",
              label ? "label:" + label : "",
              !position.index && !imageFamily ? "dom:" + domIndex : ""
            ].filter(Boolean).join("|");
            const clippedLeft = Math.max(rect.left, rootRect.left);
            const clippedTop = Math.max(rect.top, rootRect.top);
            const clippedRight = Math.min(rect.right, rootRect.right);
            const clippedBottom = Math.min(rect.bottom, rootRect.bottom);
            return {
              mediaItemId: key,
              key,
              label,
              text: dedupeRepeatedText([slide.innerText, slide.textContent].filter(Boolean).join(" "), 220),
              image,
              imageFamily,
              position: position.index,
              positionTotal: position.total,
              rect,
              visibleArea,
              visibleRatio: visibleArea / area,
              centerY: rect.top + rect.height / 2,
              rectRelative: {
                x: Math.round(Math.max(0, clippedLeft - rootRect.left)),
                y: Math.round(Math.max(0, clippedTop - rootRect.top)),
                width: Math.round(Math.max(0, clippedRight - clippedLeft)),
                height: Math.round(Math.max(0, clippedBottom - clippedTop))
              }
            };
          })
          .filter((item) =>
            item.key &&
            item.rect.width >= 24 &&
            item.rect.height >= 18 &&
            item.visibleArea > 120 &&
            item.visibleRatio >= 0.55 &&
            item.rect.right > panelRect.left + 4 &&
            item.rect.left < panelRect.right - 4 &&
            item.centerY >= panelRect.top - 20 &&
            item.centerY <= panelRect.bottom + 20
          )
          .sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);
        const deduped = [];
        const seen = new Set();
        for (const item of slides) {
          if (seen.has(item.key)) continue;
          seen.add(item.key);
          deduped.push({
            mediaItemId: item.mediaItemId,
            key: item.key,
            label: item.label,
            text: item.text,
            image: item.image,
            imageFamily: item.imageFamily,
            position: item.position,
            positionTotal: item.positionTotal,
            rect: item.rectRelative
          });
        }
        return deduped;
      };
      const mediaWindowSignature = (track) => {
        const items = mediaItems(track);
        return items.length ? JSON.stringify(items.map((item) => ({
          key: item.key,
          label: item.label,
          imageFamily: item.imageFamily
        }))) : "";
      };
      if (definition.key === "media") {
        const track = mediaTrackForState();
        const trackRoot = mediaTrackRoot(track);
        if (!track || !trackRoot) {
          return { ok: false, reason: "Could not find media track " + (state.tabLabel || state.trackLabel || state.stateLabel) + "." };
        }
        const trackRect = trackRoot.getBoundingClientRect();
        const visibleItems = mediaItems(track);
        const mediaSignature = mediaWindowSignature(track);
        if (state.windowSignature && mediaSignature !== state.windowSignature) {
          return {
            ok: false,
            reason: "Visible media items did not match planned media window " + state.stateLabel + "."
          };
        }
        const mediaTextNodes = Array.from(trackRoot.querySelectorAll("a, button, h1, h2, h3, h4, p, li, article, [class*='card'], [class*='slide'], [class*='header'], [class*='title']"))
          .filter(visible)
          .filter((node) => intersects(node.getBoundingClientRect(), trackRect) > 40);
        const seenMediaText = new Set();
        const mediaTextBlocks = [];
        for (const node of mediaTextNodes) {
          const text = cleanText([node.innerText, node.textContent].filter(Boolean).join(" "), 140);
          if (!text || seenMediaText.has(text)) continue;
          seenMediaText.add(text);
          const rect = node.getBoundingClientRect();
          mediaTextBlocks.push({
            text,
            x: Math.round(rect.left - trackRect.left),
            y: Math.round(rect.top - trackRect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          });
          if (mediaTextBlocks.length >= 24) break;
        }
        const mediaImages = visibleImageSources(trackRoot, trackRect).slice(0, 24);
        return {
          ok: true,
          clip: {
            x: Math.max(0, trackRect.left + window.scrollX),
            y: Math.max(0, trackRect.top + window.scrollY),
            width: Math.min(trackRect.width, document.documentElement.scrollWidth, window.innerWidth * 1.4),
            height: trackRect.height
          },
          text: mediaTextBlocks.map((block) => block.text).join(" "),
          textBlocks: mediaTextBlocks,
          images: mediaImages,
          logicalSignature: mediaSignature || state.logicalSignature,
          activeIndex: state.stateIndex,
          visibleItemCount: visibleItems.length,
          visibleItems,
          itemRects: visibleItems.map((item) => ({
            mediaItemId: item.mediaItemId,
            key: item.key,
            label: item.label,
            rect: item.rect
          }))
        };
      }
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
      const productVisibleItems = definition.key === "product-showcase" ? productVisibleCards(root) : [];
      const hoveredProduct = definition.key === "product-showcase" && state.interactionState === "hover"
        ? productVisibleItems.find((card) =>
          card.key === state.hoverItemKey ||
          card.href === state.hoverItemKey ||
          card.label === state.hoverItemLabel ||
          card.text === state.hoverItemLabel
        ) || null
        : null;
      const sceneSignature = definition.key === "scene-explore" ? sceneWindowSignature(root) : "";
      const sceneVisibleItems = definition.key === "scene-explore" ? sceneItems(root) : [];
      const athleteSignature = definition.key === "athletes" ? athleteWindowSignature(root) : "";
      if (definition.key === "product-showcase" && state.windowSignature && productSignature !== state.windowSignature) {
        return {
          ok: false,
          reason: "Visible products did not match planned product showcase window " + state.stateLabel + "."
        };
      }
      if (definition.key === "scene-explore" && state.windowSignature && sceneSignature !== state.windowSignature) {
        return {
          ok: false,
          reason: "Visible scene exploration slides did not match planned scene window " + state.stateLabel + "."
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
          ? (state.interactionState === "hover"
            ? (state.logicalSignature || productSignature)
            : (productSignature || state.logicalSignature))
          : (definition.key === "scene-explore"
            ? sceneSignature || state.logicalSignature
            : (definition.key === "athletes" ? athleteSignature || state.logicalSignature : state.logicalSignature)),
        activeIndex: state.stateIndex,
        visibleItemCount: productVisibleItems.length || sceneVisibleItems.length || null,
        visibleItems: productVisibleItems.length ? productVisibleItems : (sceneVisibleItems.length ? sceneVisibleItems : null),
        itemRects: productVisibleItems.length
          ? productVisibleItems.map((item) => ({
            productItemId: item.key,
            key: item.key,
            label: item.label,
            rect: item.rect
          }))
          : (sceneVisibleItems.length ? sceneVisibleItems.map((item) => ({
            sceneItemId: item.sceneItemId,
            key: item.key,
            label: item.label,
            rect: item.rect
          })) : null),
        interactionState: state.interactionState || "default",
        hoverItemKey: state.hoverItemKey || null,
        hoverItemLabel: state.hoverItemLabel || null,
        hoverItemRect: hoveredProduct?.rect || state.hoverItemRect || null,
        hoveredProduct: hoveredProduct ? {
          key: hoveredProduct.key,
          label: hoveredProduct.label,
          href: hoveredProduct.href,
          text: hoveredProduct.text,
          image: hoveredProduct.image,
          rect: hoveredProduct.rect
        } : null
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
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || 1) > 0.01 &&
          rect.width > 1 &&
          rect.height > 1;
      };
      const intersects = (rect, bounds) => {
        const x = Math.max(0, Math.min(rect.right, bounds.right) - Math.max(rect.left, bounds.left));
        const y = Math.max(0, Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top));
        return x * y;
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
  if (state?.interactionState === "hover") {
    return `${definition.key}|${state.tabIndex || state.tabLabel || "tab"}|hover|${state.hoverItemKey || state.hoverIndex || state.stateLabel || "item"}`;
  }
  if (definition.mode === "tabs-carousel") {
    return `${definition.key}|${state.tabIndex || state.tabLabel || "tab"}|default`;
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

function visualAuditForBuffer(buffer, visualHash, similar = null) {
  const quality = imageQualityAuditForBuffer(buffer);
  const audit = {
    status: "ok",
    visualHash,
    sharpness: quality.sharpness,
    contrast: quality.contrast
  };
  const messages = [];

  if (similar && similar.distance <= 3) {
    audit.similarTo = similar.label;
    audit.distance = similar.distance;
    messages.push(`Visual signature is very close to ${similar.label}.`);
  }
  if (quality.status === "warning") {
    audit.qualityStatus = "warning";
    messages.push(quality.message);
  }

  if (messages.length) {
    audit.status = "warning";
    audit.message = messages.join(" ");
  }

  return audit;
}

export function imageQualityAuditForBuffer(buffer) {
  try {
    const image = decodePng(buffer);
    if (image.width < 3 || image.height < 3) {
      return {
        status: "warning",
        sharpness: 0,
        contrast: 0,
        message: "Image is too small for quality audit."
      };
    }

    const maxSamples = 60000;
    const step = Math.max(1, Math.ceil(Math.sqrt((image.width * image.height) / maxSamples)));
    let count = 0;
    let sum = 0;
    let sumSquares = 0;
    let edgeCount = 0;
    let edgeSum = 0;

    for (let y = 0; y < image.height; y += step) {
      for (let x = 0; x < image.width; x += step) {
        const gray = grayAt(image, x, y);
        count += 1;
        sum += gray;
        sumSquares += gray * gray;

        if (x + step < image.width) {
          edgeSum += Math.abs(gray - grayAt(image, x + step, y));
          edgeCount += 1;
        }
        if (y + step < image.height) {
          edgeSum += Math.abs(gray - grayAt(image, x, y + step));
          edgeCount += 1;
        }
      }
    }

    const mean = sum / Math.max(1, count);
    const variance = Math.max(0, (sumSquares / Math.max(1, count)) - mean * mean);
    const contrast = Math.sqrt(variance);
    const sharpness = edgeSum / Math.max(1, edgeCount);
    const roundedSharpness = roundMetric(sharpness);
    const roundedContrast = roundMetric(contrast);

    if (sharpness < 4 && contrast < 18) {
      return {
        status: "warning",
        sharpness: roundedSharpness,
        contrast: roundedContrast,
        message: "Image may be blurry or low detail."
      };
    }

    return {
      status: "ok",
      sharpness: roundedSharpness,
      contrast: roundedContrast
    };
  } catch (error) {
    return {
      status: "warning",
      sharpness: null,
      contrast: null,
      message: `Image quality audit failed: ${error.message}`
    };
  }
}

function grayAt(image, x, y) {
  const sourceX = Math.max(0, Math.min(image.width - 1, x));
  const sourceY = Math.max(0, Math.min(image.height - 1, y));
  const offset = (sourceY * image.width + sourceX) * 4;
  return (
    image.rgba[offset] * 0.299 +
    image.rgba[offset + 1] * 0.587 +
    image.rgba[offset + 2] * 0.114
  );
}

function roundMetric(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
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
  const sectionOrder = ["banner", "navigation", ...homeRelatedSectionDefinitions.map((definition) => definition.key)];
  const sectionA = sectionOrder.indexOf(a.sectionKey);
  const sectionB = sectionOrder.indexOf(b.sectionKey);
  const orderA = sectionA === -1 ? 1000 : sectionA;
  const orderB = sectionB === -1 ? 1000 : sectionB;
  return orderA - orderB ||
    Number(a.tabIndex || 0) - Number(b.tabIndex || 0) ||
    Number(a.hoverIndex || 0) - Number(b.hoverIndex || 0) ||
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
    const hover = await hoverShokzTopNavigationLabel(client, "Products");
    if (!hover?.ok) {
      await hoverShokzProductsMenu(client);
    }
    state = await waitForShokzProductsNavigation(client, false);
  }

  if (!state.ok) {
    if (!viewport.mobile) {
      for (let attempt = 0; attempt < 2 && !state.ok; attempt += 1) {
        await hoverShokzTopNavigationLabel(client, "Products");
        state = await waitForShokzProductsNavigation(client, false);
        if (state.ok) break;
        await hoverShokzProductsMenu(client);
        state = await waitForShokzProductsNavigation(client, false);
      }
    }
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

async function dismissShokzKnownPopupsBeforeScreenshot(client, options = {}) {
  const rounds = Math.max(1, Math.min(6, options.rounds ?? 3));
  const totals = { clicked: [], hidden: [] };
  let remaining = [];
  let clearRounds = 0;
  for (let round = 0; round < rounds; round += 1) {
    const result = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const hideOnly = ${options.hideOnly ? "true" : "false"};
        const hidden = [];
        const clicked = [];
        const remaining = [];
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
          element.innerText,
          element.textContent,
          element.getAttribute?.("aria-label"),
          element.getAttribute?.("title"),
          element.getAttribute?.("name"),
          element.value,
          element.id,
          String(element.className || "")
        ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim() : "";
        const navPanelSelector = "#menu-drawer, .menu-drawer, .mega-menu__content, .product_mega_menu, .product_mega_menu-wrapper, [class*='mega-menu'], header, nav";
        const isNavigationElement = (element) => Boolean(
          element?.matches?.(navPanelSelector) || element?.closest?.(navPanelSelector)
        );
        const containsNavigation = (element) => Boolean(element?.querySelector?.(navPanelSelector));
        const classifyKnownPopup = (text) => {
          const value = String(text || "");
          const cookie = /\\bcookies?\\b/i.test(value) &&
            /(privacy|accept all|necessary cookies|preferences|consent|personalized features)/i.test(value);
          if (cookie) return "cookie";

          const email = /(don.?t miss out|dont miss out|subscribe now|enter your email|email address|newsletter|sign up|primary use case)/i.test(value) &&
            /(email|subscribe|newsletter|great deals|primary use case)/i.test(value);
          if (email) return "email";

          const region = /(redirect|wrong site|ip address|your ip|detected.{0,80}(region|country|location)|shopping from|looks like.{0,80}(country|region|location)|stay on.{0,40}site|continue to.{0,80}(site|store|shokz))/i.test(value);
          if (region) return "region";

          return null;
        };
        const layerState = (element, kind) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const zIndex = Number.parseInt(style.zIndex, 10);
          const area = rect.width * rect.height;
          const roleDialog = /dialog|alertdialog/i.test(element.getAttribute("role") || "");
          const ariaModal = element.getAttribute("aria-modal") === "true";
          const overlayMeta = [
            element.id,
            String(element.className || ""),
            element.getAttribute("role"),
            element.getAttribute("aria-label")
          ].filter(Boolean).join(" ");
          const modalHint = /(modal|dialog|popup|overlay|lightbox|klaviyo|flyout|interstitial)/i.test(overlayMeta);
          const positioned = ["fixed", "sticky", "absolute"].includes(style.position) ||
            (Number.isFinite(zIndex) && zIndex >= 20);
          const bottomCookie = kind === "cookie" &&
            rect.bottom >= window.innerHeight - 4 &&
            rect.width >= window.innerWidth * 0.45 &&
            rect.height >= 70;
          const pageContainer = rect.top <= 80 &&
            rect.height > window.innerHeight * 1.35 &&
            rect.width >= window.innerWidth * 0.85;
          const popupLike = kind === "cookie"
            ? roleDialog || ariaModal || modalHint || positioned || bottomCookie
            : roleDialog || ariaModal || modalHint || positioned;
          return {
            rect,
            area,
            zIndex: Number.isFinite(zIndex) ? zIndex : 0,
            roleDialog,
            bottomCookie,
            pageContainer,
            popupLike
          };
        };
        const interactiveSelector = "button, [role='button'], input[type='button'], input[type='submit'], a, [aria-label], [title], [tabindex]";
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
        const hideElement = (element, reason) => {
          if (!visible(element) ||
              element === document.body ||
              element === document.documentElement ||
              isNavigationElement(element) ||
              containsNavigation(element)) return false;
          element.dataset.pageShotHidden = "true";
          element.style.setProperty("display", "none", "important");
          element.style.setProperty("visibility", "hidden", "important");
          element.style.setProperty("pointer-events", "none", "important");
          hidden.push(reason || textOf(element).slice(0, 80) || element.tagName);
          return true;
        };
        const clickElement = (element, reason) => {
          const target = element?.closest?.(interactiveSelector) || element;
          if (!visible(target) || isNavigationElement(target)) return false;
          if (!target.matches?.(interactiveSelector)) return false;
          if (navigatesAway(target)) return false;
          if (typeof target.click === "function") {
            target.click();
          } else {
            target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          }
          clicked.push(reason || textOf(target).slice(0, 80) || target.tagName);
          return true;
        };
        const layerRootFor = (element) => {
          let current = element;
          while (current && current !== document.body && current !== document.documentElement) {
            if (!visible(current) || isNavigationElement(current) || containsNavigation(current)) {
              current = current.parentElement;
              continue;
            }
            const rect = current.getBoundingClientRect();
            const style = getComputedStyle(current);
            const zIndex = Number.parseInt(style.zIndex, 10);
            const roleDialog = /dialog|alertdialog/i.test(current.getAttribute("role") || "");
            const positioned = ["fixed", "sticky", "absolute"].includes(style.position) ||
              (Number.isFinite(zIndex) && zIndex >= 20);
            const bottomBanner = rect.bottom >= window.innerHeight - 4 &&
              rect.width >= window.innerWidth * 0.45 &&
              rect.height >= 70;
            if (roleDialog || positioned || bottomBanner) {
              return current;
            }
            current = current.parentElement;
          }
          return element;
        };
        const candidates = [];
        const seen = new Set();
        for (const element of Array.from(document.querySelectorAll("body *"))) {
          if (!visible(element) || element.dataset.pageShotHidden === "true" || isNavigationElement(element)) continue;
          const kind = classifyKnownPopup(textOf(element));
          if (!kind) continue;
          const layer = layerRootFor(element);
          if (!visible(layer) || isNavigationElement(layer) || containsNavigation(layer) || seen.has(layer)) continue;
          const state = layerState(layer, kind);
          if (state.pageContainer && !state.roleDialog && !state.bottomCookie) continue;
          if (!state.popupLike) continue;
          seen.add(layer);
          candidates.push({ layer, kind, area: state.area, zIndex: state.zIndex });
        }
        const priority = { cookie: 0, email: 1, region: 2 };
        const layers = candidates.sort((a, b) =>
          (priority[a.kind] - priority[b.kind]) ||
          (b.zIndex - a.zIndex) ||
          (b.area - a.area)
        );
        const closeMatches = /close|dismiss|no thanks|not now|icon-close|\\u00d7|^x$/i;
        const safeRegionControl = /close|dismiss|stay|stay on|not now|no thanks|cancel|keep/i;
        const unsafeRegionControl = /continue to|go to|visit|redirect|switch|shop|change/i;
        const controlText = (control) => textOf(control).slice(0, 240);
        const findControls = (layer) => Array.from(layer.querySelectorAll(interactiveSelector + ", svg, [class], [id]"))
          .filter((control) => visible(control) && !isNavigationElement(control));
        const nearTopRight = (control, layerRect) => {
          const rect = control.getBoundingClientRect();
          return rect.width <= 96 &&
            rect.height <= 96 &&
            rect.left >= layerRect.right - Math.max(140, layerRect.width * 0.3) &&
            rect.top <= layerRect.top + Math.max(140, layerRect.height * 0.3);
        };
        const hideRelatedBackdrop = (layer, kind) => {
          const layerRect = layer.getBoundingClientRect();
          for (const element of Array.from(document.querySelectorAll("body *"))) {
            if (!visible(element) || element.dataset.pageShotHidden === "true" || isNavigationElement(element) || containsNavigation(element)) continue;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const zIndex = Number.parseInt(style.zIndex, 10);
            const area = rect.width * rect.height;
            const coversViewport = area >= viewportArea * 0.45 &&
              rect.left <= 8 &&
              rect.top <= 8 &&
              rect.right >= window.innerWidth - 8 &&
              rect.bottom >= window.innerHeight - 8;
            const overlapsLayer = Math.max(0, Math.min(rect.right, layerRect.right) - Math.max(rect.left, layerRect.left)) *
              Math.max(0, Math.min(rect.bottom, layerRect.bottom) - Math.max(rect.top, layerRect.top)) > 400;
            const overlayLike = ["fixed", "absolute"].includes(style.position) ||
              (Number.isFinite(zIndex) && zIndex >= 20);
            if (element !== layer && overlayLike && (coversViewport || (kind !== "cookie" && overlapsLayer && area >= layerRect.width * layerRect.height))) {
              hideElement(element, kind + " backdrop");
            }
          }
        };

        for (const item of layers) {
          const { layer, kind } = item;
          const layerRect = layer.getBoundingClientRect();
          const controls = findControls(layer);
          let closed = false;
          if (kind === "cookie") {
            for (const pattern of [/^accept all$/i, /accept all/i, /use necessary cookies only/i]) {
              const control = controls.find((candidate) => pattern.test(controlText(candidate)));
              if (control) {
                closed = clickElement(control, "cookie consent");
                if (closed) break;
              }
            }
          } else if (kind === "email") {
            for (const control of controls) {
              const text = controlText(control);
              if (closeMatches.test(text) || nearTopRight(control, layerRect)) {
                closed = clickElement(control, text || "email popup close");
                if (closed) break;
              }
            }
          } else if (kind === "region") {
            for (const control of controls) {
              const text = controlText(control);
              if (unsafeRegionControl.test(text)) continue;
              if (safeRegionControl.test(text) || nearTopRight(control, layerRect)) {
                closed = clickElement(control, text || "region popup close");
                if (closed) break;
              }
            }
          }
          if (!closed) {
            hideRelatedBackdrop(layer, kind);
            hideElement(layer, kind + " popup");
          }
        }

        for (const element of Array.from(document.querySelectorAll("body *"))) {
          if (!visible(element) || element.dataset.pageShotHidden === "true" || isNavigationElement(element) || containsNavigation(element)) continue;
          const kind = classifyKnownPopup(textOf(element));
          if (!kind) continue;
          const state = layerState(element, kind);
          if (state.pageContainer && !state.bottomCookie) continue;
          if (state.popupLike) {
            remaining.push({
              kind,
              text: textOf(element).slice(0, 120),
              rect: {
                left: Math.round(state.rect.left),
                top: Math.round(state.rect.top),
                width: Math.round(state.rect.width),
                height: Math.round(state.rect.height)
              }
            });
          }
        }
        document.body.classList.remove("overflow-hidden");
        return { hidden, clicked, remaining: remaining.slice(0, 8) };
      })()`,
      returnByValue: true
    }).catch(() => null);
    const value = result?.result?.value || {};
    totals.clicked.push(...(value.clicked || []));
    totals.hidden.push(...(value.hidden || []));
    remaining = value.remaining || [];
    const changed = (value.hidden?.length || 0) + (value.clicked?.length || 0);
    if (!remaining.length) {
      clearRounds += 1;
      if (clearRounds >= 2) {
        await sleep(changed ? 450 : 100);
        return { ok: true, ...totals, remaining: [], remainingKinds: [] };
      }
      await sleep(changed ? 650 : 450);
      continue;
    }
    clearRounds = 0;
    await sleep(changed ? 500 : 180);
  }
  return {
    ok: remaining.length === 0,
    ...totals,
    remaining,
    remainingKinds: [...new Set(remaining.map((item) => item.kind).filter(Boolean))]
  };
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
      const drawer = document.querySelector("#menu-drawer, .menu-drawer");
      const drawerVisible = Boolean(drawer && visible(drawer));
      const drawerFullText = drawer ? textOf(drawer) : "";
      const drawerText = drawerFullText.slice(0, 220);
      const drawerCategoryHits = categories.filter((value) => includesLabel(drawerFullText, value)).length;
      const drawerTaxonomyHits = desktopTaxonomy.filter((value) => includesLabel(drawerFullText, value)).length;
      const drawerUtilityHits = utilityLinks.filter((value) => includesLabel(drawerFullText, value)).length;
      const drawerTopLevelHits = mobileTopLevel.filter((value) => includesLabel(drawerFullText, value)).length;
      const desktopDrawerOk = drawerVisible &&
        includesLabel(drawerFullText, "Products") &&
        drawerCategoryHits >= 1 &&
        (drawerTaxonomyHits >= 1 || drawerUtilityHits >= 1 || /OPENRUN|OPENSWIM|OPENMOVE|OPENFIT/i.test(drawerFullText));
      const mobileDrawerOk = drawerVisible &&
        includesLabel(drawerFullText, "Products") &&
        drawerCategoryHits >= 3 &&
        drawerTopLevelHits >= 1;
      const mobileOk = !searchOpen &&
        !cartOpen &&
        window.scrollY < 20 &&
        (
          (
            includesLabel(best.text, "Products") &&
            best.categoryHits >= 3 &&
            best.topLevelHits >= 1 &&
            best.mobilePanelLike
          ) ||
          mobileDrawerOk
        );
      const desktopOk = !searchOpen &&
        !cartOpen &&
        window.scrollY < 20 &&
        includesLabel(best.text, "Products") &&
        best.categoryHits >= 2 &&
        (best.taxonomyHits >= 1 || best.panelLike) ||
        (!searchOpen && !cartOpen && window.scrollY < 20 && desktopDrawerOk);
      return {
        ok: mobile ? mobileOk : desktopOk,
        visibleText: best.text.slice(0, 260),
        categoryHits: Math.max(best.categoryHits, drawerCategoryHits),
        taxonomyHits: Math.max(best.taxonomyHits, drawerTaxonomyHits),
        utilityHits: Math.max(best.utilityHits, drawerUtilityHits),
        topLevelHits: Math.max(best.topLevelHits, drawerTopLevelHits),
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
    if (options.dismissObstructionsBeforeSegment !== false) {
      await dismissObstructions(client, { rounds: index === 0 ? 4 : 2 });
    }
    await sleep(160);
    if (index === 0 && typeof options.beforeFirstSegmentCapture === "function") {
      await options.beforeFirstSegmentCapture();
    }
    if (typeof options.beforeSegmentCapture === "function") {
      await options.beforeSegmentCapture(index);
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

async function captureFullPageClipScreenshot(client, outputPath, options) {
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: Math.ceil(options.width),
      height: Math.ceil(options.height),
      scale: 1
    }
  });
  await fs.writeFile(outputPath, screenshot.data, "base64");
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
  await materializeFullPageContent(client);

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
  await materializeFullPageContent(client);
  state = await getPageState(client);

  return { ...state, scrolls };
}

async function materializeFullPageContent(client) {
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const eagerImageAttrs = ["data-src", "data-original", "data-lazy-src"];
      const eagerSrcSetAttrs = ["data-srcset", "data-lazy-srcset"];
      const eagerBackgroundAttrs = [
        "data-bg",
        "data-background",
        "data-background-image",
        "data-lazy-background",
        "data-bg-image",
        "data-desktop-bg",
        "data-mobile-bg"
      ];
      const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(true)));
      const decodeImage = (img) => {
        if (!(img instanceof HTMLImageElement)) return Promise.resolve(true);
        if (img.complete && img.naturalWidth > 0) return Promise.resolve(true);
        if (typeof img.decode === "function") {
          return Promise.race([
            img.decode().catch(() => true),
            new Promise((resolve) => setTimeout(resolve, 1200))
          ]);
        }
        return new Promise((resolve) => {
          const done = () => resolve(true);
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", done, { once: true });
          setTimeout(done, 1200);
        });
      };
      return (async () => {
        let forcedVisible = 0;
        let eagerBackgrounds = 0;

        document.querySelectorAll("img[loading='lazy']").forEach((img) => {
          img.loading = "eager";
          img.setAttribute("loading", "eager");
        });

        for (const img of document.querySelectorAll("img")) {
          if (!img.getAttribute("decoding")) {
            img.setAttribute("decoding", "sync");
          }
          if (!img.getAttribute("fetchpriority")) {
            img.setAttribute("fetchpriority", "high");
          }
          for (const attr of eagerImageAttrs) {
            const value = img.getAttribute(attr);
            if (value && !img.getAttribute("src")) {
              img.setAttribute("src", value);
            }
          }
          for (const attr of eagerSrcSetAttrs) {
            const value = img.getAttribute(attr);
            if (value && !img.getAttribute("srcset")) {
              img.setAttribute("srcset", value);
            }
          }
        }

        for (const element of document.querySelectorAll("body *")) {
          if (!(element instanceof HTMLElement)) continue;
          const style = getComputedStyle(element);
          if (style.contentVisibility === "auto") {
            element.style.setProperty("content-visibility", "visible", "important");
            element.style.setProperty("contain-intrinsic-size", "auto", "important");
            forcedVisible += 1;
          }
          if ((!style.backgroundImage || style.backgroundImage === "none")) {
            for (const attr of eagerBackgroundAttrs) {
              const value = element.getAttribute(attr);
              if (!value) continue;
              element.style.setProperty("background-image", value.startsWith("url(") ? value : \`url("\${value}")\`, "important");
              eagerBackgrounds += 1;
              break;
            }
          }
        }

        if (document.fonts?.ready) {
          await Promise.race([
            document.fonts.ready.catch(() => true),
            new Promise((resolve) => setTimeout(resolve, 1200))
          ]);
        }
        await Promise.all(Array.from(document.images || []).map((img) => decodeImage(img)));
        window.dispatchEvent(new Event("resize"));
        await waitFrame();
        await waitFrame();
        window.dispatchEvent(new Event("scroll"));
        await waitFrame();
        await waitFrame();
        return { ok: true, forcedVisible, eagerBackgrounds, images: document.images.length };
      })();
    })()`,
    awaitPromise: true,
    returnByValue: true
  }).catch(() => null);
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
