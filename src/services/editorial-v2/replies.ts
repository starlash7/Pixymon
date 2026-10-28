import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { requestScopeVerdictV2 } from "./scope-critic.js";
import { trainerHandleV2 } from "./trainer.js";
import { FORMAL_REGISTER_V2, ungroundedNumbersV2, xWeightedLengthV2, X_MAX_WEIGHTED_LENGTH } from "./validator.js";
import { buildEditorialWriterSystemV2 } from "./voice.js";
import type { EditorialWriterModelV2 } from "./writer.js";

export const DEFAULT_REPLY_DAILY_LIMIT_V2 = 2;

/** A post the operator pasted; nothing here is fetched from X. */
export interface ReplyTargetV2 {
  tweetId: string;
  url: string;
  author: string;
  text: string;
  trainer: boolean;
}

export interface ReplyCandidateV2 {
  text: string;
  reasons: string[];
  critic: "pass" | "fail" | "unavailable" | "not-run";
  criticNote?: string;
}

export type ReplyEventV2 =
  | { type: "reply-drafted"; id: string; createdAt: string; target: ReplyTargetV2; candidates: ReplyCandidateV2[]; modelId: string }
  | { type: "reply-prepared"; id: string; pick: number; text: string; preparedAt: string }
  | { type: "reply-published"; id: string; pick: number; text: string; xId: string; publishedAt: string }
  /** A prepared reply that provably never reached X (e.g. a budget or interval guard declined before sending). */
  | { type: "reply-released"; id: string; reason: string; releasedAt: string };

