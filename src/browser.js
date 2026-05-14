import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CdpClient } from "./cdp.js";
import { decodePng, encodePng } from "./png.js";
import { blankImageAuditForBuffer, hashBuffer, imageQualityAuditForBuffer, nearestVisualHash, visualAuditForBuffer, visualHashForBuffer } from "./image-audit.js";
import {
  findShokzCollectionRelatedSectionDefinition,
  findShokzComparisonRelatedSectionDefinition,
  findShokzHomeRelatedSectionDefinition,
  shokzHomeRelatedSectionDefinitions as importedShokzHomeRelatedSectionDefinitions,
  shokzMediaTrackDefinitions,
  shokzMobileNavigationSecondaryStateDefinitions,
  shokzNavigationTopLabels,
  shokzProductsNavigationCategoryLabels,
  shokzRelatedSectionOrder
} from "./shokz-capture-specs.js";
export { blankImageAuditForBuffer, imageQualityAuditForBuffer } from "./image-audit.js";

const defaultTimeoutMs = 45000;
const pageShotMotionFreezeStateKey = "__pageShotMotionFreeze";
const pageShotMotionFreezeStyleId = "__pageShotMotionFreezeStyle";

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

function capturePlatform(options = {}, viewport = {}) {
  const explicit = String(options?.platform || "").trim().toLowerCase();
  if (explicit === "mobile" || explicit === "pc") {
    return explicit;
  }
  return viewport.mobile ? "mobile" : "pc";
}

function viewportForCaptureContext(captureContext = {}) {
  return captureContext?.viewport || captureContext || {};
}

function isMobileCaptureContext(captureContext = {}) {
  const explicit = String(captureContext?.platform || "").trim().toLowerCase();
  if (explicit === "mobile" || explicit === "pc") {
    return explicit === "mobile";
  }

  const viewport = viewportForCaptureContext(captureContext);
  return Boolean(viewport.mobile);
}

async function driveCapture(client, url, outputPath, options) {
  const viewport = options.viewport || { width: 1440, height: 1000 };
  const platform = capturePlatform(options, viewport);
  const captureContext = { viewport, platform };
  const mobile = platform === "mobile";
  const urlCheck = {
    requestedUrl: url,
    finalUrl: "",
    ok: false,
    checks: []
  };
  const cleanShokzKnownPopups = shouldCleanShokzKnownPopups(url, options);
  const deferShokzMobileNavDismiss = options.captureMode === "shokz-products-nav" && mobile;
  let stage = "initializing";
  try {
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  // The preset width/height are CSS pixels: keep the screenshot output at
  // that same visible size, otherwise high-DPI mobile DPR crops the left edge.
  await client.send("Emulation.setDeviceMetricsOverride", {
    mobile,
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
    await openShokzProductsNavigation(client, captureContext);
    if (deferShokzMobileNavDismiss) {
      await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 3, hideOnly: true });
    }
    await verifyCurrentUrl(client, url, "after opening Shokz products navigation", urlCheck);
  }

  if (options.captureMode === "shokz-collection-page") {
    stage = "activating Shokz collection All tab";
    const activation = await activateShokzCollectionTab(client, {
      clickLabel: "All",
      stateLabel: "All"
    });
    if (!activation.ok) {
      throw new Error(activation.reason || "Could not activate Shokz collection All tab.");
    }
    const ready = await waitForShokzCollectionTabActivated(client, {
      clickLabel: "All",
      stateLabel: "All"
    });
    if (!ready.ok) {
      throw new Error(ready.reason || "Shokz collection All tab did not become active.");
    }
    await sleep(700);
    await primeLazyImages(client);
    await expandShokzCollectionViewMoreControls(client, {
      captureUrl: url,
      captureMode: options.captureMode,
      dismissPopups: options.dismissPopups,
      clickDelayMs: options.scrollStepMs ?? 350
    });
    await scrollTo(client, 0);
    await sleep(500);
    if (options.dismissPopups !== false) {
      await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 2 });
      await dismissObstructions(client, { rounds: 2 });
    }
    await verifyCurrentUrl(client, url, "after activating Shokz collection All tab", urlCheck);
  }

  if (
    options.captureMode === "shokz-home-banners" ||
    options.captureMode === "shokz-home-related" ||
    options.captureMode === "shokz-products-nav-related" ||
    options.captureMode === "shokz-home-related-section" ||
    options.captureMode === "shokz-collection-related-section" ||
    options.captureMode === "shokz-comparison-related-section"
  ) {
    stage = "reading page title";
    const titleResult = await readPageTitle(client);
    stage = options.captureMode === "shokz-products-nav-related"
      ? "capturing Shokz products navigation states"
      : options.captureMode === "shokz-collection-related-section"
        ? `capturing Shokz collection related section ${options.sectionKey || ""}`.trim()
      : options.captureMode === "shokz-comparison-related-section"
        ? `capturing Shokz comparison related section ${options.sectionKey || ""}`.trim()
      : options.captureMode === "shokz-home-related-section"
        ? `capturing Shokz home related section ${options.sectionKey || ""}`.trim()
      : options.captureMode === "shokz-home-related"
        ? "capturing Shokz home related sections"
        : "capturing Shokz home banners";
    let relatedCapture;
    if (options.captureMode === "shokz-products-nav-related") {
      relatedCapture = await captureShokzProductsNavigationRelated(client, outputPath, captureContext);
    } else if (options.captureMode === "shokz-collection-related-section") {
      const definition = findShokzCollectionRelatedSectionDefinition(options.sectionKey);
      if (!definition) {
        throw new Error(`Unknown Shokz collection related section: ${options.sectionKey || "(missing)"}.`);
      }
      const sectionCapture = await captureShokzCollectionRelatedSection(client, outputPath, captureContext, definition);
      relatedCapture = {
        width: sectionCapture.width,
        height: sectionCapture.height,
        captures: sectionCapture.captures,
        relatedValidation: {
          status: sectionCapture.warnings.length ? "warning" : "ok",
          warnings: sectionCapture.warnings,
          sections: [{
            sectionKey: definition.key,
            sectionLabel: definition.sectionLabel,
            expectedCount: sectionCapture.expectedCount,
            capturedCount: sectionCapture.capturedCount,
            savedCount: sectionCapture.captures.length,
            status: sectionCapture.warnings.length ? "warning" : "ok"
          }]
        }
      };
    } else if (options.captureMode === "shokz-comparison-related-section") {
      const definition = findShokzComparisonRelatedSectionDefinition(options.sectionKey);
      if (!definition) {
        throw new Error(`Unknown Shokz comparison related section: ${options.sectionKey || "(missing)"}.`);
      }
      const sectionCapture = await captureShokzComparisonRelatedSection(client, outputPath, captureContext, definition);
      relatedCapture = {
        width: sectionCapture.width,
        height: sectionCapture.height,
        captures: sectionCapture.captures,
        relatedValidation: {
          status: sectionCapture.warnings.length ? "warning" : "ok",
          warnings: sectionCapture.warnings,
          sections: [{
            sectionKey: definition.key,
            sectionLabel: definition.sectionLabel,
            expectedCount: sectionCapture.expectedCount,
            capturedCount: sectionCapture.capturedCount,
            savedCount: sectionCapture.captures.length,
            status: sectionCapture.warnings.length ? "warning" : "ok"
          }]
        }
      };
    } else if (options.captureMode === "shokz-home-related-section") {
      const definition = findShokzHomeRelatedSectionDefinition(options.sectionKey);
      if (!definition) {
        throw new Error(`Unknown Shokz home related section: ${options.sectionKey || "(missing)"}.`);
      }
      const sectionCapture = await captureShokzHomeRelatedSection(client, outputPath, captureContext, definition);
      relatedCapture = {
        width: sectionCapture.width,
        height: sectionCapture.height,
        captures: sectionCapture.captures,
        relatedValidation: {
          status: sectionCapture.warnings.length ? "warning" : "ok",
          warnings: sectionCapture.warnings,
          sections: [{
            sectionKey: definition.key,
            sectionLabel: definition.sectionLabel,
            expectedCount: sectionCapture.expectedCount,
            capturedCount: sectionCapture.capturedCount,
            savedCount: sectionCapture.captures.length,
            status: sectionCapture.warnings.length ? "warning" : "ok"
          }]
        }
      };
    } else if (options.captureMode === "shokz-home-related") {
      relatedCapture = await captureShokzHomeRelated(client, outputPath, captureContext);
    } else {
      relatedCapture = await captureShokzHomeBanners(client, outputPath, viewport);
    }
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
    stage = shouldUseDedicatedViewMoreExpansion(options)
      ? "preparing expanded comparison full-page capture"
      : "scrolling to trigger lazy content";
    scrollInfo = shouldUseDedicatedViewMoreExpansion(options)
      ? await prepareExpandedShokzComparisonFullPage(client, {
        ...options,
        captureUrl: url
      })
      : await prepareFullPage(client, {
        ...options,
        captureUrl: url
      });
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

  if (options.fullPage && shouldUseDedicatedViewMoreExpansion(options)) {
    stage = "expanding comparison page tech specs";
    const expandedState = await ensureShokzComparisonPageExpandedForFullPageCapture(client, {
      captureUrl: url,
      captureMode: options.captureMode,
      dismissPopups: options.dismissPopups
    });
    if (expandedState) {
      const expandedHeight = Math.max(0, Number(expandedState.height || 0));
      const reachableHeight = Math.max(
        expandedHeight,
        Number(scrollInfo?.reachableHeight || 0),
        Number(scrollInfo?.height || 0)
      );
      scrollInfo = {
        ...(scrollInfo || {}),
        ...expandedState,
        reachableHeight
      };
    }
    await verifyCurrentUrl(client, url, "after expanding comparison page tech specs", urlCheck);
  }

  stage = "reading page title";
  const titleResult = await readPageTitle(client);

  stage = "measuring page";
  const metrics = await client.send("Page.getLayoutMetrics");
  const contentSize = metrics.cssContentSize || metrics.contentSize || {};
  const pageWidth = Math.max(viewport.width, Math.ceil(contentSize.width || viewport.width));
  let pageHeight = Math.max(viewport.height, Math.ceil(contentSize.height || viewport.height));
  if (options.fullPage && Number.isFinite(scrollInfo?.reachableHeight)) {
    const reachableHeight = Math.max(viewport.height, Math.ceil(scrollInfo.reachableHeight));
    pageHeight = shouldUseDedicatedViewMoreExpansion(options)
      ? Math.max(pageHeight, reachableHeight)
      : Math.min(pageHeight, reachableHeight);
  }
  const maxHeight = options.maxFullPageHeight || 16000;
  const clipHeight = options.fullPage ? Math.min(pageHeight, maxHeight) : viewport.height;
  const clipWidth = options.fullPage ? pageWidth : viewport.width;
  let captureHeight = clipHeight;

  stage = "capturing screenshot";
  let captureBuffer = null;
  let captureValidation = null;
  if (options.fullPage) {
    const guardShokzSearchOverlay = shouldGuardShokzSearchOverlay(url, viewport, options);
    if (shouldUseDirectFullPageClipCapture(options)) {
      await freezePageMotion(client);
      try {
        const clipCapture = shouldUseDedicatedViewMoreExpansion(options)
          ? await captureExpandedShokzComparisonFullPageScreenshot(client, outputPath, {
            width: clipWidth,
            height: clipHeight,
            viewportHeight: viewport.height,
            maxHeight,
            guardSearchOverlay: guardShokzSearchOverlay,
            shokzKnownPopups: cleanShokzKnownPopups
          })
          : await captureFullPageClipScreenshot(client, outputPath, {
            width: clipWidth,
            height: clipHeight,
            label: "Shokz collection full-page screenshot",
            beforeAttempt: async ({ attempt }) => {
              if (attempt > 1) {
                await materializeFullPageContent(client);
              }
              await prepareForScreenshotCapture(client, {
                rounds: viewport.mobile ? 5 : 2,
                shokzKnownPopups: cleanShokzKnownPopups,
                guardSearchOverlay: guardShokzSearchOverlay,
                stage: viewport.mobile
                  ? "before mobile full-page clip screenshot capture"
                  : "before full-page clip screenshot capture"
              });
              if (guardShokzSearchOverlay) {
                await ensureShokzSearchOverlayClosed(client, "before full-page clip screenshot capture");
              }
              await scrollTo(client, 0);
              await settlePositionedViewport(client, {
                delayMs: attempt > 1 ? 280 : 180,
                frames: 2
              });
            }
          });
        captureBuffer = clipCapture.buffer;
        captureValidation = clipCapture.captureValidation;
        captureHeight = clipCapture.height || clipHeight;
        pageHeight = Math.max(pageHeight, captureHeight);
        if (clipCapture.pageState) {
          scrollInfo = {
            ...(scrollInfo || {}),
            ...clipCapture.pageState,
            reachableHeight: Math.max(
              Number(scrollInfo?.reachableHeight || 0),
              Number(clipCapture.pageState.height || 0)
            )
          };
        }
      } finally {
        await restorePageMotion(client);
      }
    } else {
      if (guardShokzSearchOverlay) {
        await ensureShokzSearchOverlayClosed(client, "before screenshot capture");
      }
      const beforeSegmentCapture = async ({ attempt } = {}) => {
        if (viewport.mobile && attempt > 1) {
          await materializeFullPageContent(client);
          await prepareForScreenshotCapture(client, {
            rounds: 5,
            shokzKnownPopups: cleanShokzKnownPopups,
            guardSearchOverlay: guardShokzSearchOverlay,
            stage: "after mobile full-page content materialization"
          });
          await sleep(220);
        }
        await prepareForScreenshotCapture(client, {
          rounds: viewport.mobile ? 5 : 2,
          shokzKnownPopups: cleanShokzKnownPopups,
          guardSearchOverlay: guardShokzSearchOverlay,
          stage: viewport.mobile
            ? "before mobile stitched segment screenshot capture"
            : "before stitched segment screenshot capture"
        });
      };
      await freezePageMotion(client);
      try {
        const stitchedCapture = await captureStitchedScreenshot(client, outputPath, {
          width: clipWidth,
          height: clipHeight,
          viewportHeight: viewport.height,
          stepDelay: options.scrollStepMs ?? 350,
          dismissObstructionsBeforeSegment: !cleanShokzKnownPopups,
          hideFixedElementsAfterFirstSegment: options.hideFixedElementsAfterFirstSegment !== false,
          beforeSegmentCapture,
          beforeFirstSegmentCapture: guardShokzSearchOverlay
            ? () => ensureShokzSearchOverlayClosed(client, "before first segment screenshot capture")
            : null,
          afterSegmentPositioned: async ({ isLastSegment }) => {
            if (cleanShokzKnownPopups) {
              await dismissShokzKnownPopupsBeforeScreenshot(client, {
                rounds: isLastSegment ? 4 : 2,
                hideOnly: true
              });
            }
            if (guardShokzSearchOverlay) {
              await ensureShokzSearchOverlayClosed(client, "after stitched segment positioning");
            }
            await freezePageMotion(client);
            await settlePositionedViewport(client, {
              delayMs: isLastSegment ? 520 : 140,
              frames: isLastSegment ? 4 : 2
            });
          }
        });
        const finalizedCapture = mobile && cleanShokzKnownPopups
          ? await patchShokzMobileFooterInStitchedCapture(client, url, stitchedCapture, {
            outputPath,
            viewportHeight: viewport.height,
            waitAfterLoadMs: options.waitAfterLoadMs ?? 2500,
            guardSearchOverlay: guardShokzSearchOverlay
          })
          : stitchedCapture;
        captureBuffer = finalizedCapture.buffer;
        captureValidation = finalizedCapture.captureValidation;
        captureHeight = finalizedCapture.height || clipHeight;
      } finally {
        await restorePageMotion(client);
      }
    }
  } else {
    if (options.captureMode === "shokz-products-nav") {
      await prepareShokzNavigationMainScreenshot(client, captureContext);
    } else {
      await prepareForScreenshotCapture(client, {
        rounds: 2,
        shokzKnownPopups: cleanShokzKnownPopups,
        guardSearchOverlay: shouldGuardShokzSearchOverlay(url, viewport, options),
        stage: "before screenshot capture"
      });
    }
    const screenshotCapture = await captureScreenshotWithValidation(client, {
      format: "png",
      fromSurface: true
    }, {
      label: options.captureMode || "page screenshot",
      beforeAttempt: async ({ attempt }) => {
        if (attempt === 1) {
          return;
        }
        if (options.captureMode === "shokz-products-nav") {
          await prepareShokzNavigationMainScreenshot(client, captureContext);
          return;
        }
        await prepareForScreenshotCapture(client, {
          rounds: 2,
          shokzKnownPopups: cleanShokzKnownPopups,
          guardSearchOverlay: shouldGuardShokzSearchOverlay(url, viewport, options),
          stage: "retrying screenshot capture after blank validation"
        });
      }
    });
    captureBuffer = screenshotCapture.buffer;
    captureValidation = screenshotCapture.captureValidation;
    await fs.writeFile(outputPath, captureBuffer);
  }
  const finalUrl = await verifyCurrentUrl(client, url, "after screenshot capture", urlCheck);
  urlCheck.ok = true;
  const visualHash = captureBuffer ? visualHashForBuffer(captureBuffer) : null;
  const visualAudit = captureBuffer && visualHash ? visualAuditForBuffer(captureBuffer, visualHash) : null;

  return {
    requestedUrl: url,
    finalUrl,
    urlCheck,
    title: titleResult,
    width: clipWidth,
    height: captureHeight,
    fullPageHeight: pageHeight,
    truncated: options.fullPage ? pageHeight > captureHeight : false,
    scrollInfo,
    visualHash,
    visualAudit,
    captureValidation
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

function shouldUseDirectFullPageClipCapture(options = {}) {
  const captureMode = String(options.captureMode || "").trim();
  return captureMode === "shokz-collection-page" ||
    captureMode === "shokz-comparison-page";
}

function shouldUseDedicatedViewMoreExpansion(options = {}) {
  return String(options.captureMode || "").trim() === "shokz-comparison-page";
}

function isViewMoreLabel(value) {
  const normalized = String(value || "")
    .replace(/[\u00a0\s]+/g, " ")
    .replace(/[\u25bc\u25be\u25bf\u2228\u203a\u00bb>]+/g, " ")
    .trim();
  return /^view more\b/i.test(normalized);
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
    labelPrefix: "心声",
    expectedPages: 4
  }
];

async function captureShokzHomeRelated(client, outputPath, captureContext) {
  const viewport = viewportForCaptureContext(captureContext);
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

  for (const definition of importedShokzHomeRelatedSectionDefinitions) {
    try {
      const sectionCapture = await captureShokzHomeRelatedSection(client, outputPath, captureContext, definition);
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

  sections.sort(compareRelatedSectionEntries);

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

async function captureShokzProductsNavigationRelated(client, outputPath, captureContext) {
  const viewport = viewportForCaptureContext(captureContext);
  await scrollTo(client, 0);
  await sleep(700);
  await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 3, hideOnly: true });

  if (isMobileCaptureContext(captureContext)) {
    return captureShokzMobileNavigationRelated(client, outputPath, captureContext);
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
        await openShokzProductsNavigation(client, captureContext);
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

async function captureShokzMobileNavigationRelated(client, outputPath, captureContext) {
  const viewport = viewportForCaptureContext(captureContext);
  const captures = [];
  const warnings = [];
  const seenVisual = new Set();
  const mainSeed = await visualSeedForFile(outputPath);
  const expectedCount = shokzMobileNavigationSecondaryStateDefinitions.length;

  await openShokzProductsNavigation(client, captureContext);

  for (const definition of shokzMobileNavigationSecondaryStateDefinitions) {
    try {
      await saveShokzNavigationCapture(client, outputPath, viewport, {
        navigationLevel: "secondary",
        topLevelLabel: definition.topLevelLabel,
        topLevelIndex: definition.topLevelIndex,
        tabLabel: definition.tabLabel,
        tabIndex: definition.tabIndex,
        hoverItemKey: definition.hoverItemKey,
        hoverItemLabel: definition.hoverItemLabel,
        hoverItemRect: null,
        hoverPoint: null,
        hoverIndex: definition.hoverIndex,
        stateLabel: definition.stateLabel,
        fileId: definition.fileId,
        skipMainDuplicate: false,
        restoreMode: "mobile-tap",
        activationLabel: definition.clickLabel
      }, { captures, warnings, seenVisual, mainSeed });
    } catch (error) {
      warnings.push({
        sectionKey: "navigation",
        sectionLabel: "Navigation",
        stateLabel: definition.stateLabel,
        message: error.message
      });
    }
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

  let mobileLongCapture = null;
  const useMobileLongCapture = state.restoreMode === "mobile-tap" &&
    isProductsNavigationLabel(state.topLevelLabel || state.tabLabel);
  if (useMobileLongCapture) {
    mobileLongCapture = await prepareShokzMobileNavigationExpandedCapture(client);
  }
  const screenshotCapture = useMobileLongCapture
    ? await captureScreenshotWithValidation(client, () => ({
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip: mobileLongCapture.clip
      }), {
        label: `navigation ${state.stateLabel}`,
        acceptBlankAudit: (blankAudit) => shouldAcceptShokzNavigationBlankAudit(state, current, blankAudit),
        beforeAttempt: async ({ attempt }) => {
          if (attempt === 1) {
            mobileLongCapture = await prepareShokzMobileNavigationExpandedCapture(client);
            return;
          }
          await prepareShokzNavigationRelatedScreenshot(client, state, viewport);
          const retryCleanup = await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 5, hideOnly: true });
          if (!retryCleanup.ok) {
            throw new Error(`Known popup remained before navigation retry screenshot: ${formatKnownPopupRemaining(retryCleanup)}.`);
          }
          mobileLongCapture = await prepareShokzMobileNavigationExpandedCapture(client);
        }
      })
    : await captureScreenshotWithValidation(client, {
        format: "png",
        fromSurface: true
      }, {
        label: `navigation ${state.stateLabel}`,
        acceptBlankAudit: (blankAudit) => shouldAcceptShokzNavigationBlankAudit(state, current, blankAudit),
        beforeAttempt: async ({ attempt }) => {
          if (attempt === 1) {
            return;
          }
          await prepareShokzNavigationRelatedScreenshot(client, state, viewport);
          const retryCleanup = await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 5, hideOnly: true });
          if (!retryCleanup.ok) {
            throw new Error(`Known popup remained before navigation retry screenshot: ${formatKnownPopupRemaining(retryCleanup)}.`);
          }
        }
      });
  const buffer = screenshotCapture.buffer;
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
    captureValidation: screenshotCapture.captureValidation,
    clip: {
      x: 0,
      y: 0,
      width: imageSize.width,
      height: imageSize.height
    },
    scrollInfo: mobileLongCapture
      ? {
          viewportHeight: mobileLongCapture.viewportHeight,
          reachableHeight: mobileLongCapture.contentHeight
        }
      : null,
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

function shouldAcceptShokzNavigationBlankAudit(state, current, blankAudit) {
  if (blankAudit?.status !== "blank") {
    return false;
  }
  if (blankAudit?.fullImageNearWhite) {
    return false;
  }
  if (state?.restoreMode !== "mobile-tap") {
    return false;
  }
  const panelText = comparableNavigationLabel(current?.text || "");
  const targetKey = comparableNavigationLabel(state?.hoverItemLabel || state?.topLevelLabel || state?.tabLabel || "");
  const textBlockCount = Array.isArray(current?.textBlocks) ? current.textBlocks.length : 0;
  const visibleItemCount = Number(current?.visibleItemCount || current?.itemCount || 0);
  if (!targetKey || !panelText.includes(targetKey)) {
    return false;
  }
  if (isProductsNavigationLabel(state?.topLevelLabel || state?.tabLabel)) {
    const imageCount = Array.isArray(current?.images) ? current.images.length : 0;
    return textBlockCount >= 10 && visibleItemCount >= 5 && imageCount >= 2;
  }
  return textBlockCount >= 5 && visibleItemCount >= 4;
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

async function freezePageMotion(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const stateKey = ${JSON.stringify(pageShotMotionFreezeStateKey)};
      const styleId = ${JSON.stringify(pageShotMotionFreezeStyleId)};
      const styleText = [
        "html, body { scroll-behavior: auto !important; }",
        "*, *::before, *::after {",
        "  animation-play-state: paused !important;",
        "  transition-duration: 0s !important;",
        "  transition-delay: 0s !important;",
        "  transition-property: none !important;",
        "  scroll-behavior: auto !important;",
        "}"
      ].join("\\n");
      const state = window[stateKey] && typeof window[stateKey] === "object"
        ? window[stateKey]
        : {
          animations: [],
          videos: [],
          swipers: [],
          slicks: []
        };

      let style = document.getElementById(styleId);
      if (!(style instanceof HTMLStyleElement)) {
        style = document.createElement("style");
        style.id = styleId;
        style.textContent = styleText;
        (document.head || document.documentElement).appendChild(style);
      } else if (style.textContent !== styleText) {
        style.textContent = styleText;
      }

      const animations = typeof document.getAnimations === "function"
        ? (() => {
          try {
            return document.getAnimations({ subtree: true });
          } catch {
            return document.getAnimations();
          }
        })()
        : [];
      const trackedAnimations = Array.isArray(state.animations) ? state.animations : [];
      const seenAnimations = new Set(trackedAnimations.map((entry) => entry?.animation).filter(Boolean));
      let pausedAnimations = 0;
      for (const animation of animations) {
        if (!animation || seenAnimations.has(animation)) continue;
        trackedAnimations.push({
          animation,
          shouldResume: animation.playState !== "paused"
        });
        seenAnimations.add(animation);
      }
      for (const entry of trackedAnimations) {
        if (!entry?.animation || typeof entry.animation.pause !== "function") continue;
        try {
          entry.animation.pause();
          pausedAnimations += 1;
        } catch {}
      }

      const trackedVideos = Array.isArray(state.videos) ? state.videos : [];
      const seenVideos = new Set(trackedVideos.map((entry) => entry?.element).filter(Boolean));
      let pausedVideos = 0;
      for (const video of document.querySelectorAll("video")) {
        if (!(video instanceof HTMLMediaElement)) continue;
        if (!seenVideos.has(video)) {
          trackedVideos.push({
            element: video,
            shouldResume: !video.paused && !video.ended
          });
          seenVideos.add(video);
        }
        if (!video.paused && typeof video.pause === "function") {
          try {
            video.pause();
            pausedVideos += 1;
          } catch {}
        }
      }

      const trackedSwipers = Array.isArray(state.swipers) ? state.swipers : [];
      const seenSwipers = new Set(trackedSwipers.map((entry) => entry?.swiper).filter(Boolean));
      let stoppedSwipers = 0;
      for (const element of document.querySelectorAll(".swiper, [class*='swiper']")) {
        const swiper = element?.swiper;
        if (!swiper || seenSwipers.has(swiper)) continue;
        trackedSwipers.push({
          swiper,
          shouldResume: Boolean(swiper.autoplay?.running)
        });
        seenSwipers.add(swiper);
      }
      for (const entry of trackedSwipers) {
        if (!entry?.swiper?.autoplay?.stop) continue;
        try {
          entry.swiper.autoplay.stop();
          stoppedSwipers += 1;
        } catch {}
      }

      const trackedSlicks = Array.isArray(state.slicks) ? state.slicks : [];
      const seenSlicks = new Set(trackedSlicks.map((entry) => entry?.instance).filter(Boolean));
      let pausedSlicks = 0;
      for (const element of document.querySelectorAll(".slick-slider")) {
        const instance = element?.slick;
        if (!instance || seenSlicks.has(instance)) continue;
        trackedSlicks.push({
          instance,
          shouldResume: Boolean(instance.autoPlayTimer || instance.options?.autoplay)
        });
        seenSlicks.add(instance);
      }
      for (const entry of trackedSlicks) {
        const instance = entry?.instance;
        if (!instance || typeof instance.slickPause !== "function") continue;
        try {
          instance.slickPause();
          pausedSlicks += 1;
        } catch {}
      }

      state.animations = trackedAnimations;
      state.videos = trackedVideos;
      state.swipers = trackedSwipers;
      state.slicks = trackedSlicks;
      state.active = true;
      window[stateKey] = state;
      return {
        ok: true,
        pausedAnimations,
        trackedAnimations: trackedAnimations.length,
        pausedVideos,
        trackedVideos: trackedVideos.length,
        stoppedSwipers,
        trackedSwipers: trackedSwipers.length,
        pausedSlicks,
        trackedSlicks: trackedSlicks.length
      };
    })()`,
    returnByValue: true
  }).catch(() => null);
  return result?.result?.value || { ok: false };
}

async function restorePageMotion(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const stateKey = ${JSON.stringify(pageShotMotionFreezeStateKey)};
      const styleId = ${JSON.stringify(pageShotMotionFreezeStyleId)};
      const state = window[stateKey];
      if (!state || typeof state !== "object") {
        const style = document.getElementById(styleId);
        if (style) {
          style.remove();
        }
        return { ok: true, restored: false };
      }

      let resumedAnimations = 0;
      for (const entry of Array.isArray(state.animations) ? state.animations : []) {
        if (!entry?.shouldResume || !entry.animation || typeof entry.animation.play !== "function") continue;
        try {
          entry.animation.play();
          resumedAnimations += 1;
        } catch {}
      }

      let resumedVideos = 0;
      for (const entry of Array.isArray(state.videos) ? state.videos : []) {
        if (!entry?.shouldResume || !entry.element || typeof entry.element.play !== "function") continue;
        try {
          const maybePromise = entry.element.play();
          if (maybePromise && typeof maybePromise.catch === "function") {
            maybePromise.catch(() => null);
          }
          resumedVideos += 1;
        } catch {}
      }

      let resumedSwipers = 0;
      for (const entry of Array.isArray(state.swipers) ? state.swipers : []) {
        if (!entry?.shouldResume || !entry.swiper?.autoplay?.start) continue;
        try {
          entry.swiper.autoplay.start();
          resumedSwipers += 1;
        } catch {}
      }

      let resumedSlicks = 0;
      for (const entry of Array.isArray(state.slicks) ? state.slicks : []) {
        if (!entry?.shouldResume || !entry.instance || typeof entry.instance.slickPlay !== "function") continue;
        try {
          entry.instance.slickPlay();
          resumedSlicks += 1;
        } catch {}
      }

      const style = document.getElementById(styleId);
      if (style) {
        style.remove();
      }
      delete window[stateKey];
      return {
        ok: true,
        restored: true,
        resumedAnimations,
        resumedVideos,
        resumedSwipers,
        resumedSlicks
      };
    })()`,
    returnByValue: true
  }).catch(() => null);
  return result?.result?.value || { ok: false };
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

