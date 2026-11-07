import type { DB, Row } from './db.js';
import { assert, id, nextDay, type SecretBox } from './core.js';
import { enqueue } from './worker.js';

export const billingDayAt = (now: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
export const shiftBillingDay = (day: string, delta: number) => new Date(Date.parse(day+'T00:00:00Z')+delta*86400000).toISOString().slice(0,10);
// Leave two hours for upstream daily counters to settle. No server-local dates.
export const billingThrough = (now = new Date()) => shiftBillingDay(billingDayAt(new Date(now.getTime()-2*3600000)), -1);

export function billingSchedule(now = new Date()) {
  const current = billingDayAt(now);
  const scheduledAt = new Date(current+'T02:00:00+08:00');
  return {
    day: shiftBillingDay(current,-1), scheduledAt: scheduledAt.toISOString(),
    waiting: now < scheduledAt, through: billingThrough(now), timezone: 'Asia/Shanghai',
  };
}

async function queueDay(tx: DB, box: SecretBox, owner: Row, connectionId: string, day: string) {
  const [active] = await tx.query(`SELECT id,state FROM jobs WHERE connection_id=$1 AND kind='daily_billing'
    AND subject_id=$2 AND state IN ('queued','running')`, [connectionId, day]);
  if (active) return active;
  const job = await enqueue(tx, box, owner.id, connectionId, 'daily_billing', { day }, id());
  await tx.query(`INSERT INTO billing_days(connection_id,day,job_id) VALUES($1,$2,$3)
    ON CONFLICT(connection_id,day) DO UPDATE SET job_id=EXCLUDED.job_id,state='queued',next_attempt_at=now()+interval '1 hour'`, [connectionId, day, job.id]);
  return job;
}

export async function queueBillingRange(db: DB, box: SecretBox, owner: Row, connectionIds: string[], from: string, to: string) {
  assert(owner.role==='owner', '仅管理员可读取历史对账数据', 403);
  assert(from<=to && to< billingDayAt(new Date()), '仅可结算已经结束的北京时间日期');
  assert(Date.parse(to)-Date.parse(from)<=30*86400000, '每次最多补采 31 天账单');
  return db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(7164023)');
    const connections = await tx.query('SELECT id FROM connections WHERE enabled=true AND id=ANY($1::text[])', [connectionIds]);
    assert(connections.length===new Set(connectionIds).size && connections.length>0, '连接不存在或已停用');
    const jobs: Row[] = [];
    for (const c of connections) for (let day=to; day>=from; day=shiftBillingDay(day,-1)) jobs.push(await queueDay(tx,box,owner,c.id,day));
    return jobs;
  });
}

export async function scheduleDailyBilling(db: DB, box: SecretBox, now = new Date()) {
  return db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(7164023)');
    const [owner] = await tx.query("SELECT * FROM users WHERE role='owner' AND active=true");
    if (!owner) return [];
    // During a rolling deployment an old worker can finish after the migration
    // and restore its obsolete 403/no-snapshot failure. Recover that expected
    // fallback automatically instead of waiting for the old failure backoff.
    await tx.query(`UPDATE billing_days d SET state='awaiting_data',error=NULL,
      source_error=COALESCE(d.source_error,d.error),next_attempt_at=$1
      FROM connections c WHERE c.id=d.connection_id AND c.snapshot_billing
      AND d.state='failed' AND d.basis='snapshot'
      AND d.error ~ '读取历史日账单失败（HTTP (403|404)'`,[now]);
    const through = billingThrough(now), current = billingDayAt(now);
    // Older workers could retire an interrupted job without releasing its day.
    // An active replacement protects the day even if job_id still points back.
    await tx.query(`UPDATE billing_days d SET state='failed',error='日账单任务执行中断，将自动重试',
      completed_at=now(),next_attempt_at=now()
      WHERE d.day<=$1 AND d.state IN ('queued','running') AND d.job_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.connection_id=d.connection_id AND j.kind='daily_billing'
        AND j.subject_id=d.day::text AND j.state IN ('queued','running'))`,[through]);
    const connections = await tx.query(`SELECT c.id,LEAST((c.created_at AT TIME ZONE 'Asia/Shanghai')::date,
      (SELECT min(r.effective_date) FROM connection_rates r WHERE r.connection_id=c.id),
      (SELECT min(d.day) FROM usage_days d JOIN bindings b ON b.id=d.binding_id WHERE b.connection_id=c.id))::text AS first_day
      FROM connections c WHERE c.enabled=true`);
    const jobs: Row[] = [];
    for (const c of connections) {
      const days = await tx.query('SELECT * FROM billing_days WHERE connection_id=$1', [c.id]);
      const active = await tx.query(`SELECT subject_id FROM jobs WHERE connection_id=$1 AND kind='daily_billing' AND state IN ('queued','running')`, [c.id]);
      let capacity = Math.max(0, 2-active.length);
      const start = c.first_day > shiftBillingDay(current,-30) ? c.first_day : shiftBillingDay(current,-30);
      const candidates = new Set(days.filter(d=>d.day<=through && d.state!=='succeeded').map(d=>String(d.day)));
      for (let day=start; day<=through; day=nextDay(day)) candidates.add(day);
      for (const day of [...candidates].sort().reverse()) {
        if (!capacity) break;
        if (active.some(j=>j.subject_id===day)) continue;
        const previous = days.find(d=>d.day===day);
        if (previous && new Date(previous.next_attempt_at)>now) continue;
        if (previous?.state==='succeeded' && day<shiftBillingDay(current,-3)) continue;
        jobs.push(await queueDay(tx,box,owner,c.id,day));
        capacity--;
      }
    }
    return jobs;
  });
}

export async function scheduleBillingSnapshots(db: DB, box: SecretBox, now = new Date()) {
  const time=new Date(now.getTime()+8*3600000),minute=time.getUTCHours()*60+time.getUTCMinutes();
  const closing=minute>=23*60+55||minute<=10;
  if(!closing && minute%5!==0)return [];
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(7164023)');
    const [owner]=await tx.query("SELECT * FROM users WHERE role='owner' AND active=true");
    if(!owner)return [];
    const connections=await tx.query("SELECT id FROM connections WHERE enabled=true AND provider<>'accedra'");
    const jobs:Row[]=[];
    const minuteKey=`snapshot:${Math.floor(now.getTime()/60000)}`;
    for(const c of connections)jobs.push(await enqueue(tx,box,owner.id,c.id,'billing_snapshot',{},minuteKey));
    return jobs;
  });
}
