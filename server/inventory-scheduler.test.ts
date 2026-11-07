import {expect,it} from 'vitest';
import {syncIntervalMs} from './inventory-scheduler.js';
it('polls Accedra every minute while preserving configured intervals for other platforms',()=>{
  expect(syncIntervalMs('accedra',300)).toBe(60000);
  expect(syncIntervalMs('gatelink',300)).toBe(300000);
  expect(syncIntervalMs('ai008',15)).toBe(60000);
  expect(syncIntervalMs('accedra',900)).toBe(60000);
});

import {openTestDB} from './test-db.js';
import {migrate} from './db.js';
import {bootstrap,secretBox} from './core.js';
import {scheduleInventorySync} from './inventory-scheduler.js';
it('schedules only due connections, coalesces active work, and keeps other platforms on their cadence',async()=>{
 const db=await openTestDB(),box=secretBox('51'.repeat(32));
 try {
  await migrate(db);await bootstrap(db,{ADMIN_EMAIL:'scheduler@example.com',ADMIN_PASSWORD:'scheduler test password'});
  for(const provider of ['gatelink','accedra'])await db.query('INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,$1,$1,$2,0.25)',[provider,box.encrypt({username:'u',password:'p'})]);
  const now=new Date('2020-01-01T00:00:00Z');
  await scheduleInventorySync(db,box,now);await scheduleInventorySync(db,box,now);
  expect(await db.query('SELECT id FROM jobs')).toHaveLength(2);
  await db.query("UPDATE jobs SET state='succeeded'");
  now.setTime(now.getTime()+60000);
  await scheduleInventorySync(db,box,now);
  expect((await db.query("SELECT count(*)::int AS n FROM jobs WHERE connection_id='accedra'"))[0].n).toBe(2);
  expect((await db.query("SELECT count(*)::int AS n FROM jobs WHERE connection_id='gatelink'"))[0].n).toBe(1);
  await scheduleInventorySync(db,box,now);expect(await db.query('SELECT id FROM jobs')).toHaveLength(3);
 } finally {await db.close();}
});