async function prepareShokzNavigationMainScreenshot(client, captureContext) {
  const viewport = viewportForCaptureContext(captureContext);
  const mobile = isMobileCaptureContext(captureContext);
  let cleanup = await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 4, hideOnly: true });
  if (!cleanup.ok) {
    throw new Error(`Known popup remained before Shokz navigation screenshot: ${formatKnownPopupRemaining(cleanup)}.`);
  }
  const state = await waitForShokzProductsNavigation(client, mobile);
  if (!state.ok) {
    await openShokzProductsNavigation(client, captureContext);
  }
  cleanup = await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 4, hideOnly: true });
  if (!cleanup.ok) {
    throw new Error(`Known popup remained before Shokz navigation screenshot: ${formatKnownPopupRemaining(cleanup)}.`);
  }
  const finalState = await waitForShokzProductsNavigation(client, mobile);
  if (!finalState.ok) {
    await openShokzProductsNavigation(client, captureContext);
  }
  await sleep(250);
  cleanup = await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 5, hideOnly: true });
  if (!cleanup.ok) {
    throw new Error(`Known popup remained immediately before Shokz navigation screenshot: ${formatKnownPopupRemaining(cleanup)}.`);
  }
}

async function prepareShokzNavigationRelatedScreenshot(client, state, captureContext) {
  await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 4, hideOnly: true });
  await restoreShokzNavigationHover(client, state, captureContext);
}

async function captureShokzMobileNavigationViewportStack(client, state) {
  const stackState = await readShokzMobileNavigationViewportStackState(client);
  if (!stackState.ok) {
    throw new Error(stackState.reason || `Could not inspect ${state.stateLabel} mobile viewport stack state.`);
  }

  const width = Math.max(1, Math.ceil(Number(stackState.viewportWidth) || 0));
  const viewportHeight = Math.max(1, Math.ceil(Number(stackState.viewportHeight) || 0));
  const positions = createShokzMobileViewportStackPositions(
    Math.max(0, Math.ceil(Number(stackState.maxScrollTop) || 0)),
    Math.max(1, Math.ceil(Number(stackState.scrollStep) || viewportHeight))
  );
  const rgba = new Uint8Array(width * viewportHeight * positions.length * 4);
  const attempts = [];

  for (const [index, scrollTop] of positions.entries()) {
    const screenshot = await captureScreenshotWithValidation(client, {
      format: "png",
      fromSurface: true
    }, {
      label: `navigation ${state.stateLabel} screen ${index + 1}/${positions.length}`,
      beforeAttempt: async ({ attempt }) => {
        await setShokzMobileNavigationViewportStackPosition(client, scrollTop);
        await settlePositionedViewport(client, {
          delayMs: attempt > 1 ? 760 : 460,
          frames: 4
        });
        await primeLazyImages(client);
      }
    });
    const image = decodePng(screenshot.buffer);
    if (image.width !== width || image.height !== viewportHeight) {
      throw new Error(`Unexpected viewport stack segment size ${image.width}x${image.height} for ${state.stateLabel}.`);
    }
    copySegment(image, rgba, width, viewportHeight * positions.length, index * viewportHeight);
    attempts.push({
      index,
      scrollTop,
      ...screenshot.captureValidation
    });
  }

  const buffer = encodePng(width, viewportHeight * positions.length, rgba);
  return {
    buffer,
    viewportHeight,
    contentHeight: viewportHeight * positions.length,
    captureValidation: {
      ok: true,
      label: `navigation ${state.stateLabel} viewport stack`,
      maxAttempts: Math.max(...attempts.map((item) => Number(item.maxAttempts) || 1), 1),
      retries: attempts.reduce((sum, item) => sum + (Number(item.retries) || 0), 0),
      attempts
    }
  };
}

function createShokzMobileViewportStackPositions(maxScrollTop, step) {
  const safeMax = Math.max(0, Math.ceil(Number(maxScrollTop) || 0));
  const safeStep = Math.max(1, Math.ceil(Number(step) || 0));
  const positions = [0];
  for (let next = safeStep; next < safeMax; next += safeStep) {
    positions.push(next);
  }
  if (positions[positions.length - 1] !== safeMax) {
    positions.push(safeMax);
  }
  return positions.filter((value, index, list) => index === 0 || value !== list[index - 1]);
}

async function readShokzMobileNavigationViewportStackState(client) {
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
      const overlay = Array.from(document.querySelectorAll("[data-page-shot-nav-secondary='true']"))
        .find((element) => visible(element));
      if (!overlay) {
        return { ok: false, reason: "Visible mobile navigation overlay was not found." };
      }
      const scrollRegion = overlay.querySelector("[data-page-shot-nav-scroll='true']");
      if (!(scrollRegion instanceof Element)) {
        return { ok: false, reason: "Mobile navigation scroll region was not found." };
      }
      return {
        ok: true,
        viewportWidth: Math.max(1, Math.ceil(window.innerWidth || 0)),
        viewportHeight: Math.max(1, Math.ceil(window.innerHeight || 0)),
        clientHeight: Math.max(1, Math.ceil(scrollRegion.clientHeight || 0)),
        scrollHeight: Math.max(1, Math.ceil(scrollRegion.scrollHeight || 0)),
        maxScrollTop: Math.max(0, Math.ceil((scrollRegion.scrollHeight || 0) - (scrollRegion.clientHeight || 0))),
        scrollStep: Math.max(1, Math.ceil(scrollRegion.clientHeight || 0))
      };
    })()`,
    returnByValue: true
  }).catch(() => ({ result: { value: { ok: false, reason: "Could not inspect mobile navigation viewport stack state." } } }));
  return result.result?.value || { ok: false, reason: "Could not inspect mobile navigation viewport stack state." };
}

async function setShokzMobileNavigationViewportStackPosition(client, scrollTop) {
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const target = Math.max(0, Math.ceil(${Number(scrollTop) || 0}));
      const overlay = Array.from(document.querySelectorAll("[data-page-shot-nav-secondary='true']"))
        .find((element) => {
          if (!(element instanceof Element)) return false;
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
        });
      const scrollRegion = overlay?.querySelector?.("[data-page-shot-nav-scroll='true']");
      if (!(scrollRegion instanceof Element)) {
        return { ok: false };
      }
      scrollRegion.scrollTop = target;
      return { ok: true, scrollTop: scrollRegion.scrollTop };
    })()`,
    returnByValue: true
  }).catch(() => null);
}

async function prepareShokzMobileNavigationExpandedCapture(client) {
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
      const overlay = Array.from(document.querySelectorAll("[data-page-shot-nav-secondary='true']"))
        .find((element) => visible(element));
      if (!overlay) {
        return { ok: false, reason: "Visible mobile navigation overlay was not found." };
      }
      const scrollRegion = overlay.querySelector("[data-page-shot-nav-scroll='true']") || overlay;
      if (!(scrollRegion instanceof Element)) {
        return { ok: false, reason: "Mobile navigation scroll region was not found." };
      }

      scrollRegion.scrollTop = 0;
      const overlayRect = overlay.getBoundingClientRect();
      const scrollRect = scrollRegion.getBoundingClientRect();
      const top = Math.max(0, Math.floor(overlayRect.top + window.scrollY));

      overlay.dataset.pageShotNavExpanded = "true";
      overlay.style.setProperty("position", "absolute", "important");
      overlay.style.setProperty("top", top + "px", "important");
      overlay.style.setProperty("bottom", "auto", "important");
      overlay.style.setProperty("height", "auto", "important");
      overlay.style.setProperty("max-height", "none", "important");
      overlay.style.setProperty("overflow", "visible", "important");

      scrollRegion.style.setProperty("flex", "0 0 auto", "important");
      scrollRegion.style.setProperty("height", "auto", "important");
      scrollRegion.style.setProperty("max-height", "none", "important");
      scrollRegion.style.setProperty("overflow", "visible", "important");
      scrollRegion.style.setProperty("overflow-y", "visible", "important");

      const expandedOverlayRect = overlay.getBoundingClientRect();
      const descendantBottom = Array.from(overlay.children || [])
        .reduce((max, element) => Math.max(max, Math.ceil(element.getBoundingClientRect().bottom - expandedOverlayRect.top)), 0);
      const contentHeight = Math.max(
        Math.ceil(overlay.scrollHeight || 0),
        Math.ceil(expandedOverlayRect.height || 0),
        descendantBottom
      );
      const minDocumentHeight = Math.max(
        Math.ceil(document.documentElement.scrollHeight || 0),
        top + contentHeight + 24
      );

      overlay.style.setProperty("height", contentHeight + "px", "important");

      document.documentElement.style.setProperty("min-height", minDocumentHeight + "px", "important");
      document.body.style.setProperty("min-height", minDocumentHeight + "px", "important");
      document.documentElement.style.setProperty("overflow", "visible", "important");
      document.body.style.setProperty("overflow", "visible", "important");

      return {
        ok: true,
        clip: {
          x: Math.max(0, Math.floor(overlayRect.left + window.scrollX)),
          y: top,
          width: Math.max(1, Math.ceil(overlayRect.width || window.innerWidth)),
          height: Math.max(1, contentHeight),
          scale: 1
        },
        viewportHeight: Math.max(1, Math.ceil(window.innerHeight || 0)),
        contentHeight: Math.max(1, contentHeight)
      };
    })()`,
    returnByValue: true
  }).catch(() => ({ result: { value: { ok: false, reason: "Could not prepare mobile navigation overlay capture." } } }));
  const value = result.result?.value || { ok: false, reason: "Could not prepare mobile navigation overlay capture." };
  if (!value.ok) {
    throw new Error(value.reason || "Could not prepare mobile navigation overlay capture.");
  }
  return value;
}

async function restoreShokzNavigationHover(client, state, captureContext = null) {
  if (state.restoreMode === "mobile-tap") {
    await restoreShokzMobileNavigationTapState(client, state, captureContext);
    return;
  }
  if (state.navigationLevel === "secondary" && isProductsNavigationLabel(state.topLevelLabel || state.tabLabel) && state.hoverItemLabel) {
    await hoverShokzTopNavigationLabel(client, "Products");
    const activated = await hoverShokzProductsSecondaryLabel(client, state.hoverItemLabel);
    if (activated?.ok) {
      return;
    }
    if (captureContext) {
      await openShokzProductsNavigation(client, captureContext);
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

async function restoreShokzMobileNavigationTapState(client, state, captureContext = null) {
  const targetLabel = state.activationLabel || state.hoverItemLabel || state.topLevelLabel;
  if (!targetLabel) {
    throw new Error("Mobile navigation target label is missing.");
  }

  await returnShokzMobileMenuToTopLevel(client);
  await sleep(250);

  if (!isProductsNavigationLabel(state.topLevelLabel || state.tabLabel)) {
    const rendered = await renderShokzMobileTextNavigationOverlay(client, state.topLevelLabel || state.tabLabel || targetLabel);
    if (!rendered.ok) {
      throw new Error(rendered.reason || `Could not render ${targetLabel} mobile secondary navigation state.`);
    }
    await sleep(350);
    await primeLazyImages(client);
    return;
  }

  const menuState = await readShokzProductsNavigationState(client, true);
  if (!menuState.ok) {
    if (menuState.drawerVisible) {
      await returnShokzMobileMenuToTopLevel(client);
      const resetState = await ensureShokzMobileMenuVisible(client);
      if (!resetState.ok) {
        throw new Error(`Could not return the Shokz mobile menu to the top level before opening ${targetLabel}.`);
      }
    } else {
      await openShokzProductsNavigation(client, captureContext);
    }
  }
  await returnShokzMobileMenuToTopLevel(client);
  await sleep(350);

  const expectedUrl = await readCurrentUrl(client);
  const activated = await clickShokzMobileNavigationLabel(client, targetLabel);
  if (!activated.ok) {
    throw new Error(activated.reason || `Could not activate ${targetLabel} in the Shokz mobile menu.`);
  }
  if (activated.navigatesAway) {
    throw new Error(`${targetLabel} would navigate away and was skipped.`);
  }
  if (!activated.usedDetailsToggle && Number.isFinite(activated.x) && Number.isFinite(activated.y)) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{
        x: Math.round(activated.x),
        y: Math.round(activated.y),
        radiusX: 1,
        radiusY: 1,
        force: 1,
        id: 1
      }]
    }).catch(() => null);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: []
    }).catch(() => null);
  }

  const drilldownState = await waitForShokzMobileNavigationDrilldown(client, state, expectedUrl);
  if (!drilldownState.ok) {
    const activationSummary = [
      activated.label ? `label=${activated.label}` : "",
      activated.targetTag ? `target=${activated.targetTag}` : "",
      activated.structureHint ? `structureHint=${activated.structureHint}` : "",
      activated.interactive ? `interactive=${activated.interactive}` : "",
      Object.hasOwn(activated, "usedControlledPanel") ? `usedControlledPanel=${Boolean(activated.usedControlledPanel)}` : "",
      Object.hasOwn(activated, "usedDrawerClone") ? `usedDrawerClone=${Boolean(activated.usedDrawerClone)}` : "",
      activated.targetHtml ? `html=${activated.targetHtml}` : ""
    ].filter(Boolean).join(" ");
    const suffix = activationSummary ? ` (${activationSummary})` : "";
    throw new Error((drilldownState.reason || `Could not confirm ${targetLabel} mobile secondary navigation state.`) + suffix);
  }

  await sleep(350);
  await primeLazyImages(client);
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
        if (mobileTap) {
          const clonedPanel = Array.from(document.querySelectorAll(".menu_drawer_content.active > .submenu_content"))
            .find((element) => visible(element));
          if (clonedPanel) {
            return {
              element: clonedPanel,
              text: textOf(clonedPanel).slice(0, 12000),
              rect: rectOf(clonedPanel),
              explicitPanel: true,
              drawerClonePanel: true,
              score: 999
            };
          }
        }
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
      const mobileTap = state.restoreMode === "mobile-tap";
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
        if (mobileTap) {
          const syntheticPanel = Array.from(document.querySelectorAll("[data-page-shot-nav-secondary='true']"))
            .find((element) => visible(element));
          if (syntheticPanel) {
            return {
              element: syntheticPanel,
              text: textOf(syntheticPanel).slice(0, 12000),
              rect: rectOf(syntheticPanel),
              explicitPanel: true,
              drawerClonePanel: true,
              score: 999
            };
          }
        }
        const candidates = Array.from(document.querySelectorAll("body *"))
          .filter(visible)
          .map((element) => {
            const rect = rectOf(element);
            const style = getComputedStyle(element);
            const text = textOf(element).slice(0, 12000);
            const explicitPanel = element.matches([
              "#menu-drawer",
              ".menu-drawer",
              ".menu_drawer_content",
              ".menu_drawer_content.active",
              ".menu_drawer_content > .submenu_content",
              ".mega-menu__content",
              ".product_mega_menu",
              ".product_mega_menu-wrapper",
              "[class*='mega']",
              "[class*='menu-drawer']"
            ].join(","));
            const drawerClonePanel = mobileTap &&
              element.matches?.(".menu_drawer_content.active, .menu_drawer_content > .submenu_content");
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
              explicitPanel,
              drawerClonePanel,
              score:
                Number(topHit) * 4 +
                Number(itemHit) * (mobileTap ? 8 : 4) +
                categoryHits * 3 +
                Number(explicitPanel) * 10 +
                Number(drawerClonePanel) * 16 +
                Number(positioned) * 2 +
                Math.min(rect.width / Math.max(1, window.innerWidth), 1) * 4 +
                Math.min(rect.height / Math.max(1, window.innerHeight), 1) * 2
            };
          })
          .filter((item) =>
            item.text.length > 16 &&
            item.text.length <= 12000 &&
            (item.rect.top >= (mobileTap ? 40 : 70) || item.explicitPanel) &&
            item.rect.top < Math.max(mobileTap ? 360 : 280, window.innerHeight * (mobileTap ? 0.45 : 0.35)) &&
            item.rect.height >= (mobileTap ? 120 : 80) &&
            item.rect.width >= Math.min(mobileTap ? 220 : 220, window.innerWidth * (mobileTap ? 0.55 : 0.2)) &&
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
      if (mobileTap) {
        const expectedLabels = [
          state.hoverItemLabel,
          state.topLevelLabel,
          state.tabLabel,
          state.activationLabel
        ]
          .map((value) => String(value || "").trim())
          .filter(Boolean);
        const matchedLabels = expectedLabels.filter((label) => comparable(text).includes(comparable(label)));
        if (!matchedLabels.length) {
          return {
            ok: false,
            reason: "Visible mobile navigation panel did not contain expected labels for " + (state.stateLabel || state.topLevelLabel || state.hoverItemLabel || "state") + "."
          };
        }
      }
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

    const screenshotCapture = await captureScreenshotWithValidation(client, {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip
    }, {
      label: `banner ${index + 1}`,
      beforeAttempt: async ({ attempt }) => {
        if (attempt === 1) {
          return;
        }
        await activateShokzHomeBanner(client, slide, index);
        await sleep(900);
        await waitForBannerImages(client);
        await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 5 });
        await sleep(300);
        await prepareForScreenshotCapture(client, {
          rounds: 2,
          shokzKnownPopups: true,
          stage: `retrying Shokz banner ${index + 1} screenshot capture`
        });
      }
    });
    const buffer = screenshotCapture.buffer;
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
      captureValidation: screenshotCapture.captureValidation,
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

async function captureShokzHomeRelatedSection(client, outputPath, captureContext, definition) {
  const viewport = viewportForCaptureContext(captureContext);
  await primeLazyImages(client);
  const plan = await readShokzHomeRelatedSectionPlan(client, definition, captureContext);
  if (plan.ok && plan.skipped) {
    return {
      width: 0,
      height: 0,
      captures: [],
      warnings: [],
      expectedCount: 0,
      capturedCount: 0,
      skipped: true
    };
  }
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
    const useDirectState = definition.key === "scene-explore" && state.directClip && state.directCaptureOnly;
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
    const screenshotCapture = await captureScreenshotWithValidation(client, {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip
    }, {
      label: `${definition.key} ${state.stateLabel}`,
      beforeAttempt: async ({ attempt }) => {
        if (attempt === 1) {
          return;
        }
        await clearRelatedHover(client);
        const retryActivation = skipActivation
          ? { ok: true }
          : await activateShokzHomeRelatedState(client, definition, state);
        await sleep(650);
        await waitForRelatedSectionImages(client, definition.key);
        await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 2 });
        if (retryActivation?.hoverPoint) {
          await moveMouseToPoint(client, retryActivation.hoverPoint);
          await waitForRelatedHoverSettled(client, definition, state);
          await suppressRelatedHoverDefaultLayer(client, definition, state);
          await sleep(120);
        }
        await prepareForScreenshotCapture(client, {
          rounds: 2,
          shokzKnownPopups: true,
          stage: `retrying Shokz ${definition.sectionLabel} screenshot capture`
        });
        const retryCleanup = await dismissShokzKnownPopupsBeforeScreenshot(client, {
          rounds: 5,
          hideOnly: Boolean(retryActivation?.hoverPoint)
        });
        if (!retryCleanup.ok) {
          throw new Error(`Known popup remained before ${definition.sectionLabel} retry screenshot: ${formatKnownPopupRemaining(retryCleanup)}.`);
        }
        if ((retryCleanup.hidden.length || retryCleanup.clicked.length) && retryActivation?.hoverPoint) {
          await moveMouseToPoint(client, retryActivation.hoverPoint);
          await waitForRelatedHoverSettled(client, definition, state);
          await sleep(120);
        }
      }
    });
    const buffer = screenshotCapture.buffer;
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
        message: `${definition.sectionLabel} ${state.stateLabel} looked duplicated and was saved with a warning.`
      });
    }

    const similar = nearestVisualHash(visualHash, seenHashes);
    const visualAudit = visualAuditForBuffer(buffer, visualHash, similar);
    if (visualAudit.qualityStatus === "warning") {
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
      captureValidation: screenshotCapture.captureValidation,
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

async function captureShokzCollectionRelatedSection(client, outputPath, captureContext, definition) {
  if (definition?.key === "collection-tabs") {
    return captureShokzCollectionProductVariantSection(client, outputPath, captureContext, definition);
  }

  const viewport = viewportForCaptureContext(captureContext);
  const states = Array.isArray(definition?.states) ? definition.states : [];
  if (!states.length) {
    return {
      width: 0,
      height: 0,
      captures: [],
      warnings: [],
      expectedCount: 0,
      capturedCount: 0
    };
  }

  await scrollTo(client, 0);
  await sleep(500);
  await primeLazyImages(client);

  const captures = [];
  const warnings = [];

  for (const [index, state] of states.entries()) {
    const activation = await activateShokzCollectionRelatedState(client, definition, state);
    if (!activation.ok) {
      warnings.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        stateLabel: state.stateLabel,
        message: activation.reason || `Could not activate ${definition.sectionLabel} state.`
      });
      continue;
    }
    if (definition.key === "collection-tabs") {
      const ready = await waitForShokzCollectionTabActivated(client, state);
      if (!ready.ok) {
        warnings.push({
          sectionKey: definition.key,
          sectionLabel: definition.sectionLabel,
          stateLabel: state.stateLabel,
          message: ready.reason || `Could not confirm ${state.stateLabel} tab activation.`
        });
        continue;
      }
    }

    await sleep(700);
    await primeLazyImages(client);
    await waitForRelatedSectionImages(client, definition.key);
    await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 2 });
    await dismissObstructions(client, { rounds: 3 });

    let current = null;
    let clip = null;
    let scrollInfo = null;
    let captureHeight = Number(viewport.height || 0) || 852;
    let captureWidth = Number(viewport.width || 0) || 393;
    const refreshCollectionState = async () => {
      if (definition.key === "collection-tabs") {
        scrollInfo = await prepareFullPage(client, {
          captureUrl: "https://shokz.com/collections/headphones-accessories",
          captureMode: "shokz-collection-page",
          dismissPopups: true
        });
      }
      current = await readShokzCollectionRelatedState(client, definition, state);
      if (!current.ok) {
        throw new Error(current.reason || `Could not read ${definition.sectionLabel} state.`);
      }
      if (collectionStateContainsSignupOverlay(current)) {
        await dismissShokzCollectionSignupOverlay(client);
        await sleep(260);
        current = await readShokzCollectionRelatedState(client, definition, state);
        if (!current.ok) {
          throw new Error(current.reason || `Could not read ${definition.sectionLabel} state after popup cleanup.`);
        }
      }
      if (definition.key === "collection-tabs") {
        const metrics = await client.send("Page.getLayoutMetrics");
        const contentSize = metrics.cssContentSize || metrics.contentSize || {};
        const pageWidth = Math.max(captureWidth, Math.ceil(contentSize.width || captureWidth));
        let pageHeight = Math.max(captureHeight, Math.ceil(contentSize.height || captureHeight));
        if (Number.isFinite(scrollInfo?.reachableHeight)) {
          pageHeight = Math.min(pageHeight, Math.max(captureHeight, Math.ceil(scrollInfo.reachableHeight)));
        }
        const maxHeight = 16000;
        captureWidth = pageWidth;
        captureHeight = Math.min(pageHeight, maxHeight);
        clip = {
          x: 0,
          y: 0,
          width: captureWidth,
          height: captureHeight,
          scale: 1
        };
      } else {
        clip = normalizeRelatedClip({
          x: 0,
          y: Math.max(0, Math.floor(Number(current.scrollY || 0))),
          width: captureWidth,
          height: captureHeight
        }, viewport);
      }
      if (!clip) {
        throw new Error(`Could not compute a valid crop for ${definition.sectionLabel} ${state.stateLabel}.`);
      }
    };

    try {
      await refreshCollectionState();
    } catch (error) {
      warnings.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        stateLabel: state.stateLabel,
        message: error.message
      });
      continue;
    }

    const screenshotCapture = await captureScreenshotWithValidation(client, () => ({
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip
    }), {
      label: `${definition.key} ${state.stateLabel}`,
      beforeAttempt: async ({ attempt }) => {
        if (attempt > 1) {
          const retryActivation = await activateShokzCollectionRelatedState(client, definition, state);
          if (!retryActivation.ok) {
            throw new Error(retryActivation.reason || `Could not reactivate ${definition.sectionLabel} state.`);
          }
          if (definition.key === "collection-tabs") {
            const ready = await waitForShokzCollectionTabActivated(client, state);
            if (!ready.ok) {
              throw new Error(ready.reason || `Could not confirm ${state.stateLabel} tab activation.`);
            }
          }
          await sleep(700);
          await primeLazyImages(client);
        }
        await prepareForScreenshotCapture(client, {
          rounds: 2,
          shokzKnownPopups: true,
          stage: `before Shokz ${definition.sectionLabel} screenshot capture`
        });
        await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 2 });
        await dismissObstructions(client, { rounds: 3 });
        await scrollTo(client, 0);
        await settlePositionedViewport(client, {
          delayMs: attempt > 1 ? 280 : 180,
          frames: 2
        });
        await refreshCollectionState();
      }
    });

    const buffer = screenshotCapture.buffer;
    const visualSignature = hashBuffer(buffer);
    const visualHash = visualHashForBuffer(buffer);
    const visualAudit = visualAuditForBuffer(buffer, visualHash);
    const logicalSignature = current.logicalSignature || state.logicalSignature || `${definition.key}:${state.fileId || state.stateLabel || index + 1}`;
    const relatedOutput = relatedOutputPath(outputPath, definition.key, state.fileId || state.stateIndex || index + 1);
    await fs.writeFile(relatedOutput, buffer);

    const width = Math.round(clip.width);
    const height = Math.round(clip.height);
    captures.push({
      outputPath: relatedOutput,
      width,
      height,
      kind: "section",
      sectionKey: definition.key,
      sectionLabel: definition.sectionLabel,
      sectionTitle: definition.title,
      stateIndex: state.stateIndex || index + 1,
      stateCount: states.length,
      stateLabel: state.stateLabel,
      label: state.stateLabel,
      tabLabel: state.tabLabel || null,
      tabIndex: state.tabIndex || null,
      pageIndex: null,
      interactionState: "default",
      logicalSignature,
      visualSignature,
      visualHash,
      visualAudit,
      captureValidation: screenshotCapture.captureValidation,
      scrollInfo: definition.key === "collection-tabs"
        ? {
            height: height,
            viewportHeight: Number(viewport.height || 0) || 852,
            reachableHeight: Number(scrollInfo?.reachableHeight || 0) || height,
            scrolls: Number(scrollInfo?.scrolls || 0) || null
          }
        : {
            viewportHeight: Number(viewport.height || 0) || 852
          },
      clip: {
        x: Math.round(clip.x),
        y: Math.round(clip.y),
        width,
        height
      },
      isDefaultState: Boolean(state.isDefaultState),
      coverageKey: relatedCoverageKeyForState(state),
      sectionState: {
        text: current.text || "",
        textBlocks: current.textBlocks || [],
        images: current.images || [],
        activeIndex: state.stateIndex || index + 1,
        tabLabel: state.tabLabel || null,
        tabIndex: state.tabIndex || null,
        pageIndex: null,
        interactionState: "default",
        visibleItemCount: current.visibleItemCount || null,
        visibleItems: current.visibleItems || null,
        itemRects: current.itemRects || null,
        windowSignature: current.windowSignature || null
      }
    });
  }

  return {
    width: captures.reduce((max, capture) => Math.max(max, Number(capture.width || 0)), Number(viewport.width || 0) || 393),
    height: captures.reduce((max, capture) => Math.max(max, Number(capture.height || 0)), Number(viewport.height || 0) || 852),
    captures,
    warnings,
    expectedCount: states.length,
    capturedCount: captures.length
  };
}

async function captureShokzCollectionProductVariantSection(client, outputPath, captureContext, definition) {
  const viewport = viewportForCaptureContext(captureContext);
  const categories = Array.isArray(definition?.states) ? definition.states : [];
  const captures = [];
  const warnings = [];
  const plannedStates = [];
  let maxWidth = Number(viewport.width || 0) || 393;
  let maxHeight = Number(viewport.height || 0) || 852;

  for (const category of categories) {
    await scrollTo(client, 0);
    const activation = await activateShokzCollectionTab(client, category);
    if (!activation.ok) {
      warnings.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        stateLabel: category.stateLabel,
        message: activation.reason || `Could not activate ${category.stateLabel} collection tab.`
      });
      continue;
    }

    const ready = await waitForShokzCollectionTabActivated(client, category);
    if (!ready.ok) {
      warnings.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        stateLabel: category.stateLabel,
        message: ready.reason || `Could not confirm ${category.stateLabel} collection tab activation.`
      });
      continue;
    }

    await sleep(650);
    await primeLazyImages(client);
    await expandShokzCollectionViewMoreControls(client, {
      captureMode: "shokz-collection-related-section",
      dismissPopups: true
    });
    await waitForRelatedSectionImages(client, definition.key);
    await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 2 });
    await dismissObstructions(client, { rounds: 3 });

    const plan = await readShokzCollectionProductVariantPlan(client, definition, category, captureContext);
    warnings.push(...(Array.isArray(plan.warnings) ? plan.warnings : []));
    if (!plan.ok) {
      warnings.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        stateLabel: category.stateLabel,
        message: plan.reason || `Could not read products for ${category.stateLabel}.`
      });
      continue;
    }

    const states = Array.isArray(plan.states) ? plan.states : [];
    if (!states.length) {
      warnings.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        stateLabel: category.stateLabel,
        message: `No product cards were found for ${category.stateLabel}.`
      });
      continue;
    }

    for (const state of states) {
      state.stateIndex = plannedStates.length + 1;
      plannedStates.push(state);

      const variantActivation = await activateShokzCollectionProductVariantState(client, state);
      if (!variantActivation.ok) {
        warnings.push({
          sectionKey: definition.key,
          sectionLabel: definition.sectionLabel,
          stateLabel: state.stateLabel,
          message: variantActivation.reason || `Could not activate ${state.stateLabel}.`
        });
        continue;
      }

      await sleep(260);
      await primeLazyImages(client);
      await waitForRelatedSectionImages(client, definition.key);
      await prepareForScreenshotCapture(client, {
        rounds: 2,
        shokzKnownPopups: true,
        stage: `before Shokz ${definition.sectionLabel} product variant screenshot capture`
      });
      await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 2 });
      await dismissObstructions(client, { rounds: 2 });

      let current = await readShokzCollectionProductVariantState(client, definition, state);
      if (!current.ok) {
        warnings.push({
          sectionKey: definition.key,
          sectionLabel: definition.sectionLabel,
          stateLabel: state.stateLabel,
          message: current.reason || `Could not read ${state.stateLabel}.`
        });
        continue;
      }

      let clip = normalizeRelatedClip(current.clip, viewport);
      if (!clip) {
        warnings.push({
          sectionKey: definition.key,
          sectionLabel: definition.sectionLabel,
          stateLabel: state.stateLabel,
          message: `Could not compute a valid product-card crop for ${state.stateLabel}.`
        });
        continue;
      }

      const screenshotCapture = await captureScreenshotWithValidation(client, () => ({
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip
      }), {
        label: `${definition.key} ${state.stateLabel}`,
        acceptBlankAudit: (blankAudit) => isAcceptableCollectionProductVariantBlankAudit(blankAudit, current),
        beforeAttempt: async ({ attempt }) => {
          if (attempt > 1) {
            const retryActivation = await activateShokzCollectionProductVariantState(client, state);
            if (!retryActivation.ok) {
              throw new Error(retryActivation.reason || `Could not reactivate ${state.stateLabel}.`);
            }
            await sleep(360);
            await primeLazyImages(client);
          }
          await prepareForScreenshotCapture(client, {
            rounds: 2,
            shokzKnownPopups: true,
            stage: `retrying Shokz ${definition.sectionLabel} product variant screenshot capture`
          });
          await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 2 });
          await dismissObstructions(client, { rounds: 2 });
          current = await readShokzCollectionProductVariantState(client, definition, state);
          if (!current.ok) {
            throw new Error(current.reason || `Could not reread ${state.stateLabel}.`);
          }
          clip = normalizeRelatedClip(current.clip, viewport);
          if (!clip) {
            throw new Error(`Could not compute a valid product-card crop for ${state.stateLabel}.`);
          }
        }
      });

      const buffer = screenshotCapture.buffer;
      const visualSignature = hashBuffer(buffer);
      const visualHash = visualHashForBuffer(buffer);
      const visualAudit = visualAuditForBuffer(buffer, visualHash);
      const logicalSignature = current.logicalSignature || state.logicalSignature;
      const relatedOutput = relatedOutputPath(outputPath, definition.key, state.fileId || state.stateIndex);
      await fs.writeFile(relatedOutput, buffer);

      const width = Math.round(clip.width);
      const height = Math.round(clip.height);
      maxWidth = Math.max(maxWidth, width);
      maxHeight = Math.max(maxHeight, height);
      captures.push({
        outputPath: relatedOutput,
        width,
        height,
        kind: "product-variant",
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        sectionTitle: definition.title,
        stateIndex: state.stateIndex,
        stateCount: null,
        stateLabel: state.stateLabel,
        label: state.stateLabel,
        tabLabel: state.tabLabel || category.tabLabel || null,
        tabIndex: state.tabIndex || category.tabIndex || null,
        pageIndex: null,
        interactionState: "default",
        categoryKey: state.categoryKey || null,
        categoryLabel: state.categoryLabel || state.tabLabel || null,
        productKey: state.productKey || null,
        productLabel: state.productLabel || null,
        productIndex: state.productIndex || null,
        variantKey: state.variantKey || null,
        variantLabel: state.variantLabel || null,
        variantOptions: state.variantOptions || [],
        logicalSignature,
        visualSignature,
        visualHash,
        visualAudit,
        captureValidation: screenshotCapture.captureValidation,
        clip: {
          x: Math.round(clip.x),
          y: Math.round(clip.y),
          width,
          height
        },
        isDefaultState: Boolean(state.isDefaultState),
        coverageKey: relatedCoverageKeyForState(state),
        sectionState: {
          text: current.text || "",
          textBlocks: current.textBlocks || [],
          images: current.images || [],
          activeIndex: state.stateIndex,
          tabLabel: state.tabLabel || null,
          tabIndex: state.tabIndex || null,
          interactionState: "default",
          categoryKey: state.categoryKey || null,
          categoryLabel: state.categoryLabel || null,
          productKey: state.productKey || null,
          productLabel: state.productLabel || null,
          productIndex: state.productIndex || null,
          variantKey: state.variantKey || null,
          variantLabel: state.variantLabel || null,
          variantOptions: state.variantOptions || [],
          visibleItemCount: current.visibleItemCount || 1,
          visibleItems: current.visibleItems || [],
          itemRects: current.itemRects || [],
          windowSignature: current.windowSignature || null
        }
      });
    }
  }

  for (const capture of captures) {
    capture.stateCount = plannedStates.length || captures.length || null;
  }
  warnings.push(...relatedSectionCoverageWarnings(definition, plannedStates, captures));

  return {
    width: maxWidth,
    height: maxHeight,
    captures,
    warnings,
    expectedCount: plannedStates.length,
    capturedCount: captures.length
  };
}

async function readShokzCollectionProductVariantPlan(client, definition, category, captureContext = {}) {
  const viewport = viewportForCaptureContext(captureContext);
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const definition = ${JSON.stringify({
        key: definition?.key || "",
        sectionLabel: definition?.sectionLabel || "",
        title: definition?.title || ""
      })};
      const category = ${JSON.stringify({
        categoryKey: category?.categoryKey || category?.matchHandle || category?.fileId || "",
        categoryLabel: category?.categoryLabel || category?.tabLabel || category?.stateLabel || "",
        tabLabel: category?.tabLabel || category?.categoryLabel || category?.stateLabel || "",
        tabIndex: Number(category?.tabIndex || 0) || null
      })};
      const viewport = ${JSON.stringify({
        width: Number(viewport.width || 0) || 393,
        height: Number(viewport.height || 0) || 852
      })};
      const clean = (value, max = 240) => String(value || "").replace(/[\\u00a0\\s]+/g, " ").trim().slice(0, max);
      const keyPart = (value, fallback = "item") => {
        const key = clean(value, 140).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
        return key || fallback;
      };
      const rendered = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const rectInfo = (rect) => ({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      });
      const productHref = (link) => {
        try {
          return new URL(link.getAttribute("href") || link.href || "", window.location.href).pathname.replace(/\\/+$/g, "");
        } catch {
          return clean(link.getAttribute("href") || link.href || "", 160);
        }
      };
      const productCardForLink = (link) =>
        link.closest("[data-product-card], product-card, article, li, .grid__item, .card-wrapper, [class*='product-card'], [class*='product_card'], [class*='product-item'], [class*='product_item'], [class*='card']") ||
        link.closest("section, .shopify-section") ||
        link;
      const titleForCard = (card, link, fallback) => {
        const titleNode = card.querySelector(".card__heading, .product-card__title, .product-title, [class*='product'][class*='title'], [class*='product'][class*='name'], h1, h2, h3, h4");
        const text = clean(
          titleNode?.innerText ||
          titleNode?.textContent ||
          link.getAttribute("aria-label") ||
          link.getAttribute("title") ||
          link.innerText ||
          link.textContent ||
          fallback,
          160
        );
        return clean(text.replace(/^(new|best selling)\\b/i, "").replace(/\\$\\s*\\d[\\s\\S]*$/g, ""), 100) || fallback;
      };
      const optionText = (element, fallback = "") => clean(
        element?.getAttribute?.("aria-label") ||
        element?.getAttribute?.("title") ||
        element?.getAttribute?.("data-value") ||
        element?.getAttribute?.("data-option-value") ||
        element?.value ||
        element?.innerText ||
        element?.textContent ||
        fallback,
        90
      );
      const groupTextForControl = (control) => {
        const group = control.closest("fieldset, [class*='variant'], [class*='option'], [class*='selector'], [class*='swatch'], [class*='product-form__input']") || control.parentElement;
        const legend = group?.querySelector?.("legend, .form__label, label, [class*='label'], [class*='title']") || null;
        return clean([legend?.innerText || legend?.textContent, group?.innerText || group?.textContent].filter(Boolean).join(" "), 240);
      };
      const groupNameForControl = (control, label) => {
        const directLabel = clean(label, 120).toLowerCase();
        const classText = String(control.className || "").toLowerCase();
        if (control.tagName?.toLowerCase() === "span" &&
          !/^(standard|mini|usb\\s*-?c|usb-c\\s*\\+\\s*wireless\\s*charging|wireless\\s*charging)$/i.test(directLabel) &&
          !/color|colour|swatch/.test(classText)) {
          return null;
        }
        if (/usb\\s*-?c|wireless\\s*charging/.test(directLabel)) return "Charging Type";
        if (/^(standard|mini)$/i.test(directLabel)) return "Size";
        const groupText = groupTextForControl(control);
        const haystack = clean([groupText, label, control.className, control.getAttribute?.("name"), control.getAttribute?.("data-option-name")].filter(Boolean).join(" "), 260).toLowerCase();
        const rect = control.getBoundingClientRect();
        if (/charging\\s*type|usb\\s*-?c|wireless\\s*charging/.test(haystack)) return "Charging Type";
        if (/\\bsize\\b|\\bstandard\\b|\\bmini\\b/.test(haystack)) return "Size";
        if (/color|colour|swatch/.test(haystack) || (rect.width <= 44 && rect.height <= 44 && !/add\\s*to\\s*cart|view\\s*more/i.test(label))) return "Color";
        return null;
      };
      const clickTargetForControl = (control) => {
        if (control.matches("input[type='radio'], input[type='checkbox']")) {
          const id = control.getAttribute("id");
          return id ? document.querySelector("label[for='" + CSS.escape(id) + "']") || control : control;
        }
        return control.closest("button, a, label, [role='button'], [role='radio'], [tabindex], [data-value], [data-option-value], [class*='option'], [class*='variant'], [class*='size'], [class*='charging']") || control;
      };
      const disabled = (element) => {
        const target = clickTargetForControl(element);
        const text = clean(target?.innerText || target?.textContent || "");
        return Boolean(
          element.disabled ||
          target?.disabled ||
          element.getAttribute?.("aria-disabled") === "true" ||
          target?.getAttribute?.("aria-disabled") === "true" ||
          element.classList?.contains("disabled") ||
          target?.classList?.contains("disabled") ||
          /sold\\s*out|unavailable/i.test(text)
        );
      };
      const readOptionGroups = (card, productDomId) => {
        const groupOrder = ["Color", "Size", "Charging Type"];
        const groups = new Map();
        const controls = Array.from(card.querySelectorAll("input[type='radio'], input[type='checkbox'], label[for], button, span, [role='radio'], [role='button'], [data-value], [data-option-value], .swatch, [class*='swatch'], [class*='size'], [class*='charging']"))
          .filter((control) => rendered(control))
          .filter((control) => {
            const label = optionText(control);
            const rect = control.getBoundingClientRect();
            if (rect.width > Math.max(180, viewport.width * 0.74) || rect.height > 96) return false;
            if (/add\\s*to\\s*cart|view\\s*more|learn\\s*more|feedback|privacy|terms/i.test(label)) return false;
            return Boolean(label || /swatch|color/i.test(String(control.className || "")));
          });
        for (const control of controls) {
          const label = optionText(control);
          const groupName = groupNameForControl(control, label);
          if (!groupName || disabled(control)) continue;
          const target = clickTargetForControl(control);
          if (!target || !rendered(target)) continue;
          const optionIndex = (groups.get(groupName)?.options.length || 0) + 1;
          const valueLabel = label || (groupName + " " + optionIndex);
          const valueKey = keyPart(valueLabel, keyPart(groupName) + "-" + optionIndex);
          const controlId = productDomId + "-option-" + keyPart(groupName) + "-" + optionIndex + "-" + valueKey;
          target.dataset.pageShotCollectionOptionId = controlId;
          control.dataset.pageShotCollectionOptionId = controlId;
          if (!groups.has(groupName)) {
            groups.set(groupName, {
              name: groupName,
              key: keyPart(groupName),
              options: []
            });
          }
          const group = groups.get(groupName);
          if (group.options.some((option) => option.valueKey === valueKey || option.controlId === controlId)) continue;
          group.options.push({
            groupName,
            groupKey: group.key,
            value: valueLabel,
            valueKey,
            controlId,
            optionIndex: group.options.length + 1
          });
        }
        return groupOrder
          .map((name) => groups.get(name))
          .filter((group) => group && group.options.length);
      };
      const cartesian = (groups) => {
        if (!groups.length) return [[]];
        return groups.reduce((sets, group) =>
          sets.flatMap((set) => group.options.map((option) => [...set, { ...option, groupName: group.name, groupKey: group.key }])),
          [[]]
        );
      };
      const cardEntries = [];
      const seenCards = new Set();
      for (const link of Array.from(document.querySelectorAll("a[href*='/products/']"))) {
        if (!rendered(link)) continue;
        const card = productCardForLink(link);
        if (!card || seenCards.has(card) || !rendered(card)) continue;
        const rect = card.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 160) continue;
        const href = productHref(link);
        const fallbackLabel = clean(href.split("/").filter(Boolean).pop()?.replace(/[-_]+/g, " "), 80) || "Product";
        const productLabel = titleForCard(card, link, fallbackLabel);
        if (!productLabel || /add\\s*to\\s*cart|view\\s*more/i.test(productLabel)) continue;
        seenCards.add(card);
        cardEntries.push({ card, link, href, productLabel, rect });
      }
      cardEntries.sort((a, b) => (window.scrollY + a.rect.top) - (window.scrollY + b.rect.top) || a.rect.left - b.rect.left);

      const states = [];
      const warnings = [];
      for (const [productOffset, entry] of cardEntries.entries()) {
        const productIndex = productOffset + 1;
        const productKey = keyPart(entry.href || entry.productLabel, "product-" + productIndex);
        const productDomId = "collection-" + keyPart(category.categoryKey || category.categoryLabel || "all") + "-product-" + productIndex + "-" + productKey;
        entry.card.dataset.pageShotCollectionProductId = productDomId;
        const optionGroups = readOptionGroups(entry.card, productDomId);
        const combos = cartesian(optionGroups);
        for (const [comboIndex, combo] of combos.entries()) {
          const variantOptions = combo.map((option) => ({
            name: option.groupName,
            key: option.groupKey,
            value: option.value,
            valueKey: option.valueKey,
            controlId: option.controlId,
            optionIndex: option.optionIndex
          }));
          const variantKey = variantOptions.length
            ? variantOptions.map((option) => option.key + "-" + option.valueKey).join("__")
            : "default";
          const variantLabel = variantOptions.length
            ? variantOptions.map((option) => option.name + ": " + option.value).join(" / ")
            : "Default";
          const stateLabel = (category.categoryLabel || category.tabLabel || "All") + " / " + entry.productLabel + " / " + variantLabel;
          states.push({
            kind: "product-variant",
            sectionKey: definition.key,
            sectionLabel: definition.sectionLabel,
            categoryKey: category.categoryKey || keyPart(category.categoryLabel || category.tabLabel || "all"),
            categoryLabel: category.categoryLabel || category.tabLabel || "All",
            tabLabel: category.tabLabel || category.categoryLabel || "All",
            tabIndex: category.tabIndex,
            productKey,
            productLabel: entry.productLabel,
            productIndex,
            productDomId,
            variantKey,
            variantLabel,
            variantOptions,
            stateLabel,
            label: stateLabel,
            logicalSignature: [definition.key, category.categoryKey || category.categoryLabel || "all", productKey, variantKey].join("|"),
            fileId: [category.categoryKey || "all", productKey, variantKey].join("-"),
            isDefaultState: comboIndex === 0
          });
        }
      }

      return {
        ok: true,
        states,
        warnings,
        productCount: cardEntries.length
      };
    })()`,
    returnByValue: true
  }).catch(() => null);
  return result?.result?.value || { ok: false, reason: `Could not read ${definition?.sectionLabel || "collection"} product variant plan.` };
}

