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
  isViewMoreLabel,
  composeShokzCollectionTabComposite,
  composeShokzHomeModuleComposite,
  composeShokzHomeOverviewComposite,
  composeShokzHomeTopbarComposite,
  composeShokzHomeProductShowcaseComposite,
  shouldUseDedicatedViewMoreExpansion,
  shouldUseDirectFullPageClipCapture
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
        const scrollMatch = expression.match(/window\.scrollTo\(0, (\d+)\)/);
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
  assert.equal(decoded.height, 198);
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
  assert.equal(shouldUseDirectFullPageClipCapture({ captureMode: "shokz-products-nav" }), false);
  assert.equal(shouldUseDirectFullPageClipCapture({}), false);
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
