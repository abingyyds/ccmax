import { it,expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { migrate } from './db.js';
import { openTestDB } from './test-db.js';
import { bootstrap,id } from './core.js';

it('reads SQL dates as exact calendar strings while preserving timestamp instants',async()=>{
 const db=await openTestDB();
 try {
  for(const timezone of ['UTC','Asia/Shanghai','America/Los_Angeles']) {
   await db.query(`SET TIME ZONE '${timezone}'`);
   const [row]=await db.query("SELECT DATE '2026-10-19' AS billing_day, TIMESTAMPTZ '2026-10-18 16:00:00+00' AS observed_at");
   expect(row.billing_day).toBe('2026-10-19');
   expect(new Date(row.observed_at).toISOString()).toBe('2026-10-18T16:00:00.000Z');
  }
 } finally {await db.close();}
});

it('upgrades legacy records without treating an email reservation as proof of ownership',async()=>{
 const db=await openTestDB();
 try {
  const schema=await readFile(new URL('./schema.sql',import.meta.url),'utf8');
  for(const statement of schema.split(/;\s*\n/).map(x=>x.trim()).filter(Boolean))await db.query(statement);
  await db.query('CREATE TABLE migrations(version integer PRIMARY KEY)');await db.query('INSERT INTO migrations VALUES(1),(2)');
  await bootstrap(db,{ADMIN_EMAIL:'migration@example.com',ADMIN_PASSWORD:'migration-password'});
  const [owner]=await db.query("SELECT * FROM users WHERE role='owner'");
  const connection=id(),claimed=id(),assigned=id(),sealed=id(),other=id();
  await db.query("INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,'other@example.com','Other','x')",[other,owner.id]);
  await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'ai008','fixture','fixture',0.5)",[connection]);
  for(const [account,email] of [[claimed,'claimed@example.com'],[assigned,'assigned@example.com'],[sealed,'sealed@example.com']]){
   await db.query('INSERT INTO accounts(id,owner_id,email) VALUES($1,$2,$3)',[account,owner.id,email]);
   const binding=id();await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$2)',[binding,account,connection]);
   if(account===sealed)await db.query("INSERT INTO usage_days(id,binding_id,day,raw_usd,state,source,root_rate) VALUES($1,$2,'2020-01-01',100,'final','legacy',0.5)",[id(),binding]);
  }
  await db.query("INSERT INTO audits(id,actor_id,action,target_id) VALUES($1,$2,'account.assign',$3)",[id(),owner.id,assigned]);
  await db.query("INSERT INTO ledger(id,user_id,kind,amount_usd,reference_id) VALUES($1,$2,'settlement',12.34567890,'legacy-reference')",[id(),owner.id]);
  await migrate(db);await migrate(db);
  const flags=await db.query('SELECT id,ownership_verified FROM accounts');
  expect(flags.find(a=>a.id===claimed)?.ownership_verified).toBe(false);
  expect(flags.find(a=>a.id===assigned)?.ownership_verified).toBe(true);
  await expect(db.query('UPDATE accounts SET owner_id=$2 WHERE id=$1',[sealed,other])).rejects.toThrow('immutable');
  await db.query('UPDATE accounts SET ownership_verified=true WHERE id=$1',[sealed]);
  expect(await db.query('SELECT * FROM migrations')).toHaveLength(26);
  expect(await db.query('SELECT * FROM invitations')).toEqual([]);
  expect(await db.query('SELECT * FROM oauth_code_claims')).toEqual([]);

  expect(await db.query('SELECT * FROM binding_telemetry')).toEqual([]);
  expect(await db.query('SELECT * FROM telemetry_samples')).toEqual([]);
  expect(await db.query('SELECT * FROM api_keys')).toEqual([]);
  expect((await db.query('SELECT proxy_id FROM accounts')).every(a=>a.proxy_id===null)).toBe(true);
  expect((await db.query('SELECT proxy_id FROM bindings')).every(b=>b.proxy_id===null)).toBe(true);
  await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'minicc','Mini CC','encrypted',0.4)",[id()]);
  await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,'minicc',0.15,'2020-01-01',$3)",[id(),other,owner.id]);
  await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'maxchat','MaxChat Gateway','encrypted',0.4)",[id()]);
  expect(await db.query("SELECT * FROM rates WHERE provider='maxchat'")).toEqual([]);
  await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,'maxchat',0.1,'2020-01-01',$3)",[id(),other,owner.id]);
  expect((await db.query('SELECT payout_rate FROM connections WHERE id=$1',[connection]))[0].payout_rate).toBe('0.5000');
  expect((await db.query('SELECT raw_usd FROM usage_days'))[0].raw_usd).toBe('100.00000000');
  expect((await db.query('SELECT amount_usd,reference_id FROM ledger'))[0]).toEqual({amount_usd:'12.34567890',reference_id:'legacy-reference'});
  await expect(db.query("INSERT INTO ledger(id,user_id,kind,amount_usd,reference_id) VALUES($1,$2,'settlement',1,'new-orphan')",[id(),owner.id])).rejects.toThrow('source mismatch');
 }finally{await db.close();}
});

