import {
  polishTweetText,
  sanitizeTweetText,
  stripNarrativeControlTags,
} from "./quality.js";
import { applyKoNarrativeLexicon } from "../narrative-lexicon.js";

export type NarrativeSurface = "post" | "quote" | "reply";

export function finalizeGeneratedText(text: string, language: "ko" | "en", maxChars: number): string {
  const stripped = stripNarrativeControlTags(text);
  const polished = polishTweetText(stripped, language);
  const naturalized = language === "ko" ? applyKoNarrativeLexicon(polished) : polished;
  const anchorNormalized = language === "ko" ? normalizeKoAnchorSuffixes(naturalized) : naturalized;
  const truncated = truncateAtWordBoundary(anchorNormalized, maxChars);
  const deduped = collapseImmediateSentenceRepeat(truncated, language);
  const deRepeated = removeRepeatedSentences(deduped);
  const laneAdjusted = language === "ko" ? reduceLaneAnchorEcho(deRepeated) : deRepeated;
  const stackedLeadCollapsed = language === "ko" ? collapseStackedKoLeadPrelude(laneAdjusted) : laneAdjusted;
  const repeatedLeadCollapsed = language === "ko" ? collapseRepeatedKoLeadPhrase(stackedLeadCollapsed) : stackedLeadCollapsed;
  const varied = language === "ko" ? diversifyKoTransitions(repeatedLeadCollapsed) : repeatedLeadCollapsed;
  const selfSoftened = language === "ko" ? softenExplicitSelfReferenceKo(varied) : varied;
  const conceptAdjusted = language === "ko" ? rebalanceKoConceptLead(selfSoftened) : selfSoftened;
  const particleAdjusted = language === "ko" ? correctKoParticles(conceptAdjusted) : conceptAdjusted;
  const sceneTailAdjusted = language === "ko" ? repairMalformedKoSceneTails(particleAdjusted) : particleAdjusted;
  const cleaned = cleanupDanglingTail(
    trimTrailingFragment(pruneIncompleteSentences(sceneTailAdjusted, language), language),
    language
  );
  const punctuated = ensureTerminalPunctuation(cleaned, maxChars);
  return punctuated.length <= maxChars ? punctuated : truncateAtWordBoundary(punctuated, maxChars);
}

export function finalizeNarrativeSurface(
  text: string,
  language: "ko" | "en",
  maxChars: number,
  surface: NarrativeSurface
): string {
  let finalized = finalizeGeneratedText(text, language, maxChars);
  if (!finalized) return finalized;

  if (language === "ko") {
    finalized = applySurfaceCadence(finalized, language, maxChars, surface);
    finalized = finalizeGeneratedText(finalized, language, maxChars);
  }

  return finalized.length <= maxChars ? finalized : truncateAtWordBoundary(finalized, maxChars);
}

