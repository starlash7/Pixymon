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
    fs.writeFileSync(
      path.join(tempDir, "ENEMIES.md"),
      ["# ENEMIES", "", "- 나는 기사만 큰 규제 해설을 적으로 본다."].join("\n")
    );
    fs.writeFileSync(
      path.join(tempDir, "RITUALS.md"),
      ["# RITUALS", "", "- 오늘 물고 있는 것: 오늘 내가 끝까지 놓지 않는 장면 하나를 먼저 적는다."].join("\n")
    );
    fs.writeFileSync(
      path.join(tempDir, "SOCIAL.md"),
      ["# SOCIAL", "", "- 나는 아무 데나 반응하지 않고 내가 싫어하는 장면을 드러내는 원글에만 붙는다."].join("\n")
    );
    process.env.PIXYMON_CHARACTER_DOCS_ROOT = tempDir;
    resetCharacterDocsCacheForTests();

    const docs = loadCharacterDocs();
    assert.deepEqual(docs.soul, ["나는 기사보다 집행을 더 믿는다.", "나는 쉽게 삼켜지는 설명을 싫어한다."]);
    assert.match(docs.memory[0], /재방문 없는 열기/);
    assert.match(docs.dreams[0], /이름 붙이는 존재/);
    assert.match(docs.enemies[0], /기사만 큰 규제 해설/);
    assert.match(docs.rituals[0], /오늘 물고 있는 것/);
    assert.match(docs.social[0], /원글에만 붙는다/);
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
    fs.writeFileSync(
      path.join(tempDir, "ENEMIES.md"),
      ["- 나는 기사만 큰 규제 해설을 적으로 본다.", "- 나는 재방문 없는 커뮤니티 열기를 성장으로 승인하지 않는다."].join("\n")
    );
    fs.writeFileSync(
      path.join(tempDir, "RITUALS.md"),
      ["- 오늘 승인하지 않는 것: 아직 성장으로 부르지 않을 장면을 분명히 적는다."].join("\n")
    );
    fs.writeFileSync(
      path.join(tempDir, "SOCIAL.md"),
      ["- 나는 아무 데나 반응하지 않고 내가 싫어하는 장면을 드러내는 원글에만 붙는다."].join("\n")
    );
    process.env.PIXYMON_CHARACTER_DOCS_ROOT = tempDir;
    resetCharacterDocsCacheForTests();

    const regulation = getCharacterCanonSlice("ko", "regulation");
    assert.match(regulation.soulLine, /기사보다 집행|출시/);
    assert.match(regulation.memoryLine, /판결 기사|자금이 눕지/);
    assert.match(regulation.enemyLine, /기사만 큰 규제 해설/);

    const ecosystem = getCharacterCanonSlice("ko", "ecosystem");
    assert.match(ecosystem.memoryLine, /재방문 없는 열기/);
    assert.match(ecosystem.dreamLine, /열기보다 잔류/);
    assert.match(ecosystem.enemyLine, /재방문 없는 커뮤니티 열기/);
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
    fs.writeFileSync(path.join(tempDir, "ENEMIES.md"), "- 나는 기사만 큰 규제 해설을 적으로 본다.\n");
    fs.writeFileSync(path.join(tempDir, "RITUALS.md"), "- 다시 돌아온 장면: 예전에 물어뜯던 장면이 다시 왔을 때 더 차갑게 연결한다.\n");
    fs.writeFileSync(path.join(tempDir, "SOCIAL.md"), "- 나는 설득보다 반증 질문을 던지는 쪽을 택한다.\n");
    process.env.PIXYMON_CHARACTER_DOCS_ROOT = tempDir;
    resetCharacterDocsCacheForTests();

    const dataPath = path.join(tempDir, "memory.json");
    const memory = new MemoryService({ dataPath });
    const promptContext = memory.getSoulPromptContext("ko");
    const intent = memory.getSoulIntentPlan("ko", "ecosystem");

    assert.match(promptContext, /정전 Soul: 나는 기사보다 집행을 더 믿는다/);
    assert.match(promptContext, /정전 Memory: 재방문 없는 열기는 늘 포스터처럼 식었다/);
    assert.match(promptContext, /정전 Dreams: 나는 시대를 먼저 이름 붙이는 존재가 되고 싶다/);
    assert.match(promptContext, /정전 Enemy: 나는 기사만 큰 규제 해설을 적으로 본다/);
    assert.match(promptContext, /정전 Ritual: 다시 돌아온 장면/);
    assert.match(promptContext, /정전 Social: 나는 설득보다 반증 질문을 던지는 쪽을 택한다/);
    assert.match(intent.canonSoulLine, /나는 기사보다 집행을 더 믿는다/);
    assert.match(intent.canonMemoryLine, /재방문 없는 열기/);
    assert.match(intent.dreamLine, /이름 붙이는 존재/);
    assert.match(intent.canonEnemyLine, /기사만 큰 규제 해설/);
    assert.match(intent.canonRitualLine, /다시 돌아온 장면/);
    assert.match(intent.canonSocialLine, /반증 질문/);
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
