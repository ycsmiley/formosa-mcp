// scripts/publish-outages.ts
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// src/core/garbage/text.ts
var norm = (s) => s.trim().replaceAll("\u53F0", "\u81FA").replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 65296));

// src/garbage/store.ts
var filename = (key) => `${key.replaceAll(":", "_")}.json`;

// src/core/outage/build.ts
function buildShards(items) {
  const counties2 = /* @__PURE__ */ new Map();
  for (const item of items) {
    const rows = counties2.get(item.c) ?? [];
    rows.push(item);
    counties2.set(item.c, rows);
  }
  return new Map([...counties2].sort(([a], [b]) => a.localeCompare(b)).map(([c, rows]) => [c, JSON.stringify(rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))]));
}

// src/core/outage/model.ts
var sources = ["taiwater", "taipeiwater", "taipower"];
var indexKey2 = "outage:index:v1";
var shardKey2 = (source, county) => `outage:v1:${source}:${county}`;
var official = {
  taiwater: { name: "\u53F0\u6C34", url: "https://web.water.gov.tw/wateroff/" },
  taipeiwater: { name: "\u5317\u6C34", url: "https://web.water.gov.taipei/" },
  taipower: { name: "\u53F0\u96FB", url: "https://www.taipower.com.tw/" }
};
var object = (x) => !!x && typeof x === "object" && !Array.isArray(x);
var timestamp = (x) => typeof x === "string" && Number.isFinite(Date.parse(x));
function decodeIndex2(raw) {
  const x = JSON.parse(raw);
  if (!object(x) || x.v !== 1 || !timestamp(x.generatedAt) || !object(x.sources)) throw Error("\u516C\u544A\u7D22\u5F15\u683C\u5F0F\u932F\u8AA4");
  for (const [s, v] of Object.entries(x.sources)) {
    if (!sources.includes(s) || !object(v) || typeof v.ok !== "boolean" || !object(v.counties) || v.reason !== void 0 && typeof v.reason !== "string" || [v.fetchedAt, v.lastSuccessAt].some((t) => t !== void 0 && !timestamp(t))) throw Error("\u516C\u544A\u4F86\u6E90\u683C\u5F0F\u932F\u8AA4");
    for (const [c, shard] of Object.entries(v.counties)) if (!c || !object(shard) || !/^[a-f0-9]{64}$/.test(shard.sha) || !Number.isSafeInteger(shard.count) || shard.count < 0) throw Error("\u516C\u544A\u7E23\u5E02\u683C\u5F0F\u932F\u8AA4");
  }
  return x;
}

