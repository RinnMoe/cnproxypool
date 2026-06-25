CREATE TABLE IF NOT EXISTS sources (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  refresh_interval_seconds INTEGER NOT NULL DEFAULT 1800,
  timeout_seconds INTEGER NOT NULL DEFAULT 8,
  last_refresh_at REAL,
  last_error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS proxies (
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  scheme TEXT NOT NULL,
  source TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  province TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  carrier TEXT NOT NULL DEFAULT '',
  anonymity TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL,
  source_latency_seconds REAL,
  check_latency_seconds REAL,
  health_status TEXT NOT NULL DEFAULT 'unchecked',
  last_seen_at REAL,
  last_checked_at REAL,
  fail_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  raw_location TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (host, port)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('maintenance_interval_seconds', '600');
INSERT OR IGNORE INTO settings (key, value) VALUES ('last_maintenance_at', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('max_health_checks', '500');
