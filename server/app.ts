import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { createHash, randomBytes } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { DB, Row } from './db.js';
import { AppError, assert, audit, dayString, hashPassword, id, nextDay, requireDirect, requireOwner, secretBox, subtree, today, verifyPassword } from './core.js';
import { balance, confirmInvoice, createInvoice, csv, ingestUsage, requestWithdrawal, reviewWithdrawal, settlementFunds, withdrawalDestination } from './billing.js';
import { enqueue, enqueueAccountProxySync } from './worker.js';
import { PROVIDERS, PROVIDER_KEYS, platformCatalog, ProviderClient, type ProviderKey } from './providers.js';
import { accountProxy, parseProxy, proxyFingerprint } from './proxies.js';
import { applyBatchPricing, lockPricing, previewBatchPricing, pricingReport } from './pricing.js';
import { apiKeyService } from './api-keys.js';
import { assertWalletAccounting } from './financial-integrity.js';
import { auditFinance } from './finance-audit.js';
import { previewInvoice } from './invoice-preview.js';
import { registerTelemetry } from './telemetry-routes.js';
import { registerBilling } from './billing-routes.js';
import { billingSchedule } from './billing-scheduler.js';
import { attributionTotals,snapshotView,telemetryFilters,visibleTelemetry } from './telemetry-data.js';
import { aggregateTelemetry } from './telemetry.js';
import { authorizationState } from '../shared/oauth.js';
import { validateOAuthCallback } from './oauth-callback.js';
import { isPublicInvitation, registerInvitations } from './invitations.js';
import { registerMonetization } from './monetization.js';
import { isPublicWeeklyRecord } from './weekly-record.js';
import { decodePlatformRequest, encodePlatformResponse, publicPlatformName } from './platform-privacy.js';
import { initializeKeyMarket, registerKeyMarket } from './key-market.js';

declare module 'fastify' { interface FastifyRequest { user: Row; } }
const identifier=z.string().uuid();
const provider=z.enum(PROVIDER_KEYS);
const money=z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/,'请输入最多 8 位小数的美元金额');
const rate=z.coerce.number().min(0).max(1).multipleOf(0.0001);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v)) && new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v,'日期无效');
const email=z.email().max(200).transform(v=>v.toLowerCase());
const password=z.string().min(12,'密码至少 12 位').max(200);
const key=z.string().min(8).max(100);
const publicUser=(u:Row)=>({id:u.id,name:u.name,email:u.email,role:u.role,parent_id:u.parent_id,active:u.active,created_at:u.created_at});
// All roles receive public platform identity, including administrators and CSVs.
// Saved labels can contain master-account emails and are never display names.
const connectionName=(_user:Row,provider:ProviderKey,connectionId:string,_internalName:string)=>`${publicPlatformName(provider)} · ${connectionId.slice(0,8)}`;
const publicConnectionRows=(user:Row,rows:Row[]):Row[]=>rows.map(r=>({...r,connection_name:connectionName(user,r.provider,r.connection_id,r.connection_name)}));
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const optionSchema=z.object({accountType:z.enum(['speed','stable','team','max','pro']).optional(),policyTemplateId:z.string().max(100).optional(),groupIds:z.array(z.string().max(100)).max(30).optional(),ccTemplateId:z.string().max(100).optional()}).strict();
const batchPricingSchema=z.object({provider,userIds:z.array(identifier).min(1).max(500),mode:z.enum(['fixed','scale','cap']),value:rate.optional()}).strict().refine(d=>d.mode==='cap'||d.value!==undefined,'请填写批量调价的折扣或比例');

