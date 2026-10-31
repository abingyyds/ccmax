CREATE TABLE users (
  id text PRIMARY KEY,
  parent_id text REFERENCES users(id),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'agent' CHECK(role IN ('owner','agent')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(parent_id IS NOT NULL OR role='owner'),
  CHECK(parent_id IS NULL OR role='agent')
);
CREATE UNIQUE INDEX one_owner ON users(role) WHERE role='owner';
CREATE INDEX users_parent ON users(parent_id);
CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE connections (
  id text PRIMARY KEY,
  provider text NOT NULL CHECK(provider IN ('gatelink','ai008','minicc','maxchat','aeromax')),
  name text NOT NULL,
  credentials text NOT NULL,
  payout_rate numeric(5,4) NOT NULL CHECK(payout_rate>=0 AND payout_rate<=1),
  enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending',
  last_error text,
  upstream_snapshot jsonb,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE connection_rates (
  id text PRIMARY KEY,
  connection_id text NOT NULL REFERENCES connections(id),
  rate numeric(5,4) NOT NULL CHECK(rate>=0 AND rate<=1),
  effective_date date NOT NULL,
  created_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id,effective_date)
);
CREATE INDEX connection_rates_lookup ON connection_rates(connection_id,effective_date DESC);
CREATE TABLE rates (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  provider text NOT NULL CHECK(provider IN ('gatelink','ai008','minicc','maxchat','aeromax')),
  rate numeric(5,4) NOT NULL CHECK(rate>=0 AND rate<=1),
  effective_date date NOT NULL,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,provider,effective_date)
);
CREATE TABLE accounts (
  id text PRIMARY KEY,
  owner_id text REFERENCES users(id),
  submitted_by text REFERENCES users(id),
  email text NOT NULL,
  label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(email)
);
CREATE TABLE bindings (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  connection_id text NOT NULL REFERENCES connections(id),
  external_id text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  daily_usd numeric(24,8) NOT NULL DEFAULT 0,
  cost_7d numeric(24,8),
  cost_30d numeric(24,8),
  utilization numeric(8,3),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id,external_id),
  UNIQUE(account_id,connection_id)
);
CREATE TABLE usage_days (
  id text PRIMARY KEY,
  binding_id text NOT NULL REFERENCES bindings(id),
  day date NOT NULL,
  raw_usd numeric(24,8) NOT NULL CHECK(raw_usd>=0),
  state text NOT NULL DEFAULT 'provisional' CHECK(state IN ('provisional','final')),
  source text NOT NULL,
  evidence text,
  root_rate numeric(5,4) NOT NULL,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(binding_id,day)
);
CREATE INDEX usage_days_date ON usage_days(day);
CREATE TABLE earnings (
  id text PRIMARY KEY,
  usage_id text NOT NULL REFERENCES usage_days(id),
  user_id text NOT NULL REFERENCES users(id),
  payer_id text REFERENCES users(id),
  next_user_id text REFERENCES users(id),
  rate numeric(5,4) NOT NULL,
  downstream_rate numeric(5,4) NOT NULL,
  gross_usd numeric(24,8) NOT NULL,
  downstream_usd numeric(24,8) NOT NULL,
  profit_usd numeric(24,8) NOT NULL,
  UNIQUE(usage_id,user_id)
);
CREATE INDEX earnings_user ON earnings(user_id);
CREATE TABLE invoices (
  id text PRIMARY KEY,
  number text UNIQUE NOT NULL,
  user_id text NOT NULL REFERENCES users(id),
  payer_id text REFERENCES users(id),
  date_from date NOT NULL,
  date_to date NOT NULL,
  gross_usd numeric(24,8) NOT NULL,
  downstream_usd numeric(24,8) NOT NULL,
  profit_usd numeric(24,8) NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','confirmed')),
  reference text,
  created_by text NOT NULL REFERENCES users(id),
  confirmed_by text REFERENCES users(id),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invoice_items (
  earning_id text PRIMARY KEY REFERENCES earnings(id),
  invoice_id text NOT NULL REFERENCES invoices(id)
);
CREATE TABLE withdrawals (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  payer_id text REFERENCES users(id),
  amount_usd numeric(24,8) NOT NULL CHECK(amount_usd>0),
  team_amount_usd numeric(24,8) NOT NULL DEFAULT 0 CHECK(team_amount_usd>=0 AND team_amount_usd<=amount_usd),
  method text NOT NULL,
  destination text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','paid','rejected')),
  reference text,
  reviewed_by text REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ledger (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK(kind IN ('settlement','withdrawal_hold','withdrawal_release')),
  amount_usd numeric(24,8) NOT NULL,
  reference_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(kind,reference_id)
);
CREATE INDEX ledger_user ON ledger(user_id);
CREATE TABLE team_fund_ledger (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK(kind IN ('funding','withdrawal_hold','withdrawal_release')),
  amount_usd numeric(24,8) NOT NULL,
  reference_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(kind,reference_id)
);
CREATE INDEX team_fund_ledger_user ON team_fund_ledger(user_id);
CREATE TABLE jobs (
  id text PRIMARY KEY,
  connection_id text NOT NULL REFERENCES connections(id),
  requested_by text NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK(kind IN ('sync','reconcile','oauth_start','oauth_exchange','import_rt','set_enabled')),
  payload text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed','needs_attention')),
  result jsonb,
  error text,
  idempotency_key text NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(requested_by,idempotency_key,connection_id,kind)
);
CREATE INDEX jobs_queue ON jobs(state,created_at);
CREATE UNIQUE INDEX jobs_one_sync ON jobs(connection_id) WHERE kind='sync' AND state IN ('queued','running');
CREATE TABLE oauth_attempts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  connection_id text NOT NULL REFERENCES connections(id),
  account_id text NOT NULL REFERENCES accounts(id),
  secret text NOT NULL,
  authorization_url text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','exchanging','done','needs_attention')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audits (
  id text PRIMARY KEY,
  actor_id text REFERENCES users(id),
  action text NOT NULL,
  target_id text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
