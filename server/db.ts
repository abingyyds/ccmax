import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdir, readFile } from 'node:fs/promises';
import { hardenSchema, extendProviders, accountProxies, accountProxyRotation, bindingUsageControls, combinedWithdrawableFunds, integrationKeys, financialSources, signedSettlementSources, keyMarket, keyMarketSharedConnections, keyMarketSnapshotDeltas, keyMarketSubmissionIdempotency, keyManTemplate } from './migrations.js';
import { telemetryMigration } from './telemetry.js';
import { dailyBillingMigration } from './daily-billing-migration.js';
import { snapshotRecoveryMigration } from './snapshot-recovery-migration.js';
import { invitationMigration } from './invitations.js';
import { applyJadenSettlementRepair } from './jaden-settlement-repair.js';
import { applySettlementAutoReconciliation } from './settlement-auto-reconcile.js';

export type Row = Record<string, any>;
export interface DB {
  query<T extends Row = Row>(sql: string, params?: any[]): Promise<T[]>;
  transaction<T>(fn: (tx: DB) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDB(url?: string, localPath?: string): Promise<DB> {
  if (url) {
    // DATE is a Beijing billing calendar day, never a local-midnight instant.
    // pg's default Date conversion shifts it a day when ISO-formatted in UTC.
    const pool = new pg.Pool({ connectionString: url, max: 10, types: {
      getTypeParser: (oid,format) => oid===1082 ? (value:string)=>value : pg.types.getTypeParser(oid,format),
    } });
    const wrap = (client: pg.Pool | pg.PoolClient): DB => ({
      async query(sql, params = []) { return (await client.query(sql, params)).rows; },
      async transaction(fn) {
        if (!('connect' in client)) throw new Error('Nested transactions are not supported');
        const c = await pool.connect();
        try { await c.query('BEGIN'); const result = await fn(wrap(c)); await c.query('COMMIT'); return result; }
        catch (e) { await c.query('ROLLBACK'); throw e; }
        finally { c.release(); }
      },
      async close() { await pool.end(); },
    });
    return wrap(pool);
  }
  if (localPath) await mkdir(localPath, { recursive: true });
  const db = new PGlite({ dataDir: localPath, parsers: { 1082: value=>value } });
  const wrap = (client: any): DB => ({
    async query(sql, params = []) { return (await client.query(sql, params)).rows; },
    async transaction(fn) { return client.transaction((tx: any) => fn(wrap(tx))); },
    async close() { await db.close(); },
  });
  await db.waitReady;
  return wrap(db);
}

export async function migrate(db: DB) {
  const schema = await readFile(new URL('../../server/schema.sql', import.meta.url).pathname, 'utf8')
    .catch(() => readFile('server/schema.sql', 'utf8'));
  await db.transaction(async tx => {
    // Transaction-scoped lock also serializes startup across Railway replicas.
    await tx.query('SELECT pg_advisory_xact_lock(7164021)');
    await tx.query('CREATE TABLE IF NOT EXISTS migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = await tx.query('SELECT version FROM migrations ORDER BY version');
    if (!done.some(row=>Number(row.version)===1)) {
      // PostgreSQL accepts a migration batch, while PGlite intentionally rejects
      // multiple commands in one prepared statement. Execute each DDL statement
      // separately for the local development database.
      const statements = schema.split(/;\s*\n/).map(s=>s.trim()).filter(Boolean).map(s=>s+';');
      for (const statement of statements) await tx.query(statement);
      await tx.query('INSERT INTO migrations(version) VALUES (1)');
    }
    if (!done.some(row=>Number(row.version)===2)) {
      // v1 deployments stored only the current connection payout rate. Preserve
      // that contract as a baseline so historical imports never silently use a
      // later edited value. New rows are scheduled through the API below.
      await tx.query(`CREATE TABLE IF NOT EXISTS connection_rates (
        id text PRIMARY KEY,
        connection_id text NOT NULL REFERENCES connections(id),
        rate numeric(5,4) NOT NULL CHECK(rate>=0 AND rate<=1),
        effective_date date NOT NULL,
        created_by text REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(connection_id,effective_date)
      )`);
      await tx.query('CREATE INDEX IF NOT EXISTS connection_rates_lookup ON connection_rates(connection_id,effective_date DESC)');
      await tx.query(`INSERT INTO connection_rates(id,connection_id,rate,effective_date,created_by)
        SELECT md5(c.id || ':baseline'),c.id,c.payout_rate,DATE '1970-01-01',u.id
        FROM connections c LEFT JOIN users u ON u.role='owner'
        ON CONFLICT(connection_id,effective_date) DO NOTHING`);
      await tx.query('INSERT INTO migrations(version) VALUES (2)');
    }
    if (!done.some(row=>Number(row.version)===3)) {
      await hardenSchema(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (3)');
    }
    if (!done.some(row=>Number(row.version)===4)) {
      await extendProviders(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (4)');
    }
    if (!done.some(row=>Number(row.version)===5)) {
      await accountProxies(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (5)');
    }
    if (!done.some(row=>Number(row.version)===6)) {
      await integrationKeys(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (6)');
    }
    if (!done.some(row=>Number(row.version)===7)) {
      await financialSources(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (7)');
    }
    if (!done.some(row=>Number(row.version)===8)) {
      await signedSettlementSources(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (8)');
    }
    if (!done.some(row=>Number(row.version)===9)) {
      await telemetryMigration(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (9)');
    }
    if (!done.some(row=>Number(row.version)===10)) {
      // Missing upstream counters are unknown, never a zero-dollar observation.
      // This affects operational snapshots only; financial history is untouched.
      await tx.query('ALTER TABLE bindings ALTER COLUMN daily_usd DROP NOT NULL');
      await tx.query('INSERT INTO migrations(version) VALUES (10)');
    }
    if (!done.some(row=>Number(row.version)===11)) {
      // A code is single-use across every platform for its submitting user.
      // Retain only its hash after jobs erase the sensitive callback payload.
      await tx.query(`CREATE TABLE oauth_code_claims (
        user_id text NOT NULL REFERENCES users(id),
        code_hash text NOT NULL,
        attempt_id text NOT NULL UNIQUE REFERENCES oauth_attempts(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(user_id,code_hash)
      )`);
      await tx.query('INSERT INTO migrations(version) VALUES (11)');
    }
    if (!done.some(row=>Number(row.version)===12)) {
      await dailyBillingMigration(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (12)');
    }
    if (!done.some(row=>Number(row.version)===13)) {
      await snapshotRecoveryMigration(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (13)');
    }
    if (!done.some(row=>Number(row.version)===14)) {
      await invitationMigration(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (14)');
    }
    if (!done.some(row=>Number(row.version)===15)) {
      await extendProviders(tx,['connections','rates','invitation_rates']);
      await tx.query('INSERT INTO migrations(version) VALUES (15)');
    }
    if (!done.some(row=>Number(row.version)===16)) {
      await keyMarket(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (16)');
    }
    if (!done.some(row=>Number(row.version)===17)) {
      await keyMarketSharedConnections(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (17)');
    }
    if (!done.some(row=>Number(row.version)===18)) {
      await keyMarketSnapshotDeltas(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (18)');
    }
    if (!done.some(row=>Number(row.version)===19)) {
      await keyMarketSubmissionIdempotency(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (19)');
    }
    if (!done.some(row=>Number(row.version)===20)) {
      await keyManTemplate(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (20)');
    }
    if (!done.some(row=>Number(row.version)===21)) {
      await tx.query('ALTER TABLE billing_days ADD COLUMN IF NOT EXISTS reviewed boolean NOT NULL DEFAULT false');
      await tx.query('INSERT INTO migrations(version) VALUES (21)');
    }
    if (!done.some(row=>Number(row.version)===22)) {
      // Keep the snapshot-review column available even for deployments that
      // previously used migration 21 for the combined wallet change.
      await tx.query('ALTER TABLE billing_days ADD COLUMN IF NOT EXISTS reviewed boolean NOT NULL DEFAULT false');
      await combinedWithdrawableFunds(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (22)');
    }
    if (!done.some(row=>Number(row.version)===23)) {
      await applyJadenSettlementRepair(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (23)');
    }
    if (!done.some(row=>Number(row.version)===24)) {
      await tx.query('ALTER TABLE connections ADD COLUMN IF NOT EXISTS upstream_snapshot jsonb');
      await tx.query('INSERT INTO migrations(version) VALUES (24)');
    }
    if (!done.some(row=>Number(row.version)===25)) {
      // Platform E was added after the original provider constraint migration.
      // Existing databases therefore need their three provider checks rebuilt
      // before an aeromax connection can be created.
      await extendProviders(tx,['connections','rates','invitation_rates']);
      await tx.query('INSERT INTO migrations(version) VALUES (25)');
    }
    if (!done.some(row=>Number(row.version)===26)) {
      // Existing bindings start participating in completeness checks from this
      // deployment forward; newly created bindings retain their real timestamp.
      await tx.query('ALTER TABLE bindings ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()');
      await applySettlementAutoReconciliation(tx);
      await tx.query('INSERT INTO migrations(version) VALUES (26)');
    }
    // Compatibility upgrades that do not change the numbered migration
    // contract: verified account proxy rotation and local usage pausing are
    // safe to apply idempotently on every startup, including v20 databases.
    await accountProxyRotation(tx);
    await bindingUsageControls(tx);
  });
}
