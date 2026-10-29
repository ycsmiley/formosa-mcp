// scripts/publish-tpex.ts
import { createHash as createHash2 } from "node:crypto";
import { mkdtemp, readFile as readFile2, rm as rm2, writeFile as writeFile2 } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join2, resolve as resolve2 } from "node:path";
import { pathToFileURL as pathToFileURL2 } from "node:url";

// src/core/clock.ts
var formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  hourCycle: "h23"
});

// src/core/stock/parse.ts
function parseNumber(s) {
  if (typeof s !== "string") return null;
  const value = s.replace(/[\s,]/g, "").replace(/^\+/, "");
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && Number.isFinite(+value) ? +value : null;
}
function parseRocDate(s) {
  if (!/^\d{7}$/.test(s)) return null;
  const year = +s.slice(0, 3) + 1911, month = +s.slice(3, 5), day = +s.slice(5);
  const d = new Date(Date.UTC(year, month - 1, day));
  return year > 1911 && d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month && d.getUTCDate() === day ? { year, month, day } : null;
}
function stockRows(data) {
  if (!Array.isArray(data) || data.some((r) => !r || typeof r !== "object" || Object.values(r).some((v) => typeof v !== "string"))) throw new Error("\u80A1\u7968\u8CC7\u6599\u683C\u5F0F\u4E0D\u6B63\u78BA");
  return data;
}
function parseQuotes(data, ratios, market) {
  const tw = market === "\u4E0A\u5E02", codeKey = tw ? "Code" : "SecuritiesCompanyCode";
  const byCode = new Map(stockRows(ratios).map((r) => [r[codeKey], r]));
  return stockRows(data).flatMap((r) => {
    const code = r[codeKey]?.trim(), date = parseRocDate(r.Date ?? "");
    if (!code || !date) return [];
    const ratio = byCode.get(code) ?? {}, n = (key) => parseNumber(r[key]);
    const ratioDate = parseRocDate(ratio.Date ?? "");
    const change = n("Change"), note = r.Change?.trim();
    return [{
      market,
      code,
      name: r[tw ? "Name" : "CompanyName"],
      date,
      open: n(tw ? "OpeningPrice" : "Open"),
      high: n(tw ? "HighestPrice" : "High"),
      low: n(tw ? "LowestPrice" : "Low"),
      close: n(tw ? "ClosingPrice" : "Close"),
      change,
      ...change === null && note?.startsWith("\u9664") ? { changeNote: note } : {},
      volumeShares: n(tw ? "TradeVolume" : "TradingShares"),
      value: n(tw ? "TradeValue" : "TransactionAmount"),
      pe: parseNumber(ratio[tw ? "PEratio" : "PriceEarningRatio"]),
      yield: parseNumber(ratio[tw ? "DividendYield" : "YieldRatio"]),
      pb: parseNumber(ratio[tw ? "PBratio" : "PriceBookRatio"]),
      ...ratioDate && (ratioDate.year !== date.year || ratioDate.month !== date.month || ratioDate.day !== date.day) ? { ratioDate } : {}
    }];
  });
}
function parseDividends(data, market) {
  const tw = market === "\u4E0A\u5E02";
  return stockRows(data).flatMap((r) => {
    const date = parseRocDate(r[tw ? "Date" : "ExRrightsExDividendDate"] ?? "");
    const type = (r[tw ? "Exdividend" : "ExRrightsExDividend"] ?? "").trim().replace(/^除/, "");
    if (!date || !["\u606F", "\u6B0A", "\u6B0A\u606F"].includes(type)) return [];
    const positive = (key) => {
      const n = parseNumber(r[key]);
      return n !== null && n > 0 ? n : null;
    };
    const subscription = (key) => r[key]?.trim() === "\u5C1A\u672A\u516C\u544A" ? "\u5C1A\u672A\u516C\u544A" : positive(key);
    return [{
      market,
      code: r[tw ? "Code" : "SecuritiesCompanyCode"],
      name: r[tw ? "Name" : "CompanyName"],
      date,
      type: `\u9664${type}`,
      cash: parseNumber(r.CashDividend),
      stockRatio: positive("StockDividendRatio"),
      subscriptionRatio: subscription(tw ? "SubscriptionRatio" : "SubscriptionRatioToNewSharesIssued"),
      subscriptionPrice: subscription("SubscriptionPricePerShare")
    }];
  });
}

