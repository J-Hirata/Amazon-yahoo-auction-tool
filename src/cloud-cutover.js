import {readFile} from "node:fs/promises";
import path from "node:path";

export async function cloudCutover(directory) {
  let text;
  try {text = await readFile(path.join(directory, "cloud-cutover.json"), "utf8");}
  catch (error) {if (error.code === "ENOENT") return null; throw error;}
  const value = JSON.parse(text);
  if (value.version !== 1 || value.origin !== "https://amazon-yahoo-inventory.vercel.app" || value.projectId !== "prj_GSVAyWDoMTIJepaEbf3YrBplCByT") throw new Error("クラウド切替情報を確認してください。ローカル保存は再開しません");
  return value;
}
