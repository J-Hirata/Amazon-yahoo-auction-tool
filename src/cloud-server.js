import http from "node:http";
import {Readable} from "node:stream";
import {createCloudRuntime} from "./cloud-runtime.js";

try {
  const {config, handler} = await createCloudRuntime();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, config.origin);
      if (req.headers.host !== new URL(config.origin).host || url.origin !== config.origin) {res.writeHead(403); return res.end();}
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const request = new Request(url, {method: req.method, headers, ...(["GET", "HEAD"].includes(req.method) ? {} : {body: Readable.toWeb(req), duplex: "half"})});
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {res.writeHead(500, {"Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store"}); res.end("リクエストを処理できませんでした");}
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.listen(Number(process.env.PORT || 41733), process.env.ASIN_BIND_HOST || "127.0.0.1", () => console.log(`Cloud trial: ${config.origin} (mail/background jobs disabled)`));
} catch {
  console.error("クラウド版の起動設定・ビルドを確認してください。本人ID未設定のままでは起動しません。秘密情報は表示しません。");
  process.exitCode = 1;
}
