import { writeNewEditorialR1PromotionV2 } from "../src/services/editorial-v2/r1-promotion.js";

function requiredOption(name: string): string {
  const direct = process.argv.find((argument) => argument.startsWith(`${name}=`));
  const index = process.argv.indexOf(name);
  const value = direct?.slice(name.length + 1) ?? (index >= 0 ? process.argv[index + 1] : "");
  if (!value?.trim() || value.startsWith("--")) throw new Error(`${name} is required`);
  return value.trim();
}

try {
  const target = writeNewEditorialR1PromotionV2({
    statusPath: requiredOption("--status"),
    outputPath: requiredOption("--output"),
  });
  console.log(`[EDITORIAL] manual R1 promotion=${target}`);
} catch (error) {
  console.error(`[EDITORIAL] R1 promotion failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
