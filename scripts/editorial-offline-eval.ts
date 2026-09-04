import os from "node:os";
import path from "node:path";

process.env.TEST_MODE = "true";
process.env.TEST_NO_EXTERNAL_CALLS = "true";
process.env.ACTION_MODE = "observe";
process.env.PIXYMON_DATA_DIR ||= path.join(os.tmpdir(), `pixymon-v2-offline-eval-${process.pid}`);
process.env.MEMORY_DATA_PATH ||= path.join(process.env.PIXYMON_DATA_DIR, "memory.json");

const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("offline evaluation blocked an unexpected network call");
}) as typeof fetch;

try {
  const { runOfflineGoldenV2 } = await import("../eval/editorial-v2-golden.js");
  const report = await runOfflineGoldenV2();
  console.log("Pixymon V2 offline golden — PASS (network/X/LLM disabled)");
  console.log(`provider: ${report.provider.passed}/${report.provider.total}`);
  console.log(`planner: ${report.planner.passed}/${report.planner.total}`);
  console.log(`dispatch safety: ${report.dispatch.passed}/${report.dispatch.total}`);
  console.log(`total: ${report.total.passed}/${report.total.total}`);
  console.log(
    `live create callbacks: ${report.dispatch.mockedLiveCreateCalls} (in-memory mocks only)`
  );
} finally {
  globalThis.fetch = originalFetch;
}
