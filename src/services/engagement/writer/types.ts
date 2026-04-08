import type { PlannerFocus } from "../planner/spec.js";

export type WriterFocus = PlannerFocus;
export type KoWriterFrame = "claim-note" | "field-note" | "cross-exam" | "quest";
export type WriterSegment =
  | "scene"
  | "lead"
  | "stamp"
  | "pressure"
  | "evidence"
  | "instinct"
  | "attitude"
  | "fixation"
  | "decision"
  | "consequence"
  | "question";
