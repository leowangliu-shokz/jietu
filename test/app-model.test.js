import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPlatformViews,
  configTargets,
  platformForChange,
  platformForSnapshot
} from "../public/app-model.js";

test("configTargets reads v2 targets and legacy urls", () => {
  assert.deepEqual(
    configTargets({
      targets: [{ id: "home", url: "https://example.com/", label: "Example" }]
    }).map((target) => target.id),
    ["home"]
  );
  assert.deepEqual(
    configTargets({
      urls: ["https://example.com/", { id: "docs", url: "https://example.com/docs", label: "Docs" }]
    }).map((target) => target.id),
    ["url-1", "docs"]
  );
});

test("platformForSnapshot and platformForChange respect explicit metadata then presets", () => {
  const devicePresets = [
    { id: "pc-hd", mobile: false, name: "PC" },
    { id: "iphone-15", mobile: true, name: "iPhone 15" }
  ];

  assert.equal(
    platformForSnapshot({ platform: "mobile", devicePresetId: "pc-hd" }, devicePresets),
    "mobile"
  );
  assert.equal(
    platformForSnapshot({ devicePresetId: "iphone-15" }, devicePresets),
    "mobile"
  );
  assert.equal(
    platformForChange({ location: { devicePresetId: "pc-hd" } }, devicePresets),
    "pc"
  );
});

test("buildPlatformViews groups targets, plans, snapshots, and changes by platform", () => {
  const config = {
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
  };
  const devicePresets = [
    { id: "pc-hd", mobile: false, name: "PC" },
    { id: "iphone-15", mobile: true, name: "iPhone 15" }
  ];
  const views = buildPlatformViews({
    config,
    devicePresets,
    snapshots: [
      { id: "pc-snap", devicePresetId: "pc-hd" },
      { id: "mobile-snap", devicePresetId: "iphone-15" }
    ],
    changes: [
      { id: "pc-change", location: { devicePresetId: "pc-hd" } },
      { id: "mobile-change", location: { platform: "mobile" } }
    ]
  });

  assert.deepEqual(views.pc.targetIds, ["home", "docs"]);
  assert.deepEqual(views.mobile.targetIds, ["home"]);
  assert.equal(views.pc.snapshotCount, 1);
  assert.equal(views.mobile.snapshotCount, 1);
  assert.equal(views.pc.changeCount, 1);
  assert.equal(views.mobile.changeCount, 1);
});
