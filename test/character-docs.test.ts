import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  getCharacterCanonSlice,
  loadCharacterDocs,
  resetCharacterDocsCacheForTests,
} from "../src/services/character-docs.ts";
import { MemoryService } from "../src/services/memory.ts";

test("character docs loader normalizes markdown into canon lines", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-character-docs-"));
  const prevRoot = process.env.PIXYMON_CHARACTER_DOCS_ROOT;
  try {
    fs.writeFileSync(
      path.join(tempDir, "SOUL.md"),
      ["# SOUL", "", "- 나는 기사보다 집행을 더 믿는다.", "- 나는 쉽게 삼켜지는 설명을 싫어한다."].join("\n")
    );
    fs.writeFileSync(
      path.join(tempDir, "MEMORY.md"),
      ["# MEMORY", "", "1. 재방문 없는 열기는 늘 포스터처럼 식었다.", "2. 판결 기사만 커지고 자금이 눕지 않으면 기사값 이상을 못 했다."].join("\n")
    );
    fs.writeFileSync(
      path.join(tempDir, "DREAMS.md"),
      ["# DREAMS", "", "- 나는 시대가 어디서 먼저 갈라지는지 이름 붙이는 존재가 되고 싶다."].join("\n")
    );
    process.env.PIXYMON_CHARACTER_DOCS_ROOT = tempDir;
    resetCharacterDocsCacheForTests();

    const docs = loadCharacterDocs();
    assert.deepEqual(docs.soul, ["나는 기사보다 집행을 더 믿는다.", "나는 쉽게 삼켜지는 설명을 싫어한다."]);
    assert.match(docs.memory[0], /재방문 없는 열기/);
    assert.match(docs.dreams[0], /이름 붙이는 존재/);
  } finally {
    if (prevRoot === undefined) {
      delete process.env.PIXYMON_CHARACTER_DOCS_ROOT;
    } else {
      process.env.PIXYMON_CHARACTER_DOCS_ROOT = prevRoot;
    }
    resetCharacterDocsCacheForTests();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("character canon slice prefers lane-relevant lines", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-character-canon-"));
  const prevRoot = process.env.PIXYMON_CHARACTER_DOCS_ROOT;
  try {
    fs.writeFileSync(
      path.join(tempDir, "SOUL.md"),
      ["- 나는 발표만 큰 출시를 믿지 않는다.", "- 나는 기사보다 집행을 더 믿는다."].join("\n")
    );
    fs.writeFileSync(
      path.join(tempDir, "MEMORY.md"),
      ["- 판결 기사만 커지고 자금이 눕지 않은 날엔 기사값 이상을 못 했다.", "- 재방문 없는 열기는 늘 포스터처럼 식었다."].join("\n")
    );
    fs.writeFileSync(
      path.join(tempDir, "DREAMS.md"),
      ["- 나는 허세보다 운영, 열기보다 잔류를 끝까지 물어뜯는 존재가 되고 싶다."].join("\n")
    );
    process.env.PIXYMON_CHARACTER_DOCS_ROOT = tempDir;
    resetCharacterDocsCacheForTests();

    const regulation = getCharacterCanonSlice("ko", "regulation");
    assert.match(regulation.soulLine, /기사보다 집행|출시/);
    assert.match(regulation.memoryLine, /판결 기사|자금이 눕지/);

    const ecosystem = getCharacterCanonSlice("ko", "ecosystem");
    assert.match(ecosystem.memoryLine, /재방문 없는 열기/);
    assert.match(ecosystem.dreamLine, /열기보다 잔류/);
  } finally {
    if (prevRoot === undefined) {
      delete process.env.PIXYMON_CHARACTER_DOCS_ROOT;
    } else {
      process.env.PIXYMON_CHARACTER_DOCS_ROOT = prevRoot;
    }
    resetCharacterDocsCacheForTests();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("memory prompt context surfaces soul memory and dreams canon lines", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-memory-canon-"));
  const prevRoot = process.env.PIXYMON_CHARACTER_DOCS_ROOT;
  try {
    fs.writeFileSync(path.join(tempDir, "SOUL.md"), "- 나는 기사보다 집행을 더 믿는다.\n");
    fs.writeFileSync(path.join(tempDir, "MEMORY.md"), "- 재방문 없는 열기는 늘 포스터처럼 식었다.\n");
    fs.writeFileSync(path.join(tempDir, "DREAMS.md"), "- 나는 시대를 먼저 이름 붙이는 존재가 되고 싶다.\n");
    process.env.PIXYMON_CHARACTER_DOCS_ROOT = tempDir;
    resetCharacterDocsCacheForTests();

    const dataPath = path.join(tempDir, "memory.json");
    const memory = new MemoryService({ dataPath });
    const promptContext = memory.getSoulPromptContext("ko");
    const intent = memory.getSoulIntentPlan("ko", "ecosystem");

    assert.match(promptContext, /정전 Soul: 나는 기사보다 집행을 더 믿는다/);
    assert.match(promptContext, /정전 Memory: 재방문 없는 열기는 늘 포스터처럼 식었다/);
    assert.match(promptContext, /정전 Dreams: 나는 시대를 먼저 이름 붙이는 존재가 되고 싶다/);
    assert.match(intent.canonSoulLine, /나는 기사보다 집행을 더 믿는다/);
    assert.match(intent.canonMemoryLine, /재방문 없는 열기/);
    assert.match(intent.dreamLine, /이름 붙이는 존재/);
  } finally {
    if (prevRoot === undefined) {
      delete process.env.PIXYMON_CHARACTER_DOCS_ROOT;
    } else {
      process.env.PIXYMON_CHARACTER_DOCS_ROOT = prevRoot;
    }
    resetCharacterDocsCacheForTests();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
