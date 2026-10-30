// scripts/publish-rail.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// src/core/rail/client.ts
var unavailable = "TDX \u670D\u52D9\u66AB\u6642\u7121\u6CD5\u4F7F\u7528\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66";
var railRowLimit = 1e3;
var RailError = class extends Error {
};
var object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
var string = (value) => typeof value === "string" ? value.trim() : "";
var list = (value) => {
  if (!Array.isArray(value)) throw new RailError(unavailable);
  return value;
};
var defaultTdxBase = "https://tdx.transportdata.tw";
var tokenPath = "/auth/realms/TDXConnect/protocol/openid-connect/token";
function tdxBase(value) {
  try {
    const url = new URL(value ?? "");
    if (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && !url.username && !url.password) return url.origin;
  } catch {
  }
  return defaultTdxBase;
}
function tdxApiUrl(path, base = defaultTdxBase, query = {}) {
  return `${base}/api/basic${path}?$format=JSON&$top=${railRowLimit}${Object.entries(query).map(([key, value]) => `&${key}=${encodeURIComponent(value)}`).join("")}`;
}
function tokenBody(credentials) {
  return new URLSearchParams({ grant_type: "client_credentials", client_id: credentials.clientId, client_secret: credentials.clientSecret }).toString();
}

// src/core/rail/time.ts
var taipeiFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});
function taipeiNow(date) {
  const parts = Object.fromEntries(taipeiFormatter.formatToParts(date).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: +parts.hour * 60 + +parts.minute };
}
function minutes(value) {
  if (typeof value !== "string") return void 0;
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m || +m[1] > 23 || +m[2] > 59 || m[3] && +m[3] > 59) return void 0;
  return +m[1] * 60 + +m[2];
}

// src/core/rail/budget.ts
function quota(value) {
  const n = typeof value === "string" && !/^\d+$/.test(value) ? NaN : Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 4500 ? n : 4500;
}
function snapshotReserve(value, monthlyQuota = 4500) {
  const n = value === void 0 || value.trim() === "" ? 300 : Number(value);
  return Math.min(quota(monthlyQuota), Math.max(0, Number.isFinite(n) ? Math.floor(n) : 300));
}

// src/core/rail/snapshot.ts
var stationKey = (railway) => `rail:stations:${railway}:v1`;
var timetableKey = (railway, date) => `rail:timetable:${railway}:${date}:v1`;
var flag = (value) => typeof value === "number" && [0, 1, 2].includes(value) ? value : 0;
var zh = (value) => string(object(value).Zh_tw);
var header = (date, fetchedAt, truncated) => ({ v: 1, date, fetchedAt, truncated });
function compactStations(railway, body, fetchedAt) {
  const rows = list(railway === "THSR" ? body : object(body).Stations);
  const stations = rows.map((value) => {
    const row = object(value);
    return [string(row.StationID), zh(row.StationName), string(object(row.StationName).En)];
  });
  if (!stations.length || stations.some(([id, name]) => !/^[A-Za-z0-9_-]+$/.test(id) || !name)) throw new RailError(unavailable);
  return { ...header(taipeiNow(new Date(fetchedAt)).date, fetchedAt, rows.length === 1e3), stations };
}
function compactTimetable(railway, body, date, fetchedAt, truncated = false) {
  const rows = list(railway === "THSR" ? body : object(body).TrainTimetables);
  const trains = rows.map((value) => {
    const row = object(value), info = object(railway === "THSR" ? row.DailyTrainInfo : row.TrainInfo);
    const stops = list(row.StopTimes).map(object).sort((a, b) => Number(a.StopSequence) - Number(b.StopSequence)).map((stop) => [string(stop.StationID), string(stop.ArrivalTime), string(stop.DepartureTime), flag(stop.SuspendedFlag)]);
    if (!/^\d+$/.test(string(info.TrainNo)) || stops.length < 2 || stops.some(([id, arr, dep]) => !/^[A-Za-z0-9_-]+$/.test(id) || minutes(arr) === void 0 && minutes(dep) === void 0)) throw new RailError(unavailable);
    return { no: string(info.TrainNo), type: zh(info.TrainTypeName), end: zh(info.EndingStationName), suspended: flag(info.SuspendedFlag), extra: flag(info.ExtraTrainFlag), overnight: info.Overnight === true, cross: string(info.OverNightStationID), stops };
  });
  if (!trains.length) throw new RailError(unavailable);
  return { ...header(date, fetchedAt, truncated), trains };
}

// src/core/clock.ts
var formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  hourCycle: "h23"
});

// src/worker/snapshot-keys.ts
var snapshotUsageKey = (month) => `tdx:snapshot-usage:${month}`;