export function applyNarrativeLayout(text: string, language: "ko" | "en", maxChars: number): string {
  const normalized = sanitizeTweetText(String(text || ""));
  if (!normalized) return "";

  const parts = normalized
    .split(/(?<=[.!?])/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (parts.length < 2) {
    return normalized;
  }

  const layouts = buildNarrativeLayouts(parts, language);
  const seed = stableSeedForPrelude(normalized);

  for (let i = 0; i < layouts.length; i += 1) {
    const candidate = layouts[(seed + i) % layouts.length];
    const cleaned = candidate.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (cleaned && cleaned.length <= maxChars && cleaned !== normalized) {
      return cleaned;
    }
  }

  return normalized;
}

function applySurfaceCadence(
  text: string,
  language: "ko" | "en",
  maxChars: number,
  surface: NarrativeSurface
): string {
  const normalized = sanitizeTweetText(String(text || ""));
  if (!normalized || language !== "ko") return normalized;

  const parts = normalized
    .split(/(?<=[.!?])/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (parts.length < 2) {
    return normalized;
  }

  const seed = stableSeedForPrelude(`${surface}|${normalized}`);
  const candidates: string[] = [];

  if (surface === "post") {
    candidates.push(applyNarrativeLayout(normalized, language, maxChars));
  }

  if (surface === "quote") {
    candidates.push(applyNarrativeLayout(normalized, language, maxChars));
    if (parts.length >= 2) {
      candidates.push(`${parts[0]}\n${parts.slice(1).join(" ")}`);
      candidates.push(`${parts[0]}\n\n${parts.slice(1).join(" ")}`);
    }
  }

  if (surface === "reply" && parts.length === 2 && normalized.length >= 52) {
    candidates.push(`${parts[0]}\n${parts[1]}`);
    candidates.push(`${parts[0]}\n\n${parts[1]}`);
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[(seed + i) % candidates.length]
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (candidate && candidate !== normalized && candidate.length <= maxChars) {
      return candidate;
    }
  }

  return normalized;
}

export function truncateAtWordBoundary(text: string, maxChars: number): string {
  const normalized = sanitizeTweetText(String(text || ""));
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const hard = normalized.slice(0, maxChars);
  const cut = Math.max(
    hard.lastIndexOf(". "),
    hard.lastIndexOf("? "),
    hard.lastIndexOf("! "),
    hard.lastIndexOf(", "),
    hard.lastIndexOf(" ")
  );
  if (cut >= Math.floor(maxChars * 0.65)) {
    return hard.slice(0, cut).trim();
  }
  return hard.trim();
}

export function stableSeedForPrelude(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function normalizeQuestionTail(text: string, _language: "ko" | "en"): string {
  const trimmed = sanitizeTweetText(text);
  if (!trimmed) return "";
  if (/[?؟]$/.test(trimmed)) return trimmed;
  if (/[.!]$/.test(trimmed)) return trimmed;
  return `${trimmed}?`;
}

function cleanupDanglingTail(text: string, language: "ko" | "en"): string {
  let output = sanitizeTweetText(text);
  if (!output) return output;
  if (language === "ko") {
    const parts = output
      .split(/(?<=[.!?])/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      const core = last.replace(/[.!?]+$/g, "").trim();
      if (shouldDropKoTrailingSentence(core)) {
        output = sanitizeTweetText(parts.slice(0, -1).join(" "));
      }
    }
    output = output
      .replace(/\s+(?:반증|조건|근거|근거는|단서|단서는|그리고|하지만|또|또는)$/g, "")
      .replace(/\s+(?:않으면|아니면|라면|가면|되면|놓지|놓고|않고|보고|넘기지|한\s*번\s*더|다음)$/g, "")
      .replace(/\s+[이가은는을를의로와과도]$/g, "")
      .replace(/\s*[,:;]\s*$/g, "")
      .trim();
    return output;
  }
  return output
    .replace(/\s+(?:if|because|and|but|or)$/gi, "")
    .replace(/\s*[,:;]\s*$/g, "")
    .trim();
}

function repairMalformedKoSceneTails(text: string): string {
  return sanitizeTweetText(text)
    .replace(/보이는에서/gu, "보이는 자리에서")
    .replace(/드러나는에서/gu, "드러나는 자리에서")
    .replace(/머무는에서/gu, "머무는 자리에서")
    .replace(/주저앉는에서/gu, "주저앉는 자리에서");
}

function softenExplicitSelfReferenceKo(text: string): string {
  return sanitizeTweetText(text)
    .replace(/픽시몬은/g, "나는")
    .replace(/픽시몬이/g, "내가")
    .replace(/픽시몬의/g, "내")
    .replace(/픽시몬 기준으로/g, "내 기준으로")
    .replace(/픽시몬 메모/g, "내 메모");
}

function rebalanceKoConceptLead(text: string): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;
  const parts = normalized
    .split(/(?<=[.!?])/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (parts.length < 2) return normalized;

  const leadingConcept: string[] = [];
  while (parts.length > 0 && isKoConceptCueSentence(parts[0])) {
    const sentence = parts.shift();
    if (!sentence) break;
    if (leadingConcept.length === 0 || normalizeKoConceptCue(sentence) !== normalizeKoConceptCue(leadingConcept[leadingConcept.length - 1])) {
      leadingConcept.push(sentence);
    }
  }

  if (leadingConcept.length === 0 || parts.length === 0) {
    return normalized;
  }

  const reordered = [parts[0], ...leadingConcept, ...parts.slice(1)];
  return sanitizeTweetText(reordered.join(" "));
}

function collapseRepeatedKoLeadPhrase(text: string): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;
  const parts = normalized
    .split(/(?<=[.!?])/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (parts.length === 0) return normalized;

  const words = parts[0].split(/\s+/).filter(Boolean);
  for (let size = 5; size >= 2; size -= 1) {
    if (words.length < size * 2) continue;
    const left = words.slice(0, size).join(" ");
    const right = words.slice(size, size * 2).join(" ");
    if (left.length < 6) continue;
    if (left === right) {
      parts[0] = [...words.slice(0, size), ...words.slice(size * 2)].join(" ").trim();
      return sanitizeTweetText(parts.join(" "));
    }
  }
  return normalized;
}

function collapseStackedKoLeadPrelude(text: string): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;
  return sanitizeTweetText(
    normalized.replace(
      /^(?:프로토콜|생태계|규제|정책 반응|크립토 시장|온체인|체인 안쪽|시장|실사용|업그레이드 장면|실제 돈이 붙는 쪽에선)\s*(?:쪽에선|에선|으로 보면)\s+((?:프로토콜|생태계|규제|정책 반응|크립토 시장|온체인|체인 안쪽|시장|실사용)\s*(?:쪽에선|에선))/u,
      "$1"
    ).replace(
      /([.!?]\s+)(?:프로토콜|생태계|규제|정책 반응|크립토 시장|온체인|체인 안쪽|시장|실사용|업그레이드 장면|실제 돈이 붙는 쪽)\s*(?:쪽에선|에선|으로 보면)\s+(아직\s+(?:바로\s+(?:믿기엔|먹기엔)|천천히\s+소화할|한\s+번\s+더\s+씹어\s+볼)[^.?!]*[.?!])/u,
      "$1$2"
    )
  );
}

function isKoConceptCueSentence(text: string): boolean {
  const normalized = sanitizeTweetText(text);
  return /(?:아직\s+바로\s+믿기엔\s+이른|아직\s+바로\s+단정할|아직\s+한\s+번\s+더\s+씹어|급히\s+삼키지\s+않|바로\s+믿지\s+않|오늘\s+단서가\s+된|단서가\s+된다|돈이\s+붙어야|한\s+번\s+더\s+씹는다)/.test(
    normalized
  );
}

function normalizeKoConceptCue(text: string): string {
  return sanitizeTweetText(text)
    .replace(/^(?:프로토콜|생태계|규제|정책 반응|크립토 시장|온체인|체인 안쪽|시장|실제 돈이 붙는 쪽에선)\s*(?:쪽에선|에선|으로 보면)?\s*/u, "")
    .replace(/[.!?]+$/g, "")
    .trim();
}

function normalizeKoAnchorSuffixes(text: string): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;

  return sanitizeTweetText(
    normalized
      .replace(
        /([가-힣A-Za-z0-9\s]+?(?:는지|모습|원칙|체계|과정|변동성|규칙|서사|속도|신호|수요\s*변화))\s+쪽부터/g,
        "$1부터"
      )
      .replace(
        /([가-힣A-Za-z0-9\s]+?(?:는지|모습|원칙|체계|과정|변동성|규칙|서사|속도|신호|수요\s*변화))\s+쪽을/g,
        "$1을"
      )
      .replace(
        /([가-힣A-Za-z0-9\s]+?(?:는지|모습|원칙|체계|과정|변동성|규칙|서사|속도|신호|수요\s*변화))\s+쪽이/g,
        "$1이"
      )
      .replace(
        /([가-힣A-Za-z0-9\s]+?(?:는지|모습|원칙|체계|과정|변동성|규칙|서사|속도|신호|수요\s*변화))\s+쪽만/g,
        "$1만"
      )
  );
}

function correctKoParticles(text: string): string {
  const normalized = sanitizeTweetText(text);
  const pickParticle = (word: string, consonantForm: string, vowelForm: string): string => {
    const last = word[word.length - 1];
    const code = last?.charCodeAt(0) ?? 0;
    const isHangulSyllable = code >= 0xac00 && code <= 0xd7a3;
    if (!isHangulSyllable) {
      return vowelForm;
    }
    const hasBatchim = (code - 0xac00) % 28 !== 0;
    return hasBatchim ? consonantForm : vowelForm;
  };

  return normalized.replace(/([가-힣]+)([은는이가을를와과])(?=(?:\s|[.!?,]|$))/g, (_match, word: string, particle: string) => {
    const resolved =
      particle === "은" || particle === "는"
        ? pickParticle(word, "은", "는")
        : particle === "이" || particle === "가"
          ? pickParticle(word, "이", "가")
          : particle === "을" || particle === "를"
            ? pickParticle(word, "을", "를")
            : pickParticle(word, "과", "와");
    return `${word}${resolved}`;
  })
    .replace(/없은/g, "없는")
    .replace(/있은/g, "있는");
}

function ensureTerminalPunctuation(text: string, maxChars: number): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;
  if (/[.!?]$/.test(normalized)) return normalized;
  if (normalized.length + 1 <= maxChars) {
    return `${normalized}.`;
  }
  return normalized;
}

