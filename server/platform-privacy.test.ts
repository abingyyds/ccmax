import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import { migrate, type DB } from './db.js';
import { bootstrap, id, secretBox, today } from './core.js';
import { openTestDB } from './test-db.js';
import { createInvoice, ingestUsage } from './billing.js';
import { saveBinding, enqueue } from './worker.js';
import { PROVIDER_KEYS, PROVIDERS } from './providers.js';
import { decodePlatformRequest, encodePlatformResponse, publicProvider, publicPlatformName } from './platform-privacy.js';

const privateSource=/gatelink|ai008|minicc|maxchat|aeromax|accedra|e-coding|mini\s*cc|207\.57\.170\.28|private-master/gi;
const password='platform-privacy-test-password', encryptionKey='ac'.repeat(32);
const yesterday=new Date(Date.parse(today()+'T00:00:00Z')-86400000).toISOString().slice(0,10);

describe('private platform identities at the HTTP boundary',()=>{
 let db:DB,app:FastifyInstance,ownerCookie:string,agentCookie:string,agent:any,invoice:any,accountId:string;
 const connections:any[]=[];
 const request=(method:any,url:string,payload?:any,cookie=agentCookie,token?:string)=>app.inject({method,url,payload,headers:{'x-ccmax-request':'1',...(token?{authorization:`Bearer ${token}`}:{cookie})}});
 async function login(email:string){const r=await request('POST','/api/auth/login',{email,password},'');expect(r.statusCode).toBe(200);return String(r.headers['set-cookie']).split(';')[0];}
 const safe=(body:string)=>expect(body).not.toMatch(privateSource);
 beforeEach(async()=>{
  connections.length=0;db=await openTestDB();await migrate(db);await bootstrap(db,{ADMIN_EMAIL:'privacy-owner@example.com',ADMIN_PASSWORD:password});
  ({app}=await createApp(db,{encryptionKey,appUrl:'http://localhost:3000'}));ownerCookie=await login('privacy-owner@example.com');
  const result=await request('POST','/api/team',{name:'Privacy agent',email:'privacy-agent@example.com',password,rates:{A:0.2,B:0.2,C:0.2,D:0.2,E:0.2,X:0.2},effectiveFrom:'1970-01-01'},ownerCookie);
  expect(result.statusCode,result.body).toBe(200);agent=result.json().user;agentCookie=await login(agent.email);
  accountId=id();await db.query("INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,'privacy-claude@example.com',true)",[accountId,agent.id]);
  const box=secretBox(encryptionKey);
  for(const provider of PROVIDER_KEYS){
   const [c]=await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate,status) VALUES($1,$2,'private-master@example.com',$3,0.5,'connected') RETURNING *",[id(),provider,box.encrypt({username:'private-master@example.com',password:'private-master-password'})]);connections.push(c);
   await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date) VALUES($1,$2,0.5,'1970-01-01')",[id(),c.id]);
   const b=await db.transaction(tx=>saveBinding(tx,c,{id:id(),email:'privacy-claude@example.com',name:'Account',status:'active',dailyUsd:'100',cost7d:null,cost30d:null,utilization:null}));
   await db.transaction(tx=>ingestUsage(tx,{bindingId:b.id,day:yesterday,rawUsd:'100',final:true,source:'reviewed_statement'}));
   const job=await enqueue(db,box,agent.id,c.id,'set_enabled',{bindingId:b.id,enabled:false},id());
   await db.query("UPDATE jobs SET state='failed',error=$2 WHERE id=$1",[job.id,`${PROVIDERS[provider].name} 请求失败 ${PROVIDERS[provider].url}/api/private`]);
  }
  invoice=await createInvoice(db,agent,agent.id,yesterday,yesterday);
 });
 afterEach(async()=>{vi.unstubAllGlobals();await app.close();await db.close();});

 it('serves only A–E and X to session/API-key agents and anonymous invitees, including every export, without rewriting financial records',async()=>{
  const before={usage:await db.query('SELECT * FROM usage_days ORDER BY id'),earnings:await db.query('SELECT * FROM earnings ORDER BY id'),rates:await db.query('SELECT * FROM rates ORDER BY id')};
  const key=await request('POST','/api/settings/api-keys',{name:'Privacy integration',scopes:['read'],expiresInDays:30,currentPassword:password});expect(key.statusCode).toBe(200);const token=key.json().token;
  const paths=['/api/connections','/api/dashboard','/api/accounts','/api/team','/api/team/pricing','/api/jobs','/api/audits','/api/telemetry','/api/telemetry/platforms',`/api/usage?from=${yesterday}&to=${yesterday}`,`/api/usage/export?from=${yesterday}&to=${yesterday}`,`/api/invoices/${invoice.id}/export`,`/api/invoices/preview?from=${yesterday}&to=${yesterday}`];
  for(const bearer of [undefined,token])for(const path of paths){const r=await request('GET',path,undefined,agentCookie,bearer);expect(r.statusCode,path).toBe(200);safe(r.body);}
  const catalog=(await request('GET','/api/connections')).json();expect(Object.keys(catalog.providers)).toEqual(['A','B','C','D','E','X']);
  for(const c of catalog.connections){expect(c.name).toContain(publicPlatformName(c.provider));expect(c.capabilities).not.toHaveProperty('url');expect(c.capabilities).not.toHaveProperty('upstreamName');expect(c.settlement_rate).toBe('0.2000');}
  const owner=(await request('GET','/api/connections',undefined,ownerCookie)).json();expect(owner.connections[0].capabilities).toMatchObject({upstreamName:'Gatelink',url:PROVIDERS.gatelink.url});
  const invite=await request('POST','/api/team/invitations',{name:'Private offer',rates:{A:0.1,D:0},expiresInDays:30});expect(invite.statusCode).toBe(200);
  const url=new URL(invite.json().invitation.url),preview=await request('GET',`/api/invitations/${url.pathname.split('/').at(-1)}`,undefined,'');expect(preview.statusCode).toBe(200);safe(preview.body);expect(preview.json().rates).toEqual({A:'0.1000',D:'0.0000',E:'0.1600'});
  for(const path of ['/api/docs','/api/openapi.json']){const response=await request('GET',path,undefined,'');expect(response.statusCode).toBe(200);safe(response.body);}
  const csv=await request('GET',`/api/invoices/${invoice.id}/export`);for(const code of 'ABCDEX')expect(csv.body).toContain(publicPlatformName(code));
  expect(await db.query('SELECT * FROM usage_days ORDER BY id')).toEqual(before.usage);expect(await db.query('SELECT * FROM earnings ORDER BY id')).toEqual(before.earnings);expect(await db.query('SELECT * FROM rates ORDER BY id')).toEqual(before.rates);
 });

 it('hides a paused platform from agent catalogs while keeping it available to the administrator',async()=>{
  const paused=connections.find(c=>c.provider==='maxchat');
  const changed=await request('PATCH',`/api/connections/${paused.id}`,{enabled:false},ownerCookie);
  expect(changed.statusCode,changed.body).toBe(200);
  const agentCatalog=await request('GET','/api/connections');
  expect(agentCatalog.statusCode).toBe(200);
  expect(agentCatalog.json().connections.some((c:any)=>c.provider==='D')).toBe(false);
  expect(agentCatalog.json().providers).not.toHaveProperty('D');
  const ownerCatalog=await request('GET','/api/connections',undefined,ownerCookie);
  expect(ownerCatalog.json().connections.find((c:any)=>c.provider==='D')).toMatchObject({enabled:false});
  expect(ownerCatalog.json().providers).toHaveProperty('D');
  const ownerPricing=await request('GET','/api/team/pricing',undefined,ownerCookie);
  expect(ownerPricing.statusCode,ownerPricing.body).toBe(200);
  expect(ownerPricing.json().prices.some((p:any)=>p.provider==='D')).toBe(false);
  expect(ownerPricing.json().risks.some((r:any)=>r.provider==='D')).toBe(false);
  const ownerTeam=await request('GET','/api/team',undefined,ownerCookie);
  expect(ownerTeam.json().providers).not.toHaveProperty('D');
  const invite=await request('POST','/api/team/invitations',{name:'Paused platform',rates:{D:0.1}},ownerCookie);
  expect(invite.statusCode).toBe(409);
 });
 it('seeds the requested Aeromax downstream rate only when no historical quote exists',async()=>{
  await db.query("DELETE FROM rates WHERE user_id=$1 AND provider='aeromax'",[agent.id]);
  const result=await request('POST','/api/connections',{provider:'E',name:'E-coding',username:'provider@example.com',password:'provider-password',payoutRate:0.4},ownerCookie);
  expect(result.statusCode,result.body).toBe(200);
  expect(await db.query("SELECT provider,rate FROM rates WHERE user_id=$1 AND provider='aeromax'",[agent.id])).toEqual([{provider:'aeromax',rate:'0.1600'}]);
 });

 it('routes public filters, single prices, batch prices and invitations back to the original independent platform',async()=>{
  for(const code of 'ABCDEX'){const usage=await request('GET',`/api/usage?provider=${code}`);expect(usage.statusCode,usage.body).toBe(200);expect(usage.json().rows).toHaveLength(1);expect(usage.json().rows[0]).toMatchObject({provider:code,raw_usd:'100.00000000',rate:'0.2000',gross_usd:'20.00000000'});}
  const created=await request('POST','/api/team',{name:'Child',email:'privacy-leaf@example.com',password,rates:{B:0.1,D:0},effectiveFrom:'1970-01-01'});expect(created.statusCode).toBe(200);const child=created.json().user;
  const changed=await request('PUT',`/api/team/${child.id}/rates`,{provider:'D',rate:0.12});expect(changed.statusCode).toBe(200);
  const planInput={provider:'B',userIds:[child.id],mode:'fixed',value:0.15},preview=await request('POST','/api/team/rates/preview',planInput);expect(preview.statusCode).toBe(200);expect(preview.json().provider).toBe('B');
  const batch=await request('POST','/api/team/rates/batch',{...planInput,snapshot:preview.json().snapshot});expect(batch.statusCode,batch.body).toBe(200);
  const records=await db.query('SELECT provider,rate FROM rates WHERE user_id=$1 ORDER BY provider,effective_date',[child.id]);expect(records).toEqual([{provider:'aeromax',rate:'0.1600'},{provider:'ai008',rate:'0.1000'},{provider:'ai008',rate:'0.1500'},{provider:'maxchat',rate:'0.0000'},{provider:'maxchat',rate:'0.1200'}]);
  const collision=await request('POST','/api/team',{name:'Collision',email:'collision@example.com',password,rates:{B:0.1,ai008:0.2}});expect(collision.statusCode).toBe(400);safe(collision.body);
  const invalid=await request('PUT',`/api/team/${child.id}/rates`,{provider:'unknown',rate:0.2});expect(invalid.statusCode).toBe(400);safe(invalid.body);
 });

 it('anonymizes configuration labels and blocks disclosure in both old authorization URL fields',async()=>{
  const conn=connections.find(c=>c.provider==='maxchat');
  vi.stubGlobal('fetch',vi.fn(async(input:string)=>Response.json(String(input).endsWith('/admin-login')?{accessToken:'private-session',user:{role:'vendor'}}:{items:[{id:'opaque-configuration-id',name:'MaxChat private vendor group'}]})));
  const options=await request('GET',`/api/connections/${conn.id}/options`);expect(options.statusCode).toBe(200);safe(options.body);expect(options.json()).toMatchObject({requireProxy:true,groups:[{id:'opaque-configuration-id',name:'分组 1'}]});
  const url='https://claude.ai/oauth/authorize?state=opaque&redirect_uri='+encodeURIComponent(PROVIDERS.maxchat.url+'/callback');
  const box=secretBox(encryptionKey),attempt=id();await db.query('INSERT INTO oauth_attempts(id,user_id,connection_id,account_id,secret,authorization_url,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[attempt,agent.id,conn.id,accountId,box.encrypt({}),url,new Date(Date.now()+600000)]);
  const job=await enqueue(db,box,agent.id,conn.id,'oauth_start',{accountId},id());await db.query("UPDATE jobs SET state='succeeded',result=$2 WHERE id=$1",[job.id,{attemptId:attempt,authorizationUrl:url}]);
  const attempts=await request('GET',`/api/accounts/${accountId}/attempts`);safe(attempts.body);expect(attempts.json().attempts[0]).toMatchObject({authorization_url:'',error:'授权链接暂不可用，请联系管理员核对平台配置'});
  const jobs=await request('GET',`/api/jobs?id=${job.id}`);safe(jobs.body);expect(jobs.json().jobs[0]).toMatchObject({error:'授权链接暂不可用，请联系管理员核对平台配置',result:{authorizationUrl:''}});
  expect((await db.query('SELECT authorization_url FROM oauth_attempts WHERE id=$1',[attempt]))[0].authorization_url).toBe(url);
 });
});

it('does not alter opaque OAuth values, user input, dates or exact amounts while converting provider contracts',()=>{
 const callback='https://callback.example/?code=private-ai008-value&state=opaque',value={provider:'B',rates:{A:0,D:0.2},callback,refreshToken:'private-maxchat-token',name:'AI008 user label'};
 expect(decodePlatformRequest(value)).toEqual({...value,provider:'ai008',rates:{gatelink:0,maxchat:0.2}});
 expect(encodePlatformResponse({provider:'maxchat',amount:'0.00000001',callback,token:'ai008-secret',timestamp:new Date('2026-10-23T00:00:00Z')})).toEqual({provider:'D',amount:'0.00000001',callback,token:'ai008-secret',timestamp:new Date('2026-10-23T00:00:00Z')});
 expect(PROVIDER_KEYS.map(publicProvider)).toEqual(['A','B','C','D','E','X']);
});

it('calls Accedra Platform X (✨ Anti-Ban) without exposing its internal identity',()=>{
 expect(publicProvider('accedra')).toBe('X');
 expect(encodePlatformResponse({provider:'accedra',connection_name:'Accedra'})).toEqual({provider:'X',connection_name:'Platform X (✨ Anti-Ban)'});
});
