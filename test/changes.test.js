import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareSnapshots, diffPngImages } from "../src/changes.js";
import { encodePng } from "../src/png.js";

test("matches the same section position when tab copy changes", async () => {
  const snapshots = [
    snapshot("snap-1", "2026-05-02T10:00:00.000Z", [{
      file: "missing-before.png",
      sectionKey: "product-showcase",
      sectionLabel: "产品橱窗",
      isDefaultState: true,
      stateIndex: 1,
      tabIndex: 1,
      tabLabel: "Best Selling",
      label: "Best Selling 1",
      sectionState: {
        text: "Best Selling",
        textBlocks: [{ text: "Best Selling", x: 10, y: 8, width: 120, height: 24 }]
      }
    }]),
    snapshot("snap-2", "2026-05-03T10:00:00.000Z", [{
      file: "missing-after.png",
      sectionKey: "product-showcase",
      sectionLabel: "产品橱窗",
      isDefaultState: true,
      stateIndex: 1,
      tabIndex: 1,
      tabLabel: "Best Sell",
      label: "Best Sell 1",
      sectionState: {
        text: "Best Sell",
        textBlocks: [{ text: "Best Sell", x: 10, y: 8, width: 104, height: 24 }]
      }
    }])
  ];

  const changes = await compareSnapshots(snapshots, { writeDiffImages: false });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, "text");
  assert.equal(changes[0].location.tabLabel, "Best Sell");
  assert.equal(changes[0].textChange.beforeFragment, "Best Selling");
  assert.equal(changes[0].textChange.afterFragment, "Best Sell");
  assert.equal(changes[0].createdAt, "2026-05-03T10:00:00.000Z");
});

test("prefers tab and page identity when state index shifts", async () => {
  const snapshots = [
    snapshot("snap-1", "2026-05-02T10:00:00.000Z", [{
      file: "missing-before.png",
      sectionKey: "product-showcase",
      sectionLabel: "产品橱窗",
      stateIndex: 2,
      tabIndex: 1,
      tabLabel: "Best Selling",
      pageIndex: 2,
      label: "Best Selling 2",
      sectionState: {
        text: "OpenRun Pro 2",
        textBlocks: [{ text: "OpenRun Pro 2", x: 20, y: 24, width: 160, height: 28 }]
      }
    }]),
    snapshot("snap-2", "2026-05-03T10:00:00.000Z", [{
      file: "missing-after.png",
      sectionKey: "product-showcase",
      sectionLabel: "产品橱窗",
      stateIndex: 5,
      tabIndex: 1,
      tabLabel: "Best Selling",
      pageIndex: 2,
      label: "Best Selling 2",
      sectionState: {
        text: "OpenRun Pro 2 New",
        textBlocks: [{ text: "OpenRun Pro 2 New", x: 20, y: 24, width: 188, height: 28 }]
      }
    }])
  ];

  const changes = await compareSnapshots(snapshots, { writeDiffImages: false });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].location.tabLabel, "Best Selling");
  assert.equal(changes[0].location.pageIndex, 2);
  assert.equal(changes[0].textChange.beforeFragment, "OpenRun Pro 2");
  assert.equal(changes[0].textChange.afterFragment, "OpenRun Pro 2 New");
});

test("detects visual regions and filters tiny noise", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-diff-"));
  const beforePath = path.join(tempDir, "before.png");
  const afterPath = path.join(tempDir, "after.png");
  const noisePath = path.join(tempDir, "noise.png");

  const before = solidImage(20, 20, [255, 255, 255, 255]);
  const after = solidImage(20, 20, [255, 255, 255, 255]);
  fillRect(after, 20, 8, 6, 6, 5, [220, 0, 0, 255]);
  const noise = solidImage(20, 20, [255, 255, 255, 255]);
  fillRect(noise, 20, 1, 1, 1, 1, [0, 0, 0, 255]);

  await fs.writeFile(beforePath, encodePng(20, 20, before));
  await fs.writeFile(afterPath, encodePng(20, 20, after));
  await fs.writeFile(noisePath, encodePng(20, 20, noise));

  const diff = await diffPngImages(beforePath, afterPath, { writeDiffImages: false });
  assert.equal(diff.changed, true);
  assert.equal(diff.regions.length, 1);
  assert.ok(diff.regions[0].x <= 8);
  assert.ok(diff.regions[0].y <= 6);
  assert.ok(diff.regions[0].x + diff.regions[0].width >= 14);
  assert.ok(diff.regions[0].y + diff.regions[0].height >= 11);

  const noiseDiff = await diffPngImages(beforePath, noisePath, {
    writeDiffImages: false,
    minRegionPixels: 2
  });
  assert.equal(noiseDiff.changed, false);
});

