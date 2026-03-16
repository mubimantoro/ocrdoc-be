-- Users
CREATE TABLE IF NOT EXISTS users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT,
  email      TEXT UNIQUE,
  password   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Roles
CREATE TABLE IF NOT EXISTS roles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- User Roles
CREATE TABLE IF NOT EXISTS user_roles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role_id    UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Authentications
CREATE TABLE IF NOT EXISTS authentications (
  token TEXT PRIMARY KEY
);

-- Vendors
CREATE TABLE IF NOT EXISTS vendors (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Document Types
CREATE TABLE IF NOT EXISTS document_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        VARCHAR(10) NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  schema_path TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Source Files
CREATE TABLE IF NOT EXISTS source_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  file_name     TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  page_count    INTEGER,
  status        TEXT NOT NULL DEFAULT 'uploaded'
                  CHECK (status IN ('uploaded','processing','completed','failed','pending_review')),
  progress      INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Documents
CREATE TABLE IF NOT EXISTS documents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_file_id   UUID NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  vendor_id        UUID REFERENCES vendors(id) ON DELETE SET NULL,
  document_type_id UUID REFERENCES document_types(id) ON DELETE SET NULL,
  file_path        TEXT,
  start_page       INTEGER,
  end_page         INTEGER,
  confidence       NUMERIC(4,3),
  needs_review     BOOLEAN NOT NULL DEFAULT FALSE,
  status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','extracting','completed','failed','pending_review')),
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Extraction Jobs
CREATE TABLE IF NOT EXISTS extraction_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','processing','completed','failed')),
  progress      INTEGER NOT NULL DEFAULT 0,
  attempt       INTEGER NOT NULL DEFAULT 1,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Extraction Results
CREATE TABLE IF NOT EXISTS extraction_results (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_job_id UUID NOT NULL REFERENCES extraction_jobs(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fields
CREATE TABLE IF NOT EXISTS fields (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_result_id UUID NOT NULL REFERENCES extraction_results(id) ON DELETE CASCADE,
  key                  TEXT NOT NULL,
  value                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Items
CREATE TABLE IF NOT EXISTS items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_result_id UUID NOT NULL REFERENCES extraction_results(id) ON DELETE CASCADE,
  row_index            INTEGER NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Item Fields
CREATE TABLE IF NOT EXISTS item_fields (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id    UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Webhook Deliveries
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_file_id UUID NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  url            TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','success','failed')),
  attempt        INTEGER NOT NULL DEFAULT 0,
  response_code  INTEGER,
  error_message  TEXT,
  delivered_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_user_roles_user         ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role         ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_source_files_status     ON source_files(status);
CREATE INDEX IF NOT EXISTS idx_source_files_uploader   ON source_files(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_documents_source_file   ON documents(source_file_id);
CREATE INDEX IF NOT EXISTS idx_documents_status        ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_needs_review  ON documents(needs_review);
CREATE INDEX IF NOT EXISTS idx_extraction_jobs_doc     ON extraction_jobs(document_id);
CREATE INDEX IF NOT EXISTS idx_extraction_jobs_status  ON extraction_jobs(status);
CREATE INDEX IF NOT EXISTS idx_extraction_results_job  ON extraction_results(extraction_job_id);
CREATE INDEX IF NOT EXISTS idx_fields_result           ON fields(extraction_result_id);
CREATE INDEX IF NOT EXISTS idx_items_result            ON items(extraction_result_id);
CREATE INDEX IF NOT EXISTS idx_item_fields_item        ON item_fields(item_id);

-- ── Auto updated_at ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER trg_source_files_updated_at
  BEFORE UPDATE ON source_files FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER trg_documents_updated_at
  BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER trg_extraction_jobs_updated_at
  BEFORE UPDATE ON extraction_jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER trg_webhook_deliveries_updated_at
  BEFORE UPDATE ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Seed roles ────────────────────────────────────────────────────────────
INSERT INTO roles (name) VALUES ('admin'), ('operator')
ON CONFLICT (name) DO NOTHING;

-- ── Seed document types ───────────────────────────────────────────────────
INSERT INTO document_types (code, name, schema_path) VALUES
  ('380', 'Invoice',               'schemas/380.json'),
  ('217', 'Packing List',          'schemas/217.json'),
  ('001', 'CIPL',                  'schemas/001.json'),
  ('705', 'Bill of Lading',        'schemas/705.json'),
  ('740', 'Air Way Bill',          'schemas/740.json'),
  ('860', 'ECOO',                  'schemas/860.json'),
  ('861', 'COO',                   'schemas/861.json'),
  ('704', 'Master Bill of Lading', 'schemas/704.json'),
  ('741', 'Master AWB',            'schemas/741.json'),
  ('958', 'Lartas',                'schemas/958.json'),
  ('457', 'SKB PPh',               'schemas/457.json'),
  ('800', 'POSTEL',                'schemas/800.json'),
  ('813', 'CK',                    'schemas/813.json'),
  ('846', 'SKEM',                  'schemas/846.json'),
  ('854', 'BPOM',                  'schemas/854.json'),
  ('871', 'AKL',                   'schemas/871.json'),
  ('888', 'Pengecualian Perijinan', 'schemas/888.json'),
  ('957', 'SNI/SPB',               'schemas/957.json'),
  ('959', 'PI',                    'schemas/959.json'),
  ('999', 'Lainnya',               'schemas/999.json'),
  ('CKI', 'Cukai',                  'schemas/CKI.json')
ON CONFLICT (code) DO NOTHING;