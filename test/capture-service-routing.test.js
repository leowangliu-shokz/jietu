import assert from "node:assert/strict";
import test from "node:test";
import { __testOnly } from "../src/capture-service.js";
import { normalizeConfig, resolveConfiguredCapturePlans } from "../src/store.js";

const {
  captureConfigForExecution,
  relatedCaptureModeForTarget,
  relatedDescriptorsForCaptureConfig,
  resolveAdHocCaptureExecution,
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