export function parseReplyTargetUrlV2(url: string, env: NodeJS.ProcessEnv = process.env): { tweetId: string; author: string; trainer: boolean } {
  const match = String(url).trim().match(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})(?:[/?#].*)?$/u);
  if (!match) throw new Error("reply target must be an x.com/<handle>/status/<id> URL");
  const author = match[1];
  return { tweetId: match[2], author, trainer: author.toLowerCase() === trainerHandleV2(env).toLowerCase() };
}

const HASHTAG = /(^|\s)#[^\s#]+/u;
const URL_PATTERN = /https?:\/\/|www\./iu;
const EMOJI = /\p{Extended_Pictographic}/u;

/** Deterministic floor for a reply; the critic reads meaning afterwards. */
export function validateReplyV2(text: string, target: ReplyTargetV2): string[] {
  const reasons: string[] = [];
  const trimmed = text.trim();
  if (trimmed.length < 5) reasons.push("too-short");
  if (xWeightedLengthV2(trimmed) > X_MAX_WEIGHTED_LENGTH) reasons.push("too-long");
  if (FORMAL_REGISTER_V2.test(trimmed)) reasons.push("formal-register");
  if (HASHTAG.test(trimmed)) reasons.push("hashtag");
  if (URL_PATTERN.test(trimmed)) reasons.push("url");
  if (EMOJI.test(trimmed)) reasons.push("emoji");
  if ((trimmed.match(/픽시몬/gu) || []).length > 1) reasons.push("self-name-overuse");
  if ((trimmed.match(/물고|씹고|씹는|먹고|소화|흉터|눕/gu) || []).length > 1) reasons.push("character-cue-overuse");
  if (/주인님/u.test(trimmed) && !target.trainer) reasons.push("trainer-address-to-non-trainer");
  if (/@[A-Za-z0-9_]{1,15}/u.test(trimmed)) reasons.push("mention");
  if (ungroundedNumbersV2(trimmed, target.text, { coreOnly: true }).length > 0) reasons.push("unsupported-number");
  return reasons;
}

export function buildReplyPromptV2(target: ReplyTargetV2): string {
  const who = target.trainer
    ? `@${target.author} (픽시몬의 트레이너, 주인님)`
    : `@${target.author}`;
  const relation = target.trainer
    ? "- 글쓴이는 주인님이다. \"주인님\"이라고 부르고, 아부 없이 냉철하게 지적하거나 놀려도 된다. 잘한 건 짧게 인정한다. 외모·가족·사생활은 건드리지 않는다."
    : "- 글쓴이를 주인님이라고 부르지 않는다. 조롱·비꼼 없이 픽시몬의 시각으로 짧게 반응한다. 동의하지 않으면 반증 질문을 던진다.";
  return `아래 X 글에 픽시몬이 답글을 단다.

글쓴이: ${who}
글:
${target.text}

규칙:
- 서로 다른 톤의 답글 후보 3개를 쓴다(예: 인정과 놀림 반반, 냉철한 지적, 픽시몬다운 온체인 비유).
${relation}
- 각 후보는 1~2문장, 한글 100자 이내. X는 한글을 2자로 센다.
- 캐릭터 비유 단어(물고, 씹고, 먹고, 소화, 흉터, 눕)는 합쳐서 한 번까지만 쓴다.
- 숫자·이름·사실은 원글에 있는 것만 쓴다. 원글에 없는 계산이나 추측 숫자는 쓰지 않는다.
- 픽시몬이 무엇을 봤는지, 왜 그렇게 했는지 같은 자기 작동 이유를 지어내지 않는다. 픽시몬의 실수를 지적받으면 핑계 없이 인정하고, 이유를 모르면 모른다고 한다.
- 자기 지칭은 3인칭 "픽시몬"으로 한 번까지만. 존댓말, 해시태그, 이모지, 링크, @멘션, 투자 조언은 쓰지 않는다.
- JSON만 반환한다: {"replies":["후보1","후보2","후보3"]}`;
}

export function buildReplyCriticPromptV2(text: string, target: ReplyTargetV2): string {
  return `아래 답글이 원글로 확인할 수 없는 사실을 지어내거나, 선을 넘는지 판정하라. 문체는 평가하지 않는다.

원글 (@${target.author}${target.trainer ? ", 픽시몬의 트레이너" : ""}):
${target.text}

pass인 것: 원글 내용을 그대로 인용, 의견("~같음", "픽시몬이 보기엔"), 농담, 질문.${target.trainer ? " 원글에 맞는 주인님에 대한 지적·농담·놀림." : ""}
fail인 것 (그 문장을 claim에 적는다):
- 원글에 없는 숫자·사실을 사실처럼 말함
${target.trainer ? "- 외모·가족·사생활을 건드림" : "- 글쓴이를 조롱·비하하거나 주인님이라고 부름"}
- 투자 조언, 과도한 확신
- 픽시몬이 무엇을 봤는지, 왜 그렇게 했는지를 원글로 확인할 수 없는데 사실처럼 말함 (지적받은 실수에 대한 핑계 포함)

답글:
${text}

JSON만 반환한다:
{"verdict":"pass 또는 fail","claim":"fail이면 문제 문장, pass면 빈 문자열","problem":"fail이면 한 줄"}`;
}

export async function draftRepliesV2(input: {
  model: EditorialWriterModelV2;
  critic?: EditorialWriterModelV2;
  target: ReplyTargetV2;
}): Promise<ReplyCandidateV2[]> {
  const response = await input.model.generate({ system: buildEditorialWriterSystemV2(), prompt: buildReplyPromptV2(input.target), attempt: 1 });
  if (!response) throw new Error("reply-model-empty");
  let replies: unknown;
  try {
    replies = (JSON.parse(response.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/u, "$1")) as { replies?: unknown }).replies;
  } catch {
    throw new Error("reply-invalid-json");
  }
  if (!Array.isArray(replies)) throw new Error("reply-invalid-json");
  const candidates: ReplyCandidateV2[] = [];
  for (const raw of replies.slice(0, 3)) {
    const text = String(raw ?? "").replace(/\s+/gu, " ").trim();
    const reasons = validateReplyV2(text, input.target);
    if (reasons.length || !input.critic) {
      candidates.push({ text, reasons, critic: "not-run" });
      continue;
    }
    const verdict = await requestScopeVerdictV2({ model: input.critic, prompt: buildReplyCriticPromptV2(text, input.target), text });
    candidates.push(verdict.status === "pass" ? { text, reasons, critic: "pass" }
      : verdict.status === "fail" ? { text, reasons, critic: "fail", criticNote: `${verdict.claim} (${verdict.problem})` }
        : { text, reasons, critic: "unavailable", criticNote: verdict.reason });
  }
  return candidates;
}

export class ReplyLedgerV2 {
  constructor(readonly filePath: string) {}

  events(): ReplyEventV2[] {
    if (!fs.existsSync(this.filePath)) return [];
    return fs.readFileSync(this.filePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ReplyEventV2);
  }

