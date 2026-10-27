import fs from "node:fs";
import path from "node:path";
import type { XApiCostRuntimeSettings } from "../../types/runtime.js";
import { xApiBudget } from "../x-api-budget.js";
import { draftRepliesV2, publishReplyV2, type ReplyLedgerV2, type ReplyTargetV2 } from "./replies.js";
import type { EditorialWriterModelV2 } from "./writer.js";

/** Pay-per-use X bills each post read; a poll is budgeted at its worst case before it is sent. */
export const X_READ_COST_PER_POST_USD_V2 = 0.005;
export const MENTION_POLL_MAX_RESULTS_V2 = 5;

export interface MentionV2 {
  id: string;
  text: string;
  authorId: string;
  username: string;
}

export interface MentionTimelineClientV2 {
  userMentionTimeline(userId: string, options: Record<string, unknown>): Promise<{
    data?: { data?: Array<{ id: string; text: string; author_id?: string }>; includes?: { users?: Array<{ id: string; username: string }> } };
  }>;
}

interface MentionStateV2 { sinceId?: string; lastPolledAt?: string }

function readState(file: string): MentionStateV2 {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as MentionStateV2; } catch { return {}; }
}

function writeState(file: string, state: MentionStateV2): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** Skip what is not a conversation: our own posts, link drops and tag storms. */
export function mentionSkipReasonV2(mention: MentionV2, selfId: string): string | undefined {
  if (mention.authorId === selfId) return "self";
  if (/https?:\/\/|www\./iu.test(mention.text)) return "link";
  if ((mention.text.match(/@[A-Za-z0-9_]{1,15}/gu) || []).length > 3) return "tag-storm";
  if (mention.text.replace(/@[A-Za-z0-9_]{1,15}/gu, "").trim().length < 2) return "empty";
  return undefined;
}

function compareIds(a: string, b: string): number {
  return a.length === b.length ? a.localeCompare(b) : a.length - b.length;
}

/**
 * Read new mentions of Pixymon (oldest first) and reply to each one that passes every check, within the
 * reply daily limit. The since-id advances only past mentions that were handled or deliberately skipped,
 * so a daily-limit stop leaves the rest for the next poll.
 */
export async function replyToNewMentionsV2(input: {
  client: MentionTimelineClientV2;
  selfId: string;
  statePath: string;
  ledger: ReplyLedgerV2;
  model: EditorialWriterModelV2;
  critic: EditorialWriterModelV2;
  dispatch: (text: string, replyToTweetId: string, beforeSend: () => void) => Promise<string | null>;
  trainerHandle: string;
  timezone: string;
  xApiCost: XApiCostRuntimeSettings;
  replyDailyLimit: number;
  maxRepliesPerRun: number;
  minPollMinutes: number;
  now?: Date;
}): Promise<{ polled: boolean; reason?: string; read: number; replied: string[]; skipped: Array<[string, string]> }> {
  const state = readState(input.statePath);
  const worstCase = X_READ_COST_PER_POST_USD_V2 * MENTION_POLL_MAX_RESULTS_V2;
  const guard = xApiBudget.checkReadAllowance({
    enabled: input.xApiCost.enabled, timezone: input.timezone, dailyMaxUsd: input.xApiCost.dailyMaxUsd,
    estimatedReadCostUsd: worstCase, dailyReadRequestLimit: input.xApiCost.dailyReadRequestLimit,
    kind: "read:mentions-v2", minIntervalMinutes: input.minPollMinutes,
  });
  if (!guard.allowed) return { polled: false, reason: guard.reason, read: 0, replied: [], skipped: [] };
  const response = await input.client.userMentionTimeline(input.selfId, {
    max_results: MENTION_POLL_MAX_RESULTS_V2,
    "tweet.fields": ["author_id", "created_at", "conversation_id"],
    expansions: ["author_id"],
    "user.fields": ["username"],
    ...(state.sinceId ? { since_id: state.sinceId } : {}),
  });
  const rows = response.data?.data ?? [];
  xApiBudget.recordRead({ timezone: input.timezone, estimatedReadCostUsd: X_READ_COST_PER_POST_USD_V2 * Math.max(1, rows.length), kind: "read:mentions-v2" });
  const users = new Map((response.data?.includes?.users ?? []).map((user) => [user.id, user.username]));
  const mentions: MentionV2[] = rows
    .map((row) => ({ id: row.id, text: row.text, authorId: row.author_id ?? "", username: users.get(row.author_id ?? "") ?? "" }))
    .sort((a, b) => compareIds(a.id, b.id));
  const replied: string[] = [];
  const skipped: Array<[string, string]> = [];
  let sinceId = state.sinceId;
  for (const mention of mentions) {
    const skip = mentionSkipReasonV2(mention, input.selfId) ?? (mention.username ? undefined : "unknown-author");
    if (skip) { skipped.push([mention.id, skip]); sinceId = mention.id; continue; }
    if (replied.length >= input.maxRepliesPerRun) break;
    const target: ReplyTargetV2 = {
      tweetId: mention.id, url: `https://x.com/${mention.username}/status/${mention.id}`, author: mention.username,
      text: mention.text, trainer: mention.username.toLowerCase() === input.trainerHandle.toLowerCase(),
    };
    let candidates;
    try {
      candidates = await draftRepliesV2({ model: input.model, critic: input.critic, target });
    } catch (error) {
      // Budget local-only or a model outage: stop here, keep progress, and retry this mention next poll.
      skipped.push([mention.id, `draft-failed:${error instanceof Error ? error.message : String(error)}`]);
      break;
    }
    const id = input.ledger.recordDraft(target, candidates, input.model.modelId ?? "unknown", input.now);
    const pick = candidates.findIndex((candidate) => candidate.reasons.length === 0 && candidate.critic === "pass") + 1;
    if (pick === 0) { skipped.push([mention.id, "no-passing-candidate"]); sinceId = mention.id; continue; }
    const result = await publishReplyV2({ ledger: input.ledger, id, pick, dispatch: input.dispatch, dailyLimit: input.replyDailyLimit, timezone: input.timezone, now: input.now });
    // A daily limit or a guard that declined before sending leaves this mention for the next poll.
    if (result.status === "blocked" && (result.reason === "reply-daily-limit" || result.reason.startsWith("x-not-sent"))) break;
    if (result.status === "published") replied.push(result.xId); else skipped.push([mention.id, result.reason]);
    sinceId = mention.id;
  }
  writeState(input.statePath, { sinceId, lastPolledAt: (input.now ?? new Date()).toISOString() });
  return { polled: true, read: rows.length, replied, skipped };
}
