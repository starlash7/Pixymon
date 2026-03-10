import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

test("recordNarrativeObservation writes ndjson and summary artifacts", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-narrative-audit-"));
  process.env.NARRATIVE_AUDIT_ENABLED = "true";
  process.env.NARRATIVE_AUDIT_LOG_PATH = path.join(tempDir, "narrative.ndjson");
  process.env.NARRATIVE_AUDIT_SUMMARY_PATH = path.join(tempDir, "summary.json");

  const { recordNarrativeObservation } = await import("../src/services/narrative-observer.ts");

  recordNarrativeObservation({
    surface: "post",
    text: "헤지 포지셔닝 변화 쪽부터 다시 본다. 끝까지 남는 근거 하나만 붙잡는다.",
    language: "ko",
    lane: "macro",
    narrativeMode: "identity-journal",
    fallbackKind: "post:test",
  });

  const logRaw = fs.readFileSync(process.env.NARRATIVE_AUDIT_LOG_PATH!, "utf8");
  const summaryRaw = fs.readFileSync(process.env.NARRATIVE_AUDIT_SUMMARY_PATH!, "utf8");
  const event = JSON.parse(logRaw.trim().split("\n")[0]);
  const summary = JSON.parse(summaryRaw);

  assert.equal(event.surface, "post");
  assert.ok(Array.isArray(event.hits));
  assert.equal(summary.total, 1);
  assert.equal(summary.bySurface.post, 1);
  assert.ok(summary.byLabel["hedge-positioning"] >= 1);
  assert.ok(summary.byLabel["templated-closing"] >= 1);
});
