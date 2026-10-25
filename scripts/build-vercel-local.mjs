import {readFile, writeFile, readdir, lstat, realpath, rm, mkdir, copyFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const production = process.argv.includes("--prod");
if (process.argv.slice(2).some((argument) => argument !== "--prod")) throw new Error("ビルド対象は省略(preview)または--prodを指定してください");
const project = JSON.parse(await readFile(path.join(root, ".vercel", "project.json"), "utf8"));
if (project.projectName !== "amazon-yahoo-inventory" || !project.projectId || !project.orgId) throw new Error("先に今回専用のVercelプロジェクトへ紐付けてください");
const cli = process.env.ASIN_VERCEL_CLI_PATH || (process.platform === "win32" ? path.join(process.env.APPDATA, "npm", "node_modules", "vercel", "dist", "index.js") : "");
if (!cli) throw new Error("ASIN_VERCEL_CLI_PATHでVercel CLIのJS入口を指定してください");
async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {cwd: root, stdio: "inherit", windowsHide: true});
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Build step failed (${code})`)));
  });
}
// Vercel CLI's nested cmd.exe build step fails on this Windows installation.
// Build the same assets directly with Node, then let Vercel package the function.
await run(["scripts/build-cloud.mjs"]);
const config = JSON.parse(await readFile(path.join(root, "vercel.json"), "utf8"));
const localConfig = path.join(root, ".vercel", "local-build-config.json");
await writeFile(localConfig, JSON.stringify({...config, buildCommand: "", installCommand: ""}, null, 2) + "\n", "utf8");
await run([cli, "build", ...(production ? ["--prod"] : []), "--yes", "--standalone", "--local-config", localConfig, "--scope", "bc-bridalcatjps-projects"]);
// With the local no-command override Vercel selects its root static builder.
// Replace only that generated directory with the exact reviewed cloud assets.
const output = path.join(root, ".vercel", "output");
const staticDirectory = path.join(output, "static");
const expectedOutput = path.join(await realpath(root), ".vercel", "output");
if (await realpath(output) !== expectedOutput || (await lstat(staticDirectory)).isSymbolicLink() || await realpath(staticDirectory) !== staticDirectory) throw new Error("生成物の保存先を確認できません。置換を中止しました");
const assets = await readdir(path.join(root, "dist", "cloud"), {withFileTypes: true});
if (assets.some((entry) => !entry.isFile())) throw new Error("公開ファイルに想定外のフォルダがあります");
await rm(staticDirectory, {recursive: true});
await mkdir(staticDirectory);
for (const asset of assets) await copyFile(path.join(root, "dist", "cloud", asset.name), path.join(staticDirectory, asset.name));
const functionDirectory = path.join(output, "functions", "api", "inventory.func");
const functionConfigPath = path.join(functionDirectory, ".vc-config.json");
const functionConfig = JSON.parse(await readFile(functionConfigPath, "utf8"));
const assetNames = new Set(assets.map((entry) => `dist/cloud/${entry.name}`));
for (const [destination, source] of Object.entries(functionConfig.filePathMap || {})) {
  if (!assetNames.has(destination) || ![destination, `.vercel/output/shared/${destination}`].includes(source)) throw new Error("関数の外部ファイル参照が想定外です。配備前に確認してください");
  const mapped = await readFile(path.join(root, source));
  const original = await readFile(path.join(root, destination));
  if (!mapped.equals(original)) throw new Error("配備用の静的ファイルが一致しません");
}
await mkdir(path.join(functionDirectory, "dist", "cloud"), {recursive: true});
for (const asset of assets) await copyFile(path.join(root, "dist", "cloud", asset.name), path.join(functionDirectory, "dist", "cloud", asset.name));
delete functionConfig.filePathMap;
await writeFile(functionConfigPath, JSON.stringify(functionConfig, null, 2) + "\n", "utf8");
console.log("Vercel package completed: private API function and reviewed cloud assets only");
