import type { EditorialContextItemV2 } from "./contracts.js";
import type { EvidenceCardV2 } from "./evidence.js";
import type { EditorialSensingResultV2 } from "./provider-adapters.js";

const MAX_RELATED_HEADLINES = 3;
const MAX_OTHER_HEADLINES = 2;
const KOREAN_NAMES: Record<string, string> = { Bitcoin: "비트코인", Ethereum: "이더리움", Solana: "솔라나" };

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function mentions(title: string, needles: readonly string[]): boolean {
  const lower = title.toLowerCase();
  return needles.some((needle) => needle.length >= 3 && new RegExp(`(^|[^a-z0-9])${needle.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}([^a-z0-9]|$)`, "u").test(lower));
}

/**
 * Everything Pixymon read this run that bears on the selected subject, each with its source.
 * Built only from sensing results already fetched; no extra provider calls.
 */
export function buildEditorialContextV2(input: {
  evidence: EvidenceCardV2;
  sensing: Pick<EditorialSensingResultV2, "evidence" | "discoveries">;
}): EditorialContextItemV2[] {
  const { evidence } = input;
  const items: EditorialContextItemV2[] = [];
  const profile = evidence.profile;
  const provider = evidence.source.provider;
  if (profile?.category) items.push({ id: "profile:category", kind: "profile", label: "카테고리", text: profile.category, provider, url: evidence.source.url });
  if (profile?.chains?.length) items.push({ id: "profile:chains", kind: "profile", label: "주요 체인", text: profile.chains.join(", "), provider, url: evidence.source.url });
  if (profile?.symbol) items.push({ id: "profile:symbol", kind: "profile", label: "토큰 심볼", text: `${profile.symbol} ($${profile.symbol})`, provider, url: evidence.source.url });
  if (typeof profile?.change7d === "number") items.push({ id: "profile:change7d", kind: "profile", label: "7일 TVL 변화", text: signed(profile.change7d), provider, url: evidence.source.url });
  if (evidence.followUp?.metric.name === "tvl-usd") items.push({ id: "profile:tvl", kind: "profile", label: "현재 TVL", text: evidence.followUp.metric.raw, provider, url: evidence.source.url });
  if (evidence.selection) {
    items.push({ id: "market:benchmark", kind: "market", label: "주요 프로토콜 TVL 24시간 변화 중간값", text: signed(evidence.selection.benchmarkChangePercent), provider, url: evidence.source.url });
  }
  for (const card of input.sensing.evidence.filter((card) => card.source.provider === "coingecko").slice(0, 2)) {
    const korean = KOREAN_NAMES[card.subject];
    const change = card.profile?.change24h;
    items.push({ id: `market:${card.subject.toLowerCase()}`, kind: "market",
      label: `${korean ? `${korean}(${card.subject}${card.profile?.symbol ? `, $${card.profile.symbol}` : ""})` : card.subject} 가격${typeof change === "number" ? "과 24시간 변화" : "(변화율 없음)"}`,
      text: typeof change === "number" ? `${card.metric.raw}, ${signed(change)}` : card.metric.raw, provider: "coingecko", url: card.source.url });
  }
  const needles = [evidence.subject, evidence.subject.split(/\s+/u)[0], profile?.symbol ?? ""].filter(Boolean);
  const headlines = input.sensing.discoveries.filter((item) => item.title.trim().length > 0);
  const related = headlines.filter((item) => mentions(item.title, needles)).slice(0, MAX_RELATED_HEADLINES);
  const others = headlines.filter((item) => !related.includes(item)).slice(0, MAX_OTHER_HEADLINES);
  for (const [index, item] of related.entries()) {
    items.push({ id: `headline:related:${index}`, kind: "headline", label: "관련 기사 제목", text: item.title.trim().slice(0, 200), provider: item.provider, url: item.url, publishedAt: item.publishedAt });
  }
  for (const [index, item] of others.entries()) {
    items.push({ id: `headline:other:${index}`, kind: "headline", label: "오늘 다른 기사 제목(대상과 무관할 수 있음)", text: item.title.trim().slice(0, 200), provider: item.provider, url: item.url, publishedAt: item.publishedAt });
  }
  return items;
}

/** One block shared by the inquiry, writer and critic prompts. */
export function formatEditorialContextV2(context: readonly EditorialContextItemV2[] | undefined): string {
  if (!context?.length) return "- 추가 재료 없음";
  return context.map((item) => `- ${item.label}: ${item.text} (출처: ${item.provider}${item.kind === "headline" ? ", 남의 보도라 사실 확인 안 됨" : ""})`).join("\n");
}

/** The text re-validation draws allowed numbers and names from. */
export function editorialContextTextV2(context: readonly EditorialContextItemV2[] | undefined): string {
  return (context ?? []).map((item) => `${item.label} ${item.text}`).join("\n");
}