it('upgrades existing provider checks so Platform E can be added after the original migration',async()=>{
 const db=await openTestDB();
 try {
  await migrate(db);await bootstrap(db,{ADMIN_EMAIL:'platform-e-migration@example.com',ADMIN_PASSWORD:'migration-password'});
  for(const table of ['connections','rates','invitation_rates']) {
   await db.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_provider_check`);
   await db.query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_provider_check CHECK(provider IN ('gatelink','ai008','minicc','maxchat'))`);
  }
  await db.query('DELETE FROM migrations WHERE version=25');
  await migrate(db);await migrate(db);
  const [owner]=await db.query("SELECT id FROM users WHERE role='owner'");
  const connection=id();
  await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'aeromax','Platform E','encrypted',0.4)",[connection]);
  await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,'aeromax',0.16,'2026-01-01',$2)",[id(),owner.id]);
  const invitation=id();
  await db.query("INSERT INTO invitations(id,inviter_id,name,token_hash,token_secret) VALUES($1,$2,'Platform E invite','platform-e-hash','platform-e-secret')",[invitation,owner.id]);
  await db.query("INSERT INTO invitation_rates(invitation_id,provider,rate) VALUES($1,'aeromax',0.16)",[invitation]);
  expect((await db.query('SELECT version FROM migrations ORDER BY version DESC LIMIT 1'))[0].version).toBe(26);
 } finally {await db.close();}
});

it('upgrades an existing version 14 deployment for MaxChat without assigning prices or changing old records',async()=>{
 const db=await openTestDB();
 try {
  await migrate(db);await bootstrap(db,{ADMIN_EMAIL:'migration@example.com',ADMIN_PASSWORD:'migration-password'});
  const [owner]=await db.query("SELECT id FROM users WHERE role='owner'");
  const cid=id();await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'ai008','private-label','encrypted',0.5)",[cid]);
  for(const table of ['connections','rates','invitation_rates']) {
   await db.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_provider_check`);
   await db.query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_provider_check CHECK(provider IN ('gatelink','ai008','minicc'))`);
  }
  await db.query('DELETE FROM migrations WHERE version=15');
  const invitation=id();
  await db.query("INSERT INTO invitations(id,inviter_id,name,token_hash,token_secret) VALUES($1,$2,'existing invite','hash','encrypted')",[invitation,owner.id]);
  await db.query("INSERT INTO invitation_rates(invitation_id,provider,rate) VALUES($1,'ai008',0.25)",[invitation]);
  const oldInvitations=await db.query('SELECT * FROM invitation_rates');
  const old=await db.query('SELECT * FROM connections');
  await migrate(db);await migrate(db);
  expect(await db.query('SELECT * FROM connections')).toEqual(old);
  expect(await db.query('SELECT * FROM invitation_rates')).toEqual(oldInvitations);
  expect(await db.query("SELECT * FROM rates WHERE provider='maxchat'")).toEqual([]);
  await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'maxchat','MaxChat Gateway','encrypted',0.6)",[id()]);
  await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,'maxchat',0.2,'2026-10-22',$2)",[id(),owner.id]);
  await db.query("INSERT INTO invitation_rates(invitation_id,provider,rate) VALUES($1,'maxchat',0)",[invitation]);
  expect(await db.query("SELECT rate FROM invitation_rates WHERE provider='maxchat'")).toEqual([{rate:'0.0000'}]);
  expect(await db.query('SELECT * FROM ledger')).toEqual([]);
  await expect(db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'unknown','Unknown','encrypted',0.5)",[id()])).rejects.toThrow();
 }finally{await db.close();}
});

it('backfills confirmed team funding exactly once when upgrading a version 20 deployment',async()=>{
 const db=await openTestDB();
 try {
  await migrate(db);await bootstrap(db,{ADMIN_EMAIL:'migration@example.com',ADMIN_PASSWORD:'migration-password'});
  const [owner]=await db.query("SELECT id FROM users WHERE role='owner'");
  const invoice=id();
  await db.query(`INSERT INTO invoices(id,number,user_id,date_from,date_to,gross_usd,downstream_usd,profit_usd,state,created_by,confirmed_by,confirmed_at)
    VALUES($1,$1,$2,'2020-01-01','2020-01-01',70,30,40,'confirmed',$2,$2,now())`,[invoice,owner.id]);
  await db.query("INSERT INTO ledger(id,user_id,kind,amount_usd,reference_id) VALUES($1,$2,'settlement',40,$3)",[id(),owner.id,invoice]);
  await db.query('DELETE FROM migrations WHERE version=ANY($1::int[])',[[21,22]]);

  await migrate(db);await migrate(db);

  expect(await db.query('SELECT user_id,kind,amount_usd,reference_id FROM team_fund_ledger')).toEqual([
   {user_id:owner.id,kind:'funding',amount_usd:'30.00000000',reference_id:invoice},
  ]);
  expect((await db.query('SELECT count(*)::int AS count FROM migrations WHERE version=21'))[0].count).toBe(1);
 }finally{await db.close();}
});
