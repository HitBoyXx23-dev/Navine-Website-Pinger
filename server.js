import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import http from "http";
import https from "https";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const db = new Database("navine.db");

// ---------- HTTP KEEP ALIVE ----------
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

// ---------- DB SETUP ----------
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  ok INTEGER NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  error TEXT
);
`);

// ---------- DEFAULT USER ----------
const DEFAULT_ADMIN_USER = process.env.NAVINE_USER || "admin";
const DEFAULT_ADMIN_PASS = process.env.NAVINE_PASS || "admin123";

const userCount = db.prepare(
  "SELECT COUNT(*) AS c FROM users"
).get().c;

if (userCount === 0) {
  db.prepare(`
    INSERT INTO users (username, password_hash)
    VALUES (?, ?)
  `).run(
    DEFAULT_ADMIN_USER,
    bcrypt.hashSync(DEFAULT_ADMIN_PASS, 12)
  );

  console.log(`Seeded admin: ${DEFAULT_ADMIN_USER} / ${DEFAULT_ADMIN_PASS}`);
}

// ---------- MIDDLEWARE ----------
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "navine-secret",
  resave: false,
  saveUninitialized: false
}));

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.sendStatus(401);
  next();
}

app.use(express.static(path.join(__dirname, "public")));

// ---------- AUTH ----------
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;

  const user = db.prepare(
    "SELECT * FROM users WHERE username = ?"
  ).get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.sendStatus(401);
  }

  req.session.userId = user.id;
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  res.json({ authenticated: !!req.session?.userId });
});

// ---------- SITES ----------
app.get("/api/sites", requireAuth, (req, res) => {
  const sites = db.prepare(
    "SELECT * FROM sites WHERE user_id = ? ORDER BY id DESC"
  ).all(req.session.userId);

  res.json({ sites });
});

app.post("/api/sites", requireAuth, (req, res) => {
  let { name, url } = req.body;
  if (!url.startsWith("http")) url = "https://" + url;

  const info = db.prepare(`
    INSERT INTO sites (user_id, name, url)
    VALUES (?, ?, ?)
  `).run(
    req.session.userId,
    name.trim(),
    url.trim()
  );

  res.json({ id: info.lastInsertRowid });
});

app.delete("/api/sites/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);

  db.prepare("DELETE FROM checks WHERE site_id = ?").run(id);
  db.prepare(
    "DELETE FROM sites WHERE id = ? AND user_id = ?"
  ).run(id, req.session.userId);

  res.json({ ok: true });
});

// ---------- SUMMARY ----------
app.get("/api/summary", requireAuth, (req, res) => {
  const sites = db.prepare(
    "SELECT * FROM sites WHERE user_id = ?"
  ).all(req.session.userId);

  const summary = sites.map(site => {
    const last = db.prepare(`
      SELECT * FROM checks
      WHERE site_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(site.id);

    const stats = db.prepare(`
      SELECT COUNT(*) c, SUM(ok) ok
      FROM checks
      WHERE site_id = ?
    `).get(site.id);

    return {
      ...site,
      last,
      checks: stats.c,
      uptime: stats.c ? (stats.ok / stats.c) * 100 : null
    };
  });

  res.json({ summary });
});

// ---------- MONITORING ----------
const TIMEOUT = 8000;
const RETRIES = 2;

async function checkSite(site) {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    const start = Date.now();

    try {
      const res = await fetch(site.url, {
        signal: controller.signal,
        agent: site.url.startsWith("https") ? httpsAgent : httpAgent,
        cache: "no-store"
      });

      clearTimeout(timer);

      db.prepare(`
        INSERT INTO checks (site_id, ok, status_code, latency_ms)
        VALUES (?, 1, ?, ?)
      `).run(site.id, res.status, Date.now() - start);

      return;
    } catch (err) {
      clearTimeout(timer);

      if (attempt === RETRIES) {
        db.prepare(`
          INSERT INTO checks (site_id, ok, error, latency_ms)
          VALUES (?, 0, ?, ?)
        `).run(site.id, err.message, Date.now() - start);
      }
    }
  }
}

async function pingLoop() {
  try {
    const sites = db.prepare("SELECT id, url FROM sites").all();
    await Promise.allSettled(sites.map(checkSite));
  } catch (e) {
    console.error("Ping loop error:", e);
  }

  setTimeout(pingLoop, 30_000);
}

pingLoop();

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Navine running on http://localhost:${PORT}`);
});