test("ignores banner pixel drift when copy and image assets are unchanged", async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-banner-drift-"));
  const beforeFile = "2026-05-03/example-com/banner-before.png";
  const afterFile = "2026-05-03/example-com/banner-after.png";

  const beforeImage = solidImage(100, 50, [255, 255, 255, 255]);
  const afterImage = solidImage(100, 50, [255, 255, 255, 255]);
  fillRect(afterImage, 100, 24, 14, 20, 10, [220, 220, 220, 255]);
  await writeArchiveImage(archiveRoot, beforeFile, 100, 50, beforeImage);
  await writeArchiveImage(archiveRoot, afterFile, 100, 50, afterImage);

  const changes = await compareSnapshots([
    snapshot("snap-1", "2026-05-03T08:00:00.000Z", [bannerShot(beforeFile)]),
    snapshot("snap-2", "2026-05-03T09:00:00.000Z", [bannerShot(afterFile)])
  ], { archiveRoot, writeDiffImages: false });

  assert.equal(changes.length, 0);
});

test("keeps banner image asset changes even when copy is unchanged", async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-banner-image-"));
  const beforeFile = "2026-05-03/example-com/banner-before.png";
  const afterFile = "2026-05-03/example-com/banner-after.png";

  const beforeImage = solidImage(100, 50, [255, 255, 255, 255]);
  const afterImage = solidImage(100, 50, [255, 255, 255, 255]);
  fillRect(afterImage, 100, 24, 14, 20, 10, [220, 220, 220, 255]);
  await writeArchiveImage(archiveRoot, beforeFile, 100, 50, beforeImage);
  await writeArchiveImage(archiveRoot, afterFile, 100, 50, afterImage);

  const changes = await compareSnapshots([
    snapshot("snap-1", "2026-05-03T08:00:00.000Z", [
      bannerShot(beforeFile, { bannerState: bannerState({ images: ["https://cdn.example.com/openrun-old.webp"] }) })
    ]),
    snapshot("snap-2", "2026-05-03T09:00:00.000Z", [
      bannerShot(afterFile, { bannerState: bannerState({ images: ["https://cdn.example.com/openrun-new.webp"] }) })
    ])
  ], { archiveRoot, writeDiffImages: false });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, "visual");
  assert.ok(changes[0].visualChange.signals.some((signal) => signal.type === "image"));
});

test("keeps banner layout moves for stable copy", async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-banner-layout-"));
  const beforeFile = "2026-05-03/example-com/banner-before.png";
  const afterFile = "2026-05-03/example-com/banner-after.png";

  const beforeImage = solidImage(200, 100, [255, 255, 255, 255]);
  const afterImage = solidImage(200, 100, [255, 255, 255, 255]);
  fillRect(beforeImage, 200, 10, 12, 60, 18, [20, 20, 20, 255]);
  fillRect(afterImage, 200, 145, 12, 60, 18, [20, 20, 20, 255]);
  await writeArchiveImage(archiveRoot, beforeFile, 200, 100, beforeImage);
  await writeArchiveImage(archiveRoot, afterFile, 200, 100, afterImage);

  const changes = await compareSnapshots([
    snapshot("snap-1", "2026-05-03T08:00:00.000Z", [
      bannerShot(beforeFile, {
        width: 200,
        height: 100,
        bannerState: bannerState({
          textBlocks: [{ text: "Shop Now", x: 10, y: 12, width: 60, height: 18 }]
        })
      })
    ]),
    snapshot("snap-2", "2026-05-03T09:00:00.000Z", [
      bannerShot(afterFile, {
        width: 200,
        height: 100,
        bannerState: bannerState({
          textBlocks: [{ text: "Shop Now", x: 145, y: 12, width: 60, height: 18 }]
        })
      })
    ])
  ], { archiveRoot, writeDiffImages: false });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, "visual");
  assert.ok(changes[0].visualChange.signals.some((signal) => signal.type === "layout"));
});

