import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryService } from "../src/services/memory.ts";

test("read-only observe memory neither creates nor rewrites its backing file", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-memory-observe-"));
  try {
    const missingPath = path.join(tempDir, "missing", "memory.json");
    const missing = new MemoryService({ dataPath: missingPath, readonly: true });
    missing.recordCognitiveActivity("social", 3);
    missing.flushNow();
    assert.equal(fs.existsSync(missingPath), false);

    const existingPath = path.join(tempDir, "memory.json");
    const writable = new MemoryService({ dataPath: existingPath });
    writable.flushNow();
    const before = fs.readFileSync(existingPath, "utf8");
    const readonly = new MemoryService({ dataPath: existingPath, readonly: true });
    readonly.recordCognitiveActivity("social", 5);
    readonly.flushNow();
    assert.equal(fs.readFileSync(existingPath, "utf8"), before);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
