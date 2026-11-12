// Yanju alternatives server, single file for pasting into the Cloudflare dashboard.
// Needs: a KV binding named ALT_KV (recommended) and a secret named APISH_KEY.
// ===== core.js =====
// Pure helpers: turning raw AlternativeTo data into simple, safe recommendations.
// No network and no storage in this file, so it is easy to test.

const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// AlternativeTo "features" that describe qualities (ad-free, dark mode...) and not what a product does.
// These are never used to decide what the original subscription is.
const PROPERTY_SLUGS = new Set([
  "ad-free", "ai-powered", "no-coding", "night-mode", "live-preview", "privacy-focused", "no-registration",
  "lightweight", "no-tracking", "cloud-sync", "offline-access", "built-in-color-picker", "real-time-collaboration",
  "hardware-accelerated", "transition-effects", "layer-support", "non-destructive-editing", "wysiwyg-editor",
  "cloud-based", "web-based", "scalable", "themeable", "open-source", "free", "self-hosted", "multi-platform",
  "keyboard-shortcuts", "customizable", "extensible", "plugins", "api", "no-account-needed", "end-to-end-encryption"
]);

// Pick the one category that best describes what the original service does.
// AlternativeTo lists the most common category of its alternatives first, so we take the first
// entry that is a real category and covers a fair share of the alternatives.
function pickPrimaryFeature(filters, total) {
  const list = (filters && filters.feature) || [];
  const need = Math.max(6, Math.floor((total || 0) * 0.12));
  for (const f of list) {
    if (!f || !f.slug || PROPERTY_SLUGS.has(f.slug)) continue;
    return f.count >= need ? f.slug : null;
  }
  return null;
}

const WEB = new Set(["online", "software-as-a-service", "google-chrome", "firefox", "microsoft-edge", "safari", "chrome-os"]);
const ANDROID = new Set(["android", "android-tablet"]);
const IOS = new Set(["iphone", "ipad", "apple-watch"]);
const LINUX = new Set(["linux", "flatpak", "appimage", "flathub", "snap", "arch-linux"]);
const SETUP = new Set(["self-hosted", "docker-app-container", "cloudron", "wordpress", "yunohost", "truenas", "unraid", "kubernetes"]);

// Turns the long list of platforms into a few words an ordinary person understands.
function simplifyPlatforms(platforms) {
  const slugs = (platforms || []).map(p => p.slug);
  const out = [];
  if (slugs.some(s => WEB.has(s) && s !== "chrome-os")) out.push("Web");
  if (slugs.some(s => ANDROID.has(s))) out.push("Android");
  if (slugs.some(s => IOS.has(s))) out.push("iPhone");
  if (slugs.includes("windows")) out.push("Windows");
  if (slugs.includes("mac")) out.push("Mac");
  if (slugs.some(s => LINUX.has(s))) out.push("Linux");
  const hasSetup = slugs.some(s => SETUP.has(s));
  const readyToUse = out.some(p => p === "Web" || p === "Android" || p === "iPhone" || p === "Windows" || p === "Mac");
  return { list: out, selfHost: hasSetup, needsSetup: hasSetup && !readyToUse };
}

const COST = { free: "free", freemium: "freemium", paid: "paid" };
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); if (s.length <= n) return s; const cut = s.slice(0, n); return cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[,;:\-\u2013]$/, "") + "\u2026"; };
function firstSentence(s, n = 140) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  const m = s.match(/^.{25,}?[.!](?=\s|$)/);
  return clip(m && m[0].length <= n + 40 ? m[0] : s, n);
}

// One raw AlternativeTo item -> the small, consistent shape the app uses.
function normalizeItem(it, primary) {
  const pf = simplifyPlatforms(it.platforms);
  const cost = COST[norm(it.license_cost)] || "unknown";
  const cats = (it.categories || []).map(c => c.slug);
  const hl = (it.highlights || []).map(h => h.name).filter(Boolean);
  return {
    slug: it.slug,
    name: String(it.name || "").trim(),
    blurb: firstSentence(it.description),
    category: (it.categories && it.categories[0] && it.categories[0].name) || "",
    cost,
    openSource: norm(it.license_model) === "open source",
    license: it.license && it.license.name ? it.license.name : null,
    platforms: pf.list,
    needsSetup: pf.needsSetup,
    selfHost: pf.selfHost,
    country: it.company && it.company.country ? it.company.country : null,
    highlights: hl.slice(0, 2),
    _likes: Number(it.likes) || 0,
    _match: primary ? cats.includes(primary) : false
  };
}

