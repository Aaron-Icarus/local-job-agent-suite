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

CREATE TABLE IF NOT EXISTS roles (
  role_uuid TEXT PRIMARY KEY,
  role_number TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  status TEXT NOT NULL,
  profile_md TEXT NOT NULL DEFAULT '',
  resume_source TEXT NOT NULL DEFAULT '',
  target_roles TEXT NOT NULL DEFAULT '',
  target_city TEXT NOT NULL DEFAULT '',
  target_salary TEXT NOT NULL DEFAULT '',
  special_requirements TEXT NOT NULL DEFAULT '',
  role_keywords_json TEXT NOT NULL DEFAULT '[]',
  role_channels_json TEXT NOT NULL DEFAULT '[]',
  collection_weight REAL NOT NULL DEFAULT 1,
  ai_provider_id TEXT NOT NULL DEFAULT '',
  report_channel_id TEXT NOT NULL DEFAULT '',
  has_started INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT,
  modified_at TEXT NOT NULL,
  first_started_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_roles_status ON roles(status, deleted_at);

CREATE TABLE IF NOT EXISTS role_numbering (
  scope TEXT PRIMARY KEY,
  next_no INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS role_jobs (
  role_uuid TEXT NOT NULL,
  job_uuid TEXT NOT NULL,
  job_display_id TEXT NOT NULL,
  job_status TEXT NOT NULL DEFAULT 'open',
  duplicate_status TEXT NOT NULL DEFAULT 'unique',
  status_updated_at TEXT,
  job_updated_at TEXT,
  score_id INTEGER,
  score REAL,
  tier TEXT NOT NULL DEFAULT '',
  score_time TEXT,
  score_explanation TEXT NOT NULL DEFAULT '',
  score_reasons_json TEXT NOT NULL DEFAULT '[]',
  score_risks_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  greeting_status TEXT NOT NULL DEFAULT '',
  score_version TEXT NOT NULL DEFAULT '',
  candidate_version TEXT NOT NULL DEFAULT '',
  needs_score INTEGER NOT NULL DEFAULT 1,
  skip_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(role_uuid, job_uuid),
  FOREIGN KEY(role_uuid) REFERENCES roles(role_uuid),
  FOREIGN KEY(job_uuid) REFERENCES jobs(job_uuid)
);
CREATE INDEX IF NOT EXISTS idx_role_jobs_pending ON role_jobs(role_uuid, needs_score, job_updated_at);

CREATE TABLE IF NOT EXISTS role_score_seq (
  role_uuid TEXT PRIMARY KEY,
  next_no INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS role_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_uuid TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_role_events_role ON role_events(role_uuid, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'queued',
  payload_json TEXT NOT NULL DEFAULT '{}',
  progress_json TEXT NOT NULL DEFAULT '{}',
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  next_retry_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority, created_at);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at);

CREATE TABLE IF NOT EXISTS collection_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  executed INTEGER NOT NULL DEFAULT 0,
  success_subtasks INTEGER NOT NULL DEFAULT 0,
  failed_subtasks INTEGER NOT NULL DEFAULT 0,
  force_reason TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collection_events_date ON collection_events(event_date, created_at);

CREATE TABLE IF NOT EXISTS collection_subtasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  role_uuid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  keyword_stats_json TEXT NOT NULL DEFAULT '[]',
  stop_reason TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(event_id) REFERENCES collection_events(id)
);
CREATE INDEX IF NOT EXISTS idx_collection_subtasks_event ON collection_subtasks(event_id, status);

CREATE TABLE IF NOT EXISTS keyword_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subtask_id INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(subtask_id) REFERENCES collection_subtasks(id)
);
CREATE INDEX IF NOT EXISTS idx_keyword_tasks_subtask ON keyword_tasks(subtask_id, status);

CREATE TABLE IF NOT EXISTS ai_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'openai',
  base_url TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  command TEXT NOT NULL DEFAULT '',
  key_cipher TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100,
  last_test_at TEXT,
  last_status TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL,
  role_uuid TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_date ON reports(report_date, role_uuid);

CREATE TABLE IF NOT EXISTS login_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_login_checks_platform ON login_checks(platform, checked_at);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  role_uuid TEXT NOT NULL DEFAULT '',
  channels_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  sent_at TEXT,
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, created_at);


