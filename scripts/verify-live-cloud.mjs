import assert from "node:assert/strict";
import {readFile, writeFile} from "node:fs/promises";

const origin = "https://amazon-yahoo-inventory.vercel.app";
const deployment = process.argv[2] || null;
if (deployment && !/^dpl_[A-Za-z0-9]+$/.test(deployment)) throw new Error("Deployment ID required");
const paths = [["/", 200], ["/?view=drafts", 200], ["/api/cloud-config", 200], ["/api/link-monitor", 401], ["/api/items", 401], ["/api/demo", 404]];
const checks = [];
for (const [path, expected] of paths) {
  const response = await fetch(origin + path);
  assert.equal(response.status, expected, path);
  if (path === "/api/cloud-config") assert.equal((await response.json()).authUrl, "https://ep-soft-band-a1xgevpf.neonauth.ap-southeast-1.aws.neon.tech/neondb/auth");
  else assert.doesNotMatch(await response.text(), /B0176E86U8|c1245610698|postgres(?:ql)?:\/\//);
  checks.push({path, status: expected});
}
const setup = JSON.parse(await readFile(new URL("../data/cloud-private/owner-setup.json", import.meta.url)));
const response = await fetch(origin + "/api/owner/check", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({setupToken: setup.token})});
assert.ok([200, 409].includes(response.status));
const invalid = await fetch(origin + "/api/owner/check", {method: "POST", headers: {"Content-Type": "application/json", Origin: "https://other.example"}, body: JSON.stringify({setupToken: setup.token})});
assert.equal(invalid.status, 403);
const report = {verifiedAt: new Date().toISOString(), origin, deployment, checks, ownerEnrolled: response.status === 409, differentOriginRejected: true, secretsPrinted: false, mailboxChecked: false, marketplaceWrites: 0};
await writeFile(new URL("../output/cloud-release-verification.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
