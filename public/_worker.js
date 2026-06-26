import { connect } from "cloudflare:sockets";

const VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 8000;
const HEALTH_TIMEOUT_MS = 6000;
const HEALTH_ATTEMPT_TIMEOUT_MS = 3000;
const HEALTH_CHECK_HOST = "api.ipify.org";
const HEALTH_CHECK_PATH = "/";
const HEALTH_CONNECT_HEADER_LIMIT = 8192;
const MAX_HEALTH_CHECKS = 500;
const MAX_REFRESH_SOURCES_PER_TICK = 2;
const SOURCE_CUSTOM_PREFIX = "custom_url:";
const API_CACHE_SECONDS = 60;
const CACHEABLE_GET_PATHS = new Set(["/api/v1/proxies", "/api/v1/proxies/select"]);

const BUILTIN_SOURCES = [
  { key: "ip3366_free", name: "IP3366 Free", type: "builtin", url: "http://www.ip3366.net/free/?stype=1", refresh_interval_seconds: 1800, timeout_seconds: 8 },
  { key: "qiyun_free", name: "Qiyun Free", type: "builtin", url: "https://www.qiyunip.com/freeProxy/", refresh_interval_seconds: 1800, timeout_seconds: 8 },
  { key: "66daili_free", name: "66daili Free", type: "builtin", url: "https://www.66daili.com/", refresh_interval_seconds: 1800, timeout_seconds: 8 },
  { key: "89ip_free", name: "89IP Free", type: "builtin", url: "https://api.89ip.cn/tqdl.html?api=1&num=500&port=&address=&isp=", refresh_interval_seconds: 1800, timeout_seconds: 8 },
  { key: "zdaye_free", name: "Zdaye Free", type: "builtin", url: "https://www.zdaye.com/free/", refresh_interval_seconds: 1800, timeout_seconds: 8 },
];

const PROVINCE_SLUGS = [
  "beijing", "tianjin", "shanghai", "chongqing", "hebei", "shanxi", "liaoning", "jilin",
  "heilongjiang", "jiangsu", "zhejiang", "anhui", "fujian", "jiangxi", "shandong", "henan",
  "hubei", "hunan", "guangdong", "guangxi", "hainan", "sichuan", "guizhou", "yunnan",
  "xizang", "gansu", "qinghai", "ningxia", "xinjiang", "neimeng",
];
const NON_ADMIN_REGION_WORDS = new Set(["阿里云", "腾讯云", "华为云", "百度云", "京东云", "火山云", "移动", "联通", "电信", "铁通", "广电", "教育网"]);

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/")) {
        return env.ASSETS.fetch(request);
      }
      const path = normalizePath(url.pathname);
      if (path === "/api/v1/health" && request.method === "GET") {
        return json({ status: "ok", version: VERSION });
      }
      if (request.method === "GET" && isCacheableApiRequest(path, url.searchParams)) {
        const cached = await cachedApiResponse(request);
        if (cached) return cached;
      }
      await ensureSchema(env);
      await ensureConfiguredSources(env);
      if (request.method === "GET") ctx.waitUntil(runMaintenanceIfDue(env));
      const response = await routeRequest(request, env, ctx, path);
      if (request.method === "GET" && isCacheableApiRequest(path, url.searchParams)) {
        ctx.waitUntil(cacheApiResponse(request, response));
      }
      return response;
    } catch (error) {
      return json({ detail: error.message || String(error) }, 500);
    }
  },
};

async function routeRequest(request, env, ctx, pathOverride = "") {
  const url = new URL(request.url);
  const path = pathOverride || normalizePath(url.pathname);
  if (path === "/api/v1/sources" && request.method === "GET") {
    return json({ items: await listSources(env) });
  }
  if (path.startsWith("/api/v1/sources/") && request.method === "PUT") {
    return json({ detail: "source configuration is code-managed for Cloudflare Pages deployments" }, 405);
  }
  if (path === "/api/v1/stats" && request.method === "GET") {
    return json(await stats(env));
  }
  if (path === "/api/v1/proxies" && request.method === "GET") {
    return json(await listProxies(env, url.searchParams));
  }
  if (path === "/api/v1/proxies/select" && request.method === "GET") {
    const item = await selectProxy(env, url.searchParams);
    if (!item) return json({ detail: "no matching proxy" }, 404);
    return json({ item });
  }
  if (path === "/api/v1/refresh" && request.method === "POST") {
    const response = json(await refreshAll(env, await readJson(request)));
    ctx.waitUntil(clearCommonApiCache(request));
    return response;
  }
  if (path.startsWith("/api/v1/refresh/") && request.method === "POST") {
    const key = decodeURIComponent(path.slice("/api/v1/refresh/".length));
    const response = json(await refreshOne(env, key, await readJson(request)));
    ctx.waitUntil(clearCommonApiCache(request));
    return response;
  }
  if (path === "/api/v1/check" && request.method === "POST") {
    const body = await readJson(request);
    const response = json(await checkHealth(env, Number(body.max_checks || MAX_HEALTH_CHECKS)));
    ctx.waitUntil(clearCommonApiCache(request));
    return response;
  }
  return json({ detail: "not found" }, 404);
}

