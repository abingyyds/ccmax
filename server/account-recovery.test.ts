import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import { migrate, type DB } from './db.js';
import { bootstrap, id, secretBox } from './core.js';
import { openTestDB } from './test-db.js';
import { ingestUsage } from './billing.js';
import { createWorker, saveBinding } from './worker.js';
import { ProviderClient, type ProviderKey } from './providers.js';

const encryptionKey='cd'.repeat(32),box=secretBox(encryptionKey),fixedUrl='http://user:secret@recovery.proxy.example.com:8080';
describe('owned platform account recovery',()=>{
  let db:DB,app:FastifyInstance,cookie:string,owner:any,agent:any,account:any,proxyId:string;
  beforeEach(async()=>{
    db=await openTestDB();await migrate(db);await bootstrap(db,{ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:'recovery-owner-password'});
    ({app}=await createApp(db,{encryptionKey,appUrl:'http://localhost:3000'}));
    [owner]=await db.query("SELECT * FROM users WHERE role='owner'");
    const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{'x-ccmax-request':'1'},payload:{email:owner.email,password:'recovery-owner-password'}});
    cookie=String(login.headers['set-cookie']).split(';')[0];
    const created=await call('POST','/api/team',{name:'Recovery agent',email:'recovery-agent@example.com',password:'recovery-agent-password',rates:{ai008:0.3,minicc:0.3,gatelink:0.3,maxchat:0.3},effectiveFrom:'2020-01-01'});
    agent=created.json().user;
    const agentLogin=await app.inject({method:'POST',url:'/api/auth/login',headers:{'x-ccmax-request':'1'},payload:{email:agent.email,password:'recovery-agent-password'}});
    cookie=String(agentLogin.headers['set-cookie']).split(';')[0];
    [account]=await db.query("INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,'recover-claude@example.com',true) RETURNING *",[id(),agent.id]);
    proxyId=(await call('POST','/api/proxies',{name:'Recovery fixed proxy',url:fixedUrl})).json().id;
    expect((await call('POST',`/api/accounts/${account.id}/proxy`,{proxyId})).statusCode).toBe(200);
  });
  afterEach(async()=>{await app.close();await db.close();});
  function call(method:string,url:string,payload?:any):Promise<any>{return app.inject({method:method as any,url,headers:{cookie,'x-ccmax-request':'1'},payload});}
  async function platform(provider:ProviderKey) {
    const [connection]=await db.query(`INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,$2,$3,$4,0.5) RETURNING *`,[id(),provider,'private-master@example.com',box.encrypt({username:'fixture',password:'fixture'})]);
    await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date) VALUES($1,$2,0.5,'1970-01-01')",[id(),connection.id]);
    const binding=await db.transaction(tx=>saveBinding(tx,connection,{id:`original-${provider}`,email:account.email,name:'Original',status:'disabled',dailyUsd:'123.45',cost7d:'456',cost30d:'789',utilization:12}));
    return {connection,binding};
  }
  it.each(['agent','administrator'])('lets an %s recover each platform while retaining the original owner and every financial row',async actor=>{
    if(actor==='administrator') {
      const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{'x-ccmax-request':'1'},payload:{email:owner.email,password:'recovery-owner-password'}});
      cookie=String(login.headers['set-cookie']).split(';')[0];
    }
    const platforms=await Promise.all((['ai008','minicc','gatelink','maxchat'] as const).map(platform));
    for(const {binding} of platforms)await db.transaction(tx=>ingestUsage(tx,{bindingId:binding.id,day:'2021-01-01',rawUsd:'100',final:true,source:'verified-recovery-test'}));
    const history=await db.query('SELECT * FROM usage_days ORDER BY id'),earnings=await db.query('SELECT * FROM earnings ORDER BY id');
    const states=new Map(platforms.map(({connection})=>[connection.provider,id()]));
    const proxies=new Map<ProviderKey,string>(),writes:string[]=[];
    const worker=createWorker(db,box,(provider,credentials)=>new ProviderClient(provider,credentials,async(input,init={})=>{
      const path=new URL(String(input)).pathname,body=init.body?JSON.parse(String(init.body)):{};
      const externalId=`original-${provider}`;
      if(path==='/api/login')return Response.json({},{headers:{'set-cookie':'mini=fixture; Path=/; HttpOnly'}});
      if(path==='/api/me')return Response.json({authenticated:true,user:{role:'supplier'}});
      if(path.endsWith('/auth/login'))return Response.json({csrfToken:'csrf',user:{role:'agent'}});
      if(path.endsWith('/auth/admin-login'))return Response.json({accessToken:'session',user:{role:'admin'}});
      if(path.endsWith('/proxies/manage')||path.endsWith('/outbound-proxies'))return Response.json({total:1,proxies:[{id:'fixed-proxy',upstream_id:'fixed-proxy',url:fixedUrl,status:'active',at_bound_account_limit:true}]});
      if(path==='/api/meta')return Response.json({groups:[{id:'group'}],policyTemplates:[{id:'policy',is_default:true,group_ids:['group'],policy:{max_rpm:1,max_tpm:2,max_concurrent:3,max_sessions:4}}],ccTemplates:[{id:'cc',is_default:true}]});
      if(path==='/api/submissions')return Response.json({items:[{id:externalId,upstreamEmail:account.email,upstreamDailyCost:'123.45',upstreamStatus:'disabled'}],total:1,totalPages:1});
      if(init.method==='PATCH') {expect(path).toBe(`/api/admin/oauth-accounts/${externalId}`);expect(body).toEqual({outbound_proxy_id:'fixed-proxy'});proxies.set(provider,body.outbound_proxy_id);writes.push('proxy-'+provider);return Response.json({});}
      if(path.endsWith('/authorize')||path.endsWith('/auth-url')||path.endsWith('/reauthorize')) {
        if(provider==='gatelink')expect(body).toMatchObject({overwriteExisting:true,proxy:fixedUrl});
        if(provider==='minicc')expect(body).toMatchObject({overwrite_existing:true,replace_outbound_proxy:true,outbound_proxy_id:'fixed-proxy'});
        if(provider==='ai008'||provider==='maxchat'){expect(path).toBe(`/api/admin/oauth-accounts/${externalId}/reauthorize`);expect(proxies.get(provider)).toBe('fixed-proxy');}
        writes.push('start-'+provider);
        return Response.json({url:`https://auth.example/?state=${states.get(provider)}`,state:states.get(provider),authorizationUrl:`https://auth.example/?state=${states.get(provider)}`});
      }
      if(path.endsWith('/exchange')) {
        writes.push('exchange-'+provider);
        if(provider==='gatelink')return Response.json({item:{id:externalId,upstreamEmail:account.email,upstreamDailyCost:null,upstreamStatus:'active'}});
        expect(body.code).toBe(`private-code-${provider}#${states.get(provider)}`);
        if(provider==='ai008'||provider==='maxchat')expect(path).toBe(`/api/admin/oauth-accounts/${externalId}/reauthorize/exchange`);
        else expect(body).toMatchObject({overwrite_existing:true,replace_outbound_proxy:true,outbound_proxy_id:'fixed-proxy'});
        proxies.set(provider,'fixed-proxy');return Response.json(provider==='ai008'||provider==='maxchat'?{ok:true}:{id:externalId});
      }
      if(path.endsWith('/detail')||path.endsWith('/'+externalId))return Response.json({account:{email:account.email,outbound_proxy_id:proxies.get(provider),status:proxies.has(provider)?'active':'disabled'}});
      throw new Error('Unexpected recovery endpoint');
    }));
    for(const {connection,binding} of platforms){
      if(connection.provider!=='gatelink')await db.query('INSERT INTO proxy_bindings(id,proxy_id,connection_id,external_id) VALUES($1,$2,$3,$4)',[id(),proxyId,connection.id,'fixed-proxy']);
      const requestKey=id(),start=await call('POST',`/api/bindings/${binding.id}/reauthorize`,{options:{},key:requestKey});expect(start.statusCode).toBe(200);
      await worker.runOne();
      expect((await db.query('SELECT state,error FROM jobs WHERE id=$1',[start.json().id]))[0]).toMatchObject({state:'succeeded',error:null});
      expect((await call('POST',`/api/bindings/${binding.id}/reauthorize`,{options:{},key:requestKey})).json().id).toBe(start.json().id);
      expect((await call('POST',`/api/bindings/${binding.id}/reauthorize`,{options:{},key:id()})).statusCode).toBe(409);
      const [attempt]=await db.query('SELECT * FROM oauth_attempts WHERE connection_id=$1',[connection.id]);expect(box.decrypt(attempt.secret).bindingId).toBe(binding.id);
      const visible=await call('GET',`/api/accounts/${account.id}/attempts`);expect(visible.statusCode).toBe(200);expect(visible.json().attempts.some((a:any)=>a.id===attempt.id)).toBe(true);
      const exchanged=await call('POST',`/api/oauth/${attempt.id}/exchange`,{callback:`private-code-${connection.provider}#${states.get(connection.provider)}`,key:id()});expect(exchanged.statusCode).toBe(200);
      await worker.runOne();
      expect((await db.query('SELECT state,error FROM jobs WHERE id=$1',[exchanged.json().id]))[0]).toMatchObject({state:'succeeded',error:null});
      const [after]=await db.query('SELECT * FROM bindings WHERE id=$1',[binding.id]);
      expect(after).toMatchObject({account_id:account.id,external_id:binding.external_id,proxy_id:proxyId,status:'active',daily_usd:'123.45000000',cost_7d:'456.00000000',cost_30d:'789.00000000'});
    }
    expect(await db.query('SELECT * FROM usage_days ORDER BY id')).toEqual(history);
    expect(await db.query('SELECT * FROM earnings ORDER BY id')).toEqual(earnings);
    expect(await db.query('SELECT * FROM bindings')).toHaveLength(4);
    expect((await db.query('SELECT owner_id,ownership_verified FROM accounts WHERE id=$1',[account.id]))[0]).toMatchObject({owner_id:agent.id,ownership_verified:true});
    expect(await db.query("SELECT * FROM audits WHERE action='binding.reauthorized'")).toHaveLength(4);
    expect(writes.filter(write=>write.startsWith('exchange-'))).toHaveLength(4);
  });

  it('rejects foreign and unverified bindings, proxy overrides and disabled proxies before queuing recovery',async()=>{
    const {binding}=await platform('ai008');
    expect((await call('POST',`/api/bindings/${binding.id}/reauthorize`,{options:{proxy:fixedUrl},key:id()})).statusCode).toBe(400);
    const foreign=id();await db.query("INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,'foreign@example.com',true)",[foreign,owner.id]);
    const foreignBinding=id();await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)',[foreignBinding,foreign,binding.connection_id]);
    expect((await call('POST',`/api/bindings/${foreignBinding}/reauthorize`,{options:{},key:id()})).statusCode).toBe(403);
    const unverified=id();await db.query("INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,'unverified@example.com',false)",[unverified,agent.id]);
    const unverifiedBinding=id();await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)',[unverifiedBinding,unverified,binding.connection_id]);
    expect((await call('POST',`/api/bindings/${unverifiedBinding}/reauthorize`,{options:{},key:id()})).statusCode).toBe(403);
    await call('PATCH',`/api/proxies/${proxyId}`,{enabled:false});
    expect((await call('POST',`/api/bindings/${binding.id}/reauthorize`,{options:{},key:id()})).statusCode).toBe(400);
    expect(await db.query('SELECT * FROM jobs')).toHaveLength(0);
  });

  it('keeps another member’s OAuth attempts private when an administrator manages their account',async()=>{
    const {connection}=await platform('ai008'),attemptId=id();
    await db.query(`INSERT INTO oauth_attempts(id,user_id,connection_id,account_id,secret,authorization_url,expires_at)
      VALUES($1,$2,$3,$4,$5,'https://auth.example/?state=member-private',$6)`,[attemptId,agent.id,connection.id,account.id,box.encrypt({}),new Date(Date.now()+600000)]);
    expect((await call('GET',`/api/accounts/${account.id}/attempts`)).json().attempts).toHaveLength(1);
    const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{'x-ccmax-request':'1'},payload:{email:owner.email,password:'recovery-owner-password'}});
    cookie=String(login.headers['set-cookie']).split(';')[0];
    const visible=await call('GET',`/api/accounts/${account.id}/attempts`);
    expect(visible.statusCode).toBe(200);expect(visible.json().attempts).toEqual([]);
    expect((await call('POST',`/api/oauth/${attemptId}/exchange`,{callback:'private-code#member-private',key:id()})).statusCode).toBe(404);
    expect(await db.query('SELECT * FROM jobs')).toHaveLength(0);
  });

  it('blocks administrator recovery if the account owner is disabled after queuing',async()=>{
    const {binding}=await platform('ai008');
    const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{'x-ccmax-request':'1'},payload:{email:owner.email,password:'recovery-owner-password'}});
    cookie=String(login.headers['set-cookie']).split(';')[0];
    const job=await call('POST',`/api/bindings/${binding.id}/reauthorize`,{options:{},key:id()});expect(job.statusCode).toBe(200);
    await db.query('UPDATE users SET active=false WHERE id=$1',[agent.id]);
    let requests=0;
    const worker=createWorker(db,box,(provider,credentials)=>new ProviderClient(provider,credentials,async()=>{requests++;throw new Error('Unexpected upstream request');}));
    await worker.runOne();
    expect(requests).toBe(0);
    expect((await db.query('SELECT state,error FROM jobs WHERE id=$1',[job.json().id]))[0]).toMatchObject({state:'needs_attention',error:'账号所属团队已停用'});
    expect(await db.query('SELECT * FROM oauth_attempts')).toHaveLength(0);
    expect((await db.query('SELECT owner_id FROM accounts WHERE id=$1',[account.id]))[0].owner_id).toBe(agent.id);
  });

  it('does not display enabled locally if the upstream accepted a write but did not apply it',async()=>{
    const {connection,binding}=await platform('ai008');await db.query('UPDATE bindings SET proxy_id=$2 WHERE id=$1',[binding.id,proxyId]);
    // A second platform awaiting proxy checks must not block this verified one.
    const pending=await platform('gatelink');
    expect((await call('POST',`/api/bindings/${pending.binding.id}/status`,{enabled:true,key:id()})).statusCode).toBe(409);
    let changed=false;
    const worker=createWorker(db,box,(provider,credentials)=>new ProviderClient(provider,credentials,async(input,init={})=>{
      if(String(input).endsWith('/auth/admin-login'))return Response.json({user:{role:'admin'},accessToken:'fixture'});
      if(init.method==='PATCH')return Response.json({ok:true});
      return Response.json({account:{email:account.email,status:changed?'active':'disabled'}});
    }));
    const first=await call('POST',`/api/bindings/${binding.id}/status`,{enabled:true,key:id()});expect(first.statusCode).toBe(200);await worker.runOne();
    expect((await db.query('SELECT state FROM jobs WHERE id=$1',[first.json().id]))[0].state).toBe('needs_attention');
    expect((await db.query('SELECT status FROM bindings WHERE id=$1',[binding.id]))[0].status).toBe('disabled');
    changed=true;
    const retry=await call('POST',`/api/bindings/${binding.id}/status`,{enabled:true,key:id()});await worker.runOne();
    expect((await db.query('SELECT state FROM jobs WHERE id=$1',[retry.json().id]))[0].state).toBe('succeeded');
    expect((await db.query('SELECT status FROM bindings WHERE id=$1',[binding.id]))[0].status).toBe('active');
    expect((await db.query('SELECT status,proxy_id FROM bindings WHERE id=$1',[pending.binding.id]))[0]).toMatchObject({status:'disabled',proxy_id:null});
  });

  it.each(['different ID','different email','disabled proxy','disabled owner'] as const)('preserves bindings and sealed money on recovery failure: %s',async failure=>{
    const {connection,binding}=await platform('ai008');
    await db.transaction(tx=>ingestUsage(tx,{bindingId:binding.id,day:'2021-01-01',rawUsd:'100',final:true,source:'verified-recovery-test'}));
    const bindings=await db.query('SELECT * FROM bindings'),usage=await db.query('SELECT * FROM usage_days'),earnings=await db.query('SELECT * FROM earnings');
    await db.query('INSERT INTO proxy_bindings(id,proxy_id,connection_id,external_id) VALUES($1,$2,$3,$4)',[id(),proxyId,connection.id,'fixed-proxy']);
    const attemptId=id(),secret={bindingId:binding.id,proxyId,pendingState:'recovery',options:{email:account.email,proxy:fixedUrl,proxyExternalId:'fixed-proxy',existingExternalId:binding.external_id},session:{cookies:[],token:'fixture',csrf:'',user:{role:'admin'}}};
    await db.query(`INSERT INTO oauth_attempts(id,user_id,connection_id,account_id,secret,authorization_url,expires_at) VALUES($1,$2,$3,$4,$5,'https://auth.example/?state=recovery',$6)`,[attemptId,agent.id,connection.id,account.id,box.encrypt(secret),new Date(Date.now()+600000)]);
    const job=await call('POST',`/api/oauth/${attemptId}/exchange`,{callback:`failure-${failure.replaceAll(' ','-')}#recovery`,key:id()});expect(job.statusCode,job.body).toBe(200);
    if(failure==='disabled proxy')await db.query('UPDATE proxies SET enabled=false WHERE id=$1',[proxyId]);
    if(failure==='disabled owner')await db.query('UPDATE users SET active=false WHERE id=$1',[agent.id]);
    let exchanges=0,reads=0;
    const worker=createWorker(db,box,(provider,credentials)=>new ProviderClient(provider,credentials,async(input,init={})=>{
      const path=new URL(String(input)).pathname;
      if(path.endsWith('/outbound-proxies'))return Response.json({total:1,proxies:[{id:'fixed-proxy',url:fixedUrl,status:'active'}]});
      if(path.endsWith('/reauthorize/exchange')) {exchanges++;return Response.json({id:failure==='different ID'?'unexpected-account':binding.external_id});}
      if(path.endsWith('/'+binding.external_id)){reads++;return Response.json({account:{email:failure==='different email'&&reads>1?'other@example.com':account.email,outbound_proxy_id:'fixed-proxy',status:'active'}});}
      throw new Error(`Unexpected recovery request: ${init.method} ${path}`);
    }));
    await worker.runOne();
    const [result]=await db.query('SELECT * FROM jobs WHERE id=$1',[job.json().id]);expect(result.state).toBe('needs_attention');
    expect(result.error).toMatch(failure==='disabled proxy'?/专属出口代理/:failure==='disabled owner'?/已停用/:/ID.*不一致/);
    expect(exchanges).toBe(failure.startsWith('disabled')?0:1);
    expect(await db.query('SELECT * FROM bindings')).toEqual(bindings);
    expect(await db.query('SELECT * FROM usage_days')).toEqual(usage);
    expect(await db.query('SELECT * FROM earnings')).toEqual(earnings);
    expect((await db.query('SELECT state FROM oauth_attempts WHERE id=$1',[attemptId]))[0].state).toBe('needs_attention');
    expect(await db.query("SELECT id FROM audits WHERE action='binding.reauthorized'")).toHaveLength(0);
  });

  it('invalidates a Gatelink link after an upstream 409 while keeping idempotent retries and fresh recovery available',async()=>{
    const {connection,binding}=await platform('gatelink'),attemptId=id(),requestKey=id();
    const secret={bindingId:binding.id,proxyId,pendingState:'gate-recovery',options:{email:account.email,proxy:fixedUrl,existingExternalId:binding.external_id},session:{cookies:[],token:'fixture',csrf:'',user:{role:'agent'}}};
    await db.query(`INSERT INTO oauth_attempts(id,user_id,connection_id,account_id,secret,authorization_url,expires_at) VALUES($1,$2,$3,$4,$5,'https://auth.example/?state=gate-recovery',$6)`,[attemptId,agent.id,connection.id,account.id,box.encrypt(secret),new Date(Date.now()+600000)]);
    const payload={callback:'one-use-gate#gate-recovery',key:requestKey};
    const job=await call('POST',`/api/oauth/${attemptId}/exchange`,payload);expect(job.statusCode).toBe(200);
    let writes=0;
    const worker=createWorker(db,box,(provider,credentials)=>new ProviderClient(provider,credentials,async(input,init={})=>{
      const path=new URL(String(input)).pathname;
      if(path==='/api/submissions')return Response.json({items:[{id:binding.external_id,upstreamEmail:account.email,upstreamDailyCost:null}],total:1,totalPages:1});
      expect(path).toBe('/api/oauth-submissions/exchange');expect(init.method).toBe('POST');writes++;
      return Response.json({message:'private-code and proxy credentials'},{status:409});
    }));
    await worker.runOne();
    const [attempt]=await db.query('SELECT state,secret,authorization_url FROM oauth_attempts WHERE id=$1',[attemptId]);
    expect(attempt).toMatchObject({state:'needs_attention',authorization_url:''});expect(box.decrypt(attempt.secret)).toEqual({});
    const [result]=await db.query('SELECT state,error FROM jobs WHERE id=$1',[job.json().id]);
    expect(result.state).toBe('needs_attention');expect(result.error).toContain('HTTP 409');expect(result.error).not.toContain('private-code');
    const retry=await call('POST',`/api/oauth/${attemptId}/exchange`,payload);
    expect(retry.statusCode).toBe(200);expect(retry.json().id).toBe(job.json().id);
    expect((await call('POST',`/api/oauth/${attemptId}/exchange`,{...payload,key:id()})).statusCode).toBe(409);
    expect((await call('POST',`/api/bindings/${binding.id}/reauthorize`,{options:{},key:id()})).statusCode).toBe(200);
    expect(writes).toBe(1);
    expect((await db.query('SELECT account_id,external_id,status FROM bindings WHERE id=$1',[binding.id]))[0]).toMatchObject({account_id:account.id,external_id:binding.external_id,status:'disabled'});
  });

  it.each(['interrupted write','interrupted detail read'] as const)('handles Mini CC recovery with an %s without submitting the authorization code twice',async failure=>{
    const {connection,binding}=await platform('minicc');
    await db.query('INSERT INTO proxy_bindings(id,proxy_id,connection_id,external_id) VALUES($1,$2,$3,$4)',[id(),proxyId,connection.id,'fixed-proxy']);
    const attemptId=id(),secret={bindingId:binding.id,proxyId,pendingState:'mini-recovery',options:{email:account.email,proxy:fixedUrl,proxyExternalId:'fixed-proxy',existingExternalId:binding.external_id},session:{cookies:[['mini','private-session']],token:'',csrf:'',user:{role:'supplier'}}};
    await db.query(`INSERT INTO oauth_attempts(id,user_id,connection_id,account_id,secret,authorization_url,expires_at) VALUES($1,$2,$3,$4,$5,'https://auth.example/?state=mini-recovery',$6)`,[attemptId,agent.id,connection.id,account.id,box.encrypt(secret),new Date(Date.now()+600000)]);
    const job=await call('POST',`/api/oauth/${attemptId}/exchange`,{callback:'one-use-mini#mini-recovery',key:id()});expect(job.statusCode).toBe(200);
    let writes=0,readsAfterWrite=0;
    const worker=createWorker(db,box,(provider,credentials)=>new ProviderClient(provider,credentials,async input=>{
      const path=new URL(String(input)).pathname;
      if(path==='/api/proxies/manage')return Response.json({total:1,proxies:[{id:'fixed-proxy',url:fixedUrl,status:'active'}]});
      if(path==='/api/meta')return Response.json({groups:[{id:'group'}],policyTemplates:[{id:'policy',is_default:true,group_ids:['group'],policy:{max_rpm:1,max_tpm:2,max_concurrent:3,max_sessions:4}}],ccTemplates:[{id:'cc',is_default:true}]});
      if(path==='/api/accounts/exchange') {
        writes++;
        if(failure==='interrupted write')throw new TypeError('private-proxy / one-use-mini');
        return Response.json({id:binding.external_id});
      }
      expect(path).toBe(`/api/accounts/${binding.external_id}/detail`);
      if(writes&&++readsAfterWrite===1)throw new TypeError('private-detail');
      return Response.json({account:{email:account.email,outbound_proxy_id:'fixed-proxy',status:writes?'active':'disabled'}});
    }));
    await worker.runOne();
    const [stored]=await db.query('SELECT state,error,payload FROM jobs WHERE id=$1',[job.json().id]);
    expect(stored.state).toBe(failure==='interrupted write'?'needs_attention':'succeeded');
    if(failure==='interrupted write')expect(stored.error).toBe('提交 OAuth 上号；平台连接中断或网络异常；写入结果可能未知，请先核对上游结果');
    expect(box.decrypt(stored.payload)).toEqual({});
    const [attempt]=await db.query('SELECT state,secret FROM oauth_attempts WHERE id=$1',[attemptId]);
    expect(attempt.state).toBe(failure==='interrupted write'?'needs_attention':'done');expect(box.decrypt(attempt.secret)).toEqual({});
    expect(writes).toBe(1);expect(await worker.runOne()).toBe(false);
    expect((await db.query('SELECT * FROM bindings WHERE id=$1',[binding.id]))[0]).toMatchObject({account_id:account.id,external_id:binding.external_id,status:failure==='interrupted write'?'disabled':'active',daily_usd:'123.45000000',cost_7d:'456.00000000',cost_30d:'789.00000000'});
  });

  it('rejects a stale upstream identity before changing its status',async()=>{
    const {binding}=await platform('ai008');let writes=0;
    const worker=createWorker(db,box,(provider,credentials)=>new ProviderClient(provider,credentials,async(input,init={})=>{
      if(String(input).endsWith('/auth/admin-login'))return Response.json({user:{role:'admin'},accessToken:'fixture'});
      if(init.method==='PATCH'){writes++;return Response.json({ok:true});}
      return Response.json({account:{email:'different-owner@example.com',status:'active'}});
    }));
    const job=await call('POST',`/api/bindings/${binding.id}/status`,{enabled:false,key:id()});expect(job.statusCode).toBe(200);await worker.runOne();
    expect(writes).toBe(0);
    expect((await db.query('SELECT state,error FROM jobs WHERE id=$1',[job.json().id]))[0]).toMatchObject({state:'needs_attention',error:expect.stringContaining('邮箱不一致')});
  });

  it('uses the normal Platform A status action to pause and resume locally when the upstream master is not an administrator',async()=>{
    const {binding}=await platform('gatelink');
    await db.query("UPDATE bindings SET status='active',proxy_id=$2 WHERE id=$1",[binding.id,proxyId]);
    let upstreamStatusWrites=0;
    const worker=createWorker(db,box,(provider,credentials)=>new ProviderClient(provider,credentials,async(input,init={})=>{
      const path=new URL(String(input)).pathname;
      if(path==='/api/auth/login')return Response.json({csrfToken:'csrf',user:{role:'agent'}});
      if(path==='/api/submissions')return Response.json({items:[{id:binding.external_id,upstreamEmail:account.email,upstreamStatus:'active',upstreamDailyCost:'123.45'}],total:1,totalPages:1});
      if(path.endsWith('/enabled')){upstreamStatusWrites++;return Response.json({});}
      throw new Error(`Unexpected Platform A request: ${path} ${init.method}`);
    }));

    const disabled=await call('POST',`/api/bindings/${binding.id}/status`,{enabled:false,key:id()});
    expect(disabled.statusCode).toBe(200);await worker.runOne();
    expect((await db.query('SELECT status,local_enabled FROM bindings WHERE id=$1',[binding.id]))[0]).toMatchObject({status:'active',local_enabled:false});
    expect((await db.query('SELECT state,result,error FROM jobs WHERE id=$1',[disabled.json().id]))[0]).toMatchObject({state:'succeeded',result:{enabled:false,localOnly:true},error:null});
    expect((await call('GET','/api/accounts')).json().accounts[0].bindings[0].usage_enabled).toBe(false);

    const enabled=await call('POST',`/api/bindings/${binding.id}/status`,{enabled:true,key:id()});
    expect(enabled.statusCode).toBe(200);await worker.runOne();
    expect((await db.query('SELECT status,local_enabled FROM bindings WHERE id=$1',[binding.id]))[0]).toMatchObject({status:'active',local_enabled:true});
    expect((await db.query('SELECT state,result,error FROM jobs WHERE id=$1',[enabled.json().id]))[0]).toMatchObject({state:'succeeded',result:{enabled:true,localOnly:true},error:null});
    expect(upstreamStatusWrites).toBe(0);
  });

  it('keeps the normal Platform A status action upstream when the master is an administrator',async()=>{
    const {binding}=await platform('gatelink');
    await db.query("UPDATE bindings SET status='active',proxy_id=$2 WHERE id=$1",[binding.id,proxyId]);
    let remoteStatus='active',upstreamStatusWrites=0;
    const worker=createWorker(db,box,(provider,credentials)=>new ProviderClient(provider,credentials,async(input,init={})=>{
      const path=new URL(String(input)).pathname,body=init.body?JSON.parse(String(init.body)):{};
      if(path==='/api/auth/login')return Response.json({csrfToken:'csrf',user:{role:'admin'}});
      if(path==='/api/submissions')return Response.json({items:[{id:binding.external_id,upstreamEmail:account.email,upstreamStatus:remoteStatus,upstreamDailyCost:'123.45'}],total:1,totalPages:1});
      if(path.endsWith('/enabled')){upstreamStatusWrites++;remoteStatus=body.enabled?'active':'disabled';return Response.json({});}
      throw new Error(`Unexpected Platform A request: ${path} ${init.method}`);
    }));

    const disabled=await call('POST',`/api/bindings/${binding.id}/status`,{enabled:false,key:id()});
    expect(disabled.statusCode).toBe(200);await worker.runOne();
    expect((await db.query('SELECT status,local_enabled FROM bindings WHERE id=$1',[binding.id]))[0]).toMatchObject({status:'disabled',local_enabled:true});
    const [job]=await db.query('SELECT state,result,error FROM jobs WHERE id=$1',[disabled.json().id]);
    expect(job).toMatchObject({state:'succeeded',result:{enabled:false},error:null});expect(job.result).not.toHaveProperty('localOnly');
    expect(upstreamStatusWrites).toBe(1);
  });

  it('binds once, automatically synchronizes all supported legacy platforms and preserves money and ownership',async()=>{
    const platforms=await Promise.all((['ai008','minicc','gatelink'] as const).map(platform));
    for(const {binding} of platforms)await db.transaction(tx=>ingestUsage(tx,{bindingId:binding.id,day:'2021-01-01',rawUsd:'100',final:true,source:'verified-proxy-test'}));
    const history=await db.query('SELECT * FROM usage_days ORDER BY id'),earnings=await db.query('SELECT * FROM earnings ORDER BY id');
    const bound=await call('POST',`/api/accounts/${account.id}/proxy`,{proxyId});expect(bound.statusCode).toBe(200);
    expect(bound.json().jobs).toHaveLength(2);expect(bound.json().reauthorizeConnectionIds).toEqual([platforms[2].connection.id]);
    const retry=await call('POST',`/api/accounts/${account.id}/proxy/sync`,{key:id()});expect(retry.statusCode).toBe(200);
    expect(retry.json().jobs.map((job:any)=>job.id).sort()).toEqual(bound.json().jobs.map((job:any)=>job.id).sort());
    const actual=new Map<ProviderKey,string>([['ai008','fixed-proxy']]),writes:ProviderKey[]=[];
    const worker=createWorker(db,box,(provider,credentials)=>new ProviderClient(provider,credentials,async(input,init={})=>{
      expect(provider).not.toBe('gatelink');
      const path=new URL(String(input)).pathname,body=init.body?JSON.parse(String(init.body)):{};
      if(path==='/api/login')return Response.json({},{headers:{'set-cookie':'mini=fixture; Path=/; HttpOnly'}});
      if(path==='/api/me')return Response.json({authenticated:true,user:{role:'supplier'}});
      if(path.endsWith('/auth/admin-login'))return Response.json({accessToken:'fixture',user:{role:'admin'}});
      if(path.endsWith('/proxies/manage')||path.endsWith('/outbound-proxies'))return Response.json({total:1,proxies:[{id:'fixed-proxy',upstream_id:'fixed-proxy',url:fixedUrl,status:'active',at_bound_account_limit:provider==='ai008',selectable:provider!=='ai008'}]});
      if(body.outbound_proxy_id) {expect(body.outbound_proxy_id).toBe('fixed-proxy');actual.set(provider,body.outbound_proxy_id);writes.push(provider);return Response.json({});}
      if(path.endsWith('/detail')||path.endsWith('/original-ai008'))return Response.json({account:{email:account.email,outbound_proxy_id:actual.get(provider),status:'disabled'}});
      throw new Error('Unexpected automatic proxy request');
    }));
    await worker.runOne();await worker.runOne();expect(await worker.runOne()).toBe(false);
    expect(writes.sort()).toEqual(['ai008','minicc']);
    const bindings=await db.query('SELECT * FROM bindings');
    for(const binding of bindings)expect(binding).toMatchObject({proxy_id:binding.connection_id===platforms[2].connection.id?null:proxyId,status:'disabled',daily_usd:'123.45000000'});
    expect(await db.query('SELECT * FROM usage_days ORDER BY id')).toEqual(history);expect(await db.query('SELECT * FROM earnings ORDER BY id')).toEqual(earnings);
    expect((await db.query('SELECT owner_id FROM accounts WHERE id=$1',[account.id]))[0].owner_id).toBe(agent.id);
    expect(await db.query("SELECT * FROM audits WHERE action='binding.proxy.sync'")).toHaveLength(2);
    expect((await call('POST',`/api/accounts/${account.id}/proxy/sync`,{key:id()})).json().jobs).toEqual([]);
  });

  it.each([true,false])('automatically applies the account proxy before enabling and requires upstream confirmation: %s',async applied=>{
    const {binding}=await platform('ai008');let actualProxy:string|null=null,enabled=false;
    const worker=createWorker(db,box,(provider,credentials)=>new ProviderClient(provider,credentials,async(input,init={})=>{
      const path=new URL(String(input)).pathname,body=init.body?JSON.parse(String(init.body)):{};
      if(path.endsWith('/auth/admin-login'))return Response.json({accessToken:'fixture',user:{role:'admin'}});
      if(path.endsWith('/outbound-proxies'))return Response.json({total:1,proxies:[{id:'fixed-proxy',url:fixedUrl,status:'active'}]});
      if(init.method==='PATCH') {
        if(body.outbound_proxy_id&&applied)actualProxy=body.outbound_proxy_id;
        if(body.status) {expect(actualProxy).toBe('fixed-proxy');enabled=body.status==='active';}
        return Response.json({});
      }
      return Response.json({account:{email:account.email,outbound_proxy_id:actualProxy,status:enabled?'active':'disabled'}});
    }));
    const queued=await call('POST',`/api/bindings/${binding.id}/status`,{enabled:true,key:id()});expect(queued.statusCode).toBe(200);await worker.runOne();
    expect((await db.query('SELECT state FROM jobs WHERE id=$1',[queued.json().id]))[0].state).toBe(applied?'succeeded':'needs_attention');
    expect((await db.query('SELECT proxy_id,status FROM bindings WHERE id=$1',[binding.id]))[0]).toMatchObject({proxy_id:applied?proxyId:null,status:applied?'active':'disabled'});
    expect(enabled).toBe(applied);
  });
});