function removeRepeatedSentences(text: string): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;
  const parts = normalized
    .split(/(?<=[.!?])/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (parts.length < 2) return normalized;

  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of parts) {
    const key = sanitizeTweetText(part)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!key) continue;
    if (key.length >= 10 && seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(part);
  }
  return sanitizeTweetText(kept.join(" "));
}

function reduceLaneAnchorEcho(text: string): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;
  const parts = normalized
    .split(/(?<=[.!?])/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (parts.length < 2) return normalized;

  const laneRegex = /^(프로토콜|생태계|규제|매크로|온체인|시장구조)\s*관점에서\s*/;
  const firstLane = parts[0].match(laneRegex)?.[1] || "";
  if (!firstLane) return normalized;

  const adjusted = parts.map((part, index) => {
    if (index === 0) return part;
    const match = part.match(laneRegex);
    if (!match || match[1] !== firstLane) return part;
    const stripped = part.replace(laneRegex, "").trim();
    return stripped || part;
  });

  return sanitizeTweetText(adjusted.join(" "));
}

function diversifyKoTransitions(text: string): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;

  const parts = normalized
    .split(/(?<=[.!?])/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (parts.length < 2) return normalized;

  const seed = stableSeedForPrelude(normalized);
  const leadVariants: Record<string, string[]> = {
    "먼저": ["이어서", "다음으로", "이번에는", "우선"],
    "지금은": ["이어서", "이번에는", "다음으로는", "현시점에서는"],
    "우선": ["먼저", "일단", "이번엔", "첫 단계로"],
    "지금": ["이번엔", "이 시점엔", "현 시점에서는", "이 장면에선"],
  };

  const leadSeen = new Map<string, number>();
  let evidencePhraseCount = 0;
  let framePhraseCount = 0;

  const adjusted = parts.map((raw, index) => {
    let sentence = raw;
    for (const lead of Object.keys(leadVariants)) {
      const match = sentence.match(new RegExp(`^${lead}\\s+`));
      if (!match) continue;
      const seen = leadSeen.get(lead) || 0;
      leadSeen.set(lead, seen + 1);
      if (seen >= 1) {
        const pool = leadVariants[lead];
        const replacement = pool[(seed + index + seen) % pool.length];
        sentence = sentence.replace(new RegExp(`^${lead}\\s+`), `${replacement} `);
      }
    }

    if (/두\s*근거/.test(sentence)) {
      evidencePhraseCount += 1;
      if (evidencePhraseCount >= 2) {
        const replacements = ["핵심 단서", "근거 묶음", "두 단서"];
        const replacement = replacements[(seed + index + evidencePhraseCount) % replacements.length];
        sentence = sentence.replace(/두\s*근거/, replacement);
      }
    }

    if (/같은\s*프레임에\s*둔다/.test(sentence)) {
      framePhraseCount += 1;
      if (framePhraseCount >= 2) {
        const replacements = ["같은 좌표에서 대조한다", "동일한 기준선에서 비교한다", "한 축에서 교차 확인한다"];
        const replacement = replacements[(seed + index + framePhraseCount) % replacements.length];
        sentence = sentence.replace(/같은\s*프레임에\s*둔다/, replacement);
      }
    }

    return sentence;
  });

  return sanitizeTweetText(adjusted.join(" "));
}