function normalizePath(pathname) {
  return pathname.replace(/\/+$/, "") || "/";
}

function isCacheableApiRequest(path, params) {
  if (!CACHEABLE_GET_PATHS.has(path)) return false;
  return path !== "/api/v1/proxies/select" || (params.get("strategy") || "fastest") !== "random";
}

async function cachedApiResponse(request) {
  const response = await caches.default.match(cacheRequest(request));
  if (!response) return null;
  const headers = new Headers(response.headers);
  headers.set("X-Cache", "HIT");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function cacheApiResponse(request, response) {
  if (response.status !== 200) return;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", `public, max-age=${API_CACHE_SECONDS}`);
  headers.set("X-Cache", "MISS");
  await caches.default.put(cacheRequest(request), new Response(await response.clone().arrayBuffer(), { status: response.status, statusText: response.statusText, headers }));
}

function cacheRequest(request) {
  return new Request(request.url, { method: "GET" });
}

async function clearCommonApiCache(request) {
  const origin = new URL(request.url).origin;
  await Promise.all([
    caches.default.delete(new Request(`${origin}/api/v1/stats`, { method: "GET" })),
    caches.default.delete(new Request(`${origin}/api/v1/proxies?healthy_only=true&limit=20&offset=0`, { method: "GET" })),
  ]);
}

async function ensureSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sources (
      key TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, type TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '', refresh_interval_seconds INTEGER NOT NULL DEFAULT 1800,
      timeout_seconds INTEGER NOT NULL DEFAULT 8, last_refresh_at REAL, last_error TEXT NOT NULL DEFAULT ''
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS proxies (
      host TEXT NOT NULL, port INTEGER NOT NULL, scheme TEXT NOT NULL, source TEXT NOT NULL, sources_json TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT '', province TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', carrier TEXT NOT NULL DEFAULT '',
      anonymity TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL, source_latency_seconds REAL, check_latency_seconds REAL,
      health_status TEXT NOT NULL DEFAULT 'unchecked', last_seen_at REAL, last_checked_at REAL, fail_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0, raw_location TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (host, port)
    )`),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"),
    env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('maintenance_interval_seconds', '600')"),
    env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('last_maintenance_at', '0')"),
    env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('max_health_checks', '500')"),
  ]);
}

async function ensureConfiguredSources(env) {
  const statements = BUILTIN_SOURCES.map((source) =>
    env.DB.prepare(`
      INSERT INTO sources (key, name, enabled, type, url, refresh_interval_seconds, timeout_seconds)
      VALUES (?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        url = excluded.url,
        refresh_interval_seconds = excluded.refresh_interval_seconds,
        timeout_seconds = excluded.timeout_seconds
    `).bind(source.key, source.name, source.type, source.url, source.refresh_interval_seconds, source.timeout_seconds)
  );
  if (statements.length) await env.DB.batch(statements);
}

async function runMaintenanceIfDue(env) {
  const now = epoch();
  const interval = Number(await setting(env, "maintenance_interval_seconds", "600"));
  const last = Number(await setting(env, "last_maintenance_at", "0"));
  if (now - last < Math.max(60, interval)) return;
  await setSetting(env, "last_maintenance_at", String(now));
  await refreshDueSources(env);
  await checkHealth(env, Number(await setting(env, "max_health_checks", String(MAX_HEALTH_CHECKS))));
}

async function refreshDueSources(env) {
  const now = epoch();
  const rows = await env.DB.prepare("SELECT * FROM sources WHERE enabled = 1 ORDER BY COALESCE(last_refresh_at, 0) ASC").all();
  const due = rows.results.filter((row) => now - Number(row.last_refresh_at || 0) >= Math.max(60, Number(row.refresh_interval_seconds || 1800)));
  for (const source of due.slice(0, MAX_REFRESH_SOURCES_PER_TICK)) {
    await refreshSource(env, source);
  }
}

async function refreshAll(env, body = {}) {
  const rows = await env.DB.prepare("SELECT * FROM sources WHERE enabled = 1 ORDER BY key").all();
  const refresh = { ok: [], failed: [], saved: 0 };
  for (const source of rows.results) {
    const item = await refreshSource(env, source);
    refresh.saved += item.saved || 0;
    refresh[item.error ? "failed" : "ok"].push(item.error ? { key: source.key, error: item.error } : { key: source.key, count: item.count });
  }
  if (body.check !== false) await checkHealth(env, Number(body.max_checks || MAX_HEALTH_CHECKS));
  return { ...(await stats(env)), sources: await listSources(env), refresh };
}

async function refreshOne(env, key, body = {}) {
  const source = await env.DB.prepare("SELECT * FROM sources WHERE key = ?").bind(key).first();
  if (!source) return { detail: "source not found" };
  const item = await refreshSource(env, source);
  if (body.check !== false) await checkHealth(env, Number(body.max_checks || MAX_HEALTH_CHECKS));
  return { ...(await stats(env)), sources: await listSources(env), refresh: item };
}

async function refreshSource(env, source) {
  try {
    const started = Date.now();
    let records = [];
    const errors = [];
    for (const url of sourceUrls(source)) {
      try {
        const response = await fetchWithTimeout(url, Number(source.timeout_seconds || 8) * 1000);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
        const text = await responseText(response, source.key);
        records.push(...parseSource(source.key, text));
      } catch (error) {
        errors.push(error.message || String(error));
      }
    }
    if (!records.length && errors.length) throw new Error(errors[0]);
    const latency = (Date.now() - started) / 1000;
    records = dedupe(records).map((record) => normalizeRecord({ ...record, source: source.key, sources: [source.key], source_latency_seconds: record.source_latency_seconds ?? latency }));
    const saved = await upsertProxies(env, records);
    await env.DB.prepare("UPDATE sources SET last_refresh_at = ?, last_error = '' WHERE key = ?").bind(epoch(), source.key).run();
    return { key: source.key, count: records.length, saved };
  } catch (error) {
    const message = (error.message || String(error)).slice(0, 500);
    await env.DB.prepare("UPDATE sources SET last_refresh_at = ?, last_error = ? WHERE key = ?").bind(epoch(), message, source.key).run();
    return { key: source.key, error: message, saved: 0 };
  }
}

function sourceUrls(source) {
  if (source.type === "custom_url") return [source.url];
  if (source.key.startsWith(SOURCE_CUSTOM_PREFIX)) return [source.key.slice(SOURCE_CUSTOM_PREFIX.length)];
  if (source.key === "66daili_free") return PROVINCE_SLUGS.map((province) => `${source.url.replace(/\/+$/, "")}/free-proxy/${province}/`);
  if (source.key === "zdaye_free") return [source.url, ...PROVINCE_SLUGS.map((province) => `${source.url.replace(/\/+$/, "")}/${province}/`)];
  return [source.url];
}

async function checkHealth(env, maxChecks = MAX_HEALTH_CHECKS) {
  const rows = await env.DB.prepare(`
    SELECT * FROM proxies
    ORDER BY last_checked_at IS NULL DESC, COALESCE(last_checked_at, 0) ASC
    LIMIT ?
  `).bind(Math.max(1, Math.min(maxChecks, 5000))).all();
  let checked = 0;
  for (const row of rows.results) {
    const started = Date.now();
    const status = await checkProxyWithTimeout(row);
    const latency = (Date.now() - started) / 1000;
    const ok = status === "ok";
    await env.DB.prepare(`
      UPDATE proxies
      SET health_status = ?, check_latency_seconds = ?, last_checked_at = ?,
          fail_count = fail_count + ?, success_count = success_count + ?
      WHERE host = ? AND port = ?
    `).bind(status, latency, epoch(), ok ? 0 : 1, ok ? 1 : 0, row.host, row.port).run();
    checked += 1;
  }
  return { checked, ...(await stats(env)) };
}

async function checkProxyWithTimeout(row) {
  try {
    return await withTimeout(checkProxy(row), HEALTH_TIMEOUT_MS);
  } catch (error) {
    if (/(cert|certificate|tls|ssl|trust|x509)/i.test(error.message || "")) return "tls_error";
    return /timed/i.test(error.message || "") ? "timeout" : "failed";
  }
}

async function checkProxy(row) {
  const httpsStatus = await checkHttpsProxy(row);
  if (httpsStatus === "ok") return "ok";
  const httpStatus = await checkHttpProxy(row);
  return httpStatus === "ok" ? "ok" : httpsStatus;
}

async function checkHttpsProxy(row) {
  let socket;
  let secureSocket;
  try {
    socket = connect({ hostname: row.host, port: Number(row.port) }, { secureTransport: "starttls" });
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();
    const connectRequest = `CONNECT ${HEALTH_CHECK_HOST}:443 HTTP/1.1\r\nHost: ${HEALTH_CHECK_HOST}:443\r\nUser-Agent: RinnProxyHub/0.1\r\nProxy-Connection: close\r\n\r\n`;
    await withTimeout(writer.write(new TextEncoder().encode(connectRequest)), HEALTH_ATTEMPT_TIMEOUT_MS);
    const connectResponse = await readHttpHeader(reader, HEALTH_ATTEMPT_TIMEOUT_MS);
    try { writer.releaseLock(); reader.releaseLock(); } catch {}
    if (!/^HTTP\/1\.[01] 2\d\d/i.test(connectResponse)) {
      try { socket.close(); } catch {}
      return "connect_error";
    }

    secureSocket = socket.startTls();
    const secureWriter = secureSocket.writable.getWriter();
    const secureReader = secureSocket.readable.getReader();
    const request = `GET ${HEALTH_CHECK_PATH} HTTP/1.1\r\nHost: ${HEALTH_CHECK_HOST}\r\nUser-Agent: RinnProxyHub/0.1\r\nConnection: close\r\n\r\n`;
    await withTimeout(secureWriter.write(new TextEncoder().encode(request)), HEALTH_ATTEMPT_TIMEOUT_MS);
    const response = await readHttpHeader(secureReader, HEALTH_ATTEMPT_TIMEOUT_MS);
    try { secureWriter.releaseLock(); secureReader.releaseLock(); secureSocket.close(); } catch {}
    return /^HTTP\/1\.[01] [23]\d\d/i.test(response) ? "ok" : "http_error";
  } catch (error) {
    try { secureSocket?.close(); } catch {}
    try { socket?.close(); } catch {}
    if (/(cert|certificate|tls|ssl|trust|x509)/i.test(error.message || "")) return "tls_error";
    return /timed/i.test(error.message || "") ? "timeout" : "failed";
  }
}

async function checkHttpProxy(row) {
  let socket;
  try {
    socket = connect({ hostname: row.host, port: Number(row.port) });
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();
    const request = `GET http://${HEALTH_CHECK_HOST}${HEALTH_CHECK_PATH} HTTP/1.1\r\nHost: ${HEALTH_CHECK_HOST}\r\nUser-Agent: RinnProxyHub/0.1\r\nConnection: close\r\n\r\n`;
    await withTimeout(writer.write(new TextEncoder().encode(request)), HEALTH_ATTEMPT_TIMEOUT_MS);
    const response = await readHttpHeader(reader, HEALTH_ATTEMPT_TIMEOUT_MS);
    try { writer.releaseLock(); reader.releaseLock(); socket.close(); } catch {}
    return /^HTTP\/1\.[01] [23]\d\d/i.test(response) ? "ok" : "http_error";
  } catch (error) {
    try { socket?.close(); } catch {}
    return /timed/i.test(error.message || "") ? "timeout" : "failed";
  }
}

async function readHttpHeader(reader, timeoutMs = HEALTH_TIMEOUT_MS) {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\r\n\r\n") && text.length < HEALTH_CONNECT_HEADER_LIMIT) {
    const result = await withTimeout(reader.read(), timeoutMs);
    if (!result.value) break;
    text += decoder.decode(result.value, { stream: true });
  }
  return text;
}

