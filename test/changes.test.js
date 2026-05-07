import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareSnapshots, diffPngImages, judgeHumanVisibleChange } from "../src/changes.js";
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

test("matches product showcase hover by product identity", async () => {
  const before = productHoverShot("hover-before.png", {
    stateIndex: 4,
    hoverItemKey: "/products/openfit-pro",
    hoverItemLabel: "OPENFIT PRO",
    sectionState: { text: "OPENFIT PRO hover old" }
  });
  const after = productHoverShot("hover-after.png", {
    stateIndex: 9,
    hoverItemKey: "/products/openfit-pro",
    hoverItemLabel: "OPENFIT PRO",
    sectionState: { text: "OPENFIT PRO hover new" }
  });

  const changes = await compareSnapshots([
    snapshot("snap-1", "2026-05-03T08:00:00.000Z", [before]),
    snapshot("snap-2", "2026-05-03T09:00:00.000Z", [after])
  ], { writeDiffImages: false });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].location.interactionState, "hover");
  assert.equal(changes[0].location.hoverItemKey, "/products/openfit-pro");
  assert.equal(changes[0].location.hoverItemLabel, "OPENFIT PRO");
  assert.match(changes[0].comparisonKey, /product-showcase:tab:1:hover:\/products\/openfit-pro$/);
  assert.equal(changes[0].textChange.before, "OPENFIT PRO hover old");
  assert.equal(changes[0].textChange.after, "OPENFIT PRO hover new");
});

test("keeps primary and secondary navigation hover positions separate", async () => {
  const changes = await compareSnapshots([
    navigationSnapshot("nav-1", "2026-05-03T08:00:00.000Z", [
      navigationShot("nav-primary-before.png", {
        navigationLevel: "primary",
        hoverItemKey: "primary:1",
        hoverItemLabel: "Products",
        hoverIndex: 0,
        sectionState: { text: "Products menu old" }
      }),
      navigationShot("nav-secondary-before.png", {
        navigationLevel: "secondary",
        hoverItemKey: "secondary:1:2",
        hoverItemLabel: "Workout & Lifestyle Earbuds",
        hoverIndex: 2,
        sectionState: { text: "Workout earbuds old" }
      })
    ]),
    navigationSnapshot("nav-2", "2026-05-03T09:00:00.000Z", [
      navigationShot("nav-primary-after.png", {
        navigationLevel: "primary",
        hoverItemKey: "primary:1",
        hoverItemLabel: "Products",
        hoverIndex: 0,
        sectionState: { text: "Products menu new" }
      }),
      navigationShot("nav-secondary-after.png", {
        navigationLevel: "secondary",
        hoverItemKey: "secondary:1:2",
        hoverItemLabel: "Workout & Lifestyle Earbuds",
        hoverIndex: 2,
        sectionState: { text: "Workout earbuds new" }
      })
    ])
  ], { writeDiffImages: false });

  assert.equal(changes.length, 2);
  assert.deepEqual(
    changes.map((change) => change.location.navigationLevel).sort(),
    ["primary", "secondary"]
  );
  assert.ok(changes.some((change) => /navigation:tab:1:hover:primary:1$/.test(change.comparisonKey)));
  assert.ok(changes.some((change) => /navigation:tab:1:hover:secondary:1:2$/.test(change.comparisonKey)));
});

