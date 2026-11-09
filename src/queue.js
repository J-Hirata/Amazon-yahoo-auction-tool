import { CONFIG } from "./config.js";

const HIDDEN_STATUSES = new Set(["draft_saved", "listed", "sold", "archived", "deleted"]);

export function splitDraftQueue(items) {
  const visible = items
    .filter((item) => !HIDDEN_STATUSES.has(item.status))
    .sort(compareForWork);

  const ready = visible.filter((item) => item.status === "ready_for_draft");
  const notReady = visible.filter((item) => item.status !== "ready_for_draft");
  const active = ready.slice(0, CONFIG.yahooDraftCapacity);
  const waiting = [...ready.slice(CONFIG.yahooDraftCapacity), ...notReady];

  return { active, waiting };
}

export function findPriceReviewItems(items, now = new Date()) {
  const staleMs = CONFIG.staleAfterDays * 24 * 60 * 60 * 1000;
  return items.filter((item) => {
    if (item.status !== "listed" || !item.listedAt) return false;
    return now.getTime() - new Date(item.listedAt).getTime() >= staleMs;
  });
}

function compareForWork(a, b) {
  const readyDiff = readyRank(a) - readyRank(b);
  if (readyDiff !== 0) return readyDiff;
  const priority=(Number.isSafeInteger(a.workPriority)?a.workPriority:Infinity)-(Number.isSafeInteger(b.workPriority)?b.workPriority:Infinity);
  if(priority)return priority;
  return dateValue(a.createdAt) - dateValue(b.createdAt);
}

function readyRank(item) {
  if (item.status === "ready_for_draft") return 0;
  if (item.status === "waiting_for_product_data") return 1;
  return 2;
}

function dateValue(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}