async function activateShokzCollectionProductVariantState(client, state) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(async () => {
      const state = ${JSON.stringify({
        productDomId: state?.productDomId || "",
        productKey: state?.productKey || "",
        productLabel: state?.productLabel || "",
        variantOptions: Array.isArray(state?.variantOptions) ? state.variantOptions : []
      })};
      const clean = (value) => String(value || "").replace(/[\\u00a0\\s]+/g, " ").trim();
      const keyPart = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const rendered = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const productCardForLink = (link) =>
        link.closest("[data-product-card], product-card, article, li, .grid__item, .card-wrapper, [class*='product-card'], [class*='product_card'], [class*='product-item'], [class*='product_item'], [class*='card']") ||
        link.closest("section, .shopify-section") ||
        link;
      const findCard = () => {
        const byId = state.productDomId ? document.querySelector("[data-page-shot-collection-product-id='" + CSS.escape(state.productDomId) + "']") : null;
        if (byId) return byId;
        for (const link of Array.from(document.querySelectorAll("a[href*='/products/']"))) {
          const href = (() => {
            try {
              return new URL(link.getAttribute("href") || link.href || "", window.location.href).pathname.replace(/\\/+$/g, "");
            } catch {
              return link.getAttribute("href") || link.href || "";
            }
          })();
          const card = productCardForLink(link);
          const text = clean(card?.innerText || card?.textContent || link.innerText || link.textContent);
          if ((state.productKey && keyPart(href || text).includes(state.productKey)) || (state.productLabel && text.includes(state.productLabel))) {
            return card;
          }
        }
        return null;
      };
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const clickElement = (element) => {
        if (!element) return false;
        const target = element.closest("button, a, label, [role='button'], [role='radio'], [tabindex], [data-value], [data-option-value], [class*='option'], [class*='variant'], [class*='size'], [class*='charging']") || element;
        if (!rendered(target) || target.disabled || target.getAttribute("aria-disabled") === "true") return false;
        target.scrollIntoView({ block: "center", inline: "center" });
        if (typeof target.click === "function") {
          target.click();
        } else {
          target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        }
        return true;
      };
      const fallbackOptionControl = (card, option) => {
        const targetLabel = clean(option.value || "").toLowerCase();
        if (!targetLabel) return null;
        return Array.from(card.querySelectorAll("input[type='radio'], input[type='checkbox'], label[for], button, span, [role='radio'], [role='button'], [data-value], [data-option-value], .swatch, [class*='swatch'], [class*='size'], [class*='charging']"))
          .find((element) => {
            if (!rendered(element)) return false;
            const label = clean(
              element.getAttribute?.("aria-label") ||
              element.getAttribute?.("title") ||
              element.getAttribute?.("data-value") ||
              element.getAttribute?.("data-option-value") ||
              element.value ||
              element.innerText ||
              element.textContent
            ).toLowerCase();
            return label && (label === targetLabel || label.includes(targetLabel) || targetLabel.includes(label));
          }) || null;
      };

      const card = findCard();
      if (!card) {
        return { ok: false, reason: "Could not find product card " + (state.productLabel || state.productKey || "") + "." };
      }
      card.scrollIntoView({ block: "center", inline: "center" });
      await sleep(180);
      const clicked = [];
      for (const option of state.variantOptions || []) {
        const control = option.controlId
          ? card.querySelector("[data-page-shot-collection-option-id='" + CSS.escape(option.controlId) + "']")
          : null;
        const effectiveControl = control || fallbackOptionControl(card, option);
        if (!effectiveControl) {
          return { ok: false, reason: "Could not find option " + (option.name || "") + ": " + (option.value || "") + " for " + (state.productLabel || "product") + "." };
        }
        if (clickElement(effectiveControl)) {
          clicked.push([option.name, option.value].filter(Boolean).join(": "));
          await sleep(180);
        }
      }
      card.scrollIntoView({ block: "center", inline: "center" });
      await sleep(180);
      return { ok: true, clicked };
    })()`,
    awaitPromise: true,
    returnByValue: true
  }).catch(() => null);
  return result?.result?.value || { ok: false, reason: `Could not activate ${state?.stateLabel || "collection product variant"}.` };
}

async function readShokzCollectionProductVariantState(client, definition, state) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const definition = ${JSON.stringify({
        key: definition?.key || "",
        sectionLabel: definition?.sectionLabel || "",
        title: definition?.title || ""
      })};
      const state = ${JSON.stringify({
        productDomId: state?.productDomId || "",
        productKey: state?.productKey || "",
        productLabel: state?.productLabel || "",
        productIndex: state?.productIndex || null,
        categoryKey: state?.categoryKey || "",
        categoryLabel: state?.categoryLabel || "",
        variantKey: state?.variantKey || "",
        variantLabel: state?.variantLabel || "",
        variantOptions: Array.isArray(state?.variantOptions) ? state.variantOptions : [],
        logicalSignature: state?.logicalSignature || "",
        stateLabel: state?.stateLabel || ""
      })};
      const clean = (value, max = 300) => String(value || "").replace(/[\\u00a0\\s]+/g, " ").trim().slice(0, max);
      const keyPart = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const rendered = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const rectInfo = (rect) => ({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      });
      const productCardForLink = (link) =>
        link.closest("[data-product-card], product-card, article, li, .grid__item, .card-wrapper, [class*='product-card'], [class*='product_card'], [class*='product-item'], [class*='product_item'], [class*='card']") ||
        link.closest("section, .shopify-section") ||
        link;
      const findCard = () => {
        const byId = state.productDomId ? document.querySelector("[data-page-shot-collection-product-id='" + CSS.escape(state.productDomId) + "']") : null;
        if (byId) return byId;
        for (const link of Array.from(document.querySelectorAll("a[href*='/products/']"))) {
          const href = (() => {
            try {
              return new URL(link.getAttribute("href") || link.href || "", window.location.href).pathname.replace(/\\/+$/g, "");
            } catch {
              return link.getAttribute("href") || link.href || "";
            }
          })();
          const card = productCardForLink(link);
          const text = clean(card?.innerText || card?.textContent || link.innerText || link.textContent, 500);
          if ((state.productKey && keyPart(href || text).includes(state.productKey)) || (state.productLabel && text.includes(state.productLabel))) {
            return card;
          }
        }
        return null;
      };
      const card = findCard();
      if (!card || !rendered(card)) {
        return { ok: false, reason: "Could not read product card " + (state.productLabel || state.productKey || "") + "." };
      }
      window.__pageShotRelatedSections = window.__pageShotRelatedSections || {};
      window.__pageShotRelatedSections[definition.key] = { root: card };
      const cardRect = card.getBoundingClientRect();
      const clipX = Math.max(0, Math.floor(cardRect.left - 6));
      const clipY = Math.max(0, Math.floor(window.scrollY + cardRect.top - 6));
      const clipRight = Math.min(window.innerWidth || document.documentElement.clientWidth || 393, Math.ceil(cardRect.right + 6));
      const clipWidth = Math.max(1, clipRight - clipX);
      const clipHeight = Math.max(220, Math.ceil(cardRect.height + 12));
      const textBlocks = Array.from(card.querySelectorAll("h1, h2, h3, h4, p, a, button, span, strong, li, label, legend"))
        .filter((element) => rendered(element))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            text: clean(element.innerText || element.textContent, 180),
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
        })
        .filter((block) => block.text)
        .filter((block, index, list) =>
          list.findIndex((candidate) =>
            candidate.text === block.text &&
            Math.abs(candidate.x - block.x) <= 2 &&
            Math.abs(candidate.y - block.y) <= 2
          ) === index
        )
        .slice(0, 80);
      const images = Array.from(card.querySelectorAll("img"))
        .filter((image) => rendered(image))
        .map((image) => ({
          src: image.currentSrc || image.src || image.getAttribute("data-src") || "",
          alt: clean(image.alt, 160),
          rect: rectInfo(image.getBoundingClientRect())
        }))
        .filter((image) => image.src)
        .slice(0, 12);
      const visibleItem = {
        key: state.productKey,
        label: state.productLabel,
        productIndex: state.productIndex,
        categoryKey: state.categoryKey,
        categoryLabel: state.categoryLabel,
        variantKey: state.variantKey,
        variantLabel: state.variantLabel,
        variantOptions: state.variantOptions,
        text: clean(card.innerText || card.textContent, 500),
        rect: rectInfo(cardRect)
      };
      const text = textBlocks.map((block) => block.text).join(" ").slice(0, 3200);
      return {
        ok: true,
        clip: {
          x: clipX,
          y: clipY,
          width: clipWidth,
          height: clipHeight
        },
        text,
        textBlocks,
        images,
        logicalSignature: state.logicalSignature || [definition.key, state.categoryKey, state.productKey, state.variantKey].filter(Boolean).join("|"),
        visibleItemCount: 1,
        visibleItems: [visibleItem],
        itemRects: [{
          key: state.productKey,
          label: state.productLabel,
          rect: rectInfo(cardRect)
        }],
        windowSignature: JSON.stringify({
          product: state.productKey,
          variant: state.variantKey,
          texts: textBlocks.slice(0, 24).map((block) => block.text),
          images: images.map((image) => image.src)
        }).slice(0, 1800)
      };
    })()`,
    returnByValue: true
  }).catch(() => null);
  return result?.result?.value || { ok: false, reason: `Could not read ${state?.stateLabel || "collection product variant"} state.` };
}

function isAcceptableCollectionProductVariantBlankAudit(blankAudit, state) {
  if (!blankAudit || blankAudit.status === "ok" || blankAudit.fullImageNearWhite) {
    return false;
  }
  const textBlocks = Array.isArray(state?.textBlocks) ? state.textBlocks : [];
  const images = Array.isArray(state?.images) ? state.images : [];
  const visibleItems = Array.isArray(state?.visibleItems) ? state.visibleItems : [];
  return textBlocks.length >= 3 || images.length >= 1 || visibleItems.length >= 1;
}

async function captureShokzComparisonRelatedSection(client, outputPath, captureContext, definition) {
  const viewport = viewportForCaptureContext(captureContext);
  const positioned = await positionShokzComparisonQuickLookSection(client);
  if (!positioned.ok) {
    return {
      width: Number(viewport.width || 0) || 393,
      height: Number(viewport.height || 0) || 852,
      captures: [],
      warnings: [{
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        message: positioned.reason || `Could not position ${definition.sectionLabel}.`
      }],
      expectedCount: 0,
      capturedCount: 0
    };
  }

  await sleep(550);
  await primeLazyImages(client);
  let plan = await readShokzComparisonRelatedSectionPlan(client, definition, captureContext);
  if (!plan.ok) {
    return {
      width: Number(viewport.width || 0) || 393,
      height: Number(viewport.height || 0) || 852,
      captures: [],
      warnings: [{
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        message: plan.reason || `Could not read ${definition.sectionLabel} plan.`
      }],
      expectedCount: 0,
      capturedCount: 0
    };
  }
  if (!Array.isArray(plan.states) || !plan.states.length) {
    return {
      width: Number(viewport.width || 0) || 393,
      height: Number(viewport.height || 0) || 852,
      captures: [],
      warnings: plan.warnings || [],
      expectedCount: 0,
      capturedCount: 0
    };
  }

  const captures = [];
  const warnings = Array.isArray(plan.warnings) ? [...plan.warnings] : [];

  for (const [index, state] of plan.states.entries()) {
    const activation = await activateShokzComparisonRelatedState(client, definition, state);
    if (!activation.ok) {
      warnings.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        stateLabel: state.stateLabel,
        message: activation.reason || `Could not activate ${definition.sectionLabel} state.`
      });
      continue;
    }

    const ready = await waitForShokzComparisonQuickLookState(client, state);
    if (!ready.ok) {
      warnings.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        stateLabel: state.stateLabel,
        message: ready.reason || `Could not confirm ${state.stateLabel} state.`
      });
      continue;
    }

    await sleep(520);
    await primeLazyImages(client);
    await waitForRelatedSectionImages(client, definition.key);
    await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 2 });
    await dismissObstructions(client, { rounds: 3 });

    let current = await readShokzComparisonRelatedState(client, definition, state);
    if (!current.ok) {
      warnings.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        stateLabel: state.stateLabel,
        message: current.reason || `Could not read ${definition.sectionLabel} state.`
      });
      continue;
    }
    let clip = normalizeRelatedClip(current.clip, viewport);
    if (!clip) {
      warnings.push({
        sectionKey: definition.key,
        sectionLabel: definition.sectionLabel,
        stateLabel: state.stateLabel,
        message: `Could not compute a valid crop for ${state.stateLabel}.`
      });
      continue;
    }

    const screenshotCapture = await captureScreenshotWithValidation(client, () => ({
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip
    }), {
      label: `${definition.key} ${state.stateLabel}`,
      beforeAttempt: async ({ attempt }) => {
        if (attempt > 1) {
          const retryActivation = await activateShokzComparisonRelatedState(client, definition, state);
          if (!retryActivation.ok) {
            throw new Error(retryActivation.reason || `Could not reactivate ${state.stateLabel}.`);
          }
          const retryReady = await waitForShokzComparisonQuickLookState(client, state);
          if (!retryReady.ok) {
            throw new Error(retryReady.reason || `Could not confirm ${state.stateLabel} on retry.`);
          }
          await sleep(420);
        }
        await prepareForScreenshotCapture(client, {
          rounds: 2,
          shokzKnownPopups: true,
          stage: `before Shokz ${definition.sectionLabel} screenshot capture`
        });
        await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 2 });
        await dismissObstructions(client, { rounds: 3 });
        await settlePositionedViewport(client, {
          delayMs: attempt > 1 ? 280 : 180,
          frames: 2
        });
        current = await readShokzComparisonRelatedState(client, definition, state);
        if (!current.ok) {
          throw new Error(current.reason || `Could not reread ${state.stateLabel}.`);
        }
        clip = normalizeRelatedClip(current.clip, viewport);
        if (!clip) {
          throw new Error(`Could not compute a valid crop for ${state.stateLabel}.`);
        }
      }
    });

    const buffer = screenshotCapture.buffer;
    const visualSignature = hashBuffer(buffer);
    const visualHash = visualHashForBuffer(buffer);
    const visualAudit = visualAuditForBuffer(buffer, visualHash);
    const logicalSignature = current.logicalSignature || state.logicalSignature || `${definition.key}:${state.fileId || state.stateLabel || index + 1}`;
    const relatedOutput = relatedOutputPath(outputPath, definition.key, state.fileId || state.stateIndex || index + 1);
    await fs.writeFile(relatedOutput, buffer);

    const width = Math.round(clip.width);
    const height = Math.round(clip.height);
    captures.push({
      outputPath: relatedOutput,
      width,
      height,
      kind: "carousel",
      sectionKey: definition.key,
      sectionLabel: definition.sectionLabel,
      sectionTitle: definition.title,
      stateIndex: state.stateIndex || index + 1,
      stateCount: state.pageCount || plan.states.length,
      stateLabel: state.stateLabel,
      label: state.stateLabel,
      tabLabel: state.tabLabel || null,
      tabIndex: state.tabIndex || null,
      pageIndex: state.pageIndex || null,
      interactionState: "default",
      logicalSignature,
      visualSignature,
      visualHash,
      visualAudit,
      captureValidation: screenshotCapture.captureValidation,
      clip: {
        x: Math.round(clip.x),
        y: Math.round(clip.y),
        width,
        height
      },
      isDefaultState: Boolean(state.isDefaultState),
      coverageKey: relatedCoverageKeyForState(state),
      sectionState: {
        text: current.text || "",
        textBlocks: current.textBlocks || [],
        images: current.images || [],
        activeIndex: state.stateIndex || index + 1,
        tabLabel: state.tabLabel || null,
        tabIndex: state.tabIndex || null,
        pageIndex: state.pageIndex || null,
        interactionState: "default",
        visibleItemCount: current.visibleItemCount || null,
        visibleItems: current.visibleItems || null,
        itemRects: current.itemRects || null,
        windowSignature: current.windowSignature || null
      }
    });
  }

  warnings.push(...relatedSectionCoverageWarnings(definition, plan.states, captures));

  return {
    width: captures.reduce((max, capture) => Math.max(max, Number(capture.width || 0)), Number(viewport.width || 0) || 393),
    height: captures.reduce((max, capture) => Math.max(max, Number(capture.height || 0)), Number(viewport.height || 0) || 852),
    captures,
    warnings,
    expectedCount: plan.states.length,
    capturedCount: captures.length
  };
}

