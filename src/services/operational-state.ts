import fs from "fs";
import path from "path";
import { RuntimeConfig } from "../config/runtime.js";
import { memory } from "./memory.js";
import { TEST_MODE } from "./twitter.js";
import { xApiBudget } from "./x-api-budget.js";

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_PATH = path.join(DATA_DIR, "operational-state.json");
const STATE_MD_PATH = path.join(DATA_DIR, "STATE.md");
const MAX_EVENTS = 120;

interface OperationalStateSnapshot {
  capturedAt: string;
  timezone: string;
  actionMode: "observe" | "paper" | "live";
  schedulerMode: boolean;
  testMode: boolean;
  mentionCursor?: string;
  lastTweetId?: string;
  lastTweetType?: "briefing" | "reply" | "quote";
  todayActivityCount: number;
  budget: {
    dateKey: string;
    readRequests: number;
    createRequests: number;
    estimatedTotalCostUsd: number;
  };
}

interface OperationalEvent {
  at: string;
  type: string;
  detail: string;
}

interface OperationalStateData {
  schemaVersion: 1;
  lastBootAt?: string;
  lastShutdownAt?: string;
  lastShutdownReason?: string;
  snapshot: OperationalStateSnapshot;
  events: OperationalEvent[];
  updatedAt: string;
}

function createEmptySnapshot(): OperationalStateSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    timezone: "Asia/Seoul",
    actionMode: "observe",
    schedulerMode: false,
    testMode: TEST_MODE,
    todayActivityCount: 0,
    budget: {
      dateKey: new Date().toISOString().slice(0, 10),
      readRequests: 0,
      createRequests: 0,
      estimatedTotalCostUsd: 0,
    },
  };
}

function createEmptyState(): OperationalStateData {
  return {
    schemaVersion: 1,
    snapshot: createEmptySnapshot(),
    events: [],
    updatedAt: new Date().toISOString(),
  };
}

export class OperationalStateService {
  private readonly statePath: string;
  private readonly stateMarkdownPath: string;
  private data: OperationalStateData;

  constructor(options?: { statePath?: string; stateMarkdownPath?: string }) {
    this.statePath = options?.statePath || STATE_PATH;
    this.stateMarkdownPath = options?.stateMarkdownPath || STATE_MD_PATH;
    this.data = this.load();
  }

  reconcileOnBoot(config: RuntimeConfig): void {
    if (!config.operational.stateReconcileOnBoot) {
      return;
    }
    const memoryCursor = memory.getLastProcessedMentionId();
    const snapshotCursor = this.data.snapshot.mentionCursor;

    if (!memoryCursor && snapshotCursor) {
      memory.setLastProcessedMentionId(snapshotCursor);
      this.appendEvent("reconcile", `mention cursor restored from snapshot: ${snapshotCursor}`);
    } else if (memoryCursor && snapshotCursor && memoryCursor !== snapshotCursor) {
      this.appendEvent("reconcile", `cursor mismatch (memory=${memoryCursor}, snapshot=${snapshotCursor})`);
    }

    this.captureSnapshot(config, "boot-reconcile");
  }

  recordBoot(config: RuntimeConfig): void {
    this.data.lastBootAt = new Date().toISOString();
    this.appendEvent("boot", `mode=${config.operational.actionMode} scheduler=${config.schedulerMode}`);
    this.captureSnapshot(config, "boot");
  }

  recordShutdown(config: RuntimeConfig, reason: string): void {
    this.data.lastShutdownAt = new Date().toISOString();
    this.data.lastShutdownReason = String(reason || "unknown").trim().slice(0, 120);
    this.appendEvent("shutdown", this.data.lastShutdownReason);
    this.captureSnapshot(config, "shutdown");
  }

  recordCheckpoint(config: RuntimeConfig, label: string): void {
    this.captureSnapshot(config, label);
  }

  flushNow(): void {
    this.persist(this.data);
  }

  private captureSnapshot(config: RuntimeConfig, label: string): void {
    const latestTweet = memory.getRecentTweets(1)[0];
    const todayUsage = xApiBudget.getTodayUsage(config.dailyTimezone);
    this.data.snapshot = {
      capturedAt: new Date().toISOString(),
      timezone: config.dailyTimezone,
      actionMode: config.operational.actionMode,
      schedulerMode: config.schedulerMode,
      testMode: TEST_MODE,
      mentionCursor: memory.getLastProcessedMentionId(),
      lastTweetId: latestTweet?.id,
      lastTweetType: latestTweet?.type,
      todayActivityCount: memory.getTodayActivityCount(config.dailyTimezone),
      budget: {
        dateKey: todayUsage.dateKey,
        readRequests: todayUsage.readRequests,
        createRequests: todayUsage.createRequests,
        estimatedTotalCostUsd: todayUsage.estimatedTotalCostUsd,
      },
    };
    this.appendEvent("checkpoint", label);
    this.compactEvents();
    this.persist(this.data);
  }

  private appendEvent(type: string, detail: string): void {
    this.data.events.push({
      at: new Date().toISOString(),
      type: String(type || "event").trim().slice(0, 48),
      detail: String(detail || "").trim().slice(0, 220),
    });
  }

  private compactEvents(): void {
    if (this.data.events.length <= MAX_EVENTS) return;
    this.data.events = this.data.events.slice(-MAX_EVENTS);
  }

