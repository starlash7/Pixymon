import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { planEditorialV2, type PlanEditorialInputV2, type EditorialPlanningResultV2 } from "./planner.js";
import type { EditorialMemoryContextV2 } from "./contracts.js";
import { writeEditorialDraftV2, type EditorialWriterModelV2 } from "./writer.js";

export interface EditorialDecisionContextV2 {
  kind: "pixymon-decision-context";
  version: 1;
  actionId: string;
  trackingMode: "live" | "shadow";
  revision: { commit: string | null; dirty: boolean | null };
  modelId: string;
  writerVersion: "hypothesis-writer-v2";
  planningInput: PlanEditorialInputV2;
  memories: Record<string, EditorialMemoryContextV2>;
  capturedPlanning: EditorialPlanningResultV2;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function editorialCodeRevisionV2(): EditorialDecisionContextV2["revision"] {
  try {
    return {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
      dirty: Boolean(execFileSync("git", ["status", "--porcelain", "--", "src", "scripts", "eval", "package.json", "package-lock.json"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()),
    };
  } catch { return { commit: null, dirty: null }; }
}

/** Private runtime input, not an anonymized public fixture. No provider or LLM calls. */
export function writeEditorialDecisionContextV2(directory: string, context: EditorialDecisionContextV2): string {
  const snapshot = JSON.parse(JSON.stringify(context)) as EditorialDecisionContextV2;
  const serialized = JSON.stringify(snapshot);
  const target = path.join(directory, `${hash(context.actionId)}.json`);
  fs.mkdirSync(directory, { recursive: true });
  const descriptor = fs.openSync(target, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify({ sha256: hash(serialized), context: snapshot })}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  return target;
}

export function readEditorialDecisionContextV2(filePath: string): EditorialDecisionContextV2 {
  const envelope = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const context = envelope.context as EditorialDecisionContextV2;
  if (!context || context.kind !== "pixymon-decision-context" || context.version !== 1 ||
      envelope.sha256 !== hash(JSON.stringify(context)) ||
      !["live", "shadow"].includes(context.trackingMode) ||
      !Array.isArray(context.planningInput?.evidence) ||
      !Number.isFinite(Date.parse(context.planningInput.now)) ||
      context.planningInput.evidence.some((card) => card.lane !== "protocol")) {
    throw new Error("invalid decision context or digest");
  }
  return context;
}

/** Both variants share clock, facts, history, seed and model. Never publishes or mutates memory. */
export async function replayEditorialDecisionV2(input: {
  context: EditorialDecisionContextV2;
  model: EditorialWriterModelV2;
  variant: "captured-plan" | "current-plan";
}) {
  const context = structuredClone(input.context);
  const planning = input.variant === "captured-plan"
    ? context.capturedPlanning
    : planEditorialV2(context.planningInput);
  if (planning.status === "blocked") return { status: "no-post" as const, stage: planning.stage, reason: planning.reason };
  if (input.variant === "current-plan") {
    planning.plan.memoryContext = context.memories[planning.plan.subject];
  }
  const writing = await writeEditorialDraftV2({ model: input.model, plan: planning.plan, evidence: planning.evidence });
  return { planning, writing };
}
