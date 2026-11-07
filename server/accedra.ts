import type { Credentials, OAuthOptions, UpstreamAccount } from './providers.js';
import Decimal from 'decimal.js';
import { AppError, assert, MAX_USD, today } from './core.js';
import { normalizeTelemetry } from './telemetry.js';
import { authorizationState, parseOAuthCallback } from '../shared/oauth.js';

export type AccedraAuthorization = {url:string;secret:any;expiresIn:number;completedAccount?:UpstreamAccount};
export type AccedraAccount = UpstreamAccount & {nextAuthorization?:AccedraAuthorization};
type Submission = OAuthOptions & {idempotencyKey?:string;userAgent?:string};
type AuthorizationSecret = {accountId:string;accessKey:string;options:Submission;phase?:'read'|'chat';attemptId?:string;authorizationUrl?:string};
export const ACCEDRA_PAYOUT_RATE = '0.25';
const apiBase = 'https://accedra.xyz';
const money = (value:unknown) => {
  assert(typeof value==='string'&&/^\d+(\.\d+)?$/.test(value),'Platform X (✨ Anti-Ban) 金额格式无效',502);
  const amount=new Decimal(value);
  assert(amount.isFinite()&&amount.gte(0)&&amount.lte(MAX_USD),'Platform X (✨ Anti-Ban) 金额超出范围',502);
  return amount;
};
const accountId = (value:unknown) => {
  assert(typeof value==='number'&&Number.isSafeInteger(value)&&value>0,'Platform X (✨ Anti-Ban) 账号 ID 无效',502);
  return String(value);
};

export class AccedraClient {
  constructor(private credentials:Credentials,private request:typeof fetch=fetch) {}

  private async call(path:string,body?:object,secret?:AuthorizationSecret) {
    const headers:Record<string,string>={Accept:'application/json','Content-Type':'application/json',Authorization:`Bearer ${secret?.accessKey??this.credentials.password}`};
    if(secret?.options.userAgent)headers['User-Agent']=secret.options.userAgent.slice(0,512);
    let response:Response;
    try {
      response=await this.request(apiBase+'/api/v1/provider/'+path,{method:body===undefined?'GET':'POST',headers,redirect:'error',signal:AbortSignal.timeout(path.startsWith('onboarding/')?100000:25000),...(body===undefined?{}:{body:JSON.stringify(body)})});
    } catch {throw new AppError(502,'Platform X (✨ Anti-Ban) 连接失败；请核对任务和账号状态后再重试');}
    if(!response.ok)throw new AppError(502,`Platform X (✨ Anti-Ban) 请求失败（HTTP ${response.status}）`);
    let value:any;
    try {value=await response.json();} catch {throw new AppError(502,'Platform X (✨ Anti-Ban) 响应格式无效');}
    assert(value?.code===0&&Object.hasOwn(value,'data'),'Platform X (✨ Anti-Ban) 响应格式无效',502);
    return value.data;
  }

