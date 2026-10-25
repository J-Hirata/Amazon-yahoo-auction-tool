import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {vercelCloudRequest} from "../src/vercel-entry.js";
import {parse} from "dotenv";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, ".vercel", "output");
const functionDirectory = path.join(output, "functions", "api", "inventory.func");
let checks = 0;
const pass = (message) => {checks++; console.log(`PASS ${message}`);};
const manifest = JSON.parse(await readFile(path.join(output, "config.json"), "utf8"));
assert.equal(manifest.version, 3);
assert.equal(manifest.crons?.length || 0, 0);
const route = manifest.routes.find((item) => item.dest?.startsWith("/api/inventory?__route="));
assert.ok(route);
for (const routePath of ["/api/cloud-config", "/api/session", "/api/link-monitor", "/api/link-monitor/links/fixture-id/memo", "/api/link-monitor/page-links/batch"]) {
  const match = routePath.match(new RegExp(route.src));
  assert.ok(match, routePath);
  const target = route.dest.replace(/\$(\d+)/g, (_, index) => match[Number(index)] || "");
  const canonical = vercelCloudRequest(new Request("https://inventory.example" + target));
  assert.equal(new URL(canonical.url).pathname, routePath);
}
pass("generated Vercel routing preserves nested API paths");
const expected = (await readdir(path.join(root, "dist", "cloud"))).sort();
assert.deepEqual((await readdir(path.join(output, "static"))).sort(), expected);
for (const name of expected) {
  const source = await readFile(path.join(root, "dist", "cloud", name));
  assert.deepEqual(await readFile(path.join(output, "static", name)), source);
  assert.deepEqual(await readFile(path.join(functionDirectory, "dist", "cloud", name)), source);
}
pass("static CDN and function contain exactly the same reviewed cloud assets");
const functionConfig = JSON.parse(await readFile(path.join(functionDirectory, ".vc-config.json"), "utf8"));
assert.equal(functionConfig.runtime, "nodejs22.x");
assert.equal(functionConfig.handler, "api/inventory.js");
assert.equal(functionConfig.filePathMap, undefined);
assert.deepEqual(functionConfig.environment, {});
pass("Node 22 function has no inline secrets or external file references");
const files = await readdir(functionDirectory, {recursive: true, withFileTypes: true});
const forbidden = files.filter((entry) => entry.isFile()).map((entry) => path.relative(functionDirectory, path.join(entry.parentPath || entry.path, entry.name)).replaceAll("\\", "/"))
  .filter((name) => /^(?:data|scripts|tests|output|test-output|\.git|\.vercel)\//.test(name) || /(?:^|\/)\.env(?:\.|$)/.test(name) || /^(?:src\/(?:server|gmail-transport|manual-fba-job|amazon-local-config)\.js)$/.test(name));
assert.deepEqual(forbidden, []);
pass("private function excludes business records, Windows mail helpers and legacy servers");
const secrets = [];
for (const name of ["data/cloud-private/main-admin.env", "data/cloud-private/app-runtime.env", "data/cloud-private/connections.env", ".vercel/.env.production.local", ".vercel/.env.preview.local"]) {
  let values; try {values = parse(await readFile(path.join(root, name)));} catch (error) {if (error.code === "ENOENT") continue; throw error;}
  for (const [key, value] of Object.entries(values)) {
    if (/DATABASE_URL|OIDC_TOKEN|CLIENT_SECRET|REFRESH_TOKEN|APP_PASSWORD/.test(key) && value) secrets.push(value);
    if (/DATABASE_URL/.test(key) && value) secrets.push(decodeURIComponent(new URL(value).password));
  }
}
try {secrets.push(JSON.parse(await readFile(path.join(root, "data/cloud-private/owner-setup.json"))).token);} catch (error) {if (error.code !== "ENOENT") throw error;}
let inspected = 0;
for (const entry of await readdir(output, {recursive: true, withFileTypes: true})) {
  if (!entry.isFile()) continue;
  const content = await readFile(path.join(entry.parentPath || entry.path, entry.name));
  assert.equal(secrets.filter(Boolean).some((value) => content.includes(Buffer.from(value))), false, "A private value was found in release output");
  inspected++;
}
pass(`no database credentials, setup capability or system tokens in ${inspected} release files`);
const runtimeModule = await import(pathToFileURL(path.join(functionDirectory, "src", "cloud-runtime.js")));
const packagedAssets = await runtimeModule.loadCloudAssets();
assert.ok(packagedAssets.has("/"));
assert.ok(packagedAssets.has("/cloud-login.js"));
assert.ok(packagedAssets.has("/link-monitor.js"));
pass("packaged runtime loads assets without depending on the source checkout");
const entry = (await import(pathToFileURL(path.join(functionDirectory, "api", "inventory.js")))).default;
const before = process.env.ASIN_OWNER_USER_ID;
delete process.env.ASIN_OWNER_USER_ID;
try {
  const response = await entry.fetch(new Request("https://inventory.example/api/link-monitor"));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /password|postgres:|ASIN_DATABASE_URL/);
} finally {if (before !== undefined) process.env.ASIN_OWNER_USER_ID = before;}
pass("actual packaged function fails closed when owner configuration is missing");
console.log(JSON.stringify({passed: checks, deployed: false, businessDataIncluded: false}));
