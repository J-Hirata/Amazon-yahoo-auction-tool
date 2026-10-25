import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";

// Keep the previous command, but open the integrated tool instead of a second server.
const script = fileURLToPath(new URL("../start-link-preview.ps1", import.meta.url));
const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
  stdio: "inherit",
  windowsHide: true
});
child.on("error", (error) => {console.error(error.message); process.exitCode = 1;});
child.on("exit", (code) => {process.exitCode = code ?? 1;});
