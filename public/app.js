const loginView = document.getElementById("loginView");
const dashView = document.getElementById("dashView");
const logoutBtn = document.getElementById("logoutBtn");

const loginForm = document.getElementById("loginForm");
const loginError = document.getElementById("loginError");

const addSiteForm = document.getElementById("addSiteForm");
const addError = document.getElementById("addError");

const monitorBody = document.getElementById("monitorBody");

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function fmtTime(s) {
  if (!s) return "—";
  // SQLite datetime('now') is UTC-ish string; display as local time
  const d = new Date(s.replace(" ", "T") + "Z");
  return d.toLocaleString();
}

function fmtMs(ms) {
  if (ms == null) return "—";
  return `${ms} ms`;
}

function fmtPct(x) {
  if (x == null) return "—";
  return `${x.toFixed(1)}%`;
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function checkAuthAndLoad() {
  const me = await api("/api/me");
  if (me.authenticated) {
    hide(loginView);
    show(dashView);
    show(logoutBtn);
    await refreshSummary();
  } else {
    show(loginView);
    hide(dashView);
    hide(logoutBtn);
  }
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hide(loginError);

  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    await checkAuthAndLoad();
  } catch (err) {
    loginError.textContent = err.message;
    show(loginError);
  }
});

logoutBtn.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  await checkAuthAndLoad();
});

addSiteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hide(addError);

  const name = document.getElementById("siteName").value.trim();
  const url = document.getElementById("siteUrl").value.trim();

  try {
    await api("/api/sites", { method: "POST", body: JSON.stringify({ name, url }) });
    document.getElementById("siteName").value = "";
    document.getElementById("siteUrl").value = "";
    await refreshSummary();
  } catch (err) {
    addError.textContent = err.message;
    show(addError);
  }
});

async function deleteSite(id) {
  if (!confirm("Remove this site?")) return;
  await api(`/api/sites/${id}`, { method: "DELETE" });
  await refreshSummary();
}

function statusBadge(last) {
  if (!last) {
    return `<span class="badge"><span class="pip down"></span> No data</span>`;
  }
  if (last.ok === 1) {
    return `<span class="badge"><span class="pip ok"></span> Online</span>`;
  }
  return `<span class="badge"><span class="pip down"></span> Offline</span>`;
}

async function refreshSummary() {
  const { summary } = await api("/api/summary");
  monitorBody.innerHTML = summary
    .map((s) => {
      const last = s.last;
      const lastChecked = last?.checked_at;
      const ping = last?.latency_ms;
      const visits = s.successes ?? 0; // successful pings
      const checks = s.checks ?? 0;

      const urlLink = `<a href="${s.url}" target="_blank" rel="noreferrer">${s.name}</a><div class="muted small">${s.url}</div>`;
      const err = last?.ok === 0 && last?.error ? `<div class="muted small">${last.error}</div>` : "";

      return `
        <tr>
          <td>${urlLink}</td>
          <td>${statusBadge(last)}${err}</td>
          <td>${fmtMs(ping)}</td>
          <td>${visits}</td>
          <td>${checks}</td>
          <td>${fmtPct(s.uptime)}</td>
          <td>${fmtTime(lastChecked)}</td>
          <td><button class="btn" data-del="${s.id}">Remove</button></td>
        </tr>
      `;
    })
    .join("");

  document.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => deleteSite(btn.getAttribute("data-del")));
  });
}

// Poll dashboard every 5 seconds (pings happen server-side every 30–60s)
setInterval(async () => {
  const me = await api("/api/me").catch(() => ({ authenticated: false }));
  if (me.authenticated) refreshSummary().catch(() => {});
}, 5000);

checkAuthAndLoad().catch(() => {});
