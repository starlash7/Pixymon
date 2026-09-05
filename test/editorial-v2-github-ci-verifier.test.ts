import assert from "node:assert/strict";
import test from "node:test";
import {
  verifyGitHubNetworkIsolationV2,
  type GitHubFetchV2,
} from "../src/services/editorial-v2/github-ci-verifier.ts";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const REPOSITORY = "starlash7/Pixymon";

function successfulRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 101,
    run_attempt: 2,
    updated_at: "2026-09-04T02:00:00.000Z",
    head_sha: HEAD_SHA,
    head_branch: "main",
    event: "push",
    path: ".github/workflows/verify.yml",
    status: "completed",
    conclusion: "success",
    repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

function successfulJob(
  stepOverrides: Record<string, unknown> = {},
  jobOverrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 202,
    run_id: 101,
    run_attempt: 2,
    head_sha: HEAD_SHA,
    name: "verify",
    status: "completed",
    conclusion: "success",
    steps: [{
      name: "Verify with outbound network disabled",
      status: "completed",
      conclusion: "success",
      ...stepOverrides,
    }],
    ...jobOverrides,
  };
}

function fetchSequence(values: readonly Array<{ status?: number; body: unknown }>): {
  fetchImpl: GitHubFetchV2;
  urls: string[];
} {
  const urls: string[] = [];
  let index = 0;
  return {
    urls,
    fetchImpl: async (url) => {
      urls.push(url);
      const value = values[index++];
      if (!value) throw new Error("unexpected request");
      const status = value.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
          return structuredClone(value.body);
        },
      };
    },
  };
}

test("GitHub verifier binds a successful isolation step to exact push/main HEAD", async () => {
  const mock = fetchSequence([
    { body: { total_count: 1, workflow_runs: [successfulRun()] } },
    { body: { total_count: 1, jobs: [successfulJob()] } },
  ]);
  const verified = await verifyGitHubNetworkIsolationV2({
    repository: REPOSITORY,
    headSha: HEAD_SHA,
    fetchImpl: mock.fetchImpl,
  });

  assert.equal(verified.state, "pass");
  assert.equal(verified.runId, 101);
  assert.equal(verified.runAttempt, 2);
  assert.equal(verified.jobId, 202);
  assert.equal(mock.urls.length, 2);
  const runUrl = new URL(mock.urls[0]);
  assert.equal(runUrl.hostname, "api.github.com");
  assert.equal(runUrl.pathname, "/repos/starlash7/Pixymon/actions/workflows/verify.yml/runs");
  assert.equal(runUrl.searchParams.get("branch"), "main");
  assert.equal(runUrl.searchParams.get("event"), "push");
  assert.equal(runUrl.searchParams.get("head_sha"), HEAD_SHA);
  assert.match(mock.urls[1], /\/actions\/runs\/101\/attempts\/2\/jobs\?per_page=100$/);
});

test("GitHub verifier fails closed on run or isolation-step mismatches", async () => {
  const pullRequest = fetchSequence([
    { body: { total_count: 1, workflow_runs: [successfulRun({ event: "pull_request" })] } },
  ]);
  assert.equal((await verifyGitHubNetworkIsolationV2({
    repository: REPOSITORY,
    headSha: HEAD_SHA,
    fetchImpl: pullRequest.fetchImpl,
  })).state, "fail");

  const failedStep = fetchSequence([
    { body: { total_count: 1, workflow_runs: [successfulRun()] } },
    {
      body: {
        total_count: 1,
        jobs: [successfulJob({ conclusion: "failure" })],
      },
    },
  ]);
  const result = await verifyGitHubNetworkIsolationV2({
    repository: REPOSITORY,
    headSha: HEAD_SHA,
    fetchImpl: failedStep.fetchImpl,
  });
  assert.equal(result.state, "fail");
  assert.equal(result.reason, "network-isolation-step-failed");
});

test("GitHub verifier leaves API errors, missing runs, and ambiguous runs unknown", async () => {
  const forbidden = fetchSequence([{ status: 403, body: {} }]);
  const apiError = await verifyGitHubNetworkIsolationV2({
    repository: REPOSITORY,
    headSha: HEAD_SHA,
    fetchImpl: forbidden.fetchImpl,
  });
  assert.equal(apiError.state, "unknown");
  assert.equal(apiError.reason, "github-api-http-403");

  const missing = fetchSequence([{ body: { total_count: 0, workflow_runs: [] } }]);
  assert.equal((await verifyGitHubNetworkIsolationV2({
    repository: REPOSITORY,
    headSha: HEAD_SHA,
    fetchImpl: missing.fetchImpl,
  })).state, "unknown");

  const ambiguous = fetchSequence([{
    body: { total_count: 2, workflow_runs: [successfulRun(), successfulRun({ id: 102 })] },
  }]);
  const ambiguity = await verifyGitHubNetworkIsolationV2({
    repository: REPOSITORY,
    headSha: HEAD_SHA,
    fetchImpl: ambiguous.fetchImpl,
  });
  assert.equal(ambiguity.state, "unknown");
  assert.equal(ambiguity.reason, "matching-workflow-run-ambiguous");

  const inconsistentJobs = fetchSequence([
    { body: { total_count: 1, workflow_runs: [successfulRun()] } },
    { body: { total_count: 0, jobs: [successfulJob()] } },
  ]);
  const inconsistent = await verifyGitHubNetworkIsolationV2({
    repository: REPOSITORY,
    headSha: HEAD_SHA,
    fetchImpl: inconsistentJobs.fetchImpl,
  });
  assert.equal(inconsistent.state, "unknown");
  assert.equal(inconsistent.reason, "github-api-jobs-count-mismatch");
});
