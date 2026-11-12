import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openPage, sleep } from "./cdp/kit.mjs";

const pagePath = process.argv[2];
if (!pagePath) throw new Error("Usage: node tests/text-freeze.mjs <page>");

const headings = [
  "コピペの記録は、外部に出ない",
  "そのほかにできること",
  "こんな人に",
  "ほかのアプリと比べると",
  "よくある質問",
  "今日から、コピーしたものが残る",
];
const normalize = (value) => value.replace(/\s+/g, " ").trim();
const attributes = (node) => Object.fromEntries(
  Array.from({ length: (node.attributes?.length ?? 0) / 2 }, (_, i) => [node.attributes[i * 2], node.attributes[i * 2 + 1]]),
);
const nodes = (node) => [node, ...(node.children ?? []).flatMap(nodes)];
const textOf = (node) => node.nodeName === "#text"
  ? node.nodeValue ?? ""
  : (node.children ?? []).map(textOf).join("");
const hasClass = (node, name) => (attributes(node).class ?? "").split(/\s+/).includes(name);

function inspect(root) {
  const all = nodes(root);
  const sections = new Map();
  for (const section of all.filter((node) => node.nodeName === "SECTION")) {
    const h2 = nodes(section).find((node) => node.nodeName === "H2");
    if (h2) sections.set(normalize(textOf(h2)), normalize(textOf(section)));
  }
  const facts = all.filter((node) => hasClass(node, "facts"))
    .flatMap((list) => nodes(list).filter((node) => node.nodeName === "LI").map((node) => normalize(textOf(node))));
  const pillFacts = all.filter((node) => hasClass(node, "pill-body"))
    .flatMap((panel) => nodes(panel).filter((node) => node.nodeName === "LI").map((node) => normalize(textOf(node))));
  const hrefs = all.filter((node) => node.nodeName === "A").map((node) => attributes(node).href)
    .filter((href) => href && href !== "/" && !href.startsWith("#"));
  const prices = all.filter((node) => node.nodeName === "#text" && /[¥$]/.test(node.nodeValue ?? ""))
    .map((node) => normalize(node.nodeValue));
  return { sections, facts, pillFacts, hrefs: new Set(hrefs), prices: new Set(prices) };
}

async function load(page, html) {
  const url = `data:text/html;charset=utf-8;base64,${Buffer.from(html).toString("base64")}`;
  const navigation = await page.send("Page.navigate", { url });
  if (navigation.error) throw new Error(navigation.error.message);
  for (let i = 0; i < 80; i++) {
    const response = await page.send("DOM.getDocument", { depth: -1, pierce: true });
    if (response.error) throw new Error(response.error.message);
    const root = response.result.root;
    const found = inspect(root).sections;
    if (headings.every((heading) => found.has(heading))) return inspect(root);
    await sleep(50);
  }
  throw new Error("凍結節の読み込みが終わらない");
}

const original = execFileSync("git", ["show", `main:${pagePath}`], { encoding: "utf8" });
const current = readFileSync(resolve(pagePath), "utf8");
const page = await openPage();
try {
  const disabled = await page.send("Emulation.setScriptExecutionDisabled", { value: true });
  if (disabled.error) throw new Error(disabled.error.message);
  const before = await load(page, original);
  const after = await load(page, current);
  const failures = [];
  for (const heading of headings) {
    const oldText = before.sections.get(heading);
    const newText = after.sections.get(heading);
    console.log(`${heading}: main ${oldText?.length ?? 0} / current ${newText?.length ?? 0} 文字`);
    if (!oldText || !newText) failures.push(`${heading}: 節がないか空`);
    else if (oldText !== newText) {
      const index = [...oldText].findIndex((char, i) => char !== [...newText][i]);
      failures.push(`${heading}: ${Math.max(0, index)} 文字目 main=${JSON.stringify(oldText.slice(index, index + 36))} current=${JSON.stringify(newText.slice(index, index + 36))}`);
    }
  }
  for (const fact of before.facts) if (!after.pillFacts.includes(fact)) failures.push(`facts: ${fact}`);
  for (const href of before.hrefs) if (!after.hrefs.has(href)) failures.push(`href: ${href}`);
  for (const price of before.prices) if (!after.prices.has(price)) failures.push(`価格: ${price}`);
  if (failures.length) {
    console.error(`NG text-freeze ${pagePath}\n${failures.slice(0, 12).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`OK text-freeze ${pagePath}: 6 節 / facts ${before.facts.length} 件 / href ${before.hrefs.size} 件 / 価格 ${before.prices.size} 件`);
  }
} finally {
  page.close();
}
