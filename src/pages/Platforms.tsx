import PlatformActivity, { PlatformActivityOverview } from '../PlatformActivity';
import { usePlatformCatalog } from '../PlatformIdentity';
import { t } from '../i18n';
import { platformName } from '../platforms';
import { useLocale } from '../LanguageSwitcher';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Check, KeyRound, Link2, Plus, RefreshCw, Settings2, ShieldCheck, Zap } from 'lucide-react';
import { dateTime, day, key, mutate, post, localToday, useData } from '../api';
import { PricingNotice } from '../TeamPricing';
import { Amount, RateField } from '../PriceDisplay';
import { Badge, Empty, ErrorBox, Field, Form, Loading, Modal, PageHead, PlatformMark, Submit, useSession, useToast } from '../components';

export default function Platforms(){useLocale();
  const pricing=useData('/api/team/pricing',30000);
  const {user}=useSession(),toast=useToast(),{data,error,loading,refresh}=usePlatformCatalog(),[edit,setEdit]=useState<any>(null),[busy,setBusy]=useState(false);
  const root=user.role==='owner',[scope,setScope]=useState('team'),activity=useData(`/api/telemetry/platforms?scope=${scope}`,30000);
  const stats=activity.data?.scope===scope?activity.data:null;
  async function refreshAll(){await Promise.all([refresh(),activity.refresh(),pricing.refresh()]);}
  async function sync(ids:string[]){if(!ids.length)return;setBusy(true);try{await post('/api/connections/sync',{connectionIds:ids,key:key()});toast(t("已加入同步队列，请在同步任务中查看结果"));}catch(e){toast((e as Error).message,'error');}finally{setBusy(false);}}
  return <>
    <PageHead eyebrow={t("平台连接管理")} title={t("平台管理")} description={t("查看各平台用量、运行状态与结算价格，直接管理平台连接和上号。")} actions={<><button className="button" onClick={refreshAll}><RefreshCw size={15}/>{t("刷新展示")}</button>{root&&<>
      <button className="button" disabled={busy} onClick={()=>sync((data?.connections||[]).filter((c:any)=>c.enabled).map((c:any)=>c.id))}><RefreshCw size={15} className={busy?'spin':''}/>{t("同步全部")}</button>
      <button className="button primary" onClick={()=>setEdit({provider:'A'})}><Plus size={16}/>{t("添加连接")}</button>
    </>}</>}/>
    <ErrorBox error={error}/><ErrorBox error={activity.error}/><PricingNotice report={pricing.data}/>
    <PlatformActivityOverview connections={data?.connections||[]} activity={stats} loading={!stats}/>
    <div className="platform-scope-bar"><div className="tabs" aria-label={t("数据归属")}>{([["team",root?t("全平台账号"):t("本人及下级团队")],["self",t("仅本人")],["descendants",t("仅下级团队")]]).map(([value,label])=><button key={value} className={scope===value?"active":""} onClick={()=>setScope(value)}>{label}</button>)}</div><span>{t("每 30 秒自动刷新展示")}</span></div>
    <p className="page-note platform-scope-note">{t("平台数据按账号归属统计；过期或缺失指标不计入汇总。平台账单为折扣前金额，不等于结算收益。")}</p>
    <div className="notice"><ShieldCheck size={18}/><span>{root?t("平台主账号凭据加密保存，仅管理员可配置。所有页面只显示平台名称和当前用户的结算价格。"):t("账号归属与结算由 CCMAX 统一管理。以下为直属上级给你的结算价格。")}</span></div>
    {loading?<Loading/>:<div className="connections-grid platform-data-grid">{data?.connections.map((c:any)=><section className="panel connection-card" key={c.id} aria-label={platformName(c.provider)}>
      <div className="platform-card-head"><PlatformMark provider={c.provider}/><div><h2>{platformName(c.provider)}</h2><small className="platform-connection-id">{c.id.slice(0,8)}</small>{root&&<><small>{c.capabilities.upstreamName}</small><small>{c.capabilities.url?.replace(/^https?:\/\//,'')}</small>{c.upstream_snapshot?.uploader&&<small>{t('上号器')} · {c.upstream_snapshot.uploader.state}</small>}{c.provider==='E'&&<><small className="platform-billing-line">{t('今日平台账单')} · {c.upstream_snapshot?.settlement?.owedTodayUsdMinor===null||c.upstream_snapshot?.settlement?.owedTodayUsdMinor===undefined?<>USD {t('待人工核对')}</>:<><Amount value={Number(c.upstream_snapshot.settlement.owedTodayUsdMinor)/100} digits={2} tone="settlement"/> <span>USD</span></>}</small><small>{t('上游原始点数')} · {c.upstream_snapshot?.settlement?.pointsToday??c.upstream_snapshot?.live?.pointsToday??'—'} points · {t('按固定汇率换算：1 USD = ¥6.7')}</small></>}</>}</div><Badge state={c.enabled?c.status:'disabled'}/></div>
      <PlatformActivity connectionId={c.id} activity={stats?.platforms?.find((p:any)=>p.id===c.id)} loading={!stats} scope={scope}/>
      <SettlementPrice connection={c} root={root}/>
      <details className="platform-capabilities"><summary>{t("平台能力与同步信息")}</summary><div className="connection-facts">
        <div><span>{t("OAuth 上号")}</span><span className="teal-text"><Check size={14}/>{t("已支持")}</span></div>
        <div><span>{t("Refresh token 导入")}</span><span>{c.capabilities.refreshTokenImport?t("已支持"):t("需使用 OAuth")}</span></div>
        <div><span>{t("账单更新")}</span><span>{c.capabilities.historicalUsage?t("每天 02:00 后（北京时间）"):t("仅实时账号数据，历史账单需人工核对")}</span></div>
        <div><span>{t('账号启停')}</span><span>{c.capabilities.statusRequiresAdmin?t('需要上游管理员权限'):t('已支持')}</span></div>
        <div><span>{t("最近成功同步")}</span><span>{dateTime(c.last_sync_at)}</span></div>
      </div>
      </details>
      {c.last_error&&<div className="platform-connection-error"><ErrorBox error={c.last_error}/></div>}
      <div className="connection-actions">
        {c.enabled?<Link className="button primary" to={`/accounts?create=1&connection=${encodeURIComponent(c.id)}`}><Zap size={14}/>{t("上号到此平台")}</Link>:<button className="button primary" disabled><Zap size={14}/>{t("平台已停用")}</button>}
        {root&&<>
          <button className="button" onClick={()=>setEdit(c)}><Settings2 size={14}/>{t("配置连接")}</button>
          <button className="button" disabled={!c.enabled||busy} onClick={()=>sync([c.id])}><RefreshCw size={14}/>{t("同步账号")}</button>
          <a href={c.capabilities.url} target="_blank" rel="noreferrer" className="button">{t("打开平台")} <ArrowUpRight size={14}/></a>
        </>}
      </div>
    </section>)}{!data?.connections.length&&<div className="panel"><Empty title={root?t("连接你的第一个平台"):t("暂无可用平台")} detail={root?t("添加你自己的上游主账号，即可拉取账号与实时用量。"):t("请联系上级开通平台。")} action={root&&<button className="button primary" onClick={()=>setEdit({provider:'A'})}><Plus size={15}/>{t("添加平台")}</button>}/></div>}</div>}
    <div className="info-grid"><div><Link2 size={20}/><h3>{t("选择平台，独立上号")}</h3><p>{t("可在平台卡片直接上号，也可到账号管理同时选择多个平台。所有平台共用账号固定代理。")}</p></div><div><KeyRound size={20}/><h3>{t("按自己的价格结算")}</h3><p>{t("平台账单 × 你的折扣 = 你的应收。已有报价调整从次日北京时间生效，历史账单保留当日价格。")}</p></div></div>
    {edit&&<Modal title={edit.id?t("配置平台连接"):t("添加平台连接")} subtitle={t("填写你拥有或有权管理的平台主账号")} onClose={()=>setEdit(null)}><Form onSubmit={async f=>{
      const payload:any={payoutRate:Number(f.get('payoutRate')),snapshotBilling:edit.snapshot_billing??edit.provider==='A'};
      if(edit.id){payload.enabled=f.get('enabled')==='on';if(f.get('username'))payload.username=f.get('username');if(f.get('password'))payload.password=f.get('password');await mutate(`/api/connections/${edit.id}`,'PATCH',payload);}else{Object.assign(payload,{provider:f.get('provider'),name:platformName(String(f.get('provider'))),username:f.get('username'),password:f.get('password'),effectiveFrom:f.get('effectiveFrom')});await post('/api/connections',payload);}
      toast(edit.id?t("连接配置已更新；新的上游折扣从次日北京时间生效"):t("平台已添加，正在核验并同步账号"));setEdit(null);await refreshAll();
    }}>
      <Field label={t("平台")}><select aria-label={t("平台")} name="provider" defaultValue={edit.provider} onChange={e=>setEdit({...edit,provider:e.target.value})} disabled={!!edit.id}>{Object.entries(data?.providers||{}).map(([p,v]:[string,any])=><option key={p} value={p}>{t(v.name)}{v.upstreamName?` · ${v.upstreamName}`:''}{v.url?` · ${v.url.replace(/^https?:\/\//,'')}`:''}</option>)}</select></Field>
      <Field label={edit.id?t("新的登录账号（留空保留）"):t("登录账号")}><input name="username" autoComplete="off" required={!edit.id} placeholder={t("平台登录邮箱或用户名")}/></Field>
      <Field label={edit.id?t("新的密码（留空保留）"):t("登录密码")}><input type="password" name="password" autoComplete="new-password" required={!edit.id}/></Field>
      <RateField name="payoutRate" label={t("上游给你的结算折扣")} recipient="self" hint={t("0–1，例如 0.3 表示平台账单 $100，你收到 $30。修改从次日北京时间生效，历史日账单按当日留档价格计算。")} defaultValue={edit.upcoming_payout_rate??edit.payout_rate??''}/>
      {!edit.id&&<Field label={t("初始折扣生效日")} hint={t("填写真实合同起始日期。")}><input name="effectiveFrom" type="date" required max={localToday()} defaultValue={localToday()}/></Field>}
      {edit.id&&<label className="check-row"><input type="checkbox" name="enabled" defaultChecked={edit.enabled}/>{t("启用这条连接")}</label>}
      <div className="modal-actions"><button className="button" type="button" onClick={()=>setEdit(null)}>{t("取消")}</button><Submit>{edit.id?t("保存配置"):t("保存并连接")}</Submit></div>
    </Form></Modal>}
  </>;
}

function SettlementPrice({connection:c,root}:{connection:any;root:boolean}) {useLocale();
  const priced=c.settlement_rate!==null&&c.settlement_rate!==undefined,upcoming=c.upcoming_settlement_rate!==null&&c.upcoming_settlement_rate!==undefined;
  return <div className={`settlement-price${priced?'':' unpriced'}`}>
    <div className="price-heading"><span>{root?t("上游给我的结算折扣"):t("我的结算折扣")}</span><span className="price-status">{priced?t("当前生效"):t("待设置")}</span></div>
    <strong>{priced?`× ${Number(c.settlement_rate).toFixed(4)}`:t("未定价")}</strong>
    {priced?<>{c.settlement_effective_date&&<small>{t("当前价格自 {0} 生效", [day(c.settlement_effective_date)])}</small>}<div className="settlement-example"><span>{t("平台账单 $100 · 应收示例")}</span><div>{t("结算")} <Amount value={Number(c.settlement_rate)*100} digits={2} tone="settlement"/><small>{t("USD · 示例金额")}</small></div></div></>:<p>{t("请联系直属上级设置该平台的结算折扣。")}</p>}
    {upcoming&&<div className="scheduled-price"><b>{t("待生效 ×")} {Number(c.upcoming_settlement_rate).toFixed(4)}</b><small>{t("{0} 00:00 北京时间生效", [day(c.upcoming_settlement_date)])}</small><small>{priced?t("生效前继续按当前价格结算"):t("生效前尚未定价，暂不可结算")}</small></div>}
  </div>;
}