export async function createApp(db:DB,config:{encryptionKey:string;appUrl:string;production?:boolean;logger?:boolean}) {
  const box=secretBox(config.encryptionKey);
  const catalogFor=async(owner:boolean)=>{
    if(owner)return platformCatalog(true);
    const states=await db.query<{provider:ProviderKey;enabled:string|boolean}>(`SELECT provider,bool_or(enabled) AS enabled
      FROM connections GROUP BY provider ORDER BY provider`);
    // A provider with no configured connection remains discoverable for pricing
    // and onboarding. Once a provider has connections, pausing all of them
    // removes that provider from agent-facing catalogs.
    const enabled=new Set<ProviderKey>(PROVIDER_KEYS);
    for(const state of states)if(state.enabled!==true&&state.enabled!=='true')enabled.delete(state.provider);
    return platformCatalog(false,enabled);
  };
  const assertAgentProvider=async(user:Row,provider:ProviderKey)=>{
    if(user.role==='owner')return;
    const catalog=await catalogFor(false);
    assert(!!catalog[provider],'平台连接不存在或已停用',409);
  };
  const keys=apiKeyService(db,config.appUrl);
  const app=Fastify({logger:config.logger?{redact:['req.headers.authorization','req.headers.cookie','res.headers["set-cookie"]']}:false,trustProxy:(_address,hop)=>hop===0,bodyLimit:1024*1024});
  await app.register(cookie);
  await app.register(rateLimit,{max:240,timeWindow:'1 minute'});
  app.decorateRequest('user');
  app.decorateRequest('apiKey',null);
  const apiLimit=app.createRateLimit({max:120,timeWindow:'1 minute',keyGenerator:req=>`api-user:${req.user.id}`});
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof ZodError) return reply.code(400).send({error:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；'),code:'VALIDATION_ERROR',requestId:request.id});
    if(error instanceof AppError) return reply.code(error.statusCode).send({error:error.message,code:error.code||`HTTP_${error.statusCode}`,requestId:request.id});
    const status=(error as any).statusCode;
    if(status===429) return reply.code(429).send({error:'请求过于频繁，请稍后再试',code:'RATE_LIMITED',requestId:request.id});
    if(status===400||status===413) return reply.code(status).send({error:'请求格式错误或内容过大',code:`HTTP_${status}`,requestId:request.id});
    const code=(error as any).code;
    if(['23505','23503','23514'].includes(code)) return reply.code(409).send({error:'记录已存在、归属冲突或依赖状态发生变化，请刷新后重试',code:'CONFLICT',requestId:request.id});
    request.log.error({err:error},'Request failed');
    reply.code(500).send({error:'服务器处理失败，请联系管理员核对记录',code:'INTERNAL_ERROR',requestId:request.id});
  });
  app.addHook('onRequest',async(request,reply)=>{
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('X-Frame-Options','DENY');
    if(config.production) reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const path=request.url.split('?')[0];
    if(!path.startsWith('/api/')) return;
    reply.header('Cache-Control','no-store');
    if((path==='/api/docs'||path==='/api/openapi.json')&&['GET','HEAD'].includes(request.method)) return;
    const authorization=request.headers.authorization;
    if(!authorization&&!['GET','HEAD','OPTIONS'].includes(request.method)) {
      assert(request.headers['x-ccmax-request']==='1','请求缺少 CSRF 防护标记',403);
      if(request.headers.origin) assert(request.headers.origin===new URL(config.appUrl).origin,'请求来源不允许',403);
    }
    if(!authorization&&path==='/api/auth/login') return;
    if(!authorization&&isPublicInvitation(request.method,request.routeOptions.url)) return;
    if(!authorization&&isPublicWeeklyRecord(request.method,request.routeOptions.url)) return;
    let session:Row;
    if(authorization!==undefined) {
      const authenticated=await keys.authenticate(authorization);
      session=authenticated.user;request.apiKey=authenticated.identity;request.user=session;
      keys.authorize(authenticated.identity,request.method,request.routeOptions.url);
      const limit=await apiLimit(request);
      if(!limit.isAllowed) {
        reply.header('X-RateLimit-Limit',limit.max).header('X-RateLimit-Remaining',limit.remaining).header('X-RateLimit-Reset',limit.ttlInSeconds);
        if(limit.isExceeded) {reply.header('Retry-After',limit.ttlInSeconds);throw new AppError(429,'请求过于频繁，请稍后再试','RATE_LIMITED');}
      }
    } else {
      const sid=request.cookies.ccmax_session;
      assert(sid,'请先登录',401);
      const [user]=await db.query('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>now()',[digest(sid)]);
      assert(user?.active,'登录已过期或账号已停用',401);
      session=user;
    }
    const [disabled]=await db.query(`WITH RECURSIVE chain AS (SELECT id,parent_id,active FROM users WHERE id=$1 UNION ALL SELECT u.id,u.parent_id,u.active FROM users u JOIN chain c ON c.parent_id=u.id) SELECT id FROM chain WHERE active=false LIMIT 1`,[session.id]);
    assert(!disabled,'所属团队已停用',403);
    request.user=session;
    if(request.apiKey) await keys.used(request.apiKey);
  });
  app.addHook('preValidation',async request=>{
    request.body=decodePlatformRequest(request.body);
    // Fastify's query parser uses its own object prototype. Normalize the
    // top-level query before decoding public platform filters.
    request.query=decodePlatformRequest({...request.query as Row});
  });
  app.addHook('preSerialization',async(request,_reply,payload)=>encodePlatformResponse(payload,request.user?.role==='owner'));
  app.addHook('onResponse',async(request,reply)=>{
    if(request.apiKey&&request.user&&!['GET','HEAD','OPTIONS'].includes(request.method)) {
      try {await audit(db,request.user.id,'api.request',request.apiKey.id,{method:request.method,route:request.routeOptions.url,status:reply.statusCode,requestId:request.id});}
      catch(error) {request.log.error({err:error},'API audit failed');}
    }
  });
  keys.register(app);
  registerInvitations(app,db,box,config.appUrl);
  registerMonetization(app,db);
  registerTelemetry(app,db,connectionName);
  registerBilling(app,db,box);
  // Key supply is a separate workspace, but it shares authentication and the
  // existing wallet.  Initialize its membership projection before exposing
  // any of the workspace routes so a newly bootstrapped database is ready on
  // the first request.
  await initializeKeyMarket(db);
  registerKeyMarket(app,db,box);
  app.get('/health',async()=>{await db.query('SELECT 1');return {status:'ok',service:'ccmax'};});
  app.post('/api/auth/login',{config:{rateLimit:{max:8,timeWindow:'1 minute'}}},async(req,reply)=>{
    const data=z.object({email,password:z.string().min(1).max(200)}).parse(req.body);
    const [user]=await db.query('SELECT * FROM users WHERE email=$1',[data.email]);
    const hash=user?.password_hash??'c892c3b24dbb419f829bb1e0ad47f258:'+ '0'.repeat(128);
    const valid=await verifyPassword(data.password,hash);
    assert(user && valid && user.active,'邮箱或密码错误，或账号已停用',401);
    const session=randomBytes(32).toString('base64url');
    await db.query('INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,$3)',[digest(session),user.id,new Date(Date.now()+7*86400000)]);
    reply.setCookie('ccmax_session',session,{path:'/',httpOnly:true,sameSite:'strict',secure:!!config.production,maxAge:7*86400});
    await audit(db,user.id,'auth.login',user.id);
    return {user:publicUser(user)};
  });
  app.get('/api/auth/me',async req=>({user:publicUser(req.user),today:today()}));
  app.post('/api/auth/logout',async(req,reply)=>{await db.query('DELETE FROM sessions WHERE id=$1',[digest(req.cookies.ccmax_session!)]);reply.clearCookie('ccmax_session',{path:'/'});return {ok:true};});
  app.post('/api/auth/password',async req=>{
    const d=z.object({currentPassword:z.string().max(200),newPassword:password}).parse(req.body);
    assert(await verifyPassword(d.currentPassword,req.user.password_hash),'当前密码错误');
    const hash=await hashPassword(d.newPassword);
    await db.transaction(async tx=>{await tx.query('UPDATE users SET password_hash=$2 WHERE id=$1',[req.user.id,hash]);await tx.query('DELETE FROM sessions WHERE user_id=$1 AND id<>$2',[req.user.id,digest(req.cookies.ccmax_session!)]);await tx.query('UPDATE api_keys SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[req.user.id]);await audit(tx,req.user.id,'auth.password',req.user.id);});
    return {ok:true};
  });

  app.get('/api/team',async req=>{
    const current=today(),q=z.object({from:date.default(current.slice(0,8)+'01'),to:date.default(current)}).parse(req.query);
    assert(q.from<=q.to,'开始日期不能晚于结束日期');
    const ids=await subtree(db,req.user.id);
    const users=await db.query(`WITH RECURSIVE branches AS (
      SELECT id AS root,id FROM users WHERE id=ANY($1::text[])
      UNION ALL SELECT b.root,u.id FROM branches b JOIN users u ON u.parent_id=b.id)
      SELECT u.id,u.parent_id,u.name,u.email,u.role,u.active,u.created_at,p.name AS parent_name,
      (SELECT count(*) FROM accounts a WHERE a.owner_id=u.id AND a.ownership_verified) AS account_count,
      (SELECT count(*) FROM accounts a JOIN branches b ON b.id=a.owner_id WHERE b.root=u.id AND a.ownership_verified) AS team_account_count,
      COALESCE(m.raw_usd,0) AS raw_usd,COALESCE(m.gross_usd,0) AS gross_usd,
      COALESCE(m.downstream_usd,0) AS downstream_usd,COALESCE(m.profit_usd,0) AS profit_usd,COALESCE(m.final_profit,0) AS final_profit
      FROM users u LEFT JOIN users p ON p.id=u.parent_id LEFT JOIN (
        SELECT e.user_id,sum(d.raw_usd) AS raw_usd,sum(e.gross_usd) AS gross_usd,sum(e.downstream_usd) AS downstream_usd,
          sum(e.profit_usd) AS profit_usd,sum(CASE WHEN d.state='final' THEN e.profit_usd ELSE 0 END) AS final_profit
        FROM earnings e JOIN usage_days d ON d.id=e.usage_id WHERE d.day BETWEEN $2 AND $3 GROUP BY e.user_id
      ) m ON m.user_id=u.id WHERE u.id=ANY($1::text[]) ORDER BY u.created_at`,[ids,q.from,q.to]);
    const rates=await db.query(`SELECT DISTINCT ON(user_id,provider) user_id,provider,rate,effective_date::text AS effective_date FROM rates WHERE user_id=ANY($1::text[]) AND effective_date<=$2 ORDER BY user_id,provider,effective_date DESC`,[ids,current]);
    const upcoming=await db.query(`SELECT user_id,provider,rate,effective_date::text AS effective_date FROM rates WHERE user_id=ANY($1::text[]) AND effective_date>$2`,[ids,current]);
    // The team quote surface follows active platforms for every role. Owners
    // still see paused connections in Platform management so they can resume
    // them, while old rates and historical billing remain stored untouched.
    const catalog=await catalogFor(false),visible=new Set(Object.keys(catalog));
    return {users,rates:rates.filter(row=>visible.has(row.provider)),upcoming:upcoming.filter(row=>visible.has(row.provider)),period:q,providers:catalog};
  });
  app.get('/api/team/pricing',async req=>pricingReport(db,req.user));
  app.post('/api/team/rates/preview',async req=>{
    const input=batchPricingSchema.parse(req.body);
    await assertAgentProvider(req.user,input.provider);
    return previewBatchPricing(db,req.user,input);
  });
  app.post('/api/team/rates/batch',async req=>{
    const {snapshot,acknowledgeRisk,...input}=z.object({snapshot:z.string().regex(/^[a-f0-9]{64}$/),acknowledgeRisk:z.boolean().default(false)}).passthrough().parse(req.body);
    const parsed=batchPricingSchema.parse(input);
    await assertAgentProvider(req.user,parsed.provider);
    return applyBatchPricing(db,req.user,parsed,snapshot,acknowledgeRisk);
  });
  app.post('/api/team',async req=>{
    const d=z.object({name:z.string().trim().min(1).max(80),email,password,rates:z.partialRecord(provider,rate).refine(v=>Object.keys(v).length>0,'请至少设置一个平台价格'),effectiveFrom:date.optional()}).parse(req.body);
    for(const p of Object.keys(d.rates) as ProviderKey[])await assertAgentProvider(req.user,p);
    const hash=await hashPassword(d.password),userId=id(),effective=d.effectiveFrom??today();assert(effective<=today(),'初始价格日期不能在未来');
    return db.transaction(async tx=>{
      await lockPricing(tx);
      const [u]=await tx.query('INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING *',[userId,req.user.id,d.email,d.name,hash]);
      for(const [p,value] of Object.entries(d.rates)) {
        await tx.query('INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,$4,$5,$6)',[id(),userId,p,value,effective,req.user.id]);
      }
      await audit(tx,req.user.id,'team.create',userId,{name:d.name});return {user:publicUser(u)};
    });
  });
  app.patch('/api/team/:id',async req=>{
    const target=identifier.parse((req.params as Row).id);
    const d=z.object({active:z.boolean().optional(),newPassword:password.optional()}).refine(d=>d.active!==undefined||!!d.newPassword).parse(req.body);
    const hash=d.newPassword?await hashPassword(d.newPassword):undefined;
    await db.transaction(async tx=>{
      await requireDirect(tx,req.user,target);
      if(d.active!==undefined) await tx.query('UPDATE users SET active=$2 WHERE id=$1',[target,d.active]);
      if(hash) {await tx.query('UPDATE users SET password_hash=$2 WHERE id=$1',[target,hash]);await tx.query('DELETE FROM sessions WHERE user_id=$1',[target]);await tx.query('UPDATE api_keys SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[target]);}
      await audit(tx,req.user.id,hash?'team.password':'team.status',target,{active:d.active});
    });return {ok:true};
  });
  app.put('/api/team/:id/rates',async req=>{
    const target=identifier.parse((req.params as Row).id);
    const d=z.object({provider,rate,effectiveFrom:date.optional()}).parse(req.body);
    await assertAgentProvider(req.user,d.provider);
    return db.transaction(async tx=>{
      await lockPricing(tx);
      await requireDirect(tx,req.user,target);
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[target]);
      const [existing]=await tx.query('SELECT id FROM rates WHERE user_id=$1 AND provider=$2 LIMIT 1',[target,d.provider]);
      const effective=existing?nextDay():(d.effectiveFrom??today());
      assert(!existing||!d.effectiveFrom||d.effectiveFrom===effective,'已有价格只能从次日变更');
      assert(existing||effective<=today(),'初始价格日期不能在未来');
      await tx.query(`INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(user_id,provider,effective_date) DO UPDATE SET rate=EXCLUDED.rate,created_by=EXCLUDED.created_by,created_at=now()`,[id(),target,d.provider,d.rate,effective,req.user.id]);
      await audit(tx,req.user.id,'rate.update',target,{...d,effectiveDate:effective});return {effectiveDate:effective};
    });
  });

  app.get('/api/connections',async req=>{
    const current=today(),root=req.user.role==='owner';
    const rows=await db.query(`SELECT c.id,c.provider,c.name,c.enabled,c.status,c.last_error,c.last_sync_at,c.snapshot_billing,
      COALESCE((SELECT r.rate FROM connection_rates r WHERE r.connection_id=c.id AND r.effective_date<=$1 ORDER BY r.effective_date DESC LIMIT 1),c.payout_rate) AS payout_rate,
      (SELECT r.effective_date::text FROM connection_rates r WHERE r.connection_id=c.id AND r.effective_date<=$1 ORDER BY r.effective_date DESC LIMIT 1) AS payout_effective_date,
      (SELECT r.rate FROM connection_rates r WHERE r.connection_id=c.id AND r.effective_date>$1 ORDER BY r.effective_date LIMIT 1) AS upcoming_payout_rate,
      (SELECT r.effective_date::text FROM connection_rates r WHERE r.connection_id=c.id AND r.effective_date>$1 ORDER BY r.effective_date LIMIT 1) AS upcoming_payout_date,
      (SELECT r.rate FROM rates r WHERE r.user_id=$2 AND r.provider=c.provider AND r.effective_date<=$1 ORDER BY r.effective_date DESC LIMIT 1) AS own_rate,
      (SELECT r.effective_date::text FROM rates r WHERE r.user_id=$2 AND r.provider=c.provider AND r.effective_date<=$1 ORDER BY r.effective_date DESC LIMIT 1) AS own_effective_date,
      (SELECT r.rate FROM rates r WHERE r.user_id=$2 AND r.provider=c.provider AND r.effective_date>$1 ORDER BY r.effective_date LIMIT 1) AS own_upcoming_rate,
      (SELECT r.effective_date::text FROM rates r WHERE r.user_id=$2 AND r.provider=c.provider AND r.effective_date>$1 ORDER BY r.effective_date LIMIT 1) AS own_upcoming_date
      FROM connections c ${root?'':'WHERE c.enabled=true'} ORDER BY c.created_at`,[current,req.user.id]);
    const catalog=await catalogFor(root);
    return {connections:rows.map(({payout_rate,payout_effective_date,last_error,upcoming_payout_rate,upcoming_payout_date,own_rate,own_effective_date,own_upcoming_rate,own_upcoming_date,...c})=>({
      ...c,name:connectionName(req.user,c.provider,c.id,c.name),
      settlement_rate:root?payout_rate:own_rate,settlement_effective_date:root?payout_effective_date:own_effective_date,
      upcoming_settlement_rate:root?upcoming_payout_rate:own_upcoming_rate,upcoming_settlement_date:root?upcoming_payout_date:own_upcoming_date,
      ...(root?{payout_rate,last_error,upcoming_payout_rate,upcoming_payout_date}:{}),capabilities:catalog[c.provider],
    })),providers:catalog,today:current};
  });
  app.post('/api/connections',async req=>{
    await requireOwner(req.user);
    const d=z.object({provider,name:z.string().trim().min(1).max(80),username:z.string().min(1).max(200),password:z.string().min(1).max(500),payoutRate:rate,effectiveFrom:date.optional(),snapshotBilling:z.boolean().optional()}).parse(req.body);
    const connectionId=id(),effective=d.effectiveFrom??today();assert(effective<=today(),'初始价格日期不能在未来');
    await db.transaction(async tx=>{
      await lockPricing(tx);
      await tx.query('INSERT INTO connections(id,provider,name,credentials,payout_rate,snapshot_billing) VALUES($1,$2,$3,$4,$5,$6)',[connectionId,d.provider,d.name,box.encrypt({username:d.username,password:d.password}),d.payoutRate,d.snapshotBilling??d.provider==='gatelink']);
      await tx.query('INSERT INTO connection_rates(id,connection_id,rate,effective_date,created_by) VALUES($1,$2,$3,$4,$5)',[id(),connectionId,d.payoutRate,effective,req.user.id]);
      await audit(tx,req.user.id,'connection.create',connectionId,{provider:d.provider});
    });
    const job=await enqueue(db,box,req.user.id,connectionId,'sync',{},id());
    return {id:connectionId,job};
  });
  app.patch('/api/connections/:id',async req=>{
    await requireOwner(req.user);const target=identifier.parse((req.params as Row).id);
    const d=z.object({enabled:z.boolean().optional(),payoutRate:rate.optional(),username:z.string().max(200).optional(),password:z.string().min(1).max(500).optional(),name:z.string().trim().min(1).max(80).optional(),snapshotBilling:z.boolean().optional()}).parse(req.body);
    await db.transaction(async tx=>{
      await lockPricing(tx);
      const effective=nextDay();
      const [c]=await tx.query('SELECT * FROM connections WHERE id=$1 FOR UPDATE',[target]);assert(c,'平台连接不存在',404);
      const credentials=box.decrypt(c.credentials);
      await tx.query('UPDATE connections SET enabled=$2,credentials=$3,name=$4,snapshot_billing=$5 WHERE id=$1',[target,d.enabled??c.enabled,box.encrypt({username:d.username??credentials.username,password:d.password??credentials.password}),d.name??c.name,d.snapshotBilling??c.snapshot_billing]);
      if(d.payoutRate!==undefined) {
        await tx.query(`INSERT INTO connection_rates(id,connection_id,rate,effective_date,created_by) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(connection_id,effective_date) DO UPDATE SET rate=EXCLUDED.rate,created_by=EXCLUDED.created_by,created_at=now()`,[id(),target,d.payoutRate,effective,req.user.id]);
      }
      await audit(tx,req.user.id,'connection.update',target,{enabled:d.enabled,payoutRate:d.payoutRate,snapshotBilling:d.snapshotBilling});
    });return {ok:true};
  });
  app.get('/api/connections/:id/options',async req=>{
    const target=identifier.parse((req.params as Row).id),[c]=await db.query('SELECT * FROM connections WHERE id=$1 AND enabled=true',[target]);assert(c,'平台连接不存在或已停用',404);
    const client=new ProviderClient(c.provider,box.decrypt(c.credentials));await client.login();const options=await client.options();
    if(req.user.role==='owner')return options;
    const labels={policies:'策略',groups:'分组',templates:'模板'} as const;
    return {...options,...Object.fromEntries(Object.entries(labels).filter(([key])=>Array.isArray((options as Row)[key])).map(([key,label])=>[key,(options as Row)[key].map((item:Row,index:number)=>({...item,name:`${label} ${index+1}`}))]))};
  });
  app.post('/api/connections/sync',async req=>{
    await requireOwner(req.user);const d=z.object({connectionIds:z.array(identifier).min(1).max(20),key}).parse(req.body);
    const jobs=[];
    for(const c of [...new Set(d.connectionIds)]) {const [row]=await db.query('SELECT id FROM connections WHERE id=$1 AND enabled=true',[c]);assert(row,'连接不存在或已停用');jobs.push(await enqueue(db,box,req.user.id,c,'sync',{},d.key));}
    return {jobs};
  });
  app.post('/api/connections/:id/reconcile',async req=>{
    await requireOwner(req.user);const target=identifier.parse((req.params as Row).id),d=z.object({day:date,key}).parse(req.body);assert(d.day<today(),'只能对账已结束日期');
    const [c]=await db.query('SELECT provider FROM connections WHERE id=$1 AND enabled=true',[target]);assert(c && PROVIDERS[c.provider as ProviderKey]?.historicalUsage,'此平台不支持历史查询，请导入确认的日账单');
    return enqueue(db,box,req.user.id,target,'reconcile',{day:d.day},d.key);
  });

  app.get('/api/proxies',async req=>{
    // A proxy pool is personal even when its owner can view a larger team.
    const proxies=await db.query(`SELECT p.id,p.owner_id,p.name,p.endpoint,p.enabled,p.created_at,u.name AS owner_name,a.id AS account_id,a.email AS account_email
      FROM proxies p JOIN users u ON u.id=p.owner_id LEFT JOIN accounts a ON a.proxy_id=p.id
      WHERE p.owner_id=$1 ORDER BY p.created_at DESC`,[req.user.id]);
    const mappings=publicConnectionRows(req.user,await db.query(`SELECT m.proxy_id,m.connection_id,m.external_id,c.provider,c.name AS connection_name FROM proxy_bindings m JOIN connections c ON c.id=m.connection_id WHERE m.proxy_id=ANY($1::text[])`,[proxies.map(p=>p.id)]));
    return {proxies:proxies.map(p=>({...p,mappings:mappings.filter(m=>m.proxy_id===p.id)}))};
  });
  app.post('/api/proxies',async req=>{
    const d=z.object({name:z.string().trim().min(1).max(80),url:z.string().trim().min(1).max(2000)}).parse(req.body);
    const parsed=parseProxy(d.url),proxyId=id();
    await db.transaction(async tx=>{
      await tx.query('INSERT INTO proxies(id,owner_id,name,endpoint,secret,fingerprint) VALUES($1,$2,$3,$4,$5,$6)',[proxyId,req.user.id,d.name,parsed.endpoint,box.encrypt({url:parsed.url}),proxyFingerprint(parsed.url,config.encryptionKey)]);
      await audit(tx,req.user.id,'proxy.create',proxyId);
    });return {id:proxyId};
  });
  app.patch('/api/proxies/:id',async req=>{
    const proxyId=identifier.parse((req.params as Row).id),d=z.object({name:z.string().trim().min(1).max(80).optional(),enabled:z.boolean().optional()}).parse(req.body);
    await db.transaction(async tx=>{
      const [p]=await tx.query('SELECT * FROM proxies WHERE id=$1 FOR UPDATE',[proxyId]);assert(p?.owner_id===req.user.id,'只能管理自己添加的代理',403);
      await tx.query('UPDATE proxies SET name=$2,enabled=$3 WHERE id=$1',[proxyId,d.name??p.name,d.enabled??p.enabled]);
      await audit(tx,req.user.id,'proxy.update',proxyId,{enabled:d.enabled});
    });return {ok:true};
  });
  app.post('/api/proxies/:id/mappings',async req=>{
    await requireOwner(req.user);
    const proxyId=identifier.parse((req.params as Row).id),d=z.object({connectionId:identifier,externalId:z.string().min(1).max(200),evidence:z.string().trim().min(5).max(2000)}).parse(req.body);
    const [p]=await db.query('SELECT * FROM proxies WHERE id=$1 AND owner_id=$2',[proxyId,req.user.id]),[c]=await db.query('SELECT * FROM connections WHERE id=$1 AND enabled=true',[d.connectionId]);assert(p?.enabled && c,'代理或平台不可用');
    assert(c.provider!=='gatelink','Gatelink 直接使用账号固定代理 URL，无需配置平台映射');
    const client=new ProviderClient(c.provider,box.decrypt(c.credentials));await client.login();await client.verifyProxyMapping(box.decrypt(p.secret).url,d.externalId);
    await db.transaction(async tx=>{
      const [old]=await tx.query('SELECT * FROM proxy_bindings WHERE proxy_id=$1 AND connection_id=$2',[proxyId,c.id]);
      assert(!old||old.external_id===d.externalId,'已有平台代理映射不能直接更换，请先核对上游账号',409);
      await tx.query('INSERT INTO proxy_bindings(id,proxy_id,connection_id,external_id) VALUES($1,$2,$3,$4) ON CONFLICT(proxy_id,connection_id) DO NOTHING',[id(),proxyId,c.id,d.externalId]);
      await audit(tx,req.user.id,'proxy.mapping.confirm',proxyId,{connectionId:c.id,externalId:d.externalId,evidence:d.evidence});
    });return {ok:true};
  });
  app.get('/api/accounts',async req=>{
    const ids=await subtree(db,req.user.id),root=req.user.role==='owner';
    const accounts=await db.query(`SELECT a.*,u.name AS owner_name,p.name AS proxy_name,p.endpoint AS proxy_endpoint,p.enabled AS proxy_enabled FROM accounts a LEFT JOIN users u ON u.id=a.owner_id LEFT JOIN proxies p ON p.id=a.proxy_id
      WHERE a.owner_id=ANY($1::text[]) OR $2::boolean ORDER BY a.created_at DESC`,[ids,root]);
    const bindings=await db.query(`SELECT b.*,c.provider,c.name AS connection_name,c.enabled,t.data FROM bindings b JOIN connections c ON c.id=b.connection_id JOIN accounts a ON a.id=b.account_id
      LEFT JOIN binding_telemetry t ON t.binding_id=b.id
      WHERE (a.owner_id=ANY($1::text[]) AND a.ownership_verified) OR $2::boolean`,[ids,root]);
    const visibleBindings=publicConnectionRows(req.user,bindings.map(({data,enabled,...b})=>{
      const {telemetry,fresh}=snapshotView({...b,data,enabled});
      return {...b,usage_enabled:b.local_enabled!==false,connection_enabled:enabled,telemetry,data_fresh:fresh,snapshot_at:telemetry?.sourceAt??telemetry?.collectedAt??null,
        today_usd:fresh&&telemetry?.day===today()?telemetry.periods.today.billedUsd:null};
    }));
    const proxyJobs=await db.query(`SELECT DISTINCT ON(subject_id,connection_id) subject_id,connection_id,state,error FROM jobs
      WHERE kind='set_proxy' AND subject_id=ANY($1::text[]) ORDER BY subject_id,connection_id,created_at DESC`,[accounts.map(a=>a.id)]);
    return {accounts:accounts.map(a=>{
      const own=a.owner_id===req.user.id;
      const pending=bindings.filter(b=>b.account_id===a.id&&b.enabled&&b.provider!=='gatelink'&&b.proxy_id!==a.proxy_id);
      const jobs=proxyJobs.filter(job=>job.subject_id===a.id&&pending.some(b=>b.connection_id===job.connection_id));
      const active=jobs.find(job=>['queued','running'].includes(job.state)),failed=jobs.find(job=>['failed','needs_attention'].includes(job.state));
      return {...a,proxy_bound:!!a.proxy_id,proxy_id:own?a.proxy_id:null,proxy_name:own?a.proxy_name:null,proxy_endpoint:own?a.proxy_endpoint:null,
        proxy_sync_state:!a.proxy_id?null:active?.state??(failed?'needs_attention':pending.length?'pending':'succeeded'),proxy_sync_error:failed?.error??null,
        bindings:visibleBindings.filter(b=>b.account_id===a.id).map(b=>({...b,proxy_verified:!!a.proxy_id&&b.proxy_id===a.proxy_id,proxy_id:own?b.proxy_id:null}))};
    }),providers:await catalogFor(req.user.role==='owner'),day:today()};
  });
  app.post('/api/accounts/:id/proxy',async req=>{
    const accountId=identifier.parse((req.params as Row).id),d=z.object({proxyId:identifier}).parse(req.body);
    return db.transaction(async tx=>{
      const [a]=await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[accountId]);assert(a?.owner_id===req.user.id,'只能为自己名下账号绑定代理',403);
      const rotating=!!a.proxy_id&&a.proxy_id!==d.proxyId;
      assert(!rotating||a.ownership_verified,'账号完成归属核实后才能更换固定代理',409);
      if(rotating) {
        const [active]=await tx.query(`SELECT j.id FROM jobs j WHERE j.state IN ('queued','running') AND
          (j.subject_id=$1 OR EXISTS(SELECT 1 FROM bindings b WHERE b.account_id=$1 AND b.id=j.subject_id)) LIMIT 1`,[accountId]);
        assert(!active,'账号仍有进行中的任务，请等待任务完成后再更换代理',409);
      }
      const [p]=await tx.query('SELECT * FROM proxies WHERE id=$1 FOR UPDATE',[d.proxyId]);assert(p?.enabled && p.owner_id===req.user.id,'请选择自己添加且已启用的代理',403);
      const [occupied]=await tx.query('SELECT id FROM accounts WHERE proxy_id=$1 AND id<>$2 FOR UPDATE',[d.proxyId,accountId]);
      assert(!occupied,'该代理已绑定其他账号，请选择未占用的代理',409);
      await tx.query('UPDATE accounts SET proxy_id=$2 WHERE id=$1',[accountId,p.id]);
      if(rotating) await tx.query('UPDATE bindings SET proxy_id=NULL WHERE account_id=$1',[accountId]);
      await audit(tx,req.user.id,rotating?'account.proxy.rotate':'account.proxy.bind',accountId,{previousProxyId:a.proxy_id??null,proxyId:p.id});
      const sync=await enqueueAccountProxySync(tx,box,req.user.id,accountId,id());
      return {account:{...a,proxy_bound:true,proxy_id:p.id,proxy_name:p.name,proxy_endpoint:p.endpoint,proxy_enabled:p.enabled,proxy_sync_state:sync.jobs.length||sync.reauthorizeConnectionIds.length?'pending':'succeeded'},changed:rotating,...sync};
    });
  });
  app.post('/api/accounts/:id/proxy/sync',async req=>{
    const accountId=identifier.parse((req.params as Row).id),d=z.object({key}).parse(req.body);
    return db.transaction(async tx=>{
      const [a]=await tx.query('SELECT owner_id,ownership_verified FROM accounts WHERE id=$1 FOR UPDATE',[accountId]);
      assert(a?.ownership_verified&&(a.owner_id===req.user.id||req.user.role==='owner'),'不能修改该账号代理',403);
      return enqueueAccountProxySync(tx,box,req.user.id,accountId,d.key);
    });
  });
  app.post('/api/bindings/:id/proxy/confirm',async req=>{
    await requireOwner(req.user);const bindingId=identifier.parse((req.params as Row).id),d=z.object({evidence:z.string().trim().min(5).max(2000)}).parse(req.body);
    await db.transaction(async tx=>{
      const [b]=await tx.query('SELECT b.*,c.provider FROM bindings b JOIN connections c ON c.id=b.connection_id WHERE b.id=$1 FOR UPDATE OF b',[bindingId]);assert(b,'平台绑定不存在',404);
      const p=await accountProxy(tx,box,b.account_id);
      assert(b.provider==='gatelink','此平台请使用平台代理同步核对，不允许仅凭说明确认');
      await tx.query('UPDATE bindings SET proxy_id=$2 WHERE id=$1',[bindingId,p.id]);
      await audit(tx,req.user.id,'binding.proxy.manual_confirm',bindingId,{proxyId:p.id,evidence:d.evidence});
    });return {ok:true};
  });
  app.post('/api/bindings/:id/proxy/sync',async req=>{
    const bindingId=identifier.parse((req.params as Row).id),d=z.object({key}).parse(req.body);
    const [b]=await db.query(`SELECT b.*,a.owner_id,a.ownership_verified,c.provider FROM bindings b JOIN accounts a ON a.id=b.account_id JOIN connections c ON c.id=b.connection_id WHERE b.id=$1`,[bindingId]);
    assert(b && ((b.ownership_verified&&b.owner_id===req.user.id)||req.user.role==='owner'),'不能修改该账号代理',403);
    assert(b.provider!=='gatelink','Gatelink 需在上游修改代理，再由管理员核实');
    const p=await accountProxy(db,box,b.account_id);
    return enqueue(db,box,req.user.id,b.connection_id,'set_proxy',{bindingId,accountId:b.account_id,proxyId:p.id},d.key);
  });
  app.post('/api/accounts',async req=>{
    const d=z.object({email,label:z.string().max(100).default('')}).parse(req.body);
    return db.transaction(async tx=>{
      const [existing]=await tx.query(`SELECT *,created_at<=now()-interval '15 minutes' AS recovery_stale
        FROM accounts WHERE email=$1 FOR UPDATE`,[d.email]);
      if(existing) {
        if(existing.owner_id===req.user.id)return {account:existing};
        const [binding]=await tx.query('SELECT id FROM bindings WHERE account_id=$1 LIMIT 1',[existing.id]);
        const [attempt]=await tx.query(`SELECT id FROM oauth_attempts
          WHERE account_id=$1 AND state IN ('pending','exchanging') AND expires_at>now() LIMIT 1`,[existing.id]);
        const [job]=await tx.query(`SELECT id FROM jobs WHERE subject_id=$1 AND state IN ('queued','running') LIMIT 1`,[existing.id]);
        const recoverable=!existing.ownership_verified && existing.recovery_stale && !existing.proxy_id && !binding && !attempt && !job;
        assert(recoverable,'该账号已存在，请联系管理员核对归属',409);
        const [account]=await tx.query(`UPDATE accounts SET owner_id=$2,submitted_by=$2,label=$3
          WHERE id=$1 RETURNING *`,[existing.id,req.user.id,d.label]);
        await audit(tx,req.user.id,'account.create',account.id,{recovered:true});
        return {account};
      }
      const [account]=await tx.query('INSERT INTO accounts(id,owner_id,submitted_by,email,label) VALUES($1,$2,$2,$3,$4) RETURNING *',[id(),req.user.id,d.email,d.label]);
      await audit(tx,req.user.id,'account.create',account.id);return {account};
    });
  });
  app.delete('/api/accounts/:id',async req=>{
    const accountId=identifier.parse((req.params as Row).id);
    return db.transaction(async tx=>{
      const [account]=await tx.query('SELECT id,owner_id,email,ownership_verified FROM accounts WHERE id=$1 FOR UPDATE',[accountId]);
      assert(account,'账号不存在',404);
      assert(account.owner_id===req.user.id,'只能删除自己名下的账号',403);
      assert(!account.ownership_verified,'已核实归属的账号不能删除',409);
      const [binding]=await tx.query('SELECT id FROM bindings WHERE account_id=$1 LIMIT 1',[accountId]);
      assert(!binding,'已有平台绑定的账号不能删除',409);
      const [attempt]=await tx.query(`SELECT id FROM oauth_attempts
        WHERE account_id=$1 AND state IN ('pending','exchanging') AND expires_at>now() LIMIT 1`,[accountId]);
      assert(!attempt,'账号授权流程正在进行，请完成或等待授权失效后再删除',409);
      const [job]=await tx.query(`SELECT id FROM jobs WHERE subject_id=$1 AND state IN ('queued','running') LIMIT 1`,[accountId]);
      assert(!job,'账号仍有进行中的任务，请等待任务完成后再删除',409);
      const attempts=await tx.query('SELECT id FROM oauth_attempts WHERE account_id=$1',[accountId]);
      if(attempts.length){
        await tx.query('DELETE FROM oauth_code_claims WHERE attempt_id=ANY($1::text[])',[attempts.map(row=>row.id)]);
        await tx.query('DELETE FROM oauth_attempts WHERE account_id=$1',[accountId]);
      }
      await tx.query('DELETE FROM accounts WHERE id=$1',[accountId]);
      await audit(tx,req.user.id,'account.delete',accountId,{email:account.email});
      return {ok:true};
    });
  });
  app.post('/api/accounts/:id/assign',async req=>{
    await requireOwner(req.user);const target=identifier.parse((req.params as Row).id),d=z.object({userId:identifier}).parse(req.body);
    await db.transaction(async tx=>{
      const [a]=await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[target]);assert(a && !a.ownership_verified,'只有未核实归属账号可分配；已确认账号不可改挂团队',409);
      const [u]=await tx.query('SELECT id FROM users WHERE id=$1 AND active=true',[d.userId]);assert(u,'用户不存在或已停用');
      if(a.proxy_id) {
        const [p]=await tx.query('SELECT owner_id FROM proxies WHERE id=$1',[a.proxy_id]);
        assert(p.owner_id===req.user.id||p.owner_id===u.id,'该账号的固定代理由其他成员上传，请先核对代理和账号归属',409);
      }
      await tx.query('UPDATE accounts SET owner_id=$2,ownership_verified=true WHERE id=$1',[target,d.userId]);
      // Inventory observations can predate ownership verification. Allocate all
      // open days now, preserving their original bill and frozen root price.
      // Missing historical contracts roll back the assignment with an error.
      const pending=await tx.query(`SELECT d.* FROM usage_days d JOIN bindings b ON b.id=d.binding_id
        WHERE b.account_id=$1 AND d.state='provisional' ORDER BY d.day,b.id`,[target]);
      for(const day of pending)await ingestUsage(tx,{bindingId:day.binding_id,day:dayString(day.day),rawUsd:day.raw_usd,final:false,source:day.source,evidence:day.evidence});
      await audit(tx,req.user.id,'account.assign',target,{userId:d.userId,allocatedDays:pending.length});
    });return {ok:true};
  });
  app.post('/api/accounts/:id/authorize',async req=>{
    const accountId=identifier.parse((req.params as Row).id);
    const d=z.object({targets:z.array(z.object({connectionId:identifier,options:optionSchema})).min(1).max(10),key}).parse(req.body);
    return db.transaction(async tx=>{
      const [a]=await tx.query('SELECT * FROM accounts WHERE id=$1 AND owner_id=$2 FOR UPDATE',[accountId,req.user.id]);assert(a,'只能为自己名下的账号上号',403);
      const proxy=await accountProxy(tx,box,accountId);
      assert(new Set(d.targets.map(t=>t.connectionId)).size===d.targets.length,'不能重复选择同一平台连接');
      const jobs=[];
      for(const t of d.targets) {
        const [c]=await tx.query('SELECT id FROM connections WHERE id=$1 AND enabled=true',[t.connectionId]);assert(c,'连接不存在或已停用');
        const payload={accountId,proxyId:proxy.id,options:t.options};
        const [previous]=await tx.query(`SELECT id FROM jobs WHERE requested_by=$1 AND connection_id=$2 AND kind='oauth_start' AND idempotency_key=$3`,[req.user.id,c.id,d.key]);
        if(previous){jobs.push(await enqueue(tx,box,req.user.id,c.id,'oauth_start',payload,d.key));continue;}
        const [b]=await tx.query('SELECT id FROM bindings WHERE account_id=$1 AND connection_id=$2',[accountId,c.id]);assert(!b,'此账号已在所选平台上号，请联系管理员核实归属',409);
        const [pending]=await tx.query(`SELECT id FROM oauth_attempts WHERE account_id=$1 AND connection_id=$2 AND state IN ('pending','exchanging') AND expires_at>now()`,[accountId,c.id]);
        assert(!pending,'已有有效授权流程，请完成回调或等待过期',409);
        jobs.push(await enqueue(tx,box,req.user.id,c.id,'oauth_start',payload,d.key));
      }return {jobs};
    });
  });
  app.post('/api/bindings/:id/reauthorize',async req=>{
    const bindingId=identifier.parse((req.params as Row).id),d=z.object({options:optionSchema,key}).parse(req.body);
    return db.transaction(async tx=>{
      const [b]=await tx.query(`SELECT b.*,a.owner_id,a.ownership_verified FROM bindings b JOIN accounts a ON a.id=b.account_id
        WHERE b.id=$1 FOR UPDATE OF a`,[bindingId]);
      assert(b?.ownership_verified&&(b.owner_id===req.user.id||req.user.role==='owner'),'仅账号本人或管理员可重新授权已核实归属的平台账号',403);
      const [c]=await tx.query('SELECT id FROM connections WHERE id=$1 AND enabled=true',[b.connection_id]);assert(c,'连接不存在或已停用');
      const proxy=await accountProxy(tx,box,b.account_id);
      const [previous]=await tx.query(`SELECT id FROM jobs WHERE requested_by=$1 AND connection_id=$2 AND kind='oauth_start' AND idempotency_key=$3`,[req.user.id,c.id,d.key]);
      const payload={accountId:b.account_id,bindingId:b.id,proxyId:proxy.id,options:d.options};
      if(previous)return enqueue(tx,box,req.user.id,c.id,'oauth_start',payload,d.key);
      const [pending]=await tx.query(`SELECT id FROM oauth_attempts WHERE account_id=$1 AND connection_id=$2 AND state IN ('pending','exchanging') AND expires_at>now()`,[b.account_id,c.id]);
      assert(!pending,'已有有效授权流程，请完成回调或等待过期',409);
      const job=await enqueue(tx,box,req.user.id,c.id,'oauth_start',payload,d.key);
      await audit(tx,req.user.id,'binding.reauthorize.request',b.id,{connectionId:c.id,jobId:job.id});
      return job;
    });
  });
  app.get('/api/accounts/:id/attempts',async req=>{
    const accountId=identifier.parse((req.params as Row).id);
    const [a]=await db.query('SELECT id FROM accounts WHERE id=$1 AND (owner_id=$2 OR $3::boolean)',[accountId,req.user.id,req.user.role==='owner']);assert(a,'账号不存在',404);
    return {attempts:publicConnectionRows(req.user,await db.query(`SELECT o.id,o.connection_id,
      CASE WHEN o.state='pending' AND o.expires_at>now() THEN o.authorization_url ELSE '' END AS authorization_url,
      o.state,o.expires_at,c.provider,c.name AS connection_name
      FROM oauth_attempts o JOIN connections c ON c.id=o.connection_id WHERE o.account_id=$1 AND o.user_id=$2 ORDER BY o.created_at DESC LIMIT 30`,[accountId,req.user.id]))};
  });
  app.post('/api/oauth/:id/exchange',async req=>{
    const attemptId=identifier.parse((req.params as Row).id),d=z.object({callback:z.string().trim().min(1).max(8000),key}).parse(req.body);
    return db.transaction(async tx=>{
      const [a]=await tx.query('SELECT * FROM oauth_attempts WHERE id=$1 AND user_id=$2 FOR UPDATE',[attemptId,req.user.id]);assert(a,'授权流程不存在',404);
      const [previous]=await tx.query(`SELECT id FROM jobs WHERE requested_by=$1 AND kind='oauth_exchange' AND connection_id=$2 AND idempotency_key=$3`,[req.user.id,a.connection_id,d.key]);
      if(previous) {
        // Completed exchanges erase their secrets. The immutable account proxy
        // still reconstructs the request hash without reusing a one-time code.
        const [account]=await tx.query('SELECT proxy_id FROM accounts WHERE id=$1',[a.account_id]);
        return enqueue(tx,box,req.user.id,a.connection_id,'oauth_exchange',{accountId:a.account_id,proxyId:account.proxy_id,attemptId,callback:d.callback},d.key);
      }
      // Terminal attempts have already erased their secrets. Check their state
      // before reading the proxy snapshot so stale links get a useful conflict.
      assert(a.state!=='needs_attention' && new Date(a.expires_at)>new Date(),'此授权已失效，请先核对同步任务，再重新生成链接并使用新的回调',409);
      assert(a.state==='pending','授权已过期或已经提交，请核对任务状态',409);
      const secret=box.decrypt(a.secret);assert(secret.proxyId,'旧授权流程没有固定代理，请重新授权');
      const proxy=await accountProxy(tx,box,a.account_id,secret.proxyId);
      if(secret.bindingId) {
        const [binding]=await tx.query(`SELECT b.id FROM bindings b JOIN accounts account ON account.id=b.account_id
          WHERE b.id=$1 AND b.account_id=$2 AND b.connection_id=$3 AND (account.owner_id=$4 OR $5::boolean) AND account.ownership_verified`,[secret.bindingId,a.account_id,a.connection_id,req.user.id,req.user.role==='owner']);
        assert(binding,'重新授权的原绑定或账号归属已变化，请重新核对',409);
      }
      // Reject a wrong-platform callback before consuming the attempt or code.
      // Old Gatelink attempts stored the state only inside their authorization URL.
      const pendingState=secret.pendingState||authorizationState(a.authorization_url);
      const {code}=validateOAuthCallback(d.callback,pendingState);
      const [claim]=await tx.query(`INSERT INTO oauth_code_claims(user_id,code_hash,attempt_id) VALUES($1,$2,$3)
        ON CONFLICT DO NOTHING RETURNING attempt_id`,[req.user.id,digest(req.user.id+':'+code),a.id]);
      assert(claim,'此授权码已提交过，不能跨平台复用；请打开目标平台自己的授权链接重新授权',409);
      if(!secret.pendingState)await tx.query('UPDATE oauth_attempts SET secret=$2 WHERE id=$1',[a.id,box.encrypt({...secret,pendingState})]);
      await tx.query(`UPDATE oauth_attempts SET state='exchanging' WHERE id=$1`,[a.id]);
      return enqueue(tx,box,req.user.id,a.connection_id,'oauth_exchange',{accountId:a.account_id,proxyId:proxy.id,attemptId,callback:d.callback},d.key);
    });
  });
  app.post('/api/accounts/:id/import-token',async req=>{
    const accountId=identifier.parse((req.params as Row).id),d=z.object({connectionId:identifier,refreshToken:z.string().trim().min(10).max(10000),options:optionSchema,key}).parse(req.body);
    return db.transaction(async tx=>{
      const [a]=await tx.query('SELECT id FROM accounts WHERE id=$1 AND owner_id=$2 FOR UPDATE',[accountId,req.user.id]);assert(a,'只能为自己名下账号上号',403);
      const proxy=await accountProxy(tx,box,accountId);
      const [c]=await tx.query('SELECT * FROM connections WHERE id=$1 AND enabled=true',[d.connectionId]);assert(c && PROVIDERS[c.provider as ProviderKey]?.refreshTokenImport,'此平台不支持 RT 导入');
      const [bound]=await tx.query('SELECT id FROM bindings WHERE account_id=$1 AND connection_id=$2',[accountId,c.id]);assert(!bound,'账号已在此平台，请联系管理员核实归属',409);
      const [pending]=await tx.query(`SELECT id FROM oauth_attempts WHERE account_id=$1 AND connection_id=$2 AND state IN ('pending','exchanging') AND expires_at>now()`,[accountId,c.id]);assert(!pending,'此账号已有有效 OAuth 流程，请先完成或等待过期',409);
      return enqueue(tx,box,req.user.id,c.id,'import_rt',{accountId,proxyId:proxy.id,options:d.options,refreshToken:d.refreshToken},d.key);
    });
  });
  app.post('/api/bindings/:id/status',async req=>{
    const bindingId=identifier.parse((req.params as Row).id),d=z.object({enabled:z.boolean(),key}).parse(req.body);
    const [b]=await db.query('SELECT b.*,a.owner_id,a.ownership_verified FROM bindings b JOIN accounts a ON a.id=b.account_id WHERE b.id=$1',[bindingId]);
    assert(b && ((b.ownership_verified&&b.owner_id===req.user.id)||req.user.role==='owner'),'不能操作该账号',403);
    if(d.enabled) {
      const p=await accountProxy(db,box,b.account_id),[c]=await db.query('SELECT provider FROM connections WHERE id=$1',[b.connection_id]);
      assert(c.provider!=='gatelink'||b.proxy_id===p.id,'请重新授权此平台，系统将自动应用账号固定代理',409);
    }
    return enqueue(db,box,req.user.id,b.connection_id,'set_enabled',{bindingId,enabled:d.enabled},d.key);
  });

  app.post('/api/bindings/:id/local-status',async req=>{
    const bindingId=identifier.parse((req.params as Row).id),d=z.object({enabled:z.boolean(),key}).parse(req.body);
    return db.transaction(async tx=>{
      const [b]=await tx.query(`SELECT b.*,a.owner_id,a.ownership_verified,c.provider
        FROM bindings b JOIN accounts a ON a.id=b.account_id JOIN connections c ON c.id=b.connection_id
        WHERE b.id=$1 FOR UPDATE`,[bindingId]);
      assert(b && ((b.ownership_verified&&b.owner_id===req.user.id)||req.user.role==='owner'),'不能操作该账号',403);
      assert(b.provider==='gatelink','仅平台 A 支持在 CCMAX 内单独停用使用');
      await tx.query('UPDATE bindings SET local_enabled=$2 WHERE id=$1',[bindingId,d.enabled]);
      await audit(tx,req.user.id,'binding.local_status',bindingId,{enabled:d.enabled,provider:b.provider});
      return {bindingId,enabled:d.enabled,localOnly:true};
    });
  });

  app.get('/api/jobs',async req=>{
    const q=z.object({id:identifier.optional()}).parse(req.query);
    const jobs=publicConnectionRows(req.user,await db.query(`SELECT j.id,j.connection_id,j.requested_by,j.kind,j.state,j.result,j.error,j.created_at,j.completed_at,c.provider,c.name AS connection_name
      FROM jobs j JOIN connections c ON c.id=j.connection_id WHERE (j.requested_by=$1 OR $2::boolean) AND ($3::text IS NULL OR j.id=$3) ORDER BY j.created_at DESC LIMIT 100`,[req.user.id,req.user.role==='owner',q.id??null]));
    // OAuth URLs belong only to the submitting user, including in admin views.
    return {jobs:jobs.map(j=>j.kind==='oauth_start' && j.requested_by!==req.user.id?{...j,result:null}:j)};
  });
  async function usageRows(user:Row,query:any,exporting=false) {
    const q=z.object({from:date.optional(),to:date.optional(),provider:provider.optional(),search:z.string().max(200).default(''),page:z.coerce.number().int().min(1).max(1000000).default(1)}).parse(query);
    assert(!q.from||!q.to||q.from<=q.to,'开始日期不能晚于结束日期');
    const ids=await subtree(db,user.id);
    const params=[user.id,ids,user.role==='owner',q.from??null,q.to??null,q.provider??null,q.search];
    const source=`FROM usage_days u JOIN bindings b ON b.id=u.binding_id JOIN connections c ON c.id=b.connection_id
      JOIN accounts a ON a.id=b.account_id LEFT JOIN users o ON o.id=a.owner_id
      LEFT JOIN earnings e ON e.usage_id=u.id AND e.user_id=$1
      WHERE ((a.owner_id=ANY($2::text[]) AND a.ownership_verified) OR $3::boolean) AND ($4::date IS NULL OR u.day>=$4) AND ($5::date IS NULL OR u.day<=$5)
      AND ($6::text IS NULL OR c.provider=$6) AND ($7::text='' OR strpos(lower(a.email||' '||COALESCE(o.name,'')),lower($7))>0)`;
    const [totals]=await db.query(`SELECT count(*) AS count,COALESCE(sum(u.raw_usd),0) AS raw_usd,COALESCE(sum(e.gross_usd),0) AS gross_usd,
      COALESCE(sum(e.downstream_usd),0) AS downstream_usd,COALESCE(sum(e.profit_usd),0) AS profit_usd ${source}`,params);
    if(exporting)assert(Number(totals.count)<=100000,'导出超过 100,000 条，请缩小日期或平台范围；未导出截断账单',400);
    const rows=await db.query(`SELECT u.id,u.day,u.raw_usd,u.state,u.source,u.source_at,u.evidence,u.updated_at,b.id AS binding_id,b.connection_id,c.provider,c.name AS connection_name,
      a.email,a.owner_id,a.ownership_verified,o.name AS owner_name,e.rate,e.gross_usd,e.downstream_usd,e.profit_usd ${source}
      ORDER BY u.day DESC,a.email,u.id LIMIT $8 OFFSET $9`,[...params,exporting?100000:12,exporting?0:(q.page-1)*12]);
    return {rows:publicConnectionRows(user,rows).map(({evidence,...r})=>({...r,...(user.role==='owner'?{evidence}:{})})),totals,total:Number(totals.count),page:q.page};
  }
  app.get('/api/usage',async req=>usageRows(req.user,req.query));
  app.get('/api/usage/export',async(req,reply)=>{const {rows}=await usageRows(req.user,req.query,true);return reply.header('Content-Type','text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="ccmax-usage.csv"').send(csv(rows,[['day','日期（北京时间）'],['email','账号'],['connection_name','平台'],['raw_usd','平台账单 USD'],['rate','结算折扣'],['gross_usd','我的应收 USD'],['downstream_usd','下级应付 USD'],['profit_usd','我的利润 USD'],['state','核实状态'],['source','金额来源'],['source_at','数据截止时间']]));});
  app.post('/api/usage/import',async req=>{
    await requireOwner(req.user);
    const d=z.object({evidence:z.string().trim().min(5).max(2000),rows:z.array(z.object({bindingId:identifier,day:date,rawUsd:money})).min(1).max(1000)}).parse(req.body);
    return db.transaction(async tx=>{
      for(const row of d.rows) await ingestUsage(tx,{...row,final:true,source:'reviewed_statement',evidence:d.evidence});
      await audit(tx,req.user.id,'usage.finalize',undefined,{count:d.rows.length,evidence:d.evidence});return {count:d.rows.length};
    });
  });
  app.get('/api/dashboard',async req=>{
    const ids=await subtree(db,req.user.id);
    const [accounts]=await db.query('SELECT count(*) AS total FROM accounts WHERE owner_id=ANY($1::text[]) AND ownership_verified',[ids]);
    const [team]=await db.query('SELECT count(*) AS total FROM users WHERE id=ANY($1::text[]) AND id<>$2',[ids,req.user.id]);
    const [totals]=await db.query(`SELECT COALESCE(sum(u.raw_usd),0) AS raw_usd,COALESCE(sum(e.gross_usd),0) AS gross_usd,COALESCE(sum(e.downstream_usd),0) AS downstream_usd,COALESCE(sum(e.profit_usd),0) AS profit_usd,
      COALESCE(sum(CASE WHEN u.state='final' THEN e.profit_usd ELSE 0 END),0) AS final_profit FROM earnings e JOIN usage_days u ON u.id=e.usage_id WHERE e.user_id=$1`,[req.user.id]);
    const daily=await db.query(`SELECT u.day,sum(u.raw_usd) AS raw_usd,sum(e.gross_usd) AS gross_usd,sum(e.profit_usd) AS profit_usd
      FROM earnings e JOIN usage_days u ON u.id=e.usage_id WHERE e.user_id=$1 GROUP BY u.day ORDER BY u.day DESC LIMIT 14`,[req.user.id]);
    const snapshots=await visibleTelemetry(db,req.user,telemetryFilters.parse({}),connectionName);
    const platforms:Row[]=(await db.query('SELECT id,provider,name,status,last_sync_at FROM connections WHERE enabled=true ORDER BY created_at')).map(c=>{
      const group=snapshots.filter(r=>r.connection_id===c.id),metrics=aggregateTelemetry(group,'today'),week=aggregateTelemetry(group,'7d');
      return {...c,account_count:group.length,daily_usd:metrics.billedUsd.value,daily_covered:metrics.billedUsd.covered,
        seven_day_usd:week.billedUsd.value,seven_day_covered:week.billedUsd.covered,attribution:attributionTotals(group)};
    });
    const [pending]=await db.query(`SELECT count(*) AS total FROM withdrawals WHERE payer_id=$1 AND state='pending'`,[req.user.id]);
    const [unassigned]=req.user.role==='owner'?await db.query('SELECT count(*) AS total FROM accounts WHERE ownership_verified=false'):[{total:0}];
    return {totals,accounts:Number(accounts.total),team:Number(team.total),balance:await balance(db,req.user.id),daily:daily.reverse(),platforms:platforms.map(c=>({...c,name:connectionName(req.user,c.provider,c.id,c.name)})),providers:await catalogFor(req.user.role==='owner'),pendingWithdrawals:Number(pending.total),unassigned:Number(unassigned.total)};
  });
  app.get('/api/finance',async req=>{
    const q=z.object({tab:z.enum(['all','mine','children']).default('all'),source:z.enum(['all','account','key']).default('all'),page:z.coerce.number().int().min(1).max(1000000).default(1)}).parse(req.query);
    const filter=(alias:string)=>`(${alias}.user_id=$1 OR ${alias}.payer_id=$1) AND ($2::text='all' OR ($2='mine' AND ${alias}.user_id=$1) OR ($2='children' AND ${alias}.payer_id=$1))`;
    const params=[req.user.id,q.tab],offset=(q.page-1)*12;
    const accountSource=q.source!=='key';
    const [ic]=accountSource?await db.query(`SELECT count(*) AS count FROM invoices i WHERE ${filter('i')}`,params):[{count:0}];
    const [wc]=accountSource?await db.query(`SELECT count(*) AS count FROM withdrawals w WHERE ${filter('w')}`,params):[{count:0}];
    const [pending]=accountSource?await db.query(`SELECT COALESCE(sum(profit_usd),0) AS amount FROM invoices WHERE user_id=$1 AND state='pending'`,[req.user.id]):[{amount:0}];
    const invoices=accountSource?await db.query(`SELECT i.*,u.name AS user_name,p.name AS payer_name FROM invoices i JOIN users u ON u.id=i.user_id LEFT JOIN users p ON p.id=i.payer_id
      WHERE ${filter('i')} ORDER BY i.created_at DESC,i.id LIMIT 12 OFFSET $3`,[...params,offset]):[];
    const withdrawals=accountSource?await db.query(`SELECT w.*,u.name AS user_name FROM withdrawals w JOIN users u ON u.id=w.user_id
      WHERE ${filter('w')} ORDER BY w.created_at DESC,w.id LIMIT 12 OFFSET $3`,[...params,offset]):[];
    const ledger=await db.query(`SELECT * FROM ledger WHERE user_id=$1 AND ($2='all' OR ($2='account' AND kind='settlement') OR ($2='key' AND kind IN ('task_settlement','task_adjustment'))) ORDER BY created_at DESC LIMIT 20`,[req.user.id,q.source]);
    return {balance:await balance(db,req.user.id),funds:await settlementFunds(db,req.user.id),pendingProfit:pending.amount,invoicesTotal:Number(ic.count),withdrawalsTotal:Number(wc.count),invoices,withdrawals:withdrawals.map(w=>({...w,destination:withdrawalDestination(box,w.destination)})),ledger,source:q.source,billing:billingSchedule()};
  });
  app.get('/api/ledger/export',async(req,reply)=>{
    const [total]=await db.query('SELECT count(*) AS count FROM ledger WHERE user_id=$1',[req.user.id]);
    assert(Number(total.count)<=100000,'流水超过 100,000 条，请联系管理员按数据库备份导出');
    const rows=await db.query('SELECT * FROM ledger WHERE user_id=$1 ORDER BY created_at,id',[req.user.id]);
    return reply.header('Content-Type','text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="ccmax-ledger.csv"').send(csv(rows,[['created_at','时间'],['kind','类型'],['amount_usd','金额 USD'],['reference_id','关联账单或提现编号']]));
  });
  app.get('/api/finance/check',async req=>db.transaction(async tx=>{
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
    await assertWalletAccounting(tx,req.user.id);
    return {ok:true,balance:await balance(tx,req.user.id),checkedAt:new Date().toISOString()};
  }));
  app.get('/api/finance/audit',{config:{rateLimit:{max:4,timeWindow:'1 minute'}}},async req=>{
    await requireOwner(req.user);
    return db.transaction(async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      return auditFinance(tx);
    });
  });
  app.get('/api/invoices/preview',async req=>{
    const d=z.object({userId:identifier.optional(),from:date,to:date}).parse(req.query);
    return db.transaction(async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const result=await previewInvoice(tx,req.user,d.userId??req.user.id,d.from,d.to);
      return {...result,platforms:publicConnectionRows(req.user,result.platforms)};
    });
  });
  app.post('/api/invoices',async req=>{
    const d=z.object({userId:identifier,from:date,to:date,previewToken:z.string().regex(/^[a-f0-9]{64}$/).optional()}).parse(req.body);return createInvoice(db,req.user,d.userId,d.from,d.to,d.previewToken);
  });
  app.post('/api/invoices/:id/confirm',async req=>{
    const d=z.object({reference:z.string().trim().min(3).max(500)}).parse(req.body);return confirmInvoice(db,req.user,identifier.parse((req.params as Row).id),d.reference);
  });
  app.get('/api/invoices/:id/export',async(req,reply)=>{
    const invoiceId=identifier.parse((req.params as Row).id),[inv]=await db.query('SELECT * FROM invoices WHERE id=$1',[invoiceId]);assert(inv&&(inv.user_id===req.user.id||inv.payer_id===req.user.id),'无权查看账单',403);
    const items=await db.query(`SELECT u.day,u.source,u.source_at,a.email,c.id AS connection_id,c.provider,c.name AS platform,u.raw_usd,e.rate,e.gross_usd,e.downstream_usd,e.profit_usd FROM invoice_items i JOIN earnings e ON e.id=i.earning_id
      JOIN usage_days u ON u.id=e.usage_id JOIN bindings b ON b.id=u.binding_id JOIN connections c ON c.id=b.connection_id JOIN accounts a ON a.id=b.account_id WHERE i.invoice_id=$1 ORDER BY u.day,a.email`,[invoiceId]);
    return reply.header('Content-Type','text/csv; charset=utf-8').header('Content-Disposition',`attachment; filename="${inv.number}.csv"`).send(csv(items.map(c=>({...c,platform:connectionName(req.user,c.provider,c.connection_id,c.platform),billing_basis:c.source==='daily_snapshot'?'快照预估':c.source==='upstream_daily'?'上游完整日账单':'人工核实日账单'})),[['day','日期'],['email','账号'],['platform','平台'],['raw_usd','账单 USD'],['rate','折扣'],['gross_usd','应收 USD'],['downstream_usd','下级应付 USD'],['profit_usd','利润 USD'],['billing_basis','账单依据'],['source_at','数据截止时间']]));
  });
  app.post('/api/withdrawals',async req=>{
    const d=z.object({amount:money,method:z.string().trim().min(1).max(80),destination:z.string().trim().min(3).max(500),key}).parse(req.body);const w=await requestWithdrawal(db,req.user,d.amount,d.method,d.destination,d.key,box);return {...w,destination:withdrawalDestination(box,w.destination)};
  });
  app.post('/api/withdrawals/:id/review',async req=>{
    const d=z.object({action:z.enum(['paid','rejected']),reference:z.string().trim().min(3).max(500)}).parse(req.body);const w=await reviewWithdrawal(db,req.user,identifier.parse((req.params as Row).id),d.action,d.reference);return {...w,destination:withdrawalDestination(box,w.destination)};
  });
  app.get('/api/audits',async req=>({rows:await db.query(`SELECT a.*,u.name AS actor_name FROM audits a LEFT JOIN users u ON u.id=a.actor_id WHERE a.actor_id=$1 OR $2::boolean ORDER BY a.created_at DESC LIMIT 300`,[req.user.id,req.user.role==='owner'])}));
  return {app,box};
}