// Keep real, usable consumer products. Never recommend the same product twice or the original itself.
function filterItems(items, original) {
  const orig = norm(original);
  const seen = new Set();
  return items.filter(x => {
    if (!x.slug || !x.name) return false;
    const key = norm(x.name);
    if (key === orig || x.slug === orig.replace(/ /g, "-")) return false;
    if (seen.has(key) || seen.has(x.slug)) return false;
    seen.add(key); seen.add(x.slug);
    if (!x.platforms.length && !x.needsSetup) return false;   // nothing an ordinary person can open
    if (x.cost === "unknown" && !x.openSource) return false;   // we cannot say what it costs to use
    return true;
  });
}

function score(x) {
  let s = Math.log10(1 + x._likes) * 2;
  if (x._match) s += 1.5;
  if (x.cost === "free" || x.openSource) s += 0.6;
  else if (x.cost === "freemium") s += 0.4;
  if (x.needsSetup) s -= 2;
  if (x.platforms.includes("Web") || x.platforms.includes("Android") || x.platforms.includes("iPhone")) s += 0.3;
  return s;
}

function rank(items) {
  return items.slice().sort((a, b) => score(b) - score(a));
}

// Public shape: drop the internal fields.
function publicItem(x, extra) {
  const { _likes, _match, ...rest } = x;
  return Object.assign(rest, extra || {});
}

// ===== pricing.js =====
// Reads a product's own pricing page and keeps only prices it can read with confidence.
// No AI. If anything is unclear the answer is "unavailable" and the app shows "Check current pricing".
// Be polite: we identify ourselves, obey robots.txt, fetch at most two pages per product, and cache the result.

const UA = "YanjuPriceCheck/1.0 (+subscription tracker; checks public pricing pages)";

// ---- robots.txt ----------------------------------------------------------------
function robotsAllows(txt, path) {
  const groups = []; let cur = null, lastWasAgent = false;
  for (const raw of String(txt || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim(); if (!line) continue;
    const i = line.indexOf(":"); if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === "user-agent") { if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (cur && (k === "allow" || k === "disallow")) cur.rules.push([k, v]);
  }
  const mine = groups.filter(g => g.agents.some(a => a !== "*" && "yanjupricecheck".includes(a) && a.length > 3));
  const use = mine.length ? mine : groups.filter(g => g.agents.includes("*"));
  let best = null;
  for (const g of use) for (const [k, v] of g.rules) {
    if (!v) continue;
    const re = new RegExp("^" + v.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (re.test(path) && (!best || v.length > best.len || (v.length === best.len && k === "allow"))) best = { len: v.length, allow: k === "allow" };
  }
  return best ? best.allow : true;
}

// ---- reading prices ------------------------------------------------------------
const SYM = { "$": "USD", "US$": "USD", "\u20ac": "EUR", "\u00a3": "GBP", "\u20a6": "NGN", "R": "ZAR" };
const CODE = /^(USD|EUR|GBP|NGN|ZAR|KES|GHS|CAD|AUD|INR)$/;
const periodOf = s => {
  s = String(s || "").toLowerCase();
  if (/(^|\W)(mo|month|monthly|mon|p1m)(\W|$)/.test(s)) return "month";
  if (/(^|\W)(yr|year|yearly|annual|annum|ann|p1y)(\W|$)/.test(s)) return "year";
  return null;
};

function walk(node, out, depth = 0) {
  if (!node || typeof node !== "object" || depth > 12) return;
  if (Array.isArray(node)) { node.forEach(n => walk(n, out, depth + 1)); return; }
  const t = [].concat(node["@type"] || []);
  if (t.some(x => /Offer/i.test(String(x)))) {
    const p = Number(node.price ?? node.lowPrice), c = String(node.priceCurrency || "").toUpperCase();
    const ps = node.priceSpecification || {};
    const per = periodOf(ps.billingDuration || ps.unitCode || ps.referenceQuantity && ps.referenceQuantity.unitCode || node.billingDuration);
    if (isFinite(p) && p > 0 && CODE.test(c)) out.push({ name: node.name ? String(node.name).slice(0, 40) : null, amount: p, currency: c, period: per, ambiguous: false, how: "structured" });
  }
  for (const v of Object.values(node)) walk(v, out, depth + 1);
}

function extractPlans(html) {
  html = String(html || "").slice(0, 1500000);
  const plans = [];
  // 1) Prices the site publishes in a machine-readable block: the most reliable source.
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim()), plans); } catch (e) { /* ignore broken block */ }
  }
  // 2) Otherwise: prices written as "$12/month" in the page text, with the plan name taken from the heading above.
  if (!plans.length) {
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, " ")
      .replace(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi, (_, h) => "\n##" + h.replace(/<[^>]+>/g, " ") + "\n")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&euro;/g, "\u20ac").replace(/&pound;/g, "\u00a3").replace(/&#8358;/g, "\u20a6")
      .replace(/[ \t\r\f]+/g, " ");
    const re = /(US\$|\$|\u20ac|\u00a3|\u20a6|\b(?:USD|EUR|GBP|NGN)\b)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:\/|per|a|\/\s*per)\s*(month|mo|year|yr|annum)\b/gi;
    let m, n = 0;
    while ((m = re.exec(text)) && n++ < 40) {
      const before = text.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
      if (/\b(save|saving|was|from)\b/.test(before) && /\b(save|was)\b/.test(before)) continue; // old or discount prices
      const sym = m[1].toUpperCase(), amount = Number(m[2].replace(/,/g, ""));
      if (!isFinite(amount) || amount <= 0) continue;
      const head = text.slice(Math.max(0, m.index - 400), m.index).match(/##([^\n]{2,40})\n(?![\s\S]*##)/);
      plans.push({ name: head ? head[1].trim() : null, amount, currency: SYM[m[1]] || (CODE.test(sym) ? sym : "USD"),
        period: periodOf(m[3]), ambiguous: m[1] === "$", how: "page-text" });
    }
  }
  // Keep each distinct price once, cheapest first, at most 4.
  const seen = new Set(), out = [];
  for (const p of plans.sort((a, b) => a.amount - b.amount)) {
    const k = p.amount + p.currency + p.period;
    if (seen.has(k)) continue; seen.add(k); out.push(p);
  }
  return out.slice(0, 4);
}

