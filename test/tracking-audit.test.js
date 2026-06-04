import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTrackingIssues,
  createTrackingAuditRecord
} from "../src/tracking-audit.js";

test("flags stale button_name after a button changes from View More to View Less", () => {
  const issues = buildTrackingIssues({
    interactions: [{
      id: "click-1",
      type: "click",
      timestamp: 1000,
      labelBefore: "View More",
      labelAfter: "View Less",
      selector: "button.viewmore"
    }],
    events: [{
      source: "dataLayer.push",
      name: "select_content",
      timestamp: 1100,
      interactionId: "click-1",
      parameters: {
        button_name: "View More",
        content_type: "product card",
        content_name: "BE_PDP"
      }
    }],
    requests: [{
      source: "ga4-request",
      name: "select_content",
      timestamp: 1200,
      parameters: {
        button_name: "View More"
      },
      url: "https://www.google-analytics.com/g/collect?en=select_content&ep.button_name=View%20More"
    }]
  });

  const mismatch = issues.find((issue) => issue.type === "button-label-mismatch");
  assert.ok(mismatch);
  assert.equal(mismatch.level, "P0");
  assert.equal(mismatch.expected, "View Less");
  assert.equal(mismatch.actual, "View More");
});

test("normalizes GA4 request event parameters into audit records", () => {
  const record = createTrackingAuditRecord({
    id: "snapshot-1",
    capturedAt: "2026-06-04T08:00:00.000Z",
    url: "https://shokz.com/products/opendots-2",
    finalUrl: "https://shokz.com/products/opendots-2",
    targetId: "shokz-opendots-2-product",
    targetLabel: "OpenDots 2 PDP",
    displayUrl: "OpenDots 2 PDP",
    platform: "mobile",
    devicePresetId: "iphone-15",
    capturePlanId: "plan-mobile"
  }, {
    events: [{
      source: "dataLayer.push",
      name: "select_content",
      timestamp: 1000,
      parameters: {
        button_name: "View Less",
        content_type: "product card",
        content_name: "BE_PDP"
      }
    }],
    networkRequests: [{
      source: "cdp-network",
      method: "POST",
      timestamp: 1020,
      url: "https://www.google-analytics.com/g/collect?en=select_content&ep.button_name=View%20Less&ep.content_name=BE_PDP"
    }],
    interactions: [{
      id: "click-1",
      type: "click",
      timestamp: 980,
      labelBefore: "View Less",
      labelAfter: "View Less"
    }]
  }, {
    auditedAt: "2026-06-04T08:01:00.000Z"
  });

  assert.equal(record.id, "snapshot-1-tracking");
  assert.equal(record.platform, "mobile");
  assert.equal(record.eventCount, 1);
  assert.equal(record.ga4RequestCount, 1);
  assert.equal(record.ga4Requests[0].name, "select_content");
  assert.equal(record.ga4Requests[0].parameters.button_name, "View Less");
});

test("flags meaningful clicks without matching tracking events", () => {
  const issues = buildTrackingIssues({
    interactions: [{
      id: "click-1",
      type: "click",
      timestamp: 1000,
      labelBefore: "Buy Now",
      labelAfter: "Buy Now",
      selector: "button.buy"
    }],
    events: [],
    requests: []
  });

  assert.ok(issues.some((issue) => issue.type === "click-without-event"));
});
