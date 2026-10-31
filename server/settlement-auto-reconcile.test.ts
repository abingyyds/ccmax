import { expect, it } from 'vitest';
import { bootstrap, id } from './core.js';
import { migrate } from './db.js';
import { openTestDB } from './test-db.js';

const JADEN='1cf8308f-6e34-4aa8-acd7-b45a9c9cf6f5';
const TARGETS=[
  ['72761ba0-b790-42cc-a7fd-21a8fb1dc44e','dev3@sartel.ai','maxchat','2026-10-29','204.63112100'],
  ['94cbbdea-38d1-46f2-8060-0f7a78348843','dev3@sartel.ai','gatelink','2026-10-29','115.39451800'],
  ['084662bf-95ff-47ce-a237-a55b33dad310','dev4@sartel.ai','gatelink','2026-10-29','130.55072400'],
  ['75d101df-832b-4f34-940b-112bd8c1739a','dev4@sartel.ai','maxchat','2026-10-29','60.16712520'],
  ['66d3eb3e-54b7-4719-a726-967f82f3c147','junior3@sartel.ai','maxchat','2026-10-29','5.51848000'],
  ['7232050d-3e57-4620-96eb-de9e9fcbfcaf','dev2@sartel.ai','gatelink','2026-10-30','203.42130100'],
  ['9a8266bc-3df5-4510-b34c-7ae0ee10b6ad','dev3@sartel.ai','gatelink','2026-10-30','43.52740600'],
  ['80937669-cc7c-48ac-9692-9f2e7456a917','dev4@sartel.ai','gatelink','2026-10-30','0.90842500'],
  ['567af9c1-aae5-4581-b315-2e0fcc01973e','junior1@sartel.ai','gatelink','2026-10-30','19.34791100'],
  ['8642d5ef-237a-4c74-ae73-6e830f37e647','junior3@sartel.ai','gatelink','2026-10-30','0.84696500'],
  ['dcd5dfed-8cf2-4493-aacc-8534fa570509','rhinasofi@hotmail.com','gatelink','2026-10-31','115.54776200'],
] as const;

it('credits the eleven exact stranded production rows once when the deployment migrates',async()=>{
  const db=await openTestDB();
  try {
    await migrate(db);
    await bootstrap(db,{ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:'migration-password'});
    const [owner]=await db.query("SELECT * FROM users WHERE role='owner'");
    await db.query("INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,'jaden@example.com','Jaden','x')",[JADEN,owner.id]);
    const connections:Record<string,string>={};
    for(const provider of ['gatelink','maxchat']) {
      const connection=id();connections[provider]=connection;
      await db.query('INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,$2,$2,$3,0.5)',[connection,provider,'encrypted']);
      await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date,created_by) VALUES($1,$2,0.5,'1970-01-01',$3)",[id(),connection,owner.id]);
    }
    for(const [provider,rate] of [['gatelink','0.29'],['maxchat','0.2']] as const)
      await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,$4,'2026-10-01',$5)",[id(),JADEN,provider,rate,owner.id]);
    const accounts=new Map<string,string>();
    for(const email of new Set(TARGETS.map(target=>target[1]))) {
      const account=id();accounts.set(email,account);
      await db.query('INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,$3,true)',[account,JADEN,email]);
    }
    const bindings=new Map<string,string>();
    for(const [usageId,email,provider,day,raw] of TARGETS) {
      const key=`${email}:${provider}`;
      let binding=bindings.get(key);
      if(!binding) {
        binding=id();bindings.set(key,binding);
        await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)',[binding,accounts.get(email),connections[provider]]);
      }
      await db.query(`INSERT INTO usage_days(id,binding_id,day,raw_usd,state,source,root_rate)
        VALUES($1,$2,$3,$4,'provisional','live_snapshot',0.5)`,[usageId,binding,day,raw]);
    }

    await db.query('DELETE FROM migrations WHERE version=26');
    await migrate(db);
    await migrate(db);

    const [credit]=await db.query("SELECT COALESCE(sum(amount_usd),0) AS amount,count(*)::int AS count FROM ledger WHERE user_id=$1 AND kind='settlement'",[JADEN]);
    expect(credit).toEqual({amount:'236.63139872',count:1});
    expect((await db.query("SELECT count(*)::int AS count FROM usage_days WHERE id=ANY($1::text[]) AND state='final'",[TARGETS.map(target=>target[0])]))[0].count).toBe(11);
    expect((await db.query('SELECT count(*)::int AS count FROM migrations WHERE version=26'))[0].count).toBe(1);
  } finally {await db.close();}
});
