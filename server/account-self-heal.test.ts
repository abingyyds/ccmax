import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import type {FastifyInstance,InjectOptions} from 'fastify';
import {createApp} from './app.js';
import {bootstrap,id} from './core.js';
import {migrate,type DB} from './db.js';
import {openTestDB} from './test-db.js';

describe('account placeholder self-healing',()=>{
  let db:DB,app:FastifyInstance,cookie:string,userId:string;
  const password='account-self-heal-password';

  async function create(email:string,label='Recovered') {
    return app.inject({method:'POST',url:'/api/accounts',headers:{cookie,'x-ccmax-request':'1'},payload:{email,label}} as InjectOptions);
  }

  beforeEach(async()=>{
    db=await openTestDB();
    await migrate(db);
    await bootstrap(db,{ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:password});
    const [owner]=await db.query("SELECT * FROM users WHERE role='owner'");
    userId=id();
    await db.query('INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,$3,$3,$4)',[userId,owner.id,'agent@example.com',owner.password_hash]);
    ({app}=await createApp(db,{encryptionKey:'ab'.repeat(32),appUrl:'http://localhost:3000'}));
    const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{'x-ccmax-request':'1'},payload:{email:'agent@example.com',password}});
    expect(login.statusCode).toBe(200);
    cookie=String(login.headers['set-cookie']).split(';')[0];
  });

  afterEach(async()=>{await app.close();await db.close();});

  it('claims an ownerless, unverified and unbound placeholder instead of returning a conflict',async()=>{
    const accountId=id();
    await db.query("INSERT INTO accounts(id,email,label,ownership_verified,created_at) VALUES($1,$2,'Stale placeholder',false,now()-interval '1 hour')",[accountId,'junior2@sartel.ai']);

    const response=await create('junior2@sartel.ai','Junior 2');

    expect(response.statusCode,response.body).toBe(200);
    expect(response.json().account).toMatchObject({id:accountId,owner_id:userId,submitted_by:userId,email:'junior2@sartel.ai',label:'Junior 2',ownership_verified:false});
    expect((await db.query('SELECT action,details FROM audits WHERE target_id=$1',[accountId]))).toEqual([
      expect.objectContaining({action:'account.create',details:expect.objectContaining({recovered:true})}),
    ]);
  });

  it('claims an old, inert reservation owned by another user and still requires OAuth verification',async()=>{
    const [owner]=await db.query("SELECT id FROM users WHERE role='owner'"),accountId=id();
    await db.query("INSERT INTO accounts(id,owner_id,submitted_by,email,label,ownership_verified,created_at) VALUES($1,$2,$2,$3,'Abandoned',false,now()-interval '1 hour')",[accountId,owner.id,'stale-reservation@example.com']);

    const response=await create('stale-reservation@example.com','Recovered reservation');

    expect(response.statusCode,response.body).toBe(200);
    expect(response.json().account).toMatchObject({id:accountId,owner_id:userId,submitted_by:userId,label:'Recovered reservation',ownership_verified:false});
  });

  it.each([
    ['recent placeholder',async(accountId:string)=>{await db.query('UPDATE accounts SET created_at=now() WHERE id=$1',[accountId]);}],
    ['verified placeholder',async(accountId:string)=>{await db.query('UPDATE accounts SET ownership_verified=true WHERE id=$1',[accountId]);}],
    ['bound placeholder',async(accountId:string)=>{const connectionId=id();await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'ai008','test','encrypted',0.5)",[connectionId]);await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)',[id(),accountId,connectionId]);}],
    ['proxied placeholder',async(accountId:string)=>{const proxyId=id();await db.query("INSERT INTO proxies(id,owner_id,name,endpoint,secret,fingerprint) VALUES($1,$2,'test','proxy.example.com:8080','encrypted',$1)",[proxyId,userId]);await db.query('UPDATE accounts SET proxy_id=$2 WHERE id=$1',[accountId,proxyId]);}],
    ['actively authorizing placeholder',async(accountId:string)=>{const connectionId=id();await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'ai008','test','encrypted',0.5)",[connectionId]);await db.query("INSERT INTO oauth_attempts(id,user_id,connection_id,account_id,secret,authorization_url,state,expires_at) VALUES($1,$2,$3,$4,'encrypted','https://example.com','pending',now()+interval '1 hour')",[id(),userId,connectionId,accountId]);}],
  ])('does not claim an ownerless account when it is an %s',async(_label,makeUnsafe)=>{
    const accountId=id(),email=`${accountId}@example.com`;
    await db.query("INSERT INTO accounts(id,email,label,ownership_verified,created_at) VALUES($1,$2,'Protected',false,now()-interval '1 hour')",[accountId,email]);
    await makeUnsafe(accountId);

    const response=await create(email);

    expect(response.statusCode).toBe(409);
    const [stored]=await db.query('SELECT owner_id,submitted_by FROM accounts WHERE id=$1',[accountId]);
    expect(stored.owner_id).not.toBe(userId);
    expect(stored.submitted_by).not.toBe(userId);
  });
});