async function positionShokzComparisonQuickLookSection(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const title = Array.from(document.querySelectorAll("h2")).find((node) => clean(node.textContent) === "Quick Look") || null;
      if (!title) {
        return { ok: false, reason: "Could not locate Quick Look section." };
      }
      const targetY = Math.max(0, Math.round(window.scrollY + title.getBoundingClientRect().top - 80));
      window.scrollTo(0, targetY);
      return { ok: true, scrollY: targetY };
    })()`,
    returnByValue: true
  }).catch(() => null);
  if (result?.result?.value?.ok) {
    await sleep(360);
  }
  return result?.result?.value || { ok: false, reason: "Could not position Quick Look section." };
}

async function readShokzComparisonRelatedSectionPlan(client, definition, captureContext = {}) {
  const viewport = viewportForCaptureContext(captureContext);
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const definition = ${JSON.stringify(definition || {})};
      const viewport = ${JSON.stringify({
        width: Number(viewport.width || 0) || 393,
        height: Number(viewport.height || 0) || 852
      })};
      const clean = (value, max = 160) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, max);
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
      const rectInfo = (rect) => ({
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      });
      const title = Array.from(document.querySelectorAll("h2")).find((node) => clean(node.textContent) === "Quick Look") || null;
      if (!title) {
        return { ok: false, reason: "Could not locate Quick Look section." };
      }
      const wrapper = title.closest(".less-wrapper-sec, .content-wrapper, section, .shopify-section") || title.parentElement;
      const itemList = wrapper?.querySelector(".item.item-imagelist") || null;
      if (!wrapper || !itemList) {
        return { ok: false, reason: "Could not locate Quick Look content wrapper." };
      }
      const firstSpec = Array.from(wrapper.querySelectorAll("h3")).find((node) => clean(node.textContent) && clean(node.textContent) !== "Quick Look") || null;
      const titleRect = title.getBoundingClientRect();
      const itemRect = itemList.getBoundingClientRect();
      const clipY = Math.max(0, Math.floor(window.scrollY + titleRect.top - 12));
      const clipBottom = firstSpec
        ? Math.ceil(window.scrollY + firstSpec.getBoundingClientRect().top + 8)
        : Math.ceil(window.scrollY + itemRect.bottom + 24);
      const clipHeight = Math.max(220, clipBottom - clipY);
      const labelByHandle = new Map();
      for (const node of Array.from(document.querySelectorAll(".item.product-name .content.active[data-handle], .item-inner .content.active[data-handle]"))) {
        const handle = clean(node.getAttribute("data-handle"), 80).toLowerCase();
        const text = clean(
          node.innerText ||
          node.textContent ||
          node.closest(".item-inner, .compare-col")?.innerText ||
          node.closest(".item-inner, .compare-col")?.textContent,
          80
        );
        if (handle && text && !labelByHandle.has(handle)) {
          labelByHandle.set(handle, text);
        }
      }
      const trackNodes = Array.from(itemList.querySelectorAll(".content.data.active[data-handle]"))
        .filter((node) => visible(node))
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return { node, rect };
        })
        .sort((a, b) => a.rect.left - b.rect.left)
        .slice(0, Math.max(1, Number(definition.maxTracks || 2)));
      if (!trackNodes.length) {
        return { ok: false, reason: "Could not find active Quick Look carousels." };
      }

      window.__pageShotRelatedSections = window.__pageShotRelatedSections || {};
      window.__pageShotRelatedSections[definition.key] = { root: wrapper };

      const states = [];
      let stateIndex = 0;
      for (const [trackIndex, entry] of trackNodes.entries()) {
        const node = entry.node;
        const handle = clean(node.getAttribute("data-handle"), 80).toLowerCase();
        const fallbackKey = handle || ("product-" + (trackIndex + 1));
        const productLabel = labelByHandle.get(handle) || clean(handle.replace(/[-_]+/g, " "), 80) || ("Product " + (trackIndex + 1));
        const slideCount = Math.max(
          node.querySelectorAll(".swiper-slide").length,
          node.querySelectorAll(".swiper-pagination-bullet").length
        );
        const maxPage = Math.min(slideCount, Math.max(1, Number(definition.maxPagesPerTrack || slideCount)));
        for (let pageIndex = 2; pageIndex <= maxPage; pageIndex += 1) {
          stateIndex += 1;
          states.push({
            sectionKey: definition.key,
            stateIndex,
            stateLabel: productLabel + " / Slide " + pageIndex,
            tabLabel: productLabel,
            tabIndex: trackIndex + 1,
            pageIndex,
            pageCount: slideCount,
            fileId: fallbackKey + "-slide-" + pageIndex,
            logicalSignature: [definition.key, fallbackKey, "slide-" + pageIndex].join("|"),
            handle,
            clip: {
              x: 0,
              y: clipY,
              width: Math.max(1, Math.ceil(viewport.width || window.innerWidth || 393)),
              height: clipHeight
            },
            directItem: {
              key: fallbackKey,
              label: productLabel,
              rect: rectInfo(entry.rect)
            }
          });
        }
      }

      return {
        ok: true,
        states,
        warnings: [],
        clip: {
          x: 0,
          y: clipY,
          width: Math.max(1, Math.ceil(viewport.width || window.innerWidth || 393)),
          height: clipHeight
        }
      };
    })()`,
    returnByValue: true
  }).catch(() => null);
  return result?.result?.value || { ok: false, reason: `Could not read ${definition?.sectionLabel || "comparison"} plan.` };
}

async function activateShokzComparisonRelatedState(client, definition, state) {
  if (definition.key !== "comparison-quick-look") {
    return { ok: false, reason: `Unsupported comparison section: ${definition.key || "(missing)"}.` };
  }
  const positioned = await positionShokzComparisonQuickLookSection(client);
  if (!positioned.ok) {
    return positioned;
  }
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const state = ${JSON.stringify({
        handle: String(state?.handle || "").trim().toLowerCase(),
        tabIndex: Number(state?.tabIndex || 0) || 0,
        pageIndex: Number(state?.pageIndex || 0) || 0,
        stateLabel: state?.stateLabel || ""
      })};
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
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
      const title = Array.from(document.querySelectorAll("h2")).find((node) => clean(node.textContent) === "Quick Look") || null;
      const wrapper = title?.closest(".less-wrapper-sec, .content-wrapper, section, .shopify-section") || null;
      const itemList = wrapper?.querySelector(".item.item-imagelist") || null;
      if (!itemList) {
        return { ok: false, reason: "Could not find Quick Look carousel list." };
      }
      const tracks = Array.from(itemList.querySelectorAll(".content.data.active[data-handle]"))
        .filter((node) => visible(node))
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .sort((a, b) => a.rect.left - b.rect.left)
        .map((entry) => entry.node);
      const track = tracks.find((node) => clean(node.getAttribute("data-handle")).toLowerCase() === state.handle) ||
        tracks[Math.max(0, state.tabIndex - 1)] ||
        null;
      if (!track) {
        return { ok: false, reason: "Could not find active carousel for " + (state.stateLabel || state.handle || "Quick Look") + "." };
      }
      const bullets = Array.from(track.querySelectorAll(".swiper-pagination-bullet"));
      const currentActive = track.querySelector(".swiper-slide-active img, .swiper-slide-visible img") || null;
      const currentIndex = Number(currentActive?.getAttribute("data-index") || 1) || 1;
      const targetIndex = Math.max(1, Number(state.pageIndex || currentIndex) || currentIndex);
      const targetBullet = bullets[targetIndex - 1] || null;
      if (targetBullet && typeof targetBullet.click === "function") {
        targetBullet.click();
        return { ok: true, targetIndex, currentIndex, mode: "bullet" };
      }
      const next = track.querySelector("[class*='swiper-btnnext'], .swiper-button-next");
      const prev = track.querySelector("[class*='swiper-btnprev'], .swiper-button-prev");
      if (targetIndex > currentIndex && next) {
        for (let step = currentIndex; step < targetIndex; step += 1) {
          next.click();
        }
        return { ok: true, targetIndex, currentIndex, mode: "next" };
      }
      if (targetIndex < currentIndex && prev) {
        for (let step = currentIndex; step > targetIndex; step -= 1) {
          prev.click();
        }
        return { ok: true, targetIndex, currentIndex, mode: "prev" };
      }
      return targetIndex === currentIndex
        ? { ok: true, targetIndex, currentIndex, mode: "noop" }
        : { ok: false, reason: "Could not activate " + (state.stateLabel || state.handle || "Quick Look") + " slide " + targetIndex + "." };
    })()`,
    returnByValue: true
  }).catch(() => null);
  return result?.result?.value || { ok: false, reason: `Could not activate ${state?.stateLabel || "Quick Look"} state.` };
}

async function waitForShokzComparisonQuickLookState(client, state, options = {}) {
  const timeoutMs = Math.max(400, Math.min(5000, Number(options.timeoutMs) || 2600));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const state = ${JSON.stringify({
          handle: String(state?.handle || "").trim().toLowerCase(),
          tabIndex: Number(state?.tabIndex || 0) || 0,
          pageIndex: Number(state?.pageIndex || 0) || 0
        })};
        const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
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
        const title = Array.from(document.querySelectorAll("h2")).find((node) => clean(node.textContent) === "Quick Look") || null;
        const wrapper = title?.closest(".less-wrapper-sec, .content-wrapper, section, .shopify-section") || null;
        const itemList = wrapper?.querySelector(".item.item-imagelist") || null;
        if (!itemList) {
          return { ok: false, reason: "Quick Look list is missing." };
        }
        const tracks = Array.from(itemList.querySelectorAll(".content.data.active[data-handle]"))
          .filter((node) => visible(node))
          .map((node) => ({ node, rect: node.getBoundingClientRect() }))
          .sort((a, b) => a.rect.left - b.rect.left)
          .map((entry) => entry.node);
        const track = tracks.find((node) => clean(node.getAttribute("data-handle")).toLowerCase() === state.handle) ||
          tracks[Math.max(0, state.tabIndex - 1)] ||
          null;
        if (!track) {
          return { ok: false, reason: "Quick Look carousel track is missing." };
        }
        const activeImage = track.querySelector(".swiper-slide-active img, .swiper-slide-visible img") || null;
        const activeIndex = Number(activeImage?.getAttribute("data-index") || 0) || 0;
        const bullets = Array.from(track.querySelectorAll(".swiper-pagination-bullet"));
        const activeBulletIndex = bullets.findIndex((element) => element.classList.contains("swiper-pagination-bullet-active"));
        const effectiveIndex = activeIndex || (activeBulletIndex >= 0 ? activeBulletIndex + 1 : 0);
        return {
          ok: effectiveIndex === Math.max(1, state.pageIndex || 1),
          activeIndex: effectiveIndex
        };
      })()`,
      returnByValue: true
    }).catch(() => null);
    const value = result?.result?.value || {};
    if (value.ok) {
      return { ok: true, activeIndex: Number(value.activeIndex || 0) || null };
    }
    await sleep(160);
  }
  return { ok: false, reason: `Quick Look slide ${state?.pageIndex || "?"} did not become active.` };
}

async function readShokzComparisonRelatedState(client, definition, state) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const definition = ${JSON.stringify({
        key: definition?.key || "",
        sectionLabel: definition?.sectionLabel || "",
        title: definition?.title || ""
      })};
      const state = ${JSON.stringify({
        handle: String(state?.handle || "").trim().toLowerCase(),
        stateLabel: state?.stateLabel || "",
        tabLabel: state?.tabLabel || "",
        logicalSignature: state?.logicalSignature || "",
        fileId: state?.fileId || "",
        pageIndex: Number(state?.pageIndex || 0) || 0,
        tabIndex: Number(state?.tabIndex || 0) || 0
      })};
      const clean = (value, max = 300) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, max);
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
      const rectInfo = (rect) => ({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      });
      const title = Array.from(document.querySelectorAll("h2")).find((node) => clean(node.textContent) === "Quick Look") || null;
      if (!title) {
        return { ok: false, reason: "Could not locate Quick Look section." };
      }
      const wrapper = title.closest(".less-wrapper-sec, .content-wrapper, section, .shopify-section") || title.parentElement;
      const itemList = wrapper?.querySelector(".item.item-imagelist") || null;
      if (!wrapper || !itemList) {
        return { ok: false, reason: "Could not locate Quick Look content wrapper." };
      }
      const titleRect = title.getBoundingClientRect();
      const firstSpec = Array.from(wrapper.querySelectorAll("h3")).find((node) => clean(node.textContent) && clean(node.textContent) !== "Quick Look") || null;
      const itemRect = itemList.getBoundingClientRect();
      const clipY = Math.max(0, Math.floor(window.scrollY + titleRect.top - 12));
      const clipBottom = firstSpec
        ? Math.ceil(window.scrollY + firstSpec.getBoundingClientRect().top + 8)
        : Math.ceil(window.scrollY + itemRect.bottom + 24);
      const clipHeight = Math.max(220, clipBottom - clipY);
      const labelByHandle = new Map();
      for (const node of Array.from(document.querySelectorAll(".item.product-name .content.active[data-handle], .item-inner .content.active[data-handle]"))) {
        const handle = clean(node.getAttribute("data-handle"), 80).toLowerCase();
        const text = clean(
          node.innerText ||
          node.textContent ||
          node.closest(".item-inner, .compare-col")?.innerText ||
          node.closest(".item-inner, .compare-col")?.textContent,
          80
        );
        if (handle && text && !labelByHandle.has(handle)) {
          labelByHandle.set(handle, text);
        }
      }
      const tracks = Array.from(itemList.querySelectorAll(".content.data.active[data-handle]"))
        .filter((node) => visible(node))
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .sort((a, b) => a.rect.left - b.rect.left);
      if (!tracks.length) {
        return { ok: false, reason: "Could not find active Quick Look carousels." };
      }

      window.__pageShotRelatedSections = window.__pageShotRelatedSections || {};
      window.__pageShotRelatedSections[definition.key] = { root: wrapper };

      const visibleItems = tracks.map((entry, index) => {
        const node = entry.node;
        const handle = clean(node.getAttribute("data-handle"), 80).toLowerCase();
        const fallbackKey = handle || ("product-" + (index + 1));
        const label = labelByHandle.get(handle) || clean(handle.replace(/[-_]+/g, " "), 80) || ("Product " + (index + 1));
        const slideImage = node.querySelector(".swiper-slide-active img, .swiper-slide-visible img") || null;
        const activeIndex = Number(slideImage?.getAttribute("data-index") || 0) ||
          (Array.from(node.querySelectorAll(".swiper-pagination-bullet")).findIndex((element) => element.classList.contains("swiper-pagination-bullet-active")) + 1) ||
          1;
        return {
          key: fallbackKey,
          label,
          text: clean(label + " Slide " + activeIndex + " " + (slideImage?.getAttribute("alt") || ""), 200),
          rect: rectInfo((node.closest(".compare-col") || node).getBoundingClientRect()),
          activeIndex,
          imageSrc: slideImage?.currentSrc || slideImage?.src || slideImage?.getAttribute("data-src") || "",
          alt: clean(slideImage?.getAttribute("alt") || "", 200)
        };
      });

      const clipBottomLimit = clipY + clipHeight + 2;
      const textBlocks = Array.from(wrapper.querySelectorAll("h2, h3, p, a, button, span, strong"))
        .filter((element) => visible(element))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            text: clean(element.innerText || element.textContent, 160),
            absoluteTop: window.scrollY + rect.top,
            rect
          };
        })
        .filter((block) => block.text)
        .filter((block) => block.absoluteTop + block.rect.height >= clipY && block.absoluteTop <= clipBottomLimit)
        .map((block) => ({
          text: block.text,
          x: Math.round(block.rect.left),
          y: Math.round(block.rect.top),
          width: Math.round(block.rect.width),
          height: Math.round(block.rect.height)
        }))
        .filter((block, index, list) =>
          list.findIndex((candidate) =>
            candidate.text === block.text &&
            Math.abs(candidate.x - block.x) <= 2 &&
            Math.abs(candidate.y - block.y) <= 2
          ) === index
        )
        .slice(0, 60);
      const images = visibleItems
        .filter((item) => item.imageSrc)
        .map((item) => ({
          src: item.imageSrc,
          alt: item.alt,
          rect: item.rect
        }));
      const text = textBlocks.map((block) => block.text).join(" ").slice(0, 2200);
      return {
        ok: true,
        clip: {
          x: 0,
          y: clipY,
          width: Math.max(1, Math.ceil(window.innerWidth || document.documentElement.clientWidth || 393)),
          height: clipHeight
        },
        text,
        textBlocks,
        images,
        logicalSignature: state.logicalSignature || [definition.key, state.handle, "slide-" + (state.pageIndex || 1)].filter(Boolean).join("|"),
        visibleItemCount: visibleItems.length,
        visibleItems,
        itemRects: visibleItems.map((item) => ({
          key: item.key,
          label: item.label,
          rect: item.rect
        })),
        windowSignature: JSON.stringify({
          items: visibleItems.map((item) => item.key + ":" + item.activeIndex),
          texts: textBlocks.slice(0, 18).map((block) => block.text),
          images: images.map((image) => image.src)
        }).slice(0, 1800)
      };
    })()`,
    returnByValue: true
  }).catch(() => null);
  return result?.result?.value || { ok: false, reason: `Could not read ${definition?.sectionLabel || "comparison"} state.` };
}

function collectionStateContainsSignupOverlay(state) {
  const text = String(state?.text || "");
  return /(be the first to know|subscribe now|please enter a valid email|primary use case)/i.test(text);
}

async function dismissShokzCollectionSignupOverlay(client) {
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
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const textOf = (element) => clean([
        element?.innerText,
        element?.textContent,
        element?.getAttribute?.("aria-label"),
        element?.getAttribute?.("title"),
        String(element?.className || "")
      ].filter(Boolean).join(" "));
      const popupMatch = (text) => /(be the first to know|subscribe now|please enter a valid email|primary use case)/i.test(text);
      const selector = "button, [role='button'], a, [aria-label], [title], [tabindex], svg, [class]";
      const closeMatch = /close|dismiss|no thanks|not now|icon-close|\\u00d7|^x$/i;
      const containers = [];
      const seen = new Set();
      for (const element of Array.from(document.querySelectorAll("body *"))) {
        if (!visible(element)) continue;
        const text = textOf(element);
        if (!popupMatch(text)) continue;
        const container = element.closest("[role='dialog'], [aria-modal='true'], [class*='modal'], [class*='popup'], [class*='dialog'], [class*='klaviyo'], [class*='newsletter']") || element;
        if (!visible(container) || seen.has(container)) continue;
        seen.add(container);
        containers.push(container);
      }
      const clicked = [];
      const hidden = [];
      for (const container of containers) {
        const rect = container.getBoundingClientRect();
        const controls = Array.from(container.querySelectorAll(selector))
          .filter((control) => visible(control))
          .sort((a, b) => {
            const aRect = a.getBoundingClientRect();
            const bRect = b.getBoundingClientRect();
            const aTopRight = Math.abs(aRect.top - rect.top) + Math.abs(aRect.right - rect.right);
            const bTopRight = Math.abs(bRect.top - rect.top) + Math.abs(bRect.right - rect.right);
            return aTopRight - bTopRight;
          });
        let closed = false;
        for (const control of controls) {
          const controlText = textOf(control);
          const controlRect = control.getBoundingClientRect();
          const nearTopRight = controlRect.left >= rect.right - Math.max(140, rect.width * 0.35) &&
            controlRect.top <= rect.top + Math.max(120, rect.height * 0.3) &&
            controlRect.width <= 96 &&
            controlRect.height <= 96;
          if (!closeMatch.test(controlText) && !nearTopRight) {
            continue;
          }
          if (typeof control.click === "function") {
            control.click();
          } else {
            control.dispatchEvent(new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              view: window
            }));
          }
          clicked.push(controlText || "signup overlay close");
          closed = true;
          break;
        }
        if (!closed) {
          container.dataset.pageShotHidden = "true";
          container.style.setProperty("display", "none", "important");
          container.style.setProperty("visibility", "hidden", "important");
          container.style.setProperty("pointer-events", "none", "important");
          hidden.push(textOf(container).slice(0, 80) || "signup overlay");
        }
      }
      document.body.classList.remove("overflow-hidden");
      document.documentElement.classList.remove("overflow-hidden");
      return { ok: Boolean(clicked.length || hidden.length), clicked, hidden };
    })()`,
    returnByValue: true
  }).catch(() => null);
  if (result?.result?.value?.ok) {
    await sleep(420);
  }
  return result?.result?.value || { ok: false, clicked: [], hidden: [] };
}

async function activateShokzCollectionRelatedState(client, definition, state) {
  if (definition.key === "collection-tabs") {
    return activateShokzCollectionTab(client, state);
  }
  if (definition.key === "compare-model") {
    return positionShokzCollectionCompareSection(client, state);
  }
  return { ok: false, reason: `Unsupported collection section: ${definition.key || "(missing)"}.` };
}

async function activateShokzCollectionTab(client, state) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const label = ${JSON.stringify(String(state?.clickLabel || state?.tabLabel || state?.stateLabel || "").trim())};
      const handle = ${JSON.stringify(String(state?.matchHandle || "").trim().toLowerCase())};
      const matchPatterns = ${JSON.stringify(
        Array.isArray(state?.matchPatterns) && state.matchPatterns.length
          ? state.matchPatterns
          : [String(state?.clickLabel || state?.tabLabel || state?.stateLabel || "")]
      )};
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const normalize = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
      const rendered = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const topLimit = Math.max(260, window.innerHeight * 0.5);
      const targetPatterns = matchPatterns
        .map((pattern) => normalize(pattern))
        .filter(Boolean);
      const matchesPattern = (text) => {
        const normalized = normalize(text);
        if (!normalized) return false;
        if (targetPatterns.some((pattern) => normalized === pattern || normalized.includes(pattern) || pattern.includes(normalized))) {
          return true;
        }
        return false;
      };
      const findScrollParent = (element) => {
        let current = element?.parentElement || null;
        while (current && current !== document.body) {
          if (current.scrollWidth > current.clientWidth + 8) {
            return current;
          }
          current = current.parentElement;
        }
        return null;
      };
      const tabSelector = ".fitler_list .filter_item, .filter_item";
      const collectCandidates = (selector) => Array.from(document.querySelectorAll(selector))
        .map((element) => {
          const clickTarget = element.matches(".filter_item, [data-handle], button, a, [role='tab']")
            ? element
            : element.closest(".filter_item, [data-handle], button, a, [role='tab']") || element;
          const elementHandle = String(element.getAttribute?.("data-handle") || "").trim().toLowerCase();
          const clickHandle = String(clickTarget.getAttribute?.("data-handle") || "").trim().toLowerCase();
          const text = clean(element.innerText || element.textContent);
          const textNormalized = normalize(text);
          const targetNormalized = normalize(label);
          const exactTextMatch = Boolean(targetNormalized) && textNormalized === targetNormalized;
          const fuzzyTextMatch = matchesPattern(text);
          const handleMatch = Boolean(handle) && (elementHandle === handle || clickHandle === handle);
          const rect = clickTarget.getBoundingClientRect();
          return {
            clickTarget,
            rect,
            elementHandle,
            clickHandle,
            exactTextMatch,
            fuzzyTextMatch,
            handleMatch
          };
        })
        .map((element) => {
          return element;
        })
        .filter(({ clickTarget, rect }) =>
          rendered(clickTarget) &&
          rect.top >= 40 &&
          rect.top <= topLimit &&
          rect.height <= 90
        )
        .filter(({ handleMatch, exactTextMatch, fuzzyTextMatch }) => {
          if (handle) {
            return handleMatch;
          }
          return exactTextMatch || fuzzyTextMatch;
        })
        .sort((a, b) =>
          Number(b.handleMatch) - Number(a.handleMatch) ||
          Number(b.exactTextMatch) - Number(a.exactTextMatch) ||
          a.rect.width * a.rect.height - b.rect.width * b.rect.height ||
          a.rect.top - b.rect.top ||
          Math.abs(a.rect.left) - Math.abs(b.rect.left)
        );
      let candidates = collectCandidates(tabSelector);
      if (!candidates.length) {
        candidates = collectCandidates("button, a, [role='tab'], li, div, span, h1, h2, h3, h4");
      }
      const match = candidates[0];
      if (!match) {
        return { ok: false, reason: "Could not find collection tab " + label + "." };
      }
      const scrollParent = findScrollParent(match.clickTarget);
      if (scrollParent) {
        match.clickTarget.scrollIntoView({ block: "nearest", inline: "center" });
      } else {
        match.clickTarget.scrollIntoView({ block: "center", inline: "center" });
      }
      window.scrollTo(0, 0);
      if (typeof match.clickTarget.click === "function") {
        match.clickTarget.click();
      } else {
        match.clickTarget.dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window
        }));
      }
      return { ok: true, label, handle };
    })()`,
    returnByValue: true
  }).catch(() => null);
  return result?.result?.value || { ok: false, reason: `Could not activate collection tab ${state?.tabLabel || state?.stateLabel || ""}.` };
}

async function waitForShokzCollectionTabActivated(client, state, options = {}) {
  const timeoutMs = Math.max(400, Math.min(5000, Number(options.timeoutMs) || 2600));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const label = ${JSON.stringify(String(state?.clickLabel || state?.tabLabel || state?.stateLabel || "").trim())};
        const handle = ${JSON.stringify(String(state?.matchHandle || "").trim().toLowerCase())};
        const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const normalize = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
        const active = document.querySelector(".fitler_list .filter_item.active, .filter_item.active") || null;
        if (!active) {
          return { ok: false, reason: "No active collection tab found." };
        }
        const activeHandle = String(active.getAttribute("data-handle") || "").trim().toLowerCase();
        const activeText = clean(active.innerText || active.textContent);
        const activeNormalized = normalize(activeText);
        const targetNormalized = normalize(label);
        const ok = handle
          ? activeHandle === handle
          : activeNormalized === targetNormalized ||
            activeNormalized.includes(targetNormalized) ||
            targetNormalized.includes(activeNormalized);
        return {
          ok,
          activeHandle,
          activeText
        };
      })()`,
      returnByValue: true
    }).catch(() => null);
    const value = result?.result?.value || {};
    if (value.ok) {
      return { ok: true, activeHandle: value.activeHandle || "", activeText: value.activeText || "" };
    }
    await sleep(160);
  }
  return { ok: false, reason: `Collection tab ${state?.tabLabel || state?.stateLabel || ""} did not become active.` };
}