// src/core/outage/time.ts
var local = (date) => new Date(date.getTime() + 8 * 36e5).toISOString().slice(0, 16);
var addDays = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
function validDay(s) {
  return /^\d{4}-\d\d-\d\d$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
}
function parseDate(text) {
  const s = norm(text);
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/i.test(s)) {
    const d = new Date(s);
    return validDay(s.slice(0, 10)) && Number.isFinite(d.getTime()) ? local(d) : null;
  }
  const m = /^(\d{2,4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  const year = +m[1] + (m[1].length < 4 ? 1911 : 0), day = `${year}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  if (!validDay(day) || +(m[4] ?? 0) > 23 || +(m[5] ?? 0) > 59 || +(m[6] ?? 0) > 59) return null;
  return `${day}T${(m[4] ?? "00").padStart(2, "0")}:${m[5] ?? "00"}`;
}
function waterTimes(start, end) {
  const a = parseDate(start), b = parseDate(end);
  return a && b && a <= b ? [[a, b]] : `${start || "\u672A\u6A19\u793A\u958B\u59CB\u6642\u9593"}\uFF5E${end || "\u672A\u6A19\u793A\u6062\u5FA9\u6642\u9593"}`;
}
function powerWindow(raw) {
  const [start, end, extra] = norm(raw).split(/[~～]/);
  if (!end || extra !== void 0) return null;
  const a = parseDate(start.trim());
  if (!a) return null;
  let b = parseDate(/^\d{1,2}:\d\d$/.test(end.trim()) ? `${a.slice(0, 10)} ${end.trim()}` : end.trim());
  if (!b) return null;
  if (b < a && /^\d{1,2}:\d\d$/.test(end.trim())) b = `${addDays(b.slice(0, 10), 1)}${b.slice(10)}`;
  return b >= a ? [a, b] : null;
}
function dailyTimes(date, time) {
  const days = norm(date).split(/[~～]/), a = parseDate(days[0]), b = parseDate(days[1] ?? days[0]);
  const raw = `${date} ${time}`.trim() || "\u672A\u6A19\u793A\u6642\u9593";
  if (days.length > 2 || !a || !b || b < a || (Date.parse(b) - Date.parse(a)) / 864e5 > 366 || !/^\d{1,2}:\d\d\s*[~～]\s*\d{1,2}:\d\d$/.test(norm(time))) return raw;
  const ranges = [];
  for (let day = a.slice(0, 10); day <= b.slice(0, 10); day = addDays(day, 1)) {
    const t = powerWindow(`${day} ${time}`);
    if (!t) return raw;
    ranges.push(t);
  }
  return ranges;
}

// src/core/outage/normalize.ts
var counties = ["\u81FA\u5317\u5E02", "\u65B0\u5317\u5E02", "\u6843\u5712\u5E02", "\u81FA\u4E2D\u5E02", "\u81FA\u5357\u5E02", "\u9AD8\u96C4\u5E02", "\u57FA\u9686\u5E02", "\u65B0\u7AF9\u5E02", "\u5609\u7FA9\u5E02", "\u65B0\u7AF9\u7E23", "\u82D7\u6817\u7E23", "\u5F70\u5316\u7E23", "\u5357\u6295\u7E23", "\u96F2\u6797\u7E23", "\u5609\u7FA9\u7E23", "\u5C4F\u6771\u7E23", "\u5B9C\u862D\u7E23", "\u82B1\u84EE\u7E23", "\u81FA\u6771\u7E23", "\u6F8E\u6E56\u7E23", "\u91D1\u9580\u7E23", "\u9023\u6C5F\u7E23"];
var clean = (s) => typeof s === "string" || typeof s === "number" ? String(s).trim() : "";
var canonical = (s) => norm(s).replaceAll("\u6843\u5712\u7E23", "\u6843\u5712\u5E02");
var countyPattern = counties.join("|");
function locations(text) {
  const result = [];
  let c = "";
  for (const m of canonical(text).matchAll(new RegExp(`(${countyPattern})|([\\u4e00-\\u9fff]{1,3}?[\u5340\u9109\u93AE\u5E02])`, "g"))) {
    if (m[1]) {
      c = m[1];
      result.push({ c, d: "" });
    } else if (c) {
      const previous = result[result.length - 1];
      if (previous.c === c && !previous.d) previous.d = m[2];
      else result.push({ c, d: m[2] });
    }
  }
  return result.filter((v, i, all) => all.findIndex((x) => x.c === v.c && x.d === v.d) === i);
}
var records = (input) => {
  if (!Array.isArray(input) || input.some((x) => !x || typeof x !== "object" || Array.isArray(x))) throw Error("\u5B98\u65B9\u958B\u653E\u8CC7\u6599\u683C\u5F0F\u932F\u8AA4");
  return input;
};
function taiwater(input) {
  const rows = records(input);
  if (!rows.length) throw Error("\u5B98\u65B9\u958B\u653E\u8CC7\u6599\u76EE\u524D\u56DE\u50B3\u7A7A\u6E05\u55AE");
  const items = [];
  for (const row of rows) {
    const v = (key) => clean(row[key]);
    const area = [v("\u505C\u6C34\u5730\u5340"), v("\u964D\u58D3\u5730\u5340") ? `\u964D\u58D3\uFF1A${v("\u964D\u58D3\u5730\u5340")}` : ""].filter(Boolean).join("\uFF1B");
    const explicit = canonical(v("\u5F71\u97FF\u7E23\u5E02")), cs = counties.filter((c) => explicit.includes(c));
    const fallback = locations(cs.length === 1 && !counties.some((c) => canonical(area).includes(c)) ? cs[0] + area : area);
    const ds = canonical(v("\u5F71\u97FF\u884C\u653F\u5340")).split(/[、,，/\s]+/).filter(Boolean);
    const places = cs.length ? cs.flatMap((c) => {
      let scoped = ds.filter((d) => !counties.some((other) => d.includes(other)) || d.includes(c)).map((d) => d.replace(new RegExp(countyPattern, "g"), "")).filter(Boolean);
      const linked = fallback.filter((p) => p.c === c).map((p) => p.d).filter((d) => scoped.includes(d));
      if (cs.length > 1 && linked.length) scoped = linked;
      return (scoped.length ? scoped : fallback.filter((p) => p.c === c).map((p) => p.d)).map((d) => ({ c, d })).concat(!scoped.length && !fallback.some((p) => p.c === c) ? [{ c, d: "" }] : []);
    }) : fallback;
    for (const { c, d } of places) items.push({ s: "taiwater", k: "water", c, d, t: waterTimes(v("\u6848\u4EF6\u65E5\u671F\u6642\u9593"), v("\u6062\u5FA9\u65E5\u671F\u6642\u9593")), a: area, r: v("\u505C\u6C34\u539F\u56E0") || v("\u964D\u58D3\u539F\u56E0"), n: v("\u6848\u4EF6\u7DE8\u865F"), u: official.taiwater.url, ...v("\u6848\u4EF6\u985E\u578B") ? { o: v("\u6848\u4EF6\u985E\u578B") } : {} });
  }
  if (!items.length) throw Error("\u5B98\u65B9\u958B\u653E\u8CC7\u6599\u672A\u63D0\u4F9B\u53EF\u8FA8\u8B58\u7684\u7E23\u5E02");
  return unique(items);
}
function taipeiwater(input) {
  const items = [];
  const rows = records(input);
  for (const row of rows) {
    const v = (key) => clean(row[key]);
    for (const { c, d } of locations(v("SW_Area"))) items.push({ s: "taipeiwater", k: "water", c, d, t: dailyTimes(v("Date"), v("Time")), a: v("SW_Area"), r: [v("Title"), v("Description")].filter(Boolean).join("\uFF1B"), n: v("SW_No"), u: /^https?:\/\//i.test(v("MapUrl")) ? v("MapUrl") : official.taipeiwater.url });
  }
  if (rows.length && !items.length) throw Error("\u5B98\u65B9\u958B\u653E\u8CC7\u6599\u672A\u63D0\u4F9B\u53EF\u8FA8\u8B58\u7684\u7E23\u5E02");
  return unique(items);
}
function unique(items) {
  return [...new Map(items.map((i) => [JSON.stringify(i), i])).values()];
}
function taipower(files, minimum = 100) {
  const groups = /* @__PURE__ */ new Map();
  let rows = 0, dropped = 0;
  for (const [code, text] of files) {
    const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    if (lines.shift() !== "\u71DF\u696D\u5340\u8655,\u8ACB\u6C42\u865F\u6578,\u5DE5\u4F5C\u6982\u8FF0,\u7B2C\u4E00\u6B21\u505C\u96FB\u6642\u9593,\u7B2C\u4E8C\u6B21\u505C\u96FB\u6642\u9593,\u505C\u96FB\u7BC4\u570D,\u67E5\u8A62\u96FB\u8A71(1911)") throw Error("\u53F0\u96FB CSV \u6B04\u4F4D\u683C\u5F0F\u932F\u8AA4");
    for (const line of lines) {
      if (!line.trim()) continue;
      rows++;
      const fields = line.split(",");
      if (fields.length !== 7) throw Error("\u53F0\u96FB CSV \u8CC7\u6599\u683C\u5F0F\u932F\u8AA4");
      const [office, n, r, first, second, area] = fields.map((s) => s.trim());
      const a = canonical(area);
      const c = counties.find((c2) => a.startsWith(c2));
      if (!c) {
        dropped++;
        continue;
      }
      const d = /^([\u4e00-\u9fff]{1,3}?[區鄉鎮市])/.exec(a.slice(c.length))?.[1] ?? "";
      const windows = [first, second].filter((s) => s && s !== "\u7121");
      const parsed = windows.map(powerWindow);
      const t = windows.length && parsed.every((t2) => t2 !== null) ? parsed : windows.join("\uFF1B") || "\u672A\u6A19\u793A\u6642\u9593";
      const key = JSON.stringify([n, t, c, d]);
      const found = groups.get(key);
      if (found) found.areas.add(a);
      else groups.set(key, { item: { s: "taipower", k: "power", c, d, t, a, r, n, u: `https://service.taipower.com.tw/branch/d${code.replace(/\.csv$/, "")}`, o: office }, areas: /* @__PURE__ */ new Set([a]) });
    }
  }
  if (rows < minimum || !groups.size) throw Error("\u53F0\u96FB\u958B\u653E\u8CC7\u6599\u7B46\u6578\u4E0D\u8DB3");
  return { items: [...groups.values()].map(({ item, areas }) => ({ ...item, a: [...areas].sort().join("\u3001") })), dropped, rows };
}

