import {createRemoteJWKSet, jwtVerify} from "jose";

export function cloudConfiguration(env = process.env) {
  let origin, auth;
  try {origin = new URL(env.ASIN_PUBLIC_ORIGIN); auth = new URL(env.ASIN_NEON_AUTH_URL);} catch {
    throw new Error("公開先と専用Neon AuthのURLを設定してください");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.href !== `${origin.origin}/` || origin.username || origin.password ||
      (origin.protocol !== "https:" && !(local && origin.protocol === "http:"))) throw new Error("公開先はHTTPSのOriginを指定してください");
  if (auth.protocol !== "https:" || !auth.hostname.endsWith(".neon.tech") || !auth.hostname.includes(".neonauth.") ||
      auth.username || auth.password || auth.port || auth.search || auth.hash || !/^\/[a-zA-Z0-9_-]+\/auth$/.test(auth.pathname)) throw new Error("専用Neon AuthのURLを確認してください");
  const ownerUserId = String(env.ASIN_OWNER_USER_ID || "").trim();
  const ownerFromDatabase = env.ASIN_OWNER_FROM_DATABASE === "1";
  if ((!ownerFromDatabase && !/^[a-zA-Z0-9_-]{8,128}$/.test(ownerUserId)) || (ownerFromDatabase && ownerUserId)) throw new Error("本人の認証ユーザーIDが未設定です。公開を開始できません");
  return {origin: origin.origin, authUrl: auth.href, ownerUserId, ownerFromDatabase, fullWorkspace: env.ASIN_CLOUD_FULL_WORKSPACE === "1", readOnly: env.ASIN_CLOUD_READ_ONLY !== "0"};
}

export function createIdentityVerifier({authUrl, keySet = createRemoteJWKSet(new URL(`${authUrl}/.well-known/jwks.json`), {timeoutDuration: 5000})}) {
  const issuer = new URL(authUrl).origin;
  return async function verify(request) {
    const authorization = request.headers.get("authorization") || "";
    if (!/^Bearer [A-Za-z0-9_.-]{1,8192}$/i.test(authorization)) return {status: 401};
    try {
      const {payload} = await jwtVerify(authorization.slice(7), keySet, {
        issuer, algorithms: ["EdDSA"], requiredClaims: ["sub", "iat", "exp"], maxTokenAge: "16m", clockTolerance: 5
      });
      if (!/^[a-zA-Z0-9_-]{8,128}$/.test(payload.sub || "")) return {status: 401};
      return {status: 200, userId: payload.sub};
    } catch { return {status: 401}; }
  };
}

export function createOwnerVerifier(options) {
  const identity = createIdentityVerifier(options);
  return async (request) => {
    const result = await identity(request);
    if (result.status !== 200) return result;
    // Resolve ownership only after signature verification; email never grants access.
    const owner = options.resolveOwnerUserId ? await options.resolveOwnerUserId() : options.ownerUserId;
    return owner && result.userId === owner ? result : {status: 403};
  };
}
