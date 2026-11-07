import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openTestDB } from './test-db.js';
import { migrate, type DB } from './db.js';
import { bootstrap, id, secretBox, today } from './core.js';
import { createApp } from './app.js';
import { createWorker, enqueue } from './worker.js';
import { ProviderClient } from './providers.js';
import type { FastifyInstance } from 'fastify';
import { scheduleBillingSnapshots } from './billing-scheduler.js';

const encryptionKey='31'.repeat(32),box=secretBox(encryptionKey),credentials={username:'provider-api',password:'acd_provider_private'};
let db:DB,app:FastifyInstance,owner:any,cookie:string;
beforeAll(async()=>{
  db=await openTestDB();await migrate(db);
  await bootstrap(db,{ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:'correct horse battery staple'});
  [owner]=await db.query("SELECT * FROM users WHERE role='owner'");
  ({app}=await createApp(db,{encryptionKey,appUrl:'http://localhost:3000'}));
  const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{'x-ccmax-request':'1'},payload:{email:owner.email,password:'correct horse battery staple'}});
  cookie=String(login.headers['set-cookie']).split(';')[0]!;
});
afterAll(async()=>{await app?.close();await db?.close();});
const api=(method:string,url:string,payload?:object)=>app.inject({method:method as any,url,headers:{cookie,'x-ccmax-request':'1'},payload});

async function fixture(){
  const connectionId=id(),accountId=id(),proxyId=id();
  await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate,snapshot_billing) VALUES($1,'accedra','X',$2,0.25,false)",[connectionId,box.encrypt(credentials)]);
  await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date,created_by) VALUES($1,$2,0.25,'1970-01-01',$3)",[id(),connectionId,owner.id]);
  await db.query("INSERT INTO proxies(id,owner_id,name,endpoint,secret,fingerprint) VALUES($1,$2,'fixed','http://proxy.example:8080',$3,$1)",[proxyId,owner.id,box.encrypt({url:'http://proxy.example:8080'})]);
  await db.query("INSERT INTO accounts(id,owner_id,email,proxy_id,created_at) VALUES($1,$2,$3,$4,'2019-01-01')",[accountId,owner.id,accountId+'@example.com',proxyId]);
  return {connectionId,accountId,proxyId,email:accountId+'@example.com'};
}

it('enforces the 0.25x contract and stores a provider key encrypted without requiring admin credentials',async()=>{
  const invalid=await api('POST','/api/connections',{provider:'X',name:'X',username:'provider-api',password:credentials.password,payoutRate:0.5});
  expect(invalid.statusCode).toBe(400);
  const valid=await api('POST','/api/connections',{provider:'X',name:'X',username:'provider-api',password:credentials.password,payoutRate:0.25});
  expect(valid.statusCode).toBe(200);
  const [connection]=await db.query('SELECT * FROM connections WHERE id=$1',[valid.json().id]);
  expect(connection.payout_rate).toBe('0.2500');expect(connection.snapshot_billing).toBe(false);
  expect(connection.credentials).not.toContain(credentials.password);
  expect(box.decrypt(connection.credentials)).toEqual(credentials);
  const catalog=await api('GET','/api/connections');
  expect(catalog.json().providers.X).toMatchObject({name:'Platform X (✨ Anti-Ban)',upstreamName:'Accedra',statusControl:false,proxyRotation:false});
  expect(catalog.body).not.toContain(credentials.password);
  expect((await api('PATCH','/api/connections/'+connection.id,{payoutRate:0.3})).statusCode).toBe(400);
});

