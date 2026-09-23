import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "..", "data");
const dbPath = path.join(dataDir, "items.json");

export async function loadItems() {
  try {
    const raw = await readFile(dbPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function saveItems(items) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(dbPath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

export async function upsertItems(nextItems) {
  const current = await loadItems();
  const byAsin = new Map(current.map((item) => [item.asin, item]));
  for (const item of nextItems) {
    byAsin.set(item.asin, { ...byAsin.get(item.asin), ...item, updatedAt: new Date().toISOString() });
  }
  const merged = [...byAsin.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  await saveItems(merged);
  return merged;
}