async function listSources(env) {
  const rows = await env.DB.prepare("SELECT * FROM sources ORDER BY type, key").all();
  return rows.results.map((row) => ({
    key: row.key,
    name: row.name,
    enabled: Boolean(row.enabled),
    type: row.type,
    url: row.url,
    refresh_interval_seconds: Number(row.refresh_interval_seconds),
    timeout_seconds: Number(row.timeout_seconds),
    last_refresh_at: row.last_refresh_at,
    last_error: row.last_error || "",
  }));
}

async function listProxies(env, params) {
  const where = [];
  const values = [];
  if (truthy(params.get("healthy_only"))) where.push("health_status = 'ok'");
  for (const [field, value] of [["province", params.get("province")], ["city", params.get("city")], ["scheme", params.get("scheme")], ["health_status", params.get("health_status")]]) {
    if (!value) continue;
    where.push(field === "province" || field === "city" ? `${field} LIKE ?` : `${field} = ?`);
    values.push(field === "province" || field === "city" ? `%${value}%` : value);
  }
  const limit = Math.max(1, Math.min(Number(params.get("limit") || 50), 500));
  const offset = Math.max(0, Number(params.get("offset") || 0));
  const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = await env.DB.prepare(`SELECT COUNT(*) AS total FROM proxies ${sqlWhere}`).bind(...values).first();
  const rows = await env.DB.prepare(`
    SELECT * FROM proxies ${sqlWhere}
    ORDER BY check_latency_seconds IS NULL, check_latency_seconds ASC, last_checked_at DESC
    LIMIT ? OFFSET ?
  `).bind(...values, limit, offset).all();
  return { items: rows.results.map(publicProxy), total: Number(total.total || 0) };
}

