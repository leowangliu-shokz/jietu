import assert from "node:assert/strict";
import test from "node:test";
import {
  shokzHomeRelatedSectionDefinitions,
  shokzMobileNavigationSecondaryStateDefinitions,
  shokzRelatedSectionOrder
} from "../src/shokz-capture-specs.js";

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

test("defines the six mobile navigation secondary states with stable metadata", () => {
  assert.equal(shokzMobileNavigationSecondaryStateDefinitions.length, 6);
  assert.deepEqual(
    shokzMobileNavigationSecondaryStateDefinitions.map((definition) => ({
      clickLabel: definition.clickLabel,
      tabLabel: definition.tabLabel,
      tabIndex: definition.tabIndex,
      topLevelLabel: definition.topLevelLabel,
      topLevelIndex: definition.topLevelIndex,
      hoverItemKey: definition.hoverItemKey,
      hoverItemLabel: definition.hoverItemLabel,
      hoverIndex: definition.hoverIndex
    })),
    [
      {
        clickLabel: "Sports Headphones",
        tabLabel: "Products",
        tabIndex: 1,
        topLevelLabel: "Products",
        topLevelIndex: 1,
        hoverItemKey: "secondary:1:1",
        hoverItemLabel: "Sports Headphones",
        hoverIndex: 1
      },
      {
        clickLabel: "Workout & Lifestyle Earbuds",
        tabLabel: "Products",
        tabIndex: 1,
        topLevelLabel: "Products",
        topLevelIndex: 1,
        hoverItemKey: "secondary:1:2",
        hoverItemLabel: "Workout & Lifestyle Earbuds",
        hoverIndex: 2
      },
      {
        clickLabel: "Communication Headsets",
        tabLabel: "Products",
        tabIndex: 1,
        topLevelLabel: "Products",
        topLevelIndex: 1,
        hoverItemKey: "secondary:1:3",
        hoverItemLabel: "Communication Headsets",
        hoverIndex: 3
      },
      {
        clickLabel: "Support",
        tabLabel: "Support",
        tabIndex: 2,
        topLevelLabel: "Support",
        topLevelIndex: 2,
        hoverItemKey: "secondary:2:1",
        hoverItemLabel: "Support",
        hoverIndex: 1
      },
      {
        clickLabel: "Technology",
        tabLabel: "Technology",
        tabIndex: 3,
        topLevelLabel: "Technology",
        topLevelIndex: 3,
        hoverItemKey: "secondary:3:1",
        hoverItemLabel: "Technology",
        hoverIndex: 1
      },
      {
        clickLabel: "About Us",
        tabLabel: "About Us",
        tabIndex: 4,
        topLevelLabel: "About Us",
        topLevelIndex: 4,
        hoverItemKey: "secondary:4:1",
        hoverItemLabel: "About Us",
        hoverIndex: 1
      }
    ]
  );
});
