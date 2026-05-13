import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { __testOnly, blankImageAuditForBuffer, captureScreenshotWithValidation, imageQualityAuditForBuffer } from "../src/browser.js";
import { encodePng } from "../src/png.js";

const {
  captureStitchedScreenshot,
  freezePageMotion,
  restorePageMotion,
  isAcceptableTrailingSegmentBlankAudit,
  isViewMoreLabel,
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

test("collection page capture mode prefers direct full-page clip capture", () => {
  assert.equal(shouldUseDirectFullPageClipCapture({ captureMode: "shokz-collection-page" }), true);
  assert.equal(shouldUseDirectFullPageClipCapture({ captureMode: "shokz-products-nav" }), false);
  assert.equal(shouldUseDirectFullPageClipCapture({}), false);
});

test("matches view more labels with icon suffixes", () => {
  assert.equal(isViewMoreLabel("View More"), true);
  assert.equal(isViewMoreLabel("View More ▼"), true);
  assert.equal(isViewMoreLabel("  View More   > "), true);
  assert.equal(isViewMoreLabel("Learn More"), false);
  assert.equal(isViewMoreLabel("View All"), false);
});

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
