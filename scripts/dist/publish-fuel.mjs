// scripts/publish-fuel.ts
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// scripts/snapshot-store.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// src/garbage/store.ts
var filename = (key) => `${key.replaceAll(":", "_")}.json`;

// scripts/snapshot-store.ts
function directoryStore(dir) {
  return { async get(key) {
    try {
      return await readFile(join(dir, filename(key)), "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }, async put(key, value) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename(key)), value);
  } };
}
function kvStore(env) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${env.KV_NAMESPACE_ID}/values/`;
  const request = (key, init = {}, query = "") => fetch(base + encodeURIComponent(key) + query, { ...init, headers: { Authorization: `Bearer ${env.CLOUDFLARE_KV_WRITE_TOKEN}` }, redirect: "manual", signal: AbortSignal.timeout(3e4) });
  return { async get(key) {
    const r = await request(key);
    if (r.status === 404) return null;
    if (r.status !== 200) throw Error(`kv read failed HTTP ${r.status}`);
    return r.text();
  }, async put(key, value, updatedAt, ttlSeconds) {
    const body = new FormData();
    body.set("value", value);
    body.set("metadata", JSON.stringify({ updatedAt }));
    const r = await request(key, { method: "PUT", body }, ttlSeconds === void 0 ? "" : `?expiration_ttl=${ttlSeconds}`);
    const data = await r.json().catch(() => null);
    if (r.status !== 200 || data?.success !== true) throw Error(`kv put failed HTTP ${r.status}`);
  } };
}

// src/core/fuel/model.ts
var fuelKey = "fuel:cpc:v1";
var validDay2 = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
var validTime = (s) => typeof s === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s) && validDay2(s.slice(0, 10)) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().replace(".000Z", "Z") === s.replace(".000Z", "Z");
var fields = ["category", "product", "customer", "place", "unit"];
var requiredRetailProducts = ["98\u7121\u925B\u6C7D\u6CB9", "95\u7121\u925B\u6C7D\u6CB9", "92\u7121\u925B\u6C7D\u6CB9", "\u8D85\u7D1A\u67F4\u6CB9"];
function validItems(items) {
  return Array.isArray(items) && items.every((i) => i && typeof i === "object" && Object.keys(i).sort().join() === [...fields, "price", "effective"].sort().join() && fields.every((k) => typeof i[k] === "string" && i[k].trim() === i[k] && i[k].length > 0) && typeof i.price === "number" && Number.isFinite(i.price) && i.price > 0 && validDay2(i.effective)) && requiredRetailProducts.every((product) => items.some((i) => i.category === "\u6C7D\u67F4\u6CB9\u96F6\u552E" && i.place === "\u4E2D\u6CB9\u81EA\u71DF\u7AD9" && i.product === product));
}
function decodeFuel(raw) {
  try {
    const s = typeof raw === "string" ? JSON.parse(raw) : raw;
    return s && Object.keys(s).sort().join() === "changedAt,checkedAt,items,v" && s.v === 1 && validItems(s.items) && validTime(s.changedAt) && validTime(s.checkedAt) ? s : null;
  } catch {
    return null;
  }
}

// src/core/fuel/parse.ts
function parseFuel(body) {
  const invalid = () => new Error("\u4E2D\u6CB9\u724C\u50F9\u8CC7\u6599\u683C\u5F0F\u4E0D\u6B63\u78BA\u6216\u4E2D\u6CB9\u81EA\u71DF\u7AD9\u5FC5\u8981\u6C7D\u67F4\u6CB9\u7522\u54C1\u4E0D\u5B8C\u6574");
  if (!Array.isArray(body)) throw invalid();
  const items = body.map((row) => {
    if (!row || typeof row !== "object") throw invalid();
    const text = (key) => typeof row[key] === "string" ? row[key].trim() : "";
    const roc = text("\u724C\u50F9\u751F\u6548\u65E5\u671F");
    if (!/^\d{7}$/.test(roc) || Number(roc.slice(0, 3)) === 0) throw invalid();
    const effective = `${Number(roc.slice(0, 3)) + 1911}-${roc.slice(3, 5)}-${roc.slice(5, 7)}`;
    if (!validDay2(effective)) throw invalid();
    return { category: text("\u578B\u5225\u540D\u7A31"), product: text("\u7522\u54C1\u540D\u7A31"), customer: text("\u92B7\u552E\u5C0D\u8C61"), place: text("\u4EA4\u8CA8\u5730\u9EDE"), unit: text("\u8A08\u50F9\u55AE\u4F4D").replace(/\s*\/\s*/g, "/"), price: row["\u53C3\u8003\u724C\u50F9_\u91D1\u984D"], effective };
  });
  if (!validItems(items)) throw invalid();
  return items;
}

// src/core/fuel/source.ts
var fuelUrl = "https://vipmbr.cpc.com.tw/opendata/mainprodlistprice";
var fuelSource = `\u8CC7\u6599\u4F86\u6E90\uFF1A\u53F0\u7063\u4E2D\u6CB9 openData \u4E3B\u8981\u7522\u54C1\u724C\u50F9 ${fuelUrl} \uFF08\u653F\u5E9C\u8CC7\u6599\u958B\u653E\u6388\u6B0A\u689D\u6B3E\u7B2C1\u7248\uFF09`;
var fuelFailureSource = `\u8CC7\u6599\u4F86\u6E90\uFF1A\u53F0\u7063\u4E2D\u6CB9 openData ${fuelUrl}`;
async function fetchFuel() {
  const r = await fetch(fuelUrl, { redirect: "follow", signal: AbortSignal.timeout(15e3) });
  if (!r.ok) throw Error(`HTTP ${r.status}`);
  return r.json();
}
function fuelReason(e) {
  if (e instanceof Error && /^HTTP \d{3}$/.test(e.message)) return e.message;
  if (e instanceof Error && /Timeout|Abort/.test(e.name)) return "\u9023\u7DDA\u903E\u6642";
  return e instanceof Error && e.message.startsWith("\u4E2D\u6CB9\u724C\u50F9\u8CC7\u6599") ? "\u8CC7\u6599\u683C\u5F0F\u4E0D\u6B63\u78BA" : "\u4F86\u6E90\u66AB\u6642\u7121\u6CD5\u4F7F\u7528";
}

// scripts/publish-fuel.ts
async function publishFuel(options) {
  const fetcher = options.fetchFuel ?? fetchFuel, sleep = options.sleep ?? ((ms) => new Promise((resolve2) => setTimeout(resolve2, ms)));
  let body;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      body = await fetcher();
      break;
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep((attempt + 1) * 1e3);
    }
  }
  const items = parseFuel(body), time = (options.now ?? (() => /* @__PURE__ */ new Date()))().toISOString();
  const raw = await options.store.get(fuelKey);
  let previous = decodeFuel(raw), invalidCheck = false;
  if (!previous && raw) {
    try {
      const old = JSON.parse(raw);
      if (!validTime(old.checkedAt)) {
        previous = decodeFuel({ ...old, checkedAt: time });
        invalidCheck = true;
      }
    } catch {
    }
  }
  const changed = !previous || JSON.stringify(items) !== JSON.stringify(previous.items);
  const heartbeat = !changed && (invalidCheck || Date.parse(time) - Date.parse(previous.checkedAt) >= 20 * 36e5);
  const payload = { v: 1, items, changedAt: changed ? time : previous.changedAt, checkedAt: changed || heartbeat ? time : previous.checkedAt };
  const decision = changed ? "changed" : heartbeat ? "heartbeat" : "skip";
  let writes = 0;
  if (options.dryRun) {
    (options.log ?? console.log)(decision === "skip" ? "skip" : `would write (${decision})`);
    (options.log ?? console.log)(JSON.stringify(payload));
  } else if (decision !== "skip") {
    await options.store.put(fuelKey, JSON.stringify(payload), time);
    writes = 1;
  }
  return { writes, decision, payload };
}
async function main(args = process.argv.slice(2), env = process.env, overrides = {}) {
  let dryRun = false, out;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run" && !dryRun) dryRun = true;
    else if (args[i] === "--out" && !out && args[i + 1]?.trim() && !args[i + 1].startsWith("--")) out = args[++i];
    else {
      console.error("Usage: publish-fuel [--dry-run] [--out dir]");
      return 2;
    }
  }
  if (!dryRun && !out && ["CLOUDFLARE_ACCOUNT_ID", "KV_NAMESPACE_ID", "CLOUDFLARE_KV_WRITE_TOKEN"].some((k) => !env[k]?.trim())) {
    console.error("fuel KV configuration missing");
    return 2;
  }
  const store = out ? directoryStore(out) : dryRun ? { get: async () => null, put: async () => {
    throw Error("dry-run must never write");
  } } : kvStore(env);
  try {
    const result = await publishFuel({ ...overrides, store: overrides.store ?? store, dryRun });
    console.log(`fuel KV writes=${result.writes}`);
    return 0;
  } catch (e) {
    console.warn(`::warning::fuel collection failed: ${fuelReason(e)}`);
    console.log("fuel KV writes=0");
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
export {
  main,
  publishFuel
};
