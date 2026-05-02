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
  if (options.dismissPopups !== false) {
    await dismissObstructions(client);
    await verifyCurrentUrl(client, url, "after dismissing popups", urlCheck);
  }

  if (options.captureMode === "shokz-products-nav") {
    stage = "opening Shokz products navigation";
    await openShokzProductsNavigation(client, viewport);
    await verifyCurrentUrl(client, url, "after opening Shokz products navigation", urlCheck);
  }

  if (options.captureMode === "shokz-home-banners") {
    stage = "reading page title";
    const titleResult = await readPageTitle(client);
    stage = "capturing Shokz home banners";
    const bannerCapture = await captureShokzHomeBanners(client, outputPath, viewport);
    const finalUrl = await verifyCurrentUrl(client, url, "after banner capture", urlCheck);
    urlCheck.ok = true;
    return {
      requestedUrl: url,
      finalUrl,
      urlCheck,
      title: titleResult,
      width: bannerCapture.width,
      height: bannerCapture.height,
      fullPageHeight: bannerCapture.height,
      truncated: false,
      scrollInfo: null,
      ...bannerCapture
    };
  }

  let scrollInfo = null;
  if (options.fullPage && options.lazyLoadScroll !== false) {
    stage = "scrolling to trigger lazy content";
    scrollInfo = await prepareFullPage(client, options);
    await verifyCurrentUrl(client, url, "after lazy-load scrolling", urlCheck);
    if (options.dismissPopups !== false) {
      await dismissObstructions(client);
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
    const bannerSignature = state.signature || slide.signature || `banner-${index + 1}`;
    const duplicate = seenLogical.has(bannerSignature) || seenVisual.has(visualSignature);

    if (duplicate) {
      duplicates.push({
        bannerIndex: index + 1,
        bannerSignature,
        visualSignature
      });
      continue;
    }

    seenLogical.add(bannerSignature);
    seenVisual.add(visualSignature);

    const bannerOutput = bannerOutputPath(outputPath, index + 1);
    await fs.writeFile(bannerOutput, buffer);
    maxWidth = Math.max(maxWidth, Math.round(clip.width));
    maxHeight = Math.max(maxHeight, Math.round(clip.height));
    captures.push({
      outputPath: bannerOutput,
      width: Math.round(clip.width),
      height: Math.round(clip.height),
      bannerIndex: index + 1,
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
        images: state.images || []
      }
    });
  }

  if (!captures.length) {
    throw new Error("Shokz home banner capture found slides but every screenshot looked duplicated.");
  }

  const validationStatus = captures.length === plan.count ? "ok" : "warning";
  return {
    width: maxWidth,
    height: maxHeight,
    captures,
    bannerInfo: {
      expectedCount: plan.count,
      capturedCount: captures.length,
      duplicateCount: duplicates.length,
      duplicates,
      status: validationStatus,
      slides: plan.slides
    }
  };
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
          const keywordScore = /hero|banner|swiper|slideshow|slider|carousel/i.test(className) ? 35 : 0;
          const topScore = Math.max(0, 900 - Math.abs(rect.top)) / 18;
          const sizeScore = Math.min(55, (rect.width * rect.height) / 22000);
          const swiperScore = swiper ? 35 : 0;
          const score = count * 28 + bullets.length * 4 + keywordScore + topScore + sizeScore + swiperScore;
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
            hasSwiper: Boolean(swiper)
          };
        })
        .filter((candidate) => candidate.count >= 2)
        .sort((a, b) => b.score - a.score);

      const best = candidates[0];
      if (!best) {
        return { ok: false, reason: "No visible carousel with two or more logical slides was found." };
      }

      window.__pageShotBannerRoot = best.root;
      window.__pageShotBannerSlides = best.slides.slice(0, best.count);
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
        nextControl.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
        nextControl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
        nextControl.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
        nextControl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
        nextControl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
        window.__pageShotBannerActiveElement = null;
        return { ok: true, method: "next-control", ordinal };
      }
      const domSlides = Array.isArray(window.__pageShotBannerElements)
        ? window.__pageShotBannerElements.filter((element) => element instanceof Element)
        : [];
      const forced = domSlides[ordinal];
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
      return {
        ok: true,
        clip,
        signature: signatureFor(active),
        text: cleanText([active.innerText, active.textContent].filter(Boolean).join(" "), 220),
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

function bannerOutputPath(outputPath, bannerIndex) {
  return outputPath.replace(/\.png$/i, `-banner-${bannerIndex}.png`);
}

function hashBuffer(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex");
}

async function openShokzProductsNavigation(client, viewport) {
  await scrollTo(client, 0);
  await closeShokzSearchOverlay(client);
  await sleep(700);

  if (viewport.mobile) {
    await clickShokzMobileMenu(client);
    await ensureShokzMobileMenuVisible(client);
  } else {
    await hoverShokzProductsMenu(client);
  }

  const state = await waitForShokzProductsNavigation(client, Boolean(viewport.mobile));
  if (!state.ok) {
    const visibleText = state.visibleText ? ` Visible text: ${state.visibleText}` : "";
    const details = ` hits=${state.categoryHits || 0}/${state.taxonomyHits || 0} search=${Boolean(state.searchOpen)} cart=${Boolean(state.cartOpen)} scrollY=${Math.round(state.scrollY || 0)}`;
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
      const searchInput = Array.from(document.querySelectorAll("input"))
        .find((input) => {
          if (!visible(input)) return false;
          const rect = input.getBoundingClientRect();
          const hint = [
            input.type,
            input.placeholder,
            input.getAttribute("aria-label"),
            input.id,
            String(input.className || "")
          ].filter(Boolean).join(" ");
          return rect.width > 120 && /search/i.test(hint);
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
        const details = target.closest("details[open]");
        if (details) {
          details.removeAttribute("open");
        }
        for (const modal of document.querySelectorAll(".search-modal, .modal__content, [class*='search-modal']")) {
          if (visible(modal)) {
            modal.dataset.pageShotHidden = "true";
            modal.style.setProperty("display", "none", "important");
          }
        }
        document.body.classList.remove("overflow-hidden");
        return { ok: true, x, y };
      }
      return { ok: false };
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

async function clickShokzMobileMenu(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < Math.max(180, window.innerHeight * 0.3) &&
          rect.left > window.innerWidth - 140 &&
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
      const interactiveSelector = "button, summary, [role='button'], a, [aria-label], [title], [tabindex], svg, [class*='menu']";
      const candidates = Array.from(document.querySelectorAll(interactiveSelector))
        .filter(visible)
        .map((element) => {
          const target = element.closest("button, summary, [role='button'], a, [tabindex]") || element;
          const rect = target.getBoundingClientRect();
          const text = textOf(target);
          const iconText = text + " " + target.outerHTML.slice(0, 500);
          const menuLike = /menu|hamburger|drawer|icon-menu|menu-drawer/i.test(iconText) &&
            !/cart|bag|search|account|user|login/i.test(iconText);
          return { target, rect, text, menuLike };
        })
        .filter((item) => item.rect.width >= 16 && item.rect.height >= 16 && item.rect.width <= 96 && item.rect.height <= 96)
        .sort((a, b) => Number(b.menuLike) - Number(a.menuLike) || b.rect.right - a.rect.right || a.rect.top - b.rect.top);
      const menuCandidates = candidates.filter((item) => item.menuLike);
      let target = menuCandidates[0]?.target;
      let clickMethod = "candidate";
      let forcedPoint = null;
      if (!target) {
        const pointX = Math.round(window.innerWidth - 32);
        const pointY = Math.round(Math.min(104, Math.max(72, window.innerHeight * 0.1)));
        const pointElement = document.elementFromPoint(pointX, pointY);
        const pointText = pointElement ? textOf(pointElement) + " " + pointElement.outerHTML.slice(0, 400) : "";
        const pointTarget = pointElement?.closest("button, summary, [role='button'], a, [tabindex], [onclick], details") || pointElement;
        if (pointTarget && !/cart|bag|search|account|user|login|learn/i.test(pointText)) {
          target = pointTarget;
          clickMethod = "geometry";
          forcedPoint = { x: pointX, y: pointY };
        }
      }
      if (!target) {
        const geometricCandidates = Array.from(document.querySelectorAll("body *"))
          .filter(visible)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const text = textOf(element);
            const html = element.outerHTML.slice(0, 400);
            return { target: element, rect, text, html };
          })
          .filter((item) =>
            item.rect.top >= 56 &&
            item.rect.top < 130 &&
            item.rect.left > window.innerWidth - 52 &&
            item.rect.width >= 14 &&
            item.rect.width <= 64 &&
            item.rect.height >= 14 &&
            item.rect.height <= 64 &&
            !/cart|bag|search|account|user|login|learn/i.test(item.text + " " + item.html)
          )
          .sort((a, b) => b.rect.right - a.rect.right || a.rect.top - b.rect.top);
        target = geometricCandidates[0]?.target;
        if (target) {
          clickMethod = "geometry";
        }
      }
      if (!target) {
        const drawer = Array.from(document.querySelectorAll("details, [class*='menu-drawer'], [id*='menu-drawer'], [class*='drawer']"))
          .find((element) => {
            const html = element.outerHTML.slice(0, 1200);
            return /menu-drawer|header__icon--menu|hamburger|drawer/i.test(html) &&
              !/cart|search|account|login/i.test(html);
          });
        if (drawer) {
          const details = drawer.matches("details") ? drawer : drawer.closest("details") || drawer.querySelector("details");
          if (details) {
            details.setAttribute("open", "");
            details.open = true;
          }
          const panels = [
            drawer,
            ...drawer.querySelectorAll("[class*='menu-drawer'], [class*='drawer'], nav, .menu-drawer")
          ];
          for (const panel of panels) {
            panel.style.setProperty("display", "block", "important");
            panel.style.setProperty("visibility", "visible", "important");
            panel.style.setProperty("opacity", "1", "important");
            panel.style.setProperty("transform", "translateX(0)", "important");
            panel.style.setProperty("pointer-events", "auto", "important");
          }
          document.body.classList.add("overflow-hidden");
          return { ok: true, x: 0, y: 0, text: "menu drawer fallback", clickMethod: "drawer" };
        }
        const debug = candidates
          .slice(0, 10)
          .map((item) => item.text.slice(0, 100) + " @ " + Math.round(item.rect.left) + "," + Math.round(item.rect.top) + " " + Math.round(item.rect.width) + "x" + Math.round(item.rect.height));
        return { ok: false, reason: "Mobile menu trigger not found: " + debug.join(" | ") };
      }
      const rect = target.getBoundingClientRect();
      const x = forcedPoint?.x ?? Math.round(rect.left + rect.width / 2);
      const y = forcedPoint?.y ?? Math.round(rect.top + rect.height / 2);
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          view: window
        }));
      }
      return { ok: true, x, y, text: textOf(target), clickMethod };
    })()`,
    returnByValue: true
  });
  const value = result.result?.value || {};
  if (!value.ok) {
    throw new Error(value.reason || "Mobile menu trigger not found.");
  }
  if (value.clickMethod === "geometry") {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: value.x, y: value.y, radiusX: 1, radiusY: 1, force: 1, id: 1 }]
    }).catch(() => null);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: []
    }).catch(() => null);
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: value.x,
      y: value.y,
      button: "left",
      clickCount: 1
    }).catch(() => null);
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: value.x,
      y: value.y,
      button: "left",
      clickCount: 1
    }).catch(() => null);
  }
  await sleep(900);
}

async function ensureShokzMobileMenuVisible(client) {
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const cleanText = (element) => String(element?.innerText || element?.textContent || "")
        .replace(/\\s+/g, " ")
        .trim();
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
      const hasMenuText = (text) => /Products/i.test(text) &&
        /Sports Headphones/i.test(text) &&
        /Support/i.test(text) &&
        /Technology/i.test(text);
      const alreadyVisible = Array.from(document.querySelectorAll("body *"))
        .some((element) => {
          if (!visible(element)) return false;
          const rect = element.getBoundingClientRect();
          return rect.top < 120 && rect.height > 260 && hasMenuText(cleanText(element));
        });
      if (alreadyVisible) return { ok: true, method: "already-visible" };

      const candidates = Array.from(document.querySelectorAll("body *"))
        .map((element) => ({ element, text: cleanText(element) }))
        .filter((item) =>
          item.element !== document.body &&
          item.element !== document.documentElement &&
          item.text.length > 120 &&
          item.text.length < 8000 &&
          hasMenuText(item.text)
        )
        .sort((a, b) => a.text.length - b.text.length);
      const panel = candidates[0]?.element;
      if (!panel) return { ok: false };

      const chain = [];
      let node = panel;
      while (node && node instanceof Element && node !== document.body) {
        chain.push(node);
        node = node.parentElement;
      }
      for (const element of chain) {
        element.style.setProperty("display", "block", "important");
        element.style.setProperty("visibility", "visible", "important");
        element.style.setProperty("opacity", "1", "important");
        element.style.setProperty("transform", "translateX(0)", "important");
        element.style.setProperty("pointer-events", "auto", "important");
      }
      panel.style.setProperty("position", "fixed", "important");
      panel.style.setProperty("z-index", "2147483647", "important");
      panel.style.setProperty("inset", "0", "important");
      panel.style.setProperty("width", "100vw", "important");
      panel.style.setProperty("height", "100vh", "important");
      panel.style.setProperty("max-height", "100vh", "important");
      panel.style.setProperty("overflow", "auto", "important");
      panel.style.setProperty("background", "#fff", "important");
      window.scrollTo(0, 0);
      return { ok: true, method: "forced-visible", text: candidates[0].text.slice(0, 160) };
    })()`,
    returnByValue: true
  }).catch(() => null);
  await sleep(500);
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
          rect.top < window.innerHeight &&
          rect.height <= window.innerHeight + 260 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0.01;
      };
      const textOf = (element) => [
        element.innerText,
        element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const categories = ["Sports Headphones", "Workout & Lifestyle Earbuds", "Communication Headsets"];
      const desktopTaxonomy = ["Open-Ear Headphones", "Bone Conduction Sports Headphones", "Workout & Lifestyle Open Earbuds"];
      const utilityLinks = ["Accessories", "Refurbished", "Buy In Bulk", "Compare Products", "All Products"];
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
          const categoryHits = categories.filter((value) => text.includes(value)).length;
          const taxonomyHits = desktopTaxonomy.filter((value) => text.includes(value)).length;
          const utilityHits = utilityLinks.filter((value) => text.includes(value)).length;
          const positioned = ["fixed", "absolute", "sticky"].includes(style.position) ||
            (Number.parseInt(style.zIndex, 10) || 0) >= 10;
          const panelLike = positioned || (rect.top < 180 && rect.height > window.innerHeight * 0.35);
          return { text, categoryHits, taxonomyHits, utilityHits, panelLike };
        })
        .filter((item) => item.text.length > 0 && item.text.length < 5000)
        .sort((a, b) => {
          const scoreA = a.categoryHits * 4 + a.taxonomyHits * 3 + a.utilityHits * 2 + Number(a.panelLike);
          const scoreB = b.categoryHits * 4 + b.taxonomyHits * 3 + b.utilityHits * 2 + Number(b.panelLike);
          return scoreB - scoreA;
        });
      const best = layers[0] || { text: "", categoryHits: 0, taxonomyHits: 0, utilityHits: 0, panelLike: false };
      return {
        ok: !searchOpen &&
          window.scrollY < 20 &&
          /Products/i.test(best.text) &&
          best.categoryHits >= 2 &&
          (mobile || best.taxonomyHits >= 1 || best.panelLike),
        visibleText: best.text.slice(0, 260),
        categoryHits: best.categoryHits,
        taxonomyHits: best.taxonomyHits,
        utilityHits: best.utilityHits,
        panelLike: best.panelLike,
        searchOpen,
        cartOpen,
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
