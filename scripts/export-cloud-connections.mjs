import {readFile, writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {loadAmazonConfig} from "../src/amazon-local-config.js";
import {NOTIFICATION_ADDRESS} from "../src/notification-settings.js";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
  const config = await loadAmazonConfig();
  const state = JSON.parse(await readFile(path.join(root, "data", "link-monitor.json"), "utf8"));
  if (!state.amazonAccountKey || state.amazonAccountKey !== config.accountKey || !state.amazonSellerId) throw new Error();
  const credential = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $c=Import-Clixml -LiteralPath 'data/gmail-credential.xml'; @{user=$c.UserName;password=$c.GetNetworkCredential().Password}|ConvertTo-Json -Compress"], {cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"]}));
  const password = credential.password.replace(/\s/g, "");
  if (credential.user !== NOTIFICATION_ADDRESS || !/^[a-zA-Z]{16}$/.test(password)) throw new Error();
  const values = {ASIN_AMAZON_CLIENT_ID: config.clientId, ASIN_AMAZON_CLIENT_SECRET: config.clientSecret, ASIN_AMAZON_REFRESH_TOKEN: config.refreshToken,
    ASIN_AMAZON_MARKETPLACE_ID: config.marketplaceId, ASIN_AMAZON_SELLER_ID: state.amazonSellerId, ASIN_GMAIL_USER: credential.user, ASIN_GMAIL_APP_PASSWORD: password};
  await writeFile(path.join(root, "data", "cloud-private", "connections.env"), Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n", {flag: "wx", mode: 0o600});
  console.log(JSON.stringify({amazonAccountMatches: true, gmailCredentialRecovered: true, secretsPrinted: false, sent: false}));
} catch {console.error("接続用の秘密設定を準備できませんでした。秘密値は表示していません"); process.exitCode = 1;}
