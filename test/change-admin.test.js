import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deleteChangeAction,
  deleteChangesAction,
  deleteChangesArchive
} from "../src/change-admin.js";

test("deleteChangesArchive removes multiple change records from the generated store", async () => {
  const fixture = await createFixture();
  await writeChanges(fixture.changesFilePath, [
    change("change-3", "2026-05-12T09:20:00.000Z"),
    change("change-2", "2026-05-12T09:10:00.000Z"),
    change("change-1", "2026-05-12T09:00:00.000Z")
  ]);

  const result = await deleteChangesArchive(["change-1", "change-2", "change-1"], {
    changesFilePath: fixture.changesFilePath
  });

  assert.deepEqual(result.deletedChangeIds, ["change-1", "change-2"]);
  assert.equal(result.changeRefresh.count, 1);
  const remaining = JSON.parse(await fs.readFile(fixture.changesFilePath, "utf8"));
  assert.deepEqual(remaining.map((item) => item.id), ["change-3"]);
});

test("deleteChangesAction returns deleted ids and refreshed state for a batch", async () => {
  const fixture = await createFixture();
  await writeChanges(fixture.changesFilePath, [
    change("change-1", "2026-05-12T09:00:00.000Z"),
    change("change-2", "2026-05-12T09:10:00.000Z")
  ]);

  const result = await deleteChangesAction({
    canDeleteChanges: true,
    captureRunning: false,
    changeIds: ["change-1", "change-2"],
    changesFilePath: fixture.changesFilePath,
    buildState: async () => ({ ok: true })
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.deepEqual(result.payload.deletedChangeIds, ["change-1", "change-2"]);
  assert.deepEqual(result.payload.state, { ok: true });
  assert.deepEqual(JSON.parse(await fs.readFile(fixture.changesFilePath, "utf8")), []);
});

test("deleteChangeAction returns 404 when the change id does not exist", async () => {
  const fixture = await createFixture();
  await writeChanges(fixture.changesFilePath, [change("change-1", "2026-05-12T09:00:00.000Z")]);

  const result = await deleteChangeAction({
    canDeleteChanges: true,
    captureRunning: false,
    changeId: "missing-change",
    changesFilePath: fixture.changesFilePath
  });

  assert.equal(result.status, 404);
  assert.equal(result.payload.ok, false);
  assert.match(result.payload.error, /missing-change/);
});

test("deleteChangesAction rejects disabled or capture-running deletion", async () => {
  const disabled = await deleteChangesAction({
    canDeleteChanges: false,
    captureRunning: false,
    changeIds: ["change-1"]
  });
  assert.equal(disabled.status, 403);
  assert.equal(disabled.payload.ok, false);

  const running = await deleteChangesAction({
    canDeleteChanges: true,
    captureRunning: true,
    changeIds: ["change-1"]
  });
  assert.equal(running.status, 409);
  assert.equal(running.payload.ok, false);
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-change-delete-"));
  return {
    root,
    changesFilePath: path.join(root, "changes.json")
  };
}

async function writeChanges(filePath, changes) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(changes, null, 2)}\n`, "utf8");
}

function change(id, capturedAt) {
  return {
    id,
    location: {
      platform: "pc",
      devicePresetId: "pc-hd"
    },
    to: { capturedAt }
  };
}