// ---- fetch with a size and time limit ------------------------------------------
async function getText(url, f, ms = 6000) {
  const r = await f(url, { headers: { "user-agent": UA, accept: "text/html,*/*;q=0.5" }, redirect: "follow", signal: AbortSignal.timeout(ms) });
  if (!r.ok) return { ok: false, status: r.status };
  const type = r.headers.get("content-type") || "";
  if (type && !/text|html|json|xml/i.test(type)) return { ok: false, status: 415 };
  return { ok: true, url: r.url || url, text: (await r.text()).slice(0, 1500000) };
}

const PATHS = ["/pricing", "/plans", "/pricing/"];

// official: the product's own website address. Returns a result the app can show or ignore.
async function lookupPricing(official, f = fetch, now = new Date()) {
  const checkedAt = now.toISOString().slice(0, 10);
  let origin;
  try { const u = new URL(official); if (u.protocol !== "https:" && u.protocol !== "http:") throw 0; origin = u.origin.replace(/^http:/, "https:"); }
  catch (e) { return { status: "unavailable", pricingUrl: null, plans: [], checkedAt }; }
  const base = { status: "unavailable", pricingUrl: official, plans: [], checkedAt };
  try {
    let robots = ""; 
    try { const r = await getText(origin + "/robots.txt", f, 4000); if (r.ok) robots = r.text; } catch (e) { /* no robots file: allowed */ }
    for (const p of PATHS) {
      if (!robotsAllows(robots, p)) return Object.assign(base, { status: "blocked" });
      let page; try { page = await getText(origin + p, f); } catch (e) { continue; }
      if (!page.ok) continue;
      base.pricingUrl = page.url;
      const plans = extractPlans(page.text);
      if (plans.length) return { status: "verified", pricingUrl: page.url, plans, checkedAt, region: plans.some(x => x.currency === "NGN") ? "NG" : "international" };
      return base; // page exists but its prices cannot be read reliably
    }
  } catch (e) { /* fall through */ }
  return base;
}

