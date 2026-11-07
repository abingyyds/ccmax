import { AccedraClient, type AccedraAuthorization } from './accedra.js';
import { AppError, assert,MAX_USD } from './core.js';
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { parseProxy } from './proxies.js';
import { gatelinkFailure } from './gatelink-errors.js';
import { normalizeTelemetry,normalizeModelAmounts } from './telemetry.js';
import { telemetryPeriods,type AccountTelemetry } from '../shared/telemetry.js';
import { authorizationState } from '../shared/oauth.js';
import { statefulOAuthCallback } from './oauth-callback.js';
import { upstreamNames, publicPlatformName } from './platform-privacy.js';

export const PROVIDERS = {
  gatelink: { name:upstreamNames.gatelink, url:'https://cc.gatelink.dev', oauth:true, refreshTokenImport:false, historicalUsage:true,statusRequiresAdmin:true },
  ai008: { name:upstreamNames.ai008, url:'https://ai008.xyz', oauth:true, refreshTokenImport:true, historicalUsage:true,statusRequiresAdmin:false },
  minicc: { name:upstreamNames.minicc, url:'http://207.57.170.28:8096', oauth:true, refreshTokenImport:true, historicalUsage:true,statusRequiresAdmin:false },
  maxchat: { name:upstreamNames.maxchat, url:'https://cldgtw.maxchatapi.com', oauth:true, refreshTokenImport:true, historicalUsage:true,statusRequiresAdmin:false },
  aeromax: { name:upstreamNames.aeromax, url:'https://www.aeromax.one', oauth:true, refreshTokenImport:false, historicalUsage:false,statusRequiresAdmin:false },
  accedra: { name:upstreamNames.accedra, url:'https://accedra.xyz', oauth:true, refreshTokenImport:false, historicalUsage:true, statusRequiresAdmin:false, statusControl:false, proxyRotation:false },
} as const;
// Owner-only source metadata; public catalogs never contain upstream names/URLs.
export function platformCatalog(owner=false, enabledProviders?: Iterable<string>) {
  const enabled=enabledProviders===undefined?null:new Set(enabledProviders);
  return Object.fromEntries(Object.entries(PROVIDERS).filter(([provider])=>owner||enabled===null||enabled.has(provider)).map(([provider,{name,url,...capabilities}])=>[provider,{
    ...capabilities,name:publicPlatformName(provider),...(owner?{upstreamName:name,url}:{}),
  }]));
}
export type ProviderKey=keyof typeof PROVIDERS;
export const PROVIDER_KEYS=Object.keys(PROVIDERS) as [ProviderKey,...ProviderKey[]];
export const usesAdminOAuth=(provider:ProviderKey)=>provider==='ai008'||provider==='maxchat';
export type Credentials={username:string;password:string};
export type UpstreamAccount={id:string;email:string;name:string;status:string;dailyUsd:string|null;cost7d:string|null;cost30d:string|null;utilization:number|null;proxyExternalId?:string|null;telemetry?:AccountTelemetry;nextAuthorization?:AccedraAuthorization};
export type OAuthOptions={email:string;proxy?:string;proxyExternalId?:string;accountType?:string;policyTemplateId?:string;groupIds?:string[];ccTemplateId?:string;existingExternalId?:string;note?:string;idempotencyKey?:string;userAgent?:string};
export type UpstreamDiagnostic={status:number;operation:string;format?:'json'|'non_json'|'unreadable';contentType?:string;responseBytes?:number;requestId?:string;code?:string;fields?:Record<string,string|number|boolean|null>;responseShape?:string[];stage?:string};
export class UpstreamError extends AppError {
  constructor(public upstreamStatus:number, message:string, public upstreamCode?:string,public diagnostic?:UpstreamDiagnostic) { super(502,message); }
}
const diagnosticFields=new Set(['error','code','errorcode','type','reason','message','detail','phase','name','hostlabel','vmid','since','status','requestid','traceid']);
const sensitiveField=/(?:access|authorization|callback|cookie|credential|password|proxy|refresh|secret|session|token)/i;
function safeDiagnosticString(value:string) {
  return value.slice(0,500)
    .replace(/bearer\s+[^\s,;]+/gi,'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s,;]+/gi,'[REDACTED_URL]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,'[REDACTED_EMAIL]')
    .replace(/\b(code|token|secret|password|proxy|callback)\s*[:=]\s*[^\s,;]+/gi,'$1=[REDACTED]')
    .replace(/\b[A-Za-z0-9_=-]{32,}\b/g,'[REDACTED]')
    .slice(0,240);
}
function diagnosticCode(value:unknown) {
  if(typeof value!=='string'||value.length>64||!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value))return undefined;
  const normalized=value.toLowerCase().replaceAll('-','_');
  if(normalized.replaceAll('_','')==='instanceexists'||normalized.replaceAll('_','')==='instanceexistserror')return 'instance_exists';
  return /(?:conflict|exists|invalid|denied|unauthorized|forbidden|duplicate|limit|failed|error|busy|locked)/.test(normalized)?normalized:undefined;
}
function upstreamDiagnostic(status:number,path:string,body:unknown):UpstreamDiagnostic {
  const fields:Record<string,string|number|boolean|null>={},responseShape:string[]=[],codes:string[]=[];
  const visit=(value:unknown,segments:string[],depth:number)=>{
    if(depth>5||responseShape.length>=40||value===null||typeof value!=='object')return;
    if(Array.isArray(value)) {for(let n=0;n<Math.min(value.length,3);n++)visit(value[n],[...segments,'[]'],depth+1);return;}
    for(const [key,child] of Object.entries(value as Record<string,unknown>)) {
      const pathSegments=[...segments,key],fieldPath=pathSegments.join('.'),normalizedKey=key.toLowerCase().replace(/[^a-z0-9]/g,'');
      if(pathSegments.some(segment=>sensitiveField.test(segment)))continue;
      responseShape.push(fieldPath);
      if(child!==null&&typeof child==='object') {visit(child,pathSegments,depth+1);continue;}
      if(['error','code','errorcode','type','reason'].includes(normalizedKey)) {
        const code=diagnosticCode(child);if(code)codes.push(code);
      }
      if(!diagnosticFields.has(normalizedKey)||!['string','number','boolean'].includes(typeof child)&&child!==null)continue;
      const safe=typeof child==='string'?safeDiagnosticString(child):child as number|boolean|null;
      fields[fieldPath]=safe;
    }
  };
  visit(body,[],0);
  const arxRejected=Object.entries(fields).some(([path,value])=>/(?:^|\.)(?:error|code|errorcode)$/.test(path.toLowerCase().replace(/[_-]/g,''))&&value==='arx_request_rejected');
  const detail=Object.entries(fields).filter(([path])=>/(?:^|\.)(?:detail|message)$/.test(path.toLowerCase())).map(([,value])=>String(value)).join(' ');
  const providerNameExists=status===409&&arxRejected&&(/提供商名称.*(?:已存在|存在)/.test(detail)||/provider\s+name.*(?:already\s+exists|exists|in\s+use)/i.test(detail));
  const code=providerNameExists?'provider_name_exists':codes.includes('instance_exists')?'instance_exists':codes[0];
  return {status,operation:path.split('?')[0],...(code?{code}:{}),...(Object.keys(fields).length?{fields}:{}),...(responseShape.length?{responseShape:[...new Set(responseShape)].slice(0,40)}:{})};
}
function uniqueAeromaxName(email:string,sessionId:string) {
  const suffix=createHash('sha256').update(`${email}\0${sessionId}`).digest('hex').slice(0,8);
  return `${email.slice(0,55)}-${suffix}`;
}
function diagnosticSummary(diagnostic:UpstreamDiagnostic) {
  const parts:string[]=[];
  if(diagnostic.format)parts.push(`format=${diagnostic.format}`);
  if(diagnostic.contentType)parts.push(`contentType=${diagnostic.contentType}`);
  if(diagnostic.responseBytes!==undefined)parts.push(`bytes=${diagnostic.responseBytes}`);
  if(diagnostic.requestId)parts.push(`requestId=${diagnostic.requestId}`);
  if(diagnostic.code)parts.push(`code=${diagnostic.code}`);
  for(const [path,value] of Object.entries(diagnostic.fields??{})) {
    if(path.toLowerCase().endsWith('.code')||path.toLowerCase()==='code')continue;
    parts.push(`${path}=${String(value)}`);
    if(parts.length>=10)break;
  }
  if(diagnostic.responseShape?.length)parts.push(`shape=${diagnostic.responseShape.join(',')}`);
  return parts.length?`（${parts.join('；')}）`:'';
}
function miniOperation(path:string) {
  const pathname=path.split('?')[0];
  if(pathname==='/api/login')return '登录平台';
  if(pathname==='/api/me')return '验证平台登录会话';
  if(pathname==='/api/meta')return '读取上号配置';
  if(pathname==='/api/accounts/auth-url')return '生成上号授权链接';
  if(pathname==='/api/accounts/exchange')return '提交 OAuth 上号';
  if(pathname==='/api/accounts/import-rt')return 'Refresh token 上号';
  if(pathname==='/api/proxies/import')return '导入固定出口代理';
  if(pathname==='/api/proxies/manage')return '读取平台代理';
  if(pathname==='/api/accounts')return '同步账号与实时用量';
  if(/^\/api\/accounts\/[^/]+\/detail$/.test(pathname))return '读取账号详情';
  if(/^\/api\/accounts\/[^/]+\/status$/.test(pathname))return '修改平台账号状态';
  return '请求平台';
}
function upstreamAmount(value:unknown,message:string) {
  assert(typeof value==='string'||typeof value==='number',message,502);
  let amount:Decimal;
  try { amount=new Decimal(value); } catch { throw new UpstreamError(200,message); }
  assert(amount.isFinite() && amount.gte(0),message,502);
  return amount;
}
function historicalRows(rows:any[]):{externalId:string;rawUsd:string}[] {
  const seen=new Set<string>();
  return rows.map(r=>{
    assert(r && (typeof r.account_id==='string'||typeof r.account_id==='number') && String(r.account_id).trim() && r.cost!==undefined && r.cost!==null,'历史用量字段缺失',502);
    const raw=upstreamAmount(r.cost,'历史用量金额或账号重复，未写入账本'),externalId=String(r.account_id);
    assert(raw.lte(MAX_USD),'历史用量金额或账号重复，未写入账本',502);
    assert(!seen.has(externalId),'历史用量金额或账号重复，未写入账本',502);
    seen.add(externalId);return {externalId,rawUsd:raw.toFixed()};
  });
}