it('preserves ownership and code-claim safeguards across multiple Accedra authorizations',async()=>{
  const f=await fixture();let readDone=false,chatDone=false;
  const remote=()=>({id:42,email:f.email,name:'Account',status:chatDone?'active':'disabled',onboarding_status:chatDone?'complete':'pending',usage_5h:null,usage_7d:null,earnings:'0'});
  const clientFactory=(provider:any,creds:any)=>new ProviderClient(provider,creds,async(url,init)=>{
    const path=new URL(String(url)).pathname;
    const reply=(data:any)=>Response.json({code:0,data});
    if(path==='/api/v1/provider/accounts'&&init?.method!=='POST')return reply([]);
    if(path==='/api/v1/provider/accounts'){
      expect(JSON.parse(String(init?.body)).idempotency_key).toBe('ccmax:'+f.connectionId+':'+f.accountId);
      return reply({account:remote(),access_key:'private-onboarding'});
    }
    if(path.endsWith('/verify'))return reply({email:f.email,status:chatDone?'complete':'pending',destinations:[]});
    if(path.endsWith('/read/start'))return reply(readDone?{completed:true}:{attempt_id:'read-step',authorization_url:'https://claude.ai/oauth/authorize?state=read-state'});
    if(path.endsWith('/read/complete')){readDone=true;return reply({completed:true});}
    if(path.endsWith('/chat/start'))return reply({authorization_url:'https://claude.ai/oauth/authorize?state=chat-state'});
    if(path.endsWith('/chat/complete')){chatDone=true;return reply({status:'complete'});}
    if(path.endsWith('/accounts/42'))return reply(remote());
    throw new Error('Unexpected '+path);
  });
  // Ignore the earlier connection-create sync job: this worker runs only OAuth.
  const worker=createWorker(db,box,clientFactory,['oauth_start','oauth_exchange']);
  await enqueue(db,box,owner.id,f.connectionId,'oauth_start',{accountId:f.accountId,proxyId:f.proxyId,options:{}},id());
  await worker.runOne();
  const [first]=await db.query("SELECT * FROM oauth_attempts WHERE account_id=$1 AND state='pending'",[f.accountId]);
  expect(first).toBeDefined();
  const submit=await api('POST','/api/oauth/'+first.id+'/exchange',{callback:'first-code#read-state',key:id()});
  expect(submit.statusCode).toBe(200);await worker.runOne();
  expect(await db.query('SELECT * FROM bindings WHERE account_id=$1',[f.accountId])).toHaveLength(0);
  expect((await db.query('SELECT ownership_verified FROM accounts WHERE id=$1',[f.accountId]))[0].ownership_verified).toBe(false);
  const [next]=await db.query("SELECT * FROM oauth_attempts WHERE account_id=$1 AND state='pending'",[f.accountId]);
  expect(next.id).not.toBe(first.id);expect(next.authorization_url).toContain('chat-state');
  expect((await api('POST','/api/oauth/'+next.id+'/exchange',{callback:'wrong#read-state',key:id()})).statusCode).toBe(400);
  const finish=await api('POST','/api/oauth/'+next.id+'/exchange',{callback:'second-code#chat-state',key:id()});
  expect(finish.statusCode).toBe(200);await worker.runOne();
  expect((await db.query('SELECT external_id,proxy_id FROM bindings WHERE account_id=$1',[f.accountId]))[0]).toMatchObject({external_id:'42',proxy_id:f.proxyId});
  expect((await db.query('SELECT ownership_verified FROM accounts WHERE id=$1',[f.accountId]))[0].ownership_verified).toBe(true);
  expect(await db.query('SELECT * FROM oauth_code_claims WHERE attempt_id=ANY($1::text[])',[[first.id,next.id]])).toHaveLength(2);
  expect((await api('POST','/api/bindings/'+(await db.query('SELECT id FROM bindings WHERE account_id=$1',[f.accountId]))[0].id+'/status',{enabled:false,key:id()})).statusCode).toBe(400);
  const binding=(await db.query('SELECT id FROM bindings WHERE account_id=$1',[f.accountId]))[0].id;
  expect((await api('POST','/api/bindings/'+binding+'/reauthorize',{options:{},key:id()})).statusCode).toBe(400);
  expect((await api('POST','/api/bindings/'+binding+'/proxy/sync',{key:id()})).statusCode).toBe(400);
  const otherProxy=id();await db.query("INSERT INTO proxies(id,owner_id,name,endpoint,secret,fingerprint) VALUES($1,$2,'other','http://other.example:8080',$3,$1)",[otherProxy,owner.id,box.encrypt({url:'http://other.example:8080'})]);
  expect((await api('POST','/api/accounts/'+f.accountId+'/proxy',{proxyId:otherProxy})).statusCode).toBe(409);
});

