import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDigestReflectionJob,
  buildLanguageRewriteJob,
  buildReplyRewriteJob,
} from "../src/services/llm-batch.ts";

test("buildLanguageRewriteJob produces direct-call compatible rewrite spec", () => {
  const job = buildLanguageRewriteJob({
    text: "original line",
    language: "ko",
    maxChars: 120,
  });

  assert.equal(job.kind, "rewrite:language");
  assert.equal(job.execution.kind, "rewrite:language");
  assert.equal(job.request.max_tokens, 220);
  assert.equal(job.request.messages?.[0]?.role, "user");
  assert.match(String(job.request.messages?.[0]?.content), /자연스러운 한국어 한 줄/);
});

test("buildReplyRewriteJob produces reply-specific rewrite spec", () => {
  const job = buildReplyRewriteJob({
    text: "reply line",
    language: "en",
    maxChars: 100,
  });

  assert.equal(job.kind, "rewrite:reply-language");
  assert.equal(job.execution.kind, "rewrite:reply-language");
  assert.equal(job.metadata.language, "en");
  assert.match(String(job.request.messages?.[0]?.content), /one-line English reply/i);
});

test("buildDigestReflectionJob builds batch-ready digest memo spec", () => {
  const job = buildDigestReflectionJob({
    language: "ko",
    lane: "onchain",
    summary: "오늘 체인 흐름 요약",
    acceptedNutrients: [
      { label: "고래 이동", value: "+18%", source: "onchain" },
      { label: "스테이블 공급", value: "+$24M", source: "market" },
    ],
    rejectReasons: ["stale-signal"],
    xpGainTotal: 12,
    evolvedCount: 1,
    maxChars: 220,
  });

  assert.equal(job.kind, "digest:reflection");
  assert.equal(job.execution.kind, "digest:reflection");
  assert.equal(job.metadata.lane, "onchain");
  assert.equal(job.metadata.nutrientCount, 2);
  assert.match(String(job.request.messages?.[0]?.content), /reflection memo/);
});
