import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { EditorialContextItemV2 } from "../src/services/editorial-v2/contracts.ts";
import type { EvidenceCardV2 } from "../src/services/editorial-v2/evidence.ts";
import { buildEditorialScopeCriticPromptV2 } from "../src/services/editorial-v2/scope-critic.ts";
import { loadTrainerNotesV2, trainerHandleV2 } from "../src/services/editorial-v2/trainer.ts";
import { editorialDraftValidationInputV2, validateEditorialDraftV2 } from "../src/services/editorial-v2/validator.ts";
import { buildEditorialWriterSystemV2 } from "../src/services/editorial-v2/voice.ts";

const NOW = new Date("2026-10-26T05:00:00.000Z");
const CARD: EvidenceCardV2 = {
  schemaVersion: 2, id: "fact:nexus", lane: "protocol", kind: "signal", subject: "Nexus BTC", subjectKey: "nexus-btc",
  metric: { name: "tvl-change-24h", value: 7.28, raw: "+7.28%", unit: "%", period: "24h" },
  source: { provider: "defillama", url: "https://api.llama.fi/protocols", publishedAt: null, observedAt: "2026-10-26T04:38:00.000Z", origin: "direct", role: "primary" },
  freshness: { kind: "signal", measuredAt: "2026-10-26T04:38:00.000Z", maxAgeMs: 7_200_000, ageMs: 1_200_000, state: "fresh" },
  providerHealth: { provider: "defillama", state: "green", reason: "ok", checkedAt: NOW.toISOString(), latencyMs: 10, itemCount: 1 },
  provenance: { kind: "onchain-nutrient", sourceId: "nexus-btc:tvl" },
};

function notes(t: TestContext, body: string, ageMs = 0): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-trainer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "trainer-notes.md");
  fs.writeFileSync(file, body);
  const at = new Date(NOW.getTime() - ageMs);
  fs.utimesSync(file, at, at);
  return file;
}

test("the trainer handle defaults to @Pixy7Crypto and must be a valid X handle", () => {
  assert.equal(trainerHandleV2({}), "Pixy7Crypto");
  assert.equal(trainerHandleV2({ PIXYMON_TRAINER_HANDLE: "@someone_1" }), "someone_1");
  assert.throws(() => trainerHandleV2({ PIXYMON_TRAINER_HANDLE: "bad handle!" }), /invalid/);
});

test("trainer notes become context only while fresh", (t) => {
  const fresh = notes(t, "# 주인님 메모\n- 어제 $BTC 롱 잡았다가 바로 손절\n- 오늘 하루 종일 차트만 봄\n");
  const items = loadTrainerNotesV2({ notesPath: fresh, handle: "Pixy7Crypto", now: NOW });
  assert.deepEqual(items.map((item) => item.text), ["어제 $BTC 롱 잡았다가 바로 손절", "오늘 하루 종일 차트만 봄"]);
  assert.equal(items[0].kind, "trainer");
  assert.match(items[0].label, /주인님\(@Pixy7Crypto\)/);
  assert.deepEqual(loadTrainerNotesV2({ notesPath: notes(t, "- 오래된 메모", 49 * 3_600_000), handle: "Pixy7Crypto", now: NOW }), []);
  assert.deepEqual(loadTrainerNotesV2({ notesPath: "/nonexistent/trainer-notes.md", handle: "Pixy7Crypto", now: NOW }), []);
});

function check(text: string, context: EditorialContextItemV2[]) {
  return validateEditorialDraftV2(editorialDraftValidationInputV2({ text, subject: CARD.subject, fact: CARD, factIds: [CARD.id],
    usedFactIds: [CARD.id], rendering: "thought", context })).reasons;
}

test("Pixymon may address 주인님 only when the trainer's activity is in the material", (t) => {
  const text = "Nexus BTC가 다들 빠지는 날 혼자 불었음. 주인님은 어제 $BTC 롱 잡았다가 바로 손절하던데, 픽시몬이 보기엔 버티는 쪽은 브리지였음.";
  assert.ok(check(text, []).includes("trainer-without-material"));
  const material = loadTrainerNotesV2({ notesPath: notes(t, "- 어제 $BTC 롱 잡았다가 바로 손절"), handle: "Pixy7Crypto", now: NOW });
  assert.equal(check(text, material).includes("trainer-without-material"), false);
  assert.ok(check("Nexus BTC가 혼자 불었음. @Pixy7Crypto 이거 봤음? 픽시몬이 보기엔 브리지가 버팀.", []).includes("trainer-without-material"));
});

test("the voice and critic carry the trainer relationship and its limits", () => {
  const system = buildEditorialWriterSystemV2(process.cwd());
  assert.match(system, /트레이너는 @Pixy7Crypto이다/);
  assert.match(system, /트레이너만 "주인님"이라고 부르고/);
  assert.match(system, /조롱은 주인님에게만 한다/);
  const critic = buildEditorialScopeCriticPromptV2("t", CARD, []);
  assert.match(critic, /재료에 없는 주인님\(트레이너\) 활동을 지어냄/);
  assert.match(critic, /주인님이 아닌 사람·계정·커뮤니티를 조롱함/);
});

test("a contrast clause does not read as a direction conflict, but the number's own clause still must agree", () => {
  assert.equal(check("시장은 다 빠졌는데 Nexus BTC만 하루 +7.28% 불어남. 픽시몬이 보기엔 브리지가 버팀.", []).includes("metric-direction-conflict"), false);
  assert.ok(check("Nexus BTC가 하루 +7.28% 빠졌음. 픽시몬이 보기엔 브리지가 버팀.", []).includes("metric-direction-conflict"));
});
