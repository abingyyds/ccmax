import type {DB} from './db.js';
import type {SecretBox} from './core.js';
import {enqueue} from './worker.js';

export const syncIntervalMs=(provider:string,configuredSeconds=Number(process.env.SYNC_INTERVAL_SECONDS)||300)=>
  provider==='accedra'?60000:Math.max(60,configuredSeconds)*1000;

export async function scheduleInventorySync(db:DB,box:SecretBox,now=new Date()) {
  const [owner]=await db.query("SELECT id FROM users WHERE role='owner'");
  const connections=await db.query('SELECT id,provider FROM connections WHERE enabled=true');
  for(const c of connections) {
    // Durable time buckets reuse jobs' indexed idempotency constraint. They
    // survive restarts without scanning the growing history every polling tick.
    const bucket=Math.floor(now.getTime()/syncIntervalMs(c.provider));
    await enqueue(db,box,owner.id,c.id,'sync',{},'scheduled-sync:'+bucket);
  }
}
