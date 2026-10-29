import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { loadRuntimeConfig } from "../src/config/runtime.js";
import { resolveDataDir } from "../src/services/data-dir.js";
import { EditorialEventStoreV2 } from "../src/services/editorial-v2/event-store.js";
import { resolveEditorialRuntimePathsV2 } from "../src/services/editorial-v2/paths.js";
import { collectEditorialEvidenceV2 } from "../src/services/editorial-v2/provider-adapters.js";
import { assertAutoPublishPolicyV2, autoPublishEnabledV2 } from "../src/services/editorial-v2/publication-policy.js";
import {
  bettablePricesV2,
  buildThoughtMaterialV2,
  DEFAULT_THOUGHT_DAILY_LIMIT_V2,
  draftThoughtV2,
  publishThoughtV2,
  resolveDueBetsV2,
  resultMaterialV2,
  selectThoughtSeedV2,
  ThoughtLedgerV2,
  thoughtDueV2,
} from "../src/services/editorial-v2/thoughts.js";
import { loadTrainerNotesV2, trainerHandleV2, trainerNotesPathV2 } from "../src/services/editorial-v2/trainer.js";
import { loadTrainerPostsV2 } from "../src/services/editorial-v2/trainer-posts.js";
import { createAnthropicEditorialWriterV2 } from "../src/services/editorial-v2/writer.js";
import { initClaudeClient } from "../src/services/llm.js";
import { acquireRuntimeLock } from "../src/services/process-lock.js";
import { initTwitterClient, postTweet, TEST_MODE, TEST_NO_EXTERNAL_CALLS } from "../src/services/twitter.js";
import { editorialVerificationRepositoryStateV2 } from "./editorial-repository-state.js";

/** Local hours (dailyTimezone) when a thought may go out; nobody reads a 4am musing. */
function inPostingHours(now: Date, timezone: string): boolean {
  const [from, to] = String(process.env.PIXYMON_THOUGHT_HOURS || "8-23").split("-").map(Number);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(now));
  return hour >= from && hour <= to;
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const now = new Date();
  if (config.operational.actionMode !== "live") throw new Error("editorial:thought requires ACTION_MODE=live");
  if (TEST_MODE || TEST_NO_EXTERNAL_CALLS) throw new Error("editorial:thought refuses TEST_MODE or TEST_NO_EXTERNAL_CALLS");
  const dataDir = resolveDataDir();
  assertAutoPublishPolicyV2({ enabled: autoPublishEnabledV2(), stopPath: path.join(dataDir, "editorial-v2", "STOP"),
    workingTreeClean: editorialVerificationRepositoryStateV2().workingTreeClean });
  const ledger = new ThoughtLedgerV2(path.join(dataDir, "editorial-v2", "thoughts.ndjson"));
  const betsDue = ledger.openBets().some((open) => Date.parse(open.bet.dueAt) <= now.getTime());
  const limit = Number(process.env.PIXYMON_THOUGHT_DAILY_LIMIT ?? DEFAULT_THOUGHT_DAILY_LIMIT_V2);
  const due = inPostingHours(now, config.dailyTimezone)
    ? thoughtDueV2(ledger, { dailyLimit: Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_THOUGHT_DAILY_LIMIT_V2, timezone: config.dailyTimezone, now })
    : { due: false as const, reason: "outside-posting-hours" };
  if (!due.due && !betsDue) { console.log(`[THOUGHT] skip reason=${due.reason}`); return; }

  const paths = resolveEditorialRuntimePathsV2("live");
  const lock = acquireRuntimeLock(paths.publishLockPath);
  if (!lock.acquired) throw new Error(lock.reason || "another editorial publish is running");
  try {
    const twitter = initTwitterClient();
    if (!twitter) throw new Error("Twitter credentials are required");
    // Free providers only; the material is what Pixymon "ate" this hour.
    const sensing = await collectEditorialEvidenceV2({ now: now.toISOString(), includeGenericCandidates: true,
      cryptoCompareApiKey: process.env.CRYPTOCOMPARE_API_KEY });
    const trainerNotes = [
      ...loadTrainerPostsV2({ statePath: path.join(dataDir, "editorial-v2", "trainer-state.json"), handle: trainerHandleV2(), now }),
      ...loadTrainerNotesV2({ notesPath: trainerNotesPathV2(), handle: trainerHandleV2(), now }),
    ];
    // Grading is free (the same price fetch) and happens even when no post is due.
    const prices = bettablePricesV2(sensing);
    const graded = resolveDueBetsV2(ledger, prices, now);
    if (graded.length) console.log(`[THOUGHT] graded ${graded.map((entry) => `${entry.id}:${entry.outcome}`).join(",")}`);
    if (!due.due) { console.log(`[THOUGHT] skip reason=${due.reason}`); return; }
    const progress = ledger.progress();
    const pending = ledger.pendingResults()[0];
    const material = pending
      ? resultMaterialV2(pending)
      : buildThoughtMaterialV2(sensing, trainerNotes);
    const originals = fs.existsSync(paths.eventLogPath)
      ? new EditorialEventStoreV2({ eventLogPath: paths.eventLogPath }).listDraftStates()
        .filter((state) => state.publication?.publishedText)
        .map((state) => ({ text: state.publication!.publishedText, at: state.publication!.publishedAt }))
      : [];
    const thoughts = ledger.published();
    const recentPosts = [...originals, ...thoughts.map((entry) => ({ text: entry.text, at: entry.publishedAt }))]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 6).map((post) => post.text);
    const journal = ledger.journal();
    // A graded bet is announced before anything else; that is the story people follow.
    const seed = pending ? "result" : selectThoughtSeedV2({ publishedCount: thoughts.length, hasJournal: journal.length > 0,
      hasTrainer: trainerNotes.length > 0 });
    const claude = initClaudeClient();
    const drafted = await draftThoughtV2({
      model: createAnthropicEditorialWriterV2(claude, config.dailyTimezone, "write"),
      critic: createAnthropicEditorialWriterV2(claude, config.dailyTimezone, "critique"),
      seed, material, journal, recentPosts, trainerHandle: trainerHandleV2(), progress, prices, now,
    });
    if (drafted.status === "blocked") { console.log(`[THOUGHT] no-post seed=${seed} reason=${drafted.reason}`); return; }
    const id = ledger.recordDraft({ text: drafted.text, journal: drafted.journal, seed, bet: drafted.bet,
      ...(pending ? { resultFor: pending.id } : {}) });
    const result = await publishThoughtV2({ ledger, id, text: drafted.text,
      dispatch: (text, beforeSend) => postTweet(twitter, text, "briefing", {
        timezone: config.dailyTimezone, xApiCostSettings: config.xApiCost, createKind: "editorial-v2:thought", maxAttempts: 1, beforeSend,
      }) });
    console.log(`[THOUGHT] ${result.status} seed=${seed}${drafted.bet ? ` bet=$${drafted.bet.symbol}:${drafted.bet.direction}:${drafted.bet.horizonHours}h` : ""}${"xId" in result ? ` id=${result.xId}` : ` reason=${result.reason}`} :: ${drafted.text}`);
  } finally {
    lock.release();
  }
}

main().catch((error) => {
  console.error(`[THOUGHT] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
