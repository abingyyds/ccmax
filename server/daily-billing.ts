import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import type { DB, Row } from './db.js';
import { AppError, assert, audit, id, MAX_USD, sum, today, usd } from './core.js';
import { createInvoiceInTransaction, ingestUsage } from './billing.js';
import { invoiceItems } from './invoice-preview.js';
import { assertUsageAccounting } from './financial-integrity.js';

export type DailyAmount = { externalId: string; rawUsd: string; sourceAt?:string|null; collectedAt?:string; origin?:string };
type Issue = { externalId?: string; userId?: string; message: string };
const safeError = (error: unknown) => error instanceof AppError ? error.message : '账单处理失败，将自动重试';

// User-row locking is shared with the manual invoice flow. A retry, another
// platform finishing later, or a second replica can only invoice unused items.
export async function createDailyInvoices(db: DB, owner: Row, day: string) {
  const users = await db.query(`SELECT DISTINCT e.user_id FROM earnings e JOIN usage_days d ON d.id=e.usage_id
    LEFT JOIN invoice_items i ON i.earning_id=e.id WHERE d.day=$1 AND d.state='final' AND i.earning_id IS NULL ORDER BY e.user_id`, [day]);
  let created = 0;
  const issues: Issue[] = [];
  for (const { user_id } of users) {
    try {
      const invoice = await db.transaction(async tx => {
        await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user_id]);
        if (!(await invoiceItems(tx, user_id, day, day, true)).length) return null;
        return createInvoiceInTransaction(tx, owner, user_id, day, day, undefined, true);
      });
      if (invoice) created++;
    } catch (error) { issues.push({ userId: user_id, message: safeError(error) }); }
  }
  return { created, issues };
}

async function automaticDayReady(db:DB,day:string,connectionId:string,hasIssues:boolean) {
  if(hasIssues)return false;
  const [result]=await db.query(`SELECT NOT EXISTS(
      SELECT 1 FROM connections c WHERE c.id<>$2
      AND ((c.enabled AND (c.created_at AT TIME ZONE 'Asia/Shanghai')::date<=$1)
        OR EXISTS(SELECT 1 FROM usage_days u JOIN bindings b ON b.id=u.binding_id WHERE b.connection_id=c.id AND u.day=$1))
      AND NOT EXISTS(SELECT 1 FROM billing_days d WHERE d.connection_id=c.id AND d.day=$1 AND d.state='succeeded' AND d.issue_count=0)
    ) AND NOT EXISTS(
      SELECT 1 FROM usage_days u JOIN bindings b ON b.id=u.binding_id JOIN accounts a ON a.id=b.account_id
      WHERE u.day=$1 AND a.ownership_verified AND u.state<>'final'
    ) AND NOT EXISTS(
      SELECT 1 FROM billing_entries e WHERE e.day=$1 AND e.state<>'recorded'
    ) AS ready`,[day,connectionId]);
  return !!result.ready;
}

