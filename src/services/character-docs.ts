import fs from "fs";
import path from "path";
import { TrendLane } from "../types/agent.js";

type CharacterDocKey = "soul" | "memory" | "dreams";

export interface CharacterDocsSnapshot {
  rootDir: string;
  soul: string[];
  memory: string[];
  dreams: string[];
}

export interface CharacterCanonSlice {
  soulLine: string;
  memoryLine: string;
  dreamLine: string;
}

const DOC_FILES: Record<CharacterDocKey, string> = {
  soul: "SOUL.md",
  memory: "MEMORY.md",
  dreams: "DREAMS.md",
};

const LANE_KEYWORDS: Record<TrendLane, string[]> = {
  protocol: ["출시", "업그레이드", "운영", "복구", "검증자", "로그", "릴리스", "배포"],
  ecosystem: ["생태계", "커뮤니티", "재방문", "잔류", "사용", "개발자", "열기", "사람"],
  regulation: ["규제", "법원", "판결", "집행", "승인", "기사", "정책", "자금"],
  macro: ["시대", "국면", "거시", "정책", "달러", "금리", "자금", "배치"],
  onchain: ["온체인", "체인", "주소", "지갑", "예치", "사용", "숫자", "흔적"],
  "market-structure": ["호가", "체결", "유동성", "주문", "깊이", "돈", "열기", "시장"],
};

let docsCache:
  | {
      cacheKey: string;
      snapshot: CharacterDocsSnapshot;
    }
  | null = null;

function resolveCharacterDocsRoot(rootDir?: string): string {
  return path.resolve(rootDir || process.env.PIXYMON_CHARACTER_DOCS_ROOT || process.cwd());
}

function readDocFile(rootDir: string, filename: string): string {
  const filePath = path.join(rootDir, filename);
  if (!fs.existsSync(filePath)) {
    return "";
  }
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function buildCacheKey(rootDir: string): string {
  const parts = Object.values(DOC_FILES).map((filename) => {
    const filePath = path.join(rootDir, filename);
    try {
      const stat = fs.statSync(filePath);
      return `${filename}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${filename}:missing`;
    }
  });
  return `${rootDir}|${parts.join("|")}`;
}

function normalizeDocLines(raw: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const sourceLine of String(raw || "").split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line) {
      continue;
    }
    const cleaned = line
      .replace(/^#{1,6}\s*/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned || cleaned.length < 8) {
      continue;
    }
    lines.push(cleaned);
  }
  return Array.from(new Set(lines)).slice(0, 18);
}

function stableHash(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function scoreCanonLine(line: string, laneHint?: TrendLane, key?: CharacterDocKey): number {
  const normalized = line.toLowerCase();
  let score = 0;
  if (laneHint) {
    for (const keyword of LANE_KEYWORDS[laneHint]) {
      if (normalized.includes(keyword.toLowerCase())) {
        score += 4;
      }
    }
  }
  if (key === "soul" && /(나는|믿는다|싫어|거부|가른다|판단)/.test(line)) {
    score += 2;
  }
  if (key === "memory" && /(배웠다|기억|적이 있다|여러 번|못 했다)/.test(line)) {
    score += 2;
  }
  if (key === "dreams" && /(되고 싶다|궁금해해야 한다|만들고 싶다|진화하고 싶다)/.test(line)) {
    score += 2;
  }
  return score;
}

function pickCanonLine(key: CharacterDocKey, lines: string[], laneHint?: TrendLane): string {
  if (lines.length === 0) {
    return "";
  }
  const scored = lines
    .map((line) => ({
      line,
      score: scoreCanonLine(line, laneHint, key),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.line.localeCompare(b.line, "ko");
    });
  const topScore = scored[0]?.score ?? 0;
  const candidates = scored.filter((item) => item.score === topScore).map((item) => item.line);
  const seed = stableHash(`${key}|${laneHint || "none"}|${candidates.join("|")}`);
  return candidates[seed % candidates.length] || scored[0]?.line || "";
}

export function loadCharacterDocs(rootDir?: string): CharacterDocsSnapshot {
  const resolvedRoot = resolveCharacterDocsRoot(rootDir);
  const cacheKey = buildCacheKey(resolvedRoot);
  if (docsCache && docsCache.cacheKey === cacheKey) {
    return docsCache.snapshot;
  }
  const snapshot: CharacterDocsSnapshot = {
    rootDir: resolvedRoot,
    soul: normalizeDocLines(readDocFile(resolvedRoot, DOC_FILES.soul)),
    memory: normalizeDocLines(readDocFile(resolvedRoot, DOC_FILES.memory)),
    dreams: normalizeDocLines(readDocFile(resolvedRoot, DOC_FILES.dreams)),
  };
  docsCache = { cacheKey, snapshot };
  return snapshot;
}

export function getCharacterCanonSlice(
  language: "ko" | "en" = "ko",
  laneHint?: TrendLane,
  rootDir?: string
): CharacterCanonSlice {
  void language;
  const docs = loadCharacterDocs(rootDir);
  return {
    soulLine: pickCanonLine("soul", docs.soul, laneHint),
    memoryLine: pickCanonLine("memory", docs.memory, laneHint),
    dreamLine: pickCanonLine("dreams", docs.dreams, laneHint),
  };
}

export function getCharacterCanonOverview(rootDir?: string): CharacterCanonSlice {
  return getCharacterCanonSlice("ko", undefined, rootDir);
}

export function resetCharacterDocsCacheForTests(): void {
  docsCache = null;
}