// src/core/stock/source.ts
var stockUrls = {
  "twse-quotes": "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
  "twse-ratios": "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL",
  "twse-div": "https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL",
  "tpex-quotes": "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes",
  "tpex-ratios": "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis",
  "tpex-div": "https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost"
};

// src/core/snapshot.ts
async function buildStockSnapshot(market, fetchJson, clock = () => /* @__PURE__ */ new Date()) {
  const updatedAt = clock().toISOString(), label = market === "twse" ? "\u4E0A\u5E02" : "\u4E0A\u6AC3";
  async function build(parse) {
    try {
      return { updatedAt, rows: await parse() };
    } catch {
      return null;
    }
  }
  const [quotes, dividends] = await Promise.all([
    build(async () => {
      const [q, r] = await Promise.all([fetchJson(stockUrls[`${market}-quotes`]), fetchJson(stockUrls[`${market}-ratios`])]);
      return parseQuotes(q, r, label);
    }),
    build(async () => parseDividends(await fetchJson(stockUrls[`${market}-div`]), label))
  ]);
  return { quotes, dividends };
}
var quoteKeys = ["code", "name", "open", "high", "low", "close", "change", "volumeShares", "value", "pe", "yield", "pb"];
function encodeQuotesSnapshot({ updatedAt, rows }) {
  const date = rows[0]?.date, market = rows[0]?.market;
  const sameDate = (row) => row.date.year === date?.year && row.date.month === date.month && row.date.day === date.day;
  const keys2 = [...quoteKeys];
  if (rows.some((row) => !sameDate(row))) keys2.push("date");
  if (rows.some((row) => row.changeNote !== void 0)) keys2.push("changeNote");
  if (rows.some((row) => row.ratioDate !== void 0)) keys2.push("ratioDate");
  return JSON.stringify({ v: 3, d: { updatedAt, market, date, k: keys2, r: rows.map((row) => {
    const values = keys2.map((k) => k === "date" && sameDate(row) ? null : row[k] ?? null);
    while (values.length && values.at(-1) === null) values.pop();
    return values;
  }) } });
}
function decodeQuotesSnapshot(encoded) {
  const data = JSON.parse(encoded);
  if (data.v !== 3 || !data.d || !Array.isArray(data.d.k) || !Array.isArray(data.d.r)) throw new Error("Invalid quotes snapshot");
  const table = data.d;
  return { updatedAt: table.updatedAt, rows: table.r.map((row) => {
    const quote = { market: table.market, date: table.date };
    table.k.forEach((key, i) => {
      if ((key === "date" || key === "changeNote" || key === "ratioDate") && row[i] == null) return;
      quote[key] = row[i] ?? null;
    });
    return quote;
  }) };
}
function encodeSnapshot(snapshot) {
  return JSON.stringify({ v: 1, d: snapshot }, (_key, value) => {
    if (Array.isArray(value) && value.length && value.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
      const keys2 = [...new Set(value.flatMap(Object.keys))];
      return { k: keys2, r: value.map((r) => keys2.map((k) => r[k] ?? null)) };
    }
    return value;
  });
}
function decodeSnapshot(encoded) {
  const data = JSON.parse(encoded);
  if (data.v !== 1 || !data.d || typeof data.d !== "object") throw new Error("Invalid snapshot");
  function unpack(value) {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value.k) && Array.isArray(value.r)) {
      return value.r.map((row) => Object.fromEntries(value.k.map((key, i) => [key, unpack(row[i])])));
    }
    if (Array.isArray(value)) return value.map(unpack);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unpack(item)]));
  }
  return unpack(data.d);
}

