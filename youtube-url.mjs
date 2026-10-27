export function videoUrl(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
  const host = parsed.hostname.toLowerCase();
  let id;
  if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
    if (parsed.pathname === "/watch") id = parsed.searchParams.get("v");
    else id = /^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(parsed.pathname)?.[1];
  } else if (["youtu.be", "www.youtu.be"].includes(host)) {
    id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(parsed.pathname)?.[1];
  }
  return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? `https://www.youtube.com/watch?v=${id}` : null;
}