it('upgrades existing provider constraints idempotently without changing existing quotes',async()=>{
  const legacy=await openTestDB();
  try{
    await migrate(legacy);
    for(const table of ['connections','rates','invitation_rates']){
      await legacy.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_provider_check`);
      await legacy.query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_provider_check CHECK(provider IN ('gatelink','ai008','minicc','maxchat','aeromax'))`);
    }
    await legacy.query('DELETE FROM migrations WHERE version=30');
    await migrate(legacy);await migrate(legacy);
    await legacy.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES('new-f','accedra','X','encrypted',0.25)");
    expect((await legacy.query('SELECT version FROM migrations WHERE version=30')).length).toBe(1);
  }finally{await legacy.close();}
});

it('never schedules raw-usage snapshots for the credited-earnings platform',async()=>{
  expect(await scheduleBillingSnapshots(db,box,new Date('2020-01-01T16:00:00Z'))).toEqual([]);
});

it('settles complete sparse credit statements, including a zero-credit day, without estimates or overpaying',async()=>{
  const f=await fixture(),bindingId=id();
  await db.query('UPDATE connections SET created_at=\'2019-01-01\' WHERE id=$1',[f.connectionId]);
  await db.query('UPDATE accounts SET ownership_verified=true WHERE id=$1',[f.accountId]);
  await db.query("INSERT INTO bindings(id,account_id,connection_id,external_id,status,created_at) VALUES($1,$2,$3,'42','active','2019-01-01')",[bindingId,f.accountId,f.connectionId]);
  const clientFactory=(provider:any,creds:any)=>new ProviderClient(provider,creds,async(url)=>{
    const path=new URL(String(url)).pathname,day=new URL(String(url)).searchParams.get('date');
    if(path.endsWith('/accounts'))return Response.json({code:0,data:[]});
    return Response.json({code:0,data:{date:day,timezone:'Asia/Shanghai',basis:'credited_earnings',complete:true,accounts:day==='2020-01-01'?[{account_id:42,payout_multiplier:'0.25',credited_usd:'25.123456789012'}]:[],total_credited_usd:day==='2020-01-01'?'25.123456789012':'0'}});
  });
  const worker=createWorker(db,box,clientFactory,['daily_billing']);
  for(const day of ['2020-01-01','2020-01-02']){
    await db.query('INSERT INTO billing_days(connection_id,day) VALUES($1,$2)',[f.connectionId,day]);
    await enqueue(db,box,owner.id,f.connectionId,'daily_billing',{day},id());await worker.runOne();
    const [bill]=await db.query('SELECT state FROM billing_days WHERE connection_id=$1 AND day=$2',[f.connectionId,day]);
    expect(bill.state).toBe('succeeded');
  }
  const rows=await db.query('SELECT day,raw_usd,root_rate,state FROM usage_days WHERE binding_id=$1 ORDER BY day',[bindingId]);
  expect(rows).toEqual([{day:'2020-01-01',raw_usd:'100.49382712',root_rate:'0.2500',state:'final'},{day:'2020-01-02',raw_usd:'0.00000000',root_rate:'0.2500',state:'final'}]);
  const [statement]=await db.query('SELECT raw_usd FROM upstream_statements WHERE connection_id=$1 AND day=\'2020-01-01\'',[f.connectionId]);
  expect(statement.raw_usd).toBe('100.49382712');
});

