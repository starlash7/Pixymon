import { TrendLane } from "../../../types/agent.js";
import type { KoWriterFrame, WriterFocus, WriterSegment } from "./types.js";

export function buildFrameLayouts(frame: KoWriterFrame, mode: string, lane: TrendLane, focus: WriterFocus): WriterSegment[][] {
  if (frame === "quest") {
    if (lane === "regulation" && focus === "court") {
      return [
        ["lead", "stamp", "evidence", "question"],
        ["attitude", "evidence", "decision", "question"],
        ["fixation", "stamp", "decision", "question"],
        ["lead", "attitude", "consequence", "question"],
        ["stamp", "evidence", "consequence", "question"],
        ["attitude", "stamp", "evidence", "question"],
        ["fixation", "evidence", "decision", "question"],
        ["lead", "evidence", "consequence", "question"],
        ["attitude", "fixation", "question"],
        ["stamp", "decision", "question"],
        ["scene", "stamp", "decision", "question"],
        ["scene", "attitude", "question"],
      ];
    }
    return [
      ["scene", "stamp", "attitude", "question"],
      ["lead", "fixation", "decision", "question"],
      ["scene", "instinct", "decision", "question"],
      ["fixation", "evidence", "question"],
    ];
  }

  if (mode === "meta-reflection") {
    if (lane === "regulation" && focus === "execution") {
      return [
        ["attitude", "evidence", "stamp", "consequence"],
        ["scene", "fixation", "evidence", "decision"],
        ["lead", "evidence", "stamp", "consequence"],
        ["scene", "attitude", "decision", "consequence"],
      ];
    }
    if (lane === "onchain" && focus === "durability") {
      return [
        ["attitude", "fixation", "evidence", "decision"],
        ["scene", "instinct", "evidence", "consequence"],
        ["lead", "stamp", "evidence", "decision"],
        ["scene", "attitude", "consequence"],
      ];
    }
    return frame === "cross-exam"
      ? [
          ["attitude", "stamp", "evidence", "consequence"],
          ["pressure", "evidence", "consequence"],
          ["scene", "attitude", "evidence", "consequence"],
          ["lead", "fixation", "decision", "consequence"],
          ["scene", "stamp", "fixation", "decision"],
        ]
      : [
          ["scene", "attitude", "evidence", "decision"],
          ["pressure", "evidence", "decision"],
          ["lead", "stamp", "fixation", "consequence"],
          ["attitude", "evidence", "fixation", "decision"],
        ];
  }

  if (mode === "philosophy-note") {
    if (lane === "protocol" && focus === "durability") {
      return [
        ["lead", "evidence", "decision", "consequence"],
        ["pressure", "evidence", "consequence"],
        ["attitude", "stamp", "evidence", "consequence"],
        ["stamp", "evidence", "consequence"],
        ["fixation", "evidence", "stamp", "decision"],
        ["attitude", "fixation", "evidence", "consequence"],
        ["fixation", "stamp", "evidence", "consequence"],
        ["lead", "stamp", "decision", "consequence"],
        ["stamp", "fixation", "decision", "consequence"],
        ["attitude", "evidence", "consequence"],
        ["scene", "stamp", "consequence"],
        ["scene", "fixation", "decision", "consequence"],
        ["stamp", "attitude", "consequence"],
        ["scene", "evidence", "decision", "consequence"],
      ];
    }
    if (lane === "market-structure" && focus === "settlement") {
      return [
        ["pressure", "evidence", "decision", "consequence"],
        ["lead", "pressure", "evidence", "decision"],
        ["attitude", "pressure", "evidence", "consequence"],
        ["scene", "pressure", "decision", "consequence"],
        ["lead", "evidence", "stamp", "decision"],
        ["fixation", "pressure", "evidence", "consequence"],
      ];
    }
    if (lane === "market-structure" && focus === "liquidity") {
      return [
        ["lead", "evidence", "stamp", "decision"],
        ["attitude", "fixation", "evidence", "consequence"],
        ["lead", "stamp", "evidence", "decision"],
        ["stamp", "evidence", "decision", "consequence"],
        ["fixation", "evidence", "stamp", "decision"],
        ["attitude", "stamp", "evidence", "decision"],
        ["fixation", "stamp", "evidence", "consequence"],
        ["stamp", "fixation", "decision", "consequence"],
        ["attitude", "evidence", "consequence"],
        ["scene", "stamp", "decision", "consequence"],
        ["scene", "fixation", "consequence"],
        ["stamp", "attitude", "consequence"],
      ];
    }
    return [
      ["lead", "stamp", "evidence", "decision"],
      ["pressure", "evidence", "decision"],
      ["scene", "fixation", "evidence", "consequence"],
      ["attitude", "instinct", "evidence", "decision"],
      ["lead", "evidence", "stamp", "consequence"],
    ];
  }

  if (mode === "identity-journal") {
    if (lane === "protocol" && focus === "launch") {
      return frame === "field-note"
        ? [
            ["lead", "stamp", "evidence", "decision"],
            ["pressure", "evidence", "decision"],
            ["fixation", "evidence", "consequence"],
            ["scene", "attitude", "evidence", "decision"],
            ["stamp", "evidence", "consequence"],
            ["lead", "attitude", "decision", "consequence"],
            ["scene", "fixation", "evidence", "consequence"],
          ]
        : [
            ["stamp", "evidence", "decision", "consequence"],
            ["pressure", "evidence", "consequence"],
            ["lead", "fixation", "evidence", "decision"],
            ["attitude", "evidence", "stamp", "consequence"],
            ["scene", "attitude", "evidence", "decision"],
            ["lead", "stamp", "evidence", "consequence"],
            ["fixation", "evidence", "decision", "consequence"],
          ];
    }
    if (lane === "ecosystem" && focus === "retention") {
      return frame === "field-note"
        ? [
            ["scene", "fixation", "evidence", "decision"],
            ["pressure", "evidence", "decision"],
            ["lead", "attitude", "evidence", "consequence"],
            ["scene", "stamp", "evidence", "decision"],
            ["attitude", "fixation", "evidence", "consequence"],
          ]
        : [
            ["lead", "fixation", "evidence", "decision"],
            ["pressure", "evidence", "consequence"],
            ["scene", "attitude", "evidence", "consequence"],
            ["lead", "stamp", "evidence", "decision"],
            ["scene", "fixation", "consequence"],
          ];
    }
    if (lane === "ecosystem" && focus === "builder") {
      return frame === "field-note"
        ? [
            ["lead", "stamp", "evidence", "decision"],
            ["pressure", "evidence", "consequence"],
            ["scene", "fixation", "evidence", "decision"],
            ["attitude", "stamp", "evidence", "consequence"],
            ["scene", "attitude", "evidence", "decision"],
            ["fixation", "evidence", "stamp", "consequence"],
            ["attitude", "fixation", "evidence", "consequence"],
            ["lead", "evidence", "consequence"],
            ["stamp", "evidence", "decision", "consequence"],
          ]
        : [
            ["lead", "attitude", "evidence", "decision"],
            ["pressure", "evidence", "decision"],
            ["scene", "stamp", "evidence", "consequence"],
            ["lead", "fixation", "evidence", "decision"],
            ["scene", "attitude", "consequence"],
            ["stamp", "evidence", "decision", "consequence"],
            ["fixation", "evidence", "consequence"],
            ["attitude", "evidence", "decision", "consequence"],
            ["lead", "evidence", "stamp", "consequence"],
          ];
    }
    if (lane === "ecosystem" && focus === "hype") {
      return [
        ["lead", "attitude", "evidence", "decision"],
        ["scene", "fixation", "evidence", "consequence"],
        ["attitude", "stamp", "evidence", "decision"],
        ["lead", "fixation", "consequence"],
      ];
    }
    return frame === "field-note"
      ? [
          ["scene", "instinct", "evidence", "decision"],
          ["pressure", "evidence", "decision"],
          ["lead", "stamp", "attitude", "consequence"],
          ["scene", "fixation", "evidence", "decision"],
          ["lead", "instinct", "evidence", "consequence"],
        ]
      : [
          ["scene", "attitude", "evidence", "decision"],
          ["pressure", "evidence", "consequence"],
          ["lead", "instinct", "evidence", "consequence"],
          ["scene", "stamp", "fixation", "consequence"],
          ["attitude", "evidence", "instinct", "decision"],
        ];
  }

  return [
    ["scene", "evidence", "decision", "consequence"],
    ["lead", "stamp", "evidence", "decision"],
    ["lead", "instinct", "evidence", "consequence"],
    ["fixation", "evidence", "decision", "consequence"],
  ];
}
