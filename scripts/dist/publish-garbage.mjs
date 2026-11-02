// scripts/publish-garbage.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// src/core/garbage/normalize.ts
var str = (value) => String(value ?? "").trim();
function time(value) {
  const s = str(value).replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 65296));
  const m = /^(\d{1,2}):?(\d{2})$/.exec(s);
  if (!m || +m[1] > 23 || +m[2] > 59) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}
function parseCsv(input) {
  input = input.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new Error("Invalid CSV: unclosed quote");
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows.shift() ?? [];
  return rows.filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(headers.map((h, i) => [h.trim(), r[i] ?? ""])));
}
var weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
function flags(row, prefix) {
  return weekdays.reduce((mask, day, i) => mask | (str(row[prefix + day]).toUpperCase() === "Y" ? 1 << i : 0), 0);
}
function dayText(value) {
  const s = str(value);
  if (s.includes("\u7121\u6E05\u904B")) return 0;
  return [...s].reduce((mask, c) => {
    const i = "\u65E5\u4E00\u4E8C\u4E09\u56DB\u4E94\u516D".indexOf(c === "\u5929" ? "\u65E5" : c);
    return i < 0 ? mask : mask | 1 << i;
  }, 0);
}
function one(days, start, end = "") {
  return days && start ? [{ days, start, end }] : [];
}
function daily(row, prefix) {
  const result = [];
  for (let d = 1; d <= 7; d++) {
    const start = time(row[`${prefix}_d${d}_time_s`]);
    if (!start) continue;
    const end = time(row[`${prefix}_d${d}_time_e`]);
    const slot = result.find((s) => s.start === start && s.end === end);
    if (slot) slot.days |= 1 << d % 7;
    else result.push({ days: 1 << d % 7, start, end });
  }
  return result;
}
function normalize(city, input, capturedAt) {
  const parsed = city === "ntpc" || city === "taipei" ? parseCsv(input) : JSON.parse(input);
  const rows = Array.isArray(parsed) ? parsed : parsed?.data;
  if (!Array.isArray(rows)) throw new Error("Invalid source data");
  const output = [];
  for (const item of rows) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item;
    let stop;
    if (city === "ntpc") {
      const start = time(r.time);
      stop = { district: str(r.city), village: str(r.village), route: str(r.linename), name: str(r.name), garbage: one(flags(r, "garbage"), start), recycling: one(flags(r, "recycling"), start), food: one(flags(r, "foodscraps"), start), ...str(r.memo) && str(r.memo) !== "-" ? { note: str(r.memo) } : {} };
    } else if (city === "taipei") {
      const start = time(r["\u62B5\u9054\u6642\u9593"]), end = time(r["\u96E2\u958B\u6642\u9593"]);
      const recyclingDays = /每週([一二三四五六日](?:[,、]?[一二三四五六日])*)回收/.exec(str(r["\u5730\u9EDE"]));
      const recyclingOnly = str(r["\u5730\u9EDE"]).includes("\u56DE\u6536\u8ECA");
      stop = { district: str(r["\u884C\u653F\u5340"]), village: str(r["\u91CC\u5225"]), route: `${str(r["\u8DEF\u7DDA"])} ${str(r["\u8ECA\u6B21"])}`.trim(), name: str(r["\u5730\u9EDE"]), garbage: recyclingOnly ? [] : one(118, start, end), recycling: one(recyclingDays ? dayText(recyclingDays[1]) : 118, start, end), food: recyclingOnly ? [] : one(118, start, end), ...recyclingOnly ? { note: "\u50C5\u8CC7\u6E90\u56DE\u6536\u8ECA\u6536\u904B" } : {} };
    } else {
      if (str(r.task_type) === "\u5F80\u5EE0") continue;
      stop = { district: str(r.area), village: str(r.village), route: str(r.car_licence), name: str(r.caption), garbage: daily(r, "g"), recycling: daily(r, "r"), food: [] };
    }
    if (!stop.district || !stop.name || ![...stop.garbage, ...stop.recycling, ...stop.food].length) continue;
    output.push(stop);
  }
  return output;
}

// src/core/garbage/text.ts
var norm = (s) => s.trim().replaceAll("\u53F0", "\u81FA").replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 65296));