it.each([false,true])('recovers lost completion responses through sync and billing, with prior verified ownership=%s',async(verified)=>{
  const f=await fixture();let completed=false,failNextVerify=false;
  await db.query('UPDATE accounts SET ownership_verified=$2 WHERE id=$1',[f.accountId,verified]);
  const remote=()=>({id:84,email:f.email,name:'Recovered',status:completed?'active':'disabled',onboarding_status:completed?'complete':'pending'});
  const clientFactory=(provider:any,creds:any)=>new ProviderClient(provider,creds,async(url,init)=>{
    const path=new URL(String(url)).pathname,reply=(data:any)=>Response.json({code:0,data});
    if(path.endsWith('/accounts')&&init?.method==='POST')return reply({account:remote(),access_key:'recovery-access'});
    if(path.endsWith('/accounts'))return reply(completed?[remote()]:[]);
    if(path.endsWith('/live-statement'))return reply({date:today(),timezone:'Asia/Shanghai',basis:'credited_earnings',complete:false,snapshot_complete:true,observed_at:new Date().toISOString(),accounts:[],total_credited_usd:'0'});
    if(path.endsWith('/daily-statement'))return reply({date:'2020-01-01',timezone:'Asia/Shanghai',basis:'credited_earnings',complete:true,accounts:[{account_id:84,payout_multiplier:'0.25',credited_usd:'1'}],total_credited_usd:'1'});
    if(path.endsWith('/earnings'))return reply({balance:{available_amount:'0',held_amount:'0',lifetime_earned:'0',lifetime_paid:'0',withdrawable_amount:'0'}});
    if(path.endsWith('/verify')){
      if(failNextVerify){failNextVerify=false;throw new Error('lost response after successful exchange');}
      return reply({email:f.email,status:completed?'complete':'pending',destinations:[]});
    }
    if(path.endsWith('/read/start'))return reply({completed:true});
    if(path.endsWith('/chat/start'))return reply({authorization_url:'https://claude.ai/oauth/authorize?state=recovery-state'});
    if(path.endsWith('/chat/complete')){completed=true;failNextVerify=true;return reply({status:'complete'});}
    if(path.endsWith('/accounts/84'))return reply(remote());
    throw new Error('Unexpected '+path);
  });
  const worker=createWorker(db,box,clientFactory,['oauth_start','oauth_exchange']);
  await enqueue(db,box,owner.id,f.connectionId,'oauth_start',{accountId:f.accountId,proxyId:f.proxyId,options:{}},id());await worker.runOne();
  const [attempt]=await db.query("SELECT id FROM oauth_attempts WHERE account_id=$1 AND state='pending'",[f.accountId]);
  expect((await api('POST','/api/oauth/'+attempt.id+'/exchange',{callback:id()+'#recovery-state',key:id()})).statusCode).toBe(200);
  await worker.runOne();expect(completed).toBe(true);
  await db.query("INSERT INTO billing_days(connection_id,day) VALUES($1,'2020-01-01')",[f.connectionId]);
  await enqueue(db,box,owner.id,f.connectionId,'daily_billing',{day:'2020-01-01'},id());
  await createWorker(db,box,clientFactory,['daily_billing']).runOne();
  expect(await db.query('SELECT id FROM bindings WHERE account_id=$1',[f.accountId])).toHaveLength(0);
  await db.query("UPDATE jobs SET state='succeeded' WHERE kind='sync' AND state='queued'");
  const sync=await enqueue(db,box,owner.id,f.connectionId,'sync',{},id());
  await createWorker(db,box,clientFactory,['sync']).runOne();
  expect((await db.query('SELECT state FROM jobs WHERE id=$1',[sync.id]))[0].state).toBe('succeeded');
  expect(await db.query('SELECT id FROM bindings WHERE account_id=$1',[f.accountId])).toHaveLength(0);
  const retry=await api('POST','/api/accounts/'+f.accountId+'/authorize',{targets:[{connectionId:f.connectionId,options:{}}],key:id()});
  expect(retry.statusCode).toBe(200);await worker.runOne();
  expect((await db.query('SELECT ownership_verified FROM accounts WHERE id=$1',[f.accountId]))[0].ownership_verified).toBe(true);
  expect((await db.query('SELECT external_id FROM bindings WHERE account_id=$1',[f.accountId]))[0].external_id).toBe('84');
});

