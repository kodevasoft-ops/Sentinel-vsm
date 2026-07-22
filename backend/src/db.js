const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "..", "sentinel.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS cameras (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  zone TEXT DEFAULT '',
  rtsp_url TEXT NOT NULL,
  onvif_host TEXT,
  onvif_port INTEGER DEFAULT 80,
  username TEXT,
  password TEXT,
  priority TEXT DEFAULT 'media',
  ptz INTEGER DEFAULT 0,
  manufacturer TEXT,
  model TEXT,
  network_id TEXT,
  online INTEGER DEFAULT 0,
  last_seen TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS networks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cidr TEXT NOT NULL,
  scan_order INTEGER NOT NULL DEFAULT 0,
  is_local INTEGER DEFAULT 0,
  notes TEXT DEFAULT ''
);
`);

// Seed default 3-tier network topology described by the user (Red 1 -> Red 2 -> Red 3),
// scanned in reverse order (Red 3 first, then Red 2, then Red 1) as requested.
const count = db.prepare("SELECT COUNT(*) AS c FROM networks").get().c;
if (count === 0) {
  const insert = db.prepare(
    "INSERT INTO networks (id, name, cidr, scan_order, is_local, notes) VALUES (?,?,?,?,?,?)"
  );
  insert.run("net-red1", "Red 1", "192.168.1.0/24", 3, 1, "Red local del servidor Sentinel (permite descubrimiento ONVIF multicast)");
  insert.run("net-red2", "Red 2", "192.168.2.0/24", 2, 0, "Red intermedia, accesible por ruteo desde Red 1");
  insert.run("net-red3", "Red 3", "192.168.3.0/24", 1, 0, "Red más alejada, accesible por ruteo desde Red 2");
}

module.exports = db;
