const GITHUB_API_VERSION = "2022-11-28";
const VERIFY_WORKFLOW_PATH = ".github/workflows/verify.yml";
const VERIFY_JOB_NAME = "verify";
const NETWORK_ISOLATION_STEP_NAME = "Verify with outbound network disabled";

interface GitHubFetchResponseV2 {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type GitHubFetchV2 = (
  url: string,
  init: {
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  }
) => Promise<GitHubFetchResponseV2>;

interface GitHubNetworkIsolationVerificationBaseV2 {
  repository: string;
  headSha: string;
  workflowPath: typeof VERIFY_WORKFLOW_PATH;
  reason: string;
  runId?: number;
  runAttempt?: number;
  jobId?: number;
  completedAt?: string;
}

export type GitHubNetworkIsolationVerificationV2 =
  | (GitHubNetworkIsolationVerificationBaseV2 & {
      state: "pass";
      runId: number;
      runAttempt: number;
      jobId: number;
      completedAt: string;
    })
  | (GitHubNetworkIsolationVerificationBaseV2 & { state: "fail" | "unknown" });

interface VerifyGitHubNetworkIsolationInputV2 {
  repository: string;
  headSha: string;
  token?: string;
  fetchImpl?: GitHubFetchV2;
  timeoutMs?: number;
}

interface JsonRequestResultV2 {
  ok: boolean;
  status: number | null;
  value?: unknown;
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function validInstant(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function result(
  state: GitHubNetworkIsolationVerificationV2["state"],
  repository: string,
  headSha: string,
  reason: string,
  details: Pick<
    GitHubNetworkIsolationVerificationV2,
    "runId" | "runAttempt" | "jobId" | "completedAt"
  > = {}
): GitHubNetworkIsolationVerificationV2 {
  if (
    state === "pass" &&
    (!details.runId || !details.runAttempt || !details.jobId || !details.completedAt)
  ) {
    throw new Error("passing GitHub verification requires complete run lineage");
  }
  return {
    state,
    repository,
    headSha,
    workflowPath: VERIFY_WORKFLOW_PATH,
    reason,
    ...details,
  } as GitHubNetworkIsolationVerificationV2;
}

async function defaultGitHubFetchV2(
  url: string,
  init: Parameters<GitHubFetchV2>[1]
): Promise<GitHubFetchResponseV2> {
  return fetch(url, init);
}

async function requestJson(
  fetchImpl: GitHubFetchV2,
  url: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number
): Promise<JsonRequestResultV2> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        reason: `github-api-http-${response.status}`,
      };
    }
    try {
      return { ok: true, status: response.status, value: await response.json() };
    } catch {
      return { ok: false, status: response.status, reason: "github-api-invalid-json" };
    }
  } catch (error) {
    const message = error instanceof Error ? error.name : "request-error";
    return {
      ok: false,
      status: null,
      reason: message === "AbortError" ? "github-api-timeout" : "github-api-request-error",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function repositoryName(value: string): string | null {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/.test(normalized)) {
    return null;
  }
  return normalized;
}

/**
 * Verifies GitHub's live server response for the exact current commit. This result
 * is intentionally not serializable machine evidence: status callers must obtain
 * it directly for each run instead of trusting a hand-written audit file.
 */
export async function verifyGitHubNetworkIsolationV2(
  input: VerifyGitHubNetworkIsolationInputV2
): Promise<GitHubNetworkIsolationVerificationV2> {
  const repository = repositoryName(input.repository);
  const headSha = String(input.headSha || "").trim().toLowerCase();
  if (!repository) {
    return result("fail", String(input.repository || "").trim(), headSha, "invalid-repository");
  }
  if (!/^[a-f0-9]{40}$/.test(headSha)) {
    return result("fail", repository, headSha, "invalid-head-sha");
  }
  const timeoutMs = input.timeoutMs ?? 8_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    return result("fail", repository, headSha, "invalid-timeout");
  }
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "pixymon-editorial-rollout-status",
  };
  const token = String(input.token || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const fetchImpl = input.fetchImpl ?? defaultGitHubFetchV2;
  const [owner, name] = repository.split("/");
  const workflowRunsUrl = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
      "/actions/workflows/verify.yml/runs"
  );
  workflowRunsUrl.searchParams.set("branch", "main");
  workflowRunsUrl.searchParams.set("event", "push");
  workflowRunsUrl.searchParams.set("head_sha", headSha);
  workflowRunsUrl.searchParams.set("status", "completed");
  workflowRunsUrl.searchParams.set("per_page", "100");

  const runsResponse = await requestJson(fetchImpl, workflowRunsUrl.toString(), headers, timeoutMs);
  if (!runsResponse.ok) {
    return result("unknown", repository, headSha, runsResponse.reason || "github-api-run-error");
  }
  if (!isRecord(runsResponse.value)) {
    return result("unknown", repository, headSha, "github-api-runs-shape-invalid");
  }
  const totalCount = runsResponse.value.total_count;
  const workflowRuns = runsResponse.value.workflow_runs;
  if (!Number.isInteger(totalCount) || Number(totalCount) < 0 || !Array.isArray(workflowRuns)) {
    return result("unknown", repository, headSha, "github-api-runs-shape-invalid");
  }
  if (Number(totalCount) === 0 && workflowRuns.length === 0) {
    return result("unknown", repository, headSha, "matching-workflow-run-not-found");
  }
  if (Number(totalCount) !== 1 || workflowRuns.length !== 1) {
    return result("unknown", repository, headSha, "matching-workflow-run-ambiguous");
  }
  const run = workflowRuns[0];
  if (!isRecord(run)) {
    return result("unknown", repository, headSha, "github-api-run-shape-invalid");
  }
  const runId = positiveInteger(run.id);
  const runAttempt = positiveInteger(run.run_attempt);
  const completedAt = validInstant(run.updated_at);
  const responseRepository = isRecord(run.repository) ? run.repository.full_name : undefined;
  if (!runId || !runAttempt || !completedAt || typeof responseRepository !== "string") {
    return result("unknown", repository, headSha, "github-api-run-shape-invalid");
  }
  const runDetails = { runId, runAttempt, completedAt };
  const runMatches =
    String(run.head_sha || "").toLowerCase() === headSha &&
    String(run.head_branch || "") === "main" &&
    String(run.event || "") === "push" &&
    String(run.path || "") === VERIFY_WORKFLOW_PATH &&
    String(run.status || "") === "completed" &&
    String(run.conclusion || "") === "success" &&
    responseRepository.toLowerCase() === repository.toLowerCase();
  if (!runMatches) {
    return result("fail", repository, headSha, "workflow-run-mismatch", runDetails);
  }

  const jobsUrl =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
    `/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`;
  const jobsResponse = await requestJson(fetchImpl, jobsUrl, headers, timeoutMs);
  if (!jobsResponse.ok) {
    return result(
      "unknown",
      repository,
      headSha,
      jobsResponse.reason || "github-api-jobs-error",
      runDetails
    );
  }
  if (!isRecord(jobsResponse.value)) {
    return result("unknown", repository, headSha, "github-api-jobs-shape-invalid", runDetails);
  }
  const jobTotalCount = jobsResponse.value.total_count;
  const jobs = jobsResponse.value.jobs;
  if (!Number.isInteger(jobTotalCount) || Number(jobTotalCount) < 0 || !Array.isArray(jobs)) {
    return result("unknown", repository, headSha, "github-api-jobs-shape-invalid", runDetails);
  }
  if (Number(jobTotalCount) !== jobs.length) {
    return result("unknown", repository, headSha, "github-api-jobs-count-mismatch", runDetails);
  }
  const verifyJobs = (jobs as unknown[]).filter(
    (job): job is Record<string, unknown> => isRecord(job) && job.name === VERIFY_JOB_NAME
  );
  if (verifyJobs.length !== 1) {
    return result(
      "unknown",
      repository,
      headSha,
      verifyJobs.length === 0 ? "verify-job-not-found" : "verify-job-ambiguous",
      runDetails
    );
  }
  const job = verifyJobs[0];
  const jobId = positiveInteger(job.id);
  const jobMatches =
    jobId !== null &&
    positiveInteger(job.run_id) === runId &&
    positiveInteger(job.run_attempt) === runAttempt &&
    String(job.head_sha || "").toLowerCase() === headSha &&
    String(job.status || "") === "completed" &&
    String(job.conclusion || "") === "success";
  if (!jobMatches || !jobId) {
    return result("fail", repository, headSha, "verify-job-mismatch", runDetails);
  }
  if (!Array.isArray(job.steps)) {
    return result("unknown", repository, headSha, "github-api-job-steps-missing", {
      ...runDetails,
      jobId,
    });
  }
  const isolationSteps = (job.steps as unknown[]).filter(
    (step): step is Record<string, unknown> =>
      isRecord(step) && step.name === NETWORK_ISOLATION_STEP_NAME
  );
  if (isolationSteps.length !== 1) {
    return result(
      "unknown",
      repository,
      headSha,
      isolationSteps.length === 0 ? "network-isolation-step-not-found" : "network-isolation-step-ambiguous",
      { ...runDetails, jobId }
    );
  }
  const isolationStep = isolationSteps[0];
  if (
    String(isolationStep.status || "") !== "completed" ||
    String(isolationStep.conclusion || "") !== "success"
  ) {
    return result("fail", repository, headSha, "network-isolation-step-failed", {
      ...runDetails,
      jobId,
    });
  }
  return result("pass", repository, headSha, "verified-github-push-main-workflow", {
    ...runDetails,
    jobId,
  });
}
