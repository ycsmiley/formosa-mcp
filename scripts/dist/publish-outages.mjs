// scripts/publish-outages.ts
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appendFile } from "node:fs/promises";

// scripts/snapshot-store.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// src/core/garbage/text.ts
var norm = (s) => s.trim().replaceAll("\u53F0", "\u81FA").replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 65296));
var stripZeroWidth = (s) => s.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");

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
var shardKey2 = (source, county, sha) => `outage:v1:${source}:${county}:${sha.slice(0, 12)}`;
var official = {
  taiwater: { name: "\u53F0\u6C34", url: "https://web.water.gov.tw/wateroff/" },
  taipeiwater: { name: "\u5317\u6C34", url: "https://web.water.gov.taipei/" },
  taipower: { name: "\u53F0\u96FB", url: "https://service.taipower.com.tw/" }
};
var object = (x) => !!x && typeof x === "object" && !Array.isArray(x);
var timestamp = (x) => typeof x === "string" && Number.isFinite(Date.parse(x));
function decodeIndex2(raw) {
  const x = JSON.parse(raw);
  if (!object(x) || x.v !== 1 || !timestamp(x.generatedAt) || !object(x.sources)) throw Error("\u516C\u544A\u7D22\u5F15\u683C\u5F0F\u932F\u8AA4");
  for (const [s, v] of Object.entries(x.sources)) {
    if (!sources.includes(s) || !object(v) || typeof v.ok !== "boolean" || !object(v.counties) || v.reason !== void 0 && typeof v.reason !== "string" || v.dropped !== void 0 && (!Number.isSafeInteger(v.dropped) || v.dropped < 0) || [v.fetchedAt, v.lastSuccessAt].some((t) => t !== void 0 && !timestamp(t))) throw Error("\u516C\u544A\u4F86\u6E90\u683C\u5F0F\u932F\u8AA4");
    if (v.droppedBy !== void 0 && (!object(v.droppedBy) || Object.entries(v.droppedBy).some(([office, count]) => !office || !Number.isSafeInteger(count) || count < 0))) throw Error("\u516C\u544A\u4F86\u6E90\u683C\u5F0F\u932F\u8AA4");
    for (const [c, shard] of Object.entries(v.counties)) if (!c || !object(shard) || !/^[a-f0-9]{64}$/.test(shard.sha) || !Number.isSafeInteger(shard.count) || shard.count < 0 || shard.writtenAt !== void 0 && !timestamp(shard.writtenAt)) throw Error("\u516C\u544A\u7E23\u5E02\u683C\u5F0F\u932F\u8AA4");
  }
  return x;
}

