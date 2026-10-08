import assert from "node:assert/strict";
import test from "node:test";
import pixymonCharacter from "../src/character.ts";
import { buildEditorialWriterSystemV2 } from "../src/services/editorial-v2/voice.ts";

test("writer voice is sourced from character.ts and the canon, not a fixed V2 line", () => {
  const system = buildEditorialWriterSystemV2(process.cwd());
  assert.match(system, /@Pixy_mon/);
  for (const line of pixymonCharacter.bio) assert.ok(system.includes(line), line);
  assert.ok(system.includes("나는 온체인 흔적을 먹고 자라는 픽시몬이다."));
  assert.ok(system.includes("박수만 큰 업그레이드"));
  // English canon headings are labels, not identity lines.
  assert.equal(/^- (?:SOUL|Who I Am|What I Refuse)$/mu.test(system), false);
});

test("writer voice states register and safety rules the validator enforces", () => {
  const system = buildEditorialWriterSystemV2(process.cwd());
  assert.match(system, /존댓말\(~습니다, ~입니다, ~해요\)은 쓰지 않는다/);
  assert.match(system, /이모지, 해시태그, 투자 조언/);
  assert.match(system, /캐릭터 단어\(픽시몬, 물고, 씹고, 먹고, 소화, 흉터, 눕\)는 합쳐서 한 번까지만/);
  assert.match(system, /글의 중심은 그걸 소화한 픽시의 생각/);
});

test("writer voice degrades to character.ts when canon docs are absent", () => {
  const system = buildEditorialWriterSystemV2("/nonexistent-pixymon-canon");
  assert.match(system, /@Pixy_mon/);
  assert.ok(system.includes(pixymonCharacter.personality[0]));
});