// src/outage/zip.ts
import { inflateRawSync } from "node:zlib";
function readZip(bytes) {
  try {
    const b = Buffer.from(bytes);
    let eocd = b.length - 22;
    for (; eocd >= Math.max(0, b.length - 65557); eocd--) if (b.readUInt32LE(eocd) === 101010256 && eocd + 22 + b.readUInt16LE(eocd + 20) === b.length) break;
    if (eocd < Math.max(0, b.length - 65557) || b.readUInt16LE(eocd + 4) || b.readUInt16LE(eocd + 6) || b.readUInt16LE(eocd + 8) !== b.readUInt16LE(eocd + 10)) throw Error();
    const count = b.readUInt16LE(eocd + 10), end = b.readUInt32LE(eocd + 16) + b.readUInt32LE(eocd + 12);
    let p = b.readUInt32LE(eocd + 16), total = 0;
    const files = /* @__PURE__ */ new Map();
    if (end !== eocd || count === 65535) throw Error();
    for (let i = 0; i < count; i++) {
      if (p + 46 > end || b.readUInt32LE(p) !== 33639248) throw Error();
      const flags = b.readUInt16LE(p + 8), method = b.readUInt16LE(p + 10), crc = b.readUInt32LE(p + 16), size = b.readUInt32LE(p + 20), length = b.readUInt32LE(p + 24), nameLength = b.readUInt16LE(p + 28), offset = b.readUInt32LE(p + 42);
      const name = b.subarray(p + 46, p + 46 + nameLength).toString("utf8");
      p += 46 + nameLength + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
      if (p > end) throw Error();
      if (!/^\d{3}\.csv$/.test(name)) continue;
      total += length;
      if (flags & 1 || ![0, 8].includes(method) || length > 32 * 1024 * 1024 || total > 64 * 1024 * 1024 || offset + 30 > end || b.readUInt32LE(offset) !== 67324752 || b.readUInt16LE(offset + 8) !== method || files.has(name)) throw Error();
      const start = offset + 30 + b.readUInt16LE(offset + 26) + b.readUInt16LE(offset + 28);
      if (start + size > b.readUInt32LE(eocd + 16)) throw Error();
      const compressed = b.subarray(start, start + size), data = method === 8 ? inflateRawSync(compressed, { maxOutputLength: Math.max(1, length) }) : compressed;
      if (data.length !== length || crc32(data) !== crc) throw Error();
      files.set(name, new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data));
    }
    if (p !== end || !files.size) throw Error();
    return files;
  } catch {
    throw Error("\u53F0\u96FB ZIP \u8CC7\u6599\u640D\u58DE\u6216\u683C\u5F0F\u4E0D\u652F\u63F4");
  }
}
function crc32(bytes) {
  let crc = 4294967295;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 3988292384 : 0);
  }
  return (crc ^ 4294967295) >>> 0;
}

