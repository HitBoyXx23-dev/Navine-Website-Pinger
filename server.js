import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const db = new Database("navine.db");

// ---------- DB setup ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    ok INTEGER NOT NULL,
    status_code INTEGER,
    latency_ms INTEGER,
    error TEXT,
    FOREIGN KEY (site_id) REFERENCES sites(id)
  );
`);

const DEFAULT_ADMIN_USER = process.env.NAVINE_USER || "admin";
const DEFAULT_ADMIN_PASS = process.env.NAVINE_PASS || "admin123";

// Seed default user if none exists
const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
if (userCount === 0) {
  const hash = bcrypt.hashSync(DEFAULT_ADMIN_PASS, 12);
  db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(DEFAULT_ADMIN_USER, hash);
  console.log(`Seeded user: ${DEFAULT_ADMIN_USER} / ${DEFAULT_ADMIN_PASS}`);
  console.log("Set NAVINE_USER and NAVINE_PASS env vars to change this.");
}

// ---------- Middleware ----------
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "navine-super-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true }
  })
);

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));

// ---------- Auth routes ----------
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Missing credentials" });

  const user = db.prepare("SELECT id, password_hash FROM users WHERE username = ?").get(username);
  if (!user) return res.status(401).json({ error: "Invalid username/password" });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid username/password" });

  req.session.userId = user.id;
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  res.json({ authenticated: !!req.session?.userId });
});

// ---------- Site CRUD ----------
app.get("/api/sites", requireAuth, (req, res) => {
  const sites = db
    .prepare("SELECT id, name, url, created_at FROM sites WHERE user_id = ? ORDER BY id DESC")
    .all(req.session.userId);
  res.json({ sites });
});

app.post("/api/sites", requireAuth, (req, res) => {
  const { name, url } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: "Name and URL required" });

  // Basic normalization: ensure http(s)
  const normalized = url.match(/^https?:\/\//i) ? url : `https://${url}`;

  const info = db
    .prepare("INSERT INTO sites (user_id, name, url) VALUES (?, ?, ?)")
    .run(req.session.userId, name.trim(), normalized.trim());

  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete("/api/sites/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const site = db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(id, req.session.userId);
  if (!site) return res.status(404).json({ error: "Not found" });

  db.prepare("DELETE FROM checks WHERE site_id = ?").run(id);
  db.prepare("DELETE FROM sites WHERE id = ?").run(id);

  res.json({ ok: true });
});

// ---------- Monitoring summary ----------
app.get("/api/summary", requireAuth, (req, res) => {
  const sites = db
    .prepare("SELECT id, name, url FROM sites WHERE user_id = ? ORDER BY id DESC")
    .all(req.session.userId);

  const summary = sites.map((s) => {
    const last = db
      .prepare(
        "SELECT ok, status_code, latency_ms, checked_at, error FROM checks WHERE site_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(s.id);

    const stats = db
      .prepare(
        `SELECT 
           COUNT(*) AS checks,
           SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS successes
         FROM checks
         WHERE site_id = ?`
      )
      .get(s.id);

    const checks = stats.checks || 0;
    const successes = stats.successes || 0;
    const uptime = checks > 0 ? (successes / checks) * 100 : null;

    return {
      id: s.id,
      name: s.name,
      url: s.url,
      last: last || null,
      checks,
      successes, // "visits" = successful pings
      uptime
    };
  });

  res.json({ summary });
});

// ---------- Pinger loop ----------
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function checkSite(siteId, url) {
  const controller = new AbortController();
  const timeoutMs = 8000;
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const start = Date.now();
  try {
    // "no-store" to reduce caching; still not perfect, but better
    const resp = await fetch(url, { method: "GET", signal: controller.signal, cache: "no-store" });
    const latency = Date.now() - start;

    // Consider "online" if it responds at all (any status code). You can tighten this if you want 200–399 only.
    const ok = 1;

    db.prepare(
      "INSERT INTO checks (site_id, ok, status_code, latency_ms, error) VALUES (?, ?, ?, ?, ?)"
    ).run(siteId, ok, resp.status, latency, null);
  } catch (err) {
    const latency = Date.now() - start;
    db.prepare(
      "INSERT INTO checks (site_id, ok, status_code, latency_ms, error) VALUES (?, ?, ?, ?, ?)"
    ).run(siteId, 0, null, latency, String(err?.message || err));
  } finally {
    clearTimeout(t);
  }
}

async function pingLoop() {
  // Ping all sites for all users
  const sites = db.prepare("SELECT id, url FROM sites").all();
  for (const s of sites) {
    await checkSite(s.id, s.url);
  }

  // Random 30–60 seconds
  const wait = randomInt(30, 60) * 1000;
  setTimeout(pingLoop, wait);
}

// Start loop
pingLoop();

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Navine Website Pinger running on http://localhost:${PORT}`);
});
