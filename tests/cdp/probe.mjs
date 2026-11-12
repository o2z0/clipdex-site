import { openPage } from "./kit.mjs";

const usage = "Usage: node tests/cdp/probe.mjs <base-url> [--only <name>] [--pages / /full/ …]";
const expectedEdition = new Map([
  ["/", "store"],
  ["/full/", "full"],
  ["/en/full/", "full"],
]);

function parseArgs(args) {
  const [base, ...rest] = args;
  if (!base) throw new Error(usage);
  let only = null;
  let pages = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--only") {
      only = rest[++i];
      if (!only || only.startsWith("--")) throw new Error("--only に検査名が必要");
    } else if (arg === "--pages") {
      pages = [];
      while (rest[i + 1] && !rest[i + 1].startsWith("--")) pages.push(rest[++i]);
      if (!pages.length) throw new Error("--pages にパスが必要");
    } else {
      throw new Error(`不明な引数: ${arg}`);
    }
  }
  return { base: new URL(base), only, pages: pages ?? ["/"] };
}

async function boot(base, path) {
  const expected = expectedEdition.get(path);
  if (!expected) throw new Error(`edition の期待値が未定義: ${path}`);
  const page = await openPage({ url: new URL(path, base).href });
  try {
    await page.idle();
    const edition = await page.ev("document.documentElement.dataset.edition");
    const reasons = [];
    if (page.errors.length) reasons.push(`console error ${page.errors.length}: ${page.errors.join(" | ")}`);
    if (edition !== expected) reasons.push(`edition=${JSON.stringify(edition)} expected=${expected}`);
    return reasons.join("; ");
  } finally {
    page.close();
  }
}

const checks = { boot };

async function main() {
  const { base, only, pages } = parseArgs(process.argv.slice(2));
  if (only && !checks[only]) throw new Error(`不明な検査: ${only}`);
  let failures = 0;
  for (const [name, check] of Object.entries(checks)) {
    if (only && name !== only) continue;
    for (const path of pages) {
      try {
        const reason = await check(base, path);
        if (reason) { console.log(`NG ${name} ${path} ${reason}`); failures++; }
        else console.log(`OK ${name} ${path}`);
      } catch (error) {
        console.log(`NG ${name} ${path} ${error.message}`);
        failures++;
      }
    }
  }
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`NG probe ${error.message}`);
  process.exitCode = 1;
});
