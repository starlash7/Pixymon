import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-dispatch-"));
process.env.POST_DISPATCH_LOCK_PATH = path.join(tmpRoot, "pixymon-post-dispatch.lock");
process.env.POST_DISPATCH_STATE_PATH = path.join(tmpRoot, "pixymon-post-dispatch.json");

const twitterModulePromise = import("../src/services/twitter.ts");

test("post dispatch fingerprint normalizes numeric and ticker variance", async () => {
  const { __postDispatchTest } = await twitterModulePromise;
  const fpA = __postDispatchTest.buildPostFingerprint(
    "극공포 9점인데 $BTC는 2.5% 올랐고 스테이블 유입 $249.91M"
  );
  const fpB = __postDispatchTest.buildPostFingerprint(
    "극공포 11점인데 $BTC는 3.1% 올랐고 스테이블 유입 $301.12M"
  );
  assert.equal(fpA, fpB);
});

test("post dispatch blocks immediate duplicate briefing post", async () => {
  const { __postDispatchTest } = await twitterModulePromise;
  const content = "극공포 구간에서 BTC와 스테이블 흐름을 추적 중.";

  const firstBlock = __postDispatchTest.getPostDispatchBlockReason(content);
  assert.equal(firstBlock, null);

  __postDispatchTest.persistPostDispatchState(content);
  const secondBlock = __postDispatchTest.getPostDispatchBlockReason(content);
  assert.equal(typeof secondBlock, "string");
  assert.ok(String(secondBlock).length > 0);
});
