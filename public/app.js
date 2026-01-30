const loginView = document.getElementById("loginView");
const dashView = document.getElementById("dashView");
const logoutBtn = document.getElementById("logoutBtn");
const siteTable = document.getElementById("siteTable");
const loginError = document.getElementById("loginError");

let currentUser = null;

// ---------- USERS ----------
function loadUsers() {
  return JSON.parse(localStorage.getItem("navine_users") || "{}");
}

function saveUsers(users) {
  localStorage.setItem("navine_users", JSON.stringify(users));
}

// ---------- LOGIN ----------
document.getElementById("loginBtn").onclick = () => {
  const u = username.value.trim();
  const p = password.value;

  if (!u || !p) return;

  const users = loadUsers();

  if (!users[u]) {
    // register
    users[u] = { password: p, sites: [] };
    saveUsers(users);
  }

  if (users[u].password !== p) {
    loginError.textContent = "Wrong password";
    loginError.classList.remove("hidden");
    return;
  }

  currentUser = u;
  localStorage.setItem("navine_session", u);
  loginError.classList.add("hidden");
  showDashboard();
};

logoutBtn.onclick = () => {
  localStorage.removeItem("navine_session");
  location.reload();
};

// ---------- DASHBOARD ----------
function showDashboard() {
  loginView.classList.add("hidden");
  dashView.classList.remove("hidden");
  logoutBtn.classList.remove("hidden");
  renderSites();
}

// ---------- SITES ----------
document.getElementById("addSiteBtn").onclick = () => {
  const name = siteName.value.trim();
  let url = siteUrl.value.trim();
  if (!name || !url) return;

  if (!url.startsWith("http")) url = "https://" + url;

  const users = loadUsers();
  users[currentUser].sites.push({
    name, url,
    checks: 0,
    visits: 0,
    lastPing: null,
    status: "Unknown"
  });
  saveUsers(users);
  renderSites();
};

function renderSites() {
  const users = loadUsers();
  siteTable.innerHTML = "";

  users[currentUser].sites.forEach((s, i) => {
    siteTable.innerHTML += `
      <tr>
        <td>${s.name}<br><small>${s.url}</small></td>
        <td class="${s.status === "Online" ? "status-online" : "status-offline"}">${s.status}</td>
        <td>${s.lastPing ?? "—"} ms</td>
        <td>${s.visits}</td>
        <td>${s.checks}</td>
        <td>${s.lastCheck ?? "—"}</td>
        <td><button onclick="removeSite(${i})">X</button></td>
      </tr>`;
  });
}

function removeSite(i) {
  const users = loadUsers();
  users[currentUser].sites.splice(i, 1);
  saveUsers(users);
  renderSites();
}

// ---------- PINGER ----------
async function pingSites() {
  if (!currentUser) return;

  const users = loadUsers();
  const sites = users[currentUser].sites;

  for (const s of sites) {
    s.checks++;
    const start = performance.now();
    try {
      await fetch(s.url, { mode: "no-cors" });
      s.status = "Online";
      s.visits++;
      s.lastPing = Math.round(performance.now() - start);
    } catch {
      s.status = "Offline";
    }
    s.lastCheck = new Date().toLocaleTimeString();
  }

  saveUsers(users);
  renderSites();

  setTimeout(pingSites, (30 + Math.random() * 30) * 1000);
}

// ---------- INIT ----------
const session = localStorage.getItem("navine_session");
if (session) {
  currentUser = session;
  showDashboard();
  pingSites();
}
