import path from "node:path";
import { fileURLToPath } from "node:url";
import {configuredDocumentStore} from "./storage-runtime.js";
import {validateDraftItems} from "./storage-validation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "..", "data");
const itemStore = configuredDocumentStore({key: "draft-items", directory: process.env.ASIN_DATA_DIR || dataDir,
  filename: "items.json", empty: () => [], validate: validateDraftItems});

export async function loadItems() {
  return itemStore.read();
}

export async function saveItems(items) {
  validateDraftItems(items);
  await itemStore.update((state) => {state.splice(0, state.length, ...items);});
}

export async function updateItems(callback) {
  return itemStore.update(async (state) => {
    const next = await callback(state);
    if (next && next !== state) {validateDraftItems(next); state.splice(0, state.length, ...next);}
    return structuredClone(state);
  });
}

export async function upsertItems(nextItems) {
  return updateItems((current) => {
    const byAsin = new Map(current.map((item) => [item.asin, item]));
    for (const item of nextItems) {
      byAsin.set(item.asin, { ...byAsin.get(item.asin), ...item, updatedAt: new Date().toISOString() });
    }
    return [...byAsin.values()].sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  });
}
