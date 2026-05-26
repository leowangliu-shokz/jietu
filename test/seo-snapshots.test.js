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
  loadSeoSnapshots
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
    url: "https://example.com/page",
    finalUrl: "https://example.com/page",
    targetId: "example-page",
    displayUrl: "Example Page",
    platform: "pc",
    devicePresetId: "pc-hd",
    content: {
      title: content.title || "",
      metaDescription: content.metaDescription || "",
      metaKeywords: content.metaKeywords || "",
      canonical: content.canonical || "https://example.com/page",
      robots: content.robots || "index,follow",
      h1: content.h1 || ["Example Page"],
      headings: content.headings || [{ level: "h1", text: "Example Page" }],
      tableHeaders: content.tableHeaders || [],
      navItems: content.navItems || ["Products", "Support"],
      jsonLdTypes: content.jsonLdTypes || ["WebPage"],
      imageAlt: content.imageAlt || { total: 1, missing: 0 },
      linkCounts: content.linkCounts || { total: 2, internal: 1, external: 1 }
    }
  };
}
