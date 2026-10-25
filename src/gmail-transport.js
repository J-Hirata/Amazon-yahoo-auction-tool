import {spawn} from "node:child_process";
import {access, readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

export {NOTIFICATION_ADDRESS} from "./notification-settings.js";
const helper = fileURLToPath(new URL("../scripts/deliver-gmail.ps1", import.meta.url));
export function createGmailTransport(directory, {spawnImpl = spawn} = {}) {
  return {
    async available() {
      if (process.platform !== "win32") return false;
      try {await access(path.join(directory, "gmail-credential.xml")); return true;} catch {return false;}
    },
    async receipt(id) {
      if (!/^[a-f0-9-]{36}$/.test(id)) return null;
      try {return JSON.parse(await readFile(path.join(directory, "mail-receipts", `${id}.json`), "utf8")).status;} catch {return null;}
    },
    send(message) {
      return new Promise((resolve, reject) => {
        const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const child = spawnImpl(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-DataDirectory", directory], {windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
        let output = "", finished = false;
        const finish = (result) => {if (finished) return; finished = true; clearTimeout(timer); resolve(result);};
        const timer = setTimeout(() => {child.kill(); finish({status: "uncertain", error: "メール送信結果を確認できません。重複防止のため自動再送を保留しました"});}, 45000);
        child.stdout.on("data", (data) => {if (output.length < 10000) output += data;});
        // Never return raw PowerShell stderr: it can contain input or sensitive diagnostics.
        child.stderr.on("data", () => {});
        child.stdin.on("error", () => {});
        child.on("error", () => {if (!finished) {finished = true; clearTimeout(timer); reject(new Error("メール送信処理を起動できません"));}});
        child.on("close", () => {
          try {
            const result = JSON.parse(output.trim());
            if (!["smtp_accepted", "failed", "uncertain"].includes(result.status)) throw new Error();
            finish({status: result.status, error: result.status === "failed" ? "メールを送信できませんでした。接続・認証設定を確認して再試行してください" : result.status === "uncertain" ? "送信結果が不明です。受信箱を確認してください。自動再送は保留しています" : undefined});
          } catch {finish({status: "uncertain", error: "メール送信結果を確認できません。自動再送は保留しています"});}
        });
        child.stdin.end(JSON.stringify({id: message.id, subject: message.subject, text: message.text}), "utf8");
      });
    }
  };
}
