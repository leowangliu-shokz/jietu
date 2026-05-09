export const shokzNavigationTopLabels = ["Products", "Support", "Technology", "About Us"];

export const shokzProductsNavigationCategoryLabels = [
  "Sports Headphones",
  "Workout & Lifestyle Earbuds",
  "Communication Headsets"
];

export const shokzHomeRelatedSectionDefinitions = [
  {
    key: "product-showcase",
    sectionLabel: "产品橱窗",
    title: "产品橱窗轮播图",
    mode: "tabs-carousel",
    anchors: ["Best Selling", "Sports Headphones", "Workout & Lifestyle Earbuds", "Communication Headsets"],
    tabs: ["Best Selling", "Sports Headphones", "Workout & Lifestyle Earbuds", "Communication Headsets"],
    labelMode: "tab"
  },
  {
    key: "scene-explore",
    sectionLabel: "场景探索区",
    title: "场景探索轮播图",
    mode: "carousel",
    anchors: [
      "How Shokz Makes It Possible",
      "Headphones Built for Sport",
      "Why Open-Ear Listening Matters"
    ],
    labelPrefix: "场景"
  },
  {
    key: "athletes",
    sectionLabel: "运动员区",
    title: "运动员区轮播图",
    mode: "tabs-carousel",
    anchors: ["Trusted by Athletes", "Marathon", "Trail Running", "Triathlon"],
    tabs: ["Marathon", "Trail Running", "Triathlon"],
    labelMode: "tab"
  },
  {
    key: "media",
    sectionLabel: "媒体区",
    title: "媒体区轮播图",
    mode: "carousel",
    anchors: ["Media Reviews"],
    labelPrefix: "媒体"
  },
  {
    key: "voices",
    sectionLabel: "用户心声区",
    title: "用户心声轮播图",
    mode: "carousel",
    anchors: ["Real Stories, Inspiring Moments."],
    labelPrefix: "心声",
    expectedPages: 4
  }
];

export const shokzMediaTrackDefinitions = [
  {
    key: "pioneer",
    label: "Shokz | Open-Ear Audio Pioneer",
    selector: ".co-number-swiper",
    rootSelector: ".co-number-box-banner, section, .shopify-section"
  },
  {
    key: "awards",
    label: "Sports partnership & Awards",
    selector: ".co-brand-swiper-left",
    rootSelector: ".co-brand-box"
  },
  {
    key: "reviews",
    label: "Media Reviews",
    selector: ".co-brand-swiper-right",
    rootSelector: ".co-brand-box"
  }
];

export const shokzRelatedSectionOrder = [
  "banner",
  "navigation",
  ...shokzHomeRelatedSectionDefinitions.map((definition) => definition.key)
];

export function findShokzHomeRelatedSectionDefinition(sectionKey) {
  return shokzHomeRelatedSectionDefinitions.find((definition) => definition.key === sectionKey) || null;
}
