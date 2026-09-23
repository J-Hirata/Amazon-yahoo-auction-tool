import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "..", "data");
const dbPath = path.join(dataDir, "stock-watch.json");

export async function loadStockWatch() {
  try {
    const raw = await readFile(dbPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function saveStockWatch(items) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(dbPath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

export async function upsertStockWatch(nextItems) {
  const current = await loadStockWatch();
  const now = new Date().toISOString();
  const byAsin = new Map(current.map((item) => [item.asin, item]));
  for (const item of nextItems) {
    byAsin.set(item.asin, {
      sellerName: "キャットコーポレーション合同会社",
      status: "watching",
      reminderHours: 6,
      note: "",
      createdAt: now,
      ...byAsin.get(item.asin),
      ...item,
      updatedAt: now
    });
  }
  const merged = [...byAsin.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  await saveStockWatch(merged);
  return merged;
}
