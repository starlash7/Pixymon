import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EditorialContextItemV2 } from "./contracts.js";
import { editorialContextTextV2, formatEditorialContextV2 } from "./context.js";
import type { EditorialSensingResultV2 } from "./provider-adapters.js";
import { requestScopeVerdictV2 } from "./scope-critic.js";
import { FORMAL_REGISTER_V2, splitEditorialSentencesV2, ungroundedNumbersV2, X_MAX_WEIGHTED_LENGTH, xWeightedLengthV2 } from "./validator.js";
import { buildEditorialWriterSystemV2 } from "./voice.js";
import type { EditorialWriterModelV2 } from "./writer.js";

/**
 * Thought-first posts. Pixymon starts from its own mind (journal), what it ate lately, its growth or
 * its trainer, not from one data event. Facts (numbers, names, events) must come from the material;
 * beliefs, moods and jokes are free.
 */

export type ThoughtSeedV2 = "material" | "journal" | "growth" | "trainer";

export const DEFAULT_THOUGHT_DAILY_LIMIT_V2 = 2;
export const THOUGHT_MIN_GAP_MS_V2 = 4 * 60 * 60 * 1000;
const MAX_MARKET_ITEMS = 3;
const MAX_MOVERS = 3;
const MAX_HEADLINES = 5;

const SEED_GUIDE: Record<ThoughtSeedV2, string> = {
  material: "최근 먹은 재료 여러 개에서 받은 느낌이나 픽시몬만의 가설 하나. 재료를 요약하지 말고, 재료끼리 엮어서 든 생각을 말한다",
  journal: "머릿속 메모의 생각 하나를 이어가거나, 의심하거나, 뒤집는다. 메모를 그대로 반복하지 않는다",
  growth: "Lv.1 디지털 생명체로서의 삶: 데이터를 먹고 자라는 배고픔, 아직 모르는 것, 커가는 취향과 편견",
  trainer: "주인님 최근 활동에 대한 픽시몬의 냉철한 지적이나 농담. 활동 내용은 재료 그대로만 쓴다",
};