async function positionShokzCollectionCompareSection(client, state) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const anchorText = ${JSON.stringify(String(state?.anchorText || state?.stateLabel || "Compare Shokz Model").trim())};
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
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
      const nodes = Array.from(document.querySelectorAll("h1, h2, h3, h4, p, a, button, div, span"))
        .filter((element) => visible(element) && clean(element.innerText || element.textContent).includes(anchorText))
        .map((element) => {
          const section = element.closest("section, .shopify-section, [class*='section'], [class*='compare'], [class*='banner']") || element;
          const rect = section.getBoundingClientRect();
          return { section, rect };
        })
        .sort((a, b) => a.rect.top - b.rect.top);
      const match = nodes[0];
      if (!match) {
        return { ok: false, reason: "Could not locate Compare Shokz Model section." };
      }
      const targetY = Math.max(0, Math.round(window.scrollY + match.rect.top - 92));
      window.scrollTo(0, targetY);
      return { ok: true, scrollY: targetY };
    })()`,
    returnByValue: true
  }).catch(() => null);
  return result?.result?.value || { ok: false, reason: "Could not position Compare Shokz Model section." };
}

async function readShokzCollectionRelatedState(client, definition, state) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const definition = ${JSON.stringify({
        key: definition?.key || "",
        sectionLabel: definition?.sectionLabel || "",
        title: definition?.title || ""
      })};
      const state = ${JSON.stringify({
        stateLabel: state?.stateLabel || "",
        tabLabel: state?.tabLabel || "",
        logicalSignature: state?.logicalSignature || "",
        fileId: state?.fileId || ""
      })};
      const clean = (value, max = 300) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, max);
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
      const inViewport = (rect) =>
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;
      const rectInfo = (rect) => ({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      });
      const textBlocks = Array.from(document.querySelectorAll("h1, h2, h3, h4, p, a, button, span, strong, li"))
        .filter((element) => visible(element) && inViewport(element.getBoundingClientRect()))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            text: clean(element.innerText || element.textContent, 160),
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
        })
        .filter((block) => block.text)
        .filter((block, index, list) =>
          list.findIndex((candidate) =>
            candidate.text === block.text &&
            Math.abs(candidate.x - block.x) <= 2 &&
            Math.abs(candidate.y - block.y) <= 2
          ) === index
        )
        .slice(0, 80);
      const images = Array.from(document.images || [])
        .filter((image) => visible(image) && inViewport(image.getBoundingClientRect()))
        .map((image) => ({
          src: image.currentSrc || image.src || "",
          alt: clean(image.alt, 160),
          rect: rectInfo(image.getBoundingClientRect())
        }))
        .slice(0, 20);
      const productItems = Array.from(document.querySelectorAll("a[href*='/products/']"))
        .map((link) => {
          const card = link.closest("[data-product-card], article, li, [class*='product'][class*='card'], [class*='card'], [class*='slide']") || link;
          const rect = card.getBoundingClientRect();
          const href = (() => {
            try {
              return new URL(link.getAttribute("href") || link.href || "", window.location.href).pathname;
            } catch {
              return link.getAttribute("href") || link.href || "";
            }
          })();
          const label = clean(
            card.querySelector("h1, h2, h3, h4, [class*='title'], [class*='name']")?.innerText ||
            card.innerText ||
            link.innerText,
            120
          );
          return {
            key: href || label,
            label,
            text: clean(card.innerText, 260),
            rect: rectInfo(rect),
            visibleArea: Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0)) *
              Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0))
          };
        })
        .filter((item) => item.label && item.visibleArea >= 1800)
        .filter((item, index, list) => list.findIndex((candidate) => candidate.key === item.key) === index)
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
        .slice(0, 6);
      let visibleItems = productItems;
      if (definition.key === "compare-model") {
        const sectionNodes = Array.from(document.querySelectorAll("section, .shopify-section, [class*='section'], [class*='compare'], [class*='banner']"))
          .filter((element) => visible(element) && clean(element.innerText || element.textContent, 260).includes("Compare Shokz Model"))
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        const section = sectionNodes[0] || null;
        if (!section) {
          return { ok: false, reason: "Could not read Compare Shokz Model section." };
        }
        visibleItems = [{
          key: "compare-shokz-model",
          label: "Compare Shokz Model",
          text: clean(section.innerText, 260),
          rect: rectInfo(section.getBoundingClientRect())
        }];
      }
      const text = textBlocks.map((block) => block.text).join(" ").slice(0, 3200);
      return {
        ok: true,
        scrollY: Math.max(0, Math.round(window.scrollY || 0)),
        text,
        textBlocks,
        images,
        logicalSignature: state.logicalSignature || [definition.key, state.fileId || state.tabLabel || state.stateLabel].filter(Boolean).join("|"),
        visibleItemCount: visibleItems.length,
        visibleItems,
        itemRects: visibleItems.map((item) => ({
          key: item.key,
          label: item.label,
          rect: item.rect
        })),
        windowSignature: JSON.stringify({
          items: visibleItems.map((item) => item.key || item.label),
          texts: textBlocks.slice(0, 24).map((block) => block.text),
          images: images.slice(0, 12).map((image) => image.src)
        }).slice(0, 1800)
      };
    })()`,
    returnByValue: true
  }).catch(() => null);
  return result?.result?.value || { ok: false, reason: `Could not read ${definition?.sectionLabel || "collection"} state.` };
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
  if (state?.sectionKey === "collection-tabs" && (state.productKey || state.variantKey || state.categoryKey)) {
    return [
      state.sectionKey,
      state.categoryKey || state.tabIndex || state.tabLabel || "",
      state.productKey || state.productIndex || "",
      state.variantKey || state.variantLabel || "default"
    ].join("|");
  }

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

