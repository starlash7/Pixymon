import fs from "node:fs";
import path from "node:path";
import type { XApiCostRuntimeSettings } from "../../types/runtime.js";
import { xApiBudget } from "../x-api-budget.js";
import type { EditorialContextItemV2 } from "./contracts.js";
import { MENTION_MAX_AGE_MS_V2, tweetCreatedAtMsV2, X_READ_COST_PER_POST_USD_V2 } from "./mentions.js";

/** The smallest page X allows for a user timeline. */
export const TRAINER_POLL_MAX_RESULTS_V2 = 5;
const MAX_REMEMBERED_POSTS = 5;

export interface TrainerTimelineClientV2 {
  userByUsername(username: string): Promise<{ data?: { id: string } }>;
  userTimeline(userId: string, options: Record<string, unknown>): Promise<{
    data?: { data?: Array<{ id: string; text: string }> };
  }>;
}

interface TrainerStateV2 {
  userId?: string;
  sinceId?: string;
  lastPolledAt?: string;
  /** The trainer's latest posts, newest first; thoughts use them as trainer material. */
  recent?: Array<{ id: string; text: string }>;
}

function readState(file: string): TrainerStateV2 {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as TrainerStateV2; } catch { return {}; }
}

function writeState(file: string, state: TrainerStateV2): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** The trainer's posts from the last 48h, as material for thoughts (nothing when stale or never read). */
export function loadTrainerPostsV2(input: { statePath: string; handle: string; now: Date }): EditorialContextItemV2[] {
  const recent = readState(input.statePath).recent ?? [];
  return recent
    .filter((post) => input.now.getTime() - tweetCreatedAtMsV2(post.id) <= MENTION_MAX_AGE_MS_V2)
    .map((post, index) => ({
      id: `trainer:post:${index}`, kind: "trainer" as const, label: `주인님(@${input.handle})이 X에 쓴 글`,
      text: post.text.replace(/\s+/gu, " ").trim().slice(0, 200), provider: "x",
      url: `https://x.com/${input.handle}/status/${post.id}`, publishedAt: new Date(tweetCreatedAtMsV2(post.id)).toISOString(),
    }));
}

/**
 * Reads the trainer's newest original posts (no replies or reposts) and keeps them as material for
 * thoughts. X does not let a bot reply to posts that do not mention it, so Pixymon talks about them in
 * its own posts instead. Reads are budgeted at their worst case; the user id lookup is cached.
 */
export async function readTrainerPostsV2(input: {
  client: TrainerTimelineClientV2;
  trainerHandle: string;
  statePath: string;
  timezone: string;
  xApiCost: XApiCostRuntimeSettings;
  minPollMinutes: number;
  now?: Date;
}): Promise<{ polled: boolean; reason?: string; read: number }> {
  const now = input.now ?? new Date();
  const state = readState(input.statePath);
  const budget = (kind: string, estimatedReadCostUsd: number, minIntervalMinutes: number) => xApiBudget.checkReadAllowance({
    enabled: input.xApiCost.enabled, timezone: input.timezone, dailyMaxUsd: input.xApiCost.dailyMaxUsd,
    estimatedReadCostUsd, dailyReadRequestLimit: input.xApiCost.dailyReadRequestLimit, kind, minIntervalMinutes,
  });
  let userId = state.userId;
  if (!userId) {
    const lookup = budget("read:trainer-lookup-v2", X_READ_COST_PER_POST_USD_V2, 0);
    if (!lookup.allowed) return { polled: false, reason: lookup.reason, read: 0 };
    const user = await input.client.userByUsername(input.trainerHandle);
    xApiBudget.recordRead({ timezone: input.timezone, estimatedReadCostUsd: X_READ_COST_PER_POST_USD_V2, kind: "read:trainer-lookup-v2" });
    userId = user.data?.id;
    if (!userId) return { polled: false, reason: "trainer-not-found", read: 0 };
    writeState(input.statePath, { ...state, userId });
  }
  const guard = budget("read:trainer-posts-v2", X_READ_COST_PER_POST_USD_V2 * TRAINER_POLL_MAX_RESULTS_V2, input.minPollMinutes);
  if (!guard.allowed) return { polled: false, reason: guard.reason, read: 0 };
  const response = await input.client.userTimeline(userId, {
    max_results: TRAINER_POLL_MAX_RESULTS_V2,
    exclude: ["replies", "retweets"],
    "tweet.fields": ["created_at"],
    ...(state.sinceId ? { since_id: state.sinceId } : {}),
  });
  const rows = response.data?.data ?? [];
  xApiBudget.recordRead({ timezone: input.timezone, estimatedReadCostUsd: X_READ_COST_PER_POST_USD_V2 * Math.max(1, rows.length), kind: "read:trainer-posts-v2" });
  const newestFirst = [...rows].sort((a, b) => (a.id.length === b.id.length ? b.id.localeCompare(a.id) : b.id.length - a.id.length));
  const recent = [...newestFirst, ...(state.recent ?? [])]
    .filter((post, index, all) => all.findIndex((other) => other.id === post.id) === index)
    .slice(0, MAX_REMEMBERED_POSTS);
  writeState(input.statePath, { userId, sinceId: newestFirst[0]?.id ?? state.sinceId, lastPolledAt: now.toISOString(), recent });
  return { polled: true, read: rows.length };
}
