import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { __testOnly, blankImageAuditForBuffer, captureScreenshotWithValidation, imageQualityAuditForBuffer } from "../src/browser.js";
import { decodePng, encodePng } from "../src/png.js";

const {
  captureStitchedScreenshot,
  freezePageMotion,
  restorePageMotion,
  isAcceptableTrailingSegmentBlankAudit,
  isAcceptableOverlappedTrailingSegmentBlankAudit,
  isAcceptableShokzLongPageBlankBandAudit,
  isViewMoreLabel,
  composeShokzCollectionTabComposite,
  composeShokzHomeModuleComposite,
  composeShokzHomeOverviewComposite,
  composeShokzHomeTopbarComposite,
  composeShokzHomeProductShowcaseComposite,
  shouldSuppressRelatedQualityWarning,
  shokzLandingRelatedSectionDefinitionsForPath,
  shouldPreserveMeasuredFullPageHeight,
  shouldUseDedicatedViewMoreExpansion,
  shouldUseDirectFullPageClipCapture,
  shouldUseFastViewportFullPageCapture,
  fastFullPageAttemptTimeoutMs,
  captureFastViewportFullPageScreenshot,
  shouldUseStitchedLandingFullPageCapture,
  browserLaunchProfiles,
  isRetryableBrowserLaunchError,
  isRetryableBlankCaptureError,
  isRetryableBlankGpuCaptureError,
  stitchedFullPageSegmentHeight
} = __testOnly;

test("flags flat images as low-detail quality warnings", () => {
  const buffer = encodePng(24, 24, solidImage(24, 24, [128, 128, 128, 255]));
  const audit = imageQualityAuditForBuffer(buffer);

  assert.equal(audit.status, "warning");
  assert.equal(audit.sharpness, 0);
  assert.equal(audit.contrast, 0);
});

test("passes high-contrast detailed images", () => {
  const buffer = encodePng(24, 24, checkerImage(24, 24));
  const audit = imageQualityAuditForBuffer(buffer);

  assert.equal(audit.status, "ok");
  assert.ok(audit.sharpness > 4);
  assert.ok(audit.contrast > 18);
});

test("suppresses structured media carousel low-detail quality warnings", () => {
  assert.equal(
    shouldSuppressRelatedQualityWarning(
      { key: "media" },
      { stateLabel: "Shokz | Open-Ear Audio Pioneer 1" },
      { textBlocks: [{ text: "Open-Ear Audio Pioneer" }], images: [{ src: "media.jpg" }] },
      { qualityStatus: "warning" }
    ),
    true
  );
  assert.equal(
    shouldSuppressRelatedQualityWarning(
      { key: "voices" },
      { stateLabel: "Shokz | Open-Ear Audio Pioneer 1" },
      { textBlocks: [{ text: "Open-Ear Audio Pioneer" }], images: [{ src: "media.jpg" }] },
      { qualityStatus: "warning" }
    ),
    false
  );
});

test("flags near-white images as blank", () => {
  const buffer = encodePng(200, 200, solidImage(200, 200, [255, 255, 255, 255]));
  const audit = blankImageAuditForBuffer(buffer);

  assert.equal(audit.status, "blank");
  assert.equal(audit.fullImageNearWhite, true);
});

test("flags large near-white bands as blank", () => {
  const buffer = encodePng(220, 240, whiteBandImage(220, 240, 48, 168));
  const audit = blankImageAuditForBuffer(buffer);

  assert.equal(audit.status, "blank");
  assert.ok(audit.longestNearWhiteBand >= audit.minBlankBandHeight);
});

test("allows bright images with visible detail", () => {
  const buffer = encodePng(220, 240, brightDetailedImage(220, 240));
  const audit = blankImageAuditForBuffer(buffer);

  assert.equal(audit.status, "ok");
  assert.ok(audit.longestNearWhiteBand < audit.minBlankBandHeight);
});