async function readShokzHomeRelatedSectionPlan(client, definition, captureContext = {}) {
  const viewport = viewportForCaptureContext(captureContext);
  const mobile = isMobileCaptureContext(captureContext);
  const runtimeDefinition = {
    ...definition,
    captureHover: definition.key === "product-showcase" &&
      !mobile &&
      !viewport.touch
  };
  if (runtimeDefinition.mobileOnly && !mobile && !viewport.touch) {
    return {
      ok: true,
      skipped: true,
      sectionKey: definition.key,
      sectionLabel: definition.sectionLabel,
      states: [],
      warnings: []
    };
  }
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
      const rootVisible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const selectorMatch = Boolean(definition.rootSelector && element.matches?.(definition.rootSelector));
        return rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          (selectorMatch || Number(style.opacity || 1) > 0.01);
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
          .filter((slide) => options.visibleOnly ? visible(slide) : true)
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
            (!options.visibleOnly || (
              item.rect.width >= 180 &&
              item.rect.height >= 120 &&
              item.centerY >= panelRect.top - 40 &&
              item.centerY <= panelRect.bottom + 40
            )) &&
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
      const mediaTrackDefinitions = ${JSON.stringify(shokzMediaTrackDefinitions)};
      const mediaTrackForLabel = (label) =>
        mediaTrackDefinitions.find((track) => track.label === label) || null;
      const mediaTrackPanel = (track) => track ? document.querySelector(track.selector) : null;
      const mediaTrackRoot = (track) => {
        const panel = mediaTrackPanel(track);
        return panel?.closest(track.rootSelector) || panel;
      };
      const mediaTrackSlideContainer = (track) => {
        const panel = mediaTrackPanel(track);
        const trackRoot = mediaTrackRoot(track);
        if (!panel) return trackRoot;
        return panel.querySelector(".swiper-slide, [class*='swiper-slide']") ? panel : trackRoot;
      };
      const mediaTrackViewportRect = (track) => {
        const panel = mediaTrackPanel(track);
        const trackRoot = mediaTrackRoot(track);
        const panelRect = panel?.getBoundingClientRect?.() || null;
        if (panelRect && panelRect.width >= 24 && panelRect.height >= 18) {
          return panelRect;
        }
        return trackRoot?.getBoundingClientRect?.() || panelRect || null;
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
        const slideContainer = mediaTrackSlideContainer(track);
        const viewportRect = mediaTrackViewportRect(track);
        if (!panel || !trackRoot || !slideContainer || !viewportRect) return [];
        const rootRect = trackRoot.getBoundingClientRect();
        const slides = Array.from(slideContainer.querySelectorAll(".swiper-slide, [class*='swiper-slide']"))
          .filter((slide) => visible(slide))
          .map((slide, domIndex) => {
            const rect = slide.getBoundingClientRect();
            const area = Math.max(1, rect.width * rect.height);
            const visibleArea = intersects(rect, viewportRect);
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
            item.centerY >= viewportRect.top - 20 &&
            item.centerY <= viewportRect.bottom + 20 &&
            (!options.visibleOnly || (
              item.visibleArea > 120 &&
              item.visibleRatio >= 0.55 &&
              item.rect.right > viewportRect.left + 4 &&
              item.rect.left < viewportRect.right - 4
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
      const genericCarouselPanel = (root) =>
        [root, ...root.querySelectorAll(".swiper, [class*='swiper'], .slick-slider, [class*='slider'], [class*='carousel']")]
          .filter((element) => visible(element) && element.querySelector(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const area = rect.width * rect.height;
            const activeCount = element.querySelectorAll(".swiper-slide-active, .slick-active, [class*='active']").length;
            const visibleSlides = Array.from(element.querySelectorAll(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"))
              .filter((slide) => visible(slide))
              .length;
            const score = activeCount * 200 + visibleSlides * 40 + Math.min(area / 1000, 600);
            return { element, rect, score };
          })
          .sort((a, b) => b.score - a.score || b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0]?.element || null;
      const genericCarouselSignature = (root) => {
        const panel = genericCarouselPanel(root);
        if (!panel) return "";
        const rootRect = root.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const viewportRect = panelRect.width >= 24 && panelRect.height >= 18 ? panelRect : rootRect;
        const centerX = viewportRect.left + viewportRect.width / 2;
        const slides = Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"))
          .filter((slide) => visible(slide))
          .map((slide, index) => {
            const rect = slide.getBoundingClientRect();
            const visibleArea = intersects(rect, viewportRect);
            const area = Math.max(1, rect.width * rect.height);
            const image = firstImageSource(slide);
            const imageFamily = mediaImageFamily(image);
            const text = dedupeRepeatedText(textOf(slide, 260), 220);
            const title = dedupeRepeatedText(
              slide.querySelector("h1, h2, h3, h4, [class*='title'], [class*='name'], p")?.innerText || text,
              120
            );
            const slideClass = classText(slide);
            const activeScore = Number(/active|current|selected/i.test(slideClass)) * 10000 +
              visibleArea -
              Math.abs((rect.left + rect.width / 2) - centerX) * 2;
            return {
              key: [
                title || "",
                imageFamily ? "img:" + imageFamily : "",
                slide.getAttribute("aria-label") || "",
                !title && !imageFamily ? "dom:" + index : ""
              ].filter(Boolean).join("|"),
              visibleArea,
              visibleRatio: visibleArea / area,
              activeScore
            };
          })
          .filter((slide) => slide.key && slide.visibleArea > 200 && slide.visibleRatio >= 0.08)
          .sort((a, b) => b.activeScore - a.activeScore || b.visibleArea - a.visibleArea);
        return slides[0]?.key || "";
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
        return genericCarouselSignature(root) || visibleSignature(root);
      };
      const findRoots = () => {
        const roots = new Set();
        if (definition.rootSelector) {
          document.querySelectorAll(definition.rootSelector).forEach((element) => roots.add(element));
        }
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
          if (!root || root === document.body || root === document.documentElement || !rootVisible(root)) return false;
          const rect = root.getBoundingClientRect();
          const minWidth = Math.max(24, Number(definition.minRootWidth || Math.min(260, window.innerWidth * 0.45)));
          const minHeight = Math.max(18, Number(definition.minRootHeight || 140));
          const maxHeight = Math.max(0, Number(definition.maxRootHeight || 0));
          return rect.width >= minWidth &&
            rect.height >= minHeight &&
            (!maxHeight || rect.height <= maxHeight);
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
            const selectorBonus = Number(Boolean(definition.rootSelector && root.matches?.(definition.rootSelector))) * 1200;
            const score = hits * 10000 +
              selectorBonus +
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
        let slides = Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"));
        for (const slide of slides) {
          if (slide.dataset.pageShotSceneForced === "true") {
            slide.style.removeProperty("display");
            slide.style.removeProperty("visibility");
            slide.style.removeProperty("opacity");
            slide.style.removeProperty("position");
            slide.style.removeProperty("left");
            slide.style.removeProperty("top");
            slide.style.removeProperty("transform");
            slide.style.removeProperty("transition");
            delete slide.dataset.pageShotSceneForced;
          }
        }
        slides = Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"))
          .filter((slide) => textOf(slide, 700));
        const targetText = cleanText(item?.expectedAnchor || item?.title || item?.label || "", 180).toLowerCase();
        const target = (targetText
          ? slides.find((slide) => textOf(slide, 700).toLowerCase().includes(targetText))
          : null) ||
          slides[Math.max(0, Math.min(slides.length - 1, Number(index || 0)))];
        if (!target) return false;
        const wrapper = target.parentElement;
        const panelRect = panel.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
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
          wrapper.style.transform = "none";
        }
        for (const slide of slides) {
          const isTarget = slide === target;
          slide.dataset.pageShotSceneForced = "true";
          slide.style.setProperty("transition", "none", "important");
          slide.style.setProperty("transform", "none", "important");
          slide.classList.toggle("swiper-slide-active", isTarget);
          slide.classList.toggle("slick-active", isTarget);
          if (isTarget) {
            slide.style.setProperty("display", "block", "important");
            slide.style.setProperty("visibility", "visible", "important");
            slide.style.setProperty("opacity", "1", "important");
            slide.style.setProperty("position", "relative", "important");
            slide.style.setProperty("left", "0", "important");
            slide.style.setProperty("top", "0", "important");
          } else {
            slide.style.setProperty("display", "none", "important");
            slide.style.setProperty("visibility", "hidden", "important");
            slide.style.setProperty("opacity", "0", "important");
          }
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
            return forceSceneSlideToIndex(root, fallbackIndex, item);
          }
          if (typeof swiper.update === "function") swiper.update();
          await sleep(420);
          return forceSceneSlideToIndex(root, fallbackIndex, item);
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
            windowSignature: signature || "",
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
          const fallbackSignature = () => genericCarouselSignature(trackRoot) || visibleSignature(trackRoot);
          if (!allItems.length || !firstWindowItems.length || !firstWindowSignature) {
            const startCount = states.length;
            const seen = new Set();
            const maxPages = Math.max(
              4,
              findPageBullets(trackRoot).length || 0,
              Array.from((mediaTrackSlideContainer(track) || trackRoot).querySelectorAll(".swiper-slide, [class*='swiper-slide']")).length || 0
            ) + 2;
            for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
              const signature = fallbackSignature();
              if (!signature || seen.has(signature)) break;
              seen.add(signature);
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
                windowSignature: "",
                itemCount: 0,
                visibleItemCount: 0,
                visibleItems: null,
                itemRects: null,
                fileId: track.label + "-" + pageIndex,
                isDefaultState: pageIndex === 1
              });
              const before = signature;
              const moved = await advanceMediaTrack(track);
              const after = fallbackSignature();
              if (!moved || !after || after === before || seen.has(after)) break;
            }
            if (states.length === startCount) {
              warnings.push({
                sectionKey: definition.key,
                sectionLabel: definition.sectionLabel,
                stateLabel: track.label,
                message: "Could not read visible media items for " + track.label + "."
              });
            }
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
        const bulletCount = findPageBullets(root).length;
        const expectedPages = Number(definition.expectedPages || 0);
        const maxPages = expectedPages > 0
          ? (bulletCount > 1 ? Math.min(bulletCount, expectedPages) : expectedPages)
          : (bulletCount > 1 ? bulletCount : 12);
        for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
          if (pageIndex > 1 && bulletCount > 1) {
            const moved = clickPageBullet(root, pageIndex);
            await sleep(450);
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
            windowSignature: signature,
            fileId: (tabLabel || "state") + "-" + pageIndex,
            isDefaultState
          });
          if (bulletCount > 1) {
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
            ((
              item.visibleArea > 600 &&
              item.visibleRatio >= 0.2 &&
              item.rect.width >= 180 &&
              item.rect.height >= 120 &&
              item.rect.right > rootRect.left + 12 &&
              item.rect.left < rootRect.right - 12 &&
              item.centerY >= panelRect.top - 40 &&
              item.centerY <= panelRect.bottom + 40
            ) ||
            Boolean(item.title || item.href || item.image))
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
      const mediaTrackDefinitions = ${JSON.stringify(shokzMediaTrackDefinitions)};
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
      const mediaTrackSlideContainer = (track) => {
        const panel = mediaTrackPanel(track);
        const trackRoot = mediaTrackRoot(track);
        if (!panel) return trackRoot;
        return panel.querySelector(".swiper-slide, [class*='swiper-slide']") ? panel : trackRoot;
      };
      const mediaTrackViewportRect = (track) => {
        const panel = mediaTrackPanel(track);
        const trackRoot = mediaTrackRoot(track);
        const panelRect = panel?.getBoundingClientRect?.() || null;
        if (panelRect && panelRect.width >= 24 && panelRect.height >= 18) {
          return panelRect;
        }
        return trackRoot?.getBoundingClientRect?.() || panelRect || null;
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
        const slideContainer = mediaTrackSlideContainer(track);
        const viewportRect = mediaTrackViewportRect(track);
        if (!panel || !slideContainer || !viewportRect) return [];
        const slides = Array.from(slideContainer.querySelectorAll(".swiper-slide, [class*='swiper-slide']"))
          .filter(visible)
          .map((slide, domIndex) => {
            const rect = slide.getBoundingClientRect();
            const area = Math.max(1, rect.width * rect.height);
            const visibleArea = intersects(rect, viewportRect);
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
            item.rect.right > viewportRect.left + 4 &&
            item.rect.left < viewportRect.right - 4 &&
            item.centerY >= viewportRect.top - 20 &&
            item.centerY <= viewportRect.bottom + 20
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
      const genericCarouselPanelForRoot = (targetRoot) =>
        [targetRoot, ...targetRoot.querySelectorAll(".swiper, [class*='swiper'], .slick-slider, [class*='slider'], [class*='carousel']")]
          .filter((element) => visible(element) && element.querySelector(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const area = rect.width * rect.height;
            const activeCount = element.querySelectorAll(".swiper-slide-active, .slick-active, [class*='active']").length;
            const visibleSlides = Array.from(element.querySelectorAll(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"))
              .filter((slide) => visible(slide))
              .length;
            const score = activeCount * 200 + visibleSlides * 40 + Math.min(area / 1000, 600);
            return { element, rect, score };
          })
          .sort((a, b) => b.score - a.score || b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0]?.element || null;
      const genericCarouselSignatureForRoot = (targetRoot) => {
        const panel = genericCarouselPanelForRoot(targetRoot);
        if (!panel) return "";
        const rootRect = targetRoot.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const viewportRect = panelRect.width >= 24 && panelRect.height >= 18 ? panelRect : rootRect;
        const centerX = viewportRect.left + viewportRect.width / 2;
        const slides = Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"))
          .filter((slide) => visible(slide))
          .map((slide, index) => {
            const rect = slide.getBoundingClientRect();
            const visibleArea = intersects(rect, viewportRect);
            const area = Math.max(1, rect.width * rect.height);
            const image = imageSources(slide)[0] || "";
            const imageFamily = mediaImageFamily(image);
            const text = dedupeRepeatedText(textOf(slide, 260), 220);
            const title = dedupeRepeatedText(
              slide.querySelector("h1, h2, h3, h4, [class*='title'], [class*='name'], p")?.innerText || text,
              120
            );
            const slideClass = classText(slide);
            const activeScore = Number(/active|current|selected/i.test(slideClass)) * 10000 +
              visibleArea -
              Math.abs((rect.left + rect.width / 2) - centerX) * 2;
            return {
              key: [
                title || "",
                imageFamily ? "img:" + imageFamily : "",
                slide.getAttribute("aria-label") || "",
                !title && !imageFamily ? "dom:" + index : ""
              ].filter(Boolean).join("|"),
              visibleArea,
              visibleRatio: visibleArea / area,
              activeScore
            };
          })
          .filter((slide) => slide.key && slide.visibleArea > 200 && slide.visibleRatio >= 0.08)
          .sort((a, b) => b.activeScore - a.activeScore || b.visibleArea - a.visibleArea);
        return slides[0]?.key || "";
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
        let slides = Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"));
        for (const slide of slides) {
          if (slide.dataset.pageShotSceneForced === "true") {
            slide.style.removeProperty("display");
            slide.style.removeProperty("visibility");
            slide.style.removeProperty("opacity");
            slide.style.removeProperty("position");
            slide.style.removeProperty("left");
            slide.style.removeProperty("top");
            slide.style.removeProperty("transform");
            slide.style.removeProperty("transition");
            delete slide.dataset.pageShotSceneForced;
          }
        }
        slides = Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"))
          .filter((slide) => textOf(slide, 700));
        const targetText = cleanText(item?.expectedAnchor || item?.title || item?.label || "", 180).toLowerCase();
        const target = (targetText
          ? slides.find((slide) => textOf(slide, 700).toLowerCase().includes(targetText))
          : null) ||
          slides[Math.max(0, Math.min(slides.length - 1, Number(index || 0)))];
        if (!target) return false;
        const wrapper = target.parentElement;
        const panelRect = panel.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
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
          wrapper.style.transform = "none";
        }
        for (const slide of slides) {
          const isTarget = slide === target;
          slide.dataset.pageShotSceneForced = "true";
          slide.style.setProperty("transition", "none", "important");
          slide.style.setProperty("transform", "none", "important");
          slide.classList.toggle("swiper-slide-active", isTarget);
          slide.classList.toggle("slick-active", isTarget);
          if (isTarget) {
            slide.style.setProperty("display", "block", "important");
            slide.style.setProperty("visibility", "visible", "important");
            slide.style.setProperty("opacity", "1", "important");
            slide.style.setProperty("position", "relative", "important");
            slide.style.setProperty("left", "0", "important");
            slide.style.setProperty("top", "0", "important");
          } else {
            slide.style.setProperty("display", "none", "important");
            slide.style.setProperty("visibility", "hidden", "important");
            slide.style.setProperty("opacity", "0", "important");
          }
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
            return forceSceneSlideToIndex(fallbackIndex, item);
          }
          return forceSceneSlideToIndex(fallbackIndex, item);
        }
        if (swiper.autoplay?.stop) swiper.autoplay.stop();
        if (typeof swiper.slideToLoop === "function") {
          swiper.slideToLoop(targetIndex, 0, false);
        } else if (typeof swiper.slideTo === "function") {
          swiper.slideTo(targetIndex, 0, false);
        } else {
          return forceSceneSlideToIndex(fallbackIndex, item);
        }
        if (typeof swiper.update === "function") swiper.update();
        await sleep(420);
        return forceSceneSlideToIndex(fallbackIndex, item);
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
            const currentSignature = mediaWindowSignature(track) ||
              genericCarouselSignatureForRoot(trackRoot);
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
            const after = mediaWindowSignature(track) ||
              genericCarouselSignatureForRoot(trackRoot);
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
            const activated = await activateSceneItem(targetItem, Number(state.forceIndex ?? Math.max(0, Number(state.pageIndex || 1) - 1)));
            if (activated) {
              root.scrollIntoView({ block: "center", inline: "nearest" });
              await sleep(260);
              return { ok: true };
            }
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
        if (Number(state.pageIndex || 1) > 1 && clickPageBullet(Number(state.pageIndex || 1))) {
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
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      `Could not activate ${definition.sectionLabel} ${state.stateLabel}.`
    );
  }
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
          .flatMap((node) => imageSourcesForNode(node))
          .filter(Boolean)
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
      const mediaTrackDefinitions = ${JSON.stringify(shokzMediaTrackDefinitions)};
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
      const mediaTrackSlideContainer = (track) => {
        const panel = mediaTrackPanel(track);
        const trackRoot = mediaTrackRoot(track);
        if (!panel) return trackRoot;
        return panel.querySelector(".swiper-slide, [class*='swiper-slide']") ? panel : trackRoot;
      };
      const mediaTrackViewportRect = (track) => {
        const panel = mediaTrackPanel(track);
        const trackRoot = mediaTrackRoot(track);
        const panelRect = panel?.getBoundingClientRect?.() || null;
        if (panelRect && panelRect.width >= 24 && panelRect.height >= 18) {
          return panelRect;
        }
        return trackRoot?.getBoundingClientRect?.() || panelRect || null;
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
        const slideContainer = mediaTrackSlideContainer(track);
        const viewportRect = mediaTrackViewportRect(track);
        if (!panel || !trackRoot || !slideContainer || !viewportRect) return [];
        const rootRect = trackRoot.getBoundingClientRect();
        const slides = Array.from(slideContainer.querySelectorAll(".swiper-slide, [class*='swiper-slide']"))
          .filter(visible)
          .map((slide, domIndex) => {
            const rect = slide.getBoundingClientRect();
            const area = Math.max(1, rect.width * rect.height);
            const visibleArea = intersects(rect, viewportRect);
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
            item.rect.right > viewportRect.left + 4 &&
            item.rect.left < viewportRect.right - 4 &&
            item.centerY >= viewportRect.top - 20 &&
            item.centerY <= viewportRect.bottom + 20
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
      const genericCarouselPanelForRoot = (targetRoot) =>
        [targetRoot, ...targetRoot.querySelectorAll(".swiper, [class*='swiper'], .slick-slider, [class*='slider'], [class*='carousel']")]
          .filter((element) => visible(element) && element.querySelector(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const area = rect.width * rect.height;
            const activeCount = element.querySelectorAll(".swiper-slide-active, .slick-active, [class*='active']").length;
            const visibleSlides = Array.from(element.querySelectorAll(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"))
              .filter((slide) => visible(slide))
              .length;
            const score = activeCount * 200 + visibleSlides * 40 + Math.min(area / 1000, 600);
            return { element, rect, score };
          })
          .sort((a, b) => b.score - a.score || b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0]?.element || null;
      const genericCarouselSignatureForRoot = (targetRoot) => {
        const panel = genericCarouselPanelForRoot(targetRoot);
        if (!panel) return "";
        const rootRect = targetRoot.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const viewportRect = panelRect.width >= 24 && panelRect.height >= 18 ? panelRect : rootRect;
        const centerX = viewportRect.left + viewportRect.width / 2;
        const slides = Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"))
          .filter((slide) => visible(slide))
          .map((slide, index) => {
            const rect = slide.getBoundingClientRect();
            const visibleArea = intersects(rect, viewportRect);
            const area = Math.max(1, rect.width * rect.height);
            const image = imageSources(slide)[0] || "";
            const imageFamily = mediaImageFamily(image);
            const text = dedupeRepeatedText(textOf(slide, 260), 220);
            const title = dedupeRepeatedText(
              slide.querySelector("h1, h2, h3, h4, [class*='title'], [class*='name'], p")?.innerText || text,
              120
            );
            const slideClass = classText(slide);
            const activeScore = Number(/active|current|selected/i.test(slideClass)) * 10000 +
              visibleArea -
              Math.abs((rect.left + rect.width / 2) - centerX) * 2;
            return {
              key: [
                title || "",
                imageFamily ? "img:" + imageFamily : "",
                slide.getAttribute("aria-label") || "",
                !title && !imageFamily ? "dom:" + index : ""
              ].filter(Boolean).join("|"),
              visibleArea,
              visibleRatio: visibleArea / area,
              activeScore
            };
          })
          .filter((slide) => slide.key && slide.visibleArea > 200 && slide.visibleRatio >= 0.08)
          .sort((a, b) => b.activeScore - a.activeScore || b.visibleArea - a.visibleArea);
        return slides[0]?.key || "";
      };
      const genericCarouselPanel = (targetRoot = root) =>
        [targetRoot, ...targetRoot.querySelectorAll(".swiper, [class*='swiper'], .slick-slider, [class*='slider'], [class*='carousel']")]
          .filter((element) => visible(element) && element.querySelector(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const area = rect.width * rect.height;
            const activeCount = element.querySelectorAll(".swiper-slide-active, .slick-active, [class*='active']").length;
            const visibleSlides = Array.from(element.querySelectorAll(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"))
              .filter((slide) => visible(slide))
              .length;
            const score = activeCount * 200 + visibleSlides * 40 + Math.min(area / 1000, 600);
            return { element, rect, score };
          })
          .sort((a, b) => b.score - a.score || b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0]?.element || null;
      const genericCarouselSignature = (targetRoot = root) => {
        const panel = genericCarouselPanel(targetRoot);
        if (!panel) return "";
        const rootRect = targetRoot.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const viewportRect = panelRect.width >= 24 && panelRect.height >= 18 ? panelRect : rootRect;
        const centerX = viewportRect.left + viewportRect.width / 2;
        const slides = Array.from(panel.querySelectorAll(".swiper-slide, [class*='swiper-slide'], .slick-slide, [class*='slide']"))
          .filter((slide) => visible(slide))
          .map((slide, index) => {
            const rect = slide.getBoundingClientRect();
            const visibleArea = intersects(rect, viewportRect);
            const area = Math.max(1, rect.width * rect.height);
            const image = imageSourcesForElement(slide)[0] || "";
            const imageFamily = mediaImageFamily(image);
            const text = dedupeRepeatedText(textOf(slide, 260), 220);
            const title = dedupeRepeatedText(
              slide.querySelector("h1, h2, h3, h4, [class*='title'], [class*='name'], p")?.innerText || text,
              120
            );
            const slideClass = classText(slide);
            const activeScore = Number(/active|current|selected/i.test(slideClass)) * 10000 +
              visibleArea -
              Math.abs((rect.left + rect.width / 2) - centerX) * 2;
            return {
              key: [
                title || "",
                imageFamily ? "img:" + imageFamily : "",
                slide.getAttribute("aria-label") || "",
                !title && !imageFamily ? "dom:" + index : ""
              ].filter(Boolean).join("|"),
              visibleArea,
              visibleRatio: visibleArea / area,
              activeScore
            };
          })
          .filter((slide) => slide.key && slide.visibleArea > 200 && slide.visibleRatio >= 0.08)
          .sort((a, b) => b.activeScore - a.activeScore || b.visibleArea - a.visibleArea);
        return slides[0]?.key || "";
      };
      if (definition.key === "media") {
        const track = mediaTrackForState();
        const trackRoot = mediaTrackRoot(track);
        if (!track || !trackRoot) {
          return { ok: false, reason: "Could not find media track " + (state.tabLabel || state.trackLabel || state.stateLabel) + "." };
        }
        const trackRect = trackRoot.getBoundingClientRect();
        const visibleItems = mediaItems(track);
        const mediaSignature = mediaWindowSignature(track) ||
          genericCarouselSignature(trackRoot) ||
          visibleSignature(trackRoot);
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
      if (definition.key === "scene-explore" && state.windowSignature && sceneSignature !== state.windowSignature && !state.activeItemKey && !state.expectedAnchor) {
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
      const genericSignature = genericCarouselSignature() || visibleSignature(root);
      if (!["product-showcase", "scene-explore", "athletes"].includes(definition.key) &&
        state.windowSignature &&
        genericSignature &&
        genericSignature !== state.windowSignature) {
        return {
          ok: false,
          reason: "Visible items did not match planned " + definition.sectionLabel + " window " + state.stateLabel + "."
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
            : (definition.key === "athletes"
              ? athleteSignature || state.logicalSignature
              : (genericSignature || state.logicalSignature))),
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

function safeFilePart(value) {
  return String(value || "state")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "state";
}

function compareRelatedCaptures(a, b) {
  const sectionA = shokzRelatedSectionOrder.indexOf(a.sectionKey);
  const sectionB = shokzRelatedSectionOrder.indexOf(b.sectionKey);
  const orderA = sectionA === -1 ? 1000 : sectionA;
  const orderB = sectionB === -1 ? 1000 : sectionB;
  return orderA - orderB ||
    Number(a.tabIndex || 0) - Number(b.tabIndex || 0) ||
    Number(a.productIndex || 0) - Number(b.productIndex || 0) ||
    Number(a.hoverIndex || 0) - Number(b.hoverIndex || 0) ||
    Number(a.pageIndex || 0) - Number(b.pageIndex || 0) ||
    Number(a.stateIndex || a.bannerIndex || 0) - Number(b.stateIndex || b.bannerIndex || 0) ||
    String(a.label || "").localeCompare(String(b.label || ""), "zh-CN");
}

function compareRelatedSectionEntries(a, b) {
  const sectionA = shokzRelatedSectionOrder.indexOf(a.sectionKey);
  const sectionB = shokzRelatedSectionOrder.indexOf(b.sectionKey);
  const orderA = sectionA === -1 ? 1000 : sectionA;
  const orderB = sectionB === -1 ? 1000 : sectionB;
  return orderA - orderB || String(a.sectionLabel || "").localeCompare(String(b.sectionLabel || ""), "zh-CN");
}

async function openShokzProductsNavigation(client, captureContext) {
  const viewport = viewportForCaptureContext(captureContext);
  const mobile = isMobileCaptureContext(captureContext);
  await scrollTo(client, 0);
  if (!mobile) {
    await closeShokzSearchOverlay(client);
  }
  await sleep(700);

  let state = null;
  let mobileClick = null;
  if (mobile) {
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
    if (!mobile) {
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

          const email = /(don.?t miss out|dont miss out|subscribe now|enter your email|email address|newsletter|sign up|primary use case|get\\s*\\d+%\\s*off|\\b\\d+%\\s*off\\b)/i.test(value) &&
            /(email|subscribe|newsletter|great deals|primary use case|get\\s*\\d+%\\s*off|\\b\\d+%\\s*off\\b)/i.test(value);
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
            ariaModal,
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
        const forceRemovePopupElement = (element, reason) => {
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
          element.remove();
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
            if (kind === "email" || kind === "region") {
              forceRemovePopupElement(layer, kind + " popup");
            } else {
              hideElement(layer, kind + " popup");
            }
          }
        }

        for (const element of Array.from(document.querySelectorAll("body *"))) {
          if (!visible(element) || element.dataset.pageShotHidden === "true" || isNavigationElement(element)) continue;
          const kind = classifyKnownPopup(textOf(element));
          if (!kind || kind === "cookie") continue;
          const layer = layerRootFor(element);
          if (!visible(layer) || isNavigationElement(layer) || containsNavigation(layer)) continue;
          const state = layerState(layer, kind);
          if (!state.popupLike && !state.roleDialog && !state.ariaModal) continue;
          hideRelatedBackdrop(layer, kind);
          forceRemovePopupElement(layer, kind + " forced popup");
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
        const syntheticOverlay = document.querySelector("[data-page-shot-nav-secondary='true']");
        if (syntheticOverlay) {
          const drawer = document.querySelector("#menu-drawer, .menu-drawer");
          syntheticOverlay.remove();
          [
            "display",
            "visibility",
            "opacity",
            "pointer-events"
          ].forEach((property) => drawer?.style?.removeProperty(property));
          Array.from(document.querySelectorAll(".menu_drawer_content")).forEach((element) => {
            [
              "display",
              "visibility",
              "opacity",
              "pointer-events"
            ].forEach((property) => element.style.removeProperty(property));
          });
          document.documentElement.style.removeProperty("overflow");
          document.body.classList.remove("unscroll");
          const menuIcon = document.querySelector("header-drawer .header__icon--menu .icon");
          menuIcon?.style?.removeProperty("z-index");
          return { ok: true, moved: true, text: "synthetic-secondary-close" };
        }
        const drawerBox = Array.from(document.querySelectorAll(".menu_drawer_content"))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              element,
              rect,
              active: element.classList.contains("active"),
              visible: visible(element)
            };
          })
          .sort((a, b) =>
            Number(b.active) - Number(a.active) ||
            Number(b.visible) - Number(a.visible) ||
            (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height) ||
            a.rect.top - b.rect.top ||
            a.rect.left - b.rect.left
          )[0]?.element || null;
        const closeBtn = drawerBox?.querySelector(".close_btn");
        if (visible(drawerBox) && drawerBox.classList.contains("active") && visible(closeBtn)) {
          const drawer = document.querySelector("#menu-drawer, .menu-drawer");
          drawerBox.scrollTop = 0;
          if (typeof closeBtn.click === "function") {
            closeBtn.click();
          } else {
            closeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          }
          drawerBox.classList.remove("active");
          Array.from(drawerBox.children || [])
            .filter((element) => element.classList?.contains("submenu_content"))
            .forEach((element) => element.remove());
          [
            "display",
            "position",
            "left",
            "right",
            "top",
            "bottom",
            "width",
            "height",
            "overflow-y",
            "overflow-x",
            "background",
            "transform",
            "z-index",
            "visibility",
            "opacity",
            "pointer-events"
          ].forEach((property) => drawerBox.style.removeProperty(property));
          [
            "display",
            "visibility",
            "opacity",
            "pointer-events"
          ].forEach((property) => drawer?.style?.removeProperty(property));
          document.documentElement.style.removeProperty("overflow");
          document.body.classList.remove("unscroll");
          const menuIcon = document.querySelector("header-drawer .header__icon--menu .icon");
          menuIcon?.style?.removeProperty("z-index");
          return { ok: true, moved: true, text: "drawer-clone-close" };
        }
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

async function renderShokzMobileTextNavigationOverlay(client, label) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const targetLabel = ${JSON.stringify(label)};
      const panelId = ({
        "Support": "link-support",
        "Technology": "link-technology",
        "About Us": "link-about-us"
      })[targetLabel] || "";
      const panel = panelId ? document.getElementById(panelId) : null;
      const drawerCloneSource = panel?.querySelector(".submenu_content");
      if (!drawerCloneSource) {
        return { ok: false, reason: "Hidden mobile submenu content was not found." };
      }
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
      document.querySelectorAll("[data-page-shot-nav-secondary='true']").forEach((element) => element.remove());
      const drawer = document.querySelector("#menu-drawer, .menu-drawer");
      const drawerRect = drawer?.getBoundingClientRect?.();
      const promoBar = Array.from(document.querySelectorAll("body *"))
        .find((element) => {
          if (!visible(element)) return false;
          const rect = element.getBoundingClientRect();
          const text = textOf(element);
          return rect.top >= -4 &&
            rect.top < 18 &&
            rect.height >= 20 &&
            rect.height <= 64 &&
            rect.width >= window.innerWidth * 0.55 &&
            /warranty|shipping|returns|price match/i.test(text);
        }) || null;
      const drawerTop = Math.max(0, Math.round(promoBar?.getBoundingClientRect?.().bottom || drawerRect?.top || 0));
      const overlay = document.createElement("div");
      overlay.className = "menu-drawer__submenu has-submenu gradient motion-reduce";
      overlay.dataset.pageShotNavSecondary = "true";
      overlay.dataset.pageShotNavClone = "true";
      overlay.setAttribute("aria-label", targetLabel);
      overlay.style.setProperty("display", "flex", "important");
      overlay.style.setProperty("flex-direction", "column", "important");
      overlay.style.setProperty("position", "fixed", "important");
      overlay.style.setProperty("left", "0", "important");
      overlay.style.setProperty("right", "0", "important");
      overlay.style.setProperty("top", drawerTop + "px", "important");
      overlay.style.setProperty("bottom", "0", "important");
      overlay.style.setProperty("width", window.innerWidth + "px", "important");
      overlay.style.setProperty("height", Math.max(0, window.innerHeight - drawerTop) + "px", "important");
      overlay.style.setProperty("background", "#fff", "important");
      overlay.style.setProperty("z-index", "2147483646", "important");
      overlay.style.setProperty("visibility", "visible", "important");
      overlay.style.setProperty("opacity", "1", "important");
      overlay.style.setProperty("pointer-events", "auto", "important");
      overlay.style.setProperty("overflow", "hidden", "important");
      overlay.style.setProperty("transform", "none", "important");
      overlay.style.setProperty("transition", "none", "important");

      const backButton = document.createElement("button");
      backButton.type = "button";
      backButton.dataset.pageShotNavBack = "true";
      backButton.className = "menu-drawer__close-button link link--text focus-inset";
      backButton.innerHTML = '<span style="display:block;font-size:22px;line-height:1;color:currentColor">&#8592;</span>';
      backButton.style.setProperty("display", "inline-flex", "important");
      backButton.style.setProperty("align-items", "center", "important");
      backButton.style.setProperty("justify-content", "center", "important");
      backButton.style.setProperty("padding", "0", "important");
      backButton.style.setProperty("width", "24px", "important");
      backButton.style.setProperty("height", "24px", "important");
      backButton.style.setProperty("border", "0", "important");
      backButton.style.setProperty("background", "transparent", "important");
      backButton.style.setProperty("color", "#1a1a1a", "important");
      backButton.style.setProperty("pointer-events", "none", "important");
      backButton.style.setProperty("position", "absolute", "important");
      backButton.style.setProperty("top", "16px", "important");
      backButton.style.setProperty("left", "14px", "important");
      backButton.style.setProperty("z-index", "2", "important");
      overlay.append(backButton);

      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.dataset.pageShotNavClose = "true";
      closeButton.setAttribute("aria-label", "Close");
      closeButton.innerHTML = '<span style="display:block;font-size:26px;line-height:1;color:#8d8d8d">&times;</span>';
      closeButton.style.setProperty("display", "inline-flex", "important");
      closeButton.style.setProperty("align-items", "center", "important");
      closeButton.style.setProperty("justify-content", "center", "important");
      closeButton.style.setProperty("padding", "0", "important");
      closeButton.style.setProperty("width", "24px", "important");
      closeButton.style.setProperty("height", "24px", "important");
      closeButton.style.setProperty("border", "0", "important");
      closeButton.style.setProperty("background", "transparent", "important");
      closeButton.style.setProperty("pointer-events", "none", "important");
      closeButton.style.setProperty("position", "absolute", "important");
      closeButton.style.setProperty("top", "12px", "important");
      closeButton.style.setProperty("right", "14px", "important");
      closeButton.style.setProperty("z-index", "2", "important");
      overlay.append(closeButton);

      const scrollRegion = document.createElement("div");
      scrollRegion.dataset.pageShotNavScroll = "true";
      scrollRegion.style.setProperty("flex", "1 1 auto", "important");
      scrollRegion.style.setProperty("overflow", "hidden", "important");
      scrollRegion.style.setProperty("padding", "46px 0 14px", "important");
      scrollRegion.style.setProperty("background", "#fff", "important");

      const content = document.createElement("div");
      content.dataset.pageShotNavSecondaryContent = "true";
      content.dataset.pageShotNavClone = "true";
      content.setAttribute("aria-label", targetLabel);
      content.style.setProperty("display", "block", "important");
      content.style.setProperty("width", "100%", "important");
      content.style.setProperty("background", "#fff", "important");
      content.style.setProperty("visibility", "visible", "important");
      content.style.setProperty("opacity", "1", "important");
      content.style.setProperty("pointer-events", "auto", "important");
      content.style.setProperty("padding", "0 10px", "important");

      const breadcrumb = document.createElement("div");
      breadcrumb.textContent = targetLabel;
      breadcrumb.style.setProperty("margin", "0 0 12px", "important");
      breadcrumb.style.setProperty("padding", "0", "important");
      breadcrumb.style.setProperty("font-size", "15px", "important");
      breadcrumb.style.setProperty("font-weight", "400", "important");
      breadcrumb.style.setProperty("line-height", "1.2", "important");
      breadcrumb.style.setProperty("color", "#5f6874", "important");
      content.append(breadcrumb);

      const itemLabels = [];
      const seenLabels = new Set();
      const labelOf = (element) => String(element?.innerText || element?.textContent || "")
        .replace(/\\s+/g, " ")
        .trim();
      for (const item of Array.from(drawerCloneSource.querySelectorAll("a, button, summary, .menu-drawer__menu-item, li"))) {
        const label = labelOf(item);
        const key = label.toLowerCase();
        if (
          !label ||
          label.length > 48 ||
          seenLabels.has(key) ||
          key === targetLabel.toLowerCase() ||
          itemLabels.some((existing) => key.startsWith(existing.toLowerCase() + " "))
        ) continue;
        seenLabels.add(key);
        itemLabels.push(label);
      }
      const finalItemLabels = targetLabel === "Technology"
        ? itemLabels.filter((label) => /technology$/i.test(label)).slice(0, 4)
        : itemLabels;

      for (const label of finalItemLabels.slice(0, 8)) {
        const row = document.createElement("button");
        row.type = "button";
        row.style.setProperty("display", "flex", "important");
        row.style.setProperty("align-items", "center", "important");
        row.style.setProperty("justify-content", "space-between", "important");
        row.style.setProperty("gap", "10px", "important");
        row.style.setProperty("width", "100%", "important");
        row.style.setProperty("padding", "10px 0", "important");
        row.style.setProperty("margin", "0", "important");
        row.style.setProperty("border", "0", "important");
        row.style.setProperty("background", "transparent", "important");
        row.style.setProperty("text-align", "left", "important");
        row.style.setProperty("font-size", "15px", "important");
        row.style.setProperty("font-weight", "600", "important");
        row.style.setProperty("line-height", "1.2", "important");
        row.style.setProperty("color", "#1a1a1a", "important");

        const labelNode = document.createElement("span");
        labelNode.textContent = label;
        row.append(labelNode);

        const arrow = document.createElement("span");
        arrow.textContent = "›";
        arrow.style.setProperty("font-size", "24px", "important");
        arrow.style.setProperty("line-height", "1", "important");
        arrow.style.setProperty("color", "#888", "important");
        row.append(arrow);

        content.append(row);
      }

      scrollRegion.append(content);
      overlay.append(scrollRegion);
      document.body.append(overlay);
      drawer?.style?.setProperty("display", "none", "important");
      drawer?.style?.setProperty("visibility", "hidden", "important");
      drawer?.style?.setProperty("opacity", "0", "important");
      drawer?.style?.setProperty("pointer-events", "none", "important");
      Array.from(document.querySelectorAll(".menu_drawer_content")).forEach((element) => {
        element.style.setProperty("display", "none", "important");
        element.style.setProperty("visibility", "hidden", "important");
        element.style.setProperty("opacity", "0", "important");
        element.style.setProperty("pointer-events", "none", "important");
      });
      document.body.classList.add("unscroll");
      document.documentElement.style.setProperty("overflow", "hidden", "important");
      return { ok: finalItemLabels.length > 0 };
    })()`,
    returnByValue: true
  }).catch(() => ({ result: { value: { ok: false, reason: `Could not render ${label} mobile text overlay.` } } }));
  return result.result?.value || { ok: false, reason: `Could not render ${label} mobile text overlay.` };
}

async function clickShokzMobileNavigationLabel(client, label) {
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
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const directText = (element) => Array.from(element?.childNodes || [])
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
      const drawer = document.querySelector("#menu-drawer, .menu-drawer");
      if (!visible(drawer)) {
        return { ok: false, reason: "Shokz mobile navigation drawer is not visible." };
      }
      const current = new URL(window.location.href);
      const navigatesAway = (target) => {
        const link = target?.closest?.("a[href]");
        if (!link) return false;
        const rawHref = String(link.getAttribute("href") || "").trim();
        if (!rawHref || rawHref === "#" || rawHref.startsWith("#") || /^javascript:/i.test(rawHref)) {
          return false;
        }
        try {
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
      const interactiveTargetOf = (element) =>
        element?.closest?.("summary") ||
        element?.closest?.("button, [role='button'], a, label, [tabindex]") ||
        element?.closest?.("details") ||
        element?.closest?.("li") ||
        element?.parentElement ||
        element;
      const drawerRect = rectOf(drawer);
      const raw = Array.from(drawer.querySelectorAll("a, button, [role='button'], summary, li, div, span, p"))
        .filter(visible)
        .map((element) => {
          const target = interactiveTargetOf(element);
          const rect = rectOf(target);
          const targetText = textOf(target);
          const elementLabel = compactRepeatedLabel(directText(element) || directText(target) || (target.children.length <= 2 ? targetText : ""));
          const normalizedLabel = comparable(elementLabel);
          const exactLabel = normalizedLabel === targetKey;
          const interactive = target.matches?.("summary") ? 3 :
            target.matches?.("details") ? 2 :
              target.matches?.("button, [role='button'], a, label, [tabindex]") ? 1 : 0;
          const controlHint = target.matches?.("[aria-controls]") ? 2 : 0;
          const structureHint = /summary|details/i.test(elementLabel + " " + targetText) ? 1 : 0;
          return { target, rect, label: elementLabel, normalizedLabel, exactLabel, text: targetText, interactive, controlHint, structureHint };
        })
        .filter((item) =>
          (item.normalizedLabel === targetKey || item.normalizedLabel.startsWith(targetKey)) &&
          item.rect.top >= Math.max(80, drawerRect.top - 4) &&
          item.rect.bottom <= Math.min(window.innerHeight + 24, drawerRect.bottom + 24) &&
          item.rect.left >= Math.max(0, drawerRect.left - 12) &&
          item.rect.right <= Math.min(window.innerWidth + 12, drawerRect.right + 12) &&
          item.rect.width >= 36 &&
          item.rect.height >= 14 &&
          item.rect.height <= 120
        )
        .sort((a, b) =>
          Number(b.exactLabel) - Number(a.exactLabel) ||
          b.controlHint - a.controlHint ||
          b.structureHint - a.structureHint ||
          b.interactive - a.interactive ||
          Math.abs(a.normalizedLabel.length - targetKey.length) - Math.abs(b.normalizedLabel.length - targetKey.length) ||
          a.rect.height - b.rect.height ||
          a.rect.top - b.rect.top ||
          a.rect.left - b.rect.left
        );
      const choice = raw[0];
      if (!choice) {
        return { ok: false, reason: "Target label not found in the Shokz mobile menu." };
      }
      const href = choice.target.closest?.("a[href]")?.href || "";
      const wouldNavigate = navigatesAway(choice.target);
      const detailsRoot = choice.target.matches?.("details")
        ? choice.target
        : choice.target.closest?.("details");
      const ariaControlTargetOf = (element) => {
        let current = element;
        while (current && current instanceof Element) {
          if (String(current.getAttribute?.("aria-controls") || "").trim()) {
            return current;
          }
          current = current.parentElement;
        }
        return null;
      };
      const controlTarget = !detailsRoot
        ? ariaControlTargetOf(choice.target)
        : null;
      const productPanelHint = ({
        sportsheadphones: "submenu-1",
        workoutandlifestyleearbuds: "submenu-2",
        communicationheadsets: "submenu-3"
      })[targetKey] || "";
      const controlledPanelId = controlTarget
        ? String(controlTarget.getAttribute("aria-controls") || "").trim()
        : productPanelHint;
      const controlledPanel = controlledPanelId ? document.getElementById(controlledPanelId) : null;
      const materializeMobileDrawerClone = (summary, panel) => {
        const drawer = document.querySelector("#menu-drawer, .menu-drawer");
        const drawerRect = drawer?.getBoundingClientRect?.();
        const promoBar = Array.from(document.querySelectorAll("body *"))
          .find((element) => {
            if (!visible(element)) return false;
            const rect = element.getBoundingClientRect();
            const text = textOf(element);
            return rect.top >= -4 &&
              rect.top < 18 &&
              rect.height >= 20 &&
              rect.height <= 64 &&
              rect.width >= window.innerWidth * 0.55 &&
              /warranty|shipping|returns|price match/i.test(text);
          }) || null;
        const drawerTop = Math.max(0, Math.round(promoBar?.getBoundingClientRect?.().bottom || drawerRect?.top || 0));
        const drawerCloneSource = panel?.querySelector(".submenu_content");
        if (!drawerCloneSource) {
          return false;
        }
        const isProductPanel = /^submenu-/i.test(String(panel?.id || ""));
        document.querySelectorAll("[data-page-shot-nav-secondary='true']").forEach((element) => element.remove());
        if (isProductPanel) {
          const overlay = document.createElement("div");
          overlay.className = "menu_drawer_content product_mega_menu_mb active";
          overlay.dataset.pageShotNavSecondary = "true";
          overlay.dataset.pageShotNavClone = "true";
          overlay.setAttribute("aria-label", targetLabel);
          overlay.style.setProperty("display", "flex", "important");
          overlay.style.setProperty("flex-direction", "column", "important");
          overlay.style.setProperty("position", "fixed", "important");
          overlay.style.setProperty("left", "0", "important");
          overlay.style.setProperty("right", "0", "important");
          overlay.style.setProperty("top", drawerTop + "px", "important");
          overlay.style.setProperty("bottom", "0", "important");
          overlay.style.setProperty("width", window.innerWidth + "px", "important");
          overlay.style.setProperty("height", Math.max(0, window.innerHeight - drawerTop) + "px", "important");
          overlay.style.setProperty("background", "#fff", "important");
      overlay.style.setProperty("z-index", "2147483646", "important");
      overlay.style.setProperty("visibility", "visible", "important");
      overlay.style.setProperty("opacity", "1", "important");
      overlay.style.setProperty("pointer-events", "auto", "important");
      overlay.style.setProperty("overflow", "hidden", "important");
      overlay.style.setProperty("transform", "none", "important");
      overlay.style.setProperty("transition", "none", "important");

          const headerRow = document.createElement("div");
          headerRow.dataset.pageShotNavHeader = "true";
          headerRow.style.setProperty("display", "flex", "important");
          headerRow.style.setProperty("align-items", "center", "important");
          headerRow.style.setProperty("justify-content", "space-between", "important");
          headerRow.style.setProperty("padding", "10px 14px 4px", "important");
          headerRow.style.setProperty("min-height", "34px", "important");
          headerRow.style.setProperty("background", "#fff", "important");

          const backButton = document.createElement("button");
          backButton.type = "button";
          backButton.dataset.pageShotNavBack = "true";
          backButton.className = "menu-drawer__close-button link link--text focus-inset";
          backButton.innerHTML = '<span class="svg-wrapper"><svg xmlns="http://www.w3.org/2000/svg" fill="none" class="icon icon-arrow" viewBox="0 0 14 10" width="14" height="10"><path fill="currentColor" fill-rule="evenodd" d="M8.537.808a.5.5 0 0 1 .817-.162l4 4a.5.5 0 0 1 0 .708l-4 4a.5.5 0 1 1-.708-.708L11.793 5.5H1a.5.5 0 0 1 0-1h10.793L8.646 1.354a.5.5 0 0 1-.109-.546" clip-rule="evenodd"></path></svg></span>';
          backButton.style.setProperty("display", "inline-flex", "important");
          backButton.style.setProperty("align-items", "center", "important");
          backButton.style.setProperty("justify-content", "center", "important");
          backButton.style.setProperty("padding", "0", "important");
          backButton.style.setProperty("width", "24px", "important");
          backButton.style.setProperty("height", "24px", "important");
          backButton.style.setProperty("border", "0", "important");
          backButton.style.setProperty("background", "transparent", "important");
          backButton.style.setProperty("color", "#1a1a1a", "important");
          backButton.style.setProperty("pointer-events", "none", "important");
          backButton.style.setProperty("z-index", "2", "important");
          headerRow.append(backButton);

          const closeButton = document.createElement("button");
          closeButton.type = "button";
          closeButton.dataset.pageShotNavClose = "true";
          closeButton.setAttribute("aria-label", "Close");
          closeButton.innerHTML = '<span style="display:block;font-size:26px;line-height:1;color:#8d8d8d">&times;</span>';
          closeButton.style.setProperty("display", "inline-flex", "important");
          closeButton.style.setProperty("align-items", "center", "important");
          closeButton.style.setProperty("justify-content", "center", "important");
          closeButton.style.setProperty("padding", "0", "important");
          closeButton.style.setProperty("width", "24px", "important");
          closeButton.style.setProperty("height", "24px", "important");
          closeButton.style.setProperty("border", "0", "important");
          closeButton.style.setProperty("background", "transparent", "important");
          closeButton.style.setProperty("pointer-events", "none", "important");
          closeButton.style.setProperty("z-index", "2", "important");
          headerRow.append(closeButton);
          overlay.append(headerRow);

          const scrollRegion = document.createElement("div");
          scrollRegion.dataset.pageShotNavScroll = "true";
          scrollRegion.style.setProperty("flex", "1 1 auto", "important");
          scrollRegion.style.setProperty("overflow-y", "auto", "important");
          scrollRegion.style.setProperty("overflow-x", "hidden", "important");
          scrollRegion.style.setProperty("padding", "0 6px 6px", "important");
          scrollRegion.style.setProperty("background", "#fff", "important");

          const clone = document.createElement("div");
          clone.className = String(drawerCloneSource.className || "submenu_content");
          clone.innerHTML = drawerCloneSource.innerHTML;
          clone.dataset.pageShotNavSecondaryContent = "true";
          clone.dataset.pageShotNavClone = "true";
          clone.setAttribute("aria-label", targetLabel);
          for (const image of clone.querySelectorAll("img")) {
            const dataSrc = String(image.getAttribute("data-src") || image.getAttribute("data-original") || "").trim();
            const currentSrc = String(image.getAttribute("src") || "").trim();
            if (dataSrc && (!currentSrc || /width=10\b/i.test(currentSrc))) {
              image.setAttribute("src", dataSrc);
            }
            image.removeAttribute("loading");
          }
          for (const card of clone.querySelectorAll(".p-item")) {
            card.style.setProperty("visibility", "visible", "important");
            card.style.setProperty("opacity", "1", "important");
          }
          clone.style.setProperty("display", "block", "important");
          clone.style.setProperty("width", "100%", "important");
          clone.style.setProperty("visibility", "visible", "important");
          clone.style.setProperty("opacity", "1", "important");
          clone.style.setProperty("pointer-events", "auto", "important");
          scrollRegion.append(clone);

          const footer = document.createElement("div");
          footer.dataset.pageShotNavProductFooter = "true";
          footer.style.setProperty("display", "block", "important");
          footer.style.setProperty("flex", "0 0 auto", "important");
          footer.style.setProperty("padding", "0 8px 8px", "important");
          footer.style.setProperty("background", "#fff", "important");
          footer.style.setProperty("box-shadow", "0 -6px 14px rgba(255,255,255,0.96)", "important");
          const appendFooterLink = (label, background, color, border) => {
            const source = Array.from(document.querySelectorAll("#menu-drawer a, #menu-drawer button, .menu-drawer a, .menu-drawer button, a, button"))
              .find((element) => comparable(textOf(element)) === comparable(label));
            const link = source ? source.cloneNode(true) : document.createElement("a");
            if (!source) {
              link.textContent = label;
            }
            link.style.setProperty("display", "block", "important");
            link.style.setProperty("width", "100%", "important");
            link.style.setProperty("box-sizing", "border-box", "important");
            link.style.setProperty("padding", "8px 14px", "important");
            link.style.setProperty("margin", "0 0 6px", "important");
            link.style.setProperty("border-radius", "3px", "important");
            link.style.setProperty("text-align", "center", "important");
            link.style.setProperty("text-decoration", "none", "important");
            link.style.setProperty("font-size", "14px", "important");
            link.style.setProperty("font-weight", "600", "important");
            link.style.setProperty("line-height", "1.2", "important");
            link.style.setProperty("background", background, "important");
            link.style.setProperty("color", color, "important");
            link.style.setProperty("border", border, "important");
            link.style.setProperty("visibility", "visible", "important");
            link.style.setProperty("opacity", "1", "important");
            footer.append(link);
          };
          appendFooterLink("Compare Products", "#fff", "#3f3f3f", "1px solid #d7d7d7");
          appendFooterLink("All Products", "#ff6f2c", "#fff", "1px solid #ff6f2c");
          overlay.append(scrollRegion);
          scrollRegion.append(footer);
          document.body.append(overlay);
          drawer?.style?.setProperty("display", "none", "important");
          drawer?.style?.setProperty("visibility", "hidden", "important");
          drawer?.style?.setProperty("opacity", "0", "important");
          drawer?.style?.setProperty("pointer-events", "none", "important");
          Array.from(document.querySelectorAll(".menu_drawer_content")).forEach((element) => {
            if (element === overlay) return;
            element.style.setProperty("display", "none", "important");
            element.style.setProperty("visibility", "hidden", "important");
            element.style.setProperty("opacity", "0", "important");
            element.style.setProperty("pointer-events", "none", "important");
          });
          document.body.classList.add("unscroll");
          document.documentElement.style.setProperty("overflow", "hidden", "important");
          return visible(overlay) && visible(clone);
        }
        const overlay = document.createElement("div");
        overlay.className = "menu-drawer__submenu has-submenu gradient motion-reduce";
        overlay.dataset.pageShotNavSecondary = "true";
        overlay.dataset.pageShotNavClone = "true";
        overlay.setAttribute("aria-label", targetLabel);
        overlay.style.setProperty("display", "flex", "important");
        overlay.style.setProperty("flex-direction", "column", "important");
        overlay.style.setProperty("position", "fixed", "important");
        overlay.style.setProperty("left", "0", "important");
        overlay.style.setProperty("right", "0", "important");
        overlay.style.setProperty("top", drawerTop + "px", "important");
        overlay.style.setProperty("bottom", "0", "important");
        overlay.style.setProperty("width", window.innerWidth + "px", "important");
        overlay.style.setProperty("height", Math.max(0, window.innerHeight - drawerTop) + "px", "important");
        overlay.style.setProperty("background", "#fff", "important");
        overlay.style.setProperty("z-index", "2147483646", "important");
        overlay.style.setProperty("visibility", "visible", "important");
        overlay.style.setProperty("opacity", "1", "important");
        overlay.style.setProperty("pointer-events", "auto", "important");
        overlay.style.setProperty("overflow", "hidden", "important");
        overlay.style.setProperty("transform", "none", "important");
        overlay.style.setProperty("transition", "none", "important");

        const backButton = document.createElement("button");
        backButton.type = "button";
        backButton.dataset.pageShotNavBack = "true";
        backButton.className = "menu-drawer__close-button link link--text focus-inset";
        backButton.innerHTML = '<span style="display:block;font-size:22px;line-height:1;color:currentColor">&#8592;</span>';
        backButton.style.setProperty("display", "inline-flex", "important");
        backButton.style.setProperty("align-items", "center", "important");
        backButton.style.setProperty("justify-content", "center", "important");
        backButton.style.setProperty("padding", "0", "important");
        backButton.style.setProperty("width", "24px", "important");
        backButton.style.setProperty("height", "24px", "important");
        backButton.style.setProperty("border", "0", "important");
        backButton.style.setProperty("background", "transparent", "important");
        backButton.style.setProperty("color", "#1a1a1a", "important");
        backButton.style.setProperty("pointer-events", "none", "important");
        backButton.style.setProperty("position", "absolute", "important");
        backButton.style.setProperty("top", "16px", "important");
        backButton.style.setProperty("left", "14px", "important");
        backButton.style.setProperty("z-index", "2", "important");
        overlay.append(backButton);

        const closeButton = document.createElement("button");
        closeButton.type = "button";
        closeButton.dataset.pageShotNavClose = "true";
        closeButton.setAttribute("aria-label", "Close");
        closeButton.innerHTML = '<span style="display:block;font-size:26px;line-height:1;color:#8d8d8d">&times;</span>';
        closeButton.style.setProperty("display", "inline-flex", "important");
        closeButton.style.setProperty("align-items", "center", "important");
        closeButton.style.setProperty("justify-content", "center", "important");
        closeButton.style.setProperty("padding", "0", "important");
        closeButton.style.setProperty("width", "24px", "important");
        closeButton.style.setProperty("height", "24px", "important");
        closeButton.style.setProperty("border", "0", "important");
        closeButton.style.setProperty("background", "transparent", "important");
        closeButton.style.setProperty("pointer-events", "none", "important");
        closeButton.style.setProperty("position", "absolute", "important");
        closeButton.style.setProperty("top", "12px", "important");
        closeButton.style.setProperty("right", "14px", "important");
        closeButton.style.setProperty("z-index", "2", "important");
        overlay.append(closeButton);

        const scrollRegion = document.createElement("div");
        scrollRegion.dataset.pageShotNavScroll = "true";
        scrollRegion.style.setProperty("flex", "1 1 auto", "important");
        scrollRegion.style.setProperty("overflow-y", "auto", "important");
        scrollRegion.style.setProperty("overflow-x", "hidden", "important");
        scrollRegion.style.setProperty("padding", "28px 10px 14px", "important");
        scrollRegion.style.setProperty("background", "#fff", "important");

        const clone = document.createElement("div");
        clone.className = String(drawerCloneSource.className || "submenu_content");
        clone.innerHTML = drawerCloneSource.innerHTML;
        clone.dataset.pageShotNavSecondaryContent = "true";
        clone.dataset.pageShotNavClone = "true";
        clone.setAttribute("aria-label", targetLabel);
        clone.style.setProperty("display", "block", "important");
        clone.style.setProperty("width", "100%", "important");
        clone.style.setProperty("background", "#fff", "important");
        clone.style.setProperty("visibility", "visible", "important");
        clone.style.setProperty("opacity", "1", "important");
        clone.style.setProperty("pointer-events", "auto", "important");
        for (const link of clone.querySelectorAll("a")) {
          link.style.setProperty("text-decoration", "none", "important");
        }
        const breadcrumb = clone.querySelector("a, .menu-drawer__menu-item");
        if (breadcrumb) {
          breadcrumb.style.setProperty("display", "inline-block", "important");
          breadcrumb.style.setProperty("margin", "0 0 12px", "important");
          breadcrumb.style.setProperty("font-size", "15px", "important");
          breadcrumb.style.setProperty("font-weight", "400", "important");
          breadcrumb.style.setProperty("line-height", "1.2", "important");
          breadcrumb.style.setProperty("color", "#5f6874", "important");
          breadcrumb.style.setProperty("border", "0", "important");
          breadcrumb.style.setProperty("border-bottom", "0", "important");
          breadcrumb.style.setProperty("box-shadow", "none", "important");
        }
        for (const listLink of clone.querySelectorAll(".menu-drawer__menu-item")) {
          listLink.style.setProperty("display", "flex", "important");
          listLink.style.setProperty("align-items", "center", "important");
          listLink.style.setProperty("justify-content", "space-between", "important");
        }
        scrollRegion.append(clone);
        overlay.append(scrollRegion);
        document.body.append(overlay);
        drawer?.style?.setProperty("display", "none", "important");
        drawer?.style?.setProperty("visibility", "hidden", "important");
        drawer?.style?.setProperty("opacity", "0", "important");
        drawer?.style?.setProperty("pointer-events", "none", "important");
        Array.from(document.querySelectorAll(".menu_drawer_content")).forEach((element) => {
          element.style.setProperty("display", "none", "important");
          element.style.setProperty("visibility", "hidden", "important");
          element.style.setProperty("opacity", "0", "important");
          element.style.setProperty("pointer-events", "none", "important");
        });
        document.body.classList.add("unscroll");
        document.documentElement.style.setProperty("overflow", "hidden", "important");
        return visible(overlay) && visible(clone);
      };
      const x = detailsRoot
        ? Math.round(choice.rect.left + choice.rect.width / 2)
        : Math.round(choice.rect.right - Math.min(24, Math.max(12, choice.rect.width * 0.18)));
      const y = Math.round(choice.rect.top + choice.rect.height / 2);
      let usedDrawerClone = false;
      if (!wouldNavigate) {
        const primaryTarget = controlTarget ||
          (choice.target.matches?.("summary")
            ? choice.target
            : detailsRoot?.querySelector?.(":scope > summary") || choice.target);
        const clickTargets = [
          primaryTarget,
          choice.target,
          choice.target.parentElement,
          choice.target.closest?.("li"),
          detailsRoot
        ].filter(Boolean);
        if (detailsRoot && "open" in detailsRoot) {
          detailsRoot.open = true;
          detailsRoot.setAttribute("open", "open");
        }
        if (controlledPanel) {
          usedDrawerClone = materializeMobileDrawerClone(primaryTarget, controlledPanel);
        }
        const activeTargets = usedDrawerClone
          ? []
          : detailsRoot
            ? [primaryTarget].filter(Boolean)
            : clickTargets;
        for (const element of activeTargets) {
          if (element === primaryTarget && element.matches?.("summary")) {
            element.focus?.();
            for (const key of ["Enter", " "]) {
              element.dispatchEvent(new KeyboardEvent("keydown", {
                key,
                code: key === "Enter" ? "Enter" : "Space",
                bubbles: true,
                cancelable: true
              }));
              element.dispatchEvent(new KeyboardEvent("keyup", {
                key,
                code: key === "Enter" ? "Enter" : "Space",
                bubbles: true,
                cancelable: true
              }));
            }
          }
          for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            element.dispatchEvent(new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              view: window
            }));
          }
          if (typeof element.click === "function") {
            element.click();
          }
        }
      }
      return {
        ok: true,
        label: choice.label,
        targetTag: choice.target.tagName,
        structureHint: choice.structureHint,
        interactive: choice.interactive,
        targetHtml: String(choice.target.outerHTML || "").replace(/\s+/g, " ").slice(0, 220),
        href,
        navigatesAway: wouldNavigate,
        usedDetailsToggle: Boolean(
          choice.target.matches?.("details") ||
          choice.target.matches?.("summary") ||
          choice.target.closest?.("details") ||
          usedDrawerClone
        ),
        usedControlledPanel: Boolean(controlledPanel),
        usedDrawerClone,
        x,
        y
      };
    })()`,
    returnByValue: true
  }).catch(() => ({ result: { value: { ok: false, reason: `Could not inspect mobile navigation label ${label}.` } } }));
  if (result?.exceptionDetails) {
    const details = result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      "unknown evaluation error";
    return { ok: false, reason: `Could not inspect mobile navigation label ${label}: ${details}` };
  }
  return result.result?.value || { ok: false, reason: `Could not inspect mobile navigation label ${label}.` };
}

async function waitForShokzMobileNavigationDrilldown(client, state, expectedUrl) {
  let lastState = { ok: false };
  for (let attempt = 0; attempt < 12; attempt += 1) {
    lastState = await readShokzMobileNavigationDrilldownState(client, state, expectedUrl);
    if (lastState.ok) {
      return lastState;
    }
    await sleep(350);
  }
  return lastState;
}

async function readShokzMobileNavigationDrilldownState(client, state, expectedUrl) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const targetLabel = ${JSON.stringify(state.activationLabel || state.hoverItemLabel || state.topLevelLabel || "")};
      const topLevelLabels = [
        "Sports Headphones",
        "Workout & Lifestyle Earbuds",
        "Communication Headsets",
        "Support",
        "Technology",
        "About Us"
      ];
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
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const directText = (element) => Array.from(element?.childNodes || [])
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join(" ")
        .replace(/\\s+/g, " ")
        .trim();
      const textOf = (element) => element ? [
        directText(element),
        element.innerText || element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title"),
        element.id,
        String(element.className || "")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim() : "";
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
      const syntheticOverlay = Array.from(document.querySelectorAll("[data-page-shot-nav-secondary='true']"))
        .find((element) => visible(element)) || null;
      const syntheticContent = syntheticOverlay?.querySelector?.("[data-page-shot-nav-secondary-content='true'], .submenu_content") || null;
      const drawer = document.querySelector("#menu-drawer, .menu-drawer");
      const drawerVisible = Boolean(drawer && visible(drawer));
      const clonedContent = syntheticContent ||
        Array.from(document.querySelectorAll(".menu_drawer_content > .submenu_content"))
          .find((element) => visible(element)) || null;
      const clonedDrawer = syntheticOverlay || clonedContent?.closest?.(".menu_drawer_content") || null;
      const hiddenCloneCandidate = !clonedContent
        ? Array.from(document.querySelectorAll(".menu_drawer_content > .submenu_content"))[0] || null
        : null;
      const currentUrl = window.location.href;
      const labels = drawerVisible
        ? Array.from(drawer.querySelectorAll("a, button, [role='button'], summary, li, h1, h2, h3, h4, p, span, div"))
          .filter(visible)
          .map((element) => compactRepeatedLabel(directText(element) || (element.children.length <= 2 ? textOf(element) : "")))
          .filter((text) => text && text.length <= 80)
        : [];
      const clonedText = clonedDrawer ? textOf(clonedDrawer).slice(0, 12000) : "";
      const clonedItemCount = clonedContent
        ? Array.from(clonedContent.querySelectorAll("a, button, [role='button'], li, p, span, div"))
          .filter((element) => visible(element))
          .map((element) => compactRepeatedLabel(directText(element) || (element.children.length <= 2 ? textOf(element) : "")))
          .filter((text) => text && text.length <= 120)
          .length
        : 0;
      const clonedBackVisible = Boolean(
        (syntheticOverlay?.querySelector("[data-page-shot-nav-back='true']") && visible(syntheticOverlay.querySelector("[data-page-shot-nav-back='true']"))) ||
        (clonedDrawer?.querySelector(".close_btn") && visible(clonedDrawer.querySelector(".close_btn"))) ||
        Array.from(clonedContent?.querySelectorAll?.("button, [role='button'], a, summary, svg, [class*='close-button'], [class*='arrow']") || [])
          .some((element) => {
            const target = element.closest?.("button, [role='button'], a, summary") || element;
            const text = textOf(target) + " " + String(target.outerHTML || "").slice(0, 300);
            return visible(target) &&
              /menu-drawer__close-button|back|arrow|icon-arrow|chevron/i.test(text) &&
              !/icon-close|modal__close|search/i.test(text);
          })
      );
      const targetVisible = labels.some((text) => comparable(text) === targetKey);
      const matchingDetails = Array.from(document.querySelectorAll("details"))
        .map((detail) => {
          const summary = detail.querySelector(":scope > summary");
          if (!visible(summary)) return null;
          const summaryLabel = compactRepeatedLabel(directText(summary) || textOf(summary));
          if (!summaryLabel || comparable(summaryLabel) !== targetKey) return null;
          const expandedItems = Array.from(detail.querySelectorAll("a, button, [role='button'], li, p, span, div"))
            .filter((element) => visible(element) && !summary.contains(element))
            .map((element) => compactRepeatedLabel(directText(element) || (element.children.length <= 2 ? textOf(element) : "")))
            .filter((text) => text && text.length <= 120);
          return {
            open: Boolean(detail.open),
            expandedItemCount: expandedItems.length
          };
        })
        .filter(Boolean);
      const detailState = matchingDetails[0] || null;
      const matchingControlledSummaries = Array.from(document.querySelectorAll("summary[aria-controls]"))
        .filter(visible)
        .map((summary) => {
          const summaryLabel = compactRepeatedLabel(directText(summary) || textOf(summary));
          if (!summaryLabel || comparable(summaryLabel) !== targetKey) return null;
          const controlledId = String(summary.getAttribute("aria-controls") || "").trim();
          const controlled = controlledId ? document.getElementById(controlledId) : null;
          const controlledVisible = Boolean(controlled && visible(controlled));
          const expandedItems = controlledVisible
            ? Array.from(controlled.querySelectorAll("a, button, [role='button'], li, p, span, div"))
              .filter(visible)
              .map((element) => compactRepeatedLabel(directText(element) || (element.children.length <= 2 ? textOf(element) : "")))
              .filter((text) => text && text.length <= 120)
            : [];
          return {
            expanded: String(summary.getAttribute("aria-expanded") || "").toLowerCase() === "true",
            controlledVisible,
            expandedItemCount: expandedItems.length
          };
        })
        .filter(Boolean);
      const controlledState = matchingControlledSummaries[0] || null;
      const topLevelVisibleCount = topLevelLabels
        .filter((label) => labels.some((text) => comparable(text) === comparable(label)))
        .length;
      const controls = drawerVisible
        ? Array.from(drawer.querySelectorAll("button, [role='button'], a, summary, svg, [class*='close-button'], [class*='arrow']"))
          .map((element) => {
            const target = element.closest?.("button, [role='button'], a, summary") || element;
            const rect = target.getBoundingClientRect();
            return { rect, text: textOf(target) + " " + String(target.outerHTML || "").slice(0, 500) };
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
        : [];
      return {
        drawerVisible,
        currentUrl,
        targetVisible: targetVisible || comparable(clonedText).includes(targetKey),
        detailsOpen: Boolean(detailState?.open),
        expandedItemCount: Number(detailState?.expandedItemCount || 0),
        controlledExpanded: Boolean(controlledState?.expanded),
        controlledVisible: Boolean(controlledState?.controlledVisible),
        controlledItemCount: Number(controlledState?.expandedItemCount || 0),
        clonedDrawerVisible: Boolean(clonedContent),
        clonedItemCount,
        clonedBackVisible,
        hiddenCloneRect: hiddenCloneCandidate ? hiddenCloneCandidate.getBoundingClientRect().toJSON() : null,
        hiddenCloneStyle: hiddenCloneCandidate ? {
          display: getComputedStyle(hiddenCloneCandidate).display,
          visibility: getComputedStyle(hiddenCloneCandidate).visibility,
          opacity: getComputedStyle(hiddenCloneCandidate).opacity
        } : null,
        topLevelVisibleCount,
        backVisible: controls.length > 0,
        visibleText: drawerVisible
          ? labels.slice(0, 24).join(" | ")
          : String(clonedText || "").slice(0, 280)
      };
    })()`,
    returnByValue: true
  }).catch(() => ({ result: { value: { drawerVisible: false, currentUrl: expectedUrl, targetVisible: false, backVisible: false, visibleText: "" } } }));
  const value = result.result?.value || {};
  if (!urlsEquivalent(expectedUrl, value.currentUrl || expectedUrl)) {
    return {
      ok: false,
      reason: `URL changed to ${value.currentUrl || "an unexpected URL"} after selecting ${state.activationLabel || state.hoverItemLabel || state.topLevelLabel}.`
    };
  }
  if (!value.drawerVisible) {
    if (value.clonedDrawerVisible && Number(value.clonedItemCount || 0) > 0 && value.targetVisible) {
      return {
        ok: true,
        currentUrl: value.currentUrl || expectedUrl
      };
    }
    return {
      ok: false,
      reason: `Navigation drawer closed after selecting ${state.activationLabel || state.hoverItemLabel || state.topLevelLabel}.`
    };
  }
  if (value.detailsOpen && Number(value.expandedItemCount || 0) > 0 && value.targetVisible) {
    return {
      ok: true,
      currentUrl: value.currentUrl || expectedUrl
    };
  }
  if (value.controlledExpanded && value.controlledVisible && Number(value.controlledItemCount || 0) > 0) {
    return {
      ok: true,
      currentUrl: value.currentUrl || expectedUrl
    };
  }
  if (value.clonedDrawerVisible && Number(value.clonedItemCount || 0) > 0 && value.targetVisible) {
    return {
      ok: true,
      currentUrl: value.currentUrl || expectedUrl
    };
  }
  if (Number(value.topLevelVisibleCount || 0) >= 4) {
    return {
      ok: false,
      reason: `Mobile navigation stayed at the top-level menu after selecting ${state.activationLabel || state.hoverItemLabel || state.topLevelLabel}. topLevelVisibleCount=${Number(value.topLevelVisibleCount || 0)} backVisible=${Boolean(value.backVisible)} targetVisible=${Boolean(value.targetVisible)} detailsOpen=${Boolean(value.detailsOpen)} expandedItemCount=${Number(value.expandedItemCount || 0)} controlledExpanded=${Boolean(value.controlledExpanded)} controlledVisible=${Boolean(value.controlledVisible)} controlledItemCount=${Number(value.controlledItemCount || 0)} clonedDrawerVisible=${Boolean(value.clonedDrawerVisible)} clonedItemCount=${Number(value.clonedItemCount || 0)} clonedBackVisible=${Boolean(value.clonedBackVisible)} hiddenCloneRect=${value.hiddenCloneRect ? `${Math.round(value.hiddenCloneRect.top)},${Math.round(value.hiddenCloneRect.left)},${Math.round(value.hiddenCloneRect.width)}x${Math.round(value.hiddenCloneRect.height)}` : "none"} hiddenCloneStyle=${value.hiddenCloneStyle ? `${value.hiddenCloneStyle.display}/${value.hiddenCloneStyle.visibility}/${value.hiddenCloneStyle.opacity}` : "none"} visibleText=${value.visibleText || "(empty)"}`
    };
  }
  if (!value.backVisible) {
    return {
      ok: false,
      reason: `Could not confirm ${state.activationLabel || state.hoverItemLabel || state.topLevelLabel} secondary page because no back control was visible. visibleText=${value.visibleText || "(empty)"}`
    };
  }
  if (!value.targetVisible) {
    return {
      ok: false,
      reason: `Could not confirm ${state.activationLabel || state.hoverItemLabel || state.topLevelLabel} secondary page. Visible text: ${value.visibleText || "(empty)"}.`
    };
  }
  return {
    ok: true,
    currentUrl: value.currentUrl || expectedUrl
  };
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
      const mobileMenuToggleActive = Array.from(document.querySelectorAll("summary, button, [role='button'], a"))
        .some((element) => {
          const text = [element.id, String(element.className || ""), element.getAttribute("aria-label")].filter(Boolean).join(" ");
          return /header__icon--menu|header__icon.*menu|menu-drawer|hamburger/i.test(text) &&
            /active/i.test(String(element.className || ""));
        });
      const bodyMenuLocked = document.body.classList.contains("unscroll");
      const desktopDrawerOk = drawerVisible &&
        includesLabel(drawerFullText, "Products") &&
        drawerCategoryHits >= 1 &&
        (drawerTaxonomyHits >= 1 || drawerUtilityHits >= 1 || /OPENRUN|OPENSWIM|OPENMOVE|OPENFIT/i.test(drawerFullText));
      const mobileDrawerOk = (drawerVisible || mobileMenuToggleActive || bodyMenuLocked) &&
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
        mobileMenuToggleActive,
        bodyMenuLocked,
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

function captureAreaFromOptions(options = {}) {
  const clip = options?.clip;
  if (!clip) {
    return { viewportRelative: true };
  }
  return {
    x: Math.round(Number(clip.x) || 0),
    y: Math.round(Number(clip.y) || 0),
    width: Math.round(Number(clip.width) || 0),
    height: Math.round(Number(clip.height) || 0),
    scale: Number(clip.scale) || 1,
    viewportRelative: false
  };
}

function normalizeSegmentCaptureY(y, height, segmentHeight) {
  const maxY = Math.max(0, height - segmentHeight);
  const numericY = Number.isFinite(Number(y)) ? Math.round(Number(y)) : 0;
  return Math.max(0, Math.min(maxY, numericY));
}

export async function captureScreenshotWithValidation(client, captureOptions, options = {}) {
  const maxAttempts = Math.max(1, Math.min(6, Number(options.maxAttempts) || 3));
  const attempts = [];
  const label = String(options.label || "screenshot");
  let lastBuffer = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (typeof options.beforeAttempt === "function") {
      await options.beforeAttempt({ attempt, maxAttempts, label, attempts });
    }

    const resolvedOptions = typeof captureOptions === "function"
      ? await captureOptions({ attempt, maxAttempts, label, attempts })
      : captureOptions;
    const screenshot = await client.send("Page.captureScreenshot", resolvedOptions);
    const buffer = Buffer.from(screenshot.data, "base64");
    lastBuffer = buffer;
    const blankAudit = blankImageAuditForBuffer(buffer);
    const acceptedBlankAudit = blankAudit.status !== "ok" &&
      typeof options.acceptBlankAudit === "function" &&
      options.acceptBlankAudit(blankAudit, {
        attempt,
        maxAttempts,
        label,
        attempts,
        resolvedOptions,
        buffer
      });
    const attemptSummary = {
      attempt,
      ok: blankAudit.status === "ok" || acceptedBlankAudit,
      message: blankAudit.status === "ok" || acceptedBlankAudit ? null : (blankAudit.message || null),
      target: captureAreaFromOptions(resolvedOptions),
      blankAudit,
      acceptedBlankAudit: Boolean(acceptedBlankAudit)
    };
    attempts.push(attemptSummary);

    if (blankAudit.status === "ok" || acceptedBlankAudit) {
      return {
        buffer,
        captureValidation: {
          ok: true,
          label,
          maxAttempts,
          retries: attempt - 1,
          attempts
        }
      };
    }

    if (attempt < maxAttempts && typeof options.beforeRetry === "function") {
      await options.beforeRetry({ attempt, maxAttempts, label, attempts, blankAudit, buffer });
    }
    if (attempt < maxAttempts) {
      await sleep(options.retryDelayMs ?? 350);
    }
  }

  const failure = attempts[attempts.length - 1] || { blankAudit: { message: "Image validation failed." } };
  const error = new Error(
    `${label} failed blank-image validation after ${maxAttempts} attempts. ${failure.blankAudit.message || ""}`.trim()
  );
  error.code = "BLANK_SCREENSHOT";
  error.captureBuffer = lastBuffer;
  error.captureValidation = {
    ok: false,
    label,
    maxAttempts,
    retries: Math.max(0, maxAttempts - 1),
    attempts
  };
  throw error;
}

async function captureStitchedScreenshot(client, outputPath, options) {
  const width = Math.ceil(options.width);
  const height = Math.ceil(options.height);
  const viewportHeight = Math.max(320, Math.min(Math.ceil(options.viewportHeight), height));
  const rgba = new Uint8Array(width * height * 4);
  const positions = createSegmentPositions(height, viewportHeight);
  const segmentValidations = [];
  let finalHeight = height;

  for (let index = 0; index < positions.length; index += 1) {
    const y = positions[index];
    const segmentHeight = Math.min(viewportHeight, height - y);
    let captureY = y;
    let screenshotCapture;
    try {
      const isLastSegment = index === positions.length - 1;
      screenshotCapture = await captureScreenshotWithValidation(client, () => {
        return {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: true,
          clip: {
            x: 0,
            y: captureY,
            width,
            height: segmentHeight,
            scale: 1
          }
        };
      }, {
        label: `full-page segment ${index + 1}/${positions.length}`,
        acceptBlankAudit: isLastSegment
          ? (blankAudit) => isAcceptableTrailingSegmentBlankAudit(blankAudit, segmentHeight)
          : null,
        beforeAttempt: async ({ attempt }) => {
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
            await options.beforeFirstSegmentCapture({ attempt, index, y, segmentHeight });
          }
          if (typeof options.beforeSegmentCapture === "function") {
            await options.beforeSegmentCapture({ attempt, index, y, segmentHeight });
          }
          await scrollTo(client, y);
          captureY = y;
          if (typeof options.afterSegmentPositioned === "function") {
            await options.afterSegmentPositioned({
              attempt,
              index,
              y: captureY,
              plannedY: y,
              segmentHeight,
              isLastSegment: index === positions.length - 1
            });
          }
        }
      });
    } catch (error) {
      if (error.captureValidation) {
        error.captureValidation.segment = {
          index,
          plannedY: y,
          y: captureY,
          height: segmentHeight
        };
      }
      throw error;
    }
    segmentValidations.push({
      index,
      plannedY: y,
      y: captureY,
      height: segmentHeight,
      ...screenshotCapture.captureValidation
    });
    const image = decodePng(screenshotCapture.buffer);
    copySegment(image, rgba, width, height, captureY);
  }

  const finalRgba = finalHeight === height
    ? rgba
    : rgba.subarray(0, width * finalHeight * 4);
  const buffer = encodePng(width, finalHeight, finalRgba);
  await fs.writeFile(outputPath, buffer);
  return {
    buffer,
    height: finalHeight,
    captureValidation: {
      ok: true,
      label: "full-page screenshot",
      maxAttempts: Math.max(...segmentValidations.map((item) => Number(item.maxAttempts) || 1), 1),
      retries: segmentValidations.reduce((sum, item) => sum + (Number(item.retries) || 0), 0),
      attempts: segmentValidations
    }
  };
}

function isAcceptableTrailingSegmentBlankAudit(blankAudit, segmentHeight) {
  if (!blankAudit || blankAudit.status !== "blank" || blankAudit.fullImageNearWhite) {
    return false;
  }
  return Number(blankAudit.longestNearWhiteBandStart) > 0 &&
    Number(blankAudit.longestNearWhiteBandEnd) >= Math.max(0, segmentHeight - 1);
}

export const __testOnly = {
  captureStitchedScreenshot,
  freezePageMotion,
  restorePageMotion,
  isAcceptableTrailingSegmentBlankAudit,
  isViewMoreLabel,
  shouldUseDedicatedViewMoreExpansion,
  shouldUseDirectFullPageClipCapture
};

async function captureFullPageClipScreenshot(client, outputPath, options) {
  const screenshotCapture = await captureScreenshotWithValidation(client, () => ({
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
  }), {
    label: options.label || "full-page clip screenshot",
    beforeAttempt: options.beforeAttempt,
    beforeRetry: options.beforeRetry,
    acceptBlankAudit: options.acceptBlankAudit,
    maxAttempts: options.maxAttempts,
    retryDelayMs: options.retryDelayMs
  });
  await fs.writeFile(outputPath, screenshotCapture.buffer);
  return screenshotCapture;
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
      const viewportWidth = Math.max(1, window.innerWidth || 0);
      const viewportHeight = Math.max(1, window.innerHeight || 0);
      for (const element of document.querySelectorAll("body *")) {
        if (element.dataset.pageShotHidden === "true") continue;
        if (element.closest("footer, [class*='footer'], [id*='footer']")) continue;
        const style = getComputedStyle(element);
        const position = style.position;
        const zIndex = Number.parseInt(style.zIndex, 10);
        const hasHighZIndex = Number.isFinite(zIndex) && zIndex >= 1000;
        if (position !== "fixed" && position !== "sticky" && !hasHighZIndex) continue;
        const rect = element.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area < 400) continue;
        const intersectsViewport = rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
        if (!intersectsViewport) continue;
        const anchoredToViewport = position === "fixed" ||
          position === "sticky" ||
          (hasHighZIndex && (
            position === "absolute" ||
            rect.top <= viewportHeight * 0.2 ||
            rect.bottom >= viewportHeight * 0.8 ||
            rect.width >= viewportWidth * 0.65
          ));
        if (!anchoredToViewport) continue;
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
  const finalStart = Math.max(0, height - segmentHeight);
  for (let y = 0; y < finalStart; y += segmentHeight) {
    positions.push(y);
  }
  if (!positions.includes(finalStart)) {
    positions.push(finalStart);
  }
  return positions.sort((a, b) => a - b);
}

function copySegment(image, target, targetWidth, targetHeight, targetY, maxRows = Number.POSITIVE_INFINITY) {
  const copyWidth = Math.min(image.width, targetWidth);
  const copyHeight = Math.min(
    image.height,
    targetHeight - targetY,
    Number.isFinite(Number(maxRows)) ? Math.max(0, Math.floor(Number(maxRows))) : Number.POSITIVE_INFINITY
  );
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
  const useDedicatedViewMoreExpansion = shouldUseDedicatedViewMoreExpansion(options);
  if (useDedicatedViewMoreExpansion) {
    await expandDedicatedViewMoreControls(client, {
      captureUrl: options.captureUrl,
      captureMode: options.captureMode,
      dismissPopups: options.dismissPopups,
      clickDelayMs: stepDelay
    });
    await scrollTo(client, 0);
    await sleep(Math.max(stepDelay, 900));
  }
  await materializeFullPageContent(client);
  if (!useDedicatedViewMoreExpansion) {
    await expandVisibleViewMoreControls(client, {
      captureUrl: options.captureUrl,
      captureMode: options.captureMode,
      dismissPopups: options.dismissPopups,
      clickDelayMs: stepDelay
    });
  } else {
    await sleep(Math.max(220, Math.floor(stepDelay * 0.7)));
  }

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
    if (!useDedicatedViewMoreExpansion) {
      await expandVisibleViewMoreControls(client, {
        captureUrl: options.captureUrl,
        captureMode: options.captureMode,
        dismissPopups: options.dismissPopups,
        clickDelayMs: stepDelay
      });
    }
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

  const bottomState = await settleFullPageBottom(client, state, {
    stepDelay,
    maxHeight,
    captureUrl: options.captureUrl,
    captureMode: options.captureMode,
    dismissPopups: options.dismissPopups
  });
  const reachableHeight = Math.max(
    viewportHeightForState(bottomState),
    Number(bottomState.y || 0) + viewportHeightForState(bottomState)
  );
  await scrollTo(client, 0);
  await sleep(Math.max(stepDelay, 1200));
  await materializeFullPageContent(client);
  if (!useDedicatedViewMoreExpansion) {
    await expandVisibleViewMoreControls(client, {
      captureUrl: options.captureUrl,
      captureMode: options.captureMode,
      dismissPopups: options.dismissPopups,
      clickDelayMs: stepDelay
    });
  }
  state = await getPageState(client);

  return {
    ...state,
    scrolls,
    reachableHeight: Math.max(reachableHeight, Number(state.height || 0))
  };
}

async function settleFullPageBottom(client, state, options = {}) {
  const stepDelay = Number(options.stepDelay) || 350;
  const maxHeight = Math.max(1000, Number(options.maxHeight) || 16000);
  const useDedicatedViewMoreExpansion = shouldUseDedicatedViewMoreExpansion(options);
  let currentState = state && typeof state === "object" ? state : await getPageState(client);
  let bestState = currentState;
  let stableRounds = 0;
  let lastHeight = Math.max(0, Number(currentState.height || 0));
  const maxRounds = 6;
  const settleDelay = Math.max(stepDelay, 900);
  const postMaterializeDelay = Math.max(450, Math.min(1600, stepDelay + 550));

  for (let round = 0; round < maxRounds && stableRounds < 2; round += 1) {
    const targetY = Math.min(
      maxHeight,
      Math.max(
        0,
        Number(currentState.height || 0),
        Number(currentState.y || 0)
      )
    );
    await scrollTo(client, targetY);
    await sleep(settleDelay);
    await materializeFullPageContent(client);
    if (!useDedicatedViewMoreExpansion) {
      await expandVisibleViewMoreControls(client, {
        captureUrl: options.captureUrl,
        captureMode: options.captureMode,
        dismissPopups: options.dismissPopups,
        clickDelayMs: stepDelay
      });
    }
    await sleep(postMaterializeDelay);
    currentState = await getPageState(client);
    bestState = currentState;
    const currentHeight = Math.max(0, Number(currentState.height || 0));
    const incompleteImages = Math.max(0, Number(currentState.incompleteImages || 0));
    if (currentHeight <= lastHeight && incompleteImages === 0) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }
    lastHeight = Math.max(lastHeight, currentHeight);
  }

  return bestState;
}

async function expandShokzCollectionViewMoreControls(client, options = {}) {
  const clicked = [];
  const clickDelayMs = Math.max(180, Math.min(1200, Number(options.clickDelayMs) || 420));
  const maxRounds = Math.max(4, Math.min(80, Number(options.maxRounds) || 48));
  let pageState = await getPageState(client);
  let y = 0;
  let lastHeight = Math.max(0, Number(pageState.height || 0));
  let stableBottomRounds = 0;
  const startedAt = Date.now();

  for (let round = 0; round < maxRounds && Date.now() - startedAt < 90000; round += 1) {
    await scrollTo(client, y);
    await sleep(clickDelayMs);
    const result = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const clean = (value) => String(value || "")
          .replace(/[\\u00a0\\s]+/g, " ")
          .replace(/[\\u25bc\\u25be\\u25bf\\u2228\\u203a\\u00bb>]+/g, " ")
          .trim();
        const isViewMoreLabel = (value) => /^view more\\b/i.test(clean(value));
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
        const readLabel = (element) => clean(
          element?.innerText ||
          element?.textContent ||
          element?.getAttribute?.("aria-label") ||
          element?.getAttribute?.("title")
        );
        const navigatesAway = (target) => {
          const link = target?.closest?.("a[href]");
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
        const interactiveSelector = "button, a, [role='button'], summary, [tabindex], .show_more, [class*='show-more'], [class*='show_more'], [class*='viewmore']";
        const seen = new Set();
        const candidates = Array.from(document.querySelectorAll("button, a, [role='button'], summary, div, span, p"))
          .map((element) => {
            const label = readLabel(element);
            const clickTarget = element.matches(interactiveSelector)
              ? element
              : element.closest(interactiveSelector) || element;
            const rect = element.getBoundingClientRect();
            const clickRect = clickTarget?.getBoundingClientRect?.() || rect;
            return { element, clickTarget, label, rect, clickRect };
          })
          .filter(({ element, clickTarget, label, rect, clickRect }) => {
            if (!label || !isViewMoreLabel(label)) return false;
            if (!visible(element) || !visible(clickTarget)) return false;
            if (rect.width > window.innerWidth * 0.92 || rect.height > 140) return false;
            if (clickRect.bottom < 12 || clickRect.top > window.innerHeight - 12) return false;
            if (String(clickTarget.getAttribute("aria-expanded") || element.getAttribute("aria-expanded") || "").toLowerCase() === "true") {
              return false;
            }
            if (clickTarget.dataset.pageShotCollectionViewMoreClicked === "true" || element.dataset.pageShotCollectionViewMoreClicked === "true") {
              return false;
            }
            if (navigatesAway(clickTarget)) return false;
            if (seen.has(clickTarget)) return false;
            seen.add(clickTarget);
            return true;
          })
          .sort((a, b) => a.clickRect.top - b.clickRect.top || a.clickRect.left - b.clickRect.left);
        const clicked = [];
        for (const { element, clickTarget, label } of candidates) {
          element.dataset.pageShotCollectionViewMoreClicked = "true";
          clickTarget.dataset.pageShotCollectionViewMoreClicked = "true";
          clickTarget.scrollIntoView({ block: "center", inline: "center" });
          if (typeof clickTarget.click === "function") {
            clickTarget.click();
          } else {
            clickTarget.dispatchEvent(new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              view: window
            }));
          }
          clicked.push(label);
        }
        return {
          clicked,
          height: Math.max(
            Number(document.documentElement?.scrollHeight || 0),
            Number(document.body?.scrollHeight || 0)
          ),
          viewportHeight: window.innerHeight,
          y: window.scrollY
        };
      })()`,
      returnByValue: true
    }).catch(() => null);
    const value = result?.result?.value || {};
    const passClicked = Array.isArray(value.clicked) ? value.clicked.filter(Boolean) : [];
    if (passClicked.length) {
      clicked.push(...passClicked);
      await sleep(Math.max(clickDelayMs, 620));
      await materializeFullPageContent(client);
      if (options.dismissPopups !== false) {
        await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 2 });
      }
      pageState = await getPageState(client);
      lastHeight = Math.max(lastHeight, Number(pageState.height || 0));
      stableBottomRounds = 0;
      y = Math.max(0, Number(value.y || y) - 80);
      continue;
    }

    pageState = await getPageState(client);
    const currentHeight = Math.max(0, Number(pageState.height || value.height || 0));
    const viewportHeight = Math.max(1, viewportHeightForState(pageState));
    if (currentHeight <= lastHeight && y + viewportHeight >= currentHeight - 8) {
      stableBottomRounds += 1;
      if (stableBottomRounds >= 2) {
        break;
      }
    } else {
      stableBottomRounds = 0;
    }
    lastHeight = Math.max(lastHeight, currentHeight);
    const step = Math.max(260, Math.min(900, Math.floor(viewportHeight * 0.72)));
    y = Math.min(Math.max(0, currentHeight), y + step);
  }

  await scrollTo(client, 0);
  await sleep(Math.max(clickDelayMs, 700));
  return {
    clickedCount: clicked.length,
    clicked
  };
}

async function expandDedicatedViewMoreControls(client, options = {}) {
  if (!shouldUseDedicatedViewMoreExpansion(options)) {
    return { clickedCount: 0, clicked: [] };
  }

  const clicked = [];
  const clickDelayMs = Math.max(180, Math.min(1200, Number(options.clickDelayMs) || 420));
  const maxPasses = Math.max(1, Math.min(3, Number(options.maxPasses) || 2));

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const result = await expandShokzComparisonTechSpecsViewMore(client);
    if (!result?.clicked) {
      break;
    }
    clicked.push(...(Array.isArray(result.clickedLabels) ? result.clickedLabels : []));
    await waitForShokzComparisonTechSpecsExpanded(client, {
      previousHeight: result.beforeHeight,
      timeoutMs: Math.max(2200, clickDelayMs * 6)
    });
    if (options.dismissPopups !== false) {
      if (shouldCleanShokzKnownPopups(options.captureUrl, options)) {
        await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 2 });
      } else {
        await dismissObstructions(client, { rounds: 2 });
      }
    }
    await sleep(Math.max(220, Math.floor(clickDelayMs * 0.8)));
  }

  return {
    clickedCount: clicked.length,
    clicked
  };
}

async function expandShokzComparisonTechSpecsViewMore(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const interactiveSelector = "button, a, [role='button'], summary, [tabindex], .show_more, [class*='show-more'], [class*='show_more'], .viewmore-gdbox, [class*='viewmore']";
      const clean = (value) => String(value || "")
        .replace(/[\\u00a0\\s]+/g, " ")
        .replace(/[\\u25bc\\u25be\\u25bf\\u2228\\u203a\\u00bb>]+/g, " ")
        .trim();
      const isViewMoreLabel = (value) => /^view more\\b/i.test(clean(value));
      const isViewLessLabel = (value) => /^view less\\b/i.test(clean(value));
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
      const readLabel = (element) => clean(
        element?.innerText ||
        element?.textContent ||
        element?.getAttribute?.("aria-label") ||
        element?.getAttribute?.("title")
      );
      const heading = Array.from(document.querySelectorAll("h2, h3, [role='heading']"))
        .find((node) => clean(node.textContent) === "All Tech Specs") || null;
      if (!heading) {
        return { ok: false, clicked: false, reason: "Could not locate All Tech Specs." };
      }

      heading.scrollIntoView({ block: "center", inline: "center" });
      const headingRect = heading.getBoundingClientRect();
      const markers = Array.from(document.querySelectorAll(".viewmore-gdbox, [class*='viewmore'], button, a, [role='button'], summary, div, span, p, h1, h2, h3, h4"))
        .map((element) => ({ element, label: readLabel(element) }))
        .filter(({ label }) => label);
      if (markers.some(({ element, label }) => visible(element) && isViewLessLabel(label))) {
        return { ok: true, clicked: false, expanded: true, clickedLabels: [] };
      }

      const seenTargets = new Set();
      const candidates = markers
        .filter(({ label }) => isViewMoreLabel(label))
        .map(({ element, label }) => {
          const clickTarget = element.matches(interactiveSelector)
            ? element
            : element.closest(interactiveSelector) || element;
          return {
            element,
            clickTarget,
            label,
            rect: element.getBoundingClientRect(),
            clickRect: clickTarget?.getBoundingClientRect?.() || element.getBoundingClientRect()
          };
        })
        .filter(({ element, clickTarget, rect, clickRect }) => {
          if (!clickTarget || !visible(element) || !visible(clickTarget)) return false;
          if (String(clickTarget.getAttribute("aria-expanded") || element.getAttribute("aria-expanded") || "").toLowerCase() === "true") {
            return false;
          }
          if (clickTarget.dataset.pageShotViewMoreClicked === "true" || element.dataset.pageShotViewMoreClicked === "true") {
            return false;
          }
          if (clickRect.top + 180 < headingRect.top) return false;
          if (rect.width > window.innerWidth * 0.96 || rect.height > 180) return false;
          if (clickRect.bottom < 12 || clickRect.top > window.innerHeight - 12) return false;
          if (seenTargets.has(clickTarget)) return false;
          seenTargets.add(clickTarget);
          return true;
        })
        .sort((a, b) =>
          Math.abs(a.clickRect.top - headingRect.bottom) - Math.abs(b.clickRect.top - headingRect.bottom) ||
          a.clickRect.top - b.clickRect.top ||
          a.clickRect.left - b.clickRect.left
        );

      if (!candidates.length) {
        return { ok: true, clicked: false, expanded: false, clickedLabels: [] };
      }

      const beforeHeight = Math.max(
        Number(document.documentElement?.scrollHeight || 0),
        Number(document.body?.scrollHeight || 0)
      );
      const clickedLabels = [];
      for (const { element, clickTarget, label } of candidates) {
        element.dataset.pageShotViewMoreClicked = "true";
        clickTarget.dataset.pageShotViewMoreClicked = "true";
        clickTarget.scrollIntoView({ block: "center", inline: "center" });
        if (typeof clickTarget.click === "function") {
          clickTarget.click();
        } else {
          clickTarget.dispatchEvent(new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            view: window
          }));
        }
        clickedLabels.push(label);
      }

      return {
        ok: true,
        clicked: clickedLabels.length > 0,
        expanded: false,
        clickedLabels,
        beforeHeight
      };
    })()`,
    returnByValue: true
  }).catch(() => null);
  return result?.result?.value || {
    ok: false,
    clicked: false,
    clickedLabels: [],
    reason: "Could not expand comparison page View More."
  };
}

async function waitForShokzComparisonTechSpecsExpanded(client, options = {}) {
  const timeoutMs = Math.max(400, Math.min(6000, Number(options.timeoutMs) || 2600));
  const previousHeight = Math.max(0, Number(options.previousHeight || 0));
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    lastState = await readShokzComparisonTechSpecsExpansionState(client);
    if (lastState?.ok) {
      const height = Math.max(0, Number(lastState.height || 0));
      if (lastState.expanded || (previousHeight > 0 && height > previousHeight + 60)) {
        return lastState;
      }
    }
    await sleep(180);
  }

  return lastState || {
    ok: false,
    expanded: false,
    height: previousHeight
  };
}

async function readShokzComparisonTechSpecsExpansionState(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const clean = (value) => String(value || "")
        .replace(/[\\u00a0\\s]+/g, " ")
        .replace(/[\\u25bc\\u25be\\u25bf\\u2228\\u203a\\u00bb>]+/g, " ")
        .trim();
      const isViewMoreLabel = (value) => /^view more\\b/i.test(clean(value));
      const isViewLessLabel = (value) => /^view less\\b/i.test(clean(value));
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
      const readLabel = (element) => clean(
        element?.innerText ||
        element?.textContent ||
        element?.getAttribute?.("aria-label") ||
        element?.getAttribute?.("title")
      );
      const heading = Array.from(document.querySelectorAll("h2, h3, [role='heading']"))
        .find((node) => clean(node.textContent) === "All Tech Specs") || null;
      if (!heading) {
        return {
          ok: false,
          expanded: false,
          height: Math.max(
            Number(document.documentElement?.scrollHeight || 0),
            Number(document.body?.scrollHeight || 0)
          )
        };
      }
      const headingRect = heading.getBoundingClientRect();
      const markers = Array.from(document.querySelectorAll(".viewmore-gdbox, [class*='viewmore'], button, a, [role='button'], summary, div, span, p, h1, h2, h3, h4"))
        .map((element) => ({ element, label: readLabel(element) }))
        .filter(({ element, label }) =>
          label &&
          (isViewMoreLabel(label) || isViewLessLabel(label)) &&
          element.getBoundingClientRect().top + 180 >= headingRect.top
        );
      const visibleViewMoreCount = markers.filter(({ element, label }) => visible(element) && isViewMoreLabel(label)).length;
      const visibleViewLessCount = markers.filter(({ element, label }) => visible(element) && isViewLessLabel(label)).length;
      const totalViewMoreCount = markers.filter(({ label }) => isViewMoreLabel(label)).length;
      const height = Math.max(
        Number(document.documentElement?.scrollHeight || 0),
        Number(document.body?.scrollHeight || 0)
      );
      return {
        ok: true,
        expanded: visibleViewLessCount > 0 || (totalViewMoreCount > 0 && visibleViewMoreCount === 0),
        height,
        visibleViewMoreCount,
        visibleViewLessCount,
        totalViewMoreCount
      };
    })()`,
    returnByValue: true
  }).catch(() => null);
  return result?.result?.value || {
    ok: false,
    expanded: false,
    height: 0
  };
}