function trimTrailingFragment(text: string, language: "ko" | "en"): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;
  const parts = normalized
    .split(/(?<=[.!?])/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (parts.length < 2) return normalized;

  const last = parts[parts.length - 1];
  const core = last.replace(/[.!?]+$/g, "").trim();
  if (!core || core.length <= 2) {
    return sanitizeTweetText(parts.slice(0, -1).join(" "));
  }
  if (language === "ko") {
    const looksComplete = hasKoPredicateEnding(core);
    const looksDangling = /(있는|없는|하는|되는|같은|라는|도록|으로|에서|에게|부터|까지|보다|처럼|만큼|한\s*것|할\s*것|않으면|아니면|라면|가면|되면|못하면|놓지|놓고|않고|보고|한\s*번\s*더|[은는이가을를의로와과도])$/.test(
      core
    );
    const startsWithEvidenceLead = /^(?:근거는|근거\s*[:：]|단서는|단서\s*[:：]|기준은|포인트는)\s*/.test(core);
    const danglingEvidenceList =
      startsWithEvidenceLead &&
      /[,·|]/.test(core) &&
      !looksComplete &&
      !/[가-힣]\s*(?:다|한다|했다|된다|보인다|남는다|움직인다|이어진다|읽힌다|보류한다|철회한다)$/.test(core);
    const nounTailWithoutPredicate =
      !looksComplete &&
      /[가-힣A-Za-z0-9]$/.test(core) &&
      !/[.!?]/.test(core) &&
      !/\b(?:and|but|or|if|because)\b/i.test(core) &&
      /(근거는|단서는|기준은|포인트는|현시점에서는|이번에는|지금은|우선|먼저|이어서|다음으로|않으면|아니면|라면|가면|되면|놓지|놓고|않고|보고|한\s*번\s*더)/.test(core);
    const truncatedThesisTail =
      !looksComplete &&
      /(?:못하면|처음으로|여기서|이\s*해석은|이\s*문장은|이\s*생각은|오늘\s*결론은|기대는\s*순간|믿는\s*순간|매달리는\s*순간|급히\s*넘기지)$/.test(
        core
      );
    const truncatedSceneTail =
      !looksComplete &&
      /(?:장면으로|기사로|해설로|방송으로|연출로|캠페인으로|쇼케이스로|포스터\s*값으로)$/.test(core);
    const truncatedDescriptorTail =
      !looksComplete &&
      /(?:설명만\s*큰|기사만\s*큰|해설만\s*큰|반응만\s*큰|열기만\s*큰|포장만\s*큰|발표만\s*큰)$/.test(core);
    const demonstrativeNounFragment =
      !looksComplete &&
      /^(?:이|그|저)\s+(?:소송|발표|뉴스|장면|반응|런치|출시|메인넷\s*얘기|법원\s*뉴스|규제\s*뉴스|생태계\s*얘기|업그레이드\s*얘기|거래량|체결|과열)$/.test(
        core
      );
    if (
      shouldDropKoTrailingSentence(core) ||
      (looksDangling && core.length <= 24) ||
      (core.length <= 8 && !looksComplete) ||
      danglingEvidenceList ||
      nounTailWithoutPredicate ||
      truncatedThesisTail ||
      truncatedSceneTail ||
      truncatedDescriptorTail ||
      demonstrativeNounFragment
    ) {
      return sanitizeTweetText(parts.slice(0, -1).join(" "));
    }
    return normalized;
  }
  const looksCompleteEn = /\b(?:is|are|was|were|do|does|did|can|could|should|would|will|won't|can't|must|may)\b/i.test(core);
  if (core.length <= 10 && !looksCompleteEn) {
    return sanitizeTweetText(parts.slice(0, -1).join(" "));
  }
  return normalized;
}

