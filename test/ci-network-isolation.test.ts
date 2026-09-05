import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

// Exercise the exact workflow check without requiring Linux privileges locally.
// The actual namespace and outbound denial are verified by the Linux CI run.
const workflow = readFileSync(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");
const check = workflow.match(/ip -j link show \| node -e '([\s\S]*?)'/u)?.[1];
assert.ok(check, "CI must inspect current-namespace links, not the inherited sysfs mount");

for (const fixture of [
  { name: "loopback only", input: '[{"ifindex":1,"ifname":"lo"}]', allowed: true },
  { name: "additional host interface", input: '[{"ifname":"lo"},{"ifname":"eth0"}]', allowed: false },
  { name: "non-loopback only", input: '[{"ifname":"eth0"}]', allowed: false },
  { name: "no interfaces", input: "[]", allowed: false },
  { name: "missing interface name", input: "[{}]", allowed: false },
  { name: "null interface", input: "[null]", allowed: false },
  { name: "non-array response", input: "{}", allowed: false },
  { name: "unparsable response", input: "not json", allowed: false },
  { name: "empty response", input: "", allowed: false },
]) {
  test(`CI namespace interface check: ${fixture.name}`, () => {
    const result = spawnSync(process.execPath, ["-e", check], {
      input: fixture.input,
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, fixture.allowed ? 0 : 1, result.stderr);
  });
}