// src/core/outage/districts.ts
var districts = {
  \u81FA\u5317\u5E02: "\u4E2D\u6B63\u5340 \u5927\u540C\u5340 \u4E2D\u5C71\u5340 \u677E\u5C71\u5340 \u5927\u5B89\u5340 \u842C\u83EF\u5340 \u4FE1\u7FA9\u5340 \u58EB\u6797\u5340 \u5317\u6295\u5340 \u5167\u6E56\u5340 \u5357\u6E2F\u5340 \u6587\u5C71\u5340".split(" "),
  \u65B0\u5317\u5E02: "\u677F\u6A4B\u5340 \u4E09\u91CD\u5340 \u4E2D\u548C\u5340 \u6C38\u548C\u5340 \u65B0\u838A\u5340 \u65B0\u5E97\u5340 \u6A39\u6797\u5340 \u9DAF\u6B4C\u5340 \u4E09\u5CFD\u5340 \u6DE1\u6C34\u5340 \u6C50\u6B62\u5340 \u745E\u82B3\u5340 \u571F\u57CE\u5340 \u8606\u6D32\u5340 \u4E94\u80A1\u5340 \u6CF0\u5C71\u5340 \u6797\u53E3\u5340 \u6DF1\u5751\u5340 \u77F3\u7887\u5340 \u576A\u6797\u5340 \u4E09\u829D\u5340 \u77F3\u9580\u5340 \u516B\u91CC\u5340 \u5E73\u6EAA\u5340 \u96D9\u6EAA\u5340 \u8CA2\u5BEE\u5340 \u91D1\u5C71\u5340 \u842C\u91CC\u5340 \u70CF\u4F86\u5340".split(" "),
  \u6843\u5712\u5E02: "\u6843\u5712\u5340 \u4E2D\u58E2\u5340 \u5E73\u93AE\u5340 \u516B\u5FB7\u5340 \u694A\u6885\u5340 \u8606\u7AF9\u5340 \u5927\u6EAA\u5340 \u9F8D\u6F6D\u5340 \u9F9C\u5C71\u5340 \u5927\u5712\u5340 \u89C0\u97F3\u5340 \u65B0\u5C4B\u5340 \u5FA9\u8208\u5340".split(" "),
  \u81FA\u4E2D\u5E02: "\u4E2D\u5340 \u6771\u5340 \u5357\u5340 \u897F\u5340 \u5317\u5340 \u897F\u5C6F\u5340 \u5357\u5C6F\u5340 \u5317\u5C6F\u5340 \u8C50\u539F\u5340 \u6771\u52E2\u5340 \u5927\u7532\u5340 \u6E05\u6C34\u5340 \u6C99\u9E7F\u5340 \u68A7\u68F2\u5340 \u540E\u91CC\u5340 \u795E\u5CA1\u5340 \u6F6D\u5B50\u5340 \u5927\u96C5\u5340 \u65B0\u793E\u5340 \u77F3\u5CA1\u5340 \u5916\u57D4\u5340 \u5927\u5B89\u5340 \u70CF\u65E5\u5340 \u5927\u809A\u5340 \u9F8D\u4E95\u5340 \u9727\u5CF0\u5340 \u592A\u5E73\u5340 \u5927\u91CC\u5340 \u548C\u5E73\u5340".split(" "),
  \u81FA\u5357\u5E02: "\u65B0\u71DF\u5340 \u9E7D\u6C34\u5340 \u767D\u6CB3\u5340 \u67F3\u71DF\u5340 \u5F8C\u58C1\u5340 \u6771\u5C71\u5340 \u9EBB\u8C46\u5340 \u4E0B\u71DF\u5340 \u516D\u7532\u5340 \u5B98\u7530\u5340 \u5927\u5167\u5340 \u4F73\u91CC\u5340 \u5B78\u7532\u5340 \u897F\u6E2F\u5340 \u4E03\u80A1\u5340 \u5C07\u8ECD\u5340 \u5317\u9580\u5340 \u65B0\u5316\u5340 \u5584\u5316\u5340 \u65B0\u5E02\u5340 \u5B89\u5B9A\u5340 \u5C71\u4E0A\u5340 \u7389\u4E95\u5340 \u6960\u897F\u5340 \u5357\u5316\u5340 \u5DE6\u93AE\u5340 \u4EC1\u5FB7\u5340 \u6B78\u4EC1\u5340 \u95DC\u5EDF\u5340 \u9F8D\u5D0E\u5340 \u6C38\u5EB7\u5340 \u6771\u5340 \u5357\u5340 \u5317\u5340 \u5B89\u5357\u5340 \u5B89\u5E73\u5340 \u4E2D\u897F\u5340".split(" "),
  \u9AD8\u96C4\u5E02: "\u9E7D\u57D5\u5340 \u9F13\u5C71\u5340 \u5DE6\u71DF\u5340 \u6960\u6893\u5340 \u4E09\u6C11\u5340 \u65B0\u8208\u5340 \u524D\u91D1\u5340 \u82D3\u96C5\u5340 \u524D\u93AE\u5340 \u65D7\u6D25\u5340 \u5C0F\u6E2F\u5340 \u9CF3\u5C71\u5340 \u6797\u5712\u5340 \u5927\u5BEE\u5340 \u5927\u6A39\u5340 \u5927\u793E\u5340 \u4EC1\u6B66\u5340 \u9CE5\u677E\u5340 \u5CA1\u5C71\u5340 \u6A4B\u982D\u5340 \u71D5\u5DE2\u5340 \u7530\u5BEE\u5340 \u963F\u84EE\u5340 \u8DEF\u7AF9\u5340 \u6E56\u5167\u5340 \u8304\u8423\u5340 \u6C38\u5B89\u5340 \u5F4C\u9640\u5340 \u6893\u5B98\u5340 \u65D7\u5C71\u5340 \u7F8E\u6FC3\u5340 \u516D\u9F9C\u5340 \u7532\u4ED9\u5340 \u6749\u6797\u5340 \u5167\u9580\u5340 \u8302\u6797\u5340 \u6843\u6E90\u5340 \u90A3\u746A\u590F\u5340".split(" "),
  \u57FA\u9686\u5E02: "\u4E2D\u6B63\u5340 \u4E03\u5835\u5340 \u6696\u6696\u5340 \u4EC1\u611B\u5340 \u4E2D\u5C71\u5340 \u5B89\u6A02\u5340 \u4FE1\u7FA9\u5340".split(" "),
  \u65B0\u7AF9\u5E02: "\u6771\u5340 \u5317\u5340 \u9999\u5C71\u5340".split(" "),
  \u5609\u7FA9\u5E02: "\u6771\u5340 \u897F\u5340".split(" "),
  \u65B0\u7AF9\u7E23: "\u7AF9\u5317\u5E02 \u7AF9\u6771\u93AE \u65B0\u57D4\u93AE \u95DC\u897F\u93AE \u6E56\u53E3\u9109 \u65B0\u8C50\u9109 \u828E\u6797\u9109 \u6A6B\u5C71\u9109 \u5317\u57D4\u9109 \u5BF6\u5C71\u9109 \u5CE8\u7709\u9109 \u5C16\u77F3\u9109 \u4E94\u5CF0\u9109".split(" "),
  \u82D7\u6817\u7E23: "\u82D7\u6817\u5E02 \u982D\u4EFD\u5E02 \u7AF9\u5357\u93AE \u5F8C\u9F8D\u93AE \u901A\u9704\u93AE \u82D1\u88E1\u93AE \u5353\u862D\u93AE \u4E09\u7063\u9109 \u5357\u5E84\u9109 \u7345\u6F6D\u9109 \u982D\u5C4B\u9109 \u516C\u9928\u9109 \u9285\u947C\u9109 \u4E09\u7FA9\u9109 \u897F\u6E56\u9109 \u9020\u6A4B\u9109 \u5927\u6E56\u9109 \u6CF0\u5B89\u9109".split(" "),
  \u5F70\u5316\u7E23: "\u5F70\u5316\u5E02 \u54E1\u6797\u5E02 \u548C\u7F8E\u93AE \u9E7F\u6E2F\u93AE \u6EAA\u6E56\u93AE \u4E8C\u6797\u93AE \u7530\u4E2D\u93AE \u5317\u6597\u93AE \u82B1\u58C7\u9109 \u82AC\u5712\u9109 \u5927\u6751\u9109 \u6C38\u9756\u9109 \u4F38\u6E2F\u9109 \u7DDA\u897F\u9109 \u798F\u8208\u9109 \u79C0\u6C34\u9109 \u57D4\u5FC3\u9109 \u57D4\u9E7D\u9109 \u5927\u57CE\u9109 \u82B3\u82D1\u9109 \u7AF9\u5858\u9109 \u793E\u982D\u9109 \u4E8C\u6C34\u9109 \u7530\u5C3E\u9109 \u57E4\u982D\u9109 \u6EAA\u5DDE\u9109".split(" "),
  \u5357\u6295\u7E23: "\u5357\u6295\u5E02 \u57D4\u91CC\u93AE \u8349\u5C6F\u93AE \u7AF9\u5C71\u93AE \u96C6\u96C6\u93AE \u540D\u9593\u9109 \u9E7F\u8C37\u9109 \u4E2D\u5BEE\u9109 \u9B5A\u6C60\u9109 \u570B\u59D3\u9109 \u6C34\u91CC\u9109 \u4FE1\u7FA9\u9109 \u4EC1\u611B\u9109".split(" "),
  \u96F2\u6797\u7E23: "\u6597\u516D\u5E02 \u6597\u5357\u93AE \u864E\u5C3E\u93AE \u897F\u87BA\u93AE \u571F\u5EAB\u93AE \u5317\u6E2F\u93AE \u53E4\u5751\u9109 \u5927\u57E4\u9109 \u83BF\u6850\u9109 \u6797\u5167\u9109 \u4E8C\u5D19\u9109 \u5D19\u80CC\u9109 \u9EA5\u5BEE\u9109 \u6771\u52E2\u9109 \u8912\u5FE0\u9109 \u81FA\u897F\u9109 \u5143\u9577\u9109 \u56DB\u6E56\u9109 \u53E3\u6E56\u9109 \u6C34\u6797\u9109".split(" "),
  \u5609\u7FA9\u7E23: "\u592A\u4FDD\u5E02 \u6734\u5B50\u5E02 \u5E03\u888B\u93AE \u5927\u6797\u93AE \u6C11\u96C4\u9109 \u6EAA\u53E3\u9109 \u65B0\u6E2F\u9109 \u516D\u8173\u9109 \u6771\u77F3\u9109 \u7FA9\u7AF9\u9109 \u9E7F\u8349\u9109 \u6C34\u4E0A\u9109 \u4E2D\u57D4\u9109 \u7AF9\u5D0E\u9109 \u6885\u5C71\u9109 \u756A\u8DEF\u9109 \u5927\u57D4\u9109 \u963F\u91CC\u5C71\u9109".split(" "),
  \u5C4F\u6771\u7E23: "\u5C4F\u6771\u5E02 \u6F6E\u5DDE\u93AE \u6771\u6E2F\u93AE \u6046\u6625\u93AE \u842C\u4E39\u9109 \u9577\u6CBB\u9109 \u9E9F\u6D1B\u9109 \u4E5D\u5982\u9109 \u91CC\u6E2F\u9109 \u9E7D\u57D4\u9109 \u9AD8\u6A39\u9109 \u842C\u5DD2\u9109 \u5167\u57D4\u9109 \u7AF9\u7530\u9109 \u65B0\u57E4\u9109 \u678B\u5BEE\u9109 \u65B0\u5712\u9109 \u5D01\u9802\u9109 \u6797\u908A\u9109 \u5357\u5DDE\u9109 \u4F73\u51AC\u9109 \u7409\u7403\u9109 \u8ECA\u57CE\u9109 \u6EFF\u5DDE\u9109 \u678B\u5C71\u9109 \u4E09\u5730\u9580\u9109 \u9727\u81FA\u9109 \u746A\u5BB6\u9109 \u6CF0\u6B66\u9109 \u4F86\u7FA9\u9109 \u6625\u65E5\u9109 \u7345\u5B50\u9109 \u7261\u4E39\u9109".split(" "),
  \u5B9C\u862D\u7E23: "\u5B9C\u862D\u5E02 \u7F85\u6771\u93AE \u8607\u6FB3\u93AE \u982D\u57CE\u93AE \u7901\u6EAA\u9109 \u58EF\u570D\u9109 \u54E1\u5C71\u9109 \u51AC\u5C71\u9109 \u4E94\u7D50\u9109 \u4E09\u661F\u9109 \u5927\u540C\u9109 \u5357\u6FB3\u9109".split(" "),
  \u82B1\u84EE\u7E23: "\u82B1\u84EE\u5E02 \u9CF3\u6797\u93AE \u7389\u91CC\u93AE \u65B0\u57CE\u9109 \u5409\u5B89\u9109 \u58FD\u8C50\u9109 \u5149\u5FA9\u9109 \u8C50\u6FF1\u9109 \u745E\u7A57\u9109 \u5BCC\u91CC\u9109 \u79C0\u6797\u9109 \u842C\u69AE\u9109 \u5353\u6EAA\u9109".split(" "),
  \u81FA\u6771\u7E23: "\u81FA\u6771\u5E02 \u6210\u529F\u93AE \u95DC\u5C71\u93AE \u5351\u5357\u9109 \u9E7F\u91CE\u9109 \u6C60\u4E0A\u9109 \u6771\u6CB3\u9109 \u9577\u6FF1\u9109 \u592A\u9EBB\u91CC\u9109 \u5927\u6B66\u9109 \u7DA0\u5CF6\u9109 \u6D77\u7AEF\u9109 \u5EF6\u5E73\u9109 \u91D1\u5CF0\u9109 \u9054\u4EC1\u9109 \u862D\u5DBC\u9109".split(" "),
  \u6F8E\u6E56\u7E23: "\u99AC\u516C\u5E02 \u6E56\u897F\u9109 \u767D\u6C99\u9109 \u897F\u5DBC\u9109 \u671B\u5B89\u9109 \u4E03\u7F8E\u9109".split(" "),
  \u91D1\u9580\u7E23: "\u91D1\u57CE\u93AE \u91D1\u6E56\u93AE \u91D1\u6C99\u93AE \u91D1\u5BE7\u9109 \u70C8\u5DBC\u9109 \u70CF\u5775\u9109".split(" "),
  \u9023\u6C5F\u7E23: "\u5357\u7AFF\u9109 \u5317\u7AFF\u9109 \u8392\u5149\u9109 \u6771\u5F15\u9109".split(" ")
};
var counties = Object.keys(districts);
var districtAtStart = (county, area) => {
  return districts[county]?.find((d) => area.startsWith(d)) ?? "";
};
function resolveDistrict(county, value) {
  const available = districts[county] ?? [];
  if (available.includes(value)) return value;
  if (/[市鄉鎮]$/.test(value)) {
    const district = value.slice(0, -1) + "\u5340";
    if (available.includes(district)) return district;
  }
  const matches = available.filter((d) => ["\u5340", "\u9109", "\u93AE", "\u5E02"].some((suffix) => value + suffix === d));
  return matches.length === 1 ? matches[0] : void 0;
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
var clean = (s, limit = Infinity) => {
  const text = typeof s === "string" || typeof s === "number" ? stripZeroWidth(String(s)).replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim() : "";
  return text.length > limit ? text.slice(0, limit - 1) + "\u2026" : text;
};
var canonical = (s) => stripZeroWidth(norm(s)).replace(/桃園縣(桃園|中壢|平鎮|八德|楊梅|蘆竹|大溪|龍潭|龜山|大園|觀音|新屋|復興)[市鄉鎮區](?!場)/g, "\u6843\u5712\u5E02$1\u5340").replace(/(臺北縣|臺中縣|臺南縣|高雄縣)(.{1,4}?[市鄉鎮])(?!場)/g, (match, oldCounty, oldDistrict) => {
  const county = oldCounty === "\u81FA\u5317\u7E23" ? "\u65B0\u5317\u5E02" : oldCounty.replace("\u7E23", "\u5E02");
  const district = resolveDistrict(county, oldDistrict);
  return district ? county + district : match;
}).replace(/桃園縣/g, "\u6843\u5712\u5E02").replace(/臺北縣/g, "\u65B0\u5317\u5E02").replace(/(臺中|臺南|高雄)縣/g, "$1\u5E02");
var countyPattern = counties.join("|");
function locations(text) {
  const area = canonical(text), matches = [...area.matchAll(new RegExp(countyPattern, "g"))];
  const result = matches.flatMap((m, i) => {
    const c = m[0], section = area.slice(m.index + c.length, matches[i + 1]?.index);
    const ds = section.split(/[、,，；;/]/).map((part) => districtAtStart(c, part.trim())).filter(Boolean);
    return (ds.length ? ds : [""]).map((d) => ({ c, d }));
  });
  return result.filter((v, i, all) => all.findIndex((x) => x.c === v.c && x.d === v.d) === i);
}
var records = (input) => {
  if (!Array.isArray(input) || input.some((x) => !x || typeof x !== "object" || Array.isArray(x))) throw Error("\u5B98\u65B9\u958B\u653E\u8CC7\u6599\u683C\u5F0F\u932F\u8AA4");
  return input;
};
var taiwaterEmptyReason = "\u5B98\u65B9\u958B\u653E\u8CC7\u6599\u76EE\u524D\u56DE\u50B3\u7A7A\u6E05\u55AE";
function taiwater(input) {
  const rows = records(input);
  if (!rows.length) throw Error(taiwaterEmptyReason);
  const items = [];
  let dropped = 0;
  for (const row of rows) {
    const v = (key) => clean(row[key]);
    const area = [v("\u505C\u6C34\u5730\u5340"), v("\u964D\u58D3\u5730\u5340") ? `\u964D\u58D3\uFF1A${v("\u964D\u58D3\u5730\u5340")}` : ""].filter(Boolean).join("\uFF1B");
    const explicit = canonical(v("\u5F71\u97FF\u7E23\u5E02")), cs = counties.filter((c) => explicit.includes(c));
    const fallback = locations(cs.length === 1 && !counties.some((c) => canonical(area).includes(c)) ? cs[0] + area : area);
    const ds = canonical(v("\u5F71\u97FF\u884C\u653F\u5340")).split(/[、,，/\s]+/).filter(Boolean);
    const places = cs.length ? cs.flatMap((c) => {
      let scoped = ds.filter((d) => !counties.some((other) => d.includes(other)) || d.includes(c)).map((d) => resolveDistrict(c, d.replace(new RegExp(countyPattern, "g"), ""))).filter((d) => !!d);
      const linked = fallback.filter((p) => p.c === c).map((p) => p.d).filter((d) => scoped.includes(d));
      if (cs.length > 1) scoped = scoped.filter((d) => linked.includes(d) || ds.some((raw) => raw.includes(c) && raw.replace(new RegExp(countyPattern, "g"), "") === d) || !fallback.some((p) => p.d === d));
      return (scoped.length ? scoped : fallback.filter((p) => p.c === c).map((p) => p.d)).map((d) => ({ c, d })).concat(!scoped.length && !fallback.some((p) => p.c === c) ? [{ c, d: "" }] : []);
    }) : fallback;
    if (!places.length) dropped++;
    for (const { c, d } of places) items.push({ s: "taiwater", k: "water", c, d, t: waterTimes(v("\u6848\u4EF6\u65E5\u671F\u6642\u9593"), v("\u6062\u5FA9\u65E5\u671F\u6642\u9593")), a: area, r: clean(v("\u505C\u6C34\u539F\u56E0") || v("\u964D\u58D3\u539F\u56E0"), 100), n: v("\u6848\u4EF6\u7DE8\u865F"), u: official.taiwater.url, ...v("\u6848\u4EF6\u985E\u578B") ? { o: v("\u6848\u4EF6\u985E\u578B") } : {} });
  }
  if (!items.length) throw Error("\u5B98\u65B9\u958B\u653E\u8CC7\u6599\u672A\u63D0\u4F9B\u53EF\u8FA8\u8B58\u7684\u7E23\u5E02");
  return { items: unique(items), dropped, rows: rows.length };
}
function taipeiwater(input) {
  const items = [];
  const rows = records(input);
  let dropped = 0;
  for (const row of rows) {
    const v = (key) => clean(row[key]);
    const area = v("SW_Area"), same = (s) => s.replace(/\s+/g, "");
    const reason = [...new Set([v("Title"), v("Description")].filter((s) => s && same(s) !== same(area)))].join("\uFF1B");
    const places = locations(area);
    if (!places.length) dropped++;
    for (const { c, d } of places) items.push({ s: "taipeiwater", k: "water", c, d, t: dailyTimes(v("Date"), v("Time")), a: area, r: clean(reason, 100), n: v("SW_No"), u: /^https?:\/\//i.test(v("MapUrl")) ? v("MapUrl") : official.taipeiwater.url });
  }
  if (rows.length && !items.length) throw Error("\u5B98\u65B9\u958B\u653E\u8CC7\u6599\u672A\u63D0\u4F9B\u53EF\u8FA8\u8B58\u7684\u7E23\u5E02");
  return { items: unique(items), dropped, rows: rows.length };
}
function unique(items) {
  return [...new Map(items.map((i) => [JSON.stringify(i), i])).values()];
}
function parseCsv(text) {
  const records2 = [];
  let record = [], field = "", quoted = false, closed = false, invalid = false;
  let recovery = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted && (ch === "\n" || ch === "\r" && text[i + 1] === "\n") && /^(?:(?:台電|臺電)[^,\r\n]*區營業處|金門區營業處),/.test(text.slice(i + (ch === "\r" ? 2 : 1)))) {
      if (recovery < 0) recovery = i;
    }
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        if (recovery >= 0 && text[i + 1] !== void 0 && !",\r\n".includes(text[i + 1])) return [...parseCsv(text.slice(0, recovery)), ...parseCsv(text.slice(recovery + (text[recovery] === "\r" ? 2 : 1)))];
        quoted = false;
        closed = true;
        recovery = -1;
      } else field += ch;
    } else if (ch === '"' && !field && !closed) quoted = true;
    else if (ch === "," || ch === "\n" || ch === "\r" && text[i + 1] === "\n") {
      record.push(field);
      field = "";
      closed = false;
      if (ch !== ",") {
        if (invalid) record.push(...Array(8).fill(""));
        records2.push(record);
        record = [];
        invalid = false;
        if (ch === "\r") i++;
      }
    } else if (closed) invalid = true;
    else field += ch;
  }
  if (quoted && recovery >= 0) return [...parseCsv(text.slice(0, recovery)), ...parseCsv(text.slice(recovery + (text[recovery] === "\r" ? 2 : 1)))];
  record.push(field);
  if (quoted || invalid) record.push(...Array(8).fill(""));
  records2.push(record);
  return records2;
}
var officeCounties = {
  \u81FA\u5317\u5E02\u5340\u71DF\u696D\u8655: ["\u81FA\u5317\u5E02"],
  \u81FA\u5317\u5340\u71DF\u696D\u8655: ["\u81FA\u5317\u5E02", "\u65B0\u5317\u5E02"],
  \u81FA\u5317\u5317\u5340\u71DF\u696D\u8655: ["\u81FA\u5317\u5E02", "\u65B0\u5317\u5E02"],
  \u81FA\u5317\u5357\u5340\u71DF\u696D\u8655: ["\u81FA\u5317\u5E02", "\u65B0\u5317\u5E02"],
  \u81FA\u5317\u897F\u5340\u71DF\u696D\u8655: ["\u81FA\u5317\u5E02", "\u65B0\u5317\u5E02"],
  \u57FA\u9686\u5340\u71DF\u696D\u8655: ["\u57FA\u9686\u5E02", "\u65B0\u5317\u5E02"],
  \u6843\u5712\u5340\u71DF\u696D\u8655: ["\u6843\u5712\u5E02", "\u65B0\u5317\u5E02"],
  \u65B0\u7AF9\u5340\u71DF\u696D\u8655: ["\u65B0\u7AF9\u5E02", "\u65B0\u7AF9\u7E23", "\u6843\u5712\u5E02"],
  \u82D7\u6817\u5340\u71DF\u696D\u8655: ["\u82D7\u6817\u7E23", "\u81FA\u4E2D\u5E02"],
  \u81FA\u4E2D\u5340\u71DF\u696D\u8655: ["\u81FA\u4E2D\u5E02", "\u5357\u6295\u7E23"],
  \u5F70\u5316\u5340\u71DF\u696D\u8655: ["\u5F70\u5316\u7E23", "\u5357\u6295\u7E23"],
  \u5357\u6295\u5340\u71DF\u696D\u8655: ["\u5357\u6295\u7E23", "\u81FA\u4E2D\u5E02"],
  \u96F2\u6797\u5340\u71DF\u696D\u8655: ["\u96F2\u6797\u7E23", "\u5609\u7FA9\u7E23"],
  \u5609\u7FA9\u5340\u71DF\u696D\u8655: ["\u5609\u7FA9\u5E02", "\u5609\u7FA9\u7E23"],
  \u81FA\u5357\u5340\u71DF\u696D\u8655: ["\u81FA\u5357\u5E02"],
  \u65B0\u71DF\u5340\u71DF\u696D\u8655: ["\u81FA\u5357\u5E02", "\u5609\u7FA9\u7E23"],
  \u9AD8\u96C4\u5340\u71DF\u696D\u8655: ["\u9AD8\u96C4\u5E02", "\u81FA\u5357\u5E02"],
  \u9CF3\u5C71\u5340\u71DF\u696D\u8655: ["\u9AD8\u96C4\u5E02"],
  \u5C4F\u6771\u5340\u71DF\u696D\u8655: ["\u5C4F\u6771\u7E23"],
  \u5B9C\u862D\u5340\u71DF\u696D\u8655: ["\u5B9C\u862D\u7E23", "\u65B0\u5317\u5E02"],
  \u82B1\u84EE\u5340\u71DF\u696D\u8655: ["\u82B1\u84EE\u7E23"],
  \u81FA\u6771\u5340\u71DF\u696D\u8655: ["\u81FA\u6771\u7E23"],
  \u6F8E\u6E56\u5340\u71DF\u696D\u8655: ["\u6F8E\u6E56\u7E23"],
  \u91D1\u9580\u5340\u71DF\u696D\u8655: ["\u91D1\u9580\u7E23"]
};
var countiesForOffice = (office) => officeCounties[canonical(office).replace(/^臺電/, "")] ?? [];
function taipower(files, minimum = 100) {
  const droppedBy = /* @__PURE__ */ Object.create(null);
  const groups = /* @__PURE__ */ new Map();
  let rows = 0, dropped = 0;
  for (const [code, text] of files) {
    const lines = parseCsv(text.replace(/^\uFEFF/, "").trim());
    const header = lines.shift();
    if (header?.length !== 7 || header.join(",") !== "\u71DF\u696D\u5340\u8655,\u8ACB\u6C42\u865F\u6578,\u5DE5\u4F5C\u6982\u8FF0,\u7B2C\u4E00\u6B21\u505C\u96FB\u6642\u9593,\u7B2C\u4E8C\u6B21\u505C\u96FB\u6642\u9593,\u505C\u96FB\u7BC4\u570D,\u67E5\u8A62\u96FB\u8A71(1911)") throw Error("\u53F0\u96FB CSV \u6B04\u4F4D\u683C\u5F0F\u932F\u8AA4");
    for (const fields of lines) {
      if (fields.length === 1 && !fields[0].trim()) continue;
      rows++;
      const drop = () => {
        dropped++;
        const office2 = clean(fields[0]);
        if (office2) droppedBy[office2] = (droppedBy[office2] ?? 0) + 1;
      };
      if (fields.length !== 7) {
        drop();
        continue;
      }
      const [office, n, r, first, second, area] = fields.map((s) => clean(s));
      let a = canonical(area);
      let c = counties.find((c2) => a.startsWith(c2));
      if (!c) {
        const candidates = countiesForOffice(office).filter((county) => districtAtStart(county, a));
        if (candidates.length === 1) {
          c = candidates[0];
          a = c + a;
        }
      }
      if (!c) {
        drop();
        continue;
      }
      const d = districtAtStart(c, a.slice(c.length).trimStart());
      const windows = [first, second].filter((s) => s && s !== "\u7121");
      const parsed = windows.map(powerWindow);
      const t = windows.length && parsed.every((t2) => t2 !== null) ? parsed : windows.join("\uFF1B") || "\u672A\u6A19\u793A\u6642\u9593";
      const key = JSON.stringify([n, t, c, d]);
      const found = groups.get(key);
      if (found) found.areas.add(a);
      else groups.set(key, { item: { s: "taipower", k: "power", c, d, t, a, r: clean(r, 100), n, u: `https://service.taipower.com.tw/branch/d${code.replace(/\.csv$/, "")}`, o: office }, areas: /* @__PURE__ */ new Set([a]) });
    }
  }
  if (dropped > 20 && dropped / rows > 0.05) throw Error("\u53F0\u96FB\u958B\u653E\u8CC7\u6599\u7121\u6CD5\u8FA8\u8B58\u7684\u8CC7\u6599\u5217\u904E\u591A");
  if (rows < minimum || !groups.size) throw Error("\u53F0\u96FB\u958B\u653E\u8CC7\u6599\u7B46\u6578\u4E0D\u8DB3");
  return { items: [...groups.values()].map(({ item, areas }) => ({ ...item, a: clean([...areas].sort().join("\u3001")) })), dropped, droppedBy, rows };
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
var downloadLimit = 16 * 1024 * 1024;
async function fetchSource2(source) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3e4);
  try {
    const r = await fetch(urls[source], { signal: controller.signal, redirect: "follow" });
    if (!r.ok) throw Error(`\u5B98\u65B9\u958B\u653E\u8CC7\u6599 HTTP ${r.status}`);
    if (Number(r.headers.get("content-length")) > downloadLimit) {
      await r.body?.cancel();
      throw Error("\u5B98\u65B9\u958B\u653E\u8CC7\u6599\u6A94\u6848\u904E\u5927");
    }
    if (!r.body) throw Error("\u5B98\u65B9\u958B\u653E\u8CC7\u6599\u7F3A\u5C11\u5167\u5BB9");
    const reader = r.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > downloadLimit) {
          await reader.cancel();
          throw Error("\u5B98\u65B9\u958B\u653E\u8CC7\u6599\u6A94\u6848\u904E\u5927");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (source === "taipower") return taipower(readZip(bytes));
    let input;
    try {
      input = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw Error("\u5B98\u65B9\u958B\u653E\u8CC7\u6599 JSON \u683C\u5F0F\u932F\u8AA4");
    }
    return source === "taiwater" ? taiwater(input) : taipeiwater(input);
  } catch (e) {
    if (controller.signal.aborted) throw Error("\u5B98\u65B9\u958B\u653E\u8CC7\u6599\u9023\u7DDA\u903E\u6642");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// scripts/publish-outages.ts
function describeError(e) {
  const message = (value) => value instanceof Error ? value.message : String(value);
  const details = (value, depth = 0) => {
    if (!value || typeof value !== "object") return message(value);
    const error = value;
    const text = [error.code, error.message].filter(Boolean).join(" ");
    const cause2 = error.cause ?? error.errors?.[0];
    return [text, cause2 == null || depth === 1 ? "" : details(cause2, depth + 1)].filter(Boolean).join(" ");
  };
  const cause = e instanceof Error ? e.cause ?? (e instanceof AggregateError ? e.errors[0] : void 0) : void 0;
  return message(e) + (cause == null ? "" : ` (cause: ${details(cause)})`);
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
  const fetch2 = options.fetch ?? (async (source) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fetchSource2(source);
      } catch (e) {
        console.warn(`outage ${source} attempt ${attempt}/3 failed: ${reason(describeError(e))}`);
        if (attempt === 3) throw e;
        await (options.sleep ?? ((ms) => new Promise((resolve2) => setTimeout(resolve2, ms))))(attempt * 1e3);
      }
    }
  });
  const results = await Promise.allSettled(sources.map((s) => fetch2(s)));
  const index = { v: 1, generatedAt: (options.now ?? (() => /* @__PURE__ */ new Date()))().toISOString(), sources: {} };
  const down = (lastSuccessAt) => lastSuccessAt ? `${Math.floor((Date.parse(index.generatedAt) - Date.parse(lastSuccessAt)) / 36e5)}h` : "never";
  for (const [i, source] of sources.entries()) {
    const old = previous.sources[source];
    let dropped = 0, count = 0, largest = 0;
    let publicationFailed = false;
    try {
      const result = results[i];
      if (result.status === "rejected") throw result.reason;
      const data = result.value;
      dropped = data.dropped;
      count = data.items.length;
      if (source === "taiwater" && data.rows === 0) throw Error(taiwaterEmptyReason);
      const shards = buildShards(data.items), counties2 = {};
      for (const [county, raw] of shards) {
        const sha = createHash("sha256").update(raw).digest("hex");
        largest = Math.max(largest, Buffer.byteLength(raw));
        const prior = old?.counties[county];
        let writtenAt = prior?.writtenAt;
        if (prior?.sha !== sha || !writtenAt || Date.parse(index.generatedAt) - Date.parse(writtenAt) > 3 * 864e5) {
          try {
            await store.put(shardKey2(source, county, sha), raw, index.generatedAt, 8 * 86400);
          } catch (e) {
            publicationFailed = true;
            throw e;
          }
          writes++;
          writtenAt = index.generatedAt;
        }
        counties2[county] = { sha, count: data.items.filter((item) => item.c === county).length, writtenAt };
      }
      index.sources[source] = { ok: true, fetchedAt: index.generatedAt, lastSuccessAt: index.generatedAt, counties: counties2, dropped, ...data.droppedBy ? { droppedBy: data.droppedBy } : {} };
    } catch (e) {
      const emptyTaiwater = source === "taiwater" && reason(e) === taiwaterEmptyReason;
      if (publicationFailed) failed = true;
      index.sources[source] = { ok: false, fetchedAt: index.generatedAt, reason: reason(e), ...old?.lastSuccessAt ? { lastSuccessAt: old.lastSuccessAt } : {}, counties: old?.counties ?? {}, ...old?.dropped !== void 0 ? { dropped: old.dropped } : {}, ...old?.droppedBy ? { droppedBy: old.droppedBy } : {} };
      console.warn(`::warning::outage ${source} unavailable: ${reason(describeError(e))}${emptyTaiwater ? "" : old?.lastSuccessAt ? ` (down ${down(old.lastSuccessAt)} since ${old.lastSuccessAt})` : " (never succeeded)"}`);
      if (publicationFailed) console.error(`outage ${source} failed: ${reason(describeError(e))}`);
    }
    console.log(`outage ${source} ok=${index.sources[source].ok} count=${count} largestBytes=${largest} dropped=${dropped}`);
  }
  if (sources.every((source) => !index.sources[source].ok)) {
    console.error("outage all sources failed");
    failed = true;
  }
  try {
    await store.put(indexKey2, JSON.stringify(index), index.generatedAt);
    writes++;
  } catch (e) {
    console.error(`outage index write failed: ${reason(e)}`);
    failed = true;
  }
  const summaryPath = options.summaryPath ?? process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const rows = sources.map((source) => {
      const info = index.sources[source];
      return `| ${source} | ${info.ok ? "ok" : "failed"} | ${info.lastSuccessAt ?? "\u2014"} | ${info.ok ? "0h" : down(info.lastSuccessAt)} |`;
    });
    try {
      await appendFile(summaryPath, `| \u4F86\u6E90 | \u72C0\u614B | \u6700\u5F8C\u6210\u529F | \u4E2D\u65B7\u6642\u9593 |
| --- | --- | --- | --- |
${rows.join("\n")}
`);
    } catch (e) {
      console.warn(`outage summary write failed: ${reason(e)}`);
    }
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
  describeError,
  directoryStore,
  kvStore,
  main
};
