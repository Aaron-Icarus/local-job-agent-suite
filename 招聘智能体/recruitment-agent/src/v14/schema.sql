PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  file_path TEXT NOT NULL UNIQUE,
  collected_at TEXT,
  date_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  record_count INTEGER NOT NULL DEFAULT 0,
  ingested_count INTEGER NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_files_status ON raw_files(status, collected_at, id);

CREATE TABLE IF NOT EXISTS jobs (
  job_uuid TEXT PRIMARY KEY,
  display_id TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  platform_job_id TEXT NOT NULL,
  job_url TEXT,
  company TEXT,
  title TEXT,
  salary_text TEXT,
  salary_min_k REAL,
  salary_max_k REAL,
  salary_months TEXT,
  city TEXT,
  district TEXT,
  address TEXT,
  experience TEXT,
  degree TEXT,
  skills_json TEXT,
  tags_json TEXT,
  job_description TEXT,
  source_account_id TEXT,
  collected_at TEXT,
  first_seen_at TEXT,
  first_seen_date TEXT,
  last_seen_at TEXT,
  last_seen_date TEXT,
  ingested_at TEXT,
  content_hash TEXT,
  facts_updated_at TEXT,
  job_status TEXT NOT NULL DEFAULT 'open',
  status_updated_at TEXT,
  closed_at TEXT,
  reopen_count INTEGER NOT NULL DEFAULT 0,
  duplicate_of_job_uuid TEXT,
  duplicate_status TEXT NOT NULL DEFAULT 'unique',
  duplicate_score REAL NOT NULL DEFAULT 0,
  long_lived_days INTEGER NOT NULL DEFAULT 0,
  facts_json TEXT,
  legacy_score_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(platform, platform_job_id)
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(job_status, duplicate_status);
CREATE INDEX IF NOT EXISTS idx_jobs_last_seen ON jobs(last_seen_date);
CREATE INDEX IF NOT EXISTS idx_jobs_first_seen ON jobs(first_seen_date);

CREATE TABLE IF NOT EXISTS job_numbering (
  platform TEXT PRIMARY KEY,
  next_no INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_file_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  platform_job_id TEXT,
  payload_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY(raw_file_id) REFERENCES raw_files(id)
);
CREATE INDEX IF NOT EXISTS idx_pending_jobs_raw ON pending_jobs(raw_file_id, resolved_at);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_file_id INTEGER,
  platform TEXT,
  file_path TEXT,
  status TEXT NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0,
  ingested_count INTEGER NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY(raw_file_id) REFERENCES raw_files(id)
);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_started ON ingest_runs(started_at);
