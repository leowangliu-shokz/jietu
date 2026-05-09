function defaultConfidence() {
  return {
    level: "high",
    baselineEligible: true,
    reasons: [],
    issues: []
  };
}

export function normalizeCaptureConfidence(value) {
  if (!value || typeof value !== "object") {
    return defaultConfidence();
  }
  const reasons = Array.isArray(value.reasons)
    ? value.reasons.map((reason) => String(reason || "").trim()).filter(Boolean)
    : [];
  const issues = Array.isArray(value.issues)
    ? value.issues
      .map((issue) => normalizeIssue(issue))
      .filter(Boolean)
    : [];
  return {
    level: value.level === "low" ? "low" : "high",
    baselineEligible: value.baselineEligible !== false,
    reasons,
    issues
  };
}

export function assessSnapshotConfidence(snapshot) {
  const issues = [];
  if (snapshot?.visualAudit?.status === "warning") {
    issues.push({
      code: "visual-audit-warning",
      severity: "low",
      message: snapshot.visualAudit.message || "Page screenshot failed image quality audit."
    });
  }
  if (snapshot?.urlCheck && snapshot.urlCheck.ok === false) {
    issues.push({
      code: "url-check-warning",
      severity: "low",
      message: "Capture finished without a verified final URL."
    });
  }
  return buildConfidence(issues);
}

export function relatedWarningsForShot(shot, validation) {
  const sectionKey = String(shot?.sectionKey || "").trim();
  const stateLabel = String(shot?.stateLabel || shot?.label || "").trim();
  const coverageMessages = [];
  const stateWarnings = [];

  for (const warning of Array.isArray(validation?.warnings) ? validation.warnings : []) {
    if (!warning || typeof warning !== "object") {
      continue;
    }
    if (sectionKey && warning.sectionKey && warning.sectionKey !== sectionKey) {
      continue;
    }
    const warningState = String(warning.stateLabel || "").trim();
    if (warningState && stateLabel && warningState === stateLabel) {
      stateWarnings.push(warning);
      continue;
    }
    if (!warningState && /missing planned screenshots|repeated planned screenshots/i.test(String(warning.message || ""))) {
      coverageMessages.push(warning);
    }
  }

  return { stateWarnings, coverageMessages };
}

export function assessRelatedShotConfidence(shot, validation) {
  const issues = [];
  const warnings = relatedWarningsForShot(shot, validation);
  if (shot?.visualAudit?.status === "warning") {
    issues.push({
      code: "visual-audit-warning",
      severity: "low",
      message: shot.visualAudit.message || "Related screenshot failed image quality audit."
    });
  }
  for (const warning of warnings.stateWarnings) {
    issues.push({
      code: "state-warning",
      severity: "low",
      message: String(warning.message || "Related screenshot has a capture warning."),
      sectionKey: warning.sectionKey || shot?.sectionKey || null,
      stateLabel: warning.stateLabel || shot?.stateLabel || shot?.label || null
    });
  }
  if (!issues.length && warnings.coverageMessages.length) {
    issues.push({
      code: "section-coverage-warning",
      severity: "high",
      message: String(warnings.coverageMessages[0].message || "Related section capture was incomplete.")
    });
  }
  return buildConfidence(issues);
}

export function baselineEligibleForSource(source) {
  return normalizeCaptureConfidence(source?.captureConfidence).baselineEligible;
}

function buildConfidence(issues) {
  const normalizedIssues = issues
    .map((issue) => normalizeIssue(issue))
    .filter(Boolean)
    .filter((issue, index, list) =>
      list.findIndex((candidate) =>
        candidate.code === issue.code &&
        candidate.message === issue.message &&
        candidate.sectionKey === issue.sectionKey &&
        candidate.stateLabel === issue.stateLabel
      ) === index
    );
  const blocking = normalizedIssues.filter((issue) => issue.severity === "low");
  return {
    level: blocking.length ? "low" : "high",
    baselineEligible: blocking.length === 0,
    reasons: [...new Set(normalizedIssues.map((issue) => issue.message))],
    issues: normalizedIssues
  };
}

function normalizeIssue(issue) {
  if (!issue || typeof issue !== "object") {
    return null;
  }
  const message = String(issue.message || "").trim();
  if (!message) {
    return null;
  }
  return {
    code: String(issue.code || "capture-issue"),
    severity: issue.severity === "high" ? "high" : "low",
    message,
    sectionKey: issue.sectionKey || null,
    stateLabel: issue.stateLabel || null
  };
}
