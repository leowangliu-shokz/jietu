export const shokzNavigationTopLabels = ["Products", "Support", "Technology", "About Us"];

export const shokzProductsNavigationCategoryLabels = [
  "Sports Headphones",
  "Workout & Lifestyle Earbuds",
  "Communication Headsets"
];

export const shokzMobileNavigationSecondaryStateDefinitions = [
  {
    clickLabel: "Sports Headphones",
    stateLabel: "Products / Sports Headphones",
    fileId: "products-sports-headphones",
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
    stateLabel: "Products / Workout & Lifestyle Earbuds",
    fileId: "products-workout-lifestyle-earbuds",
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
    stateLabel: "Products / Communication Headsets",
    fileId: "products-communication-headsets",
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
    stateLabel: "Support",
    fileId: "support",
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
    stateLabel: "Technology",
    fileId: "technology",
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
    stateLabel: "About Us",
    fileId: "about-us",
    tabLabel: "About Us",
    tabIndex: 4,
    topLevelLabel: "About Us",
    topLevelIndex: 4,
    hoverItemKey: "secondary:4:1",
    hoverItemLabel: "About Us",
    hoverIndex: 1
  }
];

export const shokzHomeRelatedSectionDefinitions = [
  {
    key: "topbar",
    sectionLabel: "Topbar",
    title: "Topbar 轮播图",
    mode: "carousel",
    anchors: [
      "Fast & Free Shipping",
      "45-Day Price Match",
      "Free 45-Day Returns",
      "2-Year Warranty"
    ],
    labelPrefix: "Topbar",
    expectedPages: 4,
    mobileOnly: true,
    rootSelector: ".announcement",
    minRootHeight: 24,
    maxRootHeight: 120
  },
  {
    key: "product-showcase",
    sectionLabel: "产品橱窗",
    title: "产品橱窗轮播图",
    mode: "tabs-carousel",
    rootSelector: ".section-home-product-collection",
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

export const shokzCollectionRelatedSectionDefinitions = [
  {
    key: "collection-tabs",
    sectionLabel: "Collection Tabs",
    title: "Collection Tabs",
    states: [
      {
        clickLabel: "All",
        matchPatterns: ["all"],
        stateLabel: "All",
        tabLabel: "All",
        tabIndex: 1,
        stateIndex: 1,
        fileId: "collection-all",
        categoryKey: "all",
        categoryLabel: "All"
      },
      {
        clickLabel: "Sports",
        matchHandle: "sports",
        matchPatterns: ["sport"],
        stateLabel: "Sports",
        tabLabel: "Sports",
        tabIndex: 2,
        stateIndex: 2,
        fileId: "collection-sports",
        categoryKey: "sports",
        categoryLabel: "Sports"
      },
      {
        clickLabel: "Workout & Lifestyle",
        matchHandle: "workout-lifestyle",
        matchPatterns: ["workout", "lifestyle", "workout&lifestyle"],
        stateLabel: "Workout&Lifestyle",
        tabLabel: "Workout&Lifestyle",
        tabIndex: 3,
        stateIndex: 3,
        fileId: "collection-workout-lifestyle",
        categoryKey: "workout-lifestyle",
        categoryLabel: "Workout&Lifestyle"
      },
      {
        clickLabel: "Communication",
        matchHandle: "communication",
        matchPatterns: ["communication", "commucication"],
        stateLabel: "Communication",
        tabLabel: "Communication",
        tabIndex: 4,
        stateIndex: 4,
        fileId: "collection-communication",
        categoryKey: "communication",
        categoryLabel: "Communication"
      },
      {
        clickLabel: "Refurbished",
        matchHandle: "refurbished",
        matchPatterns: ["refurbi"],
        stateLabel: "Refurbished",
        tabLabel: "Refurbished",
        tabIndex: 5,
        stateIndex: 5,
        fileId: "collection-refurbished",
        categoryKey: "refurbished",
        categoryLabel: "Refurbished"
      },
      {
        clickLabel: "Accessories",
        matchHandle: "accessories",
        matchPatterns: ["acce"],
        stateLabel: "Accessories",
        tabLabel: "Accessories",
        tabIndex: 6,
        stateIndex: 6,
        fileId: "collection-accessories",
        categoryKey: "accessories",
        categoryLabel: "Accessories"
      }
    ]
  }
];

export const shokzComparisonRelatedSectionDefinitions = [
  {
    key: "comparison-quick-look",
    sectionLabel: "Quick Look",
    title: "Quick Look",
    maxTracks: 2,
    maxPagesPerTrack: 3
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
  "topbar",
  "banner",
  "navigation",
  "collection-tabs",
  "comparison-quick-look",
  ...shokzHomeRelatedSectionDefinitions
    .map((definition) => definition.key)
    .filter((key) => key !== "topbar")
];

export function findShokzHomeRelatedSectionDefinition(sectionKey) {
  return shokzHomeRelatedSectionDefinitions.find((definition) => definition.key === sectionKey) || null;
}

export function findShokzCollectionRelatedSectionDefinition(sectionKey) {
  return shokzCollectionRelatedSectionDefinitions.find((definition) => definition.key === sectionKey) || null;
}

export function findShokzComparisonRelatedSectionDefinition(sectionKey) {
  return shokzComparisonRelatedSectionDefinitions.find((definition) => definition.key === sectionKey) || null;
}
