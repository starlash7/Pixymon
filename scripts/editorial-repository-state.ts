import { execFileSync } from "node:child_process";

export function isEditorialVerificationInputV2(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").trim();
  return normalized.startsWith("src/") ||
    /^scripts\/editorial-[^/]+\.ts$/.test(normalized) ||
    normalized.startsWith("eval/") ||
    /^test\/[^/]+\.test\.ts$/.test(normalized) ||
    normalized === "package.json" ||
    normalized === "package-lock.json" ||
    normalized === ".github/workflows/verify.yml" ||
    normalized === "tsconfig.json" ||
    normalized === "tsconfig.scripts.json";
}

function gitLines(args: readonly string[]): string[] {
  return execFileSync("git", [...args], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function editorialVerificationRepositoryStateV2(): {
  currentCommit: string;
  workingTreeClean: boolean;
  dirtyFiles: readonly string[];
} {
  const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const tracked = gitLines(["diff", "--name-only", "HEAD", "--"]);
  const untracked = gitLines(["ls-files", "--others", "--exclude-standard"]);
  const dirtyFiles = [...new Set([...tracked, ...untracked].filter(isEditorialVerificationInputV2))]
    .sort();
  return { currentCommit, workingTreeClean: dirtyFiles.length === 0, dirtyFiles };
}
