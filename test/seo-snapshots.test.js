import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendSeoSnapshots,
  compareSeoSnapshots,
  deleteSeoSnapshotsForSnapshotIds,
  loadSeoChanges,
  loadSeoSnapshots,
  normalizeSeoSnapshotRecord
} from "../src/seo-snapshots.js";

test("compares SEO snapshots by same target and platform", () => {
  const changes = compareSeoSnapshots([
    seoSnapshot("seo-1", "snap-1", "2026-05-01T08:00:00.000Z", {
      title: "Open-Ear Headphones",
      metaDescription: "Original description",
      h1: ["Open-Ear Headphones"],
      tableHeaders: ["Model", "Battery"]
    }),
    seoSnapshot("seo-2", "snap-2", "2026-05-01T09:00:00.000Z", {
      title: "Open-Ear Headphones | Shokz",
      metaDescription: "Updated description",
      h1: ["Open-Ear Headphones"],
      tableHeaders: ["Model", "Battery", "Waterproof"]
    })
  ]);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeLevel, "P1");
  assert.deepEqual(
    changes[0].fields.map((field) => field.field),
    ["title", "metaDescription", "tableHeaders"]
  );
  assert.equal(changes[0].location.platform, "pc");
});

test("marks noindex and required-field removal as P0", () => {
  const changes = compareSeoSnapshots([
    seoSnapshot("seo-1", "snap-1", "2026-05-01T08:00:00.000Z", {
      title: "Indexed page",
      metaDescription: "Description",
      canonical: "https://example.com/page",
      robots: "index,follow",
      h1: ["Indexed page"]
    }),
    seoSnapshot("seo-2", "snap-2", "2026-05-01T09:00:00.000Z", {
      title: "",
      metaDescription: "Description",
      canonical: "https://example.com/page",
      robots: "noindex,nofollow",
      h1: ["Indexed page"]
    })
  ]);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeLevel, "P0");
  assert.ok(changes[0].fields.some((field) => field.field === "robots" && field.level === "P0"));
  assert.ok(changes[0].fields.some((field) => field.field === "title" && field.level === "P0"));
});

test("builds SEO issues for bad canonical and missing Shokz regional hreflang", () => {
  const record = normalizeSeoSnapshotRecord(seoSnapshot("seo-1", "snap-1", "2026-05-01T08:00:00.000Z", {
    url: "https://shokz.com/pages/opendots-2",
    finalUrl: "https://shokz.com/pages/opendots-2",
    canonical: "https://shokz.com/pages/opendots",
    canonicalStatus: {
      ok: false,
      status: 404,
      finalUrl: "https://shokz.com/pages/opendots",
      checkedAt: "2026-05-01T08:00:01.000Z"
    },
    hreflangs: []
  }));

  assert.equal(record.issueCount, 2);
  assert.ok(record.issues.some((issue) => issue.code === "canonical-http-error" && issue.level === "P0"));
  assert.ok(record.issues.some((issue) => issue.code === "hreflang-missing-region-pair" && issue.level === "P1"));
});

test("accepts Shokz product pages with live canonical and US/CA hreflang pair", () => {
  const record = normalizeSeoSnapshotRecord(seoSnapshot("seo-1", "snap-1", "2026-05-01T08:00:00.000Z", {
    url: "https://shokz.com/products/opendots-2",
    finalUrl: "https://shokz.com/products/opendots-2",
    canonical: "https://shokz.com/products/opendots-2",
    canonicalStatus: {
      ok: true,
      status: 200,
      finalUrl: "https://shokz.com/products/opendots-2",
      checkedAt: "2026-05-01T08:00:01.000Z"
    },
    hreflangs: [
      { hreflang: "en-US", href: "https://shokz.com/products/opendots-2" },
      { hreflang: "en-CA", href: "https://ca.shokz.com/products/opendots-2" }
    ]
  }));

  assert.equal(record.issueCount, 0);
});

test("flags duplicated title prefixes and inline TODO notes", () => {
  const record = normalizeSeoSnapshotRecord(seoSnapshot("seo-1", "snap-1", "2026-05-01T08:00:00.000Z", {
    title: "OpenDots 2OpenDots 2 Clip-on Earbuds - Shokz",
    technicalNotes: ["// TODO: remove me, 2026 campaign cleanup"]
  }));

  assert.ok(record.issues.some((issue) => issue.code === "title-leading-duplicate" && issue.level === "P1"));
  assert.ok(record.issues.some((issue) => issue.code === "technical-todo-comment" && issue.level === "P2"));
});

test("stores SEO snapshots and deletes records by source snapshot id", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jietu-seo-"));
  const seoSnapshotsFilePath = path.join(tempDir, "seo-snapshots.json");
  const seoChangesFilePath = path.join(tempDir, "seo-changes.json");

  await appendSeoSnapshots([
    seoSnapshot("seo-1", "snap-1", "2026-05-01T08:00:00.000Z", { title: "Before" }),
    seoSnapshot("seo-2", "snap-2", "2026-05-01T09:00:00.000Z", { title: "After" })
  ], seoSnapshotsFilePath);

  assert.equal((await loadSeoSnapshots(seoSnapshotsFilePath)).length, 2);
  const result = await deleteSeoSnapshotsForSnapshotIds(["snap-1"], {
    seoSnapshotsFilePath,
    seoChangesFilePath
  });

  assert.equal(result.deletedCount, 1);
  assert.deepEqual((await loadSeoSnapshots(seoSnapshotsFilePath)).map((snapshot) => snapshot.snapshotId), ["snap-2"]);
  assert.deepEqual(await loadSeoChanges(seoChangesFilePath), []);
});

function seoSnapshot(id, snapshotId, capturedAt, content = {}) {
  return {
    id,
    snapshotId,
    capturedAt,
    url: content.url || "https://example.com/page",
    finalUrl: content.finalUrl || content.url || "https://example.com/page",
    targetId: "example-page",
    displayUrl: "Example Page",
    platform: "pc",
    devicePresetId: "pc-hd",
    content: {
      title: content.title || "",
      metaDescription: content.metaDescription || "",
      metaKeywords: content.metaKeywords || "",
      canonical: content.canonical || "https://example.com/page",
      canonicalStatus: content.canonicalStatus || null,
      robots: content.robots || "index,follow",
      h1: content.h1 || ["Example Page"],
      headings: content.headings || [{ level: "h1", text: "Example Page" }],
      tableHeaders: content.tableHeaders || [],
      navItems: content.navItems || ["Products", "Support"],
      jsonLdTypes: content.jsonLdTypes || ["WebPage"],
      hreflangs: content.hreflangs || [],
      technicalNotes: content.technicalNotes || [],
      imageAlt: content.imageAlt || { total: 1, missing: 0 },
      linkCounts: content.linkCounts || { total: 2, internal: 1, external: 1 }
    }
  };
}
