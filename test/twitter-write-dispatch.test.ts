import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-x-write-"));
process.env.PIXYMON_DATA_DIR = testDataDir;
process.env.PIXYMON_PAPER_DATA_DIR = path.join(testDataDir, "paper");
process.env.MEMORY_DATA_PATH = path.join(testDataDir, "memory.json");
process.env.POST_DISPATCH_LOCK_PATH = path.join(testDataDir, "post-dispatch.lock");
process.env.POST_DISPATCH_STATE_PATH = path.join(testDataDir, "post-dispatch.json");
process.env.TEST_MODE = "true";
process.env.TEST_NO_EXTERNAL_CALLS = "true";

const twitterModulePromise = import("../src/services/twitter.ts");

async function withActionMode<T>(mode: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.ACTION_MODE;
  if (typeof mode === "undefined") {
    delete process.env.ACTION_MODE;
  } else {
    process.env.ACTION_MODE = mode;
  }

  try {
    return await run();
  } finally {
    if (typeof previous === "undefined") {
      delete process.env.ACTION_MODE;
    } else {
      process.env.ACTION_MODE = previous;
    }
  }
}

test.after(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("observe mode skips X create and returns no success signal", async () => {
  const { dispatchXWrite } = await twitterModulePromise;
  let createCalls = 0;
  let successMutations = 0;

  await withActionMode("observe", async () => {
    const result = await dispatchXWrite("reply:test", async () => {
      createCalls += 1;
      return "live_1";
    });
    if (result.id) successMutations += 1;

    assert.deepEqual(result, { mode: "observe", id: null, simulated: false });
  });

  assert.equal(createCalls, 0);
  assert.equal(successMutations, 0);
});

test("paper mode simulates success without calling X", async () => {
  const { dispatchXWrite } = await twitterModulePromise;
  let createCalls = 0;

  await withActionMode("paper", async () => {
    const result = await dispatchXWrite("reply:test", async () => {
      createCalls += 1;
      return "live_1";
    });

    assert.equal(result.mode, "paper");
    assert.equal(result.simulated, true);
    assert.match(String(result.id), /^paper_\d+$/);
  });

  assert.equal(createCalls, 0);
});

test("live mode preserves the X create result", async () => {
  const { dispatchXWrite } = await twitterModulePromise;
  let createCalls = 0;

  await withActionMode("live", async () => {
    const result = await dispatchXWrite("reply:test", async () => {
      createCalls += 1;
      return "live_1";
    });

    assert.deepEqual(result, { mode: "live", id: "live_1", simulated: false });
  });

  assert.equal(createCalls, 1);
});

test("invalid action mode fails closed as observe", async () => {
  const { dispatchXWrite } = await twitterModulePromise;
  let createCalls = 0;

  await withActionMode("unexpected", async () => {
    const result = await dispatchXWrite("reply:test", async () => {
      createCalls += 1;
      return "live_1";
    });

    assert.deepEqual(result, { mode: "observe", id: null, simulated: false });
  });

  assert.equal(createCalls, 0);
});

test("mention reply reports no success in observe mode", async () => {
  const { replyToMention } = await twitterModulePromise;
  let xCalls = 0;
  const twitter = {
    v2: {
      reply: async () => {
        xCalls += 1;
        return { data: { id: "live_mention" } };
      },
    },
  } as any;

  await withActionMode("observe", async () => {
    const replied = await replyToMention(
      twitter,
      {} as any,
      { id: "mention_1", text: "@pixymon 이 흐름은 어떻게 봐?" }
    );
    assert.equal(replied, false);
  });

  assert.equal(xCalls, 0);
});

test("mention reply simulates success in paper mode without calling X", async () => {
  const { replyToMention } = await twitterModulePromise;
  let xCalls = 0;
  const twitter = {
    v2: {
      reply: async () => {
        xCalls += 1;
        return { data: { id: "live_mention" } };
      },
    },
  } as any;

  await withActionMode("paper", async () => {
    const replied = await replyToMention(
      twitter,
      {} as any,
      { id: "mention_1", text: "@pixymon 이 흐름은 어떻게 봐?" }
    );
    assert.equal(replied, true);
  });

  assert.equal(xCalls, 0);
});

test("action mode takes precedence over TEST_MODE post simulation", async () => {
  const { postTweet } = await twitterModulePromise;

  await withActionMode("observe", async () => {
    const id = await postTweet(null, "테스트 모드여도 관찰 모드는 성공을 반환하지 않는다.", "briefing", {
      xApiCostSettings: { enabled: false },
    });
    assert.equal(id, null);
  });

  await withActionMode("paper", async () => {
    const id = await postTweet(null, "페이퍼 모드는 X 없이 성공을 시뮬레이션한다.", "briefing", {
      xApiCostSettings: { enabled: false },
    });
    assert.match(String(id), /^paper_\d+$/);
  });
});

test("live mode with no Twitter client fails closed outside TEST_MODE", async () => {
  const { postTweet } = await twitterModulePromise;
  const previousTestMode = process.env.TEST_MODE;
  process.env.TEST_MODE = "false";
  try {
    await withActionMode("live", async () => {
      const id = await postTweet(null, "클라이언트가 없으면 live 성공으로 기록하면 안 된다.", "briefing", {
        xApiCostSettings: { enabled: false },
      });
      assert.equal(id, null);
    });
  } finally {
    if (previousTestMode === undefined) delete process.env.TEST_MODE;
    else process.env.TEST_MODE = previousTestMode;
  }
});
