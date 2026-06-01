import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendSnapshots, normalizeConfig, readSnapshots, resolveConfiguredCapturePlans } from "../src/store.js";

test("normalizeConfig migrates legacy config into v2 targets, device profiles, and plans", () => {
  const config = normalizeConfig({
    urls: [
      { id: "home", url: "https://example.com/", label: "Example Home" },
      { id: "nav", url: "https://example.com/nav", label: "Example Nav", captureMode: "nav", fullPage: false }
    ],
    devicePresetId: "pc-hd",
    intervalMinutes: 30,
    waitAfterLoadMs: 1800,
    relatedCaptureConcurrency: 3,
    captureRetryAttempts: 3
  });

  assert.equal(config.version, 2);
  assert.equal(config.targets.length, 2);
  assert.ok(config.deviceProfiles.some((profile) => profile.platform === "pc"));
  assert.ok(config.deviceProfiles.some((profile) => profile.platform === "mobile"));
  assert.equal(config.capturePlans.length, config.targets.length * config.deviceProfiles.length);
  assert.equal(config.intervalMinutes, 30);
  assert.equal(config.waitAfterLoadMs, 1800);
  assert.equal(config.relatedCaptureConcurrency, 3);
  assert.equal(config.captureRetryAttempts, 3);
});

test("normalizeConfig keeps explicit v2 plans and drops invalid duplicates", () => {
  const config = normalizeConfig({
    targets: [
      { id: "home", url: "https://example.com/", label: "Example" },
      { id: "home", url: "https://example.com/", label: "Duplicate" },
      { id: "docs", url: "https://example.com/docs", label: "Docs" }
    ],
    deviceProfiles: [
      { id: "pc-main", platform: "pc", devicePresetId: "pc-hd", enabled: true },
      { id: "pc-main", platform: "pc", devicePresetId: "pc-laptop", enabled: true },
      { id: "mobile-main", platform: "mobile", devicePresetId: "iphone-15", enabled: true }
    ],
    capturePlans: [
      { id: "home-pc", targetId: "home", deviceProfileId: "pc-main", enabled: true },
      { id: "home-pc-duplicate", targetId: "home", deviceProfileId: "pc-main", enabled: true },
      {
        id: "docs-mobile",
        targetId: "docs",
        deviceProfileId: "mobile-main",
        enabled: false,
        relatedCaptureMode: "shokz-collection-page"
      },
      { id: "invalid", targetId: "missing", deviceProfileId: "mobile-main", enabled: true }
    ]
  });

  assert.deepEqual(
    config.targets.map((target) => target.id),
    ["home", "docs"]
  );
  assert.deepEqual(
    config.deviceProfiles.map((profile) => profile.id),
    ["pc-main", "mobile-main"]
  );
  assert.deepEqual(
    config.capturePlans.map((plan) => plan.id),
    ["home-pc", "docs-mobile"]
  );
  assert.equal(config.capturePlans[1].relatedCaptureMode, "shokz-collection-page");
});

test("resolveConfiguredCapturePlans filters the execution matrix by platform and preset", () => {
  const config = normalizeConfig({
    targets: [
      { id: "home", url: "https://example.com/", label: "Example" },
      { id: "docs", url: "https://example.com/docs", label: "Docs" }
    ],
    deviceProfiles: [
      { id: "pc-main", platform: "pc", devicePresetId: "pc-hd", enabled: true },
      { id: "mobile-main", platform: "mobile", devicePresetId: "iphone-15", enabled: true }
    ],
    capturePlans: [
      { id: "home-pc", targetId: "home", deviceProfileId: "pc-main", enabled: true },
      { id: "docs-pc", targetId: "docs", deviceProfileId: "pc-main", enabled: true },
      { id: "home-mobile", targetId: "home", deviceProfileId: "mobile-main", enabled: true }
    ]
  });

  const pcPlans = resolveConfiguredCapturePlans(config, { platform: "pc" });
  const mobilePlans = resolveConfiguredCapturePlans(config, { devicePresetId: "iphone-15" });

  assert.deepEqual(pcPlans.map((plan) => plan.id), ["home-pc", "docs-pc"]);
  assert.deepEqual(mobilePlans.map((plan) => plan.id), ["home-mobile"]);
  assert.ok(pcPlans.every((plan) => plan.platform === "pc"));
  assert.ok(mobilePlans.every((plan) => plan.platform === "mobile"));
});

test("appendSnapshots writes a batch with one index update", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jietu-snapshots-"));
  const filePath = path.join(tempDir, "snapshots.json");

  await appendSnapshots([
    { id: "snap-1", capturedAt: "2026-05-20T08:00:00.000Z", file: "a.png" },
    { id: "snap-2", capturedAt: "2026-05-20T08:00:01.000Z", file: "b.png" }
  ], filePath);
  await appendSnapshots([
    { id: "snap-3", capturedAt: "2026-05-20T09:00:00.000Z", file: "c.png" }
  ], filePath);

  const snapshots = await readSnapshots(filePath);
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.id),
    ["snap-3", "snap-2", "snap-1"]
  );
});
