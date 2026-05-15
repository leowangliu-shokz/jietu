import assert from "node:assert/strict";
import test from "node:test";
import { __testOnly, relatedShotLabelForCaptureItem } from "../src/capture-service.js";

test("uses the state label for product showcase capture items", () => {
  const label = relatedShotLabelForCaptureItem({
    sectionKey: "product-showcase",
    stateLabel: "Best Selling 1",
    label: "轮播 undefined"
  });

  assert.equal(label, "Best Selling 1");
});

test("finds related screenshots by preview file for replacement", () => {
  const snapshot = {
    relatedShots: [
      { file: "2026-05-15/shokz/home.png", sectionKey: "banner" },
      { file: "2026-05-15/shokz/collection-tabs-all.png", sectionKey: "collection-tabs" }
    ]
  };

  const match = __testOnly.findRelatedShotForReplacement(snapshot, {
    previewFile: "2026-05-15/shokz/collection-tabs-all.png",
    tileKey: "whole:collection-tabs-all"
  });

  assert.equal(match?.shot.sectionKey, "collection-tabs");
});

test("finds composite related screenshots by source tile file", () => {
  const snapshot = {
    relatedShots: [{
      file: "2026-05-15/shokz/product-map.png",
      sectionKey: "product-showcase",
      composite: {
        variants: [{
          key: "product-showcase:best-selling:1",
          sourceFile: "2026-05-15/shokz/product-showcase-best-selling-1.png"
        }]
      }
    }]
  };

  const match = __testOnly.findRelatedShotForReplacement(snapshot, {
    sourceFile: "2026-05-15/shokz/product-showcase-best-selling-1.png",
    tileKey: "product-showcase:best-selling:1"
  });

  assert.equal(match?.shot.file, "2026-05-15/shokz/product-map.png");
});

test("resolves replacement capture modes for non-home related screenshots", () => {
  assert.equal(
    __testOnly.relatedReplacementCaptureMode(
      { targetId: "shokz-products-nav", captureMode: "shokz-products-nav" },
      { sectionKey: "navigation" },
      {}
    ),
    "shokz-products-nav-related"
  );

  assert.equal(
    __testOnly.relatedReplacementCaptureMode(
      { captureMode: "shokz-collection-page" },
      { sectionKey: "collection-tabs" },
      {}
    ),
    "shokz-collection-related-section"
  );

  assert.equal(
    __testOnly.relatedReplacementCaptureMode(
      { captureMode: "shokz-comparison-page" },
      { sectionKey: "comparison-quick-look" },
      {}
    ),
    "shokz-comparison-related-section"
  );
});