async function selectProxy(env, params) {
  const data = await listProxies(env, new URLSearchParams({
    healthy_only: params.get("healthy_only") ?? "true",
    province: params.get("province") || "",
    city: params.get("city") || "",
    scheme: params.get("scheme") || "",
    limit: "500",
  }));
  const items = data.items;
  if (!items.length) return null;
  const strategy = params.get("strategy") || "fastest";
  if (strategy === "random") return items[Math.floor(Math.random() * items.length)];
  return items[0];
}

async function stats(env) {
  const [rows, maintenance] = await Promise.all([
    env.DB.prepare("SELECT health_status, province, sources_json FROM proxies").all(),
    maintenanceSchedule(env),
  ]);
  const by_source = {};
  const by_province = {};
  for (const row of rows.results) {
    for (const source of safeJson(row.sources_json, [])) by_source[source] = (by_source[source] || 0) + 1;
    const province = cleanRegion(row.province || "unscoped");
    by_province[province] = (by_province[province] || 0) + 1;
  }
  const statuses = rows.results.map((row) => row.health_status || "unchecked");
  return {
    total: rows.results.length,
    healthy: statuses.filter((item) => item === "ok").length,
    failed: statuses.filter((item) => !["ok", "unchecked", ""].includes(item)).length,
    unchecked: statuses.filter((item) => item === "unchecked").length,
    next_check_at: maintenance.next_check_at,
    next_check_in_seconds: maintenance.next_check_in_seconds,
    by_source,
    by_province,
  };
}

