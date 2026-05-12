import assert from "node:assert/strict";
import test from "node:test";
import { shokzHomeRelatedSectionDefinitions, shokzRelatedSectionOrder } from "../src/shokz-capture-specs.js";

test("defines a mobile-only homepage topbar section ahead of banner ordering", () => {
  const topbar = shokzHomeRelatedSectionDefinitions.find((definition) => definition.key === "topbar");

  assert.ok(topbar);
  assert.equal(topbar.sectionLabel, "Topbar");
  assert.equal(topbar.title, "Topbar 轮播图");
  assert.equal(topbar.mobileOnly, true);
  assert.equal(topbar.rootSelector, ".announcement");
  assert.deepEqual(topbar.anchors, [
    "Fast & Free Shipping",
    "45-Day Price Match",
    "Free 45-Day Returns",
    "2-Year Warranty"
  ]);
  assert.ok(shokzRelatedSectionOrder.indexOf("topbar") !== -1);
  assert.ok(shokzRelatedSectionOrder.indexOf("topbar") < shokzRelatedSectionOrder.indexOf("banner"));
});