test("marks product showcase hover visual changes on the hovered card", async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-product-hover-"));
  const beforeFile = "2026-05-03/example-com/product-hover-before.png";
  const afterFile = "2026-05-03/example-com/product-hover-after.png";
  const beforeImage = solidImage(120, 80, [255, 255, 255, 255]);
  const afterImage = solidImage(120, 80, [255, 255, 255, 255]);
  fillRect(afterImage, 120, 38, 22, 16, 16, [210, 40, 40, 255]);
  await writeArchiveImage(archiveRoot, beforeFile, 120, 80, beforeImage);
  await writeArchiveImage(archiveRoot, afterFile, 120, 80, afterImage);

  const rect = { x: 30, y: 18, width: 40, height: 32 };
  const changes = await compareSnapshots([
    snapshot("snap-1", "2026-05-03T08:00:00.000Z", [
      productHoverShot(beforeFile, { hoverItemRect: rect })
    ]),
    snapshot("snap-2", "2026-05-03T09:00:00.000Z", [
      productHoverShot(afterFile, { hoverItemRect: rect })
    ])
  ], { archiveRoot, writeDiffImages: false });

  assert.equal(changes.length, 1);
  assert.ok(changes[0].visualChange.signals.some((signal) =>
    signal.type === "product-hover-item" &&
    signal.hoverItemLabel === "OPENFIT PRO"
  ));
  assert.ok(changes[0].visualChange.regions.some((region) =>
    region.source === "product-hover-item" &&
    region.hoverItemLabel === "OPENFIT PRO" &&
    region.x === rect.x &&
    region.y === rect.y
  ));
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

test("keeps large media visual diffs when stable code exceeds threshold", async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-media-item-"));
  const beforeFile = "2026-05-03/example-com/media-before.png";
  const afterFile = "2026-05-03/example-com/media-after.png";

  const beforeImage = solidImage(160, 100, [255, 255, 255, 255]);
  const afterImage = solidImage(160, 100, [255, 255, 255, 255]);
  fillRect(beforeImage, 160, 35, 35, 42, 24, [40, 80, 160, 255]);
  fillRect(afterImage, 160, 35, 35, 42, 24, [220, 40, 40, 255]);
  await writeArchiveImage(archiveRoot, beforeFile, 160, 100, beforeImage);
  await writeArchiveImage(archiveRoot, afterFile, 160, 100, afterImage);

  const item = mediaItem();

  const changes = await compareSnapshots([
    snapshot("snap-1", "2026-05-03T08:00:00.000Z", [mediaShot(beforeFile, [item])]),
    snapshot("snap-2", "2026-05-03T09:00:00.000Z", [mediaShot(afterFile, [item])])
  ], { archiveRoot, writeDiffImages: false });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].location.sectionKey, "media");
  assert.equal(changes[0].location.tabLabel, "Sports partnership & Awards");
  assert.ok(changes[0].visualChange.signals.some((signal) => signal.type === "large-visual"));
  assert.ok(!changes[0].visualChange.signals.some((signal) => signal.type === "media-item"));
});

test("ignores media pixel overlap when code metadata is stable below visual threshold", async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-media-drift-"));
  const beforeFile = "2026-05-03/example-com/media-before.png";
  const afterFile = "2026-05-03/example-com/media-after.png";
  const item = mediaItem();
  const beforeImage = solidImage(160, 100, [255, 255, 255, 255]);
  const afterImage = solidImage(160, 100, [255, 255, 255, 255]);
  fillRect(afterImage, 160, 40, 40, 8, 8, [220, 40, 40, 255]);
  await writeArchiveImage(archiveRoot, beforeFile, 160, 100, beforeImage);
  await writeArchiveImage(archiveRoot, afterFile, 160, 100, afterImage);

  const changes = await compareSnapshots([
    snapshot("snap-1", "2026-05-03T08:00:00.000Z", [mediaShot(beforeFile, [item])]),
    snapshot("snap-2", "2026-05-03T09:00:00.000Z", [mediaShot(afterFile, [item])])
  ], { archiveRoot, writeDiffImages: false });

  assert.equal(changes.length, 0);
});

test("keeps media image asset changes from code metadata", async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-media-image-"));
  const beforeFile = "2026-05-03/example-com/media-before.png";
  const afterFile = "2026-05-03/example-com/media-after.png";
  const beforeItem = mediaItem({ imageFamily: "toms-guide" });
  const afterItem = mediaItem({ imageFamily: "wired-award" });
  const beforeImage = solidImage(160, 100, [255, 255, 255, 255]);
  const afterImage = solidImage(160, 100, [255, 255, 255, 255]);
  fillRect(afterImage, 160, 40, 40, 8, 8, [220, 40, 40, 255]);
  await writeArchiveImage(archiveRoot, beforeFile, 160, 100, beforeImage);
  await writeArchiveImage(archiveRoot, afterFile, 160, 100, afterImage);

  const changes = await compareSnapshots([
    snapshot("snap-1", "2026-05-03T08:00:00.000Z", [mediaShot(beforeFile, [beforeItem])]),
    snapshot("snap-2", "2026-05-03T09:00:00.000Z", [mediaShot(afterFile, [afterItem])])
  ], { archiveRoot, writeDiffImages: false });

  assert.equal(changes.length, 1);
  assert.ok(changes[0].visualChange.signals.some((signal) =>
    signal.type === "media-item" &&
    signal.reason === "image asset changed" &&
    signal.mediaItemLabel === "wired award"
  ));
});

