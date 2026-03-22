import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_MODEL,
  CLAUDE_RESEARCH_MODEL,
  buildPromptCachingParams,
  resolveClaudeModelForKind,
  shouldGracefullySkipClaudeRequest,
  shouldUsePromptCaching,
  summarizeClaudeRequestError,
} from "../src/services/llm.ts";

test("resolveClaudeModelForKind routes cheap surfaces to research model", () => {
  assert.equal(resolveClaudeModelForKind("reply:engagement-generate", CLAUDE_MODEL), CLAUDE_RESEARCH_MODEL);
  assert.equal(resolveClaudeModelForKind("rewrite:language", CLAUDE_MODEL), CLAUDE_RESEARCH_MODEL);
  assert.equal(resolveClaudeModelForKind("post:quote-generate", CLAUDE_MODEL), CLAUDE_RESEARCH_MODEL);
  assert.equal(resolveClaudeModelForKind("post:trend-generate", CLAUDE_MODEL), CLAUDE_MODEL);
});

test("shouldUsePromptCaching only enables on non-streaming requests with system prompt", () => {
  assert.equal(
    shouldUsePromptCaching(
      {
        model: CLAUDE_MODEL,
        max_tokens: 120,
        system: "stable system prompt",
        messages: [{ role: "user", content: "hello" }],
      },
      true
    ),
    true
  );
  assert.equal(
    shouldUsePromptCaching(
      {
        model: CLAUDE_MODEL,
        max_tokens: 120,
        messages: [{ role: "user", content: "hello" }],
      },
      true
    ),
    false
  );
  assert.equal(
    shouldUsePromptCaching(
      {
        model: CLAUDE_MODEL,
        max_tokens: 120,
        system: "stable system prompt",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
      true
    ),
    false
  );
});

test("buildPromptCachingParams marks system prompt cacheable and normalizes user text", () => {
  const params = buildPromptCachingParams({
    model: CLAUDE_MODEL,
    max_tokens: 160,
    system: "stable system prompt",
    messages: [{ role: "user", content: "hello world" }],
  });

  assert.ok(Array.isArray(params.system));
  assert.equal(params.system?.[0]?.type, "text");
  assert.equal(params.system?.[0]?.cache_control?.type, "ephemeral");
  assert.ok(Array.isArray(params.messages));
  assert.ok(Array.isArray(params.messages?.[0]?.content));
  const firstBlock = params.messages?.[0]?.content?.[0];
  assert.equal(firstBlock?.type, "text");
  assert.equal(firstBlock?.text, "hello world");
});

test("buildPromptCachingParams can mark first shared user prefix as cacheable", () => {
  const params = buildPromptCachingParams(
    {
      model: CLAUDE_MODEL,
      max_tokens: 160,
      system: "stable system prompt",
      messages: [
        { role: "user", content: "shared context block" },
        { role: "user", content: "task-specific prompt" },
      ],
    },
    { cacheSharedPrefix: true }
  );

  const sharedBlock = params.messages?.[0]?.content?.[0];
  assert.equal(sharedBlock?.type, "text");
  assert.equal(sharedBlock?.cache_control?.type, "ephemeral");
});

test("shouldGracefullySkipClaudeRequest treats low-credit failures as local fallback signals", () => {
  const error = {
    status: 400,
    message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  };
  assert.equal(shouldGracefullySkipClaudeRequest(error), true);
  assert.match(summarizeClaudeRequestError(error), /status=400/i);
});

test("shouldGracefullySkipClaudeRequest keeps unrelated validation failures fatal", () => {
  const error = {
    status: 400,
    message: "messages.1.content is required",
  };
  assert.equal(shouldGracefullySkipClaudeRequest(error), false);
});
