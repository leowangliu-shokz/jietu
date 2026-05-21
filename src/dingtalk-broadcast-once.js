import { buildDingTalkBroadcastMessage, sendDingTalkMessage } from "./change-notifier.js";

const args = parseArgs(process.argv.slice(2));
const text = decodeBase64Option(args["text-b64"] || process.env.DINGTALK_BROADCAST_TEXT_B64) ||
  args.text ||
  process.env.DINGTALK_BROADCAST_TEXT;
const title = decodeBase64Option(args["title-b64"] || process.env.DINGTALK_BROADCAST_TITLE_B64) ||
  args.title ||
  process.env.DINGTALK_BROADCAST_TITLE;
const imageUrl = args["image-url"] || process.env.DINGTALK_BROADCAST_IMAGE_URL || null;

const body = buildDingTalkBroadcastMessage({
  title,
  text,
  imageUrl,
  atMobiles: listOption(args["at-mobiles"] || process.env.DINGTALK_AT_MOBILES),
  atAll: booleanOption(args["at-all"] ?? process.env.DINGTALK_AT_ALL, false)
});
const result = await sendDingTalkMessage(body);

console.log(JSON.stringify({
  ok: result.ok,
  enabled: result.enabled,
  channel: result.channel || null,
  response: result.response || null,
  title: body.markdown.title
}, null, 2));

if (!result.ok) {
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function decodeBase64Option(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  return Buffer.from(text, "base64").toString("utf8");
}

function listOption(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function booleanOption(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}