// ===== index.js =====
// Yanju alternatives server (Cloudflare Worker).
// The app asks for one service by name. This server finds alternatives, filters and ranks them, checks each
// product's own pricing page, remembers the answers, and returns one simple list. Keys never leave this server.


const BASE = "https://api.api.sh";
const DAY = 86400;
const TTL = { list: 30 * DAY, fresh: 7 * DAY, soft: 7 * DAY, sw: 90 * DAY, slug: 90 * DAY, priceOk: 7 * DAY, priceNo: 2 * DAY, lock: 300 };
const PAGE_SIZE_SHOWN = 8;            // how many products per page get a price check (each costs one lookup credit)
const KNOWN_SLUGS = { canva: "canva" }; // only slugs confirmed against the real service; the rest are searched once and remembered

// ---- tiny cache: KV when available, memory otherwise ------------------------------
const mem = new Map();
const cache = env => ({
  async get(k) {
    try { if (env.ALT_KV) return await env.ALT_KV.get(k, "json"); } catch (e) { /* ignore */ }
    const m = mem.get(k); return m && m.exp > Date.now() ? m.v : null;
  },
  async put(k, v, ttl) {
    try { if (env.ALT_KV) { await env.ALT_KV.put(k, JSON.stringify(v), { expirationTtl: Math.max(60, ttl) }); return; } } catch (e) { /* ignore */ }
    mem.set(k, { v, exp: Date.now() + ttl * 1000 });
  }
});

// ---- API.SH (AlternativeTo data) ----------------------------------------------------
async function apish(env, route, params, f = fetch) {
  if (!env.APISH_KEY) throw Object.assign(new Error("not configured"), { code: "no_key" });
  const u = new URL(BASE + route);
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== "") u.searchParams.set(k, v);
  const r = await f(u, { headers: { "x-api-key": env.APISH_KEY, accept: "application/json" }, signal: AbortSignal.timeout(28000) });
  if (r.status === 402 || r.status === 429) throw Object.assign(new Error("limit"), { code: "limit" });
  if (!r.ok) throw Object.assign(new Error("upstream " + r.status), { code: "upstream" });
  const body = await r.json();
  // Some responses wrap the data in an envelope; the app only needs the data itself.
  return body && body.data && body.status !== undefined && body.request_id !== undefined ? body.data : body;
}

async function resolveSlug(env, c, name, f) {
  const n = norm(name);
  if (KNOWN_SLUGS[n]) return { slug: KNOWN_SLUGS[n], name };
  const hit = await c.get("slug:" + n);
  if (hit) return hit.slug ? hit : null;
  const res = await apish(env, "/alternativeto/v1/search", { q: name }, f);
  const items = (res && res.items) || [];
  const pick = items.find(i => norm(i.name) === n) || items.find(i => norm(i.name).startsWith(n)) || null;
  const out = pick ? { slug: pick.slug, name: pick.name } : { slug: null };
  await c.put("slug:" + n, out, TTL.slug);
  return pick ? out : null;
}

// One page of ranked alternatives for one original service (cached; 2 lookups the first time).
async function getList(env, c, slug, name, page, f) {
  const key = `list:v1:${slug}:${page}`;
  const hit = await c.get(key), now = Date.now();
  if (hit && now - hit.at < TTL.soft * 1000) return { ...hit, stale: false };
  try {
    let res, primary = null;
    if (page === 1) {
      const first = await apish(env, "/alternativeto/v1/alternatives", { slug, sort: "likes" }, f);
      res = first;
      const want = pickPrimaryFeature(first.filters, first.total);
      if (want) {
        try {
          const focused = await apish(env, "/alternativeto/v1/alternatives", { slug, sort: "likes", feature: want }, f);
          if (focused && focused.items && focused.items.length) { res = focused; primary = want; }
        } catch (e) { /* keep the unfiltered list */ }
      }
    } else {
      const p1 = await c.get(`list:v1:${slug}:1`);
      primary = (p1 && p1.primary) || null;
      res = await apish(env, "/alternativeto/v1/alternatives", { slug, sort: "likes", feature: primary || undefined, page }, f);
    }
    const items = rank(filterItems((res.items || []).map(i => normalizeItem(i, primary)), name));
    const entry = { at: now, primary, total: res.total || 0, hasMore: !!res.next_page, items };
    await c.put(key, entry, TTL.list);
    return { ...entry, stale: false };
  } catch (e) {
    if (hit) return { ...hit, stale: true };   // the data source is down: show what we remembered
    throw e;
  }
}

