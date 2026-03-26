#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import dotenv from "dotenv";

const rootDir = process.cwd();
const envPath = path.join(rootDir, ".env");
dotenv.config({ path: envPath });

const launchAgentLabel = "com.pixymon.agent";
const legacyLaunchAgentLabel = "com.pixymon.tunis";
const launchAgentPath = path.join(os.homedir(), "Library", "LaunchAgents", `${launchAgentLabel}.plist`);
const legacyLaunchAgentPath = path.join(os.homedir(), "Library", "LaunchAgents", `${legacyLaunchAgentLabel}.plist`);
const sharedStateDir = process.env.PIXYMON_SHARED_STATE_DIR
  ? path.resolve(process.env.PIXYMON_SHARED_STATE_DIR)
  : path.join(os.homedir(), ".pixymon", "state");
const runtimeLockPath = path.join(sharedStateDir, "pixymon-runtime.lock");
const logPath = path.join(rootDir, "logs", "pixymon.log");
const metricsPath = path.join(rootDir, process.env.OBSERVABILITY_EVENT_LOG_PATH || "data/metrics-events.ndjson");

const checks = [];

function addCheck(status, title, detail) {
  checks.push({ status, title, detail });
}

function runCommand(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch (error) {
    return "";
  }
}

function findPixymonProcesses() {
  const rows = runCommand("ps", ["-Ao", "pid=,command="])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return rows.filter((line) => {
    const normalized = line.replace(/\s+/g, " ");
    return (
      /(?:^|\s)node\s+.*\/dist\/index\.js(?:\s|$)/.test(normalized) ||
      /(?:^|\s)(?:bash|zsh)\s+.*run-pixymon-local\.sh(?:\s|$)/.test(normalized) ||
      /run-pixymon-local\.sh(?:\s|$)/.test(normalized)
    );
  });
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function findLatestQuotaCycle(filePath) {
  const events = readJsonLines(filePath);
  const quotaEvents = events.filter((row) => row.type === "quota_cycle");
  return quotaEvents.length > 0 ? quotaEvents[quotaEvents.length - 1] : null;
}

function readRecentLogTail(filePath, lineCount = 120) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .slice(-lineCount)
    .map((line) => line.trim())
    .filter(Boolean);
}

function boolString(value) {
  return String(value || "").trim().toLowerCase();
}

function isFalseyFlag(value) {
  return boolString(value) === "false" || boolString(value) === "0";
}

function isTruthyFlag(value) {
  return ["true", "1", "yes", "on"].includes(boolString(value));
}

const envChecks = [
  {
    title: "TEST_MODE off",
    ok: isFalseyFlag(process.env.TEST_MODE),
    failDetail: `TEST_MODE=${process.env.TEST_MODE || "(unset)"}`
  },
  {
    title: "SCHEDULER_MODE on",
    ok: isTruthyFlag(process.env.SCHEDULER_MODE),
    failDetail: `SCHEDULER_MODE=${process.env.SCHEDULER_MODE || "(unset)"}`
  },
  {
    title: "TEST_NO_EXTERNAL_CALLS off",
    ok: isFalseyFlag(process.env.TEST_NO_EXTERNAL_CALLS),
    failDetail: `TEST_NO_EXTERNAL_CALLS=${process.env.TEST_NO_EXTERNAL_CALLS || "(unset)"}`
  },
  {
    title: "ACTION_MODE live",
    ok: boolString(process.env.ACTION_MODE) === "live",
    failDetail: `ACTION_MODE=${process.env.ACTION_MODE || "(unset)"}`
  },
  {
    title: "Anthropic usage sync on",
    ok: boolString(process.env.ANTHROPIC_USAGE_API_ENABLED || "true") === "true",
    failDetail: `ANTHROPIC_USAGE_API_ENABLED=${process.env.ANTHROPIC_USAGE_API_ENABLED || "(default:true)"}`
  },
  {
    title: "Anthropic usage sync required",
    ok: boolString(process.env.ANTHROPIC_USAGE_API_REQUIRED || "true") === "true",
    failDetail: `ANTHROPIC_USAGE_API_REQUIRED=${process.env.ANTHROPIC_USAGE_API_REQUIRED || "(unset)"}`
  },
  {
    title: "Anthropic admin key present",
    ok: String(process.env.ANTHROPIC_ADMIN_API_KEY || "").trim().length > 0,
    failDetail: "ANTHROPIC_ADMIN_API_KEY missing"
  }
];

for (const row of envChecks) {
  addCheck(row.ok ? "OK" : "FAIL", row.title, row.ok ? "ready" : row.failDetail);
}

const dailyTarget = Number(process.env.DAILY_ACTIVITY_TARGET || "0");
if (Number.isFinite(dailyTarget) && dailyTarget >= 4 && dailyTarget <= 12) {
  addCheck("OK", "Daily activity target", `DAILY_ACTIVITY_TARGET=${dailyTarget}`);
} else {
  addCheck("WARN", "Daily activity target", `DAILY_ACTIVITY_TARGET=${process.env.DAILY_ACTIVITY_TARGET || "(unset)"}; recommended 4-12 for week test`);
}

const postInterval = Number(process.env.POST_MIN_INTERVAL_MINUTES || "0");
if (Number.isFinite(postInterval) && postInterval > 0 && postInterval <= 90) {
  addCheck("OK", "Post interval", `POST_MIN_INTERVAL_MINUTES=${postInterval}`);
} else {
  addCheck("WARN", "Post interval", `POST_MIN_INTERVAL_MINUTES=${process.env.POST_MIN_INTERVAL_MINUTES || "(unset)"}; recommended <= 90`);
}

