import assert from "node:assert/strict";
import test from "node:test";
import { buildStatePayload } from "../src/server-state.js";
import { normalizeConfig } from "../src/store.js";

test("buildStatePayload annotates legacy snapshots and changes with platform metadata", () => {
  const config = normalizeConfig({
    targets: [{ id: "home", url: "https://example.com/", label: "Example" }],
    deviceProfiles: [
      { id: "pc-main", platform: "pc", devicePresetId: "pc-hd", enabled: true },
      { id: "mobile-main", platform: "mobile", devicePresetId: "iphone-15", enabled: true }
    ],
    capturePlans: [
      { id: "home-pc", targetId: "home", deviceProfileId: "pc-main", enabled: true },
      { id: "home-mobile", targetId: "home", deviceProfileId: "mobile-main", enabled: true }
    ]
  });

  const state = buildStatePayload({
    config,
    captureState: { running: false, lastResults: [] },
    nextRunAt: null,
    browser: { ok: true, path: "C:/Program Files/Google/Chrome/Application/chrome.exe" },
    snapshots: [
      {
        id: "snap-1",
        targetId: "home",
        devicePresetId: "iphone-15",
        capturedAt: "2026-05-12T09:00:00.000Z",
        file: "2026-05-12/example-com/snap.png",
        imageUrl: "/archive/2026-05-12/example-com/snap.png",
        width: 393,
        height: 852
      }
    ],
    changes: [
      {
        id: "change-1",
        location: {
          targetId: "home",
          devicePresetId: "pc-hd"
        },
        from: { capturedAt: "2026-05-12T08:00:00.000Z" },
        to: { capturedAt: "2026-05-12T09:00:00.000Z" }
      }
    ],
    permissions: {
      canDeleteSnapshots: true
    }
  });

  assert.equal(state.snapshots[0].platform, "mobile");
  assert.equal(state.snapshots[0].deviceProfileId, "mobile-main");
  assert.equal(state.snapshots[0].capturePlanId, "home-mobile");
  assert.equal(state.changesSummary.recent[0].location.platform, "pc");
  assert.equal(state.changesSummary.recent[0].location.deviceProfileId, "pc-main");
  assert.equal(state.platforms.mobile.snapshotCount, 1);
  assert.equal(state.platforms.pc.changeCount, 1);
});
