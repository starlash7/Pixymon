import test from "node:test";
import assert from "node:assert/strict";
import { __trendTargetTest } from "../src/services/twitter.ts";

test("isPreferredTrendReplyTarget rejects low-follower unverified account", () => {
  const ok = __trendTargetTest.isPreferredTrendReplyTarget(
    {
      id: "1",
      conversation_id: "1",
      created_at: new Date().toISOString(),
      text: "Onchain infra note with enough detail to look like a real market comment, not a short spam line.",
    },
    { verified: false, public_metrics: { followers_count: 1200 } },
    { engagementRaw: 42, score: 5.2 },
    0.62,
    { minSourceTrust: 0.45, minScore: 3.2, minEngagement: 12, maxAgeHours: 24, requireRootPost: true, blockSuspiciousPromo: true }
  );
  assert.equal(ok, false);
});

test("isPreferredTrendReplyTarget accepts solid unverified account above relaxed floor", () => {
  const ok = __trendTargetTest.isPreferredTrendReplyTarget(
    {
      id: "1",
      conversation_id: "1",
      created_at: new Date().toISOString(),
      text: "Protocol rollout note with enough context, a clear claim, and enough detail to look like a serious target for reply.",
    },
    { verified: false, public_metrics: { followers_count: 4200 } },
    { engagementRaw: 24, score: 4.4 },
    0.52,
    { minSourceTrust: 0.45, minScore: 3.2, minEngagement: 12, maxAgeHours: 24, requireRootPost: true, blockSuspiciousPromo: true }
  );
  assert.equal(ok, true);
});

test("isPreferredTrendReplyTarget accepts verified credible account", () => {
  const ok = __trendTargetTest.isPreferredTrendReplyTarget(
    {
      id: "1",
      conversation_id: "1",
      created_at: new Date().toISOString(),
      text: "Protocol upgrade thread with enough context and detail to qualify as a serious target for a reply.",
    },
    { verified: true, public_metrics: { followers_count: 22000 } },
    { engagementRaw: 84, score: 6.1 },
    0.67,
    { minSourceTrust: 0.45, minScore: 3.2, minEngagement: 12, maxAgeHours: 24, requireRootPost: true, blockSuspiciousPromo: true }
  );
  assert.equal(ok, true);
});

test("isPreferredTrendReplyTarget rejects old tweets", () => {
  const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
  const ok = __trendTargetTest.isPreferredTrendReplyTarget(
    {
      id: "1",
      conversation_id: "1",
      created_at: oldDate,
      text: "Long market structure post with enough context to look credible, but it is too old to revive in replies.",
    },
    { verified: true, public_metrics: { followers_count: 50000 } },
    { engagementRaw: 400, score: 7.1 },
    0.81,
    { minSourceTrust: 0.45, minScore: 3.2, minEngagement: 12, maxAgeHours: 24, requireRootPost: true, blockSuspiciousPromo: true }
  );
  assert.equal(ok, false);
});

test("isPreferredTrendReplyTarget rejects replies and quoted posts", () => {
  const ok = __trendTargetTest.isPreferredTrendReplyTarget(
    {
      id: "99",
      conversation_id: "11",
      created_at: new Date().toISOString(),
      referenced_tweets: [{ type: "replied_to" }],
      text: "This is a reply in a thread even though it looks detailed and high-signal on the surface.",
    },
    { verified: true, public_metrics: { followers_count: 18000 } },
    { engagementRaw: 84, score: 6.1 },
    0.74,
    { minSourceTrust: 0.45, minScore: 3.2, minEngagement: 12, maxAgeHours: 24, requireRootPost: true, blockSuspiciousPromo: true }
  );
  assert.equal(ok, false);
});

test("isPreferredTrendReplyTarget rejects suspicious telegram or link promo accounts", () => {
  const ok = __trendTargetTest.isPreferredTrendReplyTarget(
    {
      id: "1",
      conversation_id: "1",
      created_at: new Date().toISOString(),
      text: "Macro thread with enough detail, but the account profile pushes people into an external group.",
    },
    {
      verified: true,
      username: "marketalpha",
      description: "Join our Telegram for VIP signals",
      url: "https://t.me/marketalpha",
      public_metrics: { followers_count: 22000 },
    },
    { engagementRaw: 84, score: 6.1 },
    0.67,
    { minSourceTrust: 0.45, minScore: 3.2, minEngagement: 12, maxAgeHours: 24, requireRootPost: true, blockSuspiciousPromo: true }
  );
  assert.equal(ok, false);
});
