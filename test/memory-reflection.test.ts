import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { MemoryService } from "../src/services/memory.ts";

test("recordDigestReflectionMemo stores memo and surfaces it in soul prompt context", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-memory-reflection-"));
  try {
    const dataPath = path.join(tempDir, "memory.json");
    const memory = new MemoryService({ dataPath });

    memory.recordDigestReflectionMemo({
      customId: "digest:reflection:test",
      lane: "onchain",
      summary: "고래와 스테이블 속도차",
      text: "오늘은 결론보다 먼저 흔들린 쪽을 다시 본다. 어디서 엇갈렸는지부터 확인한다.",
      batchId: "msgbatch_001",
    });
    memory.flushNow();

    const promptContext = memory.getSoulPromptContext("ko");
    assert.match(promptContext, /최근 소화 메모: 고래와 스테이블 속도차/);
    assert.match(promptContext, /최근 digest memo: 오늘은 결론보다 먼저 흔들린 쪽을 다시 본다/);

    const raw = JSON.parse(fs.readFileSync(dataPath, "utf-8")) as {
      qualityTelemetry?: { reflectionMemos?: Array<{ customId?: string; batchId?: string }> };
    };
    assert.equal(raw.qualityTelemetry?.reflectionMemos?.length, 1);
    assert.equal(raw.qualityTelemetry?.reflectionMemos?.[0]?.customId, "digest:reflection:test");
    assert.equal(raw.qualityTelemetry?.reflectionMemos?.[0]?.batchId, "msgbatch_001");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