  private load(): OperationalStateData {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (!fs.existsSync(this.statePath)) {
        const empty = createEmptyState();
        this.persist(empty);
        return empty;
      }
      const raw = fs.readFileSync(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<OperationalStateData>;
      return this.normalizeState(parsed);
    } catch {
      return createEmptyState();
    }
  }

  private normalizeState(raw: Partial<OperationalStateData>): OperationalStateData {
    const now = new Date().toISOString();
    const snapshot = raw.snapshot || createEmptySnapshot();
    const actionMode = snapshot.actionMode === "paper" || snapshot.actionMode === "live" ? snapshot.actionMode : "observe";
    const normalized: OperationalStateData = {
      schemaVersion: 1,
      lastBootAt: typeof raw.lastBootAt === "string" ? raw.lastBootAt : undefined,
      lastShutdownAt: typeof raw.lastShutdownAt === "string" ? raw.lastShutdownAt : undefined,
      lastShutdownReason: typeof raw.lastShutdownReason === "string" ? raw.lastShutdownReason : undefined,
      snapshot: {
        capturedAt: typeof snapshot.capturedAt === "string" ? snapshot.capturedAt : now,
        timezone: typeof snapshot.timezone === "string" && snapshot.timezone.trim() ? snapshot.timezone : "Asia/Seoul",
        actionMode,
        schedulerMode: Boolean(snapshot.schedulerMode),
        testMode: Boolean(snapshot.testMode),
        mentionCursor: typeof snapshot.mentionCursor === "string" ? snapshot.mentionCursor : undefined,
        lastTweetId: typeof snapshot.lastTweetId === "string" ? snapshot.lastTweetId : undefined,
        lastTweetType:
          snapshot.lastTweetType === "briefing" || snapshot.lastTweetType === "reply" || snapshot.lastTweetType === "quote"
            ? snapshot.lastTweetType
            : undefined,
        todayActivityCount:
          typeof snapshot.todayActivityCount === "number" && Number.isFinite(snapshot.todayActivityCount)
            ? Math.max(0, Math.floor(snapshot.todayActivityCount))
            : 0,
        budget: {
          dateKey:
            snapshot.budget && typeof snapshot.budget.dateKey === "string" && snapshot.budget.dateKey
              ? snapshot.budget.dateKey
              : now.slice(0, 10),
          readRequests:
            snapshot.budget && typeof snapshot.budget.readRequests === "number" && Number.isFinite(snapshot.budget.readRequests)
              ? Math.max(0, Math.floor(snapshot.budget.readRequests))
              : 0,
          createRequests:
            snapshot.budget && typeof snapshot.budget.createRequests === "number" && Number.isFinite(snapshot.budget.createRequests)
              ? Math.max(0, Math.floor(snapshot.budget.createRequests))
              : 0,
          estimatedTotalCostUsd:
            snapshot.budget && typeof snapshot.budget.estimatedTotalCostUsd === "number" && Number.isFinite(snapshot.budget.estimatedTotalCostUsd)
              ? Math.max(0, Math.round(snapshot.budget.estimatedTotalCostUsd * 1000) / 1000)
              : 0,
        },
      },
      events: Array.isArray(raw.events)
        ? raw.events
            .filter((item): item is OperationalEvent => Boolean(item && typeof item === "object"))
            .map((item) => ({
              at: typeof item.at === "string" ? item.at : now,
              type: typeof item.type === "string" ? item.type.slice(0, 48) : "event",
              detail: typeof item.detail === "string" ? item.detail.slice(0, 220) : "",
            }))
            .slice(-MAX_EVENTS)
        : [],
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
    };
    return normalized;
  }

  private persist(data: OperationalStateData): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      data.updatedAt = new Date().toISOString();
      fs.writeFileSync(this.statePath, JSON.stringify(data, null, 2), "utf-8");
      this.writeStateMarkdown(data);
    } catch {
      // no-op
    }
  }

  private writeStateMarkdown(data: OperationalStateData): void {
    const lines: string[] = [];
    lines.push("# STATE");
    lines.push("");
    lines.push(`- updatedAt: ${data.updatedAt}`);
    lines.push(`- actionMode: ${data.snapshot.actionMode}`);
    lines.push(`- schedulerMode: ${data.snapshot.schedulerMode}`);
    lines.push(`- testMode: ${data.snapshot.testMode}`);
    lines.push(`- timezone: ${data.snapshot.timezone}`);
    lines.push(`- mentionCursor: ${data.snapshot.mentionCursor || "none"}`);
    lines.push(`- lastTweetId: ${data.snapshot.lastTweetId || "none"}`);
    lines.push(`- todayActivityCount: ${data.snapshot.todayActivityCount}`);
    lines.push(`- budget(date=${data.snapshot.budget.dateKey}): read=${data.snapshot.budget.readRequests}, create=${data.snapshot.budget.createRequests}, total=$${data.snapshot.budget.estimatedTotalCostUsd.toFixed(3)}`);
    lines.push("");
    lines.push("## Recent Events");
    for (const event of data.events.slice(-12).reverse()) {
      lines.push(`- [${event.at}] ${event.type}: ${event.detail}`);
    }
    fs.writeFileSync(this.stateMarkdownPath, `${lines.join("\n")}\n`, "utf-8");
  }
}

export const operationalState = new OperationalStateService();
