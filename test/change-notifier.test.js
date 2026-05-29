import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertReadableDingTalkMessage,
  buildDingTalkBroadcastMessage,
  buildDingTalkMarkdownMessage,
  buildDingTalkWebhookUrl,
  notificationEligibleChanges,
  notifyChangeRecords,
  resolveChangeNotificationConfig
} from "../src/change-notifier.js";

const happyTitle = "\u4e50\u4e50\u6765\u64ad\u62a5\u4e86\uff01";
const morningBroadcast = "\u65e9\u4e0a\u597d\uff01\u4e50\u4e50\u5728\u575a\u5b88\u5c97\u4f4d\uff0c\u5927\u5bb6\u8bb0\u5f97\u51fa\u95e8\u5e26\u4f1e\u54e6~";
const monitorKeyword = "\u76d1\u63a7\u62a5\u8b66";
const bannerOneLocation = "banner\u533a-banner1";
const bannerTwoLocation = "banner\u533a-banner2";
const imageChangeType = "\u56fe\u7247\u53d8\u52a8";
const footerLocation = "\u9875\u811a";

test("leaves change notification disabled without a webhook", () => {
  const config = resolveChangeNotificationConfig({}, {});

  assert.equal(config.enabled, false);
  assert.equal(config.webhook, null);
  assert.equal(config.scope, "all");
  assert.equal(config.minLevel, "P0");
});

test("selects all P0 changes by default", () => {
  const changes = [
    change("banner-p0", { monitorScope: "all", changeLevel: "P0" }),
    change("banner-p1", { monitorScope: "all", changeLevel: "P1" }),
    change("other-p0", { monitorScope: "all", changeLevel: "P0", changeLocation: footerLocation, location: { sectionKey: "footer" } })
  ];

  assert.deepEqual(
    notificationEligibleChanges(changes, {}).map((item) => item.id),
    ["banner-p0", "other-p0"]
  );
});

test("keeps explicit home banner scope available", () => {
  const changes = [
    change("banner-p1", { monitorScope: "home-banner", changeLevel: "P1" }),
    change("banner-p2", { monitorScope: "home-banner", changeLevel: "P2" }),
    change("other-p0", { monitorScope: "all", changeLevel: "P0", changeLocation: footerLocation, location: { sectionKey: "footer" } })
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
    keyword: monitorKeyword,
    atMobiles: ["13800000000"],
    atAll: false
  });

  assert.equal(body.msgtype, "markdown");
  assert.match(body.markdown.text, textPattern(happyTitle));
  assert.match(body.markdown.text, textPattern(monitorKeyword));
  assert.match(body.markdown.text, textPattern("\u9875\u9762\u533a\u57df\u53d8\u66f4"));
  assert.match(body.markdown.text, textPattern(bannerOneLocation));
  assert.deepEqual(body.at.atMobiles, ["13800000000"]);
});

test("formats DingTalk change times in China time", () => {
  const body = buildDingTalkMarkdownMessage([change("banner-p1", {
    occurredBetween: {
      from: "2026-05-28T07:48:59.467Z",
      to: "2026-05-28T08:56:04.361Z"
    }
  })]);

  assert.match(body.markdown.text, /2026-05-28 15:48 -> 2026-05-28 16:56/);
  assert.equal(body.markdown.text.includes("2026-05-28 07:48"), false);
});

test("builds manual DingTalk broadcasts from Unicode-safe text", () => {
  const body = buildDingTalkBroadcastMessage({
    text: morningBroadcast,
    imageUrl: "https://example.com/rain.jpg"
  });

  assert.equal(body.markdown.title, happyTitle);
  assert.match(body.markdown.text, textPattern(morningBroadcast));
  assert.match(body.markdown.text, /https:\/\/example\.com\/rain\.jpg/);
  assert.doesNotThrow(() => assertReadableDingTalkMessage(body));
});

test("rejects messages that were damaged into question-mark mojibake", () => {
  assert.throws(
    () => assertReadableDingTalkMessage({
      msgtype: "markdown",
      markdown: {
        title: "???????",
        text: "????????????????????~"
      }
    }),
    /replacement question marks/
  );
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

test("records eligible changes without sending when requested", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jietu-notifier-"));
  const statePath = path.join(tempDir, "change-notifications.json");
  let calls = 0;

  const result = await notifyChangeRecords([
    change("old", { changeLocation: bannerOneLocation }),
    change("new", { changeLocation: bannerTwoLocation, location: { sectionKey: "banner", bannerIndex: 2 } })
  ], {
    webhook: "https://oapi.dingtalk.com/robot/send?access_token=token",
    statePath,
    sendNotifications: false,
    fetchImpl: async () => {
      calls += 1;
      return okResponse();
    }
  });

  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(result.recordOnly, true);
  assert.equal(result.sentCount, 0);
  assert.equal(result.recordedCount, 2);
  assert.equal(calls, 0);
  assert.deepEqual(state.notifiedIds, ["old", "new"]);
});

test("sends only changes not present in the previous change set", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jietu-notifier-"));
  const statePath = path.join(tempDir, "change-notifications.json");
  const sentBodies = [];

  const result = await notifyChangeRecords([
    change("old", { changeLocation: bannerOneLocation }),
    change("new", { changeLocation: bannerTwoLocation, location: { sectionKey: "banner", bannerIndex: 2 } })
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
  assert.match(sentBodies[0].markdown.text, textPattern(bannerTwoLocation));
  assert.equal(sentBodies[0].markdown.text.includes(bannerOneLocation), false);
  assert.deepEqual(state.notifiedIds, ["old", "new"]);
});

function change(id, overrides = {}) {
  return {
    id,
    monitorScope: "home-banner",
    changeLevel: "P0",
    changeTypes: [imageChangeType],
    changeLocation: bannerOneLocation,
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

function textPattern(text) {
  return new RegExp(escapeRegExp(text));
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