function collapseImmediateSentenceRepeat(text: string, _language: "ko" | "en"): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;
  const parts = normalized
    .split(/(?<=[.!?])/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (parts.length < 2) return normalized;

  const normalizeSentence = (input: string): string =>
    sanitizeTweetText(input)
      .toLowerCase()
      .replace(
        /^(?:프로토콜|생태계|규제|매크로|온체인|시장구조)\s*관점에서\s+|^(?:오늘\s*유독\s*걸리는\s*장면은|이상하게\s*계속\s*남는\s*건|계속\s*머리에\s*맴도는\s*건|지금\s*먼저\s*적어\s*두고\s*싶은\s*건|숫자보다\s*먼저\s*마음에\s*걸린\s*건|조금\s*더\s*들여다보고\s*싶은\s*건|이번\s*흐름에서\s*자꾸\s*손이\s*가는\s*건|한\s*발\s*물러서서\s*보면\s*먼저\s*보이는\s*건|계산보다\s*먼저\s*걸린\s*건|오늘은\s*이\s*장면부터\s*붙잡는다|오늘\s*먼저\s*붙잡을\s*장면은|오늘\s*끝까지\s*붙들고\s*싶은\s*건|한참\s*마음에\s*남아\s*있는\s*건|지금\s*내\s*메모의\s*첫\s*줄은|괜히\s*오래\s*남는\s*건|지금\s*계속\s*마음에\s*남는\s*건)\s+|^from a\s+(?:protocol|ecosystem|regulation|macro|onchain|market-structure)\s+lens,\s+/i,
        ""
      )
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

  const a = normalizeSentence(parts[0]);
  const b = normalizeSentence(parts[1]);
  if (a.length < 8 || b.length < 8 || a !== b) {
    return normalized;
  }

  return sanitizeTweetText([parts[0], ...parts.slice(2)].join(" "));
}

