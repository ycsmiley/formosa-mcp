// scripts/publish-disaster.ts
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// scripts/snapshot-store.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// src/core/garbage/text.ts
var norm = (s) => s.trim().replaceAll("\u53F0", "\u81FA").replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 65296));
var stripZeroWidth = (s) => s.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");

// src/core/outage/time.ts
function validDay(s) {
  return /^\d{4}-\d\d-\d\d$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
}

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

// src/core/outage/normalize.ts
var clean = (s, limit = Infinity) => {
  const text2 = typeof s === "string" || typeof s === "number" ? stripZeroWidth(String(s)).replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim() : "";
  return text2.length > limit ? text2.slice(0, limit - 1) + "\u2026" : text2;
};
var canonical = (s) => stripZeroWidth(norm(s)).replace(/桃園縣(桃園|中壢|平鎮|八德|楊梅|蘆竹|大溪|龍潭|龜山|大園|觀音|新屋|復興)[市鄉鎮區](?!場)/g, "\u6843\u5712\u5E02$1\u5340").replace(/(臺北縣|臺中縣|臺南縣|高雄縣)(.{1,4}?[市鄉鎮])(?!場)/g, (match, oldCounty, oldDistrict) => {
  const county = oldCounty === "\u81FA\u5317\u7E23" ? "\u65B0\u5317\u5E02" : oldCounty.replace("\u7E23", "\u5E02");
  const district = resolveDistrict(county, oldDistrict);
  return district ? county + district : match;
}).replace(/桃園縣/g, "\u6843\u5712\u5E02").replace(/臺北縣/g, "\u65B0\u5317\u5E02").replace(/(臺中|臺南|高雄)縣/g, "$1\u5E02");
var countyPattern = counties.join("|");

// src/core/disaster/model.ts
var sources = ["dgpa", "ncdr"];
var severities = ["Extreme", "Severe", "Moderate", "Minor", "Unknown"];
var indexKey2 = (writer) => `disaster:index:${writer}:v1`;
var shardKey2 = (source, sha) => `disaster:v1:${source}:${sha.slice(0, 12)}`;
var official2 = { dgpa: "https://www.dgpa.gov.tw/typh/daily/nds.html", ncdr: "https://alerts.ncdr.nat.gov.tw/" };
var feedUrls = ["https://alerts.ncdr.nat.gov.tw/JSONAtomFeeds.ashx", "https://alerts.ncdr.nat.gov.tw/RssAtomFeeds.ashx"];
var safeLink = (s) => {
  try {
    const u = new URL(s);
    if (s.length <= 300 && clean(s) === s && u.protocol === "https:" && u.hostname === "alerts.ncdr.nat.gov.tw" && !u.port && !u.username && !u.password && !/^https:\/\/[^/]*:/i.test(s)) return s;
  } catch {
  }
  return official2.ncdr;
};
var object = (x) => !!x && typeof x === "object" && !Array.isArray(x);
var timestamp = (x) => typeof x === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x) && validDay(x.slice(0, 10)) && Number.isFinite(Date.parse(x)) && +x.slice(11, 13) < 24 && +x.slice(14, 16) < 60 && +x.slice(17, 19) < 60;
var strings = (x) => Array.isArray(x) && x.every((v) => typeof v === "string" && v.length > 0);
function decodeIndex2(raw) {
  const x = JSON.parse(raw);
  if (!object(x) || x.v !== 1 || !["worker", "gha"].includes(x.writer) || !timestamp(x.heartbeatAt) || !object(x.sources)) throw Error("\u707D\u9632\u7D22\u5F15\u683C\u5F0F\u932F\u8AA4");
  if (x.budget !== void 0 && (!object(x.budget) || typeof x.budget.tokens !== "number" || !Number.isFinite(x.budget.tokens) || !timestamp(x.budget.at))) throw Error("\u707D\u9632\u9810\u7B97\u683C\u5F0F\u932F\u8AA4");
  for (const [s, v] of Object.entries(x.sources)) {
    if (!sources.includes(s) || !object(v) || typeof v.ok !== "boolean" || ["closed", "skipped", "empty"].some((k) => v[k] !== void 0 && typeof v[k] !== "boolean") || v.reason !== void 0 && (typeof v.reason !== "string" || v.reason.length > 200) || ["fetchedAt", "lastSuccessAt", "sourceUpdatedAt", "writtenAt"].some((k) => v[k] !== void 0 && !timestamp(v[k])) || v.sha !== void 0 && (typeof v.sha !== "string" || !/^[a-f0-9]{12}$/.test(v.sha)) || v.count !== void 0 && (!Number.isSafeInteger(v.count) || v.count < 0) || v.empty !== void 0 && v.count !== 0 || v.closed && v.ok || v.sha !== void 0 && (!v.lastSuccessAt || !v.sourceUpdatedAt || !v.writtenAt || v.count === void 0) || v.ok && !v.sha && !v.skipped) throw Error("\u707D\u9632\u4F86\u6E90\u683C\u5F0F\u932F\u8AA4");
  }
  return x;
}
function decodeDgpa(raw) {
  const x = JSON.parse(raw);
  if (!object(x) || !validDay(x.pageDate) || !["none", "regional", "flat"].includes(x.layout) || typeof x.noEvent !== "boolean" || !object(x.counties) || Object.entries(x.counties).some(([c, lines]) => !counties.includes(c) || !strings(lines) || !lines.length || lines.length > 20 || lines.some((l) => l.length > 300 || clean(l) !== l)) || (x.noEvent ? x.layout !== "none" || Object.keys(x.counties).length !== 0 : x.layout === "none" || !Object.keys(x.counties).length)) throw Error("\u505C\u73ED\u505C\u8AB2\u5FEB\u7167\u683C\u5F0F\u932F\u8AA4");
  return x;
}
function decodeAlerts(raw) {
  const x = JSON.parse(raw);
  if (!Array.isArray(x)) throw Error("\u544A\u8B66\u5FEB\u7167\u683C\u5F0F\u932F\u8AA4");
  const ids = /* @__PURE__ */ new Set();
  for (const v of x) {
    if (!object(v) || !["id", "type", "text", "link"].every((k) => typeof v[k] === "string") || !v.id || !v.type || ids.has(v.id) || typeof v.detail !== "boolean" || v.complete !== void 0 && typeof v.complete !== "boolean" || v.complete === true && (!v.detail || !v.counties?.length) || !strings(v.counties) || v.counties.some((c) => !counties.includes(c)) || new Set(v.counties).size !== v.counties.length || Object.entries({ type: 40, title: 200, sender: 100, level: 60, color: 20, text: 400 }).some(([k, limit]) => v[k] !== void 0 && (typeof v[k] !== "string" || v[k].length > limit || clean(v[k]) !== v[k])) || v.text.length > 400 || v.severity !== void 0 && !severities.includes(v.severity) || ["effective", "expires"].some((k) => v[k] !== void 0 && !timestamp(v[k])) || v.areas !== void 0 && (!strings(v.areas) || v.areas.length > 200 || v.areas.some((a) => a.length > 100 || clean(a) !== a)) || v.link.length > 300) throw Error("\u544A\u8B66\u9805\u76EE\u683C\u5F0F\u932F\u8AA4");
    if (v.areaCounties !== void 0 && (!Array.isArray(v.areaCounties) || !Array.isArray(v.areas) || v.areaCounties.length !== v.areas.length || v.areaCounties.some((cs) => !strings(cs) || !cs.length || cs.some((c) => !v.counties.includes(c)) || new Set(cs).size !== cs.length))) throw Error("\u544A\u8B66\u5340\u57DF\u7E23\u5E02\u683C\u5F0F\u932F\u8AA4");
    ids.add(v.id);
  }
  return x;
}
function decodeShard2(raw, source) {
  return source === "dgpa" ? decodeDgpa(raw) : decodeAlerts(raw);
}

