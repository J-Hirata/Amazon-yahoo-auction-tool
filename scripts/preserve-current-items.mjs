import {readFile, writeFile, mkdir, copyFile} from "node:fs/promises";
import {isDeepStrictEqual} from "node:util";

// One-time migration: preserve the currently served queue before switching roots.
const target = new URL("../data/items.json", import.meta.url);
const current = JSON.parse(await readFile(target, "utf8"));
const useRunningQueue = process.argv.includes("--use-running-queue");
const response = await fetch("http://localhost:41731/api/items");
if (!response.ok) throw new Error("Cannot read the running queue");
const {items} = await response.json();
if (!Array.isArray(items)) throw new Error("Invalid running queue");
const byAsin = new Map(items.map((item) => [item.asin, item]));
if (byAsin.size !== items.length) throw new Error("Duplicate ASINs; manual review needed");
for (const item of useRunningQueue ? [] : current) {
  const live = byAsin.get(item.asin);
  if (!live || Date.parse(item.updatedAt || 0) > Date.parse(live.updatedAt || 0)) throw new Error(`Newer canonical item: ${item.asin}`);
  if (item.updatedAt === live.updatedAt && !isDeepStrictEqual(item, live)) throw new Error(`Conflicting item: ${item.asin}`);
}
const backup = new URL(`../data/extension-backup-${Date.now()}/`, import.meta.url);
await mkdir(backup, {recursive: true});
await copyFile(target, new URL("canonical-items.json", backup));
await writeFile(new URL("running-items.json", backup), JSON.stringify(items, null, 2) + "\n");
await writeFile(new URL("migration-summary.json", backup), JSON.stringify({
  selectedSource: "http://localhost:41731/api/items",
  runningCount: items.length,
  previousCount: current.length,
  canonicalOnlyAsins: current.filter((item) => !byAsin.has(item.asin)).map((item) => item.asin),
  useRunningQueue,
  checkedAt: new Date().toISOString()
}, null, 2) + "\n");
await writeFile(target, JSON.stringify(items, null, 2) + "\n");
console.log(`Preserved ${items.length} running items; previous ${current.length} items backed up at ${backup.pathname}`);