// scripts/publish-rail.ts
var filename = (key) => key.replaceAll(":", "_");
function directoryStore(dir) {
  return {
    async get(key) {
      try {
        return await readFile(join(dir, `${filename(key)}.json`), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw new Error("directory read failed");
      }
    },
    async put(key, value, { metadata }) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${filename(key)}.json`), value, "utf8");
      await writeFile(join(dir, `${filename(key)}.meta.json`), JSON.stringify(metadata), "utf8");
    }
  };
}
function kvStore(env) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${env.KV_NAMESPACE_ID}/values/`;
  const request = (key, suffix = "", init = {}) => fetch(`${base}${encodeURIComponent(key)}${suffix}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_KV_WRITE_TOKEN}` },
    signal: AbortSignal.timeout(3e4),
    redirect: "manual"
  });
  return {
    async get(key) {
      const response = await request(key);
      if (response.status === 404) return null;
      if (response.status !== 200) throw new Error("kv read failed");
      return response.text();
    },
    async put(key, value, { ttlSeconds, metadata }) {
      const body = new FormData();
      body.set("value", value);
      body.set("metadata", JSON.stringify(metadata));
      const response = await request(key, ttlSeconds === void 0 ? "" : `?expiration_ttl=${ttlSeconds}`, { method: "PUT", body });
      const result = await response.json().catch(() => null);
      if (response.status !== 200 || result?.success !== true) throw new Error("kv put failed");
    }
  };
}
var CallLimit = class extends Error {
};
var InvalidUsage = class extends Error {
};
function usageRecord(raw, month, updatedAt) {
  if (raw === null) return { v: 1, month, days: {}, total: 0, updatedAt };
  try {
    const data = JSON.parse(raw);
    if (data?.v === 1 && data.month === month && Number.isSafeInteger(data.total) && data.total >= 0 && data.days && typeof data.days === "object" && !Array.isArray(data.days) && Object.entries(data.days).every(([day, n]) => day.startsWith(`${month}-`) && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isSafeInteger(n) && n >= 0) && Object.values(data.days).reduce((sum, n) => sum + n, 0) === data.total && typeof data.updatedAt === "string" && Number.isFinite(Date.parse(data.updatedAt))) return data;
  } catch {
  }
  throw new InvalidUsage();
}
async function publishRail({ outDir, bulkFile, intervalMs = 6e4, maxCalls = Infinity, env = process.env, now = /* @__PURE__ */ new Date() } = {}) {
  const clientId = env.TDX_CLIENT_ID?.trim(), clientSecret = env.TDX_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    console.log("::notice::rail snapshot skipped: TDX_CLIENT_ID/TDX_CLIENT_SECRET not set");
    return 0;
  }
  if (!outDir) {
    const missing = ["CLOUDFLARE_ACCOUNT_ID", "KV_NAMESPACE_ID", "CLOUDFLARE_KV_WRITE_TOKEN"].filter((name) => !env[name]?.trim());
    if (missing.length) {
      console.error(missing.join("\n"));
      return 2;
    }
  }
  if (bulkFile && !outDir) {
    console.error("--wrangler-bulk requires --out");
    return 2;
  }
  const store = outDir ? directoryStore(outDir) : kvStore(env);
  const started = Date.now(), today = taipeiNow(now).date, month = today.slice(0, 7);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  const usageKey = snapshotUsageKey(month), reserve = snapshotReserve(env.TDX_SNAPSHOT_RESERVE, quota(env.TDX_MONTHLY_QUOTA));
  let usage;
  try {
    usage = usageRecord(await store.get(usageKey), month, now.toISOString());
  } catch (error) {
    console.error(error instanceof InvalidUsage ? "rail usage record invalid; refusing to call TDX" : `rail skip ${usageKey} read failed`);
    return 1;
  }
  let calls = 0, bytes = 0, failed = false, lastCall, warned = false, reserveWarned = false, usageFailed = false;
  let token;
  const written = /* @__PURE__ */ new Map();
  async function put(key, value, options) {
    await store.put(key, value, options);
    const size = Buffer.byteLength(value);
    bytes += size;
    written.set(key, { key, value, ...options.ttlSeconds === void 0 ? {} : { expiration_ttl: options.ttlSeconds } });
    console.log(`rail put ${key} bytes=${size}`);
  }
  try {
    let freshStations2 = function(raw) {
      try {
        const data = JSON.parse(raw ?? "null");
        return data?.v === 1 && /^\d{4}-\d{2}-\d{2}$/.test(data.date) && typeof data.truncated === "boolean" && Array.isArray(data.stations) && data.stations.length > 0 && Number.isFinite(Date.parse(data.fetchedAt)) && now.getTime() - Date.parse(data.fetchedAt) <= 7 * 864e5;
      } catch {
        return false;
      }
    };
    var freshStations = freshStations2;
    async function request(url, init = {}) {
      if (usageFailed) throw new CallLimit();
      if (usage.total + 1 > reserve) {
        if (!warned) {
          console.warn("::warning::rail snapshot monthly reserve exhausted");
          warned = true;
        }
        throw new CallLimit();
      }
      if (calls >= maxCalls) throw new CallLimit();
      if (lastCall !== void 0) {
        const wait = intervalMs - (Date.now() - lastCall);
        if (wait > 0) await new Promise((resolve2) => setTimeout(resolve2, wait));
      }
      usage.total++;
      usage.days[today] = (usage.days[today] ?? 0) + 1;
      usage.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      if (!reserveWarned && usage.total >= Math.ceil(0.8 * reserve)) {
        console.warn(`::warning::rail snapshot usage at least 80% of reserve (${usage.total}/${reserve})`);
        reserveWarned = true;
      }
      try {
        await put(usageKey, JSON.stringify(usage), { ttlSeconds: 62 * 86400, metadata: { fetchedAt: usage.updatedAt, dataDate: today } });
      } catch {
        failed = usageFailed = true;
        console.error(`rail skip ${usageKey} put failed`);
        throw new CallLimit();
      }
      lastCall = Date.now();
      calls++;
      return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(3e4) });
    }
    async function accessToken() {
      if (token && token.until > Date.now()) return token.value;
      const response = await request(`${tdxBase(env.TDX_BASE_URL)}${tokenPath}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody({ clientId, clientSecret })
      });
      if (response.status !== 200) throw new Error("token failed");
      const data = object(await response.json()), value = string(data.access_token);
      if (!value) throw new Error("invalid token");
      if (env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${value}`);
      const expiry = data.expires_in ?? 86400;
      if (data.token_type !== void 0 && data.token_type !== "Bearer" || typeof expiry !== "number" || !Number.isFinite(expiry) || expiry <= 0) throw new Error("invalid token");
      token = { value, until: Date.now() + Math.max(0, expiry - Math.min(60, expiry / 10)) * 1e3 };
      return value;
    }
    async function get(path, query) {
      for (let attempt = 0; ; attempt++) {
        const access = await accessToken();
        const response = await request(tdxApiUrl(path, tdxBase(env.TDX_BASE_URL), query), { headers: { authorization: `Bearer ${access}` } });
        if (response.status === 401) {
          token = void 0;
          if (attempt === 0) continue;
        }
        if (response.status !== 200) throw new Error("data failed");
        return response.json();
      }
    }
    async function collect(railway, date) {
      const key = date ? timetableKey(railway, date) : stationKey(railway);
      try {
        const old = await store.get(key);
        if (date ? old !== null : freshStations2(old)) {
          console.log(`rail skip ${key} exists`);
          return;
        }
        let snapshot;
        if (!date) {
          const body = await get(railway === "THSR" ? "/v2/Rail/THSR/Station" : "/v3/Rail/TRA/Station");
          snapshot = compactStations(railway, body, now.toISOString());
        } else {
          const path = railway === "THSR" ? `/v2/Rail/THSR/DailyTimetable/TrainDate/${date}` : `/v3/Rail/TRA/DailyTrainTimetable/TrainDate/${date}`;
          let body = await get(path), truncated = false;
          if (railway === "TRA") {
            const trains = [];
            for (let page = 0; page < 3; page++) {
              if (page) body = await get(path, { "$skip": String(page * 1e3) });
              const rows = object(body).TrainTimetables;
              if (!Array.isArray(rows)) throw new Error("invalid timetable");
              trains.push(...rows);
              if (rows.length < 1e3) break;
              if (page === 2) truncated = true;
            }
            body = { TrainTimetables: trains };
          }
          snapshot = compactTimetable(railway, body, date, now.toISOString(), truncated);
        }
        await put(key, JSON.stringify(snapshot), { ...date ? { ttlSeconds: 259200 } : {}, metadata: { fetchedAt: snapshot.fetchedAt, dataDate: snapshot.date } });
      } catch (error) {
        if (error instanceof CallLimit) console.log(`rail skip ${key} call limit`);
        else {
          failed = true;
          console.error(`rail skip ${key} failed`);
        }
      }
    }
    await collect("THSR", today);
    await collect("TRA", today);
    await collect("THSR");
    await collect("TRA");
    await collect("THSR", tomorrow);
    await collect("TRA", tomorrow);
  } catch {
    failed = true;
    console.error(`rail skip ${usageKey} read failed`);
  } finally {
    if (bulkFile) {
      try {
        await writeFile(bulkFile, JSON.stringify([...written.values()]), "utf8");
      } catch {
        failed = true;
        console.error("rail bulk write failed");
      }
    }
    console.log(`rail collector calls=${calls} elapsedMs=${Date.now() - started} bytes=${bytes}`);
  }
  return failed ? 1 : 0;
}
async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag2 = args[i], value = args[i + 1];
    if (!value || value.startsWith("--") || !["--out", "--wrangler-bulk", "--interval-ms", "--max-calls"].includes(flag2) || ["--interval-ms", "--max-calls"].includes(flag2) && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) {
      console.error("Usage: publish-rail [--out <dir>] [--wrangler-bulk <file>] [--interval-ms N] [--max-calls N]");
      return 2;
    }
    if (flag2 === "--out") options.outDir = value;
    if (flag2 === "--wrangler-bulk") options.bulkFile = value;
    if (flag2 === "--interval-ms") options.intervalMs = Number(value);
    if (flag2 === "--max-calls") options.maxCalls = Number(value);
  }
  return publishRail(options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
export {
  directoryStore,
  main,
  publishRail
};
