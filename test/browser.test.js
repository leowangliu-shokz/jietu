import assert from "node:assert/strict";
import test from "node:test";
import { imageQualityAuditForBuffer } from "../src/browser.js";
import { encodePng } from "../src/png.js";

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