test("labels media visual diffs with the overlapping item", async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-media-item-"));
  const beforeFile = "2026-05-03/example-com/media-before.png";
  const afterFile = "2026-05-03/example-com/media-after.png";

  const beforeImage = solidImage(160, 100, [255, 255, 255, 255]);
  const afterImage = solidImage(160, 100, [255, 255, 255, 255]);
  fillRect(beforeImage, 160, 35, 35, 42, 24, [40, 80, 160, 255]);
  fillRect(afterImage, 160, 35, 35, 42, 24, [220, 40, 40, 255]);
  await writeArchiveImage(archiveRoot, beforeFile, 160, 100, beforeImage);
  await writeArchiveImage(archiveRoot, afterFile, 160, 100, afterImage);

  const item = {
    mediaItemId: "awards|pos:3|img:toms-guide",
    key: "awards|pos:3|img:toms-guide",
    label: "toms guide",
    image: "https://cdn.example.com/toms-guide.webp",
    imageFamily: "toms-guide",
    rect: { x: 30, y: 30, width: 55, height: 35 }
  };
  const relatedShot = (file) => ({
    file,
    imageUrl: `/archive/${file}`,
    width: 160,
    height: 100,
    kind: "tab-carousel",
    sectionKey: "media",
    sectionLabel: "媒体区",
    tabLabel: "Sports partnership & Awards",
    tabIndex: 2,
    pageIndex: 1,
    stateIndex: 1,
    stateLabel: "Sports partnership & Awards 1",
    label: "Sports partnership & Awards 1",
    visibleItems: [item],
    itemRects: [{ mediaItemId: item.mediaItemId, key: item.key, label: item.label, rect: item.rect }],
    sectionState: {
      text: "Sports partnership & Awards",
      images: [item.image],
      visibleItems: [item],
      itemRects: [{ mediaItemId: item.mediaItemId, key: item.key, label: item.label, rect: item.rect }]
    }
  });

  const changes = await compareSnapshots([
    snapshot("snap-1", "2026-05-03T08:00:00.000Z", [relatedShot(beforeFile)]),
    snapshot("snap-2", "2026-05-03T09:00:00.000Z", [relatedShot(afterFile)])
  ], { archiveRoot, writeDiffImages: false });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].location.sectionKey, "media");
  assert.equal(changes[0].location.tabLabel, "Sports partnership & Awards");
  assert.ok(changes[0].visualChange.signals.some((signal) =>
    signal.type === "media-item" &&
    signal.mediaItemId === item.mediaItemId &&
    signal.mediaItemLabel === "toms guide"
  ));
  assert.ok(changes[0].visualChange.regions.some((region) =>
    region.source === "media-item" &&
    region.mediaItemId === item.mediaItemId &&
    region.x === item.rect.x &&
    region.y === item.rect.y
  ));
});

test("backfill writes diff artifacts without rewriting archived screenshots", async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-archive-"));
  const folder = path.join(archiveRoot, "2026-05-03", "example-com");
  await fs.mkdir(folder, { recursive: true });
  const beforeFile = "2026-05-03/example-com/before.png";
  const afterFile = "2026-05-03/example-com/after.png";
  const beforePath = path.join(archiveRoot, beforeFile);
  const afterPath = path.join(archiveRoot, afterFile);

  const beforeBuffer = encodePng(12, 12, solidImage(12, 12, [255, 255, 255, 255]));
  const afterImage = solidImage(12, 12, [255, 255, 255, 255]);
  fillRect(afterImage, 12, 3, 3, 6, 6, [0, 0, 0, 255]);
  const afterBuffer = encodePng(12, 12, afterImage);
  await fs.writeFile(beforePath, beforeBuffer);
  await fs.writeFile(afterPath, afterBuffer);

  const changes = await compareSnapshots([
    snapshot("snap-1", "2026-05-03T08:00:00.000Z", [], beforeFile),
    snapshot("snap-2", "2026-05-03T09:00:00.000Z", [], afterFile)
  ], { archiveRoot });

  assert.equal(changes.length, 1);
  assert.ok(changes[0].visualChange.diffFile.startsWith("diffs/"));
  assert.deepEqual(await fs.readFile(beforePath), beforeBuffer);
  assert.deepEqual(await fs.readFile(afterPath), afterBuffer);
});

function snapshot(id, capturedAt, relatedShots = [], file = `${id}.png`) {
  return {
    id,
    url: "https://example.com/",
    targetId: "home",
    targetLabel: "Example",
    displayUrl: "Example",
    capturedAt,
    file,
    imageUrl: `/archive/${file}`,
    width: 120,
    height: 80,
    devicePresetId: "pc",
    deviceName: "PC",
    relatedShots
  };
}

async function writeArchiveImage(archiveRoot, relativeFile, width, height, rgba) {
  const filePath = path.join(archiveRoot, relativeFile);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, encodePng(width, height, rgba));
}

function bannerShot(file, overrides = {}) {
  return {
    kind: "banner",
    sectionKey: "banner",
    sectionLabel: "Banner",
    sectionTitle: "Banner",
    label: "Slide 2",
    file,
    imageUrl: `/archive/${file}`,
    width: overrides.width || 100,
    height: overrides.height || 50,
    bannerIndex: 2,
    stateIndex: 2,
    stateCount: 3,
    bannerState: bannerState(),
    ...overrides
  };
}

function bannerState(overrides = {}) {
  return {
    text: "OpenRun Pro 2 Shop Now",
    images: ["https://cdn.example.com/openrun-pro-2.webp"],
    textBlocks: [],
    ...overrides
  };
}

function solidImage(width, height, color) {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < rgba.length; index += 4) {
    rgba[index] = color[0];
    rgba[index + 1] = color[1];
    rgba[index + 2] = color[2];
    rgba[index + 3] = color[3];
  }
  return rgba;
}

function fillRect(rgba, width, x, y, rectWidth, rectHeight, color) {
  for (let row = y; row < y + rectHeight; row += 1) {
    for (let col = x; col < x + rectWidth; col += 1) {
      const offset = (row * width + col) * 4;
      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = color[3];
    }
  }
}
