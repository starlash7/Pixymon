import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.TEST_MODE = "false";
const testMemoryPath = path.join(process.cwd(), "data", "test-twitter-quote-memory.json");
process.env.MEMORY_DATA_PATH = testMemoryPath;
fs.rmSync(testMemoryPath, { force: true });

const twitterModulePromise = import("../src/services/twitter.ts");

function withEnv(
  overrides: Record<string, string | undefined>,
  run: () => Promise<void> | void
): Promise<void> | void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (typeof value === "undefined") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (typeof value === "undefined") {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  try {
    const result = run();
    if (result && typeof (result as Promise<void>).then === "function") {
      return (result as Promise<void>).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

test.after(() => {
  fs.rmSync(testMemoryPath, { force: true });
});

test("postTweet sends quote payload when type is quote", async () => {
  const { postTweet } = await twitterModulePromise;
  const calls: any[] = [];
  const twitter = {
    v2: {
      tweet: async (payload: unknown) => {
        calls.push(payload);
        return { data: { id: "quote_123" } };
      },
    },
  } as any;

  let id: string | null = null;
  await withEnv({ ACTION_MODE: "live" }, async () => {
    id = await postTweet(twitter, "온체인 근거가 먼저 움직이는 구간.", "quote", {
      quoteTweetId: "1940012345678901234",
      createKind: "post:quote:test",
      xApiCostSettings: { enabled: false },
    });
  });

  assert.equal(id, "quote_123");
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0], "object");
  assert.equal(calls[0].text, "온체인 근거가 먼저 움직이는 구간.");
  assert.equal(calls[0].quote_tweet_id, "1940012345678901234");
});

test("postTweet blocks quote when quoteTweetId is missing or invalid", async () => {
  const { postTweet } = await twitterModulePromise;
  const calls: any[] = [];
  const twitter = {
    v2: {
      tweet: async (payload: unknown) => {
        calls.push(payload);
        return { data: { id: "should_not_happen" } };
      },
    },
  } as any;

  const missingId = await postTweet(twitter, "테스트", "quote", {
    xApiCostSettings: { enabled: false },
  });
  const invalidId = await postTweet(twitter, "테스트", "quote", {
    quoteTweetId: "abc123",
    xApiCostSettings: { enabled: false },
  });

  assert.equal(missingId, null);
  assert.equal(invalidId, null);
  assert.equal(calls.length, 0);
});

test("postTweet skips live create in observe mode", async () => {
  const { postTweet } = await twitterModulePromise;
  const calls: any[] = [];
  const twitter = {
    v2: {
      tweet: async (payload: unknown) => {
        calls.push(payload);
        return { data: { id: "should_not_happen" } };
      },
    },
  } as any;

  await withEnv({ ACTION_MODE: "observe" }, async () => {
    const id = await postTweet(twitter, "관찰 모드 테스트", "briefing", {
      xApiCostSettings: { enabled: false },
    });
    assert.equal(id, null);
  });

  assert.equal(calls.length, 0);
});

test("postTweet simulates create in paper mode", async () => {
  const { postTweet } = await twitterModulePromise;
  const calls: any[] = [];
  const twitter = {
    v2: {
      tweet: async (payload: unknown) => {
        calls.push(payload);
        return { data: { id: "should_not_happen" } };
      },
    },
  } as any;

  await withEnv({ ACTION_MODE: "paper" }, async () => {
    const id = await postTweet(twitter, "페이퍼 모드 테스트", "briefing", {
      xApiCostSettings: { enabled: false },
    });
    assert.match(String(id), /^paper_/);
  });

  assert.equal(calls.length, 0);
});
