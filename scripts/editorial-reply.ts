import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { loadRuntimeConfig } from "../src/config/runtime.js";
import { resolveDataDir } from "../src/services/data-dir.js";
import { assertExternalCallsAllowed } from "../src/services/external-call-policy.js";
import { initClaudeClient } from "../src/services/llm.js";
import { initTwitterClient, postTweet, TEST_MODE, TEST_NO_EXTERNAL_CALLS } from "../src/services/twitter.js";
import { createAnthropicEditorialWriterV2 } from "../src/services/editorial-v2/writer.js";
import { autoPublishEnabledV2 } from "../src/services/editorial-v2/publication-policy.js";
import {
  DEFAULT_REPLY_DAILY_LIMIT_V2,
  draftRepliesV2,
  parseReplyTargetUrlV2,
  publishReplyV2,
  releaseReplyV2,
  ReplyLedgerV2,
} from "../src/services/editorial-v2/replies.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function show(ledger: ReplyLedgerV2, id: string): void {
  const draft = ledger.draft(id);
  if (!draft) throw new Error(`unknown reply id ${id}`);
  console.log(`[REPLY] ${draft.id} → @${draft.target.author}${draft.target.trainer ? " (주인님)" : ""} ${draft.target.url}`);
  draft.candidates.forEach((candidate, index) => {
    const ok = candidate.reasons.length === 0 && candidate.critic === "pass";
    console.log(`  ${index + 1}. [${ok ? "OK" : `BLOCKED ${[...candidate.reasons, candidate.critic !== "pass" ? `critic:${candidate.critic}` : ""].filter(Boolean).join(",")}`}] ${candidate.text}${candidate.criticNote ? `\n     critic: ${candidate.criticNote}` : ""}`);
  });
}

async function publish(ledger: ReplyLedgerV2, id: string, pick: number): Promise<void> {
  const config = loadRuntimeConfig();
  if (config.operational.actionMode !== "live") throw new Error("editorial:reply publish requires ACTION_MODE=live");
  if (TEST_MODE || TEST_NO_EXTERNAL_CALLS) throw new Error("editorial:reply publish refuses TEST_MODE or TEST_NO_EXTERNAL_CALLS");
  // The same kill switch as originals: an operator STOP file suspends every send.
  if (fs.existsSync(path.join(resolveDataDir(), "editorial-v2", "STOP"))) throw new Error("editorial-live-suspended");
  const twitter = initTwitterClient();
  if (!twitter) throw new Error("Twitter credentials are required");
  const limit = Number(process.env.PIXYMON_REPLY_DAILY_LIMIT || DEFAULT_REPLY_DAILY_LIMIT_V2);
  const result = await publishReplyV2({
    ledger, id, pick, timezone: config.dailyTimezone, dailyLimit: Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_REPLY_DAILY_LIMIT_V2,
    dispatch: (text, replyToTweetId, beforeSend) => postTweet(twitter, text, "reply", {
      replyToTweetId, maxAttempts: 1, createKind: "reply:v2", timezone: config.dailyTimezone, xApiCostSettings: config.xApiCost, beforeSend,
    }),
  });
  console.log(result.status === "published" ? `[REPLY] published https://x.com/Pixy_mon/status/${result.xId}` : `[REPLY] blocked: ${result.reason}`);
  if (result.status !== "published") process.exitCode = 2;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const ledger = new ReplyLedgerV2(path.join(resolveDataDir(), "editorial-v2", "replies.ndjson"));
  if (command === "draft") {
    assertExternalCallsAllowed("editorial:reply draft");
    const url = arg("url");
    const textFile = arg("text-file");
    const text = textFile ? fs.readFileSync(textFile, "utf8") : arg("text");
    if (!url || !text?.trim()) throw new Error("usage: editorial:reply draft --url <x.com/.../status/id> (--text-file <file> | --text <text>)");
    const parsed = parseReplyTargetUrlV2(url);
    const claude = initClaudeClient();
    const model = createAnthropicEditorialWriterV2(claude, undefined, "write");
    const critic = createAnthropicEditorialWriterV2(claude, undefined, "critique");
    const target = { ...parsed, url, text: text.trim().slice(0, 4000) };
    const candidates = await draftRepliesV2({ model, critic, target });
    const id = ledger.recordDraft(target, candidates, model.modelId ?? "unknown");
    show(ledger, id);
    if (process.argv.includes("--auto-publish")) {
      if (!autoPublishEnabledV2()) throw new Error("auto-publish-disabled (set PIXYMON_AUTO_PUBLISH=true)");
      const pick = candidates.findIndex((candidate) => candidate.reasons.length === 0 && candidate.critic === "pass") + 1;
      if (pick === 0) {
        console.log("[REPLY] no candidate passed every check; nothing published");
        process.exitCode = 2;
        return;
      }
      await publish(ledger, id, pick);
    }
    return;
  }
  if (command === "show") {
    const id = arg("id");
    if (!id) throw new Error("usage: editorial:reply show --id <replyId>");
    show(ledger, id);
    return;
  }
  if (command === "publish") {
    const id = arg("id");
    const pick = Number(arg("pick"));
    if (!id || !Number.isInteger(pick) || pick < 1) throw new Error("usage: editorial:reply publish --id <replyId> --pick <n>");
    await publish(ledger, id, pick);
    return;
  }
  if (command === "release") {
    // Only after checking on X that the reply is not on the account.
    const id = arg("id");
    const reason = arg("reason");
    if (!id || !reason) throw new Error("usage: editorial:reply release --id <replyId> --reason <checked-on-x-not-posted>");
    process.stdout.write(`${JSON.stringify(releaseReplyV2(ledger, id, reason))}\n`);
    return;
  }
  throw new Error("usage: editorial:reply (draft|show|publish|release) ...");
}

main().catch((error) => {
  console.error(`[REPLY] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
