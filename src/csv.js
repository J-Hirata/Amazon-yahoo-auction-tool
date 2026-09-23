import { buildYahooDraft } from "./draft.js";

export function buildDraftCsv(items) {
  const rows = [
    ["ASIN", "タイトル", "初回価格", "7日後価格", "発送元", "送料", "発送目安", "Amazon URL", "画像URL", "説明"]
  ];

  for (const item of items) {
    const draft = buildYahooDraft(item);
    rows.push([
      draft.asin,
      draft.title,
      draft.price || "",
      draft.stalePrice || "",
      draft.sourceRegion,
      draft.shipping,
      draft.shipAfter,
      item.amazonUrl,
      draft.imageUrls.join("\n"),
      draft.description
    ]);
  }

  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}