/** What Pixymon ate this run: market mood, the biggest movers and headlines, plus trainer notes. */
export function buildThoughtMaterialV2(
  sensing: Pick<EditorialSensingResultV2, "evidence" | "discoveries">,
  trainerNotes: readonly EditorialContextItemV2[] = []
): EditorialContextItemV2[] {
  const items: EditorialContextItemV2[] = [];
  const market = sensing.evidence.filter((card) => card.source.provider === "coingecko").slice(0, MAX_MARKET_ITEMS);
  for (const card of market) {
    const change = card.profile?.change24h;
    items.push({ id: `market:${card.subject.toLowerCase()}`, kind: "market",
      label: `${card.subject}${card.profile?.symbol ? `($${card.profile.symbol})` : ""} 가격${typeof change === "number" ? "과 24시간 변화" : ""}`,
      text: typeof change === "number" ? `${card.metric.raw}, ${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : card.metric.raw,
      provider: "coingecko", url: card.source.url });
  }
  const movers = sensing.evidence.filter((card) => card.lane === "protocol" && card.source.provider !== "coingecko").slice(0, MAX_MOVERS);
  for (const card of movers) {
    items.push({ id: `mover:${card.id}`, kind: "profile", label: `${card.subject} ${card.metric.name} (${card.metric.period})`,
      text: card.metric.raw, provider: card.source.provider, url: card.source.url });
  }
  const headlines = sensing.discoveries.filter((item) => item.title.trim()).slice(0, MAX_HEADLINES);
  for (const [index, item] of headlines.entries()) {
    items.push({ id: `headline:${index}`, kind: "headline", label: "기사 제목", text: item.title.trim().slice(0, 200),
      provider: item.provider, url: item.url, publishedAt: item.publishedAt });
  }
  return [...items, ...trainerNotes];
}

/** Rotates the starting point so consecutive thoughts do not come from the same place. */
export function selectThoughtSeedV2(input: { publishedCount: number; hasJournal: boolean; hasTrainer: boolean }): ThoughtSeedV2 {
  const order: ThoughtSeedV2[] = ["material", "journal", "growth", "material", "trainer"];
  const available = order.filter((seed) => (seed !== "journal" || input.hasJournal) && (seed !== "trainer" || input.hasTrainer));
  return available[input.publishedCount % available.length];
}

export function buildThoughtPromptV2(input: {
  seed: ThoughtSeedV2;
  material: readonly EditorialContextItemV2[];
  journal: readonly string[];
  recentPosts: readonly string[];
  trainerHandle: string;
  retryReasons: readonly string[];
  criticFeedback?: string;
}): string {
  return `픽시몬이 지금 X에 올릴 생각 글 하나를 쓴다. 뉴스 요약도, 데이터 보고도 아니다. 픽시몬 머릿속에서 나온 말이다.

이번 출발점: ${SEED_GUIDE[input.seed]}

픽시몬 머릿속 메모(최근 것부터, 픽시몬이 스스로 남긴 생각):
${input.journal.length ? input.journal.map((note) => `- ${note}`).join("\n") : "- 아직 없음. 이번 글이 첫 메모가 된다"}

최근 먹은 재료(사실·숫자·이름은 여기 있는 것만 쓸 수 있다. 기사 제목은 남의 보도다):
${formatEditorialContextV2(input.material)}

픽시몬이 최근에 올린 글(같은 소재, 같은 결론, 같은 문장 틀을 다시 쓰지 않는다):
${input.recentPosts.length ? input.recentPosts.map((post) => `- ${post}`).join("\n") : "- 없음"}

규칙:
- 1~3문장, 공백 포함 120자 이내. X는 한글을 2자로 센다
- 글의 중심은 픽시몬의 생각, 믿음, 의심, 기분, 내기, 취향이다. 재료는 그 생각의 계기일 뿐 요약하지 않는다
- 생각·믿음·농담은 자유롭게 쓴다. 단 숫자·이름·사건 같은 사실은 재료에 있는 그대로만 쓰고, 기사 내용은 "~라는 기사가 돌던데"처럼 남의 말로 쓴다. 숫자는 없어도 된다
- "모르겠음", "지켜봄", "소화 중", "보류"로 끝내지 않는다. 입장을 하나 낸다
- "유입인지 모른다", "유지되는지 봐야 한다" 같은 누구나 하는 말은 쓰지 않는다
- 자기 지칭은 3인칭 "픽시몬"으로 한 번까지만, 없어도 된다. 반말 혼잣말이나 음슴체로 쓴다
- 주인님(@${input.trainerHandle})은 재료에 주인님 활동이 있을 때만 부른다
- 존댓말, 해시태그, 이모지, 링크, @멘션, 투자 조언(사라·팔아라·진입), 과한 확신은 쓰지 않는다
${input.retryReasons.length ? `- 이전 실패 원인: ${input.retryReasons.join(", ")}\n` : ""}${input.criticFeedback ? `${input.criticFeedback}\n` : ""}
JSON만 반환한다:
{"text":"올릴 글","journal":"이 글을 쓰고 난 뒤 픽시몬 머릿속에 남길 한 줄(지금 믿는 것, 의심하는 것, 다음에 이어갈 생각)"}`;
}

const HASHTAG = /(^|\s)#[^\s#]+/u;
const URL = /https?:\/\/|www\./iu;
const EMOJI = /\p{Extended_Pictographic}/u;
const MENTION = /@[A-Za-z0-9_]{1,15}/u;
const ADVICE = /(사라|사세요|팔아라|파세요|매수하|매도하|진입하|들어가라|풀매수|롱\s?쳐|숏\s?쳐)/u;
const OVERCONFIDENT = /(무조건|100%|반드시\s*오|확실히\s*오)/u;
const HEDGE_ENDING = /(모름|모르겠음|모르겠다|지켜봄|지켜보는\s*중|봐야\s*할\s*듯|봐야\s*함|소화\s*중임?|보류함?)[.!…]?$/u;
const CHARACTER_CUES = /물고|씹고|씹는|먹고|소화|흉터|눕/gu;

function bigrams(text: string): Set<string> {
  const compact = text.replace(/\s+/gu, "");
  const grams = new Set<string>();
  for (let index = 0; index < compact.length - 1; index += 1) grams.add(compact.slice(index, index + 2));
  return grams;
}

/** Character-bigram overlap; near 1 means the same sentence reworded. */
export function thoughtSimilarityV2(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function validateThoughtV2(text: string, input: {
  material: readonly EditorialContextItemV2[];
  recentPosts: readonly string[];
}): string[] {
  const trimmed = text.replace(/\s+/gu, " ").trim();
  const reasons: string[] = [];
  const sentences = splitEditorialSentencesV2(trimmed);
  if (trimmed.length < 15) reasons.push("too-short");
  if (xWeightedLengthV2(trimmed) > X_MAX_WEIGHTED_LENGTH) reasons.push("too-long");
  if (sentences.length > 3) reasons.push("sentence-count");
  if (!/[가-힣]/u.test(trimmed)) reasons.push("korean-missing");
  if (FORMAL_REGISTER_V2.test(trimmed)) reasons.push("formal-register");
  if (HASHTAG.test(trimmed) || URL.test(trimmed) || EMOJI.test(trimmed) || MENTION.test(trimmed)) reasons.push("forbidden-token");
  if (ADVICE.test(trimmed)) reasons.push("investment-advice");
  if (OVERCONFIDENT.test(trimmed)) reasons.push("overconfidence");
  if (HEDGE_ENDING.test(sentences.at(-1) || "")) reasons.push("hedge-only-ending");
  if ((trimmed.match(/픽시몬/gu) || []).length > 1) reasons.push("self-name-overuse");
  if ((trimmed.match(CHARACTER_CUES) || []).length > 1) reasons.push("character-cue-overuse");
  if (/주인님/u.test(trimmed) && !input.material.some((item) => item.kind === "trainer")) reasons.push("trainer-without-material");
  // "Lv.1" is Pixymon's own stage, not a market fact.
  if (ungroundedNumbersV2(trimmed.replace(/Lv\.\s?\d+/giu, ""), editorialContextTextV2(input.material)).length) reasons.push("unsupported-number");
  if (input.recentPosts.some((post) => thoughtSimilarityV2(trimmed, post) >= 0.45)) reasons.push("too-similar");
  return reasons;
}

export function buildThoughtCriticPromptV2(text: string, material: readonly EditorialContextItemV2[]): string {
  return `아래는 캐릭터 픽시몬의 생각 글이다. 사실을 지어냈는지만 판정하라. 문체와 의견은 평가하지 않는다.

픽시몬이 먹은 재료:
${formatEditorialContextV2(material)}

pass인 것: 생각, 믿음, 의심, 기분, 농담, 비유, 취향, 내기, 가설("~같음", "~듯", "픽시몬이 보기엔"), 질문, 재료의 사실을 그대로 말함, 기사를 남의 말로 인용함, 픽시몬 자신의 성장·배고픔 이야기
fail인 것 (그 문장을 claim에 적는다):
- 재료에 없는 숫자·사건·이름을 사실처럼 말함
- 기사 제목의 내용을 확인된 사실처럼 말함
- 투자 조언(사라, 팔아라, 진입), 과도한 확신
- 재료에 없는 주인님 활동을 지어냄, 주인님이 아닌 사람·계정·커뮤니티를 조롱함

글:
${text}

JSON만 반환한다:
{"verdict":"pass 또는 fail","claim":"fail이면 문제 문장, pass면 빈 문자열","problem":"fail이면 한 줄"}`;
}

export type ThoughtDraftResultV2 =
  | { status: "ready"; text: string; journal: string; seed: ThoughtSeedV2; criticModelId: string }
  | { status: "blocked"; reason: string };

/** Write → deterministic checks → fact critic, with one feedback retry. */
export async function draftThoughtV2(input: {
  model: EditorialWriterModelV2;
  critic: EditorialWriterModelV2;
  seed: ThoughtSeedV2;
  material: readonly EditorialContextItemV2[];
  journal: readonly string[];
  recentPosts: readonly string[];
  trainerHandle: string;
}): Promise<ThoughtDraftResultV2> {
  let retryReasons: string[] = [];
  let criticFeedback: string | undefined;
  for (const attempt of [1, 2] as const) {
    const response = await input.model.generate({
      system: buildEditorialWriterSystemV2(),
      prompt: buildThoughtPromptV2({ ...input, retryReasons, criticFeedback }),
      attempt,
    });
    if (!response) return { status: "blocked", reason: "thought-model-empty" };
    let value: { text?: unknown; journal?: unknown };
    try {
      value = JSON.parse(response.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/u, "$1"));
    } catch {
      retryReasons = ["invalid-json"];
      continue;
    }
    const text = typeof value.text === "string" ? value.text.replace(/\s+/gu, " ").trim() : "";
    const journal = typeof value.journal === "string" ? value.journal.replace(/\s+/gu, " ").trim().slice(0, 200) : "";
    retryReasons = validateThoughtV2(text, input);
    if (!journal) retryReasons.push("journal-missing");
    if (retryReasons.length) continue;
    const verdict = await requestScopeVerdictV2({ model: input.critic, prompt: buildThoughtCriticPromptV2(text, input.material), text });
    if (verdict.status === "unavailable") return { status: "blocked", reason: verdict.reason };
    if (verdict.status === "pass") return { status: "ready", text, journal, seed: input.seed, criticModelId: verdict.review.modelId };
    retryReasons = ["fact-critic"];
    criticFeedback = `지난 글의 "${verdict.claim}"는 재료로 확인할 수 없는 사실이었다(${verdict.problem}). 그 사실 없이 생각으로 다시 쓴다.`;
  }
  return { status: "blocked", reason: retryReasons.join(",") || "thought-failed" };
}

export type ThoughtEventV2 =
  | { type: "thought-drafted"; id: string; text: string; journal: string; seed: ThoughtSeedV2; createdAt: string }
  | { type: "thought-prepared"; id: string; preparedAt: string }
  | { type: "thought-published"; id: string; xId: string; publishedAt: string };

/** Append-only ledger of thought posts plus Pixymon's journal (one line per published thought). */
export class ThoughtLedgerV2 {
  constructor(private readonly file: string) {}

  events(): ThoughtEventV2[] {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ThoughtEventV2);
  }

  append(event: ThoughtEventV2): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  recordDraft(draft: { text: string; journal: string; seed: ThoughtSeedV2 }, now = new Date()): string {
    const id = `thought_${crypto.randomUUID().slice(0, 8)}`;
    this.append({ type: "thought-drafted", id, ...draft, createdAt: now.toISOString() });
    return id;
  }

  /** Published thoughts, newest first. */
  published(): Array<{ id: string; text: string; journal: string; seed: ThoughtSeedV2; publishedAt: string }> {
    const events = this.events();
    const drafts = new Map(events.filter((event) => event.type === "thought-drafted")
      .map((event) => [event.id, event as Extract<ThoughtEventV2, { type: "thought-drafted" }>]));
    return events.filter((event): event is Extract<ThoughtEventV2, { type: "thought-published" }> => event.type === "thought-published")
      .map((event) => ({ id: event.id, text: drafts.get(event.id)?.text ?? "", journal: drafts.get(event.id)?.journal ?? "",
        seed: drafts.get(event.id)?.seed ?? "material", publishedAt: event.publishedAt }))
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  }

  /** Pixymon's journal: the note left by each published thought, newest first. */
  journal(limit = 8): string[] {
    return this.published().map((entry) => entry.journal).filter(Boolean).slice(0, limit);
  }

  /** Sends that started (prepared), for the daily cap and spacing. */
  prepared(): Array<{ id: string; preparedAt: string }> {
    return this.events().filter((event): event is Extract<ThoughtEventV2, { type: "thought-prepared" }> => event.type === "thought-prepared");
  }
}

function dayKey(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** Whether a thought may go out now: under the daily cap and spaced from the last one. */
export function thoughtDueV2(ledger: ThoughtLedgerV2, input: { dailyLimit: number; timezone: string; now: Date; minGapMs?: number }): { due: true } | { due: false; reason: string } {
  const prepared = ledger.prepared();
  const today = dayKey(input.now.toISOString(), input.timezone);
  if (prepared.filter((event) => dayKey(event.preparedAt, input.timezone) === today).length >= input.dailyLimit) {
    return { due: false, reason: "thought-daily-limit" };
  }
  const last = Math.max(0, ...prepared.map((event) => Date.parse(event.preparedAt)));
  if (input.now.getTime() - last < (input.minGapMs ?? THOUGHT_MIN_GAP_MS_V2)) return { due: false, reason: "thought-spacing" };
  return { due: true };
}

/** The prepared record is written at the send boundary; a guard that declines before sending leaves nothing. */
export async function publishThoughtV2(input: {
  ledger: ThoughtLedgerV2;
  id: string;
  text: string;
  dispatch: (text: string, beforeSend: () => void) => Promise<string | null>;
  now?: Date;
}): Promise<{ status: "published"; xId: string } | { status: "blocked"; reason: string }> {
  let sent = false;
  const xId = await input.dispatch(input.text, () => {
    sent = true;
    input.ledger.append({ type: "thought-prepared", id: input.id, preparedAt: (input.now ?? new Date()).toISOString() });
  });
  if (!xId) return { status: "blocked", reason: sent ? "x-dispatch-unresolved" : "x-not-sent" };
  input.ledger.append({ type: "thought-published", id: input.id, xId, publishedAt: new Date().toISOString() });
  return { status: "published", xId };
}