  append(event: ReplyEventV2): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const fd = fs.openSync(this.filePath, "a", 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(event)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  recordDraft(target: ReplyTargetV2, candidates: ReplyCandidateV2[], modelId: string, now = new Date()): string {
    const id = `reply_${randomUUID().slice(0, 8)}`;
    this.append({ type: "reply-drafted", id, createdAt: now.toISOString(), target, candidates, modelId });
    return id;
  }

  draft(id: string) {
    return this.events().find((event): event is Extract<ReplyEventV2, { type: "reply-drafted" }> => event.type === "reply-drafted" && event.id === id);
  }
}

/**
 * Operator-only: releases a prepared reply after checking the account shows it never posted, so the
 * target can be replied to again. A published reply can never be released.
 */
export function releaseReplyV2(ledger: ReplyLedgerV2, id: string, reason: string, now = new Date()): { status: "released" } | { status: "blocked"; reason: string } {
  const events = ledger.events();
  if (events.some((event) => event.type === "reply-published" && event.id === id)) return { status: "blocked", reason: "reply-already-published" };
  if (events.some((event) => event.type === "reply-released" && event.id === id)) return { status: "blocked", reason: "reply-already-released" };
  if (!events.some((event) => event.type === "reply-prepared" && event.id === id)) return { status: "blocked", reason: "reply-not-prepared" };
  if (!reason.trim()) return { status: "blocked", reason: "release-reason-required" };
  ledger.append({ type: "reply-released", id, reason: reason.trim(), releasedAt: now.toISOString() });
  return { status: "released" };
}

function dayKey(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/**
 * Publishing is an explicit operator choice of one candidate. A prepared record is written right before
 * the single X request, so a crash can never lead to a second send of the same reply or target, while a
 * guard that declines before sending leaves nothing behind.
 */
export async function publishReplyV2(input: {
  ledger: ReplyLedgerV2;
  id: string;
  pick: number;
  /** Must call beforeSend synchronously right before the network request; a null result without it means not sent. */
  dispatch: (text: string, replyToTweetId: string, beforeSend: () => void) => Promise<string | null>;
  dailyLimit?: number;
  timezone: string;
  now?: Date;
}): Promise<{ status: "published"; xId: string } | { status: "blocked"; reason: string }> {
  const now = input.now ?? new Date();
  const draft = input.ledger.draft(input.id);
  if (!draft) return { status: "blocked", reason: "unknown-reply-id" };
  const candidate = draft.candidates[input.pick - 1];
  if (!candidate) return { status: "blocked", reason: "unknown-candidate" };
  if (candidate.reasons.length) return { status: "blocked", reason: `candidate-failed-checks:${candidate.reasons.join(",")}` };
  if (candidate.critic !== "pass") return { status: "blocked", reason: `candidate-critic-${candidate.critic}` };
  const events = input.ledger.events();
  const targetIds = new Map(events.filter((event) => event.type === "reply-drafted")
    .map((event) => [(event as Extract<ReplyEventV2, { type: "reply-drafted" }>).id, (event as Extract<ReplyEventV2, { type: "reply-drafted" }>).target.tweetId]));
  const released = new Set(events.filter((event) => event.type === "reply-released").map((event) => event.id));
  const prepared = events.filter((event) => event.type === "reply-prepared" && !released.has(event.id));
  const published = events.filter((event) => event.type === "reply-published");
  if ([...prepared, ...published].some((event) => targetIds.get(event.id) === draft.target.tweetId)) {
    return { status: "blocked", reason: "target-already-replied-or-unresolved" };
  }
  const limit = input.dailyLimit ?? DEFAULT_REPLY_DAILY_LIMIT_V2;
  const today = dayKey(now.toISOString(), input.timezone);
  if (prepared.filter((event) => dayKey((event as Extract<ReplyEventV2, { type: "reply-prepared" }>).preparedAt, input.timezone) === today).length >= limit) {
    return { status: "blocked", reason: "reply-daily-limit" };
  }
  // The prepared record is written at the send boundary, so a guard that declines beforehand blocks nothing.
  let sent = false;
  const xId = await input.dispatch(candidate.text, draft.target.tweetId, () => {
    sent = true;
    input.ledger.append({ type: "reply-prepared", id: draft.id, pick: input.pick, text: candidate.text, preparedAt: now.toISOString() });
  });
  if (!xId) return { status: "blocked", reason: sent ? "x-dispatch-unresolved (check the account before retrying)" : "x-not-sent (guard declined; retry later)" };
  input.ledger.append({ type: "reply-published", id: draft.id, pick: input.pick, text: candidate.text, xId, publishedAt: new Date().toISOString() });
  return { status: "published", xId };
}