// src/outage/source.ts
var urls = {
  taiwater: "https://web.water.gov.tw/wateroffapi/openData/export/json",
  taipeiwater: "https://webs.water.gov.taipei/apps/outage.asmx/outageOpenData",
  taipower: "https://service.taipower.com.tw/data/opendata/apply/file/d077004/001.zip"
};
async function fetchSource2(source) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3e4);
  try {
    const r = await fetch(urls[source], { signal: controller.signal, redirect: "follow" });
    if (!r.ok) throw Error(`\u5B98\u65B9\u958B\u653E\u8CC7\u6599 HTTP ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > 32 * 1024 * 1024) throw Error("\u5B98\u65B9\u958B\u653E\u8CC7\u6599\u6A94\u6848\u904E\u5927");
    if (source === "taipower") return taipower(readZip(bytes));
    let input;
    try {
      input = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw Error("\u5B98\u65B9\u958B\u653E\u8CC7\u6599 JSON \u683C\u5F0F\u932F\u8AA4");
    }
    const items = source === "taiwater" ? taiwater(input) : taipeiwater(input);
    return { items, dropped: 0, rows: input.length };
  } catch (e) {
    if (controller.signal.aborted) throw Error("\u5B98\u65B9\u958B\u653E\u8CC7\u6599\u9023\u7DDA\u903E\u6642");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// scripts/publish-outages.ts
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
async function collectOutages(store, options = {}) {
  const reason = (e) => (options.token ? String(e instanceof Error ? e.message : e).replaceAll(options.token, "[redacted]") : String(e instanceof Error ? e.message : e)).replace(/https?:\/\/[^\s]+/g, "[url]").replace(/\s+/g, " ").slice(0, 200);
  let previous;
  let writes = 0, failed = false;
  try {
    const raw = await store.get(indexKey2);
    previous = raw ? decodeIndex2(raw) : { v: 1, generatedAt: "", sources: {} };
  } catch (e) {
    console.error(`outage index read failed: ${reason(e)}`);
    return 1;
  }
  const results = await Promise.allSettled(sources.map((s) => (options.fetch ?? fetchSource2)(s)));
  const index = { v: 1, generatedAt: (options.now ?? (() => /* @__PURE__ */ new Date()))().toISOString(), sources: {} };
  for (const [i, source] of sources.entries()) {
    const old = previous.sources[source];
    let dropped = 0, count = 0, largest = 0;
    try {
      const result = results[i];
      if (result.status === "rejected") throw result.reason;
      const data = result.value;
      dropped = data.dropped;
      count = data.items.length;
      const shards = buildShards(data.items), counties2 = {};
      for (const [county, raw] of shards) {
        const sha = createHash("sha256").update(raw).digest("hex");
        largest = Math.max(largest, Buffer.byteLength(raw));
        counties2[county] = { sha, count: data.items.filter((item) => item.c === county).length };
        if (old?.counties[county]?.sha !== sha) {
          await store.put(shardKey2(source, county), raw, index.generatedAt);
          writes++;
        }
      }
      index.sources[source] = { ok: true, fetchedAt: index.generatedAt, lastSuccessAt: index.generatedAt, counties: counties2 };
    } catch (e) {
      failed = true;
      index.sources[source] = { ok: false, reason: reason(e), ...old?.lastSuccessAt ? { lastSuccessAt: old.lastSuccessAt } : {}, counties: old?.counties ?? {} };
      console.error(`outage ${source} failed: ${reason(e)}`);
    }
    console.log(`outage ${source} ok=${index.sources[source].ok} count=${count} largestBytes=${largest} dropped=${dropped}`);
  }
  try {
    await store.put(indexKey2, JSON.stringify(index), index.generatedAt);
    writes++;
  } catch (e) {
    console.error(`outage index write failed: ${reason(e)}`);
    failed = true;
  }
  console.log(`outage KV writes=${writes}`);
  return failed ? 1 : 0;
}
async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length && (args.length !== 2 || args[0] !== "--out" || !args[1]?.trim())) {
    console.error("Usage: publish-outages [--out dir]");
    return 2;
  }
  const dir = args[1];
  if (!dir && ["CLOUDFLARE_ACCOUNT_ID", "KV_NAMESPACE_ID", "CLOUDFLARE_KV_WRITE_TOKEN"].some((k) => !env[k]?.trim())) {
    console.error("outage KV configuration missing");
    return 2;
  }
  return collectOutages(dir ? directoryStore(dir) : kvStore(env), { token: env.CLOUDFLARE_KV_WRITE_TOKEN });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
export {
  collectOutages,
  directoryStore,
  kvStore,
  main
};
