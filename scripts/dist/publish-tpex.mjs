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
    const code = r[codeKey]?.trim(), date2 = parseRocDate(r.Date ?? "");
    if (!code || !date2) return [];
    const ratio = byCode.get(code) ?? {}, n = (key) => parseNumber(r[key]);
    const ratioDate = parseRocDate(ratio.Date ?? "");
    const change = n("Change"), note = r.Change?.trim();
    return [{
      market,
      code,
      name: r[tw ? "Name" : "CompanyName"],
      date: date2,
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
      ...ratioDate && (ratioDate.year !== date2.year || ratioDate.month !== date2.month || ratioDate.day !== date2.day) ? { ratioDate } : {}
    }];
  });
}
function parseDividends(data, market) {
  const tw = market === "\u4E0A\u5E02";
  return stockRows(data).flatMap((r) => {
    const date2 = parseRocDate(r[tw ? "Date" : "ExRrightsExDividendDate"] ?? "");
    const type = (r[tw ? "Exdividend" : "ExRrightsExDividend"] ?? "").trim().replace(/^除/, "");
    if (!date2 || !["\u606F", "\u6B0A", "\u6B0A\u606F"].includes(type)) return [];
    const positive = (key) => {
      const n = parseNumber(r[key]);
      return n !== null && n > 0 ? n : null;
    };
    const subscription = (key) => r[key]?.trim() === "\u5C1A\u672A\u516C\u544A" ? "\u5C1A\u672A\u516C\u544A" : positive(key);
    return [{
      market,
      code: r[tw ? "Code" : "SecuritiesCompanyCode"],
      name: r[tw ? "Name" : "CompanyName"],
      date: date2,
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
var marketUrls = {
  fmtqik: "https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK",
  margn: "https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN",
  tpexIndex: "https://www.tpex.org.tw/openapi/v1/tpex_daily_trading_index",
  tpexMargin: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance"
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
function encodeQuotesSnapshot({ updatedAt, rows: rows2 }) {
  const date2 = rows2[0]?.date, market = rows2[0]?.market;
  const sameDate = (row) => row.date.year === date2?.year && row.date.month === date2.month && row.date.day === date2.day;
  const keys2 = [...quoteKeys];
  if (rows2.some((row) => !sameDate(row))) keys2.push("date");
  if (rows2.some((row) => row.changeNote !== void 0)) keys2.push("changeNote");
  if (rows2.some((row) => row.ratioDate !== void 0)) keys2.push("ratioDate");
  return JSON.stringify({ v: 3, d: { updatedAt, market, date: date2, k: keys2, r: rows2.map((row) => {
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
var keys = { invoice: "invoice:v1", marketSummary: "stock:market:v1", twseQuotes: "stock:quotes:twse:v1", tpexQuotes: "stock:quotes:tpex:v1", twseDividends: "stock:dividends:twse:v1", tpexDividends: "stock:dividends:tpex:v1" };
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

// src/core/stock/format.ts
var dateKey = (d) => d.year * 1e4 + d.month * 100 + d.day;

// src/core/stock/market.ts
function rows(body, minimum = 1) {
  const result = stockRows(body);
  if (result.length < minimum) throw new Error(`\u5927\u76E4\u8CC7\u6599\u7B46\u6578\u4E0D\u8DB3\uFF1A${result.length} < ${minimum}`);
  return result;
}
function numeric(row, key, blankZero = false) {
  const value = blankZero && row[key]?.trim() === "" ? 0 : parseNumber(row[key]);
  if (value === null || blankZero && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`\u5927\u76E4\u8CC7\u6599\u6B04\u4F4D\u4E0D\u6B63\u78BA\uFF1A${key}`);
  return value;
}
function date(row) {
  const result = parseRocDate(row.Date ?? "");
  if (!result) throw new Error("\u5927\u76E4\u8CC7\u6599\u65E5\u671F\u4E0D\u6B63\u78BA");
  return result;
}
function index(body, twse) {
  const data = rows(body);
  const latest = data.reduce((a, b) => dateKey(date(a)) >= dateKey(date(b)) ? a : b);
  const block = { dataDate: date(latest), taiex: numeric(latest, twse ? "TAIEX" : "TPExIndex"), change: numeric(latest, "Change"), value: numeric(latest, twse ? "TradeValue" : "TradeAmount") };
  for (const row of data) {
    date(row);
    for (const key of twse ? ["TAIEX", "Change", "TradeValue", "TradeVolume", "Transaction"] : ["TPExIndex", "Change", "TradeAmount", "TradeVolume", "NumberOfTransactions"]) numeric(row, key);
  }
  if (block.taiex <= 0 || block.taiex - block.change <= 0 || block.value < 0) throw new Error("\u5927\u76E4\u6307\u6578\u6216\u6210\u4EA4\u91D1\u984D\u4E0D\u6B63\u78BA");
  return block;
}
function margin(body, twse, dataDate) {
  const data = rows(body, twse ? 100 : 50);
  const fields = twse ? ["\u878D\u8CC7\u524D\u65E5\u9918\u984D", "\u878D\u8CC7\u4ECA\u65E5\u9918\u984D", "\u878D\u5238\u524D\u65E5\u9918\u984D", "\u878D\u5238\u4ECA\u65E5\u9918\u984D"] : ["MarginPurchaseBalancePreviousDay", "MarginPurchaseBalance", "ShortSaleBalancePreviousDay", "ShortSaleBalance"];
  const totals = fields.map((key) => data.reduce((sum, row) => sum + numeric(row, key, true), 0));
  if (!twse) for (const row of data) date(row);
  return { date: dataDate, dateConfirmed: true, financePrev: totals[0], finance: totals[1], shortPrev: totals[2], short: totals[3] };
}
function twseMarginReason(dataDate, fmtqik, margn) {
  const a = fmtqik ? Date.parse(fmtqik) : NaN, b = margn ? Date.parse(margn) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "FMTQIK \u6216 MI_MARGN \u7F3A\u5C11\u53EF\u89E3\u6790\u7684 Last-Modified \u6A19\u982D\u3002";
  const close = Date.UTC(dataDate.year, dataDate.month - 1, dataDate.day, 6, 30);
  if (a < close || b < close) return "FMTQIK \u6216 MI_MARGN \u7684 Last-Modified \u65E9\u65BC\u6307\u6578\u8CC7\u6599\u65E5\u53F0\u5317\u6642\u9593 14:30\u3002";
  if (Math.abs(b - a) > 6 * 36e5) return b < a ? "MI_MARGN \u7684 Last-Modified \u6BD4 FMTQIK \u820A\u8D85\u904E 6 \u5C0F\u6642\u3002" : "MI_MARGN \u7684 Last-Modified \u6BD4 FMTQIK \u65B0\u8D85\u904E 6 \u5C0F\u6642\u3002";
}
function buildMarketSummary(input, previous) {
  const errors = [];
  const build = (twse2) => {
    const old = twse2 ? previous?.twse : previous?.tpex;
    try {
      const block = index(twse2 ? input.fmtqik : input.tpexIndex, twse2);
      const body = twse2 ? input.margn : input.tpexMargin;
      const totals = margin(body, twse2, block.dataDate);
      const reason2 = twse2 ? twseMarginReason(block.dataDate, input.fmtqikLastModified, input.margnLastModified) : rows(body).some((row) => dateKey(date(row)) !== dateKey(block.dataDate)) ? "\u4E0A\u6AC3\u878D\u8CC7\u5238\u5404\u7B46\u65E5\u671F\u672A\u5168\u90E8\u7B49\u65BC\u4E0A\u6AC3\u6307\u6578\u8CC7\u6599\u65E5\u671F\u3002" : void 0;
      if (reason2) {
        block.marginReason = reason2;
        if (old?.margin?.dateConfirmed) block.margin = old.margin;
      } else block.margin = totals;
      return block;
    } catch (error) {
      errors.push(`${twse2 ? "\u4E0A\u5E02" : "\u4E0A\u6AC3"}\uFF1A${error instanceof Error ? error.message : String(error)}`);
      return old;
    }
  };
  const twse = build(true), tpex = build(false);
  if (!twse && !tpex) throw new Error(errors.join("\uFF1B"));
  return { ...twse ? { twse } : {}, ...tpex ? { tpex } : {}, fetchedAt: input.fetchedAt ?? previous?.fetchedAt ?? "" };
}

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
    const rows2 = stockRows(result.body);
    if (feed === "tpex-ratios" && rows2.length < minimumRows.tpex) {
      throw new Error(`too few ratios rows: ${rows2.length} < ${minimumRows.tpex}`);
    }
    if (!rows2.length) throw new Error("empty array");
    for (const row of rows2) for (const field of required[feed]) {
      if (typeof row[field] !== "string" || !row[field].trim()) throw new Error(`missing required field ${field}`);
    }
    if (feed !== "tpex-div") {
      let dataDate = "";
      for (const row of rows2) {
        const date2 = parseRocDate(row.Date);
        if (!date2) throw new Error(`invalid Date: ${row.Date}`);
        const iso = `${String(date2.year).padStart(4, "0")}-${String(date2.month).padStart(2, "0")}-${String(date2.day).padStart(2, "0")}`;
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
  try {
    let oldSummary, oldValue;
    const old = previous?.keys[keys.marketSummary];
    if (old) {
      try {
        if (old.file !== "stock_market_v1.json") throw new Error("unexpected file");
        oldValue = await readFile(join(previousDir ?? outDir, old.file), "utf8");
        if (createHash("sha256").update(oldValue).digest("hex") !== old.sha256) throw new Error("changed previous summary");
        oldSummary = JSON.parse(oldValue);
      } catch {
        console.warn("market summary previous snapshot unavailable");
      }
    }
    const results2 = await Promise.allSettled(Object.entries(marketUrls).map(async ([feed, url]) => {
      const result = await fetchStockFeed(feed, url, void 0, { retryDelayMs });
      if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
      return result;
    }));
    const data = results2.map((r) => r.status === "fulfilled" ? r.value : void 0);
    const summary = buildMarketSummary({
      fmtqik: data[0]?.body,
      margn: data[1]?.body,
      fmtqikLastModified: data[0]?.validators.lastModified,
      margnLastModified: data[1]?.validators.lastModified,
      tpexIndex: data[2]?.body,
      tpexMargin: data[3]?.body,
      fetchedAt: generatedAt
    }, oldSummary);
    for (const market of ["twse", "tpex"]) {
      if (!summary[market] || summary[market] === oldSummary?.[market]) console.warn(`market summary ${market} failed; retaining previous data if available`);
    }
    const unchanged = oldSummary && JSON.stringify({ ...summary, fetchedAt: "" }) === JSON.stringify({ ...oldSummary, fetchedAt: "" });
    const encoded = unchanged ? oldValue : JSON.stringify(summary);
    const file = "stock_market_v1.json", sha256 = createHash("sha256").update(encoded).digest("hex");
    await atomicWrite(join(outDir, file), encoded);
    manifest.keys[keys.marketSummary] = {
      file,
      dataDate: null,
      rows: Number(!!summary.twse) + Number(!!summary.tpex),
      bytes: new TextEncoder().encode(encoded).length,
      sha256,
      updatedAt: unchanged ? old.updatedAt : generatedAt
    };
    manifest.written.push(keys.marketSummary);
  } catch {
    console.warn("market summary collection failed; retaining previous data if available");
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
    return [keys.tpexQuotes, keys.tpexDividends].every((key) => manifest.written.includes(key)) ? 0 : 1;
  } catch (error) {
    console.error(`tpex collect fail: ${reason(error)}`);
    return 1;
  }
}
if (process.argv[1] && /^collect-tpex\.(ts|js)$/.test(basename(process.argv[1])) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();

// scripts/publish-tpex.ts
var requiredEnv = ["CLOUDFLARE_ACCOUNT_ID", "KV_NAMESPACE_ID", "CLOUDFLARE_KV_WRITE_TOKEN"];
var tpexKeys = [keys.tpexQuotes, keys.tpexDividends, keys.marketSummary];
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
    let skipSummary = false;
    const previous = { v: 1, market: "tpex", generatedAt: now.toISOString(), written: [], failures: [], keys: {} };
    for (const key of tpexKeys) {
      try {
        const response = await request(key);
        if (response.status === 404) continue;
        if (response.status !== 200) {
          if (key === keys.marketSummary) {
            console.warn(`market summary KV read HTTP ${response.status}; skipping summary publication`);
            skipSummary = true;
            continue;
          }
          console.error(`kv read ${key} HTTP ${response.status}`);
          return 1;
        }
        const value = await response.text();
        let rows2, dataDate = null;
        try {
          if (key === keys.tpexQuotes) {
            const snapshot = decodeQuotesSnapshot(value);
            rows2 = snapshot.rows.length;
            dataDate = snapshot.rows.map(({ date: date2 }) => {
              const { year, month, day } = date2;
              if (![year, month, day].every(Number.isInteger)) throw new Error("invalid date");
              return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            }).sort().at(-1) ?? null;
            if (!dataDate) throw new Error("missing date");
          } else if (key === keys.marketSummary) {
            const summary = JSON.parse(value);
            if (!summary || !summary.twse && !summary.tpex) throw new Error("missing markets");
            rows2 = Number(!!summary.twse) + Number(!!summary.tpex);
          } else {
            const snapshot = decodeSnapshot(value);
            if (!Array.isArray(snapshot.rows)) throw new Error("missing rows");
            rows2 = snapshot.rows.length;
          }
        } catch {
          console.warn(`kv read ${key} invalid snapshot; treating as absent`);
          continue;
        }
        const file = `${key.replaceAll(":", "_")}.json`;
        await writeFile2(join2(previousDir, file), value, "utf8");
        previous.keys[key] = { file, dataDate, rows: rows2, bytes: new TextEncoder().encode(value).length, sha256: hash(value), updatedAt: "" };
      } catch {
        if (key === keys.marketSummary) {
          console.warn("market summary KV read failed; skipping summary publication");
          skipSummary = true;
        } else {
          console.error(`kv read ${key} failed`);
          return 1;
        }
      }
    }
    outDir ??= await mkdtemp(join2(tmpdir(), "tpex-"));
    const manifest = await collectTpex({ outDir, previous, previousDir, now });
    let failed = manifest.failures.length > 0;
    for (const key of manifest.written) {
      if (key === keys.marketSummary && skipSummary) continue;
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
          if (key !== keys.marketSummary) failed = true;
          const errors = Array.isArray(result?.errors) ? result.errors.map((error) => `${error.code}:${error.message}`).join(" ") : "";
          (key === keys.marketSummary ? console.warn : console.error)(`kv put ${key} HTTP ${response.status}${errors ? ` ${errors.replaceAll(token, "[redacted]").replace(/\s+/g, " ")}` : ""}`);
        }
      } catch {
        if (key === keys.marketSummary) console.warn(`kv put ${key} failed`);
        else {
          failed = true;
          console.error(`kv put ${key} failed`);
        }
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