// src/worker/snapshot-keys.ts
var keys = { invoice: "invoice:v1", twseQuotes: "stock:quotes:twse:v1", tpexQuotes: "stock:quotes:tpex:v1", twseDividends: "stock:dividends:twse:v1", tpexDividends: "stock:dividends:tpex:v1" };
var collectKeys = { tpex: "stock:collect:tpex:v1" };
var minimumRows = { twse: 100, tpex: 50, invoice: 1 };
var isQuotes = (key) => key === keys.twseQuotes || key === keys.tpexQuotes;
function encodeStoredSnapshot(key, snapshot) {
  const stable = { ...snapshot, updatedAt: "" };
  return isQuotes(key) ? encodeQuotesSnapshot(stable) : encodeSnapshot(stable);
}

// scripts/collect-tpex.ts
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

// src/worker/stock-source.ts
function conditionalHeaders(validators = {}) {
  return {
    ...validators.etag ? { "If-None-Match": validators.etag } : {},
    ...validators.lastModified ? { "If-Modified-Since": validators.lastModified } : {}
  };
}
async function readBoundedBody(response) {
  let body = "";
  try {
    const reader = response.body?.getReader(), decoder = new TextDecoder();
    if (reader) try {
      for (let remaining = 1024; remaining > 0; ) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value.subarray(0, remaining);
        body += decoder.decode(chunk, { stream: true });
        remaining -= chunk.byteLength;
      }
      body += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {
      });
    }
  } catch {
  }
  return body;
}
async function fetchStockFeed(feed, url, validators, { retryDelayMs = 1500 } = {}) {
  const started = Date.now(), deadline = started + 45e3, signal = AbortSignal.timeout(45e3);
  const headers = { "User-Agent": "formosa-mcp (+https://github.com/ycsmiley/formosa-mcp)", Accept: "application/json", ...conditionalHeaders(validators) };
  const { host, pathname } = new URL(url);
  const clean = (text) => text.replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/g, "$1").replace(/\s+/g, " ").trim();
  for (let attempt = 0; ; attempt++) {
    let response, bodyText, retryable = false;
    try {
      try {
        response = await fetch(url, { signal, headers, redirect: "manual" });
      } catch (error) {
        retryable = true;
        throw error;
      }
      if (response.status === 304) return { status: 304 };
      if (response.status !== 200) {
        retryable = response.status === 429 || response.status >= 500 && response.status <= 599;
        throw new Error(`HTTP ${response.status}`);
      }
      const contentType = response.headers.get("Content-Type");
      if (contentType !== null && !contentType.toLowerCase().includes("json")) throw new Error(`Unexpected content-type: ${contentType}`);
      const etag = response.headers.get("ETag"), lastModified = response.headers.get("Last-Modified");
      bodyText = await response.text();
      return { status: 200, body: JSON.parse(bodyText), validators: {
        ...etag ? { etag } : {},
        ...lastModified ? { lastModified } : {}
      } };
    } catch (error) {
      if (attempt === 0 && retryable && !signal.aborted && Date.now() + retryDelayMs < deadline) {
        await response?.body?.cancel().catch(() => {
        });
        if (retryDelayMs > 0) await new Promise((resolve3) => setTimeout(resolve3, Math.min(retryDelayMs, Math.max(0, deadline - Date.now()))));
        if (!signal.aborted && Date.now() < deadline) continue;
      }
      let detail;
      if (response) {
        const body = clean(bodyText ?? await readBoundedBody(response)).slice(0, 200);
        detail = `status=${response.status}`;
        if (response.status >= 300 && response.status <= 399) {
          let location = "none";
          try {
            const header = response.headers.get("Location");
            if (header) {
              const target = new URL(header, url);
              location = target.host + target.pathname;
            }
          } catch {
          }
          detail += ` location=${location} set-cookie=${response.headers.has("Set-Cookie") ? "yes" : "no"}`;
        }
        detail += ` body=${JSON.stringify(body)}`;
        if (response.status === 200) detail += ` error=${clean(error instanceof Error ? `${error.name}: ${error.message}` : String(error))}`;
      } else detail = `error=${clean(error instanceof Error ? `${error.name}: ${error.message}` : String(error))}`;
      console.warn(`stock feed fail ${feed.split("-")[0]} ${feed} ${host}${pathname} ${detail} ms=${Date.now() - started}`);
      throw error;
    }
  }
}

