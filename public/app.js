const state = { stats: {}, proxies: [], proxyTotal: 0, page: 1, pageSize: 20 };
const nonAdminRegionWords = ["阿里云", "腾讯云", "华为云", "百度云", "京东云", "火山云", "移动", "联通", "电信", "铁通", "广电", "教育网"];

const $ = (selector) => document.querySelector(selector);
const setText = (selector, value) => {
  const node = $(selector);
  if (node) node.textContent = value;
};

function renderApiExamples() {
  const origin = window.location.origin;
  document.querySelectorAll("[data-api-path]").forEach((node) => {
    const path = node.getAttribute("data-api-path") || "";
    node.textContent = `GET ${origin}${path}`;
  });
  $("#api-code-sample").textContent = `const res = await fetch("${origin}/api/v1/proxies/select?province=广东省&strategy=fastest&healthy_only=true");
const { item } = await res.json();
// item.url 可用于 requests / aiohttp / Node 代理配置`;
}

async function api(path) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text.slice(0, 300));
  }
  return response.json();
}

function showError(error) {
  const box = $("#error-box");
  if (!error) {
    box.classList.add("hidden");
    box.textContent = "";
    return;
  }
  box.textContent = String(error.message || error);
  box.classList.remove("hidden");
}

async function loadAll() {
  try {
    showError(null);
    const [stats, proxies] = await Promise.all([
      api("/api/v1/stats"),
      loadProxyPage(state.page),
    ]);
    state.stats = stats;
    state.proxies = proxies.items;
    state.proxyTotal = proxies.total || 0;
    render();
  } catch (error) {
    showError(error);
  }
}

function loadProxyPage(page) {
  const offset = (page - 1) * state.pageSize;
  return api(`/api/v1/proxies?healthy_only=true&limit=${state.pageSize}&offset=${offset}`);
}

function render() {
  setText("#stat-total", state.stats.total || 0);
  setText("#stat-healthy", state.stats.healthy || 0);
  setText("#stat-checking", state.stats.unchecked || 0);
  setText("#stat-next-check", formatCountdown(state.stats.next_check_in_seconds));
  renderProxies(state.proxies);
  renderPagination();
}

function renderProxies(items) {
  $("#proxy-table").innerHTML = `
    <table>
      <thead><tr><th>IP</th><th>端口</th><th>匿名性</th><th>地区</th><th>状态</th><th>延迟</th><th>上次测试时间</th></tr></thead>
      <tbody>
        ${items.map((item) => `
          <tr>
            <td><code>${escapeHtml(item.host)}</code></td>
            <td>${escapeHtml(item.port)}</td>
            <td>${escapeHtml(normalizeAnonymity(item.anonymity))}</td>
            <td>${escapeHtml(formatLocation(item))}</td>
            <td><span class="status ${item.health_status === "ok" ? "ok" : item.health_status === "unchecked" ? "" : "error"}">${escapeHtml(formatHealthStatus(item.health_status))}</span></td>
            <td>${formatLatency(item.check_latency_seconds)}</td>
            <td>${formatTime(item.last_checked_at)}</td>
          </tr>
        `).join("") || `<tr><td colspan="7">暂无代理</td></tr>`}
      </tbody>
    </table>`;
}

function formatLocation(item) {
  const province = String(item.province || "").trim();
  const city = String(item.city || "").trim();
  const normalizedProvince = province.endsWith("省") ? province.slice(0, -1) : province;
  if (nonAdminRegionWords.some((word) => normalizedProvince.endsWith(word))) {
    return city || normalizedProvince || "-";
  }
  return [province, city].filter(Boolean).join(" ") || "-";
}

function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(state.proxyTotal / state.pageSize));
  $("#page-info").textContent = `第 ${state.page} / ${totalPages} 页，共 ${state.proxyTotal} 条`;
  $("#prev-page").disabled = state.page <= 1;
  $("#next-page").disabled = state.page >= totalPages;
}

async function goToPage(nextPage) {
  const totalPages = Math.max(1, Math.ceil(state.proxyTotal / state.pageSize));
  state.page = Math.max(1, Math.min(nextPage, totalPages));
  try {
    showError(null);
    const proxies = await loadProxyPage(state.page);
    state.proxies = proxies.items;
    state.proxyTotal = proxies.total || 0;
    renderProxies(state.proxies);
    renderPagination();
  } catch (error) {
    showError(error);
  }
}

function normalizeAnonymity(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  if (text.includes("高匿")) return "高匿";
  if (text.includes("透明")) return "透明";
  if (text.includes("普匿")) return "普匿";
  return text;
}

function formatHealthStatus(value) {
  return {
    ok: "可用",
    failed: "失败",
    timeout: "超时",
    http_error: "HTTP 错误",
    unchecked: "未测",
  }[value] || value || "未测";
}

function formatLatency(seconds) {
  if (seconds === null || seconds === undefined || seconds === "") return "-";
  return `${Math.round(Number(seconds) * 1000)} ms`;
}

function formatTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return "-";
  const date = new Date(value * 1000);
  const pad = (item) => String(item).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatCountdown(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "-";
  const remaining = Math.max(0, Math.ceil(value));
  if (remaining <= 0) return "即将检测";
  if (remaining < 60) return `${remaining}秒后`;
  return `${Math.ceil(remaining / 60)}分后`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

$("#prev-page").addEventListener("click", () => goToPage(state.page - 1));
$("#next-page").addEventListener("click", () => goToPage(state.page + 1));

renderApiExamples();
loadAll();
