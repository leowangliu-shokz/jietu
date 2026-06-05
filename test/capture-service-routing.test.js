import assert from "node:assert/strict";
import test from "node:test";
import { __testOnly } from "../src/capture-service.js";
import { normalizeConfig, resolveConfiguredCapturePlans } from "../src/store.js";

const {
  captureConfigForExecution,
  relatedCaptureModeForTarget,
  relatedDescriptorsForCaptureConfig,
  resolveAdHocCaptureExecution,
  captureConcurrency,
  relatedCaptureConcurrency,
  captureRetryAttempts,
  shouldRetryCaptureResult,
  createCaptureRunRecord,
  runnerNameForPlatform
} = __testOnly;

test("capture plans route to distinct platform runners", () => {
  assert.equal(runnerNameForPlatform("pc"), "capturePcPlan");
  assert.equal(runnerNameForPlatform("mobile"), "captureMobilePlan");
});

test("captureConfigForExecution builds a mobile viewport and applies plan overrides", () => {
  const config = normalizeConfig({
    targets: [{ id: "home", url: "https://example.com/", label: "Example" }],
    deviceProfiles: [{ id: "mobile-main", platform: "mobile", devicePresetId: "iphone-15", enabled: true }],
    capturePlans: [{
      id: "home-mobile",
      targetId: "home",
      deviceProfileId: "mobile-main",
      enabled: true,
      fullPage: false,
      captureMode: "shokz-products-nav"
    }]
  });
  const execution = resolveConfiguredCapturePlans(config, { planIds: ["home-mobile"] })[0];

  const captureConfig = captureConfigForExecution(config, execution);

  assert.equal(captureConfig.platform, "mobile");
  assert.equal(captureConfig.viewport.mobile, true);
  assert.equal(captureConfig.viewport.touch, true);
  assert.equal(captureConfig.captureMode, "shokz-products-nav");
  assert.equal(captureConfig.fullPage, false);
});

test("captureConfigForExecution carries targeted related-state filters", () => {
  const config = normalizeConfig({
    targets: [{ id: "comparison", url: "https://example.com/compare", label: "Comparison" }],
    deviceProfiles: [{ id: "mobile-main", platform: "mobile", devicePresetId: "iphone-15", enabled: true }],
    capturePlans: [{
      id: "comparison-mobile",
      targetId: "comparison",
      deviceProfileId: "mobile-main",
      enabled: true,
      captureMode: "shokz-comparison-page"
    }]
  });
  const execution = resolveConfiguredCapturePlans(config, { planIds: ["comparison-mobile"] })[0];

  const captureConfig = captureConfigForExecution(config, execution, {
    sectionKey: "comparison-products",
    relatedStateFilter: {
      sectionKey: "comparison-products",
      productKey: "openrunpro2",
      tileKey: "openrunpro2"
    }
  });

  assert.equal(captureConfig.captureMode, "shokz-comparison-page");
  assert.equal(captureConfig.sectionKey, "comparison-products");
  assert.deepEqual(captureConfig.relatedStateFilter, {
    sectionKey: "comparison-products",
    productKey: "openrunpro2",
    tileKey: "openrunpro2"
  });
});

test("Shokz page relatedCaptureMode also selects the main capture mode", () => {
  const config = normalizeConfig({
    targets: [{ id: "collection", url: "https://example.com/collection", label: "Collection" }],
    deviceProfiles: [{ id: "pc-main", platform: "pc", devicePresetId: "pc-hd", enabled: true }],
    capturePlans: [{
      id: "collection-pc",
      targetId: "collection",
      deviceProfileId: "pc-main",
      enabled: true,
      relatedCaptureMode: "shokz-collection-page"
    }]
  });
  const execution = resolveConfiguredCapturePlans(config, { planIds: ["collection-pc"] })[0];

  const captureConfig = captureConfigForExecution(config, execution);

  assert.equal(captureConfig.captureMode, "shokz-collection-page");
  assert.equal(captureConfig.relatedCaptureMode, "shokz-collection-page");
  assert.equal(
    relatedCaptureModeForTarget(execution.target, captureConfig),
    "shokz-collection-related-section"
  );
});

test("relatedDescriptorsForCaptureConfig narrows isolated related captures by section", () => {
  const descriptors = [
    { sectionKey: "comparison-products" },
    { sectionKey: "comparison-quick-look" }
  ];

  assert.deepEqual(
    relatedDescriptorsForCaptureConfig(descriptors, { sectionKey: "comparison-products" }),
    [{ sectionKey: "comparison-products" }]
  );
  assert.deepEqual(
    relatedDescriptorsForCaptureConfig(descriptors, {
      relatedStateFilter: { sectionKey: "comparison-quick-look" }
    }),
    [{ sectionKey: "comparison-quick-look" }]
  );
  assert.deepEqual(
    relatedDescriptorsForCaptureConfig(descriptors, { sectionKey: "missing-section" }),
    descriptors
  );
});