async function maintenanceSchedule(env) {
  const now = epoch();
  const interval = Math.max(60, Number(await setting(env, "maintenance_interval_seconds", "600")));
  const last = Number(await setting(env, "last_maintenance_at", "0"));
  const next = last > 0 ? last + interval : now;
  return {
    next_check_at: next,
    next_check_in_seconds: Math.max(0, next - now),
  };
}

async function upsertProxies(env, records) {
  const now = epoch();
  const statements = [];
  for (const record of records) {
    const item = normalizeRecord(record);
    statements.push(env.DB.prepare(`
      INSERT INTO proxies (
        host, port, scheme, source, sources_json, country, province, city, carrier, anonymity,
        tags_json, source_latency_seconds, health_status, last_seen_at, raw_location, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unchecked', ?, ?, ?)
      ON CONFLICT(host, port) DO UPDATE SET
        scheme = excluded.scheme,
        source = CASE WHEN proxies.source != '' THEN proxies.source ELSE excluded.source END,
        sources_json = excluded.sources_json,
        country = excluded.country,
        province = CASE WHEN excluded.province != '' THEN excluded.province ELSE proxies.province END,
        city = CASE WHEN excluded.city != '' THEN excluded.city ELSE proxies.city END,
        carrier = CASE WHEN excluded.carrier != '' THEN excluded.carrier ELSE proxies.carrier END,
        anonymity = CASE WHEN excluded.anonymity != '' THEN excluded.anonymity ELSE proxies.anonymity END,
        tags_json = excluded.tags_json,
        source_latency_seconds = excluded.source_latency_seconds,
        last_seen_at = excluded.last_seen_at,
        raw_location = CASE WHEN excluded.raw_location != '' THEN excluded.raw_location ELSE proxies.raw_location END,
        metadata_json = excluded.metadata_json
    `).bind(item.host, item.port, item.scheme, item.source, JSON.stringify(item.sources), item.country, item.province, item.city, item.carrier, item.anonymity, JSON.stringify(item.tags), item.source_latency_seconds, now, item.raw_location, item.metadata_json));
  }
  if (statements.length) await env.DB.batch(statements);
  return statements.length;
}

