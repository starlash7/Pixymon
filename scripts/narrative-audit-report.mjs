import fs from "fs";
import path from "path";

const rawPath =
  process.argv[2] ||
  process.env.NARRATIVE_AUDIT_SUMMARY_PATH ||
  "data/narrative-phrase-audit.json";
const targetPath = path.isAbsolute(rawPath) ? rawPath : path.join(process.cwd(), rawPath);

if (!fs.existsSync(targetPath)) {
  console.log(`[narrative-audit] summary not found: ${targetPath}`);
  process.exit(0);
}

const summary = JSON.parse(fs.readFileSync(targetPath, "utf8"));
const byLabel = Object.entries(summary.byLabel || {}).sort((a, b) => Number(b[1]) - Number(a[1]));

console.log("Narrative Audit");
console.log(`- summary: ${targetPath}`);
console.log(`- total events: ${Number(summary.total || 0)}`);
console.log(
  `- by surface: post=${Number(summary.bySurface?.post || 0)}, quote=${Number(summary.bySurface?.quote || 0)}, reply=${Number(summary.bySurface?.reply || 0)}`
);

if (byLabel.length === 0) {
  console.log("- top labels: none");
  process.exit(0);
}

console.log("- top labels:");
for (const [label, count] of byLabel.slice(0, 10)) {
  console.log(`  - ${label}: ${count}`);
  const examples = Array.isArray(summary.examplesByLabel?.[label]) ? summary.examplesByLabel[label] : [];
  for (const example of examples.slice(0, 2)) {
    console.log(`    ${example}`);
  }
}