test("retries blank screenshots until a valid image is captured", async () => {
  let captures = 0;
  const client = {
    async send(method) {
      assert.equal(method, "Page.captureScreenshot");
      captures += 1;
      const buffer = captures === 1
        ? encodePng(200, 200, solidImage(200, 200, [255, 255, 255, 255]))
        : encodePng(200, 200, checkerImage(200, 200));
      return { data: buffer.toString("base64") };
    }
  };

  const result = await captureScreenshotWithValidation(client, {
    format: "png",
    fromSurface: true
  }, {
    label: "retry-test"
  });

  assert.equal(captures, 2);
  assert.equal(result.captureValidation.ok, true);
  assert.equal(result.captureValidation.retries, 1);
  assert.equal(result.captureValidation.attempts.length, 2);
  assert.equal(result.captureValidation.attempts[0].ok, false);
  assert.equal(result.captureValidation.attempts[1].ok, true);
});

test("fails after repeated blank screenshots", async () => {
  let captures = 0;
  const client = {
    async send() {
      captures += 1;
      const buffer = encodePng(200, 200, solidImage(200, 200, [255, 255, 255, 255]));
      return { data: buffer.toString("base64") };
    }
  };

  await assert.rejects(
    () => captureScreenshotWithValidation(client, {
      format: "png",
      fromSurface: true
    }, {
      label: "always-blank",
      maxAttempts: 3,
      retryDelayMs: 1
    }),
    (error) => {
      assert.equal(error.code, "BLANK_SCREENSHOT");
      assert.equal(error.captureValidation.ok, false);
      assert.equal(error.captureValidation.attempts.length, 3);
      return true;
    }
  );
  assert.equal(captures, 3);
});

test("uses the stable headless browser profile before in-process GPU fallback", () => {
  assert.equal(browserLaunchProfiles[0].name, "headless-new-no-sandbox");
  assert.equal(browserLaunchProfiles[1].name, "headless-new");
  assert.equal(browserLaunchProfiles[2].name, "headless-new-swiftshader");
});

test("blank screenshots trigger browser profile fallback", () => {
  const gpuBlank = new Error(
    "page screenshot failed blank-image validation after 3 attempts. (stage: capturing screenshot) Browser output: ContextResult::kFatalFailure"
  );
  gpuBlank.code = "BLANK_SCREENSHOT";
  const plainBlank = new Error(
    "page screenshot failed blank-image validation after 3 attempts. (stage: capturing screenshot)"
  );
  plainBlank.code = "BLANK_SCREENSHOT";

  assert.equal(isRetryableBlankCaptureError(gpuBlank), true);
  assert.equal(isRetryableBlankCaptureError(plainBlank), true);
  assert.equal(isRetryableBlankGpuCaptureError(gpuBlank), true);
  assert.equal(isRetryableBrowserLaunchError(gpuBlank), true);
  assert.equal(isRetryableBlankGpuCaptureError(plainBlank), false);
  assert.equal(isRetryableBrowserLaunchError(plainBlank), true);
});

test("freezes and restores page motion with runtime evaluation", async () => {
  const expressions = [];
  const client = {
    async send(method, params = {}) {
      assert.equal(method, "Runtime.evaluate");
      expressions.push(String(params.expression || ""));
      return { result: { value: { ok: true } } };
    }
  };

  await freezePageMotion(client);
  await restorePageMotion(client);

  assert.equal(expressions.length, 2);
  assert.match(expressions[0], /__pageShotMotionFreeze/);
  assert.match(expressions[0], /document\.getAnimations/);
  assert.match(expressions[0], /autoplay\.stop/);
  assert.match(expressions[1], /autoplay\.start/);
  assert.match(expressions[1], /style\.remove/);
});