export class ProviderClient {
  private cookies=new Map<string,string>();
  private token='';
  private csrf='';
  public user:any;
  public providerSnapshot:any;
  constructor(public provider:ProviderKey,private credentials:Credentials,private request:typeof fetch=fetch) {}
  private accedra() { return new AccedraClient(this.credentials,this.request); }
  exportSession() { return {cookies:[...this.cookies],token:this.token,csrf:this.csrf,user:this.user}; }
  restoreSession(session:any) { this.cookies=new Map(session.cookies);this.token=session.token;this.csrf=session.csrf;this.user=session.user; }
  async call(path:string,method='GET',body?:unknown) {
    assert(path.startsWith('/api/') && !path.includes('://'),'非法平台接口路径');
    // Mini CC performs token exchange and proxy connectivity checks inline.
    // Keep these single submissions alive long enough for the upstream to finish.
    const timeoutMs=this.provider==='minicc'&&method==='POST'&&[
      '/api/accounts/auth-url','/api/accounts/exchange','/api/accounts/import-rt','/api/proxies/import',
    ].includes(path)?120000:25000;
    for(let attempt=0;;attempt++) {
      try {return await this.callOnce(path,method,body,timeoutMs);}
      catch(error) {
        // Retrying a read can verify a successful write whose detail read failed.
        // Never replay an OAuth code, refresh token or other write automatically.
        if(this.provider!=='minicc'||method!=='GET'||attempt>=1||!(error instanceof UpstreamError)||![0,502,503,504].includes(error.upstreamStatus))throw error;
        await new Promise(resolve=>setTimeout(resolve,300));
      }
    }
  }
  private async callOnce(path:string,method:string,body:unknown,timeoutMs:number) {
    const base=PROVIDERS[this.provider].url;
    const headers:Record<string,string>={'Content-Type':'application/json','Accept':'application/json','Origin':base};
    if(this.cookies.size) headers.Cookie=[...this.cookies].map(([k,v])=>`${k}=${v}`).join('; ');
    if(this.token) headers.Authorization=`Bearer ${this.token}`;
    if(this.csrf && method!=='GET') headers['x-csrf-token']=this.csrf;
    const signal=AbortSignal.timeout(timeoutMs),operation=this.provider==='minicc'?miniOperation(path):null;
    const networkFailure=()=>new UpstreamError(0,[operation,signal.aborted?`平台请求超时（${timeoutMs/1000} 秒）`:'平台连接中断或网络异常',
      ...(['GET','HEAD'].includes(method)?[]:['写入结果可能未知，请先核对上游结果']),
    ].filter(Boolean).join('；'));
    let response:Response;
    try { response=await this.request(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal}); }
    catch { throw networkFailure(); }
    for(const cookie of response.headers.getSetCookie()) {
      const pair=cookie.split(';')[0], index=pair.indexOf('=');
      if(index>0) this.cookies.set(pair.slice(0,index),pair.slice(index+1));
    }
    // Never expose a raw upstream body: account APIs can contain tokens/proxies.
    if(!response.ok) {
      let diagnostic:UpstreamDiagnostic|undefined;
      if(this.provider==='aeromax'&&path==='/api/v1/provider/uploader/authorize') {
        const contentType=response.headers.get('content-type')?.split(';')[0].slice(0,80);
        const rawRequestId=response.headers.get('x-request-id')??response.headers.get('x-correlation-id');
        const requestId=rawRequestId&&/^[A-Za-z0-9._:-]{1,128}$/.test(rawRequestId)?rawRequestId:undefined;
        let text:string|undefined;
        try {text=await response.clone().text();}
        catch {diagnostic={status:response.status,operation:path,format:'unreadable',...(contentType?{contentType}:{}),...(requestId?{requestId}:{})};}
        if(text!==undefined) {
          try {diagnostic={...upstreamDiagnostic(response.status,path,JSON.parse(text)),format:'json',...(contentType?{contentType}:{}),responseBytes:text.length,...(requestId?{requestId}:{})};}
          catch {diagnostic={status:response.status,operation:path,format:'non_json',...(contentType?{contentType}:{}),responseBytes:text.length,...(requestId?{requestId}:{})};}
        }
      }
      throw new UpstreamError(response.status,this.provider==='gatelink'?await gatelinkFailure(response,path):`平台返回 HTTP ${response.status}${response.status===403?'：当前主账号无此权限':''}${diagnostic?diagnosticSummary(diagnostic):''}`,diagnostic?.code,diagnostic);
    }
    if(response.status===204) return {};
    let text:string;
    try {text=await response.text();}
    catch {throw networkFailure();}
    try { return JSON.parse(text) as any; }
    catch { throw new UpstreamError(response.status,'平台响应格式变化，请检查适配器'); }
  }
  async login() {
    if(this.provider==='accedra') {await this.accedra().accounts();this.user={role:'provider',username:'provider-api'};return this.user;}
    if(this.provider==='gatelink') {
      const data=await this.call('/api/auth/login','POST',{username:this.credentials.username,password:this.credentials.password});
      assert(data.user && data.csrfToken,'Gatelink 登录响应缺少会话信息',502);
      this.csrf=data.csrfToken;this.user=data.user;
    } else if(this.provider==='minicc') {
      await this.call('/api/login','POST',this.credentials);
      const data=await this.call('/api/me');
      assert(data.authenticated===true && data.user && this.cookies.size>0,'Mini CC 登录响应缺少有效会话',502);
      this.user=data.user;
    } else if(this.provider==='aeromax') {
      const data=await this.call('/api/v1/auth/login','POST',{email:this.credentials.username,password:this.credentials.password,intendedRole:'provider'});
      assert(data.role==='provider' && data.email && this.cookies.size>0,'E-coding provider 登录响应缺少有效会话',502);
      assert(String(data.email).toLowerCase()===this.credentials.username.toLowerCase(),'E-coding provider 身份与配置账号不一致',502);
      this.user=data;
    } else {
      const data=await this.call('/api/auth/admin-login','POST',{identifier:this.credentials.username,email:this.credentials.username,password:this.credentials.password});
      assert(data.accessToken && data.user,`${PROVIDERS[this.provider].name} 登录响应缺少会话信息`,502);
      this.token=data.accessToken;this.user=data.user;
    }
    return {role:this.user.role,username:this.user.username};
  }
  async listAccounts():Promise<UpstreamAccount[]> {
    if(this.provider==='accedra') {const client=this.accedra(),accounts=await client.liveAccounts();this.providerSnapshot=await client.finance();return accounts;}
    const result:UpstreamAccount[]=[];
    const seen=new Set<string>(),emails=new Set<string>();let declaredTotal:number|undefined;
    for(let page=1;page<=1000;page++) {
      const data=await this.call(this.provider==='aeromax'?'/api/v1/view/provider':this.provider==='gatelink'?`/api/submissions?page=${page}&pageSize=100`:this.provider==='minicc'?`/api/accounts?page=${page}&page_size=100`:`/api/admin/oauth-accounts?page_mode=1&page=${page}&page_size=100`);
      if(this.provider==='aeromax') {
        assert(data.role==='provider' && data.email && String(data.email).toLowerCase()===this.credentials.username.toLowerCase(),'E-coding provider 返回身份不一致',502);
        assert(Array.isArray(data.accounts),'E-coding provider 账号列表格式变化',502);
        const numeric=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER?value:null;
        const minor=(value:unknown)=>{
          const n=typeof value==='number'?value:typeof value==='string'&&/^\d+$/.test(value)?Number(value):NaN;
          return Number.isSafeInteger(n)&&n>=0?n:null;
        };
        // CCMAX keeps one USD ledger. Aeromax reports settlement in CNY minor
        // units, so convert deterministically with the agreed fixed rate and
        // half-up rounding (1 USD = ¥6.7).
        const cnyToUsdMinor=(value:number|null)=>value===null?null:new Decimal(value).div('6.7').toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toNumber();
        const money=(value:any)=>value&&Number.isSafeInteger(value.amountMinor)&&value.amountMinor>=0&&['CNY','USD'].includes(value.currency)?{amountMinor:value.amountMinor,currency:value.currency}:null;
        // Aeromax exposes provider settlement in points/CNY. Keep the raw
        // reference labelled while applying CCMAX's fixed CNY→USD contract
        // conversion to the platform-level settlement values below.
        let settlement:any=null;
        try {
          const raw=await this.call('/api/v1/provider/settlement');
          if(raw&&typeof raw==='object') {
            const pointsToday=numeric(raw.pointsToday);
            // Some Aeromax deployments omit the daily money field. A zero
            // point counter is still an unambiguous zero-dollar day; any
            // non-zero day stays pending until the upstream supplies a CNY
            // amount that can be reconciled.
            const owedTodayMinor=minor(raw.owedTodayMinor)??(pointsToday===0?0:null);
            const paidTodayMinor=minor(raw.paidTodayMinor);
            const balanceTodayMinor=minor(raw.balanceTodayMinor);
            const generatedAt=typeof raw.generatedAt==='string'&&Number.isFinite(Date.parse(raw.generatedAt))?new Date(raw.generatedAt).toISOString():new Date().toISOString();
            settlement={
            currency:'CNY',
            usdCurrency:'USD',
            cnyPerUsd:'6.7',
            today:typeof raw.today==='string'?raw.today:null,
            pointsToday,
            owedTodayMinor,
            paidTodayMinor,
            balanceTodayMinor,
            owedMinor:minor(raw.owedMinor),
            paidMinor:minor(raw.paidMinor),
            balanceMinor:minor(raw.balanceMinor),
            owedTodayUsdMinor:cnyToUsdMinor(owedTodayMinor),
            paidTodayUsdMinor:cnyToUsdMinor(paidTodayMinor),
            balanceTodayUsdMinor:cnyToUsdMinor(balanceTodayMinor),
            owedUsdMinor:cnyToUsdMinor(minor(raw.owedMinor)),
            paidUsdMinor:cnyToUsdMinor(minor(raw.paidMinor)),
            balanceUsdMinor:cnyToUsdMinor(minor(raw.balanceMinor)),
            sourceOk:raw.sourceOk!==false,
            generatedAt,
          };
          }
        } catch { /* Settlement is an optional reference read; inventory sync remains safe. */ }
        this.providerSnapshot={uploader:data.uploader&&typeof data.uploader.state==='string'?{state:data.uploader.state,detail:typeof data.uploader.detail==='string'?data.uploader.detail:null}:null,
          stats:data.stats&&typeof data.stats==='object'?{totalRequests:numeric(data.stats.totalRequests),successfulRequests:numeric(data.stats.successfulRequests),failedRequests:numeric(data.stats.failedRequests),inputTokens:numeric(data.stats.inputTokens),outputTokens:numeric(data.stats.outputTokens),pointsConsumedMinor:numeric(data.stats.pointsConsumedMinor),activeProviders:numeric(data.stats.activeProviders),unhealthyProviders:numeric(data.stats.unhealthyProviders)}:null,
          live:data.live&&typeof data.live==='object'?{accounts:numeric(data.live.accounts),requestsRecent:numeric(data.live.requestsRecent),requestsToday:numeric(data.live.requestsToday),rpm:numeric(data.live.rpm),rpmCapacity:numeric(data.live.rpmCapacity),eligible:numeric(data.live.eligible),healthy:numeric(data.live.healthy),rateLimited:numeric(data.live.rateLimited),reauth:numeric(data.live.reauth),degraded:numeric(data.live.degraded),retired:numeric(data.live.retired),pointsToday:numeric(data.live.pointsToday),pointsTotal:numeric(data.live.pointsTotal)}:null,
          earnings:data.earnings&&typeof data.earnings.tag==='string'?{tag:data.earnings.tag,verifiedPointsMinor:numeric(data.earnings.verifiedPointsMinor),posted:money(data.earnings.posted),paid:money(data.earnings.paid)}:null,
          settlement,
          sourceAt:typeof data.stamp?.asOf==='string'&&Number.isFinite(Date.parse(data.stamp.asOf))?new Date(data.stamp.asOf).toISOString():null};
      }
      const items=this.provider==='aeromax'||this.provider==='gatelink'?data.items??data.accounts:data.accounts;
      assert(Array.isArray(items),'平台账号列表格式变化',502);
      if(this.provider==='minicc') {
        assert(Number.isInteger(data.pages) && data.pages>=1 && Number.isInteger(data.total) && data.total>=0,'平台分页格式变化',502);
      }
      const totalPages=this.provider==='aeromax'?1:this.provider==='gatelink'?data.totalPages:this.provider==='minicc'?data.pages:(data.pagination?.total_pages??data.pagination?.totalPages);
      const total=this.provider==='aeromax'?items.length:this.provider==='gatelink'?data.total:this.provider==='minicc'?data.total:(data.pagination?.total_rows??data.pagination?.total??data.pagination?.total_count);
      if(total!==undefined) {
        assert(Number.isInteger(Number(total))&&Number(total)>=0,'平台分页格式变化',502);
        assert(declaredTotal===undefined||declaredTotal===Number(total),'平台账号数在分页时发生变化，请重新同步',502);
        declaredTotal=Number(total);
      }
      if(totalPages!==undefined)assert(Number.isInteger(Number(totalPages))&&Number(totalPages)>=0,'平台分页格式变化',502);
      for(const a of items) {
        const email=this.provider==='aeromax'?a.service?.ownerEmail:this.provider==='gatelink'?(a.upstreamEmail||a.submittedEmail||a.email):(a.email||a.canonical_identity?.email);
        assert(email,'平台未返回可核实邮箱，本次同步未提交',502);
        const normalized=this.normalize(a);
        assert(!seen.has(normalized.id),'平台分页出现重复账号，本次同步未提交',502);
        assert(!emails.has(normalized.email),'平台同一邮箱对应多个账号，本次同步未提交',502);
        seen.add(normalized.id);emails.add(normalized.email);result.push(normalized);
      }
      if(totalPages!==undefined) {
        if(page>=Number(totalPages)) { assert(declaredTotal===undefined||result.length===declaredTotal,'平台账号结果不完整，本次同步未提交',502);return result; }
        assert(items.length>0,'平台分页提前结束',502);continue;
      }
      if(total!==undefined) { if(result.length>=Number(total)){assert(result.length===Number(total),'平台账号结果不完整，本次同步未提交',502);return result;}assert(items.length>0,'平台分页提前结束',502);continue; }
      if(items.length<100) return result;
    }
    throw new UpstreamError(0,'平台账号超过分页上限，本次同步未提交');
  }
  // End-of-day capture commits each account as it arrives. Inventory sync still
  // requires a complete, valid list; one malformed counter must not prevent
  // collecting every other account during the limited closing window.
  async captureSnapshots(consume:(account:UpstreamAccount)=>Promise<void>) {
    const seen=new Set<string>();
    let accounts=0,issueCount=0,observed=0,declaredTotal:number|undefined;
    const readPage=async(path:string)=>{
      for(let attempt=0;;attempt++) {
        try {return await this.call(path);}
        catch(error) {
          if(attempt>=2 || !(error instanceof UpstreamError) || ![0,429].includes(error.upstreamStatus)&&error.upstreamStatus<500)throw error;
          await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
        }
      }
    };
    for(let page=1;page<=1000;page++) {
      const data=await readPage(this.provider==='aeromax'?'/api/v1/view/provider':this.provider==='gatelink'?`/api/submissions?page=${page}&pageSize=100`:this.provider==='minicc'?`/api/accounts?page=${page}&page_size=100`:`/api/admin/oauth-accounts?page_mode=1&page=${page}&page_size=100`);
      if(this.provider==='aeromax')assert(data.role==='provider'&&data.email&&String(data.email).toLowerCase()===this.credentials.username.toLowerCase(),'E-coding provider 返回身份不一致',502);
      const items=this.provider==='aeromax'||this.provider==='gatelink'?data.items??data.accounts:data.accounts;
      assert(Array.isArray(items),'平台账号列表格式变化',502);
      const pages=this.provider==='aeromax'?1:this.provider==='gatelink'?data.totalPages:this.provider==='minicc'?data.pages:(data.pagination?.total_pages??data.pagination?.totalPages);
      const total=this.provider==='aeromax'?items.length:this.provider==='gatelink'?data.total:this.provider==='minicc'?data.total:(data.pagination?.total_rows??data.pagination?.total??data.pagination?.total_count);
      if(total!==undefined) {
        assert(Number.isInteger(Number(total))&&Number(total)>=0 && (declaredTotal===undefined||declaredTotal===Number(total)),'平台账号数在分页时发生变化，请重新同步',502);
        declaredTotal=Number(total);
      }
      if(pages!==undefined)assert(Number.isInteger(Number(pages))&&Number(pages)>=0,'平台分页格式变化',502);
      observed+=items.length;
      // Small batches limit database pressure while independent platforms have
      // separate workers. Failed accounts are revisited on the next pass.
      for(let offset=0;offset<items.length;offset+=4)await Promise.all(items.slice(offset,offset+4).map(async(a:any)=>{
        try {
          const remote=this.normalize(a);
          assert(!seen.has(remote.id),'平台分页出现重复账号，本次同步未提交',502);seen.add(remote.id);
          assert(remote.dailyUsd!==null&&remote.telemetry?.sourceAt,'平台未返回有效的当日用量，保留上次成功数据',502);
          try {await consume(remote);}
          catch(error) {if(error instanceof AppError)throw error;await consume(remote);}
          accounts++;
        } catch {issueCount++;}
      }));
      if(pages!==undefined?page>=Number(pages):declaredTotal!==undefined?observed>=declaredTotal:items.length<100) {
        assert(declaredTotal===undefined||observed===declaredTotal,'平台账号结果不完整，本次同步未提交',502);
        return {accounts,issueCount};
      }
      assert(items.length>0,'平台分页提前结束',502);
    }
    throw new UpstreamError(0,'平台账号超过分页上限，本次同步未提交');
  }
  normalize(a:any):UpstreamAccount {
    if(this.provider==='accedra')return this.accedra().normalize(a);
    if(this.provider==='aeromax') {
      const email=typeof a.service?.ownerEmail==='string'?a.service.ownerEmail.trim().toLowerCase():'';
      assert(a.providerId && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'E-coding 未返回可核实的账号归属邮箱',502);
      const service=a.service??{},activity=service.activity??{},windows=activity.windows??{};
      const requests=service.requests??null,refused=service.refusedRequests??null;
      const money=(value:any)=>value&&Number.isSafeInteger(value.amountMinor)&&value.amountMinor>=0&&['CNY','USD'].includes(value.currency)?{amountMinor:value.amountMinor,currency:value.currency}:null;
      const financial=a.money&&['unpriced','provider_payable','agent_payable'].includes(a.money.tag)?{tag:a.money.tag,verifiedPointsMinor:typeof a.money.verifiedPointsMinor==='number'&&Number.isSafeInteger(a.money.verifiedPointsMinor)&&a.money.verifiedPointsMinor>=0?a.money.verifiedPointsMinor:0,posted:money(a.money.posted),paid:money(a.money.paid)}:undefined;
      const telemetry=normalizeTelemetry(this.provider,{sourceAt:a.stamp?.asOf,aeromaxFinancial:financial,stats:{daily_req:activity.requestsToday??null,daily_tok:(service.inputTokens??0)+(service.outputTokens??0),rpm:service.rpm??null,active_sessions:null,concurrent:null},max_rpm:service.rpmLimit??null,req_24h:requests,ok_24h:requests!==null&&refused!==null?Math.max(0,requests-refused):null,limited_24h:refused,usage_windows:{req_5h:windows.h5?.requests??null,req_7d:windows.d7?.requests??null},claude_utilization:{five_hour:{utilization:windows.h5?.utilization??null,resets_at:windows.h5?.windowEnd??null},seven_day:{utilization:windows.d7?.utilization??null,resets_at:windows.d7?.windowEnd??null}}});
      const status={healthy:'active',degraded:'degraded',cooldown:'cooldown',expired:'disabled',rejected:'disabled',retired:'disabled'}[a.health as string]??'unknown';
      // Aeromax exposes points and settlement currencies, but the account view
      // does not identify a verified daily amount. Keep account billing
      // pending until a reconciliable per-account CNY amount is available;
      // platform-level settlement is converted separately at the fixed rate.
      return {id:String(a.providerId),email,name:email,status,dailyUsd:null,cost7d:null,cost30d:null,utilization:windows.d7?.utilization??null,telemetry};
    }
    if(this.provider==='minicc') {
      const email=a.canonical_identity?.email||a.email,daily=a.daily_cost;
      assert(a.upstream_id && email,'平台未返回账号 ID / 邮箱',502);
      upstreamAmount(daily,'平台未返回有效的当日用量，保留上次成功数据');
      return {id:String(a.upstream_id),email:String(email).toLowerCase(),name:a.name||email,status:a.status||'unknown',dailyUsd:String(daily),cost7d:a.cost_7d??null,cost30d:a.cost_30d??null,utilization:null,proxyExternalId:a.outbound_proxy_id?String(a.outbound_proxy_id):null,telemetry:normalizeTelemetry(this.provider,a)};
    }
    const gate=this.provider==='gatelink';
    const snapshot=gate?a.upstreamSnapshot:a;
    const email=(gate?(a.upstreamEmail||a.submittedEmail||a.email):(a.email||a.canonical_identity?.email))?.toLowerCase();
    assert(a.id && email,'平台未返回账号 ID / 邮箱',502);
    const daily=gate?a.upstreamDailyCost:a.stats?.daily_cost;
    // New Gatelink submissions can have an identity before any usage snapshot.
    // Keep that inventory row, with no dollar value to ingest. Malformed or
    // negative amounts still fail validation instead of silently disappearing.
    if(!gate || daily!==null&&daily!==undefined)upstreamAmount(daily,'平台未返回有效的当日用量，保留上次成功数据');
    return {id:String(a.id),email,name:a.name||email,status:gate?(a.upstreamStatus||a.status||'unknown'):(a.status||'unknown'),
      dailyUsd:daily===null||daily===undefined?null:String(daily),
      cost7d:(gate?a.upstreamCost7d:a.usage_windows?.cost_7d)??snapshot?.usage_windows?.cost_7d??null,
      cost30d:snapshot?.usage_windows?.cost_30d??null,
      utilization:(gate?a.upstreamUtilization5h:a.stats?.claude_utilization?.five_hour?.utilization)??null,
      telemetry:normalizeTelemetry(this.provider,a),
      ...(!gate?{proxyExternalId:a.outbound_proxy_id?String(a.outbound_proxy_id):null}:{})};
  }
  async enrichTelemetry(accounts:UpstreamAccount[]) {
    if(this.provider==='gatelink'||this.provider==='aeromax'||this.provider==='accedra')return;
    // Optional operational reads are isolated per account. An unavailable
    // detail endpoint must not prevent inventory or financial synchronization.
    let index=0;
    const deadline=Date.now()+35000;
    // Rotate the starting account so a large pool still receives detail reads
    // over successive syncs when the optional read budget is exhausted.
    const offset=accounts.length?Math.floor(Date.now()/300000)%accounts.length:0;
    await Promise.all(Array.from({length:Math.min(4,accounts.length)},async()=>{
      while(index<accounts.length&&Date.now()<deadline) {
        const remote=accounts[(offset+index++)%accounts.length];
        try {
          const path=this.provider==='minicc'?`/api/accounts/${encodeURIComponent(remote.id)}/detail`:`/api/admin/oauth-accounts/${encodeURIComponent(remote.id)}`;
          const d=await this.call(path),a=d.account;
          assert(a&&String(a.upstream_id??a.id)===remote.id,'平台遥测账号身份不一致',502);
          const email=a.email??a.canonical_identity?.email;
          assert(!email||String(email).toLowerCase()===remote.email,'平台遥测账号邮箱不一致',502);
          const health=remote.telemetry?.health;
          const detailed=normalizeTelemetry(this.provider,{req_24h:health?.requests24h,ok_24h:health?.successful24h,limited_24h:health?.limited24h},d);
          const base=remote.telemetry;
          if(base) {
            for(const group of ['activity','limits','quota'] as const)for(const field of Object.keys(base[group])) {
              const values=detailed[group] as Record<string,any>;
              if(values[field]===null)values[field]=(base[group] as Record<string,any>)[field];
            }
            for(const p of telemetryPeriods)for(const field of ['requests','tokens','billedUsd','officialUsd','cacheCreditUsd'] as const) {
              if(detailed.periods[p][field]===null)(detailed.periods[p] as any)[field]=base.periods[p][field];
            }
          }
          remote.telemetry=detailed;
        }catch{/* Keep the safe account-list snapshot and its unavailable marker. */}
      }
    }));
    if(!usesAdminOAuth(this.provider))return;
    for(let start=0;start<accounts.length&&Date.now()<deadline;start+=50) {
      const batch=accounts.slice(start,start+50);
      try {
        const d=await this.call(`/api/admin/oauth-accounts/model-usage?ids=${encodeURIComponent(batch.map(a=>a.id).join(','))}`);
        const generated=typeof d.generated_at==='string'?Date.parse(d.generated_at):NaN;
        // Keep the source timestamp even when the upstream model cache is
        // delayed. Current totals exclude it; the UI can show a dated reference.
        if(!Number.isFinite(generated)||generated>Date.now()+60000)continue;
        for(const a of batch)if(a.telemetry&&d.accounts?.[a.id])for(const p of telemetryPeriods) {
          a.telemetry.modelsAt=new Date(generated).toISOString();
          a.telemetry.periods[p].models=normalizeModelAmounts(d.accounts[a.id][{today:'today','5h':'five_hour','7d':'seven_day','30d':'thirty_day'}[p]]);
        }
      }catch{/* Model breakdown is optional; never use the shared summary. */}
    }
  }
  async options() {
    if(this.provider==='accedra')return {requireProxy:true,configurationLocked:true,accountTypes:[],proxyMode:'fixed'};
    if(this.provider==='gatelink') {
      const settings=await this.call('/api/settings/submission');
      return {requireProxy:true,accountTypes:['speed','stable','team'],settings:{proxyMode:settings.proxyMode}};
    }
    if(this.provider==='minicc') {
      const {policy,template,groups}=await this.miniDefaults();
      return {requireProxy:true,accountTypes:[],configurationLocked:true,proxyMode:'manual',
        policies:[{id:policy.id,name:policy.name}],templates:[{id:template.id,name:template.name}],
        groups:groups.map((g:any)=>({id:g.id,name:g.name})),
        defaults:{policyTemplateId:policy.id,ccTemplateId:template.id,groupIds:groups.map((g:any)=>String(g.id))}};
    }
    if(this.provider==='aeromax') {
      return {requireProxy:true,accountTypes:[],configurationLocked:true,proxyMode:'manual',uploader:true};
    }
    const [groups,policies,templates]=await Promise.all([
      this.call('/api/admin/groups'),this.call('/api/admin/account-policy-templates'),this.call('/api/admin/cc-disguise-templates'),
    ]);
    const clean=(data:any,key:string)=>{
      const list=Array.isArray(data)?data:(data.items??data[key]??[]);
      return list.map((v:any)=>({id:v.id,name:v.name}));
    };
    return {requireProxy:true,accountTypes:['max','pro','team'],groups:clean(groups,'groups'),policies:clean(policies,'templates'),templates:clean(templates,'templates')};
  }
  private aiConfig(options:OAuthOptions) {
    this.requireProxy(options);
    return {provider:'anthropic',oauth_flow:'login',name:options.email,inference_backend:'native',
      ...(options.accountType?{account_type:options.accountType}:{}),
      outbound_proxy_mode:'manual',outbound_proxy_id:options.proxyExternalId,
      ...(options.policyTemplateId?{policy_template_id:options.policyTemplateId}:{}),
      ...(options.groupIds?.length?{group_ids:options.groupIds}:{}),
      ...(options.ccTemplateId?{cc_template_id:options.ccTemplateId}:{}),
    };
  }
  private requireProxy(options:OAuthOptions) {
    assert(options.proxy,'每个账号必须绑定专属出口代理');parseProxy(options.proxy);
    if(this.provider!=='gatelink'&&this.provider!=='aeromax')assert(options.proxyExternalId,'平台代理映射尚未确认，已阻止上号');
  }
  private proxyMatches(record:any,url:string,full:boolean) {
    const expected=parseProxy(url),raw=record.url??record.proxy_url??record.uri;
    if(typeof raw==='string') {try{return parseProxy(raw).url===expected.url;}catch{return false;}}
    const scheme=String(record.scheme||'').replace(/:$/,'').replace(/^socks5$/,'socks5h');
    if(scheme!==expected.scheme||String(record.host).toLowerCase()!==expected.host||Number(record.port)!==expected.port)return false;
    if(record.username!==undefined && String(record.username??'')!==expected.username)return false;
    if(record.password!==undefined && String(record.password??'')!==expected.password)return false;
    return !full||(Object.hasOwn(record,'username')&&Object.hasOwn(record,'password'));
  }
  private usableProxy(record:any,existing=false) {
    const full=record?.at_bound_account_limit===true;
    assert(record && record.status!=='disabled' && !record.missing && (record.selectable!==false||(existing&&full)) && (existing||!full),'平台代理已停用、失效或达到绑定上限，已阻止上号',502);
    const id=this.provider==='minicc'?(record.upstream_id??record.id):record.id;
    assert(typeof id==='string'&&id.length>0,'平台未返回有效的代理 ID',502);return id;
  }
  private async remoteProxies() {
    const result:any[]=[];
    for(let page=1;page<=1000;page++) {
      const path=this.provider==='minicc'?`/api/proxies/manage?page=${page}`:`/api/admin/outbound-proxies?page=${page}&limit=100`;
      const data=await this.call(path);
      assert(Array.isArray(data.proxies) && Number.isInteger(data.total) && data.total>=0,'平台代理列表格式变化',502);
      result.push(...data.proxies);
      if(result.length>=data.total) {
        const ids=result.map(p=>String(this.provider==='minicc'?(p.upstream_id??p.id):p.id));
        assert(result.length===data.total && new Set(ids).size===ids.length,'平台代理分页结果不完整或重复',502);return result;
      }
      assert(data.proxies.length>0,'平台代理分页不完整',502);
    }
    throw new UpstreamError(0,'平台代理分页超过上限');
  }
  async verifyProxyMapping(url:string,externalId:string) {
    assert(this.provider!=='accedra','Platform X (✨ Anti-Ban) 不支持此操作，请联系管理员核对');
    const records=await this.remoteProxies();
    const record=records.find(p=>String(this.provider==='minicc'?(p.upstream_id??p.id):p.id)===externalId);
    assert(record && this.proxyMatches(record,url,false),'上游代理地址与账号固定代理不符或不可核实，已阻止上号',502);
    // Capacity limits apply to new assignments, not identity checks on a
    // proxy already occupied by this account. Upstream writes enforce capacity.
    return this.usableProxy(record,true);
  }
  async provisionProxy(url:string,existingExternalId?:string) {
    assert(this.provider!=='accedra','Platform X (✨ Anti-Ban) 不支持此操作，请联系管理员核对');
    const normalized=parseProxy(url).url;
    if(this.provider==='gatelink'||this.provider==='aeromax')return null;
    const before=await this.remoteProxies();
    const exact=before.filter(p=>this.proxyMatches(p,normalized,true));
    assert(exact.length<=1,'上游出现重复代理，请管理员核对平台映射',502);
    if(exact.length===1) {
      let existing=false;
      if(existingExternalId) {
        // Reuse capacity only when this exact account already holds the proxy.
        const path=this.provider==='minicc'?`/api/accounts/${encodeURIComponent(existingExternalId)}/detail`:`/api/admin/oauth-accounts/${encodeURIComponent(existingExternalId)}`;
        const {account}=await this.call(path);
        const proxyId=this.provider==='minicc'?(exact[0].upstream_id??exact[0].id):exact[0].id;
        existing=!!account&&String(account.outbound_proxy_id||'')===String(proxyId);
      }
      return this.usableProxy(exact[0],existing);
    }
    const ids=new Set(before.map(p=>String(this.provider==='minicc'?(p.upstream_id??p.id):p.id)));
    const imported=await this.call(this.provider==='minicc'?'/api/proxies/import':'/api/admin/outbound-proxies/import','POST',{text:normalized});
    assert(!imported.failed && !(imported.errors?.length),'上游代理导入或连通测试失败，请在平台核对代理后重试',502);
    const after=await this.remoteProxies();
    const matches=after.filter(p=>this.proxyMatches(p,normalized,true));
    if(matches.length===1)return this.usableProxy(matches[0]);
    const fresh=after.filter(p=>!ids.has(String(this.provider==='minicc'?(p.upstream_id??p.id):p.id)));
    // A successful single import plus exactly one new matching record proves
    // provenance even when the upstream masks credentials in its read API.
    assert(Number(imported.imported)===1 && fresh.length===1 && this.proxyMatches(fresh[0],normalized,false),'上游代理已存在或导入结果不明确，请管理员核实平台映射后继续',502);
    return this.usableProxy(fresh[0]);
  }
  private async miniDefaults() {
    const meta=await this.call('/api/meta');
    const policy=meta.policyTemplates?.find((v:any)=>v.is_default===true),template=meta.ccTemplates?.find((v:any)=>v.is_default===true);
    assert(policy?.id && template?.id,'新平台缺少默认策略或 CC 模板，暂时无法上号',502);
    const groups=(meta.groups||[]).filter((v:any)=>policy.group_ids?.includes(v.id));
    assert(groups.length>0,'新平台默认策略没有可用分组，暂时无法上号',502);
    return {policy,template,groups};
  }
  private async miniConfig(options:OAuthOptions) {
    this.requireProxy(options);
    const {policy,template,groups}=await this.miniDefaults();
    const limits:Record<string,number>={};
    for(const field of ['max_rpm','max_tpm','max_concurrent','max_sessions']) {
      assert(typeof policy.policy?.[field]==='number' && Number.isFinite(policy.policy[field]) && policy.policy[field]>=0,'新平台默认策略限额格式变化',502);
      limits[field]=policy.policy[field];
    }
    // This upstream locks new accounts to its current default templates.
    return {name:options.email,inference_backend:'native',outbound_proxy_mode:'manual',outbound_proxy_id:options.proxyExternalId,
      overwrite_existing:!!options.existingExternalId,...(options.existingExternalId?{replace_outbound_proxy:true}:{}),cc_template_id:template.id,policy_template_id:policy.id,group_ids:groups.map((g:any)=>g.id),...limits};
  }
  private gatelinkConfig(options:OAuthOptions) {
    this.requireProxy(options);
    const accountType=options.accountType||'speed';
    assert(['speed','stable','team'].includes(accountType),'Gatelink 账号类型仅支持 speed、stable 或 team');
    // Gatelink documents SOCKS5 URLs. Keep the canonical account identity and
    // encrypted snapshot unchanged; serialize its SOCKS proxy in that API format.
    const proxy=parseProxy(options.proxy!).url.replace(/^socks5h:/,'socks5:');
    return {accountType,oauthFlow:'login',loginMethod:options.email,proxy};
  }
  async startOAuth(options:OAuthOptions):Promise<AccedraAuthorization> {
    if(this.provider==='accedra')return this.accedra().start(options);
    this.requireProxy(options);
    if(this.provider==='aeromax') {
      const data=await this.call('/api/v1/provider/uploader/sessions','POST',{httpProxy:options.proxy,acceptDirectRisk:false});
      assert(data.id&&data.authorizationUrl,'E-coding 未返回上号授权链接',502);
      const expiresAt=Number(data.expiresAt),expiresIn=Number.isFinite(expiresAt)?Math.max(60,Math.min(1800,(expiresAt-Date.now())/1000)):600;
      return {url:data.authorizationUrl,secret:{options,sessionId:data.id,pendingState:null},expiresIn};
    }
    if(this.provider==='gatelink') {
      const data=await this.call('/api/oauth-submissions/authorize','POST',{...this.gatelinkConfig(options),overwriteExisting:!!options.existingExternalId});
      assert(data.authorizationUrl,'平台未返回授权地址',502);
      const pendingState=authorizationState(data.authorizationUrl);
      assert(pendingState,'平台授权地址缺少可核验的 state',502);
      return {url:data.authorizationUrl,secret:{options,pendingState},expiresIn:Math.min(data.expiresInSeconds||600,1800)};
    }
    if(this.provider==='minicc') {
      await this.miniDefaults();
      const data=await this.call('/api/accounts/auth-url','POST',{provider:'anthropic',oauth_flow:'login',name:options.email,inference_backend:'native',outbound_proxy_mode:'manual',outbound_proxy_id:options.proxyExternalId,overwrite_existing:!!options.existingExternalId,...(options.existingExternalId?{replace_outbound_proxy:true}:{})});
      assert(data.url && data.state,'平台未返回 OAuth URL / state',502);
      return {url:data.url,secret:{options,pendingState:data.state},expiresIn:600};
    }
    const data=options.existingExternalId
      ?await this.call(`/api/admin/oauth-accounts/${encodeURIComponent(options.existingExternalId)}/reauthorize`,'POST',{oauth_flow:'login'})
      :await this.call('/api/admin/oauth-accounts/auth-url','POST',this.aiConfig(options));
    assert(data.url && data.state,'平台未返回 OAuth URL / state',502);
    return {url:data.url,secret:{options,pendingState:data.state},expiresIn:600};
  }
  async exchangeOAuth(secret:any,callback:string,allowInstanceReplacement=false):Promise<UpstreamAccount> {
    if(this.provider==='accedra')return this.accedra().complete(secret,callback);
    this.requireProxy(secret.options);
    if(this.provider==='aeromax') {
      const stageFailure=(error:unknown,stage:string)=>error instanceof UpstreamError
        ?new UpstreamError(error.upstreamStatus,`${stage}：${error.message}`,error.upstreamCode,error.diagnostic?{...error.diagnostic,stage}:undefined)
        :error;
      const input=callback.trim();let code=input;
      if(/^https?:\/\//i.test(input)) {
        const url=new URL(input);const values=url.searchParams.getAll('code');assert(values.length===1&&values[0],'请粘贴 E-coding 返回的授权码或完整回调地址');code=values[0]!;
      }
      assert(code.length>0&&code.length<=4096&&!/[\s#]/.test(code),'请粘贴有效的 E-coding 授权码');
      let payload={sessionId:secret.sessionId,code,name:secret.options.email,note:secret.options.note};
      let data:any;
      try { data=await this.call('/api/v1/provider/uploader/authorize','POST',payload); }
      catch(error) {
        let currentError=error;
        // A confirmed name collision means Aeromax rejected the request before
        // accepting the OAuth code. Retry once with a stable per-session name;
        // never replay other ARX rejections or uncertain network failures.
        if(currentError instanceof UpstreamError&&currentError.upstreamStatus===409&&currentError.upstreamCode==='provider_name_exists') {
          payload={...payload,name:uniqueAeromaxName(secret.options.email,String(secret.sessionId))};
          try {data=await this.call('/api/v1/provider/uploader/authorize','POST',payload);}
          catch(nameRetryError) {currentError=nameRetryError;}
        }
        // Upstream offers replacement as a separate, explicit user action;
        // an existing instance can still be running and must not be assumed stale.
        if(data===undefined&&(!(currentError instanceof UpstreamError)||currentError.upstreamStatus!==409||currentError.upstreamCode!=='instance_exists'))throw stageFailure(currentError,'平台 E 初次上号请求失败');
        if(data===undefined) {
          if(!allowInstanceReplacement)throw new AppError(409,
            '平台 E 已有同名实例，请核对后重新生成授权链接，并勾选允许替换已有实例','UPSTREAM_INSTANCE_EXISTS');
          // Aeromax can keep the old worker in its stopping phase briefly after
          // accepting replacement. A documented instance_exists response is a
          // definitive rejection, so the OAuth code was not consumed and the
          // same approved replacement can be retried safely. Never retry a
          // network failure or an unknown conflict because that write may have
          // succeeded upstream.
          let replacementRenamed=payload.name!==secret.options.email,confirmedInstanceConflicts=0;
          for(let replacementAttempt=0;replacementAttempt<4;replacementAttempt++) {
            if(replacementAttempt>0)await new Promise(resolve=>setTimeout(resolve,750*replacementAttempt));
            try {
              data=await this.call('/api/v1/provider/uploader/authorize','POST',{...payload,force:true});
              break;
            } catch(replacementError) {
              const confirmedNameCollision=replacementError instanceof UpstreamError
                && replacementError.upstreamStatus===409
                && replacementError.upstreamCode==='provider_name_exists';
              if(confirmedNameCollision&&!replacementRenamed) {
                payload={...payload,name:uniqueAeromaxName(secret.options.email,String(secret.sessionId))};
                replacementRenamed=true;continue;
              }
              const confirmedConflict=replacementError instanceof UpstreamError
                && replacementError.upstreamStatus===409
                && replacementError.upstreamCode==='instance_exists';
              if(confirmedConflict&&++confirmedInstanceConflicts<3)continue;
              throw stageFailure(replacementError,'平台 E 替换已有实例失败');
            }
          }
        }
      }
      assert(data.id,'E-coding 未返回上号任务',502);
      let task=data;
      for(let n=0;n<30&&!['succeeded','failed','cancelled'].includes(task.status);n++) {
        await new Promise(resolve=>setTimeout(resolve,1000));
        try {task=await this.call(`/api/v1/provider/uploader/tasks/${encodeURIComponent(data.id)}`);}
        catch(error) {throw stageFailure(error,'平台 E 上号任务状态检查失败');}
      }
      if(task.status!=='succeeded'||!task.providerId) {
        const diagnostic={...upstreamDiagnostic(200,'/api/v1/provider/uploader/tasks',task),stage:'uploader_task'};
        const taskId=safeDiagnosticString(String(data.id));
        const pending=!['succeeded','failed','cancelled'].includes(task.status);
        throw new UpstreamError(200,`平台 E ${pending?'任务仍未完成，结果待核对，请勿重复授权':'上号任务未成功完成'}；taskId=${taskId}${diagnosticSummary(diagnostic)}`,diagnostic.code,diagnostic);
      }
      return this.submittedIdentity({id:task.providerId},undefined,secret.options.email);
    }
    const code=statefulOAuthCallback(callback,secret.pendingState);
    if(this.provider==='gatelink') {
      const data=await this.call('/api/oauth-submissions/exchange','POST',{...this.gatelinkConfig(secret.options),callback:callback.trim()});
      assert(data.item,'平台未返回已提交账号',502);
      assert(data.item.upstreamEmail,'平台未返回可核实的真实邮箱，请由管理员同步核对归属',502);
      return this.normalize(data.item);
    }
    if(this.provider==='minicc') {
      const data=await this.call('/api/accounts/exchange','POST',{...await this.miniConfig(secret.options),code,pending_state:secret.pendingState});
      assert(data.id,'平台未返回账号 ID',502);
      return this.submittedIdentity(data,secret.options.proxyExternalId);
    }
    const target=secret.options.existingExternalId;
    const data=target
      ?await this.call(`/api/admin/oauth-accounts/${encodeURIComponent(target)}/reauthorize/exchange`,'POST',{code,pending_state:secret.pendingState})
      :await this.call('/api/admin/oauth-accounts/exchange','POST',{...this.aiConfig(secret.options),code,pending_state:secret.pendingState});
    if(target) {
      const returnedId=data.id??data.account?.id;
      assert(returnedId===undefined||String(returnedId)===target,'重新授权返回的账号 ID 不一致，请同步核对；未替换原绑定',502);
      return this.submittedIdentity({id:target},secret.options.proxyExternalId);
    }
    assert(data.id,'平台未返回账号 ID',502);
    return this.submittedIdentity(data,secret.options.proxyExternalId);
  }
  async importRefreshToken(options:OAuthOptions,refreshToken:string) {
    assert(PROVIDERS[this.provider].refreshTokenImport,'此平台不支持 refresh token 导入，需单独完成 OAuth 授权');
    if(this.provider==='minicc') {
      const data=await this.call('/api/accounts/import-rt','POST',{...await this.miniConfig(options),refresh_token:refreshToken});
      assert(data.id,'平台未返回账号 ID',502);
      return this.submittedIdentity(data,options.proxyExternalId);
    }
    const data=await this.call('/api/admin/oauth-accounts/import-rt','POST',{...this.aiConfig(options),refresh_token:refreshToken});
    assert(data.id,'平台未返回账号 ID',502);
    return this.submittedIdentity(data,options.proxyExternalId);
  }
  private async submittedIdentity(data:any,expectedProxyId:string|undefined,expectedEmail?:string):Promise<UpstreamAccount> {
    if(this.provider==='aeromax') {
      const view=await this.call('/api/v1/view/provider');
      assert(view.role==='provider'&&view.email&&String(view.email).toLowerCase()===this.credentials.username.toLowerCase(),'E-coding provider 返回身份不一致',502);
      assert(Array.isArray(view.accounts),'E-coding provider 账号列表格式变化',502);
      const matches=view.accounts.filter((account:any)=>String(account?.providerId)===String(data.id));
      assert(matches.length===1,'E-coding 未返回唯一且可核实的账号 ID，请同步后由管理员核对',502);
      const remote=this.normalize(matches[0]);
      assert(!expectedEmail||remote.email===expectedEmail.trim().toLowerCase(),'E-coding 返回的账号归属邮箱与本次授权不一致，请管理员核对',502);
      assert(!expectedProxyId||remote.proxyExternalId===expectedProxyId,'E-coding 未返回可核实的账号归属，请同步后由管理员核对',502);
      return remote;
    }
    // The label supplied by the user is never proof of ownership. If the write
    // response omits the canonical email, verify it against the upstream list.
    const path=this.provider==='minicc'?`/api/accounts/${encodeURIComponent(data.id)}/detail`:`/api/admin/oauth-accounts/${encodeURIComponent(data.id)}`;
    const {account}=await this.call(path);
    assert(account,'平台未返回可验证的真实邮箱，请同步后由管理员核对归属',502);
    assert(String(account.outbound_proxy_id||'')===expectedProxyId,'上游实际绑定代理与账号固定代理不一致，请管理员核对',502);
    const email=account.canonical_identity?.email||account.email;
    if(!email) {
      const remote=(await this.listAccounts()).find(a=>a.id===String(data.id));
      assert(remote && remote.proxyExternalId===expectedProxyId,'平台未返回可验证的真实邮箱或一致的代理，请同步后由管理员核对归属',502);return remote;
    }
    return {id:String(data.id),email:String(email).toLowerCase(),name:String(email),status:account.status||'active',dailyUsd:'0',cost7d:null,cost30d:null,utilization:null,proxyExternalId:expectedProxyId};
  }
  async verifySubmissionTarget(externalId:string,email:string) {
    if(this.provider==='accedra') {await this.accedra().identity(externalId,email);return;}
    if(this.provider==='aeromax') {
      const remote=(await this.listAccounts()).find(account=>account.id===externalId);
      assert(remote?.email===email.toLowerCase(),'E-coding 原账号不存在或邮箱不一致，请管理员同步核对',409);return;
    }
    if(this.provider==='gatelink') {
      const remote=(await this.listAccounts()).find(account=>account.id===externalId);
      assert(remote?.email===email,'上游原账号不存在或邮箱不一致，请管理员同步核对；未覆盖其他账号',409);
      return;
    }
    const path=this.provider==='minicc'?`/api/accounts/${encodeURIComponent(externalId)}/detail`:`/api/admin/oauth-accounts/${encodeURIComponent(externalId)}`;
    const {account}=await this.call(path);
    const identity=account?.canonical_identity?.email||account?.email;
    assert(identity&&String(identity).toLowerCase()===email,'上游原账号不存在或邮箱不一致，请管理员同步核对；未覆盖其他账号',409);
  }
  async setEnabled(externalId:string,enabled:boolean) {
    assert(this.provider!=='accedra','Platform X (✨ Anti-Ban) 不支持此操作，请联系管理员核对');
    if(this.provider==='aeromax')return this.call(`/api/v1/provider/accounts/${encodeURIComponent(externalId)}/actions`,'POST',{action:enabled?'enable':'disable'});
    if(this.provider==='gatelink') {
      assert(this.user?.role==='admin','Gatelink 启停账号需要上游管理员权限，当前主账号无此权限');
      return this.call(`/api/admin/accounts/${encodeURIComponent(externalId)}/enabled`,'POST',{enabled});
    }
    if(this.provider==='minicc') return this.call(`/api/accounts/${encodeURIComponent(externalId)}/status`,'POST',{status:enabled?'active':'disabled'});
    return this.call(`/api/admin/oauth-accounts/${encodeURIComponent(externalId)}`,'PATCH',{status:enabled?'active':'disabled'});
  }
  async verifyAccountStatus(externalId:string,email:string,enabled:boolean) {
    let status:string|undefined,identity:string|undefined;
    if(this.provider==='aeromax') {
      const remote=(await this.listAccounts()).find(account=>account.id===externalId);identity=remote?.email;status=remote?.status;
      const ok=enabled?status==='active'||status==='degraded'||status==='cooldown':status==='disabled';
      assert(identity===email.toLowerCase()&&ok,'E-coding 尚未确认目标账号状态，请同步核对；本地未提前修改状态',502);return;
    } else if(this.provider==='gatelink') {
      const remote=(await this.listAccounts()).find(account=>account.id===externalId);
      status=remote?.status;identity=remote?.email;
    } else {
      const path=this.provider==='minicc'?`/api/accounts/${encodeURIComponent(externalId)}/detail`:`/api/admin/oauth-accounts/${encodeURIComponent(externalId)}`;
      const {account}=await this.call(path);
      identity=account?.canonical_identity?.email||account?.email;status=account?.status;
    }
    assert(identity?.toLowerCase()===email&&status===(enabled?'active':'disabled'),'上游尚未确认目标账号状态，请同步核对；本地未提前修改状态',502);
  }
  async setAccountProxy(externalId:string,options:OAuthOptions) {
    assert(this.provider!=='accedra','Platform X (✨ Anti-Ban) 不支持此操作，请联系管理员核对');
    this.requireProxy(options);
    if(this.provider==='aeromax') {
      await this.call(`/api/v1/provider/accounts/${encodeURIComponent(externalId)}/proxy`,'PUT',{httpProxy:options.proxy});
      const result=await this.call(`/api/v1/provider/accounts/${encodeURIComponent(externalId)}/proxy`);
      assert(result?.proxy && this.proxyMatches({url:result.proxy},options.proxy!,false),'E-coding 实际代理未匹配，请核对后重试',502);return;
    }
    assert(this.provider!=='gatelink','Gatelink 当前权限不支持修改已有账号代理，请在上游修改后由管理员核实');
    if(this.provider==='minicc')await this.call(`/api/accounts/${encodeURIComponent(externalId)}/policy`,'POST',{outbound_proxy_id:options.proxyExternalId});
    else await this.call(`/api/admin/oauth-accounts/${encodeURIComponent(externalId)}`,'PATCH',{outbound_proxy_id:options.proxyExternalId});
    const path=this.provider==='minicc'?`/api/accounts/${encodeURIComponent(externalId)}/detail`:`/api/admin/oauth-accounts/${encodeURIComponent(externalId)}`;
    const {account}=await this.call(path);
    assert(account && String(account.outbound_proxy_id||'')===options.proxyExternalId,'上游实际代理未匹配，请核对后重试',502);
  }
  async historicalDay(day:string):Promise<{externalId:string;rawUsd:string}[]> {
    if(this.provider==='accedra')return this.accedra().statement(day);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day))&&new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day,'日期无效');
    if(this.provider==='gatelink') {
      // Probe the actual permission, rather than rejecting all agent logins.
      // The public Gatelink UI uses this endpoint for completed Beijing days.
      assert(this.user?.id,'请先登录平台再读取历史账单');
      const query=new URLSearchParams({scopeType:'user',scopeUserId:String(this.user.id),includeChildren:'true',source:'upstream',from:day,to:day});
      const data=await this.call(`/api/admin/usage-settlements?${query}`);
      assert(data.query?.from===day && data.query?.to===day && String(data.query?.scopeUserId)===String(this.user.id)
        && (data.statsSource??data.source)==='upstream','Gatelink 未返回可核实日期和范围的上游日账单',502);
      const days=Array.isArray(data.items)?data.items:[];
      assert(days.length===1 && days[0].date===day && days[0].dataStatus==='complete','历史查询尚未完成，请稍后重新查询',502);
      // Team totals or member totals cannot be allocated to Claude accounts.
      // Only an explicit account breakdown is usable for automatic settlement.
      assert(Array.isArray(days[0].accounts),'Gatelink 日账单未提供逐账号金额，无法自动分配给代理',502);
      const rows=historicalRows(days[0].accounts);
      const total=upstreamAmount(days[0].usageUsdExact,'Gatelink 日账单合计缺失');
      assert(rows.reduce((n,r)=>n.plus(r.rawUsd),new Decimal(0)).eq(total),'Gatelink 逐账号金额与日账单合计不一致',502);
      return rows;
    }
    if(this.provider==='minicc') {
      const query=new URLSearchParams({since:new Date(`${day}T00:00:00+08:00`).toISOString(),until:new Date(`${day}T23:59:59+08:00`).toISOString()});
      let data:any;
      for(let n=0;n<25;n++) {
        data=await this.call(`/api/usage?${query}`);
        assert(typeof data.complete==='boolean','历史用量完整性标记缺失，未写入账本',502);
        if(data.complete && !data.pending && !data.refreshing) break;
        if(n<24) await new Promise(resolve=>setTimeout(resolve,2000));
      }
      assert(data.complete && !data.pending && !data.refreshing,'历史查询尚未完成，请稍后重新查询',502);
      assert(Array.isArray(data.accounts),'上游历史结果缺少逐账号用量；未写入账本',502);
      return historicalRows(data.accounts);
    }
    const data=await this.call('/api/admin/vendor-usage/queries','POST',{since:`${day}T00:00:00+08:00`,until:`${day}T23:59:59+08:00`,granularity:'day'});
    assert(data.task?.id,'历史查询接口响应变化',502);
    const taskMatches=(task:any)=>task?.id===data.task.id
      &&(task.input?.since===undefined||Date.parse(task.input.since)===Date.parse(`${day}T00:00:00+08:00`))
      &&(task.input?.until===undefined||Date.parse(task.input.until)===Date.parse(`${day}T23:59:59+08:00`));
    let first:any;
    for(let n=0;n<25;n++) {
      first=await this.call(`/api/admin/vendor-usage/queries/${encodeURIComponent(data.task.id)}?page=1&account_page=1`);
      assert(taskMatches(first.task),'历史查询分页结果不完整',502);
      if(first.task?.status==='succeeded'||first.task?.status==='completed') break;
      assert(!['failed','cancelled'].includes(first.task?.status),'上游历史查询失败',502);
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    assert(first?.result && ['succeeded','completed'].includes(first.task?.status),'历史查询尚未完成，请稍后重新查询',502);
    const result=first.result;
    assert(Array.isArray(result.accounts),'上游历史结果缺少逐账号用量；未写入账本',502);
    const rows=[...result.accounts];
    const count=result.account_count,pageSize=result.page_size;
    assert(Number.isInteger(count)&&count>=0&&count<=100000&&Number.isInteger(pageSize)&&pageSize>=0&&(pageSize>0||count===0)
      &&(count===0||Math.ceil(count/pageSize)<=1000)&&result.account_page===1,'历史查询分页格式变化',502);
    for(let page=2;page<=Math.ceil(count/pageSize);page++) {
      const next=await this.call(`/api/admin/vendor-usage/queries/${encodeURIComponent(data.task.id)}?page=1&account_page=${page}`);
      assert(taskMatches(next.task)&&['succeeded','completed'].includes(next.task?.status)&&Array.isArray(next.result?.accounts)
        &&next.result.account_count===count&&next.result.page_size===pageSize&&next.result.account_page===page,'历史查询分页结果不完整',502);
      rows.push(...next.result.accounts);
    }
    assert(rows.length===count,'历史账号结果不完整，未写入账本',502);
    return historicalRows(rows);
  }
}
