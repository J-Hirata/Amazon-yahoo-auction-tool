import path from "node:path";
import {createCloudRuntime} from "../../src/cloud-runtime.js";

let runtime;
export default async function inventory(request) {
  try {
    runtime ||= createCloudRuntime({assetDirectory: path.resolve("dist/cloud")});
    return (await runtime).handler(request);
  } catch {
    runtime = undefined;
    return Response.json({error: "公開設定を確認中です。既存データは変更していません"}, {status: 503, headers: {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}});
  }
}
export const config = {path: ["/", "/link-monitor.html", "/api/*"]};
