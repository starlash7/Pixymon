/** Read flags at the call boundary, so a process cannot retain stale test permissions. */
export function externalCallsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TEST_NO_EXTERNAL_CALLS !== undefined) {
    // Only an explicit false opts in. Empty or malformed configured values fail closed.
    return env.TEST_NO_EXTERNAL_CALLS.trim().toLowerCase() !== "false";
  }
  return env.TEST_MODE?.trim().toLowerCase() === "true";
}

export function assertExternalCallsAllowed(
  operation: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (externalCallsDisabled(env)) {
    throw new Error(`${operation} blocked: external calls are disabled (TEST_NO_EXTERNAL_CALLS)`);
  }
}
