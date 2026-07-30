// Lightweight server-side tools that do not require another API account.
// Bing's RSS search endpoint gives structured results and is fast enough to
// run before the model request when the user enables Web in the composer.

function decodeXml(value) {
  return String(value || "")
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function field(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i"));
  return decodeXml(match?.[1] || "");
}

export async function searchWeb(query, { limit = 5, robloxOnly = false } = {}) {
  const clean = String(query || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!clean) return [];
  const scoped = robloxOnly
    ? `${clean} (site:create.roblox.com OR site:devforum.roblox.com)`
    : clean;
  const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(scoped)}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Spider-Roblox-Builder/2.1" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`search HTTP ${response.status}`);
  const xml = await response.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, Math.max(1, Math.min(8, limit)));
  return items.map((match) => ({
    title: field(match[1], "title"),
    url: field(match[1], "link"),
    snippet: field(match[1], "description").slice(0, 500),
  })).filter((item) => item.title && item.url);
}

export function formatSearchResults(results) {
  if (!Array.isArray(results) || results.length === 0) return "(no search results)";
  return results.map((item, index) =>
    `${index + 1}. ${item.title}\nURL: ${item.url}\n${item.snippet}`
  ).join("\n\n");
}
