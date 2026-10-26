export function stockImageUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol === "https:" && !u.username && !u.password && !u.port && u.href.length <= 2048 &&
      (["m.media-amazon.com", "images-na.ssl-images-amazon.com", "images-fe.ssl-images-amazon.com"].includes(u.hostname) || u.hostname.endsWith(".yimg.jp"))) return u.href;
  } catch {}
  return "";
}