async function ensureShokzComparisonPageExpandedForFullPageCapture(client, options = {}) {
  if (!shouldUseDedicatedViewMoreExpansion(options)) {
    return null;
  }

  await expandDedicatedViewMoreControls(client, options);
  await scrollTo(client, 0);
  await settlePositionedViewport(client, {
    delayMs: 420,
    frames: 2
  });
  await sleep(900);
  return getPageState(client);
}

async function prepareExpandedShokzComparisonFullPage(client, options = {}) {
  const stepDelay = options.scrollStepMs ?? 350;
  const maxHeight = options.maxFullPageHeight || 16000;
  await expandDedicatedViewMoreControls(client, options);
  await scrollTo(client, 0);
  await sleep(Math.max(stepDelay, 1200));

  let state = await getPageState(client);
  let y = 0;
  let lastHeight = Math.max(0, Number(state.height || 0));
  let stableRounds = 0;
  let scrolls = 0;
  const step = Math.max(360, Math.min(1400, Math.floor((state.viewportHeight || 1000) * 0.65)));
  const maxY = Math.min(maxHeight, 60000);
  const startedAt = Date.now();

  while (stableRounds < 2 && scrolls < 120 && Date.now() - startedAt < 90000) {
    await scrollTo(client, y);
    await sleep(stepDelay);
    state = await getPageState(client);
    scrolls += 1;

    const currentHeight = Math.max(0, Number(state.height || 0));
    if (currentHeight <= lastHeight && y + viewportHeightForState(state) >= currentHeight - 8) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }

    lastHeight = Math.max(lastHeight, currentHeight);
    y += step;
    if (y > Math.min(currentHeight, maxY)) {
      y = currentHeight;
    }
  }

  await scrollTo(client, 0);
  await sleep(Math.max(stepDelay, 1200));
  state = await getPageState(client);

  return {
    ...state,
    scrolls,
    reachableHeight: Math.max(lastHeight, Number(state.height || 0))
  };
}