function parseSource(source, text) {
  if (source === "66daili_free") return parse66Daili(text, source);
  if (source === "89ip_free") return parse89Ip(text, source);
  if (source === "zdaye_free") return parseZdaye(text, source);
  return parseGeneric(text, source);
}

function parse66Daili(text, source) {
  const rows = parseListRows(text, "flex");
  return rows.filter((row) => row.length >= 7 && isIp(row[0]) && validPort(row[1])).map((row) => {
    const [province, city, carrier] = splitLocationWithCarrier(row[2]);
    return normalizeRecord({ host: row[0], port: Number(row[1]), scheme: normalizeScheme(row[4]), source, province, city, carrier, anonymity: row[3], raw_location: row[2], source_latency_seconds: parseLatency(row[5]) });
  });
}

function parse89Ip(text, source) {
  const cells = tableCells(text);
  const records = [];
  for (let index = 0; index <= cells.length - 5; index += 5) {
    const row = cells.slice(index, index + 5);
    if (!isIp(row[0]) || !validPort(row[1])) continue;
    const [province, city, carrier] = splitLocationWithCarrier(row[2]);
    records.push(normalizeRecord({ host: row[0], port: Number(row[1]), scheme: "http", source, province, city, carrier, raw_location: row[2] }));
  }
  return records.length ? records : parseGeneric(text, source);
}

function parseZdaye(text, source) {
  const rows = parseListRows(text, "ul-row");
  const records = [];
  for (const row of rows) {
    const match = String(row[0] || "").match(/((?:\d{1,3}\.){3}\d{1,3})\s*Port[:：]\s*(\d{1,5})/);
    if (!match || !isIp(match[1]) || !validPort(match[2])) continue;
    const [province, city, carrier] = splitLocationWithCarrier(row[2] || "");
    records.push(normalizeRecord({ host: match[1], port: Number(match[2]), scheme: /HTTPS/i.test(row[1] || "") ? "https" : "http", source, province, city, carrier, anonymity: row[1] || "", raw_location: row[2] || "", source_latency_seconds: parseLatency(row[4] || "") }));
  }
  return records;
}

function parseGeneric(text, source) {
  const cells = tableCells(text);
  const tableRecords = [];
  for (let index = 0; index <= cells.length - 7; index += 7) {
    const row = cells.slice(index, index + 7);
    if (!isIp(row[0]) || !validPort(row[1])) continue;
    const [province, city, carrier] = splitLocationWithCarrier(row[4]);
    tableRecords.push(normalizeRecord({ host: row[0], port: Number(row[1]), scheme: normalizeScheme(row[3]), source, province, city, carrier, anonymity: row[2], raw_location: row[4], source_latency_seconds: parseLatency(row[5]) }));
  }
  if (tableRecords.length) return tableRecords;
  return parseIpPortPairs(text, source);
}

function parseIpPortPairs(text, source) {
  const records = [];
  for (const match of String(text || "").matchAll(/((?:\d{1,3}\.){3}\d{1,3})\s*[:\s]\s*(\d{2,5})/g)) {
    if (!isIp(match[1]) || !validPort(match[2])) continue;
    records.push(normalizeRecord({ host: match[1], port: Number(match[2]), scheme: "http", source }));
  }
  return records;
}

function tableCells(html) {
  return [...html.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => cleanHtml(match[1])).filter(Boolean);
}

