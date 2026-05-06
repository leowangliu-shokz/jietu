import assert from "node:assert/strict";
import test from "node:test";
import { relatedShotLabelForCaptureItem } from "../src/capture-service.js";

test("uses the state label for product showcase capture items", () => {
  const label = relatedShotLabelForCaptureItem({
    sectionKey: "product-showcase",
    stateLabel: "Best Selling 1",
    label: "轮播 undefined"
  });

  assert.equal(label, "Best Selling 1");
});
