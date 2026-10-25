import {mkdir, writeFile, realpath} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "data", "cloud-private");
let input = "";
if (process.stdin.isTTY) process.stdin.setRawMode(true);
for await (const chunk of process.stdin) {input += chunk; if (input.length > 20000) throw new Error("Input too large"); if (/[\r\n]/.test(input)) break;}
try {
  const data = JSON.parse(input);
  const url = new URL(data.connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname.endsWith(".neon.tech") || url.pathname !== "/neondb" || !url.username || !url.password) throw new Error();
  await mkdir(directory, {recursive: true, mode: 0o700});
  if (await realpath(directory) !== directory) throw new Error();
  if (process.platform === "win32") {
    const sid = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], {encoding: "utf8", windowsHide: true}).trim();
    if (!/^S-1-5-/.test(sid)) throw new Error();
    execFileSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], {stdio: "pipe", windowsHide: true});
  }
  const values = {ASIN_STORAGE_BACKEND: "postgres", ASIN_DATABASE_URL: url.toString(), ASIN_DATABASE_EXPECTED_HOST: url.hostname,
    ASIN_DATABASE_ENVIRONMENT: "production", ASIN_NEON_AUTH_URL: "https://ep-soft-band-a1xgevpf.neonauth.ap-southeast-1.aws.neon.tech/neondb/auth", ASIN_PUBLIC_ORIGIN: "https://amazon-yahoo-inventory.vercel.app"};
  await writeFile(path.join(directory, "main-admin.env"), Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n", {flag: "wx", mode: 0o600});
  console.log(JSON.stringify({saved: true, credentialsPrinted: false, directoryProtected: true}));
} catch {console.error("専用の秘密設定を保存できません。値は表示していません"); process.exitCode = 1;}
