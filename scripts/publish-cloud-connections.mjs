import {readFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {parse} from "dotenv";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = JSON.parse(await readFile(path.join(root, ".vercel/project.json")));
if (project.projectId !== "prj_GSVAyWDoMTIJepaEbf3YrBplCByT" || project.orgId !== "team_kDASckvfUG81AUJTtTSrqD35") throw new Error("Dedicated project required");
const values = parse(await readFile(path.join(root, "data/cloud-private/connections.env")));
const keys = ["ASIN_AMAZON_CLIENT_ID", "ASIN_AMAZON_CLIENT_SECRET", "ASIN_AMAZON_REFRESH_TOKEN", "ASIN_AMAZON_MARKETPLACE_ID", "ASIN_AMAZON_SELLER_ID", "ASIN_GMAIL_USER", "ASIN_GMAIL_APP_PASSWORD"];
if (Object.keys(values).length !== keys.length || keys.some((key) => !values[key])) throw new Error("Incomplete private settings");
for (const key of keys) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.env.APPDATA, "npm/node_modules/vercel/dist/index.js"), "env", "add", key, "production", "--sensitive", "--scope", "bc-bridalcatjps-projects"], {cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
    child.stdout.resume(); child.stderr.resume(); child.stdin.on("error", () => {});
    child.once("error", () => reject(new Error(`Cannot configure ${key}`)));
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Cannot configure ${key}; no values displayed`)));
    child.stdin.end(values[key]);
  });
  console.log(`Configured ${key} (private value not displayed)`);
}