  normalize(row:any):UpstreamAccount {
    const id=accountId(row?.id);
    assert(typeof row.email==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email),'Platform X (✨ Anti-Ban) 账号邮箱无效',502);
    const quota=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
    const fiveHour=quota(row.usage_5h),sevenDay=quota(row.usage_7d);
    const telemetry=normalizeTelemetry('accedra',{claude_utilization:{five_hour:{utilization:fiveHour},seven_day:{utilization:sevenDay}}});
    // This API does not report quota observation timestamps. Do not invent freshness.
    telemetry.sourceAt=null;
    return {id,email:row.email.toLowerCase(),name:typeof row.name==='string'?row.name:row.email,status:typeof row.status==='string'?row.status:'unknown',dailyUsd:null,cost7d:null,cost30d:null,utilization:fiveHour,telemetry};
  }

  async accounts():Promise<UpstreamAccount[]> {
    const rows=await this.call('accounts');
    assert(rows===null||Array.isArray(rows),'Platform X (✨ Anti-Ban) 账号列表格式无效',502);
    const accounts=(rows??[]).map((row:any)=>({row,normalized:this.normalize(row)})).filter(({row}:any)=>row.onboarding_status==='complete'||row.status==='active').map(({normalized}:any)=>normalized) as UpstreamAccount[];
    assert(new Set(accounts.map(a=>a.id)).size===accounts.length&&new Set(accounts.map(a=>a.email)).size===accounts.length,'Platform X (✨ Anti-Ban) 返回重复账号',502);
    return accounts;
  }

  async liveAccounts():Promise<UpstreamAccount[]> {
    const accounts=await this.accounts(),value=await this.call('finance/live-statement');
    const stamp=typeof value?.observed_at==='string'?Date.parse(value.observed_at):NaN;
    assert(value?.date===today()&&value.timezone==='Asia/Shanghai'&&value.basis==='credited_earnings'&&value.complete===false&&value.snapshot_complete===true&&Array.isArray(value.accounts), 'Platform X (✨ Anti-Ban) 实时收益快照不完整',502);
    assert(Number.isFinite(stamp)&&stamp<=Date.now()+60000&&stamp>=Date.now()-600000&&new Date(stamp+8*3600000).toISOString().slice(0,10)===value.date,'Platform X (✨ Anti-Ban) 实时收益快照已过期',502);
    const count=(n:unknown)=>{
      if(n===null)return null;
      assert(typeof n==='string'&&/^(0|[1-9]\d*)$/.test(n)&&new Decimal(n).lte(Number.MAX_SAFE_INTEGER),'Platform X (✨ Anti-Ban) 用量计数无效',502);
      return Number(n);
    };
    const rows=new Map<string,{raw:string;billed:string;requests:number|null;tokens:number|null}>();let total=new Decimal(0);
    for(const row of value.accounts) {
      const id=accountId(row?.account_id),credit=money(row.credited_usd);
      assert(!rows.has(id)&&money(row.payout_multiplier).eq(ACCEDRA_PAYOUT_RATE),'Platform X (✨ Anti-Ban) 账号重复或折扣不匹配',502);
      const raw=credit.toDecimalPlaces(8,Decimal.ROUND_DOWN).div(ACCEDRA_PAYOUT_RATE);
      assert(raw.lte(MAX_USD),'Platform X (✨ Anti-Ban) 实时收益超出范围',502);
      rows.set(id,{raw:raw.toFixed(),billed:money(row.billed_usd).toFixed(),requests:count(row.requests),tokens:count(row.tokens)});total=total.plus(credit);
    }
    assert(total.eq(money(value.total_credited_usd)),'Platform X (✨ Anti-Ban) 实时收益合计不一致',502);
    return accounts.map(account=>{
      const row=rows.get(account.id)??{raw:'0',billed:'0',requests:0,tokens:0},t=account.telemetry!;
      t.sourceAt=new Date(stamp).toISOString();t.day=value.date;t.source='account_detail';t.detail='available';
      t.periods.today={...t.periods.today,billedUsd:row.billed,requests:row.requests,tokens:row.tokens};
      return {...account,dailyUsd:row.raw};
    });
  }

  async finance() {
    const summary=await this.call('finance/earnings');
    assert(summary?.balance,'Platform X (✨ Anti-Ban) 收益数据缺失',502);
    const balance:Record<string,string|boolean|null>={};
    for(const key of ['available_amount','held_amount','lifetime_earned','lifetime_paid','withdrawable_amount'])balance[key]=money(summary.balance[key]).toFixed();
    balance.reconciliation_pending=summary.balance.reconciliation_pending===true;
    balance.estimated_amount=summary.balance.estimated_amount==null?null:money(summary.balance.estimated_amount).toFixed();
    return {basis:'credited_earnings',balance};
  }

  async identity(id:string,email:string):Promise<UpstreamAccount> {
    assert(/^[1-9]\d*$/.test(id),'Platform X (✨ Anti-Ban) 账号 ID 无效');
    const row=await this.call('accounts/'+id),remote=this.normalize(row);
    assert(remote.id===id&&remote.email===email.toLowerCase(),'Platform X (✨ Anti-Ban) 账号身份不一致',409);
    return remote;
  }

  async start(options:Submission):Promise<AccedraAuthorization> {
    assert(options.proxy,'Platform X (✨ Anti-Ban) 需要账号固定代理');
    let account:any,accessKey:unknown;
    if(options.existingExternalId){
      await this.identity(options.existingExternalId,options.email);
      const response=await this.call(`accounts/${options.existingExternalId}/onboarding-key`,{});
      account={id:Number(options.existingExternalId)};accessKey=response?.access_key;
    } else {
      assert(options.idempotencyKey&&options.idempotencyKey.length<=128,'Platform X (✨ Anti-Ban) 缺少稳定的提交编号');
      const response=await this.call('accounts',{email:options.email,name:options.email,proxy_mode:'custom',custom_proxy:options.proxy,idempotency_key:options.idempotencyKey});
      account=response?.account;accessKey=response?.access_key;
      assert(this.normalize(account).email===options.email.toLowerCase(),'Platform X (✨ Anti-Ban) 账号身份不一致',409);
    }
    assert(typeof accessKey==='string'&&accessKey.length>0,'Platform X (✨ Anti-Ban) 未返回授权凭据',502);
    return this.next({accountId:accountId(account?.id),accessKey,options});
  }

  private async next(secret:AuthorizationSecret):Promise<AccedraAuthorization> {
    const proof=await this.call('onboarding/verify',{},secret);
    assert(proof?.email?.toLowerCase()===secret.options.email.toLowerCase(),'Platform X (✨ Anti-Ban) 授权邮箱不一致',409);
    const authorized=proof.status==='complete'||Array.isArray(proof.destinations)&&proof.destinations.length>0&&proof.destinations.every((d:any)=>d.auth_status==='authorized');
    if(authorized)return {url:'',secret,expiresIn:600,completedAccount:await this.identity(secret.accountId,secret.options.email)};
    const read=await this.call('onboarding/read/start',{},secret);
    if(read?.completed!==true)return this.authorization(secret,'read',read);
    const refreshed=await this.call('onboarding/verify',{},secret);
    if(refreshed.status==='complete')return {url:'',secret,expiresIn:600,completedAccount:await this.identity(secret.accountId,secret.options.email)};
    const chat=await this.call('onboarding/chat/start',{},secret);
    assert(chat?.completed!==true,'Platform X (✨ Anti-Ban) 授权状态待核对，请重新同步',409);
    return this.authorization(secret,'chat',chat);
  }

  private authorization(secret:AuthorizationSecret,phase:'read'|'chat',response:any):AccedraAuthorization {
    assert(typeof response?.authorization_url==='string'&&authorizationState(response.authorization_url),'Platform X (✨ Anti-Ban) 未返回可核验的授权链接',502);
    const url=new URL(response.authorization_url);
    assert(url.protocol==='https:','Platform X (✨ Anti-Ban) 授权链接必须使用 HTTPS',502);
    if(phase==='read')assert(typeof response.attempt_id==='string'&&response.attempt_id,'Platform X (✨ Anti-Ban) 授权流程缺少编号',502);
    return {url:url.toString(),expiresIn:600,secret:{...secret,phase,attemptId:response.attempt_id,authorizationUrl:url.toString()}};
  }

  async complete(secret:AuthorizationSecret,callback:string):Promise<AccedraAccount> {
    assert(secret?.accessKey&&secret.accountId&&secret.options&&secret.authorizationUrl,'Platform X (✨ Anti-Ban) 授权流程已失效',409);
    const parsed=parseOAuthCallback(callback,authorizationState(secret.authorizationUrl));
    if(secret.phase==='read')await this.call('onboarding/read/complete',{attempt_id:secret.attemptId,callback:`${parsed.code}#${parsed.state}`},secret);
    else {assert(secret.phase==='chat','Platform X (✨ Anti-Ban) 授权阶段无效',409);await this.call('onboarding/chat/complete',{code:parsed.code},secret);}
    const next=await this.next(secret);
    if(next.completedAccount)return next.completedAccount;
    return {id:secret.accountId,email:secret.options.email,name:secret.options.email,status:'pending',dailyUsd:null,cost7d:null,cost30d:null,utilization:null,nextAuthorization:next};
  }

  async statement(day:string):Promise<{externalId:string;rawUsd:string}[]> {
    assert(/^\d{4}-\d{2}-\d{2}$/.test(day)&&day>='0001-01-01'&&day<'9999-12-31'&&Number.isFinite(Date.parse(day))&&new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day&&day<today(),'只能读取有效的已结束日期');
    const value=await this.call('finance/daily-statement?date='+encodeURIComponent(day));
    assert(value?.date===day&&value.timezone==='Asia/Shanghai'&&value.basis==='credited_earnings'&&value.complete===true&&Array.isArray(value.accounts),'Platform X (✨ Anti-Ban) 日账单不完整',502);
    const seen=new Set<string>();let total=new Decimal(0);
    const rows=value.accounts.map((row:any)=>{
      const id=accountId(row?.account_id),credited=money(row.credited_usd);
      assert(!seen.has(id)&&money(row.payout_multiplier).eq(ACCEDRA_PAYOUT_RATE),'Platform X (✨ Anti-Ban) 账号重复或历史折扣不匹配，请人工核对',502);
      seen.add(id);total=total.plus(credited);
      // CCMAX stores eight decimals. Round down before gross-up so liabilities
      // cannot exceed the actual upstream credit by a rounding fraction.
      const raw=credited.toDecimalPlaces(8,Decimal.ROUND_DOWN).div(ACCEDRA_PAYOUT_RATE);
      assert(raw.lte(MAX_USD),'Platform X (✨ Anti-Ban) 日账单超出范围',502);
      return {externalId:id,rawUsd:raw.toFixed()};
    });
    assert(total.eq(money(value.total_credited_usd)),'Platform X (✨ Anti-Ban) 日账单合计不一致',502);
    return rows;
  }
}
