import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { safeJoin } from "../src/path-safety.js";

test("safeJoin keeps normal paths inside the requested root", () => {
  const root = path.resolve("tmp", "archive");

  assert.equal(
    safeJoin(root, "/2026-05-14/shokz/snap.png"),
    path.join(root, "2026-05-14", "shokz", "snap.png")
  );
  assert.equal(
    safeJoin(root, "..cache/snap.png"),
    path.join(root, "..cache", "snap.png")
  );
});

test("safeJoin rejects sibling directories with the same root prefix", () => {
  const root = path.resolve("tmp", "archive");

  assert.equal(
    safeJoin(root, "../archive-backup/secret.png"),
    null
  );
});
