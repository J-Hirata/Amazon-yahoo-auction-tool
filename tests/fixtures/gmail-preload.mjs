// Browser-test child only. No SMTP process or real credential is used.
import childProcess from "node:child_process";
import {syncBuiltinESMExports} from "node:module";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const directory = process.env.LINK_MONITOR_DATA_DIR;
if (!directory || !path.basename(directory).startsWith("asin-link-browser-") || !path.resolve(directory).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase() + path.sep)) throw new Error("Mail mock requires an isolated browser-test directory");
const originalSpawn = childProcess.spawn;
let deliveries = 0;
childProcess.spawn = function(exe, args, options) {
  if (!args.some((value) => String(value).endsWith("deliver-gmail.ps1"))) return originalSpawn(exe, args, options);
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  let input = "";
  child.stdin.on("data", (chunk) => {input += chunk;});
  child.stdin.on("finish", async () => {
    const payload = JSON.parse(input);
    const status = ++deliveries === 2 ? "failed" : "smtp_accepted";
    await mkdir(path.join(directory, "mail-receipts"), {recursive: true});
    await writeFile(path.join(directory, "mail-receipts", `${payload.id}.json`), JSON.stringify({status}));
    child.stdout.write(JSON.stringify({status}));
    child.emit("close", 0);
  });
  return child;
};
syncBuiltinESMExports();