function parseListRows(html, className) {
  const rows = [];
  const regex = new RegExp(`<ul[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/ul>`, "gi");
  for (const match of html.matchAll(regex)) {
    rows.push([...match[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((item) => cleanHtml(item[1])).filter(Boolean));
  }
  return rows;
}

function cleanHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function splitLocationWithCarrier(value) {
  const text = String(value || "").trim();
  const [location, ...carrierParts] = text.split(/\s+/);
  const carrier = carrierParts.join(" ");
  for (const suffix of ["特别行政区", "自治区", "省", "市"]) {
    const index = location.indexOf(suffix);
    if (index >= 0) {
      const end = index + suffix.length;
      return [location.slice(0, end), location.slice(end), carrier];
    }
  }
  return [location, "", carrier];
}

function normalizeRecord(record) {
  const scheme = normalizeScheme(record.scheme);
  const sources = [...new Set([...(record.sources || []), record.source].filter(Boolean))];
  const [province, city] = normalizeRegionFields(record.province, record.city);
  const tags = [...new Set([...(record.tags || []), province, city, scheme, record.anonymity].filter(Boolean))];
  return {
    host: String(record.host || "").trim(),
    port: Number(record.port || 0),
    scheme,
    source: record.source || "",
    sources,
    country: record.country || "中国",
    province,
    city,
    carrier: record.carrier || "",
    anonymity: record.anonymity || "",
    tags,
    source_latency_seconds: record.source_latency_seconds ?? null,
    raw_location: record.raw_location || "",
    metadata_json: record.metadata_json || "{}",
  };
}

function dedupe(records) {
  const map = new Map();
  for (const record of records) {
    const item = normalizeRecord(record);
    const key = `${item.host}:${item.port}`;
    if (!map.has(key)) {
      map.set(key, item);
      continue;
    }
    const existing = map.get(key);
    existing.sources = [...new Set([...existing.sources, ...item.sources])];
    existing.tags = [...new Set([...existing.tags, ...item.tags])];
    if (!existing.province && item.province) {
      existing.province = item.province;
      existing.city = item.city;
      existing.carrier = item.carrier;
    }
  }
  return [...map.values()];
}

function publicProxy(row) {
  const [province, city] = normalizeRegionFields(cleanRegion(row.province), cleanRegion(row.city));
  const anonymity = cleanText(row.anonymity);
  return {
    host: row.host,
    port: Number(row.port),
    scheme: row.scheme,
    url: `${row.scheme}://${row.host}:${row.port}`,
    source: row.source,
    sources: safeJson(row.sources_json, []),
    country: row.country,
    province,
    city,
    carrier: row.carrier,
    anonymity,
    tags: safeJson(row.tags_json, []).map(cleanText).filter(Boolean),
    source_latency_seconds: row.source_latency_seconds,
    check_latency_seconds: row.check_latency_seconds,
    health_status: row.health_status,
    last_seen_at: row.last_seen_at,
    last_checked_at: row.last_checked_at,
    fail_count: Number(row.fail_count || 0),
    success_count: Number(row.success_count || 0),
    raw_location: cleanText(row.raw_location),
    metadata_json: row.metadata_json,
  };
}

function isIp(value) {
  const parts = String(value || "").split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function normalizeScheme(value) {
  const text = String(value || "http").toLowerCase();
  if (text.includes("socks5")) return "socks5";
  if (text.includes("https")) return "https";
  return "http";
}

function parseLatency(value) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) / 1000 : null;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 RinnProxyHub/0.1" } });
  } finally {
    clearTimeout(timer);
  }
}

async function responseText(response, sourceKey) {
  const buffer = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") || "";
  const charset = contentType.match(/charset=([^;\s]+)/i)?.[1]?.toLowerCase();
  const preferred = charset || (sourceKey === "ip3366_free" ? "gb18030" : "utf-8");
  try {
    return new TextDecoder(preferred).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
  ]);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function setting(env, key, fallback) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row?.value ?? fallback;
}

async function setSetting(env, key, value) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function cleanRegion(value) {
  const text = String(value || "");
  return isMojibake(text) ? "未知" : text;
}

function normalizeRegionFields(province, city) {
  const provinceText = String(province || "").trim();
  const cityText = String(city || "").trim();
  if (isNonAdminRegion(provinceText)) return ["", cityText || provinceText.replace(/省$/, "")];
  return [provinceText, cityText];
}

function isNonAdminRegion(value) {
  const text = String(value || "").trim().replace(/省$/, "");
  if (NON_ADMIN_REGION_WORDS.has(text)) return true;
  return [...NON_ADMIN_REGION_WORDS].some((word) => text.endsWith(word));
}

function cleanText(value) {
  const text = String(value || "");
  return isMojibake(text) ? "" : text;
}

function isMojibake(text) {
  return text.includes("�") || text.includes("锟");
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function epoch() {
  return Date.now() / 1000;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
