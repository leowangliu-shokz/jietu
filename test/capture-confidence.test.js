import assert from "node:assert/strict";
import test from "node:test";
import {
  assessRelatedShotConfidence,
  assessSnapshotConfidence,
  normalizeCaptureConfidence,
  relatedWarningsForShot
} from "../src/capture-confidence.js";

test("marks visual-audit warnings as low-confidence baselines", () => {
  const confidence = assessSnapshotConfidence({
    visualAudit: {
      status: "warning",
      qualityStatus: "warning",
      message: "Image may be blurry or low detail."
    }
  });

  assert.equal(confidence.level, "low");
  assert.equal(confidence.baselineEligible, false);
  assert.deepEqual(confidence.reasons, ["Image may be blurry or low detail."]);
});

test("matches related warnings by section and state label", () => {
  const shot = {
    sectionKey: "product-showcase",
    stateLabel: "Best Selling 1"
  };
  const validation = {
    warnings: [
      { sectionKey: "product-showcase", stateLabel: "Best Selling 1", message: "Known popup remained." },
      { sectionKey: "product-showcase", message: "missing planned screenshots: Best Selling 2." },
      { sectionKey: "media", stateLabel: "Media 1", message: "Irrelevant warning." }
    ]
  };

  const warnings = relatedWarningsForShot(shot, validation);

  assert.equal(warnings.stateWarnings.length, 1);
  assert.equal(warnings.coverageMessages.length, 1);
  assert.equal(warnings.stateWarnings[0].message, "Known popup remained.");
});

test("treats coverage-only section warnings as non-blocking confidence hints", () => {
  const confidence = assessRelatedShotConfidence({
    sectionKey: "product-showcase",
    stateLabel: "Best Selling 1"
  }, {
    warnings: [{
      sectionKey: "product-showcase",
      message: "missing planned screenshots: Best Selling 2."
    }]
  });

  assert.equal(confidence.level, "high");
  assert.equal(confidence.baselineEligible, true);
});

test("keeps similarity-only visual audits as non-blocking hints", () => {
  const confidence = assessRelatedShotConfidence({
    sectionKey: "scene-explore",
    stateLabel: "场景 2",
    visualAudit: {
      status: "notice",
      similarityStatus: "warning",
      message: "Visual signature is very close to 场景 1."
    }
  }, { warnings: [] });

  assert.equal(confidence.level, "high");
  assert.equal(confidence.baselineEligible, true);
  assert.deepEqual(confidence.reasons, ["Visual signature is very close to 场景 1."]);
});

test("does not downgrade similarity warnings when validation echoes the same message", () => {
  const confidence = assessRelatedShotConfidence({
    sectionKey: "scene-explore",
    stateLabel: "场景 2",
    visualAudit: {
      status: "notice",
      similarityStatus: "warning",
      message: "Visual signature is very close to 场景 1."
    }
  }, {
    warnings: [{
      sectionKey: "scene-explore",
      stateLabel: "场景 2",
      message: "Visual signature is very close to 场景 1."
    }]
  });

  assert.equal(confidence.level, "high");
  assert.equal(confidence.baselineEligible, true);
  assert.deepEqual(confidence.reasons, ["Visual signature is very close to 场景 1."]);
});

test("keeps structured low-detail media panels as non-blocking hints", () => {
  const confidence = assessRelatedShotConfidence({
    sectionKey: "media",
    stateLabel: "Shokz | Open-Ear Audio Pioneer 1",
    visibleItems: new Array(5).fill(null).map((_, index) => ({ key: `item-${index + 1}` })),
    visualAudit: {
      status: "warning",
      qualityStatus: "warning",
      message: "Image may be blurry or low detail."
    },
    sectionState: {
      textBlocks: new Array(8).fill(null).map((_, index) => ({ text: `block-${index + 1}` })),
      images: ["hero.webp"]
    }
  }, {
    warnings: [{
      sectionKey: "media",
      stateLabel: "Shokz | Open-Ear Audio Pioneer 1",
      message: "Image may be blurry or low detail."
    }]
  });

  assert.equal(confidence.level, "high");
  assert.equal(confidence.baselineEligible, true);
  assert.deepEqual(confidence.reasons, ["Image may be blurry or low detail."]);
});

test("keeps sparse text-only navigation secondary panels as non-blocking hints", () => {
  const confidence = assessRelatedShotConfidence({
    sectionKey: "navigation",
    navigationLevel: "secondary",
    topLevelLabel: "Support",
    stateLabel: "Support",
    visibleItems: new Array(4).fill(null).map((_, index) => ({ key: `item-${index + 1}` })),
    visualAudit: {
      status: "warning",
      qualityStatus: "warning",
      message: "Image may be blurry or low detail."
    },
    sectionState: {
      textBlocks: new Array(5).fill(null).map((_, index) => ({ text: `block-${index + 1}` })),
      images: []
    }
  }, {
    warnings: [{
      sectionKey: "navigation",
      stateLabel: "Support",
      message: "Image may be blurry or low detail."
    }]
  });

  assert.equal(confidence.level, "high");
  assert.equal(confidence.baselineEligible, true);
  assert.deepEqual(confidence.reasons, ["Image may be blurry or low detail."]);
});

test("normalizes missing confidence payloads to high confidence", () => {
  const confidence = normalizeCaptureConfidence(null);

  assert.equal(confidence.level, "high");
  assert.equal(confidence.baselineEligible, true);
  assert.deepEqual(confidence.reasons, []);
});