// ---- prices -----------------------------------------------------------------------
async function priceFor(env, c, slug, f, now) {
  const hit = await c.get("price:" + slug);
  if (hit && hit.status === "pending") return hit.at && now - hit.at < TTL.lock * 1000 ? hit : null;
  return hit;
}

async function enrichOne(env, c, it, f) {
  const now = Date.now();
  await c.put("price:" + it.slug, { status: "pending", at: now }, TTL.lock);
  let result = { status: "unavailable", pricingUrl: null, plans: [], checkedAt: new Date().toISOString().slice(0, 10) };
  try {
    let sw = await c.get("sw:" + it.slug);
    if (!sw) {
      const d = await apish(env, "/alternativeto/v1/software", { slug: it.slug }, f);
      const off = ((d && d.links) || []).find(l => l && l.type === "Official");
      sw = { website: off ? off.url : (d && d.company && d.company.url) || null };
      await c.put("sw:" + it.slug, sw, TTL.sw);
    }
    if (sw.website) result = Object.assign(await lookupPricing(sw.website, f), { website: sw.website });
    else result.website = null;
  } catch (e) { result.error = e.code || "error"; }
  const ok = result.status === "verified";
  await c.put("price:" + it.slug, result, ok ? TTL.priceOk : TTL.priceNo);
  return result;
}

// ---- request handler ----------------------------------------------------------------
const json = (o, status, cors) => new Response(JSON.stringify(o), { status: status || 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors } });

function corsFor(req, env) {
  const allowed = String(env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean);
  const o = req.headers.get("origin") || "";
  const ok = allowed.includes("*") || allowed.includes(o);
  return { "access-control-allow-origin": allowed.includes("*") ? "*" : (ok ? o : allowed[0] || ""), "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "content-type", vary: "origin" };
}

async function handle(req, env, ctx, f = fetch) {
  const cors = corsFor(req, env), url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (url.pathname === "/health") return json({ ok: true }, 200, cors);
  if (url.pathname !== "/alternatives" || req.method !== "GET") return json({ ok: false, reason: "not_found" }, 404, cors);

  const service = (url.searchParams.get("service") || "").replace(/[\u0000-\u001f]/g, "").trim();
  const page = Math.min(5, Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1));
  if (service.length < 2 || service.length > 60) return json({ ok: false, reason: "bad_service" }, 400, cors);

  const c = cache(env), now = Date.now();
  try {
    const match = await resolveSlug(env, c, service, f);
    if (!match) return json({ ok: true, service, matched: null, page, hasMore: false, items: [], pricingPending: false }, 200, cors);
    const list = await getList(env, c, match.slug, match.name || service, page, f);
    const shown = list.items.slice(0, 12);
    const out = []; const toEnrich = [];
    for (const it of shown) {
      const p = await priceFor(env, c, it.slug, f, now);
      const idx = out.length;
      if (!p && idx < PAGE_SIZE_SHOWN) toEnrich.push(it);
      const price = p ? (p.status === "pending" ? { status: "pending" } : { status: p.status, plans: p.plans || [], pricingUrl: p.pricingUrl || null, checkedAt: p.checkedAt, region: p.region || null })
        : idx < PAGE_SIZE_SHOWN ? { status: "pending" } : { status: "unavailable", plans: [], pricingUrl: null };
      out.push(publicItem(it, { website: p && p.website ? p.website : null, price }));
    }
    if (toEnrich.length && ctx && ctx.waitUntil) ctx.waitUntil(Promise.allSettled(toEnrich.map(it => enrichOne(env, c, it, f))));
    else if (toEnrich.length) await Promise.allSettled(toEnrich.map(it => enrichOne(env, c, it, f)));
    return json({ ok: true, service, matched: match, page, hasMore: list.hasMore, stale: list.stale, items: out,
      pricingPending: out.some(i => i.price.status === "pending") }, 200, cors);
  } catch (e) {
    const reason = e.code === "limit" ? "busy" : e.code === "no_key" ? "not_configured" : "unavailable";
    return json({ ok: false, reason }, reason === "not_configured" ? 503 : 502, cors);
  }
}

export default { fetch: (req, env, ctx) => handle(req, env, ctx) };