// src/core/garbage/snapshot.ts
var indexKey = "garbage:index:v2";
var shardKey = (city, gen, district) => `garbage:v2:${city}:${gen}:${district}`;
var object = (x) => !!x && typeof x === "object" && !Array.isArray(x);
var timestamp = (x) => typeof x === "string" && Number.isFinite(Date.parse(x));
var count = (x) => Number.isSafeInteger(x) && x >= 0;
function decodeIndex(text) {
  const x = JSON.parse(text);
  if (!object(x) || x.v !== 2 || !timestamp(x.generatedAt) || !object(x.cities)) throw new Error("Invalid garbage index");
  for (const [city, entry] of Object.entries(x.cities)) {
    if (city === "tainan" || city === "kaohsiung") {
      delete x.cities[city];
      continue;
    }
    if (!["ntpc", "taipei", "taichung"].includes(city) || !object(entry) || (typeof entry.gen !== "string" || !/^[0-9a-z]{1,16}$/.test(entry.gen)) || !timestamp(entry.fetchedAt) || !timestamp(entry.updatedAt) || entry.writtenAt !== void 0 && !timestamp(entry.writtenAt) || !count(entry.stops) || !object(entry.districts)) throw new Error("Invalid garbage city");
    for (const [name, district] of Object.entries(entry.districts)) if (!name || !object(district) || !count(district.stops) || typeof district.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(district.sha256)) throw new Error("Invalid garbage district");
  }
  return x;
}
var validTime = (x) => typeof x === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(x);
function decodeSlot(x) {
  if (!Array.isArray(x) || x.length !== 3 || !Number.isInteger(x[0]) || x[0] < 1 || x[0] > 127 || !validTime(x[1]) || !(x[2] === "" || validTime(x[2]))) throw new Error("Invalid garbage slot");
  return { days: x[0], start: x[1], end: x[2] };
}
function decodeShard(text, district, keyword, filter) {
  const [header, ...lines] = text.split("\n");
  const x = JSON.parse(header);
  if (!object(x) || x.v !== 2) throw new Error("Invalid garbage shard");
  const needle = keyword ? norm(keyword) : "";
  const checkLine = !needle.includes('"') && !needle.includes("\\");
  const stops = [];
  let matched = 0;
  for (const line of lines) {
    if (needle) {
      if (checkLine && !norm(line).includes(needle)) continue;
      const fields = /^\["((?:[^"\\]|\\.)*)","((?:[^"\\]|\\.)*)","((?:[^"\\]|\\.)*)"/.exec(line);
      if (!fields || !fields.slice(1).some((field) => norm(field.includes("\\") ? JSON.parse(`"${field}"`) : field).includes(needle))) continue;
      matched++;
      if (matched > 1e3) return { v: 2, stops, truncated: true, matched };
    }
    const s = JSON.parse(line);
    if (!Array.isArray(s) || s.length < 6 || s.length > 7 || typeof s[0] !== "string" || typeof s[1] !== "string" || typeof s[2] !== "string" || !s[2] || s[6] !== void 0 && typeof s[6] !== "string" || !Array.isArray(s[3]) || !Array.isArray(s[4]) || !Array.isArray(s[5])) throw new Error("Invalid garbage stop");
    const stop = { district, village: s[0], route: s[1], name: s[2], garbage: s[3].map(decodeSlot), recycling: s[4].map(decodeSlot), food: s[5].map(decodeSlot), ...s[6] === void 0 ? {} : { note: s[6] } };
    if (filter && ![...stop.garbage, ...stop.recycling, ...stop.food].some(filter)) continue;
    if (needle && stops.length === 200) return { v: 2, stops, truncated: true, matched };
    stops.push(stop);
  }
  return { v: 2, stops, ...needle ? { matched } : {} };
}
function encodeIndex(index) {
  const s = JSON.stringify(index);
  decodeIndex(s);
  return s;
}
function encodeShard(shard) {
  const slots = (items) => items.map((s) => [s.days, s.start, s.end]);
  const stops = shard.stops.map((s) => s.note === void 0 ? [s.village, s.route, s.name, slots(s.garbage), slots(s.recycling), slots(s.food)] : [s.village, s.route, s.name, slots(s.garbage), slots(s.recycling), slots(s.food), s.note]);
  const text = [JSON.stringify({ v: 2 }), ...stops.map((stop) => JSON.stringify(stop))].join("\n");
  decodeShard(text, shard.stops[0]?.district ?? "");
  return text;
}

// src/core/garbage/build.ts
async function buildCity(city, input, now) {
  const stops = normalize(city, input, now), groups = /* @__PURE__ */ new Map();
  for (const stop of stops) {
    const group = groups.get(stop.district) ?? [];
    group.push(stop);
    groups.set(stop.district, group);
  }
  const shards = /* @__PURE__ */ new Map(), districts = {};
  for (const [district, group] of groups) {
    const value = encodeShard({ v: 2, stops: group });
    shards.set(district, value);
    districts[district] = { stops: group.length, sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (b) => b.toString(16).padStart(2, "0")).join("") };
  }
  const date = now.toISOString();
  return { entry: { gen: now.getTime().toString(36), fetchedAt: date, updatedAt: date, stops: stops.length, districts }, shards };
}

