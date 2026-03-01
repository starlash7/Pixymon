import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MODE = "false";

const twitterModulePromise = import("../src/services/twitter.ts");

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

  const id = await postTweet(twitter, "온체인 근거가 먼저 움직이는 구간.", "quote", {
    quoteTweetId: "1940012345678901234",
    createKind: "post:quote:test",
    xApiCostSettings: { enabled: false },
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