test("navigation related captures run for both desktop and mobile navigation targets", () => {
  assert.equal(
    relatedCaptureModeForTarget(
      { id: "shokz-products-nav" },
      { platform: "pc", captureMode: "shokz-products-nav" }
    ),
    "shokz-products-nav-related"
  );
  assert.equal(
    relatedCaptureModeForTarget(
      { id: "shokz-products-nav" },
      { platform: "mobile", captureMode: "shokz-products-nav" }
    ),
    "shokz-products-nav-related"
  );
});

test("collection page capture mode routes to isolated related section captures", () => {
  assert.equal(
    relatedCaptureModeForTarget(
      { id: "shokz-headphones-accessories" },
      { platform: "mobile", captureMode: "shokz-collection-page" }
    ),
    "shokz-collection-related-section"
  );
});

test("comparison page capture mode routes to isolated related section captures", () => {
  assert.equal(
    relatedCaptureModeForTarget(
      { id: "shokz-product-comparison" },
      { platform: "mobile", captureMode: "shokz-comparison-page" }
    ),
    "shokz-comparison-related-section"
  );
});

test("landing page capture mode routes to landing related captures", () => {
  assert.equal(
    relatedCaptureModeForTarget(
      { id: "shokz-explore-open-ear-headphones" },
      { platform: "mobile", captureMode: "shokz-landing-page" }
    ),
    "shokz-landing-related"
  );
});

test("resolveAdHocCaptureExecution can bind a manual URL to the requested mobile profile", () => {
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

  const execution = resolveAdHocCaptureExecution("https://example.com/pricing", config, {
    platform: "mobile"
  });

  assert.equal(execution.platform, "mobile");
  assert.equal(execution.deviceProfile.id, "mobile-main");
  assert.equal(execution.target.url, "https://example.com/pricing");
  assert.equal(execution.id, "adhoc-home-mobile-url-1");
});

test("capture run records preserve plan item metadata for batch status", () => {
  const config = normalizeConfig({
    targets: [{ id: "home", url: "https://example.com/", label: "Example" }],
    deviceProfiles: [{ id: "pc-main", platform: "pc", devicePresetId: "pc-hd", enabled: true }],
    capturePlans: [{ id: "home-pc", targetId: "home", deviceProfileId: "pc-main", enabled: true }]
  });
  const execution = resolveConfiguredCapturePlans(config, { planIds: ["home-pc"] })[0];

  const run = createCaptureRunRecord([execution], { runId: "run-test" });

  assert.equal(run.id, "run-test");
  assert.equal(run.totalCount, 1);
  assert.equal(run.items[0].status, "pending");
  assert.equal(run.items[0].targetId, "home");
  assert.equal(run.items[0].deviceProfileId, "pc-main");
  assert.equal(run.items[0].capturePlanId, "home-pc");
});

test("capture concurrency is bounded and defaults to the conservative serial runner", () => {
  assert.equal(captureConcurrency({}, {}), 1);
  assert.equal(captureConcurrency({ captureConcurrency: 3 }, {}), 3);
  assert.equal(captureConcurrency({ captureConcurrency: 20 }, {}), 8);
  assert.equal(captureConcurrency({ captureConcurrency: 3 }, { maxConcurrency: 2 }), 2);
});

test("related capture concurrency uses a tighter browser budget", () => {
  assert.equal(relatedCaptureConcurrency({}, {}), 1);
  assert.equal(relatedCaptureConcurrency({ relatedCaptureConcurrency: 2 }, {}), 2);
  assert.equal(relatedCaptureConcurrency({ relatedCaptureConcurrency: 20 }, {}), 4);
});

test("blank screenshot failures are retried with a bounded attempt count", () => {
  assert.equal(captureRetryAttempts({}, {}), 2);
  assert.equal(captureRetryAttempts({ captureRetryAttempts: 9 }, {}), 3);
  assert.equal(shouldRetryCaptureResult({
    ok: false,
    error: "full-page segment 2/6 failed blank-image validation after 3 attempts."
  }), true);
  assert.equal(shouldRetryCaptureResult({
    ok: true,
    snapshot: {
      relatedValidation: {
        warnings: [{ sectionKey: "navigation", message: "missing planned screenshots" }]
      }
    }
  }), false);
  assert.equal(shouldRetryCaptureResult({
    ok: false,
    error: "Mobile menu trigger not found:  (stage: opening Shokz products navigation)"
  }), true);
  assert.equal(shouldRetryCaptureResult({
    ok: false,
    error: "Shokz products navigation did not open. hits=3/3 reason=Desktop Products navigation category column was too close to the left edge."
  }), true);
  assert.equal(shouldRetryCaptureResult({
    ok: false,
    error: "URL check failed after navigation: requested https://shokz.com/ but browser is at chrome-error://chromewebdata/."
  }), true);
  assert.equal(shouldRetryCaptureResult({
    ok: false,
    error: "Could not find collection tab All. (stage: activating Shokz collection All tab)"
  }), true);
  assert.equal(shouldRetryCaptureResult({
    ok: false,
    error: "Capture completed but failed to save snapshot index: disk full"
  }), false);
});
