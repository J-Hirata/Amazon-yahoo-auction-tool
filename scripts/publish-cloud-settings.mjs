import {readFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {parse} from "dotenv";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = JSON.parse(await readFile(path.join(root, ".vercel", "project.json"), "utf8"));
if (project.projectId !== "prj_GSVAyWDoMTIJepaEbf3YrBplCByT" || project.orgId !== "team_kDASckvfUG81AUJTtTSrqD35") throw new Error("Dedicated project required");
const settings = parse(await readFile(path.join(root, "data", "cloud-private", "app-runtime.env")));
const allowed = ["ASIN_STORAGE_BACKEND", "ASIN_DATABASE_URL", "ASIN_DATABASE_EXPECTED_HOST", "ASIN_DATABASE_ENVIRONMENT", "ASIN_NEON_AUTH_URL", "ASIN_PUBLIC_ORIGIN", "ASIN_OWNER_FROM_DATABASE", "ASIN_CLOUD_FULL_WORKSPACE", "ASIN_CLOUD_READ_ONLY"];
if (Object.keys(settings).length !== allowed.length || allowed.some((key) => !settings[key])) throw new Error("Unexpected settings");
const cli = path.join(process.env.APPDATA, "npm", "node_modules", "vercel", "dist", "index.js");
for (const key of allowed) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "env", "add", key, "production", ...(key === "ASIN_DATABASE_URL" ? ["--sensitive"] : []), "--scope", "bc-bridalcatjps-projects"], {cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true});
    child.stdout.resume(); child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", () => reject(new Error(`Cannot configure ${key}`)));
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Cannot configure ${key}; check variable names without displaying values`)));
    child.stdin.end(settings[key]);
  });
  console.log(`Configured ${key} (value not displayed)`);
}