it('updates provisional agent earnings and real token bills on each sync without adding withdrawable money or double counting',async()=>{
 const f=await fixture(),binding=id(),day=today();let credit='2.5',bill='10',tokens='1000',corrupt=false;
 const invited=await api('POST','/api/team',{name:'Live agent',email:'live-agent@example.com',password:'live agent test password',rates:{A:0.2,B:0.2,C:0.2,D:0.2,E:0.2,X:0.2},effectiveFrom:'1970-01-01'});
 expect(invited.statusCode,invited.body).toBe(200);const agent=invited.json().user;
 await db.query('UPDATE accounts SET owner_id=$2,ownership_verified=true WHERE id=$1',[f.accountId,agent.id]);
 await db.query("INSERT INTO bindings(id,account_id,connection_id,external_id,status,created_at) VALUES($1,$2,$3,'42','active','2019-01-01')",[binding,f.accountId,f.connectionId]);
 const clientFactory=(provider:any,creds:any)=>new ProviderClient(provider,creds,async url=>{
  const path=new URL(String(url)).pathname,reply=(data:any)=>Response.json({code:0,data});
  if(path.endsWith('/accounts'))return reply([{id:42,email:f.email,status:'active',onboarding_status:'complete',usage_5h:20,usage_7d:30}]);
  if(path.endsWith('/live-statement'))return reply({date:day,timezone:'Asia/Shanghai',basis:'credited_earnings',complete:false,snapshot_complete:true,observed_at:new Date().toISOString(),accounts:[{account_id:42,payout_multiplier:'0.25',credited_usd:credit,billed_usd:bill,requests:'2',tokens}],total_credited_usd:corrupt?'999':credit});
  if(path.endsWith('/daily-statement'))return reply({date:day,timezone:'Asia/Shanghai',basis:'credited_earnings',complete:true,accounts:[{account_id:42,payout_multiplier:'0.25',credited_usd:credit}],total_credited_usd:credit});
  if(path.endsWith('/earnings'))return reply({balance:{available_amount:credit,held_amount:'0',lifetime_earned:credit,lifetime_paid:'0',withdrawable_amount:credit}});
  throw Error('Unexpected request');
 });
 await db.query("UPDATE jobs SET state='succeeded' WHERE kind='sync' AND state='queued'");
 const worker=createWorker(db,box,clientFactory,['sync']);
 const sync=async()=>{const job=await enqueue(db,box,owner.id,f.connectionId,'sync',{},id());await worker.runOne();return (await db.query('SELECT state FROM jobs WHERE id=$1',[job.id]))[0].state;};
 expect(await sync()).toBe('succeeded');
 credit='5';bill='20';tokens='2000';expect(await sync()).toBe('succeeded');expect(await sync()).toBe('succeeded');
 const [usage]=await db.query('SELECT * FROM usage_days WHERE binding_id=$1 AND day=$2',[binding,day]);
 expect(usage).toMatchObject({state:'provisional',raw_usd:'20.00000000'});
 const earnings=await db.query('SELECT user_id,gross_usd,downstream_usd,profit_usd FROM earnings WHERE usage_id=$1',[usage.id]);
 expect(earnings.find(e=>e.user_id===owner.id)).toMatchObject({gross_usd:'5.00000000',downstream_usd:'4.00000000',profit_usd:'1.00000000'});
 expect(earnings.find(e=>e.user_id===agent.id)).toMatchObject({gross_usd:'4.00000000',profit_usd:'4.00000000'});
 const [telemetry]=await db.query('SELECT data FROM binding_telemetry WHERE binding_id=$1',[binding]);
 expect(telemetry.data.periods.today).toMatchObject({requests:2,tokens:2000,billedUsd:'20'});
 expect(await db.query('SELECT * FROM ledger WHERE user_id=$1',[agent.id])).toHaveLength(0);
 expect(await db.query('SELECT * FROM invoices WHERE user_id=$1',[agent.id])).toHaveLength(0);
 corrupt=true;expect(await sync()).toBe('failed');
 expect((await db.query('SELECT raw_usd FROM usage_days WHERE id=$1',[usage.id]))[0].raw_usd).toBe('20.00000000');corrupt=false;
 try {
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.parse(day+'T16:01:00Z'));
  await db.query('INSERT INTO billing_days(connection_id,day) VALUES($1,$2)',[f.connectionId,day]);
  await enqueue(db,box,owner.id,f.connectionId,'daily_billing',{day},id());await createWorker(db,box,clientFactory,['daily_billing']).runOne();
  expect((await db.query('SELECT state FROM usage_days WHERE id=$1',[usage.id]))[0].state).toBe('final');
  expect((await db.query('SELECT profit_usd FROM earnings WHERE usage_id=$1 AND user_id=$2',[usage.id,agent.id]))[0].profit_usd).toBe('4.00000000');
 } finally {vi.useRealTimers();}
});