async function captureExpandedShokzComparisonFullPageScreenshot(client, outputPath, options = {}) {
  await triggerShokzComparisonTechSpecsViewMoreExact(client);
  await sleep(2600);
  await scrollTo(client, 0);
  await settlePositionedViewport(client, {
    delayMs: 1400,
    frames: 2
  });

  const pageState = await getPageState(client);
  const clipWidth = Math.max(1, Math.ceil(Number(options.width || 0) || 393));
  const clipHeight = Math.min(
    Math.max(Number(options.viewportHeight || 0) || 852, Math.ceil(Number(pageState.height || 0) || Number(options.height || 0) || 852)),
    Math.max(1000, Number(options.maxHeight || 0) || 16000)
  );

  const screenshotCapture = await captureScreenshotWithValidation(client, () => ({
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: clipWidth,
      height: clipHeight,
      scale: 1
    }
  }), {
    label: "Shokz comparison full-page screenshot",
    beforeAttempt: async ({ attempt }) => {
      if (attempt > 1) {
        await triggerShokzComparisonTechSpecsViewMoreExact(client);
        await sleep(2600);
      }
      await prepareForScreenshotCapture(client, {
        rounds: 2,
        shokzKnownPopups: options.shokzKnownPopups,
        dismissObstructions: false,
        guardSearchOverlay: options.guardSearchOverlay,
        stage: "before comparison full-page clip screenshot capture"
      });
      if (options.guardSearchOverlay) {
        await ensureShokzSearchOverlayClosed(client, "before comparison full-page clip screenshot capture");
      }
      await scrollTo(client, 0);
      await settlePositionedViewport(client, {
        delayMs: attempt > 1 ? 1400 : 1200,
        frames: 2
      });
    }
  });
  await fs.writeFile(outputPath, screenshotCapture.buffer);

  return {
    buffer: screenshotCapture.buffer,
    captureValidation: screenshotCapture.captureValidation,
    height: clipHeight,
    pageState: {
      ...pageState,
      reachableHeight: clipHeight
    }
  };
}

async function triggerShokzComparisonTechSpecsViewMoreExact(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const clean = (value) => String(value || "")
        .replace(/[\\u00a0\\s]+/g, " ")
        .replace(/[\\u25bc\\u25be\\u25bf\\u2228\\u203a\\u00bb>]+/g, " ")
        .trim();
      const heading = Array.from(document.querySelectorAll("h2, h3, [role='heading']"))
        .find((node) => clean(node.textContent) === "All Tech Specs") || null;
      if (!heading) {
        return { ok: false, reason: "Could not locate All Tech Specs." };
      }
      heading.scrollIntoView({ block: "center", inline: "center" });
      const button = Array.from(document.querySelectorAll(".viewmore-gdbox, [class*='viewmore']"))
        .find((node) => clean(node.innerText || node.textContent || "") === "View More") || null;
      if (!button) {
        return { ok: false, reason: "Could not locate comparison page View More button." };
      }
      button.click();
      return { ok: true };
    })()`,
    returnByValue: true
  }).catch(() => null);
  return result?.result?.value || { ok: false, reason: "Could not trigger comparison page View More." };
}

async function expandVisibleViewMoreControls(client, options = {}) {
  const maxPasses = Math.max(1, Math.min(4, Number(options.maxPasses) || 2));
  const clicked = [];
  const clickDelayMs = Math.max(180, Math.min(1200, Number(options.clickDelayMs) || 420));

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const result = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const interactiveSelector = "button, a, [role='button'], summary, [tabindex], .show_more, [class*='show-more'], [class*='show_more'], .viewmore-gdbox, [class*='viewmore']";
        const clean = (value) => String(value || "")
          .replace(/[\\u00a0\\s]+/g, " ")
          .replace(/[\\u25bc\\u25be\\u25bf\\u2228\\u203a\\u00bb>]+/g, " ")
          .trim();
        const isViewMoreLabel = (value) => /^view more\\b/i.test(clean(value));
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
        const navigatesAway = (target) => {
          const link = target?.closest?.("a[href]");
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
        const seen = new Set();
        const candidates = Array.from(document.querySelectorAll("button, a, [role='button'], summary, div, span, p, h1, h2, h3, h4"))
          .map((element) => {
            const label = clean(
              element.innerText ||
              element.textContent ||
              element.getAttribute?.("aria-label") ||
              element.getAttribute?.("title")
            );
            const clickTarget = element.matches(interactiveSelector)
              ? element
              : element.closest(interactiveSelector) || element;
            const rect = element.getBoundingClientRect();
            const clickRect = clickTarget.getBoundingClientRect();
            return { element, clickTarget, label, rect, clickRect };
          })
          .filter(({ element, clickTarget, label, rect, clickRect }) => {
            if (!label || !isViewMoreLabel(label)) return false;
            if (!visible(element) || !visible(clickTarget)) return false;
            if (rect.width > window.innerWidth * 0.92 || rect.height > 140) return false;
            if (clickRect.bottom < 12 || clickRect.top > window.innerHeight - 12) return false;
            if (String(clickTarget.getAttribute("aria-expanded") || element.getAttribute("aria-expanded") || "").toLowerCase() === "true") {
              return false;
            }
            if (clickTarget.dataset.pageShotViewMoreClicked === "true" || element.dataset.pageShotViewMoreClicked === "true") {
              return false;
            }
            if (navigatesAway(clickTarget)) return false;
            if (seen.has(clickTarget)) return false;
            seen.add(clickTarget);
            return true;
          })
          .sort((a, b) =>
            a.clickRect.top - b.clickRect.top ||
            a.clickRect.left - b.clickRect.left
          );
        const clicked = [];
        for (const { element, clickTarget, label } of candidates) {
          element.dataset.pageShotViewMoreClicked = "true";
          clickTarget.dataset.pageShotViewMoreClicked = "true";
          clickTarget.scrollIntoView({ block: "center", inline: "center" });
          if (typeof clickTarget.click === "function") {
            clickTarget.click();
          } else {
            clickTarget.dispatchEvent(new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              view: window
            }));
          }
          clicked.push(label);
        }
        return { clicked };
      })()`,
      returnByValue: true
    }).catch(() => null);
    const value = result?.result?.value || {};
    const passClicked = Array.isArray(value.clicked) ? value.clicked.filter(Boolean) : [];
    if (!passClicked.length) {
      break;
    }
    clicked.push(...passClicked);
    await sleep(clickDelayMs);
    await materializeFullPageContent(client);
    if (options.dismissPopups !== false) {
      if (shouldCleanShokzKnownPopups(options.captureUrl, options)) {
        await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 2 });
      } else {
        await dismissObstructions(client, { rounds: 2 });
      }
    }
    await sleep(Math.max(160, Math.floor(clickDelayMs * 0.6)));
  }

  return {
    clickedCount: clicked.length,
    clicked
  };
}

async function settlePositionedViewport(client, options = {}) {
  const frames = Math.max(1, Math.min(6, Number(options.frames) || 2));
  const delayMs = Math.max(0, Math.min(2000, Number(options.delayMs) || 0));
  await client.send("Runtime.evaluate", {
    expression: `(() => new Promise((resolve) => {
      let remainingFrames = ${frames};
      const finish = () => setTimeout(resolve, ${delayMs});
      const tick = () => {
        remainingFrames -= 1;
        if (remainingFrames <= 0) {
          finish();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }))()`,
    awaitPromise: true,
    returnByValue: true
  }).catch(() => sleep(delayMs));
}

async function patchShokzMobileFooterInStitchedCapture(client, url, stitchedCapture, options = {}) {
  if (!stitchedCapture?.buffer || !Number.isFinite(Number(stitchedCapture.height))) {
    return stitchedCapture;
  }
  const viewportHeight = Math.max(1, Math.floor(Number(options.viewportHeight) || 0));
  const finalHeight = Math.max(1, Math.floor(Number(stitchedCapture.height) || 0));
  const finalStart = Math.max(0, finalHeight - viewportHeight);
  if (viewportHeight < 200 || finalStart <= 0) {
    return stitchedCapture;
  }

  await navigateForFooterPatch(client, url, {
    waitAfterLoadMs: options.waitAfterLoadMs,
    guardSearchOverlay: options.guardSearchOverlay
  });
  await positionFooterPatchViewport(client, finalStart, {
    guardSearchOverlay: options.guardSearchOverlay
  });

  const footerCapture = await captureScreenshotWithValidation(client, {
    format: "png",
    fromSurface: true
  }, {
    label: "shokz footer viewport patch",
    maxAttempts: 2,
    acceptBlankAudit: (blankAudit) => Boolean(blankAudit && !blankAudit.fullImageNearWhite),
    beforeAttempt: async ({ attempt }) => {
      if (attempt > 1) {
        await navigateForFooterPatch(client, url, {
          waitAfterLoadMs: options.waitAfterLoadMs,
          guardSearchOverlay: options.guardSearchOverlay
        });
      }
      await positionFooterPatchViewport(client, finalStart, {
        guardSearchOverlay: options.guardSearchOverlay,
        delayMs: attempt > 1 ? 1100 : 760
      });
    }
  });
  const footerInfo = await readShokzFooterViewportInfo(client);
  const footerTop = resolveShokzFooterPatchTop(footerInfo, viewportHeight);

  const buffer = patchViewportRowsIntoStitchedCapture(
    stitchedCapture.buffer,
    footerCapture.buffer,
    {
      sourceTop: footerTop,
      targetTop: finalStart + footerTop
    }
  );
  if (!buffer) {
    return stitchedCapture;
  }
  if (options.outputPath) {
    await fs.writeFile(options.outputPath, buffer);
  }
  return {
    ...stitchedCapture,
    buffer
  };
}

function patchViewportRowsIntoStitchedCapture(baseBuffer, viewportBuffer, options = {}) {
  const baseImage = decodePng(baseBuffer);
  const viewportImage = decodePng(viewportBuffer);
  const sourceY = Math.max(0, Math.min(viewportImage.height - 1, Math.floor(Number(options.sourceTop) || 0)));
  const targetY = Math.max(0, Math.min(baseImage.height - 1, Math.floor(Number(options.targetTop) || 0)));
  const rows = Math.min(viewportImage.height - sourceY, baseImage.height - targetY);
  if (rows <= 0) {
    return null;
  }
  const rgba = new Uint8Array(baseImage.rgba);
  const copyWidth = Math.min(baseImage.width, viewportImage.width);
  for (let row = 0; row < rows; row += 1) {
    const sourceStart = ((sourceY + row) * viewportImage.width) * 4;
    const targetStart = ((targetY + row) * baseImage.width) * 4;
    rgba.set(
      viewportImage.rgba.subarray(sourceStart, sourceStart + copyWidth * 4),
      targetStart
    );
  }
  return encodePng(baseImage.width, baseImage.height, rgba);
}

function resolveShokzFooterPatchTop(footerInfo, viewportHeight) {
  const safeViewportHeight = Math.max(1, Math.floor(Number(viewportHeight) || 0));
  const fallbackTop = Math.max(120, Math.min(safeViewportHeight - 220, Math.round(safeViewportHeight * 0.2)));
  if (!footerInfo?.ok) {
    return fallbackTop;
  }
  return Math.max(80, Math.min(safeViewportHeight - 120, Math.floor(Number(footerInfo.top) || fallbackTop)));
}

async function navigateForFooterPatch(client, url, options = {}) {
  const loadEvent = client.waitFor("Page.loadEventFired", defaultTimeoutMs).catch(() => null);
  await client.send("Page.navigate", { url });
  await loadEvent;
  await sleep(options.waitAfterLoadMs ?? 2500);
  await dismissShokzKnownPopupsBeforeScreenshot(client, { rounds: 3 });
  if (options.guardSearchOverlay) {
    await ensureShokzSearchOverlayClosed(client, "after footer patch navigation");
  }
  await materializeFullPageContent(client);
  await sleep(420);
}

async function positionFooterPatchViewport(client, finalStart, options = {}) {
  await scrollTo(client, finalStart);
  await settlePositionedViewport(client, {
    delayMs: Number(options.delayMs) > 0 ? Number(options.delayMs) : 760,
    frames: 4
  });
  await dismissCookieControlsInViewport(client);
  if (options.guardSearchOverlay) {
    await ensureShokzSearchOverlayClosed(client, "before footer patch capture");
  }
  await hideFixedElements(client);
  await freezePageMotion(client);
  await settlePositionedViewport(client, { delayMs: 380, frames: 2 });
}

async function dismissCookieControlsInViewport(client) {
  for (let round = 0; round < 3; round += 1) {
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
        const textOf = (element) => [
          element.innerText,
          element.textContent,
          element.getAttribute?.("aria-label"),
          element.getAttribute?.("title"),
          element.value
        ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
        let clicked = 0;
        const controls = Array.from(document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']"));
        for (const control of controls) {
          if (!visible(control)) continue;
          const text = textOf(control).slice(0, 160);
          if (!/accept all|use necessary cookies only|preferences/i.test(text)) continue;
          try {
            if (typeof control.click === "function") {
              control.click();
            } else {
              control.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
            }
            clicked += 1;
          } catch {}
        }
        return clicked;
      })()`,
      returnByValue: true
    }).catch(() => null);
    const clicked = Number(result?.result?.value || 0);
    await sleep(clicked ? 420 : 180);
    if (!clicked) {
      break;
    }
  }
}

async function readShokzFooterViewportInfo(client) {
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
      const textOf = (element) => (element?.innerText || element?.textContent || "").replace(/\\s+/g, " ").trim();
      const candidates = Array.from(document.querySelectorAll(
        ".shopify-section-group-footer-group, .section-footer-new, footer, [class*='footer'], [id*='footer']"
      ))
        .filter(visible)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = textOf(element);
          return {
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
            text,
            score:
              Number(/USA:|About Us|Support|Policy|United States/i.test(text)) * 12 +
              Number(/©\\s*20\\d\\d\\s*Shokz/i.test(text)) * 16 +
              Math.min(rect.height / 120, 8)
          };
        })
        .filter((item) =>
          item.top >= 80 &&
          item.top < window.innerHeight &&
          item.height >= 160 &&
          /USA:|About Us|Support|Policy|United States|©\\s*20\\d\\d\\s*Shokz/i.test(item.text)
        )
        .sort((a, b) => b.score - a.score || a.top - b.top);
      const best = candidates[0];
      if (!best) {
        return { ok: false };
      }
      return {
        ok: true,
        top: best.top,
        bottom: best.bottom,
        height: best.height,
        text: best.text.slice(0, 240)
      };
    })()`,
    returnByValue: true
  }).catch(() => null);
  return result?.result?.value || { ok: false };
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

function viewportHeightForState(state = {}) {
  return Math.max(0, Number(state.viewportHeight || 0));
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
