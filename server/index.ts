import 'dotenv/config';
import path from 'node:path';
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import { bootstrap, assert } from './core.js';
import { openDB, migrate } from './db.js';
import { createApp } from './app.js';
import { createWorker } from './worker.js';
import { scheduleDailyBilling, scheduleBillingSnapshots } from './billing-scheduler.js';
import { syncPublishedKeyTasks } from './key-market.js';
import { scheduleInventorySync } from './inventory-scheduler.js';
import { autoRepairInvoices } from './invoice-repair.js';

const prod=process.env.NODE_ENV==='production';
const appUrl=process.env.APP_URL||(process.env.RAILWAY_PUBLIC_DOMAIN?`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`:undefined);
assert(!prod||(appUrl && new URL(appUrl).protocol==='https:'),'生产环境必须配置 HTTPS 的 APP_URL 或 Railway 公网域名',500);
assert(process.env.DATABASE_URL||(!prod&&process.env.ALLOW_LOCAL_DB==='true'),'生产环境必须设置 DATABASE_URL；本地开发需明确开启 ALLOW_LOCAL_DB',500);
const db=await openDB(process.env.DATABASE_URL,process.env.LOCAL_DB_PATH||'.local/database');
await migrate(db);await bootstrap(db,process.env);
assert(process.env.ENCRYPTION_KEY,'生产或本地启动都必须设置 ENCRYPTION_KEY',500);
const {app,box}=await createApp(db,{encryptionKey:process.env.ENCRYPTION_KEY,appUrl:appUrl||'http://localhost:3000',production:prod,logger:true});
const worker=createWorker(db,box,undefined,['sync','reconcile','oauth_start','oauth_exchange','import_rt','set_proxy','set_enabled']);
const billingWorker=createWorker(db,box,undefined,['daily_billing']);
const snapshotWorkers=Array.from({length:3},()=>createWorker(db,box,undefined,['billing_snapshot']));
await worker.recover();
let vite:any;
if(!prod) {
  const {createServer}=await import('vite');
  vite=await createServer({server:{middlewareMode:true},appType:'spa'});
  app.setNotFoundHandler(async(req,reply)=>{
    if(req.url.startsWith('/api/')) return reply.code(404).send({error:'接口不存在'});
    reply.hijack();vite.middlewares(req.raw,reply.raw);
  });
} else {
  const root=path.resolve('dist/client');assert(existsSync(root),'前端构建产物不存在',500);
  await app.register(fastifyStatic,{root,wildcard:false});
  app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({error:'接口不存在'}):reply.sendFile('index.html'));
}
const workTimer=setInterval(()=>{worker.tick().catch(e=>app.log.error(e));},1000);
const billingWorkTimer=setInterval(()=>{billingWorker.tick().catch(e=>app.log.error(e));},1000);
const snapshotWorkTimer=setInterval(()=>{for(const sampler of snapshotWorkers)sampler.tick().catch(e=>app.log.error(e));},1000);
let keyScheduling=false;
async function scheduleKeySync() {
  if(keyScheduling)return;
  keyScheduling=true;
  try {
    const results=await syncPublishedKeyTasks(db,box);
    if(results.some(result => 'issues' in result || 'error' in result)) app.log.warn({results},'Key task sync completed with issues');
  } finally {keyScheduling=false;}
}
const keySyncTimer=setInterval(()=>{scheduleKeySync().catch(e=>app.log.error(e));},Math.max(60,Number(process.env.KEY_SYNC_INTERVAL_SECONDS)||300)*1000);
let scheduling=false;
async function scheduleSync() {
  if(scheduling)return;scheduling=true;
  try {
    await worker.recover();
    await scheduleInventorySync(db,box);
  } finally{scheduling=false;}
}
const syncTimer=setInterval(()=>{scheduleSync().catch(e=>app.log.error(e));},15000);
await app.listen({host:process.env.HOST||'0.0.0.0',port:Number(process.env.PORT)||3000});
let billingScheduling=false;
let lastBillingMinute=-1;
async function scheduleBilling() {
  const minute=Math.floor(Date.now()/60000);
  if(billingScheduling||lastBillingMinute===minute)return;billingScheduling=true;
  try {
    await worker.recover();await scheduleBillingSnapshots(db,box);await scheduleDailyBilling(db,box);
    const repairs=await autoRepairInvoices(db);
    if(repairs.repaired||repairs.issues.length)app.log.info({repairs},'Automatic duplicate invoice repair');
    lastBillingMinute=minute;
  } finally {billingScheduling=false;}
}
const billingTimer=setInterval(()=>{scheduleBilling().catch(e=>app.log.error(e));},5000);
await scheduleBilling();
let shuttingDown=false;
async function shutdown() {
  if(shuttingDown)return;shuttingDown=true;
  for(const timer of [workTimer,syncTimer,keySyncTimer,billingTimer,billingWorkTimer,snapshotWorkTimer])clearInterval(timer);
  worker.stop();billingWorker.stop();for(const sampler of snapshotWorkers)sampler.stop();
  await app.close();
  // Give an in-flight external mutation time to finish and commit its result.
  const deadline=Date.now()+28000;
  while((worker.isBusy()||billingWorker.isBusy()||snapshotWorkers.some(s=>s.isBusy()))&&Date.now()<deadline) await new Promise(r=>setTimeout(r,250));
  if(vite) await vite.close();await db.close();process.exit(0);
}
process.on('SIGTERM',()=>{shutdown().catch(()=>process.exit(1));});process.on('SIGINT',()=>{shutdown().catch(()=>process.exit(1));});
// Independent startup tasks must not hold up the billing scheduler or prevent
// shutdown handlers from being installed while an upstream request is pending.
void scheduleSync().catch(e=>app.log.error(e));
void scheduleKeySync().catch(e=>app.log.error(e));
