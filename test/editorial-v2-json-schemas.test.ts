import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SCHEMA_PATHS = [
  "eval/annotations/v2.schema.json",
  "eval/annotations/v2-adjudication.schema.json",
  "eval/annotations/v2-comparisons.schema.json",
  "eval/editorial-v2-replay.schema.json",
  "eval/rollout-evidence.schema.json",
] as const;

test("tracked editorial V2 JSON schemas remain valid JSON", () => {
  for (const relativePath of SCHEMA_PATHS) {
    const absolutePath = path.resolve(relativePath);
    assert.equal(fs.existsSync(absolutePath), true, `${relativePath} must exist`);
    assert.doesNotThrow(
      () => JSON.parse(fs.readFileSync(absolutePath, "utf8")) as unknown,
      `${relativePath} must parse as JSON`
    );
  }
});
