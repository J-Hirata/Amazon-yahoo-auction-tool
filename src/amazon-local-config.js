import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {parse} from "dotenv";
import {amazonConfigFromValues} from "./amazon-fba-reader.js";

const sharedEnv = fileURLToPath(new URL("../../../05_分析・ダッシュボード/売上ダッシュボード/ai-keiei-dashboard/.env", import.meta.url));
export async function loadAmazonConfig(file = process.env.ASIN_AMAZON_ENV_FILE || sharedEnv) {
  let env;
  try {env = parse(await readFile(file));}
  catch {throw new Error("既存のAmazon接続設定を読み取れません。設定ファイルを確認してください");}
  return amazonConfigFromValues(env);
}
