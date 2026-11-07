import { describe, expect, it } from 'vitest';
import { AccedraClient } from './accedra.js';

const credentials = {username:'provider-api',password:'acd_provider_private'};
const options = {email:'account@example.com',proxy:'http://user:password@proxy.example:8080',idempotencyKey:'ccmax:connection:account'};
const owned = {id:42,email:'account@example.com',name:'Account',status:'active',onboarding_status:'complete',usage_5h:37.5,usage_7d:61,earnings:'2.500000000000',estimated_amount:'0.1'};
const envelope = (data:unknown) => Response.json({code:0,data});

describe('Accedra provider API contract',()=>{
  it('keeps unfinished upstream accounts out of inventory so background sync cannot block their authorization',async()=>{
    const client=new AccedraClient(credentials,async()=>envelope([{...owned,status:'disabled',onboarding_status:'pending'}, {...owned,id:43,email:'complete@example.com',status:'disabled'}]));
    expect((await client.accounts()).map(a=>a.id)).toEqual(['43']);
    expect(await new AccedraClient(credentials,async()=>envelope(null)).accounts()).toEqual([]);
  });

  it('rejects invalid statement dates before requesting an upstream report',async()=>{
    let calls=0;const client=new AccedraClient(credentials,async()=>{calls++;return envelope({});});
    await expect(client.statement('0000-01-01')).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it('keeps the key on the fixed HTTPS origin, preserves quotas, and never books lifetime or estimated earnings as daily usage',async()=>{
    const calls:{url:string;init?:RequestInit}[]=[];
    const client=new AccedraClient(credentials,async(url,init)=>{
      calls.push({url:String(url),init});
      return envelope(String(url).endsWith('/accounts')?[owned]:{balance:{available_amount:'2.5',held_amount:'0',lifetime_earned:'2.5',lifetime_paid:'0',withdrawable_amount:'2.5',reconciliation_pending:false,estimated_amount:'0.1'},earnings:[]});
    });
    const accounts=await client.accounts();
    expect(accounts[0]).toMatchObject({id:'42',email:options.email,status:'active',dailyUsd:null,cost7d:null,cost30d:null,utilization:37.5,telemetry:{quota:{fiveHour:37.5,sevenDay:61}}});
    expect(calls.every(c=>c.url.startsWith('https://accedra.xyz/api/v1/provider/'))).toBe(true);
    expect(calls.every(c=>new Headers(c.init?.headers).get('authorization')==='Bearer acd_provider_private')).toBe(true);
    expect(calls.every(c=>c.init?.redirect==='error')).toBe(true);
    expect(JSON.stringify(accounts)).not.toContain(credentials.password);
  });

  it('creates an idempotent account and performs multiple authorizations without completing ownership early',async()=>{
    let reads=0,readDone=false,chatDone=false;
    const seen:string[]=[];
    const client=new AccedraClient(credentials,async(url,init)=>{
      const path=new URL(String(url)).pathname,body=init?.body?JSON.parse(String(init.body)):{};
      seen.push(path);
      if(path==='/api/v1/provider/accounts'&&init?.method==='POST'){
        expect(body).toEqual({email:options.email,name:options.email,proxy_mode:'custom',custom_proxy:options.proxy,idempotency_key:options.idempotencyKey});
        return envelope({account:{...owned,status:'disabled',onboarding_status:'pending'},access_key:'onboarding-private',onboarding_url:'/user/provide?access_key=onboarding-private&embed=1'});
      }
      if(path.includes('/onboarding/'))expect(new Headers(init?.headers).get('authorization')).toBe('Bearer onboarding-private');
      if(path.endsWith('/verify'))return envelope({email:options.email,status:chatDone?'complete':'pending',destinations:[]});
      if(path.endsWith('/read/start'))return envelope(readDone?{completed:true,status:'read_connected'}:{attempt_id:'read-1',authorization_url:'https://claude.ai/oauth/authorize?state=read-state',status:'read_pending'});
      if(path.endsWith('/read/complete')){expect(body).toEqual({attempt_id:'read-1',callback:'read-code#read-state'});readDone=true;reads++;return envelope({completed:true,status:'read_connected'});}
      if(path.endsWith('/chat/start'))return envelope({authorization_url:'https://claude.ai/oauth/authorize?state=chat-state',status:'chat_pending'});
      if(path.endsWith('/chat/complete')){expect(body).toEqual({code:'chat-code'});chatDone=true;return envelope({status:'complete'});}
      if(path.endsWith('/accounts/42'))return envelope(owned);
      throw new Error('Unexpected request '+path);
    });
    const first=await client.start(options);
    expect(first.url).toContain('state=read-state');
    expect(first.completedAccount).toBeUndefined();
    await expect(client.complete(first.secret,'wrong#other-state')).rejects.toThrow('state');
    expect(reads).toBe(0);
    const next=await client.complete(first.secret,'read-code#read-state');
    expect(next.nextAuthorization?.url).toContain('state=chat-state');
    expect(next.status).toBe('pending');
    const finished=await client.complete(next.nextAuthorization!.secret,'https://localhost/callback?code=chat-code&state=chat-state');
    expect(finished).toMatchObject({id:'42',email:options.email,status:'active'});
    expect(finished.nextAuthorization).toBeUndefined();
    expect(seen).not.toContain('/api/v1/auth/login');
  });

  it('reconciles exact settled credits at 0.25x without applying the multiplier twice',async()=>{
    const client=new AccedraClient(credentials,async()=>envelope({date:'2020-01-01',timezone:'Asia/Shanghai',basis:'credited_earnings',complete:true,accounts:[{account_id:42,payout_multiplier:'0.2500000000',credited_usd:'0.123456789012'}],total_credited_usd:'0.123456789012'}));
    expect(await client.statement('2020-01-01')).toEqual([{externalId:'42',rawUsd:'0.49382712'}]);
  });

  it.each([
    {complete:false}, {date:'2020-01-02'}, {timezone:'UTC'}, {total_credited_usd:'2'},
    {accounts:[{account_id:42,payout_multiplier:'0.5',credited_usd:'1'}]},
    {accounts:[{account_id:42,payout_multiplier:'0.25',credited_usd:'1'},{account_id:42,payout_multiplier:'0.25',credited_usd:'0'}]},
  ])('rejects incomplete, inconsistent or differently priced statements (%j)',async override=>{
    const client=new AccedraClient(credentials,async()=>envelope({date:'2020-01-01',timezone:'Asia/Shanghai',basis:'credited_earnings',complete:true,accounts:[{account_id:42,payout_multiplier:'0.25',credited_usd:'1'}],total_credited_usd:'1',...override}));
    await expect(client.statement('2020-01-01')).rejects.toThrow();
  });

  it('rejects mismatched identities and hides upstream credential errors',async()=>{
    const wrong=new AccedraClient(credentials,async()=>envelope({...owned,email:'other@example.com'}));
    await expect(wrong.identity('42',options.email)).rejects.toThrow();
    const denied=new AccedraClient(credentials,async()=>Response.json({message:credentials.password},{status:401}));
    const error=await denied.accounts().catch(e=>e);
    expect(error.message).not.toContain(credentials.password);
    expect(error.message).toContain('401');
  });
});

describe('Accedra live provisional earnings',()=>{
  const observed=()=>new Date().toISOString();
  const report=(overrides:object={})=>({date:new Date(Date.now()+8*3600000).toISOString().slice(0,10),timezone:'Asia/Shanghai',basis:'credited_earnings',complete:false,snapshot_complete:true,observed_at:observed(),accounts:[{account_id:42,payout_multiplier:'0.25',credited_usd:'2.500000009999',billed_usd:'10.000000039996',requests:'3',tokens:'123456'}],total_credited_usd:'2.500000009999',...overrides});
  const client=(value:any)=>new AccedraClient(credentials,async url=>envelope(String(url).endsWith('/accounts')?[owned,{...owned,id:43,email:'empty@example.com'}]:value));
  it('maps current credited earnings into the existing daily provisional base while displaying actual token/bill counters',async()=>{
    const value=report(),accounts=await client(value).liveAccounts();
    expect(accounts[0]).toMatchObject({id:'42',dailyUsd:'10',telemetry:{sourceAt:value.observed_at,day:value.date,periods:{today:{requests:3,tokens:123456,billedUsd:'10.000000039996'}}}});
    expect(accounts[1]).toMatchObject({id:'43',dailyUsd:'0',telemetry:{periods:{today:{requests:0,tokens:0,billedUsd:'0'}}}});
    expect(accounts[0].telemetry?.quota.updatedAt).toBeNull();
  });
  it.each([{snapshot_complete:false},{complete:true},{date:'2000-01-01'},{timezone:'UTC'},{observed_at:'2000-01-01T00:00:00Z'},{observed_at:new Date(Date.now()+3600000).toISOString()},{total_credited_usd:'99'},
    {accounts:[{account_id:42,payout_multiplier:'0.5',credited_usd:'2.500000009999',billed_usd:'5',requests:'1',tokens:'1'}]},
    {accounts:[{account_id:42,payout_multiplier:'0.25',credited_usd:'2.500000009999',billed_usd:'10',requests:'1',tokens:'9007199254740992'}]},
  ])('rejects partial, stale, future, or inconsistent live snapshots (%j)',async override=>{
    await expect(client(report(override)).liveAccounts()).rejects.toThrow();
  });
  it('preserves unknown usage coverage rather than inventing zero tokens',async()=>{
    const value=report({accounts:[{account_id:42,payout_multiplier:'0.25',credited_usd:'2.500000009999',billed_usd:'10',requests:null,tokens:null}]});
    expect((await client(value).liveAccounts())[0].telemetry?.periods.today).toMatchObject({requests:null,tokens:null});
  });
});
