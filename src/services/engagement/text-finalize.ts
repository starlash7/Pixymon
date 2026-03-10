import {
  polishTweetText,
  sanitizeTweetText,
  stripNarrativeControlTags,
} from "./quality.js";

export function finalizeGeneratedText(text: string, language: "ko" | "en", maxChars: number): string {
  const stripped = stripNarrativeControlTags(text);
  const polished = polishTweetText(stripped, language);
  const truncated = truncateAtWordBoundary(polished, maxChars);
  const deduped = collapseImmediateSentenceRepeat(truncated, language);
  const deRepeated = removeRepeatedSentences(deduped);
  const laneAdjusted = language === "ko" ? reduceLaneAnchorEcho(deRepeated) : deRepeated;
  const varied = language === "ko" ? diversifyKoTransitions(laneAdjusted) : laneAdjusted;
  const selfSoftened = language === "ko" ? softenExplicitSelfReferenceKo(varied) : varied;
  const cleaned = cleanupDanglingTail(trimTrailingFragment(pruneIncompleteSentences(selfSoftened, language), language), language);
  const punctuated = ensureTerminalPunctuation(cleaned, maxChars);
  return punctuated.length <= maxChars ? punctuated : truncateAtWordBoundary(punctuated, maxChars);
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
    output = output
      .replace(/\s+(?:반증|조건|근거|근거는|단서|단서는|그리고|하지만|또|또는)$/g, "")
      .replace(/\s+(?:않으면|아니면|라면|가면|되면|놓지|놓고|않고|보고|한\s*번\s*더)$/g, "")
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

function softenExplicitSelfReferenceKo(text: string): string {
  return sanitizeTweetText(text)
    .replace(/픽시몬은/g, "나는")
    .replace(/픽시몬이/g, "내가")
    .replace(/픽시몬의/g, "내")
    .replace(/픽시몬 기준으로/g, "내 기준으로")
    .replace(/픽시몬 메모/g, "내 메모");
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
      /(?:못하면|처음으로|여기서|이\s*해석은|이\s*문장은|이\s*생각은|오늘\s*결론은)$/.test(core);
    if (
      (looksDangling && core.length <= 24) ||
      (core.length <= 8 && !looksComplete) ||
      danglingEvidenceList ||
      nounTailWithoutPredicate ||
      truncatedThesisTail
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
