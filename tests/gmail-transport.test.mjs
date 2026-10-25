import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createGmailTransport} from "../src/gmail-transport.js";

test("mail helper receives Unicode JSON on stdin, not a password or a shell command", async () => {
  let received;
  const transport = createGmailTransport("test-only", {spawnImpl(exe, args, options) {
    assert.ok(exe.endsWith("powershell.exe"));
    assert.ok(args.includes("-NonInteractive"));
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, undefined);
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let content = "";
    child.stdin.on("data", (chunk) => {content += chunk.toString("utf8");});
    child.stdin.on("finish", () => {
      received = JSON.parse(content);
      child.stderr.write("sensitive-test-diagnostic-do-not-return");
      child.stdout.write('{"status":"smtp_accepted"}'); child.emit("close", 0);
    });
    return child;
  }});
  const message = {id: "12345678-1234-1234-1234-123456789abc", subject: "紐付けが完了しました", text: "スタンドなし。電源コード付属。"};
  const result = await transport.send(message);
  assert.deepEqual(received, message);
  assert.deepEqual(result, {status: "smtp_accepted", error: undefined});
  assert.ok(!JSON.stringify(result).includes("sensitive-test"));
});
test("malformed helper output is uncertain and invalid receipt IDs cannot read files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asin-mail-transport-"));
  const transport = createGmailTransport(directory, {spawnImpl() {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.on("finish", () => {child.stdout.write("invalid response"); child.emit("close", 1);});
    return child;
  }});
  assert.equal((await transport.send({id: "dummy", subject: "test", text: "test"})).status, "uncertain");
  assert.equal(await transport.receipt("../../anything"), null);
  await mkdir(path.join(directory, "mail-receipts"));
  const id = "12345678-1234-1234-1234-123456789abc";
  await writeFile(path.join(directory, "mail-receipts", `${id}.json`), '{"status":"smtp_accepted"}');
  assert.equal(await transport.receipt(id), "smtp_accepted");
});
test("PowerShell helper preview validates Japanese without SMTP or credential access", {skip: process.platform !== "win32"}, () => {
  const exe = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const helper = fileURLToPath(new URL("../scripts/deliver-gmail.ps1", import.meta.url));
  for (const [subject, expected] of [["日本語メールの確認", "preview"], ["bad\nsubject", "failed"]]) {
    const result = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-DataDirectory", path.join(os.tmpdir(), "no-real-mail-credentials"), "-Preview"], {
      input: JSON.stringify({id: "12345678-1234-1234-1234-123456789abc", subject, text: "電源コード付属"}), encoding: "utf8", windowsHide: true, timeout: 10000
    });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout.trim()).status, expected);
  }
});
