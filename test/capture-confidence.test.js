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

test("normalizes missing confidence payloads to high confidence", () => {
  const confidence = normalizeCaptureConfidence(null);

  assert.equal(confidence.level, "high");
  assert.equal(confidence.baselineEligible, true);
  assert.deepEqual(confidence.reasons, []);
});
