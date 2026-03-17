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
    { verified: false, public_metrics: { followers_count: 320 } },
    { engagementRaw: 7, score: 2.9 },
    0.39,
    { minSourceTrust: 0.38, minScore: 2.6, minEngagement: 4, maxAgeHours: 24, requireRootPost: true, blockSuspiciousPromo: true }
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

test("isPreferredTrendReplyTarget accepts smaller clean unverified account when trust and engagement are exceptional", () => {
  const ok = __trendTargetTest.isPreferredTrendReplyTarget(
    {
      id: "1",
      conversation_id: "1",
      created_at: new Date().toISOString(),
      text: "Detailed onchain thread with a clear thesis, no links, and enough context to justify a real reply without looking like a promo post.",
    },
    { verified: false, public_metrics: { followers_count: 1600 } },
    { engagementRaw: 31, score: 4.9 },
    0.68,
    { minSourceTrust: 0.45, minScore: 3.2, minEngagement: 12, maxAgeHours: 24, requireRootPost: true, blockSuspiciousPromo: true }
  );
  assert.equal(ok, true);
});

test("isPreferredTrendReplyTarget accepts mid-sized clean unverified account after relaxed floor", () => {
  const ok = __trendTargetTest.isPreferredTrendReplyTarget(
    {
      id: "1",
      conversation_id: "1",
      created_at: new Date().toISOString(),
      text: "Careful market structure note with a real thesis, no links, and enough detail to justify a thoughtful reply target.",
    },
    { verified: false, public_metrics: { followers_count: 2100 } },
    { engagementRaw: 14, score: 3.8 },
    0.47,
    { minSourceTrust: 0.42, minScore: 3, minEngagement: 8, maxAgeHours: 24, requireRootPost: true, blockSuspiciousPromo: true }
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

test("buildTrendSearchTerms reduces narrative phrases into searchable terms", () => {
  const terms = __trendTargetTest.buildTrendSearchTerms([
    "사람들이 실제로 머무는 체인과 밖에서 도는 서사가 맞물리는지 살핀다",
    "AI 에이전트 서사가 결제와 실사용까지 닿는지부터 본다",
    "Firedancer upgrade",
  ]);

  assert.ok(terms.includes("에이전트"));
  assert.ok(terms.includes("결제"));
  assert.ok(terms.includes("실사용"));
  assert.ok(terms.includes("Firedancer"));
  assert.equal(terms.includes("사람들"), false);
  assert.equal(terms.includes("사람"), true);
  assert.equal(terms.includes("장면"), false);
});

test("trend search cooldown helper reports remaining time", () => {
  const now = Date.now();
  __trendTargetTest.setTrendSearchCooldownUntilForTest(now + 30_000);
  assert.ok(__trendTargetTest.getTrendSearchCooldownRemainingMs(now) >= 29_000);
  __trendTargetTest.setTrendSearchCooldownUntilForTest(0);
  assert.equal(__trendTargetTest.getTrendSearchCooldownRemainingMs(now), 0);
});
