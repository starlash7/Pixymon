import { TrendLane } from "../../../types/agent.js";

export type PlannerFocus =
  | "retention"
  | "hype"
  | "builder"
  | "execution"
  | "court"
  | "liquidity"
  | "settlement"
  | "durability"
  | "launch"
  | "flow"
  | "general";

export interface PlannerSceneSelection {
  focus: PlannerFocus;
  sceneFamily?: string;
  sceneBase?: string;
  sceneTilt?: string;
}

export interface RecentNarrativeThread {
  lane: TrendLane;
  focus?: string;
  sceneFamily?: string;
  headline?: string;
}