// src/core/disaster/parse.ts
var entities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, code) => {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  if (code[0] !== "#") return named[code.toLowerCase()] ?? all;
  const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : +code.slice(1);
  return n > 0 && n <= 1114111 && !(n >= 55296 && n <= 57343) ? String.fromCodePoint(n) : " ";
});
var text = (s) => clean(entities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, "")));
var attr = (s, name) => entities(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(s)?.slice(1).find((v) => v !== void 0) ?? "");
var tag = (s, name) => new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}\\s*>`, "i").exec(s)?.[1] ?? "";
var tags = (s, name) => [...s.matchAll(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}\\s*>`, "gi"))].map((m) => m[1]);
function ncdrTime(s) {
  if (timestamp(s)) return s;
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(上午|下午)\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m || +m[5] < 1 || +m[5] > 12 || +m[6] > 59 || +m[7] > 59) return;
  const day = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  if (!validDay(day)) return;
  return `${day}T${String(+m[5] % 12 + (m[4] === "\u4E0B\u5348" ? 12 : 0)).padStart(2, "0")}:${m[6]}:${m[7]}+08:00`;
}
function parseDgpa(html) {
  const header = [...html.matchAll(/<div\b([^>]*)>/gi)].find((m) => attr(m[1], "class").split(/\s+/).includes("Header_YMD"));
  const date = header && /^(\d{2,3})年\s*(\d{1,2})月\s*(\d{1,2})日\s*天然災害停止上班及上課情形$/.exec(text(html.slice(header.index + header[0].length).split(/<\/div\s*>/i)[0]));
  const update = /更新時間\s*[：:]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d\d):(\d\d):(\d\d)/.exec(text(html));
  if (!date || !update) throw Error("\u4EBA\u4E8B\u884C\u653F\u7E3D\u8655\u9801\u9762\u65E5\u671F\u6216\u66F4\u65B0\u6642\u9593\u7121\u6CD5\u8FA8\u8B58");
  const pageDate = `${+date[1] + 1911}-${date[2].padStart(2, "0")}-${date[3].padStart(2, "0")}`, updatedAt = `${update[1]}-${update[2].padStart(2, "0")}-${update[3].padStart(2, "0")}T${update[4]}:${update[5]}:${update[6]}+08:00`;
  if (!validDay(pageDate) || !timestamp(updatedAt)) throw Error("\u4EBA\u4E8B\u884C\u653F\u7E3D\u8655\u65E5\u671F\u7121\u6548");
  const body = [...html.matchAll(/<tbody\b([^>]*)>([\s\S]*?)<\/tbody\s*>/gi)].find((m) => attr(m[1], "class").split(/\s+/).includes("Table_Body"))?.[2];
  if (!body) throw Error("\u4EBA\u4E8B\u884C\u653F\u7E3D\u8655\u7F3A\u5C11 Table_Body");
  const result = { updatedAt, pageDate, layout: "flat", noEvent: false, counties: {} };
  const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)];
  if (body.replace(/<!--[\s\S]*?-->/g, "").replace(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi, "").trim()) throw Error("\u4EBA\u4E8B\u884C\u653F\u7E3D\u8655\u8868\u683C\u6709\u672A\u8FA8\u8B58\u5167\u5BB9");
  for (const [i, row] of rows.entries()) {
    const cells = [...row[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td\s*>/gi)];
    if (row[1].replace(/<!--[\s\S]*?-->/g, "").replace(/<td\b[^>]*>[\s\S]*?<\/td\s*>/gi, "").trim()) throw Error("\u4EBA\u4E8B\u884C\u653F\u7E3D\u8655\u8868\u683C\u5217\u7121\u6CD5\u8FA8\u8B58");
    if (i === rows.length - 1 && cells.length === 1 && attr(cells[0][1], "colspan") === "3" && /^(?:備註[：:]\s*)?1\.若欲進入本總處網站/.test(text(cells[0][2]))) continue;
    if (cells.some((c) => /\bcity_Region\b/.test(attr(c[1], "headers")))) result.layout = "regional";
    const data = cells.filter((c) => !/\bcity_Region\b/.test(attr(c[1], "headers")));
    if (data.length === 1 && /\bcity_Name\b/.test(attr(data[0][1], "headers")) && attr(data[0][1], "colspan") === "2" && text(data[0][2]) === "\u7121\u505C\u73ED\u505C\u8AB2\u8A0A\u606F\u3002" && !result.noEvent) {
      result.noEvent = true;
      continue;
    }
    if (data.length !== 2 || !/\bcity_Name\b/.test(attr(data[0][1], "headers"))) throw Error("\u4EBA\u4E8B\u884C\u653F\u7E3D\u8655\u8868\u683C\u5217\u7121\u6CD5\u8FA8\u8B58");
    const county = canonical(text(data[0][2]));
    const lines = data[1][2].split(/<br\b[^>]*>/i).map((v) => clean(text(v), 300)).filter(Boolean);
    if (!counties.includes(county) || Object.hasOwn(result.counties, county) || !lines.length || lines.length > 20) throw Error("\u4EBA\u4E8B\u884C\u653F\u7E3D\u8655\u7E23\u5E02\u6216\u516C\u544A\u5217\u7121\u6CD5\u8FA8\u8B58");
    result.counties[county] = lines;
  }
  if (result.noEvent ? Object.keys(result.counties).length > 0 : !Object.keys(result.counties).length) throw Error("\u4EBA\u4E8B\u884C\u653F\u7E3D\u8655\u516C\u544A\u5167\u5BB9\u77DB\u76FE\u6216\u7A7A\u767D");
  if (result.noEvent) result.layout = "none";
  return result;
}
var LoginRequired = class extends Error {
  constructor() {
    super("\u8ACB\u5148\u767B\u5165\u6703\u54E1\u3002");
  }
};
function warning(s) {
  if (s.includes("\u8ACB\u5148\u767B\u5165\u6703\u54E1")) throw new LoginRequired();
  if (/WarningMessage|"Warning"\s*:/i.test(s)) throw Error("NCDR \u4F86\u6E90\u56DE\u50B3\u8B66\u544A");
}
function xml(s, root) {
  warning(s);
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw Error("NCDR XML \u683C\u5F0F\u932F\u8AA4");
  const stack = [];
  let roots = 0, end = 0;
  const input = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g, "");
  for (const m of input.matchAll(/<([^>]+)>/g)) {
    const between = input.slice(end, m.index);
    if (between.includes("<") || !stack.length && between.trim()) throw Error("NCDR XML \u683C\u5F0F\u932F\u8AA4");
    end = m.index + m[0].length;
    const t = m[1], name = /^\/?([\w:.-]+)/.exec(t)?.[1];
    if (!name) throw Error("NCDR XML \u683C\u5F0F\u932F\u8AA4");
    if (t[0] === "/") {
      if (stack.pop() !== name) throw Error("NCDR XML \u683C\u5F0F\u932F\u8AA4");
    } else {
      if (!stack.length) {
        if (name.split(":").pop() !== root || roots++) throw Error("NCDR XML \u683C\u5F0F\u932F\u8AA4");
      }
      if (!/\/\s*$/.test(t)) stack.push(name);
    }
  }
  if (!roots || stack.length || input.slice(end).trim() || !new RegExp(`<(?:[\\w-]+:)?${root}\\b`).test(input) || input.replace(/<[^>]+>/g, "").includes("<")) throw Error("NCDR XML \u683C\u5F0F\u932F\u8AA4");
}
var mentionPattern;
var mentionOwners;
function mentioned(s) {
  if (!mentionPattern) {
    const owners = /* @__PURE__ */ new Map();
    for (const [county, names] of Object.entries(districts)) for (const name of names) {
      const full = canonical(name), stem = full.replace(/[鄉鎮市區]$/, "");
      for (const key of [full, ...stem.length >= 2 ? [stem] : []]) {
        if (!owners.has(key)) owners.set(key, /* @__PURE__ */ new Set());
        owners.get(key).add(county);
      }
    }
    mentionOwners = new Map([...owners].filter(([, cs]) => cs.size === 1).map(([name, cs]) => [name, [...cs][0]]));
    for (const county of counties) mentionOwners.set(county, county);
    mentionPattern = new RegExp([...mentionOwners.keys()].sort((a, b) => b.length - a.length).join("|"), "g");
  }
  const matched = /* @__PURE__ */ new Set();
  for (const match of canonical(s).matchAll(mentionPattern)) matched.add(mentionOwners.get(match[0]));
  return counties.filter((c) => matched.has(c));
}
function entry(v, retainedIds) {
  if (typeof v.id !== "string" || !v.id || typeof v.title !== "string" || !v.title || v.summary !== void 0 && typeof v.summary !== "string" && (!object(v.summary) || typeof v.summary["#text"] !== "string") || typeof v.status !== "string" || typeof v.msgType !== "string") throw Error("NCDR \u544A\u8B66\u9805\u76EE\u683C\u5F0F\u932F\u8AA4");
  const summary = text(typeof v.summary === "string" ? v.summary : v.summary?.["#text"] ?? "");
  const links = Array.isArray(v.link) ? v.link : [v.link], link = links.find((l) => object(l) && typeof l["@href"] === "string" && l["@href"].includes(".cap"))?.["@href"] ?? links.find((l) => object(l) && typeof l["@href"] === "string")?.["@href"];
  if (!link || !/^https?:\/\//.test(link)) throw Error("NCDR \u544A\u8B66\u9023\u7D50\u683C\u5F0F\u932F\u8AA4");
  const effective = v.effective ? ncdrTime(v.effective) : void 0, expires = v.expires ? ncdrTime(v.expires) : void 0;
  if (v.effective && !effective || v.expires && !expires) throw Error("NCDR \u544A\u8B66\u6642\u9593\u683C\u5F0F\u932F\u8AA4");
  return { id: v.id, type: clean(v.category?.["@term"] || v.title, 40), title: clean(v.title, 200), sender: clean(v.author?.name, 100), ...effective ? { effective } : {}, ...expires ? { expires } : {}, counties: retainedIds?.has(v.id) ? [] : mentioned(summary), text: clean(summary, 400), link: safeLink(link), detail: false, complete: false, status: v.status, msgType: v.msgType };
}
function feed(updated, entries, now) {
  if (!timestamp(updated)) throw Error("NCDR \u7F3A\u5C11\u6709\u6548\u4F86\u6E90\u66F4\u65B0\u6642\u9593");
  if (now && Date.parse(updated) - now.getTime() > 5 * 6e4) throw Error("NCDR \u8CC7\u6599\u6642\u9593\u7570\u5E38");
  if (now && now.getTime() - Date.parse(updated) > 24 * 36e5) throw Error("NCDR \u4F86\u6E90\u66F4\u65B0\u6642\u9593\u5DF2\u8D85\u904E 24 \u5C0F\u6642");
  if (new Set(entries.map((e) => e.id)).size !== entries.length) throw Error("NCDR \u544A\u8B66\u8B58\u5225\u78BC\u91CD\u8907");
  return { updated, entries: entries.filter((e) => e.status === "Actual" && e.msgType !== "Cancel") };
}
function parseNcdrJson(s, now, retainedIds) {
  warning(s);
  const v = JSON.parse(s);
  if (!object(v) || typeof v.id !== "string" || !v.id.trim() || typeof v.title !== "string" || !v.title.trim() || v.author?.name !== "NCDR" || v.entry !== void 0 && v.entry !== null && !Array.isArray(v.entry) && !object(v.entry)) throw Error("NCDR feed \u683C\u5F0F\u932F\u8AA4");
  const entries = v.entry == null ? [] : Array.isArray(v.entry) ? v.entry : [v.entry];
  if (entries.some((e) => !object(e))) throw Error("NCDR \u544A\u8B66\u683C\u5F0F\u932F\u8AA4");
  return feed(v.updated, entries.map((e) => entry(e, retainedIds)), now);
}
function parseNcdrAtom(s, now, retainedIds) {
  xml(s, "feed");
  const body = tag(s, "feed"), entries = tags(body, "entry");
  if ([...body.matchAll(/<(?:[\w-]+:)?entry\b/gi)].length !== entries.length) throw Error("NCDR \u544A\u8B66\u683C\u5F0F\u932F\u8AA4");
  const header = body.replace(/<(?:[\w-]+:)?entry\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?entry\s*>/gi, "");
  if (!text(tag(header, "id")) || !text(tag(header, "title")) || text(tag(tag(header, "author"), "name")) !== "NCDR") throw Error("NCDR feed \u683C\u5F0F\u932F\u8AA4");
  return feed(text(tag(header, "updated")), entries.map((e) => entry({ id: text(tag(e, "id")), title: text(tag(e, "title")), author: { name: text(tag(tag(e, "author"), "name")) }, summary: { "#text": tag(e, "summary") }, link: [...e.matchAll(/<link\b([^>]*)\/?\s*>/gi)].map((m) => ({ "@href": attr(m[1], "href") })), category: { "@term": attr(/<category\b([^>]*)/i.exec(e)?.[1] ?? "", "term") }, status: text(tag(e, "status")), msgType: text(tag(e, "msgType")), effective: text(tag(e, "effective")), expires: text(tag(e, "expires")) }, retainedIds)), now);
}
var geocodeCounties = {
  "10002": "\u5B9C\u862D\u7E23",
  "10004": "\u65B0\u7AF9\u7E23",
  "10005": "\u82D7\u6817\u7E23",
  "10007": "\u5F70\u5316\u7E23",
  "10008": "\u5357\u6295\u7E23",
  "10009": "\u96F2\u6797\u7E23",
  "10010": "\u5609\u7FA9\u7E23",
  "10013": "\u5C4F\u6771\u7E23",
  "10014": "\u81FA\u6771\u7E23",
  "10015": "\u82B1\u84EE\u7E23",
  "10016": "\u6F8E\u6E56\u7E23",
  "10017": "\u57FA\u9686\u5E02",
  "10018": "\u65B0\u7AF9\u5E02",
  "10020": "\u5609\u7FA9\u5E02",
  "09007": "\u9023\u6C5F\u7E23",
  "09020": "\u91D1\u9580\u7E23",
  "63": "\u81FA\u5317\u5E02",
  "64": "\u9AD8\u96C4\u5E02",
  "65": "\u65B0\u5317\u5E02",
  "66": "\u81FA\u4E2D\u5E02",
  "67": "\u81FA\u5357\u5E02",
  "68": "\u6843\u5712\u5E02"
};
function geocodeCounty(value) {
  if (!/^\d+$/.test(value)) return;
  return geocodeCounties[value.slice(0, 5)] ?? geocodeCounties[value.slice(0, 2)];
}
var capAreaPattern = /<(?:[\w-]+:)?area\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?area\s*>/gi;
var capAreaDescPattern = /<(?:[\w-]+:)?areaDesc\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?areaDesc\s*>/i;
var capGeocodePattern = /<(?:[\w-]+:)?geocode\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?geocode\s*>/gi;
var capValueNamePattern = /<(?:[\w-]+:)?valueName\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?valueName\s*>/i;
var capValuePattern = /<(?:[\w-]+:)?value\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?value\s*>/i;
var countyPrefixPattern = new RegExp(`^(?:${counties.join("|")})`);
function parseCap(s) {
  xml(s, "alert");
  const body = tag(s, "alert"), info = tags(body, "info").find((i) => /^zh/i.test(text(tag(i, "language")))) || tag(body, "info");
  const id = text(tag(body, "identifier")), type = text(tag(info, "event")), severity = text(tag(info, "severity"));
  if (!id || !type || !severities.includes(severity) || !text(tag(body, "status")) || !text(tag(body, "msgType"))) throw Error("CAP \u5167\u5BB9\u683C\u5F0F\u932F\u8AA4");
  const times = {};
  for (const key of ["effective", "onset", "expires"]) {
    const v = text(tag(info, key));
    if (v && !timestamp(v)) throw Error("CAP \u6642\u9593\u683C\u5F0F\u932F\u8AA4");
    if (v) times[key] = v;
  }
  const covered = /* @__PURE__ */ new Set(), areas = [], areaCounties = [];
  let areaCount = 0, complete = true;
  for (const [, area] of info.matchAll(capAreaPattern)) {
    areaCount++;
    const original = text(capAreaDescPattern.exec(area)?.[1] ?? "");
    const prefix = countyPrefixPattern.exec(canonical(original))?.[0];
    let scoped = prefix ? [prefix] : [];
    for (const [, geocode] of area.matchAll(capGeocodePattern)) {
      if (text(capValueNamePattern.exec(geocode)?.[1] ?? "") !== "Taiwan_Geocode_103") continue;
      const county = geocodeCounty(text(capValuePattern.exec(geocode)?.[1] ?? ""));
      if (county && !scoped.includes(county)) scoped.push(county);
    }
    if (!scoped.length) complete = false;
    if (scoped.length > 1) scoped = counties.filter((c) => scoped.includes(c));
    for (const county of scoped) covered.add(county);
    if (original && scoped.length && areas.length < 200) {
      areas.push(clean(original, 100));
      areaCounties.push(scoped);
    }
  }
  const matched = counties.filter((c) => covered.has(c));
  const parameters = Object.fromEntries(tags(info, "parameter").map((p) => [text(tag(p, "valueName")), text(tag(p, "value"))]));
  return { id, type: clean(type, 40), title: clean(text(tag(info, "headline")), 200), sender: clean(text(tag(info, "senderName")), 100), complete: areaCount > 0 && complete, severity, ...times, ...parameters.severity_level ? { level: clean(parameters.severity_level, 60) } : {}, ...parameters.alert_color ? { color: clean(parameters.alert_color, 20) } : {}, counties: matched, areas, areaCounties, text: clean(text(tag(info, "description")), 400), web: text(tag(info, "web")) || official2.ncdr, status: text(tag(body, "status")), msgType: text(tag(body, "msgType")) };
}

// src/core/disaster/collect.ts
var reason = (e, token) => (token ? String(e instanceof Error ? e.message : e).replaceAll(token, "[redacted]") : String(e instanceof Error ? e.message : e)).replace(/https?:\/\/[^\s]+/gi, "[url]").replace(/(?:Bearer\s+)[^\s]+/gi, "Bearer [redacted]").replace(/(?:token|key|secret)=\S+/gi, "[redacted]").replace(/\s+/g, " ").slice(0, 200);
function quietDelayMs(date) {
  const ms = date.getUTCMinutes() % 10 * 6e4 + date.getUTCSeconds() * 1e3 + date.getUTCMilliseconds();
  return ms >= 4.5 * 6e4 && ms < 7 * 6e4 ? 7 * 6e4 - ms : 0;
}
var responseTimes = /* @__PURE__ */ new WeakMap();
var changed = (a, b) => ["ok", "closed", "sha", "reason", "empty", "skipped"].some((k) => a?.[k] !== b?.[k]);
var version = (a, b) => {
  for (const key of ["sourceUpdatedAt", "lastSuccessAt", "fetchedAt"]) {
    const x = a?.[key] && (key !== "fetchedAt" || a.ok) ? Date.parse(a[key]) : -Infinity;
    const y = b?.[key] && (key !== "fetchedAt" || b.ok) ? Date.parse(b[key]) : -Infinity;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
};
var mergeState = (ours, latest) => {
  if (!ours || !latest) return ours ?? latest;
  const attempt = (latest.fetchedAt ? Date.parse(latest.fetchedAt) : -Infinity) > (ours.fetchedAt ? Date.parse(ours.fetchedAt) : -Infinity) ? latest : ours;
  const evidence = version(latest, ours) > 0 ? latest : ours;
  if (attempt.ok) return evidence;
  const { ok: _ok, closed: _closed, skipped: _skipped, reason: _reason, fetchedAt: _fetchedAt, ...success } = evidence;
  return { ...success, ok: attempt.ok, closed: attempt.closed, skipped: attempt.skipped, reason: attempt.reason, fetchedAt: attempt.fetchedAt };
};
var sameState = (a, b) => a === b || !!a && !!b && Object.keys({ ...a, ...b }).every((key) => a[key] === b[key]);
async function collectDisaster(o) {
  const now = o.now ?? (() => /* @__PURE__ */ new Date()), started = now().getTime(), scheduled = o.scheduledAt ?? started;
  const guardEnd = Math.floor(scheduled / 6e5) * 6e5 + 7 * 6e4;
  const raw = await o.store.get(indexKey2(o.writer));
  let stored = null;
  if (raw !== null) {
    try {
      stored = decodeIndex2(raw);
    } catch {
      o.warn?.(`disaster ${o.writer} \u7D22\u5F15\u7121\u6CD5\u89E3\u8B80\uFF0C\u91CD\u65B0\u5EFA\u7ACB`);
    }
  }
  const previous = stored ?? { v: 1, writer: o.writer, heartbeatAt: new Date(started).toISOString(), sources: {} };
  if (previous.writer !== o.writer) throw Error("\u707D\u9632\u7D22\u5F15\u5BEB\u5165\u8005\u4E0D\u7B26");
  let peer = null;
  if (o.peerIndex) {
    try {
      peer = await o.peerIndex();
    } catch {
    }
  }
  const heartbeatDue = !stored || started - Date.parse(previous.heartbeatAt) >= 55 * 6e4;
  const index = { v: 1, writer: o.writer, heartbeatAt: previous.heartbeatAt, sources: { ...previous.sources }, ...previous.budget ? { budget: previous.budget } : {} };
  const shards = /* @__PURE__ */ new Map();
  let writes = 0, exitCode = 0, finished = responseTimes.get(o.store);
  async function request(url) {
    if (finished !== void 0) {
      const delay = finished + 3100 - now().getTime();
      if (delay > 0) await o.sleep(delay);
    }
    if (o.quietWindow) {
      const delay = quietDelayMs(now());
      if (delay) await o.sleep(delay);
    }
    if (o.ncdrDeadlineMs !== void 0 && now().getTime() - scheduled >= o.ncdrDeadlineMs || o.scheduledAt !== void 0 && now().getTime() >= guardEnd) throw Error("NCDR \u672C\u8F2A\u8ACB\u6C42\u6642\u9593\u5DF2\u7528\u5B8C");
    try {
      const response = await o.fetchText(url);
      if (response.text.includes("\u8ACB\u5148\u767B\u5165\u6703\u54E1")) throw new LoginRequired();
      if (response.status !== 200) throw Error(`NCDR HTTP ${response.status}`);
      return response.text;
    } finally {
      finished = now().getTime();
      responseTimes.set(o.store, finished);
    }
  }
  async function ncdr(old) {
    const detailed = /* @__PURE__ */ new Map();
    for (const state of [old, peer?.sources.ncdr]) {
      if (!state?.sha) continue;
      try {
        const raw2 = await o.store.get(shardKey2("ncdr", state.sha));
        if (raw2) {
          for (const item of decodeAlerts(raw2)) if (item.detail && item.complete !== void 0 && item.areaCounties !== void 0) detailed.set(item.id, item);
        }
      } catch {
      }
    }
    const retainedIds = new Set(detailed.keys());
    const emptyError = () => Error("NCDR \u56DE\u50B3 0 \u7B46\u544A\u8B66\uFF0C\u7121\u6CD5\u78BA\u8A8D\u70BA\u6709\u6548\u7A7A\u6E05\u55AE");
    let feed2, primary, login = 0, failure;
    for (const [i, url] of feedUrls.entries()) {
      try {
        const parsed = (i === 0 ? parseNcdrJson : parseNcdrAtom)(await request(url), now(), retainedIds);
        if (i === 0) {
          primary = parsed;
          if (parsed.entries.length) {
            feed2 = parsed;
            break;
          }
        } else {
          if (primary && !parsed.entries.length && !primary.entries.length) {
            feed2 = { ...parsed, updated: Date.parse(primary.updated) < Date.parse(parsed.updated) ? primary.updated : parsed.updated };
          } else if (!primary && parsed.entries.length) feed2 = parsed;
          else throw emptyError();
        }
      } catch (e) {
        if (e instanceof LoginRequired) login++;
        failure = e;
      }
    }
    if (!feed2) {
      if (login === 2) throw new LoginRequired();
      if (primary && !primary.entries.length) throw emptyError();
      throw Error(failure instanceof LoginRequired ? "NCDR \u5099\u63F4\u4F86\u6E90\u7121\u6CD5\u53D6\u5F97" : reason(failure, o.token));
    }
    const data = feed2.entries.map((e) => {
      const { status: _status, msgType: _msgType, ...base } = e;
      return detailed.get(e.id) ?? base;
    });
    const pending = feed2.entries.flatMap((e, i) => {
      if (detailed.has(e.id)) return [];
      return e.link !== official2.ncdr && safeLink(e.link) === e.link ? [i] : [];
    });
    const offset = pending.length ? Math.floor(started / 6e5) * o.maxCaps % pending.length : 0;
    for (let n = 0; n < Math.min(o.maxCaps, pending.length); n++) {
      const i = pending[(offset + n) % pending.length], e = feed2.entries[i], base = data[i];
      if (o.ncdrDeadlineMs === void 0 || now().getTime() - scheduled < o.ncdrDeadlineMs) {
        try {
          const body = await request(e.link);
          if (new TextEncoder().encode(body).length > 256 * 1024) throw Error("CAP \u8D85\u904E\u5927\u5C0F\u4E0A\u9650");
          const cap = parseCap(body);
          if (cap.id !== e.id) throw Error("CAP \u8B58\u5225\u78BC\u4E0D\u7B26");
          if (cap.status !== "Actual" || cap.msgType === "Cancel") {
            data[i] = null;
            continue;
          }
          const { status: _s, msgType: _m, onset: _o, web: _w, ...detail } = cap;
          data[i] = { ...detail, ...detail.effective || base.effective ? { effective: detail.effective ?? base.effective } : {}, ...detail.expires || base.expires ? { expires: detail.expires ?? base.expires } : {}, link: e.link, detail: true };
        } catch (e2) {
          if (e2 instanceof LoginRequired) throw e2;
        }
      }
    }
    const usable = data.filter((e) => e !== null);
    if (!usable.length && feed2.entries.length) throw emptyError();
    return { data: usable, updated: feed2.updated };
  }
  for (const source of sources) {
    if (o.only && !o.only.includes(source)) continue;
    const old = previous.sources[source], peerState = peer?.sources[source];
    const current = now().getTime();
    if (o.writer === "gha" && peer?.writer === "worker" && peerState?.ok === true && !peerState.skipped && !peerState.closed && peerState.sha && peerState.lastSuccessAt && peerState.sourceUpdatedAt && current - Date.parse(peerState.lastSuccessAt) >= 0 && current - Date.parse(peerState.lastSuccessAt) < 25 * 6e4 && (source === "ncdr" ? current - Date.parse(peerState.sourceUpdatedAt) <= 24 * 36e5 : current - Date.parse(peerState.sourceUpdatedAt) < 90 * 6e4) && Date.parse(peerState.sourceUpdatedAt) - current <= 5 * 6e4) {
      try {
        const raw2 = await o.store.get(shardKey2(source, peerState.sha)), data = raw2 === null ? null : decodeShard2(raw2, source);
        if (data && (Array.isArray(data) ? data.length : Object.keys(data.counties).length) === peerState.count) {
          index.sources[source] = { ...old ?? { ok: false }, skipped: true };
          continue;
        }
      } catch {
      }
    }
    try {
      let data, updated, count;
      if (source === "dgpa") {
        const response = await o.fetchText(official2.dgpa);
        if (response.status !== 200) throw Error(`\u4EBA\u4E8B\u884C\u653F\u7E3D\u8655 HTTP ${response.status}`);
        const { updatedAt, ...snapshot } = parseDgpa(response.text);
        data = snapshot;
        updated = updatedAt;
        count = Object.keys(snapshot.counties).length;
      } else {
        const result = await ncdr(old);
        data = result.data;
        updated = result.updated;
        count = result.data.length;
      }
      if (old?.sha && old.sourceUpdatedAt && Date.parse(updated) < Date.parse(old.sourceUpdatedAt)) throw Error("\u4F86\u6E90\u66F4\u65B0\u6642\u9593\u5012\u9000");
      if (peerState?.sha && peerState.sourceUpdatedAt && Date.parse(updated) < Date.parse(peerState.sourceUpdatedAt)) {
        index.sources[source] = { ...old ?? { ok: false }, skipped: true, reason: "\u5C0D\u65B9\u5DF2\u6709\u8F03\u65B0\u4F86\u6E90\u7248\u672C" };
        continue;
      }
      const encoded = JSON.stringify(data), digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded)), sha = [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("").slice(0, 12);
      const fetchedAt = now().toISOString();
      index.sources[source] = { ok: true, fetchedAt, lastSuccessAt: fetchedAt, sourceUpdatedAt: updated, sha, count, writtenAt: old?.writtenAt ?? fetchedAt, ...source === "ncdr" && count === 0 ? { empty: true } : {} };
      shards.set(source, { encoded, sha });
    } catch (e) {
      const closed = e instanceof LoginRequired;
      index.sources[source] = { ...old, ok: false, skipped: false, closed, reason: reason(e, o.token), fetchedAt: now().toISOString() };
      if (closed ? !old?.closed : old?.ok || !old?.lastSuccessAt || now().getTime() - Date.parse(old.lastSuccessAt) > 864e5) exitCode = 1;
    }
  }
  const needsIndex = () => sources.some((s) => changed(previous.sources[s], index.sources[s])) || heartbeatDue && sources.some((s) => index.sources[s] && !index.sources[s]?.skipped && (!o.only || o.only.includes(s)));
  const mustRecord = (base) => sources.some((s) => {
    const state = index.sources[s], old = base.sources[s];
    return (!o.only || o.only.includes(s)) && state?.ok === false && !state.skipped && (old?.ok !== false || !!old.closed !== !!state.closed);
  });
  const recheck = !needsIndex() && sources.some((s) => (!o.only || o.only.includes(s)) && index.sources[s]?.ok === false && !index.sources[s]?.skipped);
  if (needsIndex() || recheck) {
    for (const [source, shard] of shards) {
      const old = previous.sources[source];
      if (old?.sha === shard.sha && old.writtenAt && now().getTime() - Date.parse(old.writtenAt) <= 3 * 864e5) shards.delete(source);
    }
    const publicationAt = now().toISOString();
    const refill = (saved) => o.budget ? Math.min(o.budget.burst, (saved?.tokens ?? o.budget.burst) + o.budget.perHour * Math.max(0, Date.parse(publicationAt) - Date.parse(saved?.at ?? publicationAt)) / 36e5) : Infinity;
    const reread = async () => {
      try {
        const raw2 = await o.store.get(indexKey2(o.writer));
        if (raw2 !== null) {
          const decoded = decodeIndex2(raw2);
          if (decoded.writer === o.writer) return decoded;
        }
      } catch {
      }
      return null;
    };
    const beforeShards = await reread();
    if (recheck) {
      if (!beforeShards || !sources.some((s) => {
        const state = index.sources[s], old = beforeShards.sources[s], merged = mergeState(state, old);
        return (!o.only || o.only.includes(s)) && state?.ok === false && !state.skipped && merged?.ok === false && (old?.ok !== merged.ok || !!old.closed !== !!merged.closed);
      })) return { index: previous, previous, writes, exitCode };
      shards.clear();
    }
    let tokens = Infinity;
    if (o.budget) {
      tokens = refill(previous.budget);
      if (beforeShards?.budget && Date.parse(beforeShards.budget.at) > Date.parse(previous.budget?.at ?? "1970-01-01")) tokens = Math.min(tokens, refill(beforeShards.budget));
      if (tokens < shards.size + 1) {
        (o.warn ?? console.warn)("disaster KV \u9810\u7B97\u4E0D\u8DB3\uFF0C\u5EF6\u5F8C\u767C\u5E03");
        let available = tokens - 1;
        for (const [source] of shards) {
          if (available >= 1) {
            available--;
            continue;
          }
          shards.delete(source);
          if (previous.sources[source]) index.sources[source] = previous.sources[source];
          else delete index.sources[source];
        }
        if (tokens < 1 && !(mustRecord(beforeShards ?? previous) && tokens >= 0)) {
          if (mustRecord(beforeShards ?? previous)) {
            (o.warn ?? console.warn)("disaster failure state cannot be recorded: KV overdraft exhausted");
            exitCode = 1;
          }
          return { index: beforeShards ?? previous, previous, writes, exitCode };
        }
        if (!needsIndex() && !recheck) return { index: previous, previous, writes, exitCode };
      }
    }
    index.heartbeatAt = new Date(started).toISOString();
    let shardAttempts = 0;
    for (const [source, shard] of shards) {
      shardAttempts++;
      try {
        await o.store.put(shardKey2(source, shard.sha), shard.encoded, 8 * 86400);
        writes++;
        index.sources[source].writtenAt = now().toISOString();
      } catch (e) {
        index.sources[source] = { ...previous.sources[source], ok: false, skipped: false, closed: false, reason: reason(e, o.token), fetchedAt: now().toISOString() };
        exitCode = 1;
      }
    }
    let latest = null;
    for (const observed of [beforeShards, await reread()]) {
      if (!observed) continue;
      latest ??= { ...observed, sources: { ...observed.sources } };
      for (const source of sources) {
        const saved = mergeState(latest.sources[source], observed.sources[source]);
        if (saved) latest.sources[source] = saved;
        const merged = mergeState(index.sources[source], observed.sources[source]);
        if (merged) index.sources[source] = merged;
      }
      if (observed.budget && Date.parse(observed.budget.at) > Date.parse(previous.budget?.at ?? "1970-01-01")) tokens = Math.min(tokens, refill(observed.budget));
      if (observed.budget && Date.parse(observed.budget.at) > Date.parse(latest.budget?.at ?? "1970-01-01")) latest.budget = observed.budget;
      if (Date.parse(observed.heartbeatAt) > Date.parse(latest.heartbeatAt)) latest.heartbeatAt = observed.heartbeatAt;
    }
    if (latest) {
      const oursNewer = sources.some((s) => !sameState(index.sources[s], latest.sources[s]));
      const heartbeatNeeded = started - Date.parse(latest.heartbeatAt) >= 55 * 6e4 && sources.some((s) => index.sources[s] && !index.sources[s]?.skipped && (!o.only || o.only.includes(s)));
      if (!shardAttempts && !oursNewer && !heartbeatNeeded) return { index: latest, previous, writes, exitCode };
      if (Date.parse(latest.heartbeatAt) > Date.parse(index.heartbeatAt)) index.heartbeatAt = latest.heartbeatAt;
    }
    if (o.budget) {
      const charged = tokens - shardAttempts - 1;
      if (!shardAttempts && charged < 0 && !(mustRecord(latest ?? previous) && charged >= -1)) {
        (o.warn ?? console.warn)("disaster KV \u9810\u7B97\u4E0D\u8DB3\uFF0C\u5EF6\u5F8C\u767C\u5E03");
        if (mustRecord(latest ?? previous)) {
          (o.warn ?? console.warn)("disaster failure state cannot be recorded: KV overdraft exhausted");
          exitCode = 1;
        }
        return { index: latest ?? previous, previous, writes, exitCode };
      }
      index.budget = { tokens: Math.max(-1, charged), at: latest?.budget && Date.parse(latest.budget.at) > Date.parse(publicationAt) ? latest.budget.at : publicationAt };
    }
    try {
      await o.store.put(indexKey2(o.writer), JSON.stringify(index));
      writes++;
    } catch {
      return { index: latest ?? previous, previous, writes, exitCode: 1 };
    }
    return { index, previous, writes, exitCode };
  }
  return { index: previous, previous, writes, exitCode };
}

// src/core/disaster/http.ts
async function fetchText(url, timeoutMs) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  const reader = response.body?.getReader(), decoder = new TextDecoder();
  let size = 0, text2 = "";
  if (reader) try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw Error("\u4F86\u6E90\u56DE\u61C9\u8D85\u904E\u5927\u5C0F\u4E0A\u9650");
      text2 += decoder.decode(value, { stream: true });
    }
    text2 += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {
    });
  }
  return { status: response.status, text: text2 };
}

