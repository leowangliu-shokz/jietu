import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDingTalkMarkdownMessage,
  buildDingTalkWebhookUrl,
  notificationEligibleChanges,
  notifyChangeRecords,
  resolveChangeNotificationConfig
} from "../src/change-notifier.js";

test("leaves change notification disabled without a webhook", () => {
  const config = resolveChangeNotificationConfig({}, {});

  assert.equal(config.enabled, false);
  assert.equal(config.webhook, null);
});

test("selects home banner changes by scope and minimum level", () => {
  const changes = [
    change("banner-p1", { monitorScope: "home-banner", changeLevel: "P1" }),
    change("banner-p2", { monitorScope: "home-banner", changeLevel: "P2" }),
    change("other-p0", { monitorScope: "all", changeLevel: "P0", changeLocation: "页脚", location: { sectionKey: "footer" } })
  ];

  assert.deepEqual(
    notificationEligibleChanges(changes, { scope: "home-banner", minLevel: "P1" }).map((item) => item.id),
    ["banner-p1"]
  );
});

test("builds DingTalk signed webhook URL", () => {
  const webhook = "https://oapi.dingtalk.com/robot/send?access_token=token";
  const secret = "SEC-test-secret";
  const timestamp = 1760000000000;
  const url = new URL(buildDingTalkWebhookUrl(webhook, secret, timestamp));
  const expectedSign = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}\n${secret}`, "utf8")
    .digest("base64");

  assert.equal(url.searchParams.get("access_token"), "token");
  assert.equal(url.searchParams.get("timestamp"), String(timestamp));
  assert.equal(url.searchParams.get("sign"), expectedSign);
});

test("builds DingTalk markdown message with keyword and mentions", () => {
  const body = buildDingTalkMarkdownMessage([change("banner-p1")], {
    keyword: "监控报警",
    atMobiles: ["13800000000"],
    atAll: false
  });

  assert.equal(body.msgtype, "markdown");
  assert.match(body.markdown.text, /乐乐来播报了！/);
  assert.match(body.markdown.text, /监控报警/);
  assert.match(body.markdown.text, /banner区-banner1/);
  assert.deepEqual(body.at.atMobiles, ["13800000000"]);
});

test("bootstraps existing changes without sending historical notifications", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jietu-notifier-"));
  const statePath = path.join(tempDir, "change-notifications.json");
  let calls = 0;

  const result = await notifyChangeRecords([change("existing")], {
    webhook: "https://oapi.dingtalk.com/robot/send?access_token=token",
    statePath,
    bootstrap: "skip",
    fetchImpl: async () => {
      calls += 1;
      return okResponse();
    }
  });

  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(result.bootstrapped, true);
  assert.equal(result.sentCount, 0);
  assert.equal(calls, 0);
  assert.deepEqual(state.notifiedIds, ["existing"]);
});

test("sends only changes not present in the previous change set", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jietu-notifier-"));
  const statePath = path.join(tempDir, "change-notifications.json");
  const sentBodies = [];

  const result = await notifyChangeRecords([
    change("old", { changeLocation: "banner区-banner1" }),
    change("new", { changeLocation: "banner区-banner2", location: { sectionKey: "banner", bannerIndex: 2 } })
  ], {
    webhook: "https://oapi.dingtalk.com/robot/send?access_token=token",
    statePath,
    previousChanges: [change("old")],
    fetchImpl: async (url, request) => {
      sentBodies.push(JSON.parse(request.body));
      assert.match(url, /^https:\/\/oapi\.dingtalk\.com\/robot\/send/);
      return okResponse();
    }
  });

  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(result.sentCount, 1);
  assert.match(sentBodies[0].markdown.text, /banner区-banner2/);
  assert.equal(sentBodies[0].markdown.text.includes("banner区-banner1"), false);
  assert.deepEqual(state.notifiedIds, ["old", "new"]);
});

function change(id, overrides = {}) {
  return {
    id,
    monitorScope: "home-banner",
    changeLevel: "P1",
    changeTypes: ["图片变动"],
    changeLocation: "banner区-banner1",
    occurredBetween: {
      from: "2026-05-19T10:00:00.000Z",
      to: "2026-05-20T10:00:00.000Z"
    },
    location: {
      sectionKey: "banner",
      bannerIndex: 1
    },
    ...overrides
  };
}

function okResponse() {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ errcode: 0, errmsg: "ok" });
    }
  };
}