test("keeps media visible window membership changes", async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-media-window-"));
  const beforeFile = "2026-05-03/example-com/media-before.png";
  const afterFile = "2026-05-03/example-com/media-after.png";
  const beforeItem = mediaItem({ position: 3, imageFamily: "toms-guide" });
  const afterItem = mediaItem({ position: 4, imageFamily: "wired-award" });
  const beforeImage = solidImage(160, 100, [255, 255, 255, 255]);
  const afterImage = solidImage(160, 100, [255, 255, 255, 255]);
  fillRect(afterImage, 160, 40, 40, 8, 8, [220, 40, 40, 255]);
  await writeArchiveImage(archiveRoot, beforeFile, 160, 100, beforeImage);
  await writeArchiveImage(archiveRoot, afterFile, 160, 100, afterImage);

  const changes = await compareSnapshots([
    snapshot("snap-1", "2026-05-03T08:00:00.000Z", [mediaShot(beforeFile, [beforeItem])]),
    snapshot("snap-2", "2026-05-03T09:00:00.000Z", [mediaShot(afterFile, [afterItem])])
  ], { archiveRoot, writeDiffImages: false });

  assert.equal(changes.length, 1);
  assert.ok(changes[0].visualChange.signals.some((signal) =>
    signal.type === "media-item" &&
    signal.reason === "added or moved into this window"
  ));
});

test("keeps media item order changes from code metadata", async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-media-order-"));
  const beforeFile = "2026-05-03/example-com/media-before.png";
  const afterFile = "2026-05-03/example-com/media-after.png";
  const first = mediaItem({ position: null, imageFamily: "toms-guide" });
  const second = mediaItem({ position: null, imageFamily: "wired-award" });
  const beforeImage = solidImage(160, 100, [255, 255, 255, 255]);
  const afterImage = solidImage(160, 100, [255, 255, 255, 255]);
  fillRect(afterImage, 160, 40, 40, 8, 8, [220, 40, 40, 255]);
  await writeArchiveImage(archiveRoot, beforeFile, 160, 100, beforeImage);
  await writeArchiveImage(archiveRoot, afterFile, 160, 100, afterImage);

  const changes = await compareSnapshots([
    snapshot("snap-1", "2026-05-03T08:00:00.000Z", [mediaShot(beforeFile, [first, second])]),
    snapshot("snap-2", "2026-05-03T09:00:00.000Z", [mediaShot(afterFile, [second, first])])
  ], { archiveRoot, writeDiffImages: false });

  assert.equal(changes.length, 1);
  assert.ok(changes[0].visualChange.signals.some((signal) =>
    signal.type === "media-item" &&
    signal.reason === "item order changed"
  ));
});

test("keeps media item rect moves from code metadata", async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-media-rect-"));
  const beforeFile = "2026-05-03/example-com/media-before.png";
  const afterFile = "2026-05-03/example-com/media-after.png";
  const beforeItem = mediaItem({ rect: { x: 30, y: 30, width: 55, height: 35 } });
  const afterItem = mediaItem({ rect: { x: 70, y: 30, width: 55, height: 35 } });
  const beforeImage = solidImage(160, 100, [255, 255, 255, 255]);
  const afterImage = solidImage(160, 100, [255, 255, 255, 255]);
  fillRect(beforeImage, 160, 35, 35, 10, 10, [40, 80, 160, 255]);
  fillRect(afterImage, 160, 75, 35, 10, 10, [40, 80, 160, 255]);
  await writeArchiveImage(archiveRoot, beforeFile, 160, 100, beforeImage);
  await writeArchiveImage(archiveRoot, afterFile, 160, 100, afterImage);

  const changes = await compareSnapshots([
    snapshot("snap-1", "2026-05-03T08:00:00.000Z", [mediaShot(beforeFile, [beforeItem])]),
    snapshot("snap-2", "2026-05-03T09:00:00.000Z", [mediaShot(afterFile, [afterItem])])
  ], { archiveRoot, writeDiffImages: false });

  assert.equal(changes.length, 1);
  assert.ok(changes[0].visualChange.signals.some((signal) =>
    signal.type === "media-item" &&
    signal.reason === "item rect changed"
  ));
});