// scripts/publish-disaster.ts
async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length && (args.length !== 2 || args[0] !== "--out" || !args[1]?.trim())) {
    console.error("Usage: publish-disaster [--out dir]");
    return 2;
  }
  if (!args[1] && ["CLOUDFLARE_ACCOUNT_ID", "KV_NAMESPACE_ID", "CLOUDFLARE_KV_WRITE_TOKEN"].some((k) => !env[k]?.trim())) {
    console.error("disaster KV configuration missing");
    return 2;
  }
  const backing = args[1] ? directoryStore(args[1]) : kvStore(env);
  const store = { get: (key) => backing.get(key), put: (key, value, ttl) => backing.put(key, value, (/* @__PURE__ */ new Date()).toISOString(), ttl) };
  try {
    const result = await collectDisaster({ writer: "gha", ...args[1] ? {} : { budget: { perHour: 1.5, burst: 6 } }, store, token: env.CLOUDFLARE_KV_WRITE_TOKEN, fetchText: (url) => fetchText(url, 3e4), sleep: (ms) => new Promise((resolve2) => setTimeout(resolve2, ms)), maxCaps: 20, quietWindow: true, peerIndex: async () => {
      const raw = await store.get(indexKey2("worker"));
      return raw ? decodeIndex2(raw) : null;
    } });
    for (const [source, state] of Object.entries(result.index.sources)) {
      const message = `disaster ${source} ok=${state.ok} skipped=${!!state.skipped} count=${state.count ?? 0}${state.reason ? ` reason=${reason(state.reason, env.CLOUDFLARE_KV_WRITE_TOKEN)}` : ""}`;
      if (!state.ok && !state.skipped) console.warn(message);
      else console.log(message);
    }
    console.log(`disaster KV writes=${result.writes}`);
    return result.exitCode;
  } catch (e) {
    console.error(`disaster publication failed: ${reason(e, env.CLOUDFLARE_KV_WRITE_TOKEN)}`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
export {
  main
};