// src/garbage/source.ts
var urls = {
  ntpc: "https://data.ntpc.gov.tw/api/datasets/edc3ad26-8ae7-4916-a00b-bc6048d19bf8/csv/file",
  taipei: "https://data.taipei/api/dataset/6bb3304b-4f46-4bb0-8cd1-60c66dcd1cae/resource/a6e90031-7ec4-4089-afb5-361a4efe7202/download",
  taichung: "https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=68d1a87f-7baa-4b50-8408-c36a3a7eda68"
};
async function fetchSource(city) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9e4);
  try {
    const response = await fetch(urls[city], { signal: controller.signal, redirect: "follow", headers: { "User-Agent": "formosa-mcp garbage collector (+https://github.com/ycsmiley/formosa-mcp)" } });
    if (!response.ok || !response.body) throw new Error("source unavailable");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 32 * 1024 * 1024) {
        controller.abort();
        throw new Error("source too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
  } finally {
    clearTimeout(timer);
  }
}

// src/garbage/store.ts
var filename = (key) => `${key.replaceAll(":", "_")}.json`;

// scripts/publish-garbage.ts
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
var minimum = { ntpc: 1e4, taipei: 2e3, taichung: 8e3 };
async function collectGarbage(store, options = {}) {
  const reason = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    return (options.token ? message.replaceAll(options.token, "[redacted]") : message).replace(/\s+/g, " ").slice(0, 200);
  };
  const cities = options.cities ?? Object.keys(urls);
  let index;
  try {
    const old = await store.get(indexKey);
    index = old ? decodeIndex(old) : { v: 2, generatedAt: (/* @__PURE__ */ new Date()).toISOString(), cities: {} };
  } catch (error) {
    console.error(`garbage index read failed: ${reason(error)}`);
    return 1;
  }
  let failed = false, dirty = false;
  for (let i = 0; i < cities.length; i++) {
    if (i) await (options.delay ?? (() => new Promise((r) => setTimeout(r, 2e3))))();
    const city = cities[i];
    try {
      const input = await (options.fetch ?? fetchSource)(city);
      const now = (options.now ?? (() => /* @__PURE__ */ new Date()))();
      const data = await buildCity(city, input, now);
      const previous = index.cities[city];
      if (data.entry.stops < (options.minimum ?? minimum)[city]) throw Error("minimum guard");
      const changed = Object.keys(data.entry.districts).length !== Object.keys(previous?.districts ?? {}).length || Object.entries(data.entry.districts).some(([d, v]) => previous?.districts[d]?.sha256 !== v.sha256);
      data.entry.updatedAt = changed ? now.toISOString() : previous.updatedAt;
      if (!changed) data.entry.gen = previous.gen;
      else if (data.entry.gen === previous?.gen) data.entry.gen = (now.getTime() + 1).toString(36);
      const writtenAt = previous?.writtenAt ?? previous?.fetchedAt;
      const renew = !changed && (!writtenAt || now.getTime() - Date.parse(writtenAt) > 7 * 864e5);
      let wrote = false;
      for (const [district, value] of data.shards) {
        const key = shardKey(city, data.entry.gen, district);
        if (!changed && !renew && await store.get(key) === value) continue;
        await store.put(key, value, data.entry.updatedAt, 1209600);
        wrote = true;
      }
      if (changed || wrote || renew) {
        data.entry.writtenAt = changed || renew ? now.toISOString() : writtenAt;
        index.cities[city] = data.entry;
        dirty = true;
      }
    } catch (error) {
      failed = true;
      console.error(`garbage ${city} failed: ${reason(error)}`);
    }
  }
  try {
    if (dirty) {
      index.generatedAt = (options.now ?? (() => /* @__PURE__ */ new Date()))().toISOString();
      await store.put(indexKey, encodeIndex(index), index.generatedAt);
    }
  } catch (error) {
    console.error(`garbage index write failed: ${reason(error)}`);
    failed = true;
  }
  return failed ? 1 : 0;
}
async function main(args = process.argv.slice(2), env = process.env) {
  let dir, cities;
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!value || !["--out", "--city"].includes(args[i]) || args[i] === "--city" && value.split(",").some((c) => !Object.hasOwn(urls, c))) {
      console.error("Usage: publish-garbage [--out dir] [--city codes]");
      return 2;
    }
    if (args[i] === "--out") dir = value;
    else cities = value.split(",");
  }
  if (!dir && ["CLOUDFLARE_ACCOUNT_ID", "KV_NAMESPACE_ID", "CLOUDFLARE_KV_WRITE_TOKEN"].some((k) => !env[k]?.trim())) {
    console.error("garbage KV configuration missing");
    return 2;
  }
  return collectGarbage(dir ? directoryStore(dir) : kvStore(env), { cities, token: env.CLOUDFLARE_KV_WRITE_TOKEN });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
export {
  collectGarbage,
  directoryStore,
  kvStore,
  main
};
