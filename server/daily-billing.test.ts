import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, type DB, type Row } from './db.js';
import { openTestDB } from './test-db.js';
import { bootstrap, id, secretBox, today } from './core.js';
import { createDailyInvoices, recordDailyStatement } from './daily-billing.js';
import { billingSchedule, billingThrough, queueBillingRange, scheduleBillingSnapshots, scheduleDailyBilling, shiftBillingDay } from './billing-scheduler.js';
import { saveBillingSnapshot, snapshotDay } from './billing-snapshots.js';
import { createWorker, enqueue } from './worker.js';
import { ProviderClient, UpstreamError, type UpstreamAccount } from './providers.js';
import { normalizeTelemetry } from './telemetry.js';
import { balance, confirmInvoice, createInvoice, ingestUsage } from './billing.js';
import { createApp } from './app.js';

const box=secretBox('bd'.repeat(32));
const day=shiftBillingDay(today(),-1);

describe('automatic daily billing',()=>{
  let db:DB,owner:Row,agent:Row,leaf:Row,connection:Row,binding:Row;
  beforeEach(async()=>{
    db=await openTestDB();await migrate(db);
    await bootstrap(db,{ADMIN_EMAIL:'owner@billing.test',ADMIN_PASSWORD:'billing-test-password'});
    [owner]=await db.query("SELECT * FROM users WHERE role='owner'");
    [agent]=await db.query("INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,'agent@billing.test','Agent','x') RETURNING *",[id(),owner.id]);
    [leaf]=await db.query("INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,'leaf@billing.test','Leaf','x') RETURNING *",[id(),agent.id]);
    [connection]=await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate,created_at) VALUES($1,'ai008','Private upstream',$2,0.3,$3) RETURNING *",[id(),box.encrypt({username:'fixture',password:'fixture'}),day+'T00:00:00+08:00']);
    await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date) VALUES($1,$2,0.3,$3)",[id(),connection.id,day]);
    for(const [u,rate] of [[agent,'0.2'],[leaf,'0.1']] as const)await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,'ai008',$3,$4,$5)",[id(),u.id,rate,day,owner.id]);
    binding=await account('real',leaf.id);
    await db.query('INSERT INTO billing_days(connection_id,day) VALUES($1,$2)',[connection.id,day]);
  });
  afterEach(async()=>{await db.close();});
  async function account(externalId:string,userId:string|null,verified=true) {
    const accountId=id();
    await db.query('INSERT INTO accounts(id,owner_id,email,ownership_verified,created_at) VALUES($1,$2,$3,$4,$5)',[accountId,userId,externalId+'@claude.test',verified,day+'T00:00:00+08:00']);
    const [b]=await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$4) RETURNING *',[id(),accountId,connection.id,externalId]);return b;
  }
  const observation=(sourceDay:string,hour='23:59:00',value='100'):UpstreamAccount=>{
    const sourceAt=new Date(sourceDay+'T'+hour+'+08:00').toISOString();
    const telemetry=normalizeTelemetry('gatelink',{upstreamSyncedAt:sourceAt,upstreamDailyCost:value});
    // Test historical source days without changing the clock used for billing.
    telemetry.sourceAt=sourceAt;telemetry.collectedAt=sourceAt;telemetry.day=sourceDay;
    return {id:'real',email:'real@claude.test',name:'Real',status:'active',dailyUsd:value,cost7d:null,cost30d:null,utilization:null,telemetry};
  };
  async function saveAt(hour:string,value='100'){await saveBillingSnapshot(db,binding.id,observation(day,hour,value));}

  it('archives complete per-account statements, invoices every level exactly once and waits for real receipt',async()=>{
    const first=await recordDailyStatement(db,connection,owner,day,[{externalId:'real',rawUsd:'100.00000001'}]);
    expect(first).toMatchObject({state:'succeeded',finalized:1,invoices:3,basis:'upstream'});
    const statements=await db.query('SELECT * FROM upstream_statements');expect(statements).toHaveLength(1);
    expect(statements[0].raw_usd).toBe('100.00000001');
    const invoices=await db.query('SELECT * FROM invoices');expect(invoices.every(i=>i.automatic&&!i.estimated&&i.state==='pending')).toBe(true);
    expect(await db.query('SELECT * FROM ledger')).toHaveLength(0);expect((await balance(db,leaf.id)).available).toBe('0.00000000');
    expect((await recordDailyStatement(db,connection,owner,day,[{externalId:'real',rawUsd:'100.00000001'}])).invoices).toBe(0);
    expect(await db.query('SELECT * FROM invoices')).toHaveLength(3);expect(await db.query('SELECT * FROM upstream_statements')).toHaveLength(1);
    const chain=[owner,agent,leaf];
    for(let i=0;i<chain.length;i++)await confirmInvoice(db,chain[Math.max(0,i-1)],invoices.find(b=>b.user_id===chain[i].id)!.id,'verified real receipt');
    expect((await balance(db,owner.id)).available).toBe('30.00000000');
    expect((await balance(db,agent.id)).available).toBe('20.00000000');
    expect((await balance(db,leaf.id)).available).toBe('10.00000000');
  });

  it('waits for every eligible platform day before creating automatic invoices',async()=>{
    const [second]=await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate,created_at) VALUES($1,'ai008','Second upstream',$2,0.3,$3) RETURNING *",[id(),box.encrypt({username:'fixture',password:'fixture'}),day+'T00:00:00+08:00']);
    await db.query('INSERT INTO connection_rates(id,connection_id,rate,effective_date) VALUES($1,$2,0.3,$3)',[id(),second.id,day]);
    const accountId=id(),secondBinding=id();
    await db.query('INSERT INTO accounts(id,owner_id,email,ownership_verified,created_at) VALUES($1,$2,$3,true,$4)',[accountId,leaf.id,'second@claude.test',day+'T00:00:00+08:00']);
    await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$4)',[secondBinding,accountId,second.id,'second']);
    await db.query('INSERT INTO billing_days(connection_id,day) VALUES($1,$2)',[second.id,day]);

    const first=await recordDailyStatement(db,connection,owner,day,[{externalId:'real',rawUsd:'100'}]);
    expect(first.invoices).toBe(0);
    expect(await db.query('SELECT * FROM invoices')).toHaveLength(0);

    const complete=await recordDailyStatement(db,second,owner,day,[{externalId:'second',rawUsd:'50'}]);
    expect(complete.invoices).toBe(3);
    expect(await db.query('SELECT * FROM invoice_items')).toHaveLength(6);
  });

  it('blocks a partial statement when an already-connected verified account is absent',async()=>{
    await db.query('ALTER TABLE bindings ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()');
    await db.query('UPDATE bindings SET created_at=$2 WHERE id=$1',[binding.id,day+'T00:00:00+08:00']);
    const missing=await account('missing',leaf.id);
    await db.query('UPDATE bindings SET created_at=$2 WHERE id=$1',[missing.id,day+'T00:00:00+08:00']);

    const result=await recordDailyStatement(db,connection,owner,day,[{externalId:'real',rawUsd:'100'}]);

    expect(result).toMatchObject({state:'needs_attention',invoices:0,issueCount:1});
    expect(await db.query('SELECT * FROM invoices')).toHaveLength(0);
    expect(await db.query("SELECT external_id,state FROM billing_entries WHERE external_id='missing'"))
      .toEqual([{external_id:'missing',state:'blocked'}]);
  });

  it('archives unassigned accounts and missing prices while settling unrelated accounts, then retries without duplicate invoices',async()=>{
    const unassigned=await account('unassigned',null,false);
    const input=[{externalId:'real',rawUsd:'100'},{externalId:'unassigned',rawUsd:'10'}];
    const first=await recordDailyStatement(db,connection,owner,day,input);
    expect(first).toMatchObject({state:'needs_attention',finalized:1,issueCount:1,invoices:0});
    expect((await db.query('SELECT * FROM upstream_statements'))[0].rows).toHaveLength(2);
    await db.query('UPDATE accounts SET owner_id=$2,ownership_verified=true WHERE id=$1',[unassigned.account_id,agent.id]);
    const second=await recordDailyStatement(db,connection,owner,day,input);
    expect(second).toMatchObject({state:'succeeded',finalized:2,invoices:3});
    expect(await db.query('SELECT * FROM invoice_items')).toHaveLength(5);
    expect(await db.query('SELECT * FROM upstream_statements')).toHaveLength(1);
  });

  it('preserves amounts with missing historical rates and records them after the contract is supplied',async()=>{
    await db.query('DELETE FROM rates WHERE user_id=$1',[leaf.id]);
    const first=await recordDailyStatement(db,connection,owner,day,[{externalId:'real',rawUsd:'12.34567890'}]);
    expect(first).toMatchObject({state:'needs_attention',finalized:0,invoices:0});
    expect(await db.query('SELECT * FROM usage_days')).toHaveLength(0);
    expect((await db.query('SELECT raw_usd FROM upstream_statements'))[0].raw_usd).toBe('12.34567890');
    await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,'ai008',0.1,$3,$4)",[id(),leaf.id,day,agent.id]);
    expect((await recordDailyStatement(db,connection,owner,day,[{externalId:'real',rawUsd:'12.34567890'}])).state).toBe('succeeded');
  });

  it('archives conflicting upstream revisions without rewriting sealed amounts or producing new invoices',async()=>{
    await recordDailyStatement(db,connection,owner,day,[{externalId:'real',rawUsd:'100'}]);
    const result=await recordDailyStatement(db,connection,owner,day,[{externalId:'real',rawUsd:'101'}]);
    expect(result).toMatchObject({state:'needs_attention',finalized:0,invoices:0});
    expect(await db.query('SELECT * FROM upstream_statements')).toHaveLength(2);
    expect((await db.query('SELECT raw_usd FROM usage_days'))[0].raw_usd).toBe('100.00000000');
    expect((await db.query('SELECT state FROM billing_entries'))[0].state).toBe('blocked');
    await expect(db.query("UPDATE upstream_statements SET raw_usd=0")).rejects.toThrow('append-only');
  });

  it('does not manufacture zero daily statements for missing accounts or accept repeated IDs',async()=>{
    await expect(recordDailyStatement(db,connection,owner,day,[{externalId:'real',rawUsd:'10'},{externalId:'real',rawUsd:'10'}])).rejects.toThrow('重复');
    expect(await db.query('SELECT * FROM upstream_statements')).toHaveLength(0);
    const empty=await recordDailyStatement(db,connection,owner,day,[]);expect(empty.finalized).toBe(0);
    expect(await db.query('SELECT * FROM usage_days')).toHaveLength(0);
  });

  it('uses the upstream day across midnight and chooses the latest near-midnight source instead of the next reset or the daily maximum',async()=>{
    await saveAt('23:55:00','99');await saveAt('23:59:00','100');
    const delayed=observation(day,'23:59:30','101');delayed.telemetry!.collectedAt=new Date(shiftBillingDay(day,1)+'T00:02:00+08:00').toISOString();
    await saveBillingSnapshot(db,binding.id,delayed);
    await saveBillingSnapshot(db,binding.id,observation(shiftBillingDay(day,1),'00:03:00','0'));
    const snapshot=await snapshotDay(db,connection,day);
    expect(snapshot.rows).toMatchObject([{externalId:'real',rawUsd:'101.00000000',sourceAt:delayed.telemetry!.sourceAt}]);
    expect(snapshot.issues).toHaveLength(0);
  });

  it('uses the last available same-day snapshot while retaining missing and regressed counters as issues',async()=>{
    expect(await snapshotDay(db,connection,day)).toMatchObject({rows:[],issues:[{message:'当日用量数据待补齐'}]});
    await saveAt('23:40:00','100');expect((await snapshotDay(db,connection,day)).rows).toMatchObject([{rawUsd:'100.00000000'}]);
    await saveAt('23:59:00','0');const result=await snapshotDay(db,connection,day);
    expect(result.rows).toHaveLength(0);expect(result.issues[0].message).toContain('回退');
    expect(await db.query('SELECT * FROM billing_snapshots')).toHaveLength(2);
  });
  it('rejects a counter regression even when the upstream source timestamp was not advanced',async()=>{
    await saveAt('23:59:00','100');
    const changed=observation(day,'23:59:00','99');changed.telemetry!.collectedAt=new Date(day+'T23:59:10+08:00').toISOString();
    await saveBillingSnapshot(db,binding.id,changed);
    const result=await snapshotDay(db,connection,day);
    expect(result.rows).toHaveLength(0);expect(result.issues[0].message).toContain('回退');
  });
  it('recovers an interrupted snapshot quickly while preserving a live collector lease',async()=>{
    const expired=await enqueue(db,box,owner.id,connection.id,'billing_snapshot',{},id());
    await db.query("UPDATE jobs SET state='running',started_at=now()-interval '2 minutes',heartbeat_at=now()-interval '2 minutes' WHERE id=$1",[expired.id]);
    const worker=createWorker(db,box);await worker.recover();
    expect((await db.query('SELECT state FROM jobs WHERE id=$1',[expired.id]))[0].state).toBe('failed');
    const live=await enqueue(db,box,owner.id,connection.id,'billing_snapshot',{},id());
    await db.query("UPDATE jobs SET state='running',started_at=now()-interval '5 minutes',heartbeat_at=now() WHERE id=$1",[live.id]);
    await worker.recover();expect((await db.query('SELECT state FROM jobs WHERE id=$1',[live.id]))[0].state).toBe('running');
  });

  it('retries an expired daily billing lease promptly and finishes a partially invoiced day exactly once',async()=>{
    await db.transaction(tx=>ingestUsage(tx,{bindingId:binding.id,day,rawUsd:'100',final:true,source:'upstream_daily'}));
    const invoice=await createInvoice(db,owner,owner.id,day,day);
    await confirmInvoice(db,owner,invoice.id,'receipt before interruption');
    const existing=await db.query('SELECT * FROM invoices ORDER BY id');
    const ledger=await db.query('SELECT * FROM ledger ORDER BY id');
    const job=(await queueBillingRange(db,box,owner,[connection.id],day,day))[0];
    await db.query("UPDATE jobs SET state='running',started_at=now()-interval '2 minutes',heartbeat_at=now()-interval '2 minutes' WHERE id=$1",[job.id]);
    await db.query("UPDATE billing_days SET state='running',attempts=1,next_attempt_at=now()+interval '1 hour' WHERE connection_id=$1",[connection.id]);
    const worker=createWorker(db,box,()=>({login:async()=>{},historicalDay:async()=>[{externalId:'real',rawUsd:'100'}]} as unknown as ProviderClient),['daily_billing']);
    await worker.recover();
    expect((await db.query('SELECT state FROM jobs WHERE id=$1',[job.id]))[0].state).toBe('failed');
    expect((await db.query('SELECT state,next_attempt_at<=now() AS retry_due FROM billing_days'))[0]).toEqual({state:'failed',retry_due:true});
    const now=new Date(Math.max(Date.now(),Date.parse(today()+'T02:00:00+08:00')));
    expect(await scheduleDailyBilling(db,box,now)).toHaveLength(1);
    expect(await scheduleDailyBilling(db,box,now)).toHaveLength(0);
    await worker.tick();
    expect((await db.query('SELECT state FROM billing_days'))[0].state).toBe('succeeded');
    expect(await db.query("SELECT * FROM invoices WHERE state='confirmed' ORDER BY id")).toEqual(existing);
    expect(await db.query('SELECT * FROM invoices')).toHaveLength(3);
    expect(await db.query('SELECT * FROM ledger ORDER BY id')).toEqual(ledger);
  });

  it.each(['daily_billing','billing_snapshot'])('keeps a %s job with a live heartbeat even after thirty minutes',async kind=>{
    const job=await enqueue(db,box,owner.id,connection.id,kind,kind==='daily_billing'?{day}:{},id());
    await db.query("UPDATE jobs SET state='running',started_at=now()-interval '31 minutes',heartbeat_at=now() WHERE id=$1",[job.id]);
    await createWorker(db,box).recover();
    expect((await db.query('SELECT state FROM jobs WHERE id=$1',[job.id]))[0].state).toBe('running');
  });

  it.each(['queued','running'])('repairs an orphaned %s billing day left by an older worker without waiting for its queue backoff',async state=>{
    const job=(await queueBillingRange(db,box,owner,[connection.id],day,day))[0];
    await db.query("UPDATE jobs SET state='needs_attention',completed_at=now() WHERE id=$1",[job.id]);
    await db.query("UPDATE billing_days SET state=$2,next_attempt_at=now()+interval '1 hour' WHERE connection_id=$1",[connection.id,state]);
    const now=new Date(Math.max(Date.now(),Date.parse(today()+'T02:00:00+08:00')));
    expect(await scheduleDailyBilling(db,box,now)).toHaveLength(1);
    expect((await db.query('SELECT job_id FROM billing_days'))[0].job_id).not.toBe(job.id);
    expect(await scheduleDailyBilling(db,box,now)).toHaveLength(0);
  });

  it('renews a live daily lease during a slow history read so recovery cannot start a duplicate settlement',async()=>{
    let ready!:()=>void,release!:(rows:{externalId:string;rawUsd:string}[])=>void;
    const started=new Promise<void>(resolve=>{ready=resolve;}),history=new Promise<{externalId:string;rawUsd:string}[]>(resolve=>{release=resolve;});
    const job=(await queueBillingRange(db,box,owner,[connection.id],day,day))[0];
    vi.useFakeTimers({toFake:['setInterval','clearInterval']});
    const worker=createWorker(db,box,()=>({login:async()=>{},historicalDay:async()=>{ready();return history;}} as unknown as ProviderClient));
    const running=worker.runOne();
    try {
      await started;
      await db.query("UPDATE jobs SET started_at=now()-interval '31 minutes',heartbeat_at=now()-interval '89 seconds' WHERE id=$1",[job.id]);
      await vi.advanceTimersByTimeAsync(10000);
      await expect.poll(async()=>(await db.query("SELECT heartbeat_at>now()-interval '5 seconds' AS fresh FROM jobs WHERE id=$1",[job.id]))[0].fresh).toBe(true);
      await createWorker(db,box).recover();
      expect((await db.query('SELECT state FROM jobs WHERE id=$1',[job.id]))[0].state).toBe('running');
      release([{externalId:'real',rawUsd:'100'}]);await running;
      expect(await db.query('SELECT * FROM invoices')).toHaveLength(3);
    } finally {release([{externalId:'real',rawUsd:'100'}]);await running;vi.useRealTimers();}
  });

  it('keeps an active replacement and real request-failure backoff while automatically retrying a timed out query',async()=>{
    const job=(await queueBillingRange(db,box,owner,[connection.id],day,day))[0];
    await db.query("UPDATE jobs SET state='needs_attention' WHERE id=$1",[job.id]);
    const replacement=await enqueue(db,box,owner.id,connection.id,'daily_billing',{day},id());
    const now=new Date(Math.max(Date.now(),Date.parse(today()+'T02:00:00+08:00')));
    expect(await scheduleDailyBilling(db,box,now)).toHaveLength(0);
    expect((await db.query('SELECT state,job_id FROM billing_days'))[0]).toEqual({state:'queued',job_id:job.id});
    await db.query('UPDATE billing_days SET job_id=$1',[replacement.id]);
    let attempts=0;
    const worker=createWorker(db,box,()=>({login:async()=>{},historicalDay:async()=>{
      if(++attempts===1)throw new UpstreamError(0,'平台请求超时（25 秒）');
      return [{externalId:'real',rawUsd:'100'}];
    }} as unknown as ProviderClient),['daily_billing']);
    await worker.tick();
    const [failed]=await db.query('SELECT state,error,next_attempt_at>now() AS backed_off FROM billing_days');
    expect(failed).toEqual({state:'failed',error:'平台请求超时（25 秒）',backed_off:true});
    expect(await scheduleDailyBilling(db,box,new Date(Math.max(Date.now(),now.getTime())))).toHaveLength(0);
    await db.query("UPDATE billing_days SET next_attempt_at=now()-interval '1 second'");
    expect(await scheduleDailyBilling(db,box,new Date(Math.max(Date.now(),now.getTime())))).toHaveLength(1);
    await worker.tick();
    expect((await db.query('SELECT state FROM billing_days'))[0].state).toBe('succeeded');
    expect(await db.query('SELECT * FROM invoices')).toHaveLength(3);
    expect(await db.query('SELECT * FROM ledger')).toHaveLength(0);
  });
  it('keeps snapshot writes for other accounts when an upstream ID changes email',async()=>{
    const other=await account('other',leaf.id),valid=observation(day),changed={...observation(day),email:'someone-else@claude.test'};
    const job=await enqueue(db,box,owner.id,connection.id,'billing_snapshot',{},id());
    const client={login:async()=>({}),captureSnapshots:async(consume:(row:UpstreamAccount)=>Promise<void>)=>{
      let issueCount=0;for(const row of [changed,{...valid,id:'other',email:'other@claude.test'}])try{await consume(row);}catch{issueCount++;}
      return {accounts:1,issueCount};
    }} as unknown as ProviderClient;
    await createWorker(db,box,()=>client).runOne();
    expect((await db.query('SELECT state,result FROM jobs WHERE id=$1',[job.id]))[0]).toMatchObject({state:'needs_attention',result:{accounts:1,issueCount:1}});
    const rows=await db.query('SELECT binding_id FROM billing_snapshots');expect(rows).toEqual([{binding_id:other.id}]);
  });
  it('serializes simultaneous automatic invoice attempts without duplicating earning items',async()=>{
    await db.transaction(tx=>ingestUsage(tx,{bindingId:binding.id,day,rawUsd:'100',final:true,source:'upstream_daily'}));
    const result=await Promise.all([createDailyInvoices(db,owner,day),createDailyInvoices(db,owner,day)]);
    expect(result.reduce((n,r)=>n+r.created,0)).toBe(3);expect(result.every(r=>!r.issues.length)).toBe(true);
    expect(await db.query('SELECT * FROM invoices')).toHaveLength(3);
    expect(await db.query('SELECT * FROM invoice_items')).toHaveLength(3);
  });

  it('uses configured snapshot estimates when the real history endpoint denies access and labels every derived invoice',async()=>{
    await saveAt('23:59:00','100');
    await db.query('UPDATE connections SET snapshot_billing=true WHERE id=$1',[connection.id]);
    const job=await enqueue(db,box,owner.id,connection.id,'daily_billing',{day},id());
    const worker=createWorker(db,box,()=>({login:async()=>({}),historicalDay:async()=>{throw new UpstreamError(403,'history HTTP 403');}} as unknown as ProviderClient));
    await worker.runOne();
    const [saved]=await db.query('SELECT * FROM jobs WHERE id=$1',[job.id]);
    expect(saved.state).toBe('succeeded');expect(saved.result).toMatchObject({basis:'snapshot',finalized:1,invoices:3});
    expect((await db.query('SELECT * FROM invoices')).every(i=>i.estimated)).toBe(true);
    expect((await db.query('SELECT source FROM usage_days'))[0].source).toBe('daily_snapshot');
    const [progress]=await db.query('SELECT * FROM billing_days');expect(progress.basis).toBe('snapshot');expect(progress.error).toBeNull();expect(progress.source_error).toContain('403');
  });

  it('always prefers the directly readable daily statement over an available snapshot',async()=>{
    await saveAt('23:59:00','99');
    await db.query('UPDATE connections SET snapshot_billing=true WHERE id=$1',[connection.id]);
    await enqueue(db,box,owner.id,connection.id,'daily_billing',{day},id());
    await createWorker(db,box,()=>({login:async()=>({}),historicalDay:async()=>[{externalId:'real',rawUsd:'100'}]} as unknown as ProviderClient)).runOne();
    expect((await db.query('SELECT basis,error FROM billing_days'))[0]).toEqual({basis:'upstream',error:null});
    expect((await db.query('SELECT raw_usd,source FROM usage_days'))[0]).toEqual({raw_usd:'100.00000000',source:'upstream_daily'});
    expect((await db.query('SELECT estimated FROM invoices')).every(i=>!i.estimated)).toBe(true);
  });

  it('recovers pre-archive counters from 23:59:58 without inventing an upstream timestamp or requiring a manual import',async()=>{
    const capturedAt=new Date(day+'T23:59:58+08:00');
    await db.transaction(tx=>ingestUsage(tx,{bindingId:binding.id,day,rawUsd:'802.581353',final:false,source:'live_snapshot'}));
    await db.query('UPDATE usage_days SET updated_at=$2 WHERE binding_id=$1',[binding.id,capturedAt]);
    await db.query('UPDATE connections SET snapshot_billing=true WHERE id=$1',[connection.id]);
    const job=await enqueue(db,box,owner.id,connection.id,'daily_billing',{day},id());
    await createWorker(db,box,()=>({login:async()=>({}),historicalDay:async()=>{throw new UpstreamError(403,'history HTTP 403');}} as unknown as ProviderClient)).runOne();
    expect((await db.query('SELECT state,result FROM jobs WHERE id=$1',[job.id]))[0]).toMatchObject({state:'succeeded',result:{basis:'snapshot',finalized:1,invoices:3}});
    const [statement]=await db.query('SELECT * FROM upstream_statements');
    expect(statement.rows).toMatchObject([{rawUsd:'802.581353',sourceAt:null,collectedAt:capturedAt.toISOString(),origin:'usage_archive'}]);
    expect((await db.query('SELECT * FROM billing_snapshots'))[0]).toMatchObject({source_at:null,origin:'usage_archive',raw_usd:'802.58135300'});
    expect((await db.query('SELECT * FROM invoices')).every(i=>i.estimated)).toBe(true);
    await snapshotDay(db,connection,day);expect(await db.query('SELECT * FROM billing_snapshots')).toHaveLength(1);
  });

  it('archives snapshot bills for unassigned accounts while preserving their amounts for later automatic settlement',async()=>{
    binding=await account('unassigned-snapshot',null,false);
    await db.transaction(tx=>ingestUsage(tx,{bindingId:binding.id,day,rawUsd:'857.442890',final:false,source:'live_snapshot'}));
    await db.query('UPDATE usage_days SET updated_at=$2 WHERE binding_id=$1',[binding.id,new Date(day+'T23:59:58+08:00')]);
    const snapshot=await snapshotDay(db,connection,day);
    const result=await recordDailyStatement(db,connection,owner,day,snapshot.rows,{basis:'snapshot'});
    expect(result).toMatchObject({state:'needs_attention',accounts:1,invoices:0});
    expect((await db.query('SELECT * FROM upstream_statements'))[0].raw_usd).toBe('857.44289000');
    expect((await db.query('SELECT source,raw_usd,state FROM usage_days'))[0]).toEqual({source:'daily_snapshot',raw_usd:'857.44289000',state:'provisional'});
    expect(await db.query('SELECT * FROM earnings')).toHaveLength(0);
    await db.query('UPDATE accounts SET owner_id=$2,ownership_verified=true WHERE id=$1',[binding.account_id,leaf.id]);
    expect(await recordDailyStatement(db,connection,owner,day,(await snapshotDay(db,connection,day)).rows,{basis:'snapshot'})).toMatchObject({state:'succeeded',invoices:3});
  });

  it('keeps a missing snapshot pending without creating a zero bill or surfacing an expected 403 as a failure',async()=>{
    await db.query('UPDATE connections SET snapshot_billing=true WHERE id=$1',[connection.id]);
    const job=await enqueue(db,box,owner.id,connection.id,'daily_billing',{day},id());
    await createWorker(db,box,()=>({login:async()=>({}),historicalDay:async()=>{throw new UpstreamError(403,'history HTTP 403');}} as unknown as ProviderClient)).runOne();
    expect((await db.query('SELECT state,error,result FROM jobs WHERE id=$1',[job.id]))[0]).toMatchObject({state:'needs_attention',error:null,result:{state:'awaiting_data'}});
    expect((await db.query('SELECT state,error,basis,source_error FROM billing_days'))[0]).toEqual({state:'awaiting_data',error:null,basis:'snapshot',source_error:'history HTTP 403'});
    expect(await db.query('SELECT * FROM upstream_statements')).toHaveLength(0);
    expect(await db.query('SELECT * FROM invoices')).toHaveLength(0);
  });

  it('does not recover a next-day observation as an old daily bill or accept invalid snapshot amounts',async()=>{
    await db.transaction(tx=>ingestUsage(tx,{bindingId:binding.id,day,rawUsd:'100',final:false,source:'live_snapshot'}));
    expect((await snapshotDay(db,connection,day)).rows).toHaveLength(0);
    for(const rawUsd of ['-1','NaN','Infinity','invalid'])expect(await saveBillingSnapshot(db,binding.id,observation(day,'23:59:00',rawUsd))).toBe(false);
    expect(await db.query('SELECT * FROM billing_snapshots')).toHaveLength(0);
  });

  it('keeps snapshots provisional if automatic estimates are disabled and never falls back from invalid historical data',async()=>{
    await saveAt('23:59:00','100');
    const snapshot=await snapshotDay(db,connection,day);
    const result=await recordDailyStatement(db,connection,owner,day,snapshot.rows,{basis:'snapshot',autoFinalize:false});
    expect(result).toMatchObject({state:'needs_attention',finalized:0,invoices:0});
    expect((await db.query('SELECT state FROM usage_days'))[0].state).toBe('provisional');
    await db.query('UPDATE connections SET snapshot_billing=true WHERE id=$1',[connection.id]);
    const job=await enqueue(db,box,owner.id,connection.id,'daily_billing',{day},id());
    const worker=createWorker(db,box,()=>({login:async()=>({}),historicalDay:async()=>{throw new UpstreamError(502,'incomplete history');}} as unknown as ProviderClient));
    await worker.runOne();expect((await db.query('SELECT state FROM jobs WHERE id=$1',[job.id]))[0].state).toBe('failed');
    expect(await db.query('SELECT * FROM invoices')).toHaveLength(0);
  });

  it('schedules Beijing days after 02:00 with durable retries and no duplicate active tasks',async()=>{
    expect(billingThrough(new Date('2026-10-19T01:59:59+08:00'))).toBe('2026-10-17');
    expect(billingThrough(new Date('2026-10-19T02:00:00+08:00'))).toBe('2026-10-18');
    await db.query('DELETE FROM billing_days');
    const now=new Date(today()+'T02:01:00+08:00');
    expect(await scheduleDailyBilling(db,box,now)).toHaveLength(1);
    expect(await scheduleDailyBilling(db,box,now)).toHaveLength(0);
    expect(await queueBillingRange(db,box,owner,[connection.id],day,day)).toHaveLength(1);
    expect(await db.query("SELECT * FROM jobs WHERE kind='daily_billing'")).toHaveLength(1);
    await expect(queueBillingRange(db,box,owner,[connection.id],shiftBillingDay(day,-31),day)).rejects.toThrow('31');
    expect(await scheduleBillingSnapshots(db,box,new Date(today()+'T23:54:00+08:00'))).toHaveLength(0);
    const at=new Date(today()+'T23:55:00+08:00');expect(await scheduleBillingSnapshots(db,box,at)).toHaveLength(1);
    expect(await scheduleBillingSnapshots(db,box,at)).toHaveLength(1);
    expect(await db.query("SELECT * FROM jobs WHERE kind='billing_snapshot'")).toHaveLength(1);
    expect(await scheduleBillingSnapshots(db,box,new Date(today()+'T00:11:00+08:00'))).toHaveLength(0);
    expect(await scheduleBillingSnapshots(db,box,new Date(today()+'T12:30:00+08:00'))).toHaveLength(1);
    expect(await scheduleBillingSnapshots(db,box,new Date(today()+'T12:31:00+08:00'))).toHaveLength(0);
  });

  it('settles the next Beijing day after the cutoff while preserving confirmed invoices and avoiding duplicate payments',async()=>{
    const previous=shiftBillingDay(day,-1);
    await db.query('UPDATE connection_rates SET effective_date=$1',[previous]);
    await db.query('UPDATE rates SET effective_date=$1',[previous]);
    await db.query('INSERT INTO billing_days(connection_id,day) VALUES($1,$2)',[connection.id,previous]);
    await recordDailyStatement(db,connection,owner,previous,[{externalId:'real',rawUsd:'50'}]);
    const paid=await db.query('SELECT * FROM invoices');
    for(const user of [owner,agent,leaf])await confirmInvoice(db,user.id===leaf.id?agent:owner,paid.find(invoice=>invoice.user_id===user.id)!.id,'previous day receipt');
    const confirmed=await db.query('SELECT * FROM invoices ORDER BY id');
    const ledger=await db.query('SELECT * FROM ledger ORDER BY id');
    await db.query('UPDATE connections SET snapshot_billing=true WHERE id=$1',[connection.id]);
    await db.query('UPDATE billing_days SET next_attempt_at=$3 WHERE connection_id=$1 AND day=$2',[connection.id,day,today()+'T00:00:00+08:00']);
    await saveAt('23:59:00','100');

    const before=new Date(today()+'T01:59:59+08:00'),after=new Date(today()+'T02:00:00+08:00');
    expect(billingSchedule(before)).toEqual({day,scheduledAt:after.toISOString(),waiting:true,through:previous,timezone:'Asia/Shanghai'});
    expect(await scheduleDailyBilling(db,box,before)).toHaveLength(0);
    expect(billingSchedule(after)).toMatchObject({day,waiting:false,through:day});
    expect(await scheduleDailyBilling(db,box,after)).toHaveLength(1);
    const factory=()=>({login:async()=>{},historicalDay:async()=>{throw new UpstreamError(403,'history HTTP 403');}} as unknown as ProviderClient);
    await createWorker(db,box,factory,['daily_billing']).tick();

    expect(await db.query("SELECT * FROM invoices WHERE state='confirmed' ORDER BY id")).toEqual(confirmed);
    const pending=await db.query("SELECT * FROM invoices WHERE state='pending' ORDER BY user_id");
    expect(pending).toHaveLength(3);
    expect(pending.map(invoice=>invoice.user_id).sort()).toEqual([owner.id,agent.id,leaf.id].sort());
    expect(pending.every(invoice=>invoice.date_from===day&&invoice.date_to===day&&invoice.estimated)).toBe(true);
    expect(await db.query('SELECT * FROM ledger ORDER BY id')).toEqual(ledger);
    await queueBillingRange(db,box,owner,[connection.id],day,day);
    await createWorker(db,box,factory,['daily_billing']).tick();
    expect(await db.query('SELECT * FROM invoices')).toHaveLength(6);
    expect(await db.query('SELECT * FROM ledger ORDER BY id')).toEqual(ledger);
  });

  it('automatically recovers an obsolete history-permission failure written by an older worker during deployment',async()=>{
    await db.query('UPDATE connections SET snapshot_billing=true WHERE id=$1',[connection.id]);
    const message='Gatelink 读取历史日账单失败（HTTP 403）；当前主账号无此权限；没有当天有效快照，无法补建历史金额';
    await db.query(`UPDATE billing_days SET state='failed',basis='snapshot',error=$1,next_attempt_at=now()+interval '2 days'`,[message]);
    expect(await scheduleDailyBilling(db,box,new Date(today()+'T23:00:00+08:00'))).toHaveLength(1);
    const [progress]=await db.query('SELECT state,error,source_error FROM billing_days');
    expect(progress).toEqual({state:'queued',error:null,source_error:message});
    await db.query("UPDATE jobs SET state='failed'");
    await db.query("UPDATE billing_days SET state='failed',error='Gatelink 登录失败（HTTP 403）',next_attempt_at=now()+interval '2 days'");
    expect(await scheduleDailyBilling(db,box,new Date(today()+'T23:00:00+08:00'))).toHaveLength(0);
    expect((await db.query('SELECT error FROM billing_days'))[0].error).toContain('登录失败');
  });

  it('allows only administrators to collect, inspect or download raw statements and exports estimated billing basis',async()=>{
    const {app}=await createApp(db,{encryptionKey:'bd'.repeat(32),appUrl:'http://localhost:3000'});
    try {
      const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{'x-ccmax-request':'1'},payload:{email:owner.email,password:'billing-test-password'}});
      const cookie=String(login.headers['set-cookie']).split(';')[0],headers={cookie,'x-ccmax-request':'1'};
      expect((await app.inject({url:'/api/finance',headers})).json().billing).toEqual(billingSchedule());
      const [session]=await db.query('SELECT * FROM sessions');
      await saveAt('23:59:00','100');const snapshot=await snapshotDay(db,connection,day);
      const result=await recordDailyStatement(db,connection,owner,day,snapshot.rows,{basis:'snapshot',sourceError:'history HTTP 403'});
      const progress=await app.inject({url:'/api/billing/days',headers});expect(progress.statusCode).toBe(200);expect(progress.json().rows[0].basis).toBe('snapshot');expect(progress.json().rows[0].connection_name).toMatch(/^平台 B/);expect(progress.body).not.toContain('Private upstream');expect(progress.body).not.toContain('403');expect(progress.body).not.toContain('source_error');
      expect((await app.inject({url:'/api/billing/statements/'+result.statementId,headers})).json().rows[0].sourceAt).toBeDefined();
      const [invoice]=await db.query('SELECT * FROM invoices WHERE user_id=$1',[owner.id]);
      const exported=await app.inject({url:'/api/invoices/'+invoice.id+'/export',headers});expect(exported.body).toContain('快照预估');
      await db.query('UPDATE sessions SET user_id=$2 WHERE id=$1',[session.id,agent.id]);
      expect((await app.inject({url:'/api/finance',headers})).json().billing).toEqual(billingSchedule());
      expect((await app.inject({url:'/api/billing/days',headers})).statusCode).toBe(403);
      expect((await app.inject({url:'/api/billing/statements/'+result.statementId,headers})).statusCode).toBe(403);
      expect((await app.inject({method:'POST',url:'/api/billing/collect',headers,payload:{connectionIds:[connection.id],from:day,to:day}})).statusCode).toBe(403);
    } finally {await app.close();}
  });
});