test("suppresses one pixel alignment drift when code metadata is stable", async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-media-align-"));
  const beforeFile = "2026-05-03/example-com/media-before.png";
  const afterFile = "2026-05-03/example-com/media-after.png";
  const beforeImage = stripedImage(100, 80, 20, 10);
  const afterImage = shiftImage(beforeImage, 100, 80, 1, 0, [255, 255, 255, 255]);
  await writeArchiveImage(archiveRoot, beforeFile, 100, 80, beforeImage);
  await writeArchiveImage(archiveRoot, afterFile, 100, 80, afterImage);

  const diff = await diffPngImages(
    path.join(archiveRoot, beforeFile),
    path.join(archiveRoot, afterFile)
  );
  const item = mediaItem({ rect: { x: 0, y: 0, width: 100, height: 80 } });
  const judgment = judgeHumanVisibleChange(
    mediaShot(beforeFile, [item], { width: 100, height: 80 }),
    mediaShot(afterFile, [item], { width: 100, height: 80 }),
    diff
  );

  assert.equal(diff.alignmentDrift.likely, true);
  assert.equal(judgment.changed, false);
  assert.equal(judgment.kind, "suppressed-drift");
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

function navigationSnapshot(id, capturedAt, relatedShots = [], file = `${id}.png`) {
  return {
    ...snapshot(id, capturedAt, relatedShots, file),
    url: "https://shokz.com/",
    targetId: "shokz-products-nav",
    targetLabel: "https://shokz.com/（导航栏）",
    displayUrl: "https://shokz.com/（导航栏）"
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

function mediaShot(file, items, overrides = {}) {
  const itemRects = items.map((item) => ({
    mediaItemId: item.mediaItemId,
    key: item.key,
    label: item.label,
    rect: item.rect
  }));
  return {
    kind: "tab-carousel",
    sectionKey: "media",
    sectionLabel: "Media",
    tabLabel: "Sports partnership & Awards",
    tabIndex: 2,
    pageIndex: 1,
    stateIndex: 1,
    stateLabel: "Sports partnership & Awards 1",
    label: "Sports partnership & Awards 1",
    file,
    imageUrl: `/archive/${file}`,
    width: overrides.width || 160,
    height: overrides.height || 100,
    visibleItems: items,
    itemRects,
    sectionState: {
      text: "Sports partnership & Awards",
      images: items.map((item) => item.image),
      visibleItems: items,
      itemRects,
      ...(overrides.sectionState || {})
    },
    ...overrides
  };
}

function productHoverShot(file, overrides = {}) {
  const hoverItemKey = overrides.hoverItemKey || "/products/openfit-pro";
  const hoverItemLabel = overrides.hoverItemLabel || "OPENFIT PRO";
  const hoverItemRect = overrides.hoverItemRect || { x: 30, y: 18, width: 40, height: 32 };
  const sectionState = {
    text: "OPENFIT PRO hover",
    images: ["https://cdn.example.com/openfit-hover.webp"],
    interactionState: "hover",
    hoverItemKey,
    hoverItemLabel,
    hoverItemRect,
    hoveredProduct: {
      key: hoverItemKey,
      label: hoverItemLabel,
      href: hoverItemKey,
      image: "https://cdn.example.com/openfit-hover.webp",
      rect: hoverItemRect
    },
    ...(overrides.sectionState || {})
  };
  return {
    kind: "product-hover",
    sectionKey: "product-showcase",
    sectionLabel: "Product Showcase",
    sectionTitle: "Product Showcase",
    tabLabel: "Best Selling",
    tabIndex: 1,
    pageIndex: 1,
    basePageIndex: 1,
    hoverIndex: 1,
    stateIndex: 4,
    stateLabel: `Hover ${hoverItemLabel}`,
    label: `Hover ${hoverItemLabel}`,
    interactionState: "hover",
    hoverItemKey,
    hoverItemLabel,
    hoverItemRect,
    file,
    imageUrl: `/archive/${file}`,
    width: overrides.width || 120,
    height: overrides.height || 80,
    sectionState,
    ...overrides,
    sectionState
  };
}

function navigationShot(file, overrides = {}) {
  const navigationLevel = overrides.navigationLevel || "secondary";
  const hoverItemKey = overrides.hoverItemKey || "secondary:1:1";
  const hoverItemLabel = overrides.hoverItemLabel || "Sports Headphones";
  const hoverIndex = Object.hasOwn(overrides, "hoverIndex") ? overrides.hoverIndex : 1;
  const sectionState = {
    text: "Navigation hover",
    textBlocks: [{ text: "Navigation hover", x: 10, y: 10, width: 120, height: 20 }],
    images: [],
    interactionState: "hover",
    navigationLevel,
    topLevelLabel: "Products",
    topLevelIndex: 1,
    hoverItemKey,
    hoverItemLabel,
    hoverIndex,
    ...(overrides.sectionState || {})
  };
  return {
    kind: `navigation-${navigationLevel}`,
    sectionKey: "navigation",
    sectionLabel: "Navigation",
    sectionTitle: "Navigation hierarchy",
    tabLabel: "Products",
    tabIndex: 1,
    stateIndex: overrides.stateIndex || hoverIndex + 1,
    stateLabel: hoverItemLabel,
    label: hoverItemLabel,
    interactionState: "hover",
    navigationLevel,
    topLevelLabel: "Products",
    topLevelIndex: 1,
    hoverItemKey,
    hoverItemLabel,
    hoverIndex,
    file,
    imageUrl: `/archive/${file}`,
    width: overrides.width || 120,
    height: overrides.height || 80,
    sectionState,
    ...overrides,
    sectionState
  };
}

function mediaItem(overrides = {}) {
  const position = Object.hasOwn(overrides, "position") ? overrides.position : 3;
  const imageFamily = overrides.imageFamily || "toms-guide";
  const label = overrides.label || imageFamily.replace(/[-_]+/g, " ");
  const rect = overrides.rect || { x: 30, y: 30, width: 55, height: 35 };
  const key = overrides.key || `awards|pos:${position}|img:${imageFamily}|label:${label}`;
  return {
    mediaItemId: overrides.mediaItemId || key,
    key,
    label,
    text: overrides.text || "",
    image: overrides.image || `https://cdn.example.com/${imageFamily}.webp`,
    imageFamily,
    position,
    positionTotal: overrides.positionTotal || 10,
    rect
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

function stripedImage(width, height, startX = 0, stripeWidth = width) {
  const rgba = solidImage(width, height, [255, 255, 255, 255]);
  for (let x = startX; x < Math.min(width, startX + stripeWidth); x += 2) {
    fillRect(rgba, width, x, 0, 1, height, [0, 0, 0, 255]);
  }
  return rgba;
}

function shiftImage(source, width, height, dx, dy, fill) {
  const shifted = solidImage(width, height, fill);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const targetX = x + dx;
      const targetY = y + dy;
      if (targetX < 0 || targetX >= width || targetY < 0 || targetY >= height) {
        continue;
      }
      const fromOffset = (y * width + x) * 4;
      const toOffset = (targetY * width + targetX) * 4;
      shifted[toOffset] = source[fromOffset];
      shifted[toOffset + 1] = source[fromOffset + 1];
      shifted[toOffset + 2] = source[fromOffset + 2];
      shifted[toOffset + 3] = source[fromOffset + 3];
    }
  }
  return shifted;
}