export async function recordDailyStatement(db: DB, connection: Row, owner: Row, day: string, input: DailyAmount[],
  options:{basis?:'upstream'|'snapshot';autoFinalize?:boolean;issues?:Issue[];sourceError?:string;reviewed?:boolean}={}) {
  assert(day < today(), '仅可结算已经结束的北京时间日期');
  assert(Array.isArray(input) && input.length <= 100000, '历史账号结果不完整，未写入账本', 502);
  const seen = new Set<string>();
  const basis=options.basis??'upstream',autoFinalize=options.autoFinalize!==false,source=options.reviewed?'reviewed_statement':basis==='upstream'?'upstream_daily':'daily_snapshot';
  const rows = input.map(row => {
    assert(typeof row.externalId === 'string' && row.externalId.trim() && !seen.has(row.externalId), '历史用量金额或账号重复，未写入账本', 502);
    seen.add(row.externalId);
    let amount: Decimal;
    try { amount = new Decimal(row.rawUsd); } catch { throw new AppError(502, '历史用量金额或账号重复，未写入账本'); }
    assert(amount.isFinite() && amount.gte(0) && amount.lte(MAX_USD), '历史用量金额或账号重复，未写入账本', 502);
    return { externalId: row.externalId, rawUsd: amount.toFixed(),
      ...(basis==='snapshot'?{sourceAt:row.sourceAt??null,collectedAt:row.collectedAt,origin:row.origin??'upstream'}:{}) };
  }).sort((a, b) => a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0);
  const checksum = createHash('sha256').update(JSON.stringify([basis,rows])).digest('hex');
  const statement = await db.transaction(async tx => {
    await tx.query(`INSERT INTO upstream_statements(id,connection_id,day,checksum,rows,account_count,raw_usd,basis)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(connection_id,day,checksum) DO NOTHING`,
      [id(), connection.id, day, checksum, JSON.stringify(rows), rows.length, usd(sum(rows.map(row => usd(row.rawUsd)))),basis]);
    const [saved] = await tx.query('SELECT id FROM upstream_statements WHERE connection_id=$1 AND day=$2 AND checksum=$3', [connection.id, day, checksum]);
    await tx.query(`UPDATE billing_days SET statement_id=$3,account_count=$4,basis=$5 WHERE connection_id=$1 AND day=$2`, [connection.id, day, saved.id, rows.length,basis]);
    await tx.query(`UPDATE billing_entries SET state='blocked',error='上游完整日账单缺少已有用量账号，已保留原记录等待核对' WHERE connection_id=$1 AND day=$2`, [connection.id,day]);
    for (const row of rows) await tx.query(`INSERT INTO billing_entries(connection_id,day,external_id,usage_id,state)
      SELECT $1,$2,$3,(SELECT d.id FROM usage_days d JOIN bindings b ON b.id=d.binding_id WHERE b.connection_id=$1 AND b.external_id=$3 AND d.day=$2),'pending'
      ON CONFLICT(connection_id,day,external_id) DO UPDATE SET state='pending',error=NULL`, [connection.id,day,row.externalId]);
    return saved;
  });

  let finalized = 0;
  const issues: Issue[] = [...(options.issues??[])];
  // Archive first, then transact per account. One unassigned account must not
  // discard another agent's valid statement or hide the original source.
  for (const row of rows) {
    try {
      const recorded=await db.transaction(async tx => {
        const [binding] = await tx.query(`SELECT b.id,a.owner_id,a.ownership_verified FROM bindings b
          JOIN accounts a ON a.id=b.account_id WHERE b.connection_id=$1 AND b.external_id=$2`, [connection.id, row.externalId]);
        assert(binding, '历史账单账号尚未同步，请同步平台账号', 409);
        const owned=!!binding.owner_id&&binding.ownership_verified;
        const usageId = await ingestUsage(tx, { bindingId: binding.id, day, rawUsd: row.rawUsd, final: autoFinalize&&owned,
          source:options.reviewed&&owned?'reviewed_statement':source,sourceAt:row.sourceAt??undefined,
          evidence: `upstream_statement:${statement.id};sha256:${checksum}` });
        if(!autoFinalize||!owned) {
          const message=!owned?'账号归属待确认，账单已保留':'快照预估已存档，等待审核或启用快照自动出账';
          await tx.query(`UPDATE billing_entries SET state='blocked',usage_id=$4,error=$5 WHERE connection_id=$1 AND day=$2 AND external_id=$3`,[connection.id,day,row.externalId,usageId,message]);
          return message;
        }
        await assertUsageAccounting(tx, [usageId]);
        await tx.query(`UPDATE billing_entries SET state='recorded',usage_id=$4,error=NULL WHERE connection_id=$1 AND day=$2 AND external_id=$3`, [connection.id,day,row.externalId,usageId]);
      });
      if(recorded)issues.push({externalId:row.externalId,message:recorded});
      else finalized++;
    } catch (error) {
      const message=safeError(error);
      issues.push({ externalId: row.externalId, message });
      await db.query(`UPDATE billing_entries SET state='blocked',error=$4 WHERE connection_id=$1 AND day=$2 AND external_id=$3`, [connection.id,day,row.externalId,message]);
    }
  }
  const absent = await db.query(`SELECT d.id,b.external_id FROM bindings b JOIN accounts a ON a.id=b.account_id
    LEFT JOIN usage_days d ON d.binding_id=b.id AND d.day=$2
    WHERE b.connection_id=$1 AND NOT(b.external_id=ANY($3::text[])) AND a.ownership_verified
    AND b.status='active' AND b.local_enabled AND (b.created_at AT TIME ZONE 'Asia/Shanghai')::date<=$2`,
  [connection.id, day, rows.map(row => row.externalId)]);
  for (const row of absent) {
    const message='上游完整日账单缺少已连接账号，已阻止部分结算并等待自动重试';
    issues.push({ externalId: row.external_id, message });
    await db.query(`INSERT INTO billing_entries(connection_id,day,external_id,usage_id,state,error) VALUES($1,$2,$3,$4,'blocked',$5)
      ON CONFLICT(connection_id,day,external_id) DO UPDATE SET state='blocked',usage_id=EXCLUDED.usage_id,error=EXCLUDED.error`, [connection.id,day,row.external_id,row.id,message]);
  }

  const preliminaryState=issues.length?'needs_attention':'succeeded';
  await db.query(`UPDATE billing_days SET state=$3,finalized_count=$4,issue_count=$5,issues=$6,error=NULL,source_error=$7
    WHERE connection_id=$1 AND day=$2`,[connection.id,day,preliminaryState,finalized,issues.length,JSON.stringify(issues.slice(0,100)),options.sourceError??null]);
  const invoices = await automaticDayReady(db,day,connection.id,!!issues.length)
    ? await createDailyInvoices(db, owner, day) : {created:0,issues:[] as Issue[]};
  issues.push(...invoices.issues);
  const state = issues.length ? 'needs_attention' : 'succeeded';
  await db.transaction(async tx => {
    await tx.query(`UPDATE billing_days SET state=$3,finalized_count=$4,issue_count=$5,issues=$6,error=NULL,source_error=$7,
      completed_at=now(),next_attempt_at=now()+CASE WHEN $3='succeeded' THEN interval '6 hours' ELSE interval '1 hour' END
      WHERE connection_id=$1 AND day=$2`, [connection.id, day, state, finalized, issues.length, JSON.stringify(issues.slice(0,100)),options.sourceError??null]);
    await audit(tx, owner.id, 'billing.daily', statement.id, { connectionId: connection.id, day, accounts: rows.length, finalized, issues: issues.length, invoices: invoices.created });
  });
  return { day, statementId: statement.id, basis, accounts: rows.length, finalized, issueCount: issues.length, invoices: invoices.created, state };
}

export async function awaitSnapshotBilling(db:DB,connectionId:string,day:string,issues:Issue[],sourceError:string) {
  const state=issues.some(issue=>issue.message!=='当日用量数据待补齐')?'needs_attention':'awaiting_data';
  await db.query(`UPDATE billing_days SET state=$3,basis='snapshot',error=NULL,source_error=$4,
    account_count=$5,issue_count=$5,issues=$6,completed_at=NULL,next_attempt_at=now()+interval '1 hour'
    WHERE connection_id=$1 AND day=$2`,[connectionId,day,state,sourceError,issues.length,JSON.stringify(issues.slice(0,100))]);
  return {day,basis:'snapshot',state,accounts:issues.length,finalized:0,issueCount:issues.length,invoices:0};
}

export async function failDailyBilling(db: DB, connectionId: string, day: string, message: string) {
  await db.query(`UPDATE billing_days SET state='failed',error=$3,completed_at=now(),
    next_attempt_at=now()+LEAST(attempts,12)*interval '5 minutes' WHERE connection_id=$1 AND day=$2`, [connectionId, day, message]);
}