const budgetSummary = [
  `X=${process.env.X_API_DAILY_MAX_USD || "(unset)"}`,
  `LLM=${process.env.ANTHROPIC_DAILY_MAX_USD || "(unset)"}`,
  `TOTAL=${process.env.TOTAL_DAILY_MAX_USD || "(unset)"}`
].join(" | ");
addCheck("OK", "Daily cost caps", budgetSummary);
addCheck("OK", "Shared state dir", sharedStateDir);

const fallbackAutoPublish = boolString(process.env.ALLOW_FALLBACK_AUTO_PUBLISH);
if (fallbackAutoPublish === "true") {
  addCheck("WARN", "Fallback auto-publish", "ALLOW_FALLBACK_AUTO_PUBLISH=true; recommended false for week test");
} else {
  addCheck("OK", "Fallback auto-publish", `ALLOW_FALLBACK_AUTO_PUBLISH=${process.env.ALLOW_FALLBACK_AUTO_PUBLISH || "false"} (deterministic-only live fallback policy)`);
}

const launchAgentExists = fs.existsSync(launchAgentPath);
addCheck(launchAgentExists ? "OK" : "WARN", "LaunchAgent file", launchAgentExists ? launchAgentPath : "missing com.pixymon.agent.plist");

const legacyLaunchAgentExists = fs.existsSync(legacyLaunchAgentPath);
addCheck(legacyLaunchAgentExists ? "WARN" : "OK", "Legacy LaunchAgent", legacyLaunchAgentExists ? legacyLaunchAgentPath : "not present");

const launchctlList = runCommand("launchctl", ["list"]);
const currentLoaded = launchctlList.includes(launchAgentLabel);
const legacyLoaded = launchctlList.includes(legacyLaunchAgentLabel);
addCheck(currentLoaded ? "WARN" : "OK", "Current LaunchAgent loaded", currentLoaded ? `${launchAgentLabel} is loaded; stop it before a clean week-test start` : "not loaded");
addCheck(legacyLoaded ? "FAIL" : "OK", "Legacy LaunchAgent loaded", legacyLoaded ? `${legacyLaunchAgentLabel} is loaded` : "not loaded");

const processLines = findPixymonProcesses();
if (processLines.length === 0) {
  addCheck("OK", "Pixymon processes", "no live process running");
} else if (processLines.length === 1) {
  addCheck("WARN", "Pixymon processes", `one process already running: ${processLines[0]}`);
} else {
  addCheck("FAIL", "Pixymon processes", `${processLines.length} matching processes running`);
}

if (fs.existsSync(runtimeLockPath)) {
  const lockPid = fs.readFileSync(runtimeLockPath, "utf8").trim();
  addCheck("WARN", "Runtime lock", `lock present at ${runtimeLockPath} (pid=${lockPid || "unknown"})`);
} else {
  addCheck("OK", "Runtime lock", "no runtime lock file present");
}

const latestQuota = findLatestQuotaCycle(metricsPath);
if (!latestQuota) {
  addCheck(processLines.length > 0 ? "WARN" : "OK", "Latest quota cycle", processLines.length > 0 ? `no quota_cycle metric found at ${metricsPath}` : "no quota_cycle metric found; clean start state");
} else {
  const executed = latestQuota.executed ?? 0;
  const posts = latestQuota.activity?.posts ?? 0;
  const replies = latestQuota.activity?.replies ?? 0;
  const fallbackRate = latestQuota.postGeneration?.fallbackRate ?? 0;
  const executedDetail = `executed=${executed}, posts=${posts}, replies=${replies}, fallbackRate=${fallbackRate}`;
  if (executed === 0 || posts === 0) {
    addCheck("WARN", "Latest quota cycle", executedDetail);
  } else {
    addCheck("OK", "Latest quota cycle", executedDetail);
  }
}

const recentLogLines = readRecentLogTail(logPath);
const noPostCount = recentLogLines.filter((line) => /\[POST\] 스킵|\[POST-GUARD\] 글 발행 스킵|NO_POST/.test(line)).length;
const duplicateLockCount = recentLogLines.filter((line) => /\[LOCK\] 실행 중단: 다른 인스턴스가 이미 실행 중|\[POST-GUARD\] 다른 인스턴스가 글 발행 중/.test(line)).length;
const searchUnavailableCount = recentLogLines.filter((line) => /search endpoint unavailable|search endpoint cooldown active/.test(line)).length;
const fallbackSignalCount = recentLogLines.filter((line) => /\[POST\] .*fallback 사용|fallback 발행 차단/.test(line)).length;
addCheck(noPostCount > 0 ? "WARN" : "OK", "Recent no-post signals", `${noPostCount} hit(s) in last ${recentLogLines.length} log lines`);
addCheck(duplicateLockCount > 0 ? "WARN" : "OK", "Recent duplicate-run signals", `${duplicateLockCount} hit(s) in last ${recentLogLines.length} log lines`);
addCheck(searchUnavailableCount > 0 ? "WARN" : "OK", "Recent social entitlement signals", `${searchUnavailableCount} hit(s) in last ${recentLogLines.length} log lines`);
addCheck(fallbackSignalCount > 0 ? "WARN" : "OK", "Recent fallback signals", `${fallbackSignalCount} hit(s) in last ${recentLogLines.length} log lines`);

const failures = checks.filter((row) => row.status === "FAIL");
const warnings = checks.filter((row) => row.status === "WARN");

for (const row of checks) {
  const icon = row.status === "OK" ? "OK" : row.status === "WARN" ? "WARN" : "FAIL";
  console.log(`${icon}  ${row.title}: ${row.detail}`);
}

console.log("---");
console.log(`Summary: ${failures.length} fail, ${warnings.length} warn, ${checks.length - failures.length - warnings.length} ok`);

if (failures.length > 0) {
  process.exit(1);
}