function pruneIncompleteSentences(text: string, language: "ko" | "en"): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;

  const parts = normalized
    .split(/(?<=[.!?])/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (parts.length < 2) return normalized;

  const kept = parts.filter((part, index) => {
    if (index === parts.length - 1) {
      return true;
    }
    const core = part.replace(/[.!?]+$/g, "").trim();
    if (!core) return false;
    if (language === "en") {
      return true;
    }

    const hasPredicate = hasKoPredicateEnding(core);
    if (hasPredicate || /[?؟]$/.test(part)) {
      return true;
    }

    if (/^(?:근거는|단서는|포인트는|기준은)\s*/.test(core)) {
      return false;
    }
    if (/(어디에|무엇을|어떤|어느|왜|어떻게|말도|가운데|중에서)$/.test(core)) {
      return false;
    }
    if (/(부터|까지|처럼|향해|하려고|하려는|쯤에서)$/.test(core)) {
      return false;
    }
    if (/[,·|]/.test(core) && core.length <= 36) {
      return false;
    }
    if (core.length <= 16) {
      return false;
    }
    return true;
  });

  return kept.length > 0 ? sanitizeTweetText(kept.join(" ")) : normalized;
}

function buildNarrativeLayouts(parts: string[], language: "ko" | "en"): string[] {
  const safe = parts.map((item) => item.trim()).filter(Boolean);
  if (safe.length < 2) return [safe.join(" ")];

  const layouts = new Set<string>();
  const joinRange = (start: number, end: number): string => safe.slice(start, end).join(" ").trim();

  layouts.add(safe.join(" "));

  if (safe.length === 2) {
    layouts.add(`${safe[0]}\n\n${safe[1]}`);
    layouts.add(`${safe[0]}\n${safe[1]}`);
    return [...layouts];
  }

  if (safe.length === 3) {
    layouts.add(`${safe[0]}\n\n${joinRange(1, 3)}`);
    layouts.add(`${joinRange(0, 2)}\n\n${safe[2]}`);
    layouts.add(`${safe[0]}\n${safe[1]}\n\n${safe[2]}`);
    layouts.add(`${safe[0]}\n\n${safe[1]}\n\n${safe[2]}`);
    if (language === "ko") {
      layouts.add(`${safe[0]}\n\n${safe[1]}\n${safe[2]}`);
    }
    return [...layouts];
  }

  layouts.add(`${safe[0]}\n\n${joinRange(1, 3)}\n\n${joinRange(3, safe.length)}`);
  layouts.add(`${joinRange(0, 2)}\n\n${joinRange(2, 4)}\n${joinRange(4, safe.length)}`);
  layouts.add(`${safe[0]}\n${safe[1]}\n\n${joinRange(2, safe.length)}`);
  layouts.add(`${joinRange(0, safe.length - 1)}\n\n${safe[safe.length - 1]}`);
  layouts.add(`${safe[0]}\n\n${safe[1]}\n\n${joinRange(2, safe.length)}`);
  layouts.add(`${joinRange(0, 2)}\n\n${safe[2]}\n\n${joinRange(3, safe.length)}`);
  return [...layouts];
}

function hasKoPredicateEnding(text: string): boolean {
  return /(다|요|까|자|함|됨|한다|했다|싶다|없다|있다|보인다|남는다|움직인다|이어진다|읽힌다|달린다|가깝다|중이다|좋다|나쁘다|맞다|틀리다|늦춘다|바꾼다|접는다|철회한다|보류한다|흐려진다|멈춘다|남긴다|고른다|시작된다|보탠다|가리킨다|비교한다|대조한다|확인한다|짚어본다|붙어\s*있다|적어\s*둔다|붙들고\s*간다)$/.test(
    text
  );
}

function shouldDropKoTrailingSentence(core: string): boolean {
  const normalized = sanitizeTweetText(core).replace(/[.!?]+$/g, "").trim();
  if (!normalized || hasKoPredicateEnding(normalized) || /[?؟]$/.test(normalized)) {
    return false;
  }

  return (
    /(?:뒤에야|그제야|끝에야)\s*(?:다음|그다음)$/.test(normalized) ||
    /(?:다음|그다음)$/.test(normalized)
  );
}