// scripts/collect-tpex.ts
var feeds = ["tpex-quotes", "tpex-ratios", "tpex-div"];
var required = {
  "tpex-quotes": ["Date", "SecuritiesCompanyCode", "CompanyName", "Close"],
  "tpex-ratios": ["Date", "SecuritiesCompanyCode"],
  "tpex-div": ["ExRrightsExDividendDate", "SecuritiesCompanyCode", "CompanyName", "ExRrightsExDividend"]
};
var reason = (error) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
async function atomicWrite(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, value, "utf8");
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}
async function collectTpex({ outDir, previous, previousDir, now = /* @__PURE__ */ new Date(), retryDelayMs = 1500 }) {
  const generatedAt = now.toISOString();
  const manifest = { v: 1, market: "tpex", generatedAt, written: [], failures: [], keys: { ...previous?.keys } };
  const bodies = /* @__PURE__ */ new Map(), dates = /* @__PURE__ */ new Map();
  function fail(key, feed, error) {
    const failure = { key, feed, reason: reason(error) };
    manifest.failures.push(failure);
    console.warn(`tpex collect fail ${key} ${feed}: ${failure.reason}`);
  }
  const results = await Promise.allSettled(feeds.map(async (feed) => {
    const result = await fetchStockFeed(feed, stockUrls[feed], void 0, { retryDelayMs });
    if (result.status !== 200) throw new Error(`HTTP ${result.status}; expected 200`);
    const rows = stockRows(result.body);
    if (feed === "tpex-ratios" && rows.length < minimumRows.tpex) {
      throw new Error(`too few ratios rows: ${rows.length} < ${minimumRows.tpex}`);
    }
    if (!rows.length) throw new Error("empty array");
    for (const row of rows) for (const field of required[feed]) {
      if (typeof row[field] !== "string" || !row[field].trim()) throw new Error(`missing required field ${field}`);
    }
    if (feed !== "tpex-div") {
      let dataDate = "";
      for (const row of rows) {
        const date = parseRocDate(row.Date);
        if (!date) throw new Error(`invalid Date: ${row.Date}`);
        const iso = `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
        if (iso > dataDate) dataDate = iso;
      }
      const previousDate = previous?.keys[keys.tpexQuotes]?.dataDate;
      if (previousDate && dataDate < previousDate) throw new Error(`stale date ${dataDate} < ${previousDate}`);
      dates.set(feed, dataDate);
    }
    bodies.set(stockUrls[feed], result.body);
  }));
  results.forEach((result, i) => {
    if (result.status === "rejected") fail(feeds[i] === "tpex-div" ? keys.tpexDividends : keys.tpexQuotes, feeds[i], result.reason);
  });
  const snapshots = await buildStockSnapshot("tpex", async (url) => {
    if (!bodies.has(url)) throw new Error("invalid feed");
    return bodies.get(url);
  }, () => now);
  await mkdir(outDir, { recursive: true });
  for (const kind of ["quotes", "dividends"]) {
    const key = kind === "quotes" ? keys.tpexQuotes : keys.tpexDividends;
    if (manifest.failures.some((failure) => failure.key === key)) continue;
    const snapshot = snapshots[kind], feed = kind === "quotes" ? "tpex-quotes" : "tpex-div";
    try {
      if (!snapshot) throw new Error("no snapshot");
      const minimum = kind === "quotes" ? minimumRows.tpex : 1;
      if (snapshot.rows.length < minimum) throw new Error(`too few parsed rows: ${snapshot.rows.length} < ${minimum}`);
      const encoded = encodeStoredSnapshot(key, snapshot), file = `${key.replaceAll(":", "_")}.json`;
      const sha256 = createHash("sha256").update(encoded, "utf8").digest("hex");
      const old = previous?.keys[key];
      const entry = {
        file,
        dataDate: kind === "quotes" ? dates.get("tpex-quotes") : null,
        rows: snapshot.rows.length,
        bytes: new TextEncoder().encode(encoded).length,
        sha256,
        updatedAt: old?.sha256 === sha256 ? old.updatedAt : generatedAt
      };
      await atomicWrite(join(outDir, file), encoded);
      manifest.keys[key] = entry;
      manifest.written.push(key);
      console.log(`tpex collect ok ${key} ${entry.bytes} bytes dataDate=${entry.dataDate}`);
    } catch (error) {
      fail(key, feed, error);
    }
  }
  for (const [key, entry] of Object.entries(manifest.keys)) {
    if (manifest.written.includes(key)) continue;
    try {
      if (entry.file !== `${key.replaceAll(":", "_")}.json`) throw new Error("unexpected file");
      const file = join(outDir, entry.file);
      let bytes;
      try {
        bytes = await readFile(file);
      } catch (error) {
        if (error.code !== "ENOENT" || !previousDir) throw error;
        await atomicWrite(file, await readFile(join(previousDir, entry.file)));
        bytes = await readFile(file);
      }
      if (createHash("sha256").update(bytes).digest("hex") === entry.sha256) continue;
    } catch {
    }
    delete manifest.keys[key];
    console.warn(`tpex collect drop ${key}: previous file missing or changed`);
  }
  await atomicWrite(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
async function main(args = process.argv.slice(2)) {
  let outDir = "out/tpex", previousPath;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!["--out", "--previous"].includes(flag) || !value || value.startsWith("--")) {
      console.error("Usage: collect-tpex [--out <dir>] [--previous <manifest.json>]");
      return 2;
    }
    if (flag === "--out") outDir = value;
    else previousPath = value;
  }
  let previous;
  if (previousPath) {
    try {
      const parsed = JSON.parse(await readFile(previousPath, "utf8"));
      if (parsed?.v !== 1 || parsed.market !== "tpex" || !parsed.keys || typeof parsed.keys !== "object" || Array.isArray(parsed.keys)) throw new Error("invalid manifest");
      previous = parsed;
    } catch {
      console.warn("tpex collect previous manifest unavailable; treating as no previous");
    }
  }
  try {
    const manifest = await collectTpex({ outDir, previous, previousDir: previousPath ? dirname(previousPath) : void 0 });
    return manifest.written.length === 2 ? 0 : 1;
  } catch (error) {
    console.error(`tpex collect fail: ${reason(error)}`);
    return 1;
  }
}
if (process.argv[1] && /^collect-tpex\.(ts|js)$/.test(basename(process.argv[1])) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();

// scripts/publish-tpex.ts
var requiredEnv = ["CLOUDFLARE_ACCOUNT_ID", "KV_NAMESPACE_ID", "CLOUDFLARE_KV_WRITE_TOKEN"];
var tpexKeys = [keys.tpexQuotes, keys.tpexDividends];
var hash = (value) => createHash2("sha256").update(value, "utf8").digest("hex");
async function publishTpex({ outDir, env = process.env, now = /* @__PURE__ */ new Date() } = {}) {
  const missing = requiredEnv.filter((name) => !env[name]);
  if (missing.length) {
    console.error(missing.join("\n"));
    return 2;
  }
  const token = env.CLOUDFLARE_KV_WRITE_TOKEN;
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${env.KV_NAMESPACE_ID}`;
  const request = (key, init = {}) => fetch(`${base}/values/${encodeURIComponent(key)}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3e4),
    redirect: "manual"
  });
  let previousDir;
  try {
    previousDir = await mkdtemp(join2(tmpdir(), "tpex-previous-"));
    const previous = { v: 1, market: "tpex", generatedAt: now.toISOString(), written: [], failures: [], keys: {} };
    for (const key of tpexKeys) {
      let response;
      try {
        response = await request(key);
      } catch {
        console.error(`kv read ${key} failed`);
        return 1;
      }
      if (response.status === 404) continue;
      if (response.status !== 200) {
        console.error(`kv read ${key} HTTP ${response.status}`);
        return 1;
      }
      const value = await response.text();
      let rows, dataDate = null;
      try {
        if (key === keys.tpexQuotes) {
          const snapshot = decodeQuotesSnapshot(value);
          rows = snapshot.rows.length;
          dataDate = snapshot.rows.map(({ date }) => {
            const { year, month, day } = date;
            if (![year, month, day].every(Number.isInteger)) throw new Error("invalid date");
            return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          }).sort().at(-1) ?? null;
          if (!dataDate) throw new Error("missing date");
        } else {
          const snapshot = decodeSnapshot(value);
          if (!Array.isArray(snapshot.rows)) throw new Error("missing rows");
          rows = snapshot.rows.length;
        }
      } catch {
        console.warn(`kv read ${key} invalid snapshot; treating as absent`);
        continue;
      }
      const file = `${key.replaceAll(":", "_")}.json`;
      await writeFile2(join2(previousDir, file), value, "utf8");
      previous.keys[key] = { file, dataDate, rows, bytes: new TextEncoder().encode(value).length, sha256: hash(value), updatedAt: "" };
    }
    outDir ??= await mkdtemp(join2(tmpdir(), "tpex-"));
    const manifest = await collectTpex({ outDir, previous, previousDir, now });
    let failed = manifest.failures.length > 0;
    for (const key of manifest.written) {
      const entry = manifest.keys[key];
      if (entry.sha256 === previous.keys[key]?.sha256) {
        console.log(`kv skip ${key} unchanged`);
        continue;
      }
      try {
        const value = await readFile2(join2(outDir, entry.file), "utf8");
        const body = new FormData();
        body.set("value", value);
        body.set("metadata", JSON.stringify({ updatedAt: entry.updatedAt }));
        const response = await request(key, { method: "PUT", body });
        const result = await response.json().catch(() => null);
        if (response.status === 200 && result?.success === true) {
          console.log(`kv put ${key} ${entry.bytes} bytes dataDate=${entry.dataDate} updatedAt=${entry.updatedAt}`);
        } else {
          failed = true;
          const errors = Array.isArray(result?.errors) ? result.errors.map((error) => `${error.code}:${error.message}`).join(" ") : "";
          console.error(`kv put ${key} HTTP ${response.status}${errors ? ` ${errors.replaceAll(token, "[redacted]").replace(/\s+/g, " ")}` : ""}`);
        }
      } catch {
        failed = true;
        console.error(`kv put ${key} failed`);
      }
    }
    if (!failed && manifest.written.includes(keys.tpexQuotes)) {
      const lastSuccessAt = now.toISOString(), dataDate = manifest.keys[keys.tpexQuotes].dataDate;
      try {
        const response = await request(collectKeys.tpex, { method: "PUT", body: JSON.stringify({ v: 1, lastSuccessAt, dataDate }) });
        const result = await response.json().catch(() => null);
        if (response.status === 200 && result?.success === true) console.log(`kv heartbeat lastSuccessAt=${lastSuccessAt} dataDate=${dataDate}`);
        else {
          failed = true;
          console.error(`kv put ${collectKeys.tpex} HTTP ${response.status}`);
        }
      } catch {
        failed = true;
        console.error(`kv put ${collectKeys.tpex} failed`);
      }
    }
    return failed ? 1 : 0;
  } catch {
    console.error("tpex publish failed");
    return 1;
  } finally {
    if (previousDir) await rm2(previousDir, { recursive: true, force: true });
  }
}
async function main2(args = process.argv.slice(2)) {
  let outDir;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] !== "--out" || !args[i + 1] || args[i + 1].startsWith("--")) {
      console.error("Usage: publish-tpex [--out <dir>]");
      return 2;
    }
    outDir = args[i + 1];
  }
  return publishTpex({ outDir });
}
if (process.argv[1] && import.meta.url === pathToFileURL2(resolve2(process.argv[1])).href) process.exitCode = await main2();
export {
  main2 as main,
  publishTpex
};