test("stitched capture runs the post-position hook before capture", async () => {
  const events = [];
  const screenshotBuffer = encodePng(48, 48, checkerImage(48, 48));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-browser-test-"));
  const outputPath = path.join(tempDir, "stitched.png");
  const client = {
    async send(method, params = {}) {
      if (method === "Runtime.evaluate") {
        const expression = String(params.expression || "");
        const scrollMatch = expression.match(/const targetY = (\d+)/);
        if (scrollMatch) {
          events.push(`scroll:${scrollMatch[1]}`);
        }
        return { result: { value: { ok: true } } };
      }
      if (method === "Page.captureScreenshot") {
        events.push("capture");
        return { data: screenshotBuffer.toString("base64") };
      }
      throw new Error(`Unexpected method: ${method}`);
    }
  };

  try {
    await captureStitchedScreenshot(client, outputPath, {
      width: 48,
      height: 48,
      viewportHeight: 48,
      stepDelay: 0,
      dismissObstructionsBeforeSegment: false,
      hideFixedElementsAfterFirstSegment: false,
      beforeSegmentCapture: async () => {
        events.push("before");
      },
      afterSegmentPositioned: async () => {
        events.push("after");
      },
      viewportRelativeCapture: false
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  assert.deepEqual(events, ["scroll:0", "before", "scroll:0", "after", "capture"]);
});

test("accepts a trailing near-white band on the last stitched segment", () => {
  assert.equal(
    isAcceptableTrailingSegmentBlankAudit({
      status: "blank",
      fullImageNearWhite: false,
      longestNearWhiteBandStart: 21,
      longestNearWhiteBandEnd: 99
    }, 100),
    true
  );
  assert.equal(
    isAcceptableTrailingSegmentBlankAudit({
      status: "blank",
      fullImageNearWhite: true,
      longestNearWhiteBandStart: 0,
      longestNearWhiteBandEnd: 99
    }, 100),
    false
  );
});

test("accepts a trailing near-white band fully covered by the next stitched segment", () => {
  assert.equal(
    isAcceptableOverlappedTrailingSegmentBlankAudit({
      status: "blank",
      fullImageNearWhite: false,
      longestNearWhiteBandStart: 62,
      longestNearWhiteBandEnd: 99
    }, 100, 60),
    true
  );
  assert.equal(
    isAcceptableOverlappedTrailingSegmentBlankAudit({
      status: "blank",
      fullImageNearWhite: false,
      longestNearWhiteBandStart: 52,
      longestNearWhiteBandEnd: 99
    }, 100, 60),
    false
  );
});

test("accepts Shokz long-page white bands without accepting fully blank captures", () => {
  assert.equal(
    isAcceptableShokzLongPageBlankBandAudit({
      status: "blank",
      fullImageNearWhite: false,
      nearWhiteCoverage: 0.42,
      longestNearWhiteBand: 280,
      minBlankBandHeight: 120
    }),
    true
  );
  assert.equal(
    isAcceptableShokzLongPageBlankBandAudit({
      status: "blank",
      fullImageNearWhite: true,
      nearWhiteCoverage: 0.99,
      longestNearWhiteBand: 1000,
      minBlankBandHeight: 120
    }),
    false
  );
  assert.equal(
    isAcceptableShokzLongPageBlankBandAudit({
      status: "blank",
      fullImageNearWhite: true,
      nearWhiteCoverage: 0.99,
      longestNearWhiteBand: 1000,
      minBlankBandHeight: 120
    }, { allowFullImageNearWhite: true }),
    true
  );
});

test("Shokz full-page captures keep measured page height when pre-scroll height is shorter", () => {
  assert.equal(
    shouldPreserveMeasuredFullPageHeight("https://shokz.com/pages/openrunpro2", { fullPage: true }),
    true
  );
  assert.equal(
    shouldPreserveMeasuredFullPageHeight("https://shokz.com/", { fullPage: true, captureMode: "shokz-products-nav" }),
    false
  );
  assert.equal(
    shouldPreserveMeasuredFullPageHeight("https://example.com/page", { fullPage: true }),
    false
  );
});

test("stitched capture keeps the full last segment when only the tail is near-white", async () => {
  const firstSegment = encodePng(100, 100, checkerImage(100, 100));
  const lastSegment = encodePng(100, 100, trailingWhiteBandImage(100, 100, 18));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-browser-test-"));
  const outputPath = path.join(tempDir, "stitched-tail.png");
  const client = {
    async send(method, params = {}) {
      if (method === "Runtime.evaluate") {
        return { result: { value: { ok: true } } };
      }
      if (method === "Page.captureScreenshot") {
        const clipY = Number(params?.clip?.y || 0);
        return { data: (clipY >= 100 ? lastSegment : firstSegment).toString("base64") };
      }
      throw new Error(`Unexpected method: ${method}`);
    }
  };

  try {
    const result = await captureStitchedScreenshot(client, outputPath, {
      width: 100,
      height: 200,
      viewportHeight: 100,
      stepDelay: 0,
      dismissObstructionsBeforeSegment: false,
      hideFixedElementsAfterFirstSegment: false,
      viewportRelativeCapture: false
    });
    assert.equal(result.height, 200);
    assert.equal(result.captureValidation.ok, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("stitched capture accepts non-first fully near-white Shokz long-page segments", async () => {
  const contentSegment = encodePng(100, 100, checkerImage(100, 100));
  const whiteSegment = encodePng(100, 100, solidImage(100, 100, [255, 255, 255, 255]));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-browser-test-"));
  const outputPath = path.join(tempDir, "stitched-white-middle.png");
  const client = {
    async send(method, params = {}) {
      if (method === "Runtime.evaluate") {
        return { result: { value: { ok: true } } };
      }
      if (method === "Page.captureScreenshot") {
        const clipY = Number(params?.clip?.y || 0);
        return { data: (clipY === 100 ? whiteSegment : contentSegment).toString("base64") };
      }
      throw new Error(`Unexpected method: ${method}`);
    }
  };

  try {
    const result = await captureStitchedScreenshot(client, outputPath, {
      width: 100,
      height: 300,
      viewportHeight: 100,
      stepDelay: 0,
      dismissObstructionsBeforeSegment: false,
      hideFixedElementsAfterFirstSegment: false,
      acceptInteriorNearWhiteBands: true
    });
    assert.equal(result.height, 300);
    assert.equal(result.captureValidation.ok, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("stitched capture rejects fully near-white first segments", async () => {
  const contentSegment = encodePng(100, 100, checkerImage(100, 100));
  const whiteSegment = encodePng(100, 100, solidImage(100, 100, [255, 255, 255, 255]));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-browser-test-"));
  const outputPath = path.join(tempDir, "stitched-white-first.png");
  const client = {
    async send(method, params = {}) {
      if (method === "Runtime.evaluate") {
        return { result: { value: { ok: true } } };
      }
      if (method === "Page.captureScreenshot") {
        const clipY = Number(params?.clip?.y || 0);
        return { data: (clipY === 0 ? whiteSegment : contentSegment).toString("base64") };
      }
      throw new Error(`Unexpected method: ${method}`);
    }
  };

  try {
    await assert.rejects(
      () => captureStitchedScreenshot(client, outputPath, {
        width: 100,
        height: 300,
        viewportHeight: 100,
        stepDelay: 0,
        dismissObstructionsBeforeSegment: false,
        hideFixedElementsAfterFirstSegment: false,
        acceptInteriorNearWhiteBands: true
      }),
      /failed blank-image validation/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("collection tab composite keeps the long screenshot and lays variants to the right by product row", () => {
  const longBuffer = encodePng(100, 240, solidImage(100, 240, [30, 40, 50, 255]));
  const firstCard = encodePng(40, 50, solidImage(40, 50, [200, 20, 20, 255]));
  const secondCard = encodePng(40, 50, solidImage(40, 50, [20, 200, 20, 255]));
  const thirdCard = encodePng(40, 50, solidImage(40, 50, [20, 20, 200, 255]));

  const result = composeShokzCollectionTabComposite({
    longCapture: {
      buffer: longBuffer
    },
    viewport: {
      width: 100,
      height: 120
    },
    variantCaptures: [
      collectionVariantCapture(firstCard, "openfit-pro", 1, "black", 24),
      collectionVariantCapture(secondCard, "openfit-pro", 1, "white", 24),
      collectionVariantCapture(thirdCard, "openrun-pro-2", 2, "orange", 140)
    ]
  });

  const decoded = decodePng(result.buffer);

  assert.ok(decoded.width > 100);
  assert.equal(decoded.height, 240);
  assert.equal(result.layout.kind, "collection-tab-composite");
  assert.equal(result.layout.mainWidth, 100);
  assert.equal(result.layout.variantCount, 3);
  assert.equal(result.layout.productCount, 2);
  assert.equal(pixelAt(decoded, 10, 10)[0], 30);
  assert.equal(pixelAt(decoded, 214, 24)[0], 200);
  assert.equal(pixelAt(decoded, 452, 24)[1], 200);
  assert.equal(pixelAt(decoded, 214, 140)[2], 200);
});

test("collection tab composite does not accumulate row drift from natural source spacing", () => {
  const longBuffer = encodePng(100, 180, solidImage(100, 180, [30, 40, 50, 255]));
  const firstCard = encodePng(40, 50, solidImage(40, 50, [200, 20, 20, 255]));
  const secondCard = encodePng(40, 50, solidImage(40, 50, [20, 200, 20, 255]));
  const thirdCard = encodePng(40, 50, solidImage(40, 50, [20, 20, 200, 255]));

  const result = composeShokzCollectionTabComposite({
    longCapture: {
      buffer: longBuffer
    },
    viewport: {
      width: 100,
      height: 120
    },
    variantCaptures: [
      collectionVariantCapture(firstCard, "openrun-pro", 1, "black", 10),
      collectionVariantCapture(secondCard, "openrun", 2, "black", 63),
      collectionVariantCapture(thirdCard, "openmove", 3, "black", 116)
    ]
  });

  const variantRows = result.layout.variants.map((variant) => variant.rect.y);
  assert.deepEqual(variantRows, [10, 63, 116]);
});

test("home product showcase composite stacks default pages and crops hover cards", () => {
  const firstPage = encodePng(100, 80, solidImage(100, 80, [200, 20, 20, 255]));
  const secondPage = encodePng(100, 80, solidImage(100, 80, [20, 200, 20, 255]));
  const hoverPage = encodePng(100, 80, solidImage(100, 80, [20, 20, 200, 255]));

  const result = composeShokzHomeProductShowcaseComposite({
    viewport: {
      width: 100,
      height: 80
    },
    defaultCaptures: [
      homeShowcaseCapture(firstPage, 1),
      homeShowcaseCapture(secondPage, 2)
    ],
    hoverCaptures: [
      {
        ...homeShowcaseCapture(hoverPage, 2),
        interactionState: "hover",
        basePageIndex: 2,
        hoverIndex: 1,
        hoverItemKey: "openfit-pro",
        hoverItemLabel: "OpenFit Pro",
        hoverItemRect: {
          x: 10,
          y: 20,
          width: 40,
          height: 30
        }
      }
    ]
  });

  const decoded = decodePng(result.buffer);

  assert.equal(result.layout.sourceKind, "home-product-showcase");
  assert.equal(result.layout.mainStack.pageCount, 2);
  assert.equal(result.layout.variantCount, 1);
  assert.ok(decoded.width > 100);
  assert.equal(decoded.height, 180);
  assert.equal(pixelAt(decoded, 10, 10)[0], 200);
  assert.equal(pixelAt(decoded, 10, 100)[1], 200);
  assert.equal(pixelAt(decoded, 211, 115)[2], 200);
});

test("home topbar composite keeps the main screenshot and lays carousel states to the right", () => {
  const main = encodePng(100, 180, solidImage(100, 180, [30, 40, 50, 255]));
  const firstTopbar = encodePng(80, 16, solidImage(80, 16, [200, 20, 20, 255]));
  const secondTopbar = encodePng(80, 16, solidImage(80, 16, [20, 200, 20, 255]));

  const result = composeShokzHomeTopbarComposite({
    mainCapture: {
      buffer: main
    },
    viewport: {
      width: 100,
      height: 180
    },
    topbarCaptures: [
      topbarCapture(firstTopbar, 1),
      topbarCapture(secondTopbar, 2)
    ]
  });

  const decoded = decodePng(result.buffer);

  assert.equal(result.layout.sourceKind, "home-topbar");
  assert.equal(result.layout.mainWidth, 100);
  assert.equal(result.layout.variantCount, 2);
  assert.equal(result.layout.variants.length, 2);
  assert.ok(decoded.width > 100);
  assert.equal(decoded.height, 180);
  assert.equal(pixelAt(decoded, 10, 10)[0], 30);
  assert.equal(pixelAt(decoded, 124, 8)[0], 200);
  assert.equal(pixelAt(decoded, 222, 8)[1], 200);
});

test("home module composite reuses the Topbar layout for other carousel sections", () => {
  const main = encodePng(120, 200, solidImage(120, 200, [40, 50, 60, 255]));
  const firstState = encodePng(90, 50, solidImage(90, 50, [220, 30, 30, 255]));
  const secondState = encodePng(90, 50, solidImage(90, 50, [30, 220, 30, 255]));

  const result = composeShokzHomeModuleComposite({
    mainCapture: {
      buffer: main
    },
    viewport: {
      width: 120,
      height: 200
    },
    sourceKind: "home-banner",
    stateCaptures: [
      topbarCapture(firstState, 1, 64),
      topbarCapture(secondState, 2, 112)
    ]
  });

  const decoded = decodePng(result.buffer);

  assert.equal(result.layout.sourceKind, "home-banner");
  assert.equal(result.layout.mainWidth, 120);
  assert.equal(result.layout.variantCount, 2);
  assert.equal(result.layout.rowCount, 2);
  assert.equal(result.stateCaptures.length, 2);
  assert.equal(decoded.height, 200);
  assert.equal(pixelAt(decoded, 10, 10)[0], 40);
  assert.equal(pixelAt(decoded, 144, 74)[0], 220);
  assert.equal(pixelAt(decoded, 144, 122)[1], 220);
});

test("home overview composite merges module maps into one right-side timeline", () => {
  const main = encodePng(120, 220, solidImage(120, 220, [40, 50, 60, 255]));
  const topbarState = encodePng(80, 20, solidImage(80, 20, [220, 30, 30, 255]));
  const bannerState = encodePng(90, 50, solidImage(90, 50, [30, 220, 30, 255]));
  const topbarMap = composeShokzHomeModuleComposite({
    mainCapture: { buffer: main },
    viewport: { width: 120, height: 220 },
    sourceKind: "home-topbar",
    stateCaptures: [topbarCapture(topbarState, 1, 0)]
  });
  const bannerMap = composeShokzHomeModuleComposite({
    mainCapture: { buffer: main },
    viewport: { width: 120, height: 220 },
    sourceKind: "home-banner",
    stateCaptures: [topbarCapture(bannerState, 1, 72)]
  });

  const result = composeShokzHomeOverviewComposite({
    mainCapture: { buffer: main },
    viewport: { width: 120, height: 220 },
    moduleCaptures: [
      {
        buffer: topbarMap.buffer,
        composite: topbarMap.layout,
        sectionKey: "topbar",
        sectionLabel: "Topbar"
      },
      {
        buffer: bannerMap.buffer,
        composite: bannerMap.layout,
        sectionKey: "banner",
        sectionLabel: "Banner"
      }
    ]
  });

  const decoded = decodePng(result.buffer);

  assert.equal(result.layout.kind, "home-overview-composite");
  assert.equal(result.layout.mainWidth, 120);
  assert.equal(result.layout.variantCount, 2);
  assert.equal(result.layout.sectionCount, 2);
  assert.equal(result.layout.rowCount, 2);
  assert.equal(decoded.height, 220);
  assert.equal(pixelAt(decoded, 10, 10)[0], 40);
  assert.equal(pixelAt(decoded, 144, 8)[0], 220);
  assert.equal(pixelAt(decoded, 144, 84)[1], 220);
});

test("collection and comparison page capture modes prefer direct full-page clip capture", () => {
  assert.equal(shouldUseDirectFullPageClipCapture({ captureMode: "shokz-collection-page" }), true);
  assert.equal(shouldUseDirectFullPageClipCapture({ captureMode: "shokz-comparison-page" }), true);
  assert.equal(shouldUseDirectFullPageClipCapture({ captureMode: "shokz-landing-page" }), true);
  assert.equal(shouldUseDirectFullPageClipCapture({ captureMode: "shokz-collection-page", fullPage: false }), false);
  assert.equal(shouldUseDirectFullPageClipCapture({ captureMode: "shokz-products-nav" }), false);
  assert.equal(shouldUseDirectFullPageClipCapture({}), false);
});

test("fast full-page mode is limited to non-related full-page captures", () => {
  assert.equal(shouldUseFastViewportFullPageCapture({ fastFullPage: true }), true);
  assert.equal(shouldUseFastViewportFullPageCapture({ fastFullPage: true, fullPage: false }), false);
  assert.equal(shouldUseFastViewportFullPageCapture({ fastFullPage: true, captureMode: "shokz-products-nav" }), false);
  assert.equal(shouldUseFastViewportFullPageCapture({ fastFullPage: true, captureMode: "shokz-home-related-section" }), false);
  assert.equal(shouldUseFastViewportFullPageCapture({}), false);
});

test("fast full-page attempt timeout is short and configurable", () => {
  assert.equal(fastFullPageAttemptTimeoutMs({ fastFullPageTimeoutMs: 10000 }), 15000);
  assert.equal(fastFullPageAttemptTimeoutMs({ fastFullPageAttemptTimeoutMs: 12000 }), 12000);
});

test("fast full-page capture expands the viewport and captures without a clip", async () => {
  const calls = [];
  const screenshotBuffer = encodePng(120, 360, checkerImage(120, 360));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-fast-fullpage-test-"));
  const outputPath = path.join(tempDir, "fast-fullpage.png");
  const client = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === "Page.captureScreenshot") {
        assert.equal(params.clip, undefined);
        return { data: screenshotBuffer.toString("base64") };
      }
      return { result: { value: { ok: true } } };
    }
  };

  try {
    const result = await captureFastViewportFullPageScreenshot(client, outputPath, {
      width: 120,
      height: 360,
      viewport: { width: 120, height: 90, mobile: false, deviceScaleFactor: 1 }
    });
    assert.equal(result.height, 360);
    assert.ok(await fileExists(outputPath));
    const metricsCall = calls.find((call) => call.method === "Emulation.setDeviceMetricsOverride");
    assert.equal(metricsCall.params.width, 120);
    assert.equal(metricsCall.params.height, 360);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("desktop landing full-page capture uses stitched segments", () => {
  assert.equal(shouldUseStitchedLandingFullPageCapture(
    { captureMode: "shokz-landing-page", platform: "pc" },
    { width: 1920, height: 1080, mobile: false }
  ), true);
  assert.equal(shouldUseStitchedLandingFullPageCapture(
    { captureMode: "shokz-landing-page", platform: "mobile" },
    { width: 393, height: 852, mobile: true }
  ), false);
  assert.equal(shouldUseStitchedLandingFullPageCapture(
    { captureMode: "shokz-landing-page", platform: "pc", fullPage: false },
    { width: 1920, height: 1080, mobile: false }
  ), false);
  assert.equal(shouldUseStitchedLandingFullPageCapture(
    { captureMode: "shokz-collection-page", platform: "pc" },
    { width: 1920, height: 1080, mobile: false }
  ), false);
});

test("desktop landing stitched capture uses taller segments", () => {
  assert.equal(stitchedFullPageSegmentHeight(
    { stitchedFullPageSegmentHeight: 2200 },
    { width: 1920, height: 1080, mobile: false },
    6864
  ), 2200);
  assert.equal(stitchedFullPageSegmentHeight(
    { captureMode: "shokz-landing-page", platform: "pc" },
    { width: 1920, height: 1080, mobile: false },
    8213
  ), 1800);
  assert.equal(stitchedFullPageSegmentHeight(
    { captureMode: "shokz-landing-page", platform: "mobile" },
    { width: 393, height: 852, mobile: true },
    6400
  ), 852);
});

test("sports landing page uses the sports PP related-section plan", () => {
  const sportsDefinitions = shokzLandingRelatedSectionDefinitionsForPath("/pages/explore-sports-headphones");
  const openEarDefinitions = shokzLandingRelatedSectionDefinitionsForPath("/pages/explore-open-ear-headphones");

  assert.ok(sportsDefinitions.some((definition) => definition.key === "landing-sports-scenes"));
  assert.ok(sportsDefinitions.some((definition) => definition.idPart === "section-sports-headphones-product-1"));
  assert.equal(openEarDefinitions.some((definition) => definition.key === "landing-sports-scenes"), false);
});

test("landing page overview exposes only meaningful carousel modules", () => {
  const openEarDefinitions = shokzLandingRelatedSectionDefinitionsForPath("/pages/explore-open-ear-headphones");
  const sportsDefinitions = shokzLandingRelatedSectionDefinitionsForPath("/pages/explore-sports-headphones");

  assert.deepEqual(
    openEarDefinitions.filter((definition) => definition.relatedOverview).map((definition) => definition.key),
    ["landing-open-ear-benefits"]
  );
  assert.deepEqual(
    sportsDefinitions.filter((definition) => definition.relatedOverview).map((definition) => definition.key),
    ["landing-sports-scenes", "landing-sports-athletes"]
  );
});

test("sports scenes carousel captures full windows keyed by slide labels", () => {
  const sportsDefinitions = shokzLandingRelatedSectionDefinitionsForPath("/pages/explore-sports-headphones");
  const scenes = sportsDefinitions.find((definition) => definition.key === "landing-sports-scenes");
  const athletes = sportsDefinitions.find((definition) => definition.key === "landing-sports-athletes");

  assert.equal(scenes?.labeledSlideWindow, true);
  assert.equal(athletes?.labeledSlideWindow, undefined);
});

test("only comparison page capture mode uses dedicated view more expansion", () => {
  assert.equal(shouldUseDedicatedViewMoreExpansion({ captureMode: "shokz-comparison-page" }), true);
  assert.equal(shouldUseDedicatedViewMoreExpansion({ captureMode: "shokz-collection-page" }), false);
  assert.equal(shouldUseDedicatedViewMoreExpansion({ captureMode: "shokz-products-nav" }), false);
  assert.equal(shouldUseDedicatedViewMoreExpansion({}), false);
});

test("matches view more labels with icon suffixes", () => {
  assert.equal(isViewMoreLabel("View More"), true);
  assert.equal(isViewMoreLabel("View More ▼"), true);
  assert.equal(isViewMoreLabel("  View More   > "), true);
  assert.equal(isViewMoreLabel("Learn More"), false);
  assert.equal(isViewMoreLabel("View All"), false);
});

function collectionVariantCapture(buffer, productKey, productIndex, variantKey, y) {
  return {
    buffer,
    clip: {
      x: 0,
      y,
      width: 40,
      height: 50
    },
    state: {
      productKey,
      productLabel: productKey,
      productIndex,
      variantKey,
      variantLabel: variantKey,
      stateIndex: productIndex
    }
  };
}

function homeShowcaseCapture(buffer, pageIndex) {
  return {
    buffer,
    pageIndex,
    stateLabel: `Best Selling ${pageIndex}`,
    sectionState: {
      text: `Best Selling ${pageIndex}`,
      textBlocks: [],
      images: []
    }
  };
}

function topbarCapture(buffer, pageIndex, y = 0) {
  return {
    buffer,
    pageIndex,
    stateIndex: pageIndex,
    stateLabel: `Topbar ${pageIndex}`,
    coverageKey: `topbar-${pageIndex}`,
    sectionState: {
      text: `Topbar ${pageIndex}`,
      textBlocks: [],
      images: []
    },
    clip: {
      x: 0,
      y,
      width: 80,
      height: 16
    }
  };
}

function pixelAt(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return image.rgba.slice(offset, offset + 4);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function solidImage(width, height, color) {
  const rgba = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba.set(color, offset);
  }
  return rgba;
}

function checkerImage(width, height) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = (x + y) % 2 === 0 ? 0 : 255;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}

function whiteBandImage(width, height, startY, endY) {
  const rgba = brightDetailedImage(width, height);
  for (let y = Math.max(0, startY); y < Math.min(height, endY); y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      rgba[offset] = 255;
      rgba[offset + 1] = 255;
      rgba[offset + 2] = 255;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}

function trailingWhiteBandImage(width, height, preservedRows) {
  return whiteBandImage(width, height, Math.max(0, preservedRows), height);
}

function brightDetailedImage(width, height) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      let value = 252;
      if (y % 18 === 0 || x % 24 === 0) {
        value = 210;
      }
      if ((x + y) % 37 === 0) {
        value = 96;
      }
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}
