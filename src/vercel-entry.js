import path from "node:path";
import {createCloudRuntime} from "./cloud-runtime.js";
import {attachDatabasePool} from "@vercel/functions";
import {publicDemo} from "./public-demo.js";

export function vercelCloudRequest(request) {
  const url = new URL(request.url);
  if (!url.searchParams.has("__route")) return request;
  const value = url.searchParams.get("__route") || "";
  const route = value.startsWith("/") ? value.slice(1) : value;
  if (url.searchParams.getAll("__route").length !== 1 || [...url.searchParams.keys()].some((key) => !["__route", "path"].includes(key)) ||
      (url.searchParams.has("path") && (url.searchParams.getAll("path").length !== 1 || url.searchParams.get("path") !== route)) ||
      !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(route || "") || route.length > 500) return null;
  const canonicalPath = `/api/${route}`;
  if (url.pathname !== "/api/inventory" && url.pathname !== canonicalPath) return null;
  url.pathname = canonicalPath;
  url.search = "";
  return new Request(url, request);
}

export function vercelCloudEnvironment(env = process.env) {
  if (env.ASIN_PUBLIC_ORIGIN) return {...env};
  // Only Vercel's server-side preview hostname may supply a missing origin.
  // Never derive this value from Host, Forwarded, or a request parameter.
  if (env.VERCEL === "1" && env.VERCEL_ENV === "preview" &&
      /^[a-z0-9][a-z0-9-]*\.vercel\.app$/.test(env.VERCEL_URL || "")) {
    return {...env, ASIN_PUBLIC_ORIGIN: `https://${env.VERCEL_URL}`};
  }
  return {...env};
}

export function createVercelEntry({runtimeFactory = createCloudRuntime, environment = () => process.env, attachPool = attachDatabasePool} = {}) {
  let runtime;
  return async function fetch(request) {
    try {
      const canonical = vercelCloudRequest(request);
      if (!canonical) return Response.json({error: "未対応のURLです"}, {status: 404, headers: {"Cache-Control": "no-store"}});
      if (new URL(canonical.url).pathname === "/api/demo") return publicDemo(canonical, environment());
      runtime ||= Promise.resolve(runtimeFactory({assetDirectory: path.resolve("dist/cloud"), env: vercelCloudEnvironment(environment())})).then((value) => {
        if (value.pool) attachPool(value.pool);
        return value;
      });
      return await (await runtime).handler(canonical);
    } catch {
      runtime = undefined;
      return Response.json({error: "公開設定を確認中です。既存データは変更していません"}, {
        status: 503, headers: {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
      });
    }
  };
}
