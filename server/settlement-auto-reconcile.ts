import Decimal from 'decimal.js';
import type { DB, Row } from './db.js';
import { assert, audit, id, sum, usd } from './core.js';
import { confirmInvoiceInTransaction, ingestUsage } from './billing.js';
import { assertUsageAccounting } from './financial-integrity.js';

const JADEN='1cf8308f-6e34-4aa8-acd7-b45a9c9cf6f5';
const REFERENCE='automatic settlement reconciliation 2026-10-31';
const TARGETS=[
  {id:'72761ba0-b790-42cc-a7fd-21a8fb1dc44e',email:'dev3@sartel.ai',provider:'maxchat',day:'2026-10-29',raw:'204.63112100',profit:'40.92622420'},
  {id:'94cbbdea-38d1-46f2-8060-0f7a78348843',email:'dev3@sartel.ai',provider:'gatelink',day:'2026-10-29',raw:'115.39451800',profit:'33.46441022'},
  {id:'084662bf-95ff-47ce-a237-a55b33dad310',email:'dev4@sartel.ai',provider:'gatelink',day:'2026-10-29',raw:'130.55072400',profit:'37.85970996'},
  {id:'75d101df-832b-4f34-940b-112bd8c1739a',email:'dev4@sartel.ai',provider:'maxchat',day:'2026-10-29',raw:'60.16712520',profit:'12.03342504'},
  {id:'66d3eb3e-54b7-4719-a726-967f82f3c147',email:'junior3@sartel.ai',provider:'maxchat',day:'2026-10-29',raw:'5.51848000',profit:'1.10369600'},
  {id:'7232050d-3e57-4620-96eb-de9e9fcbfcaf',email:'dev2@sartel.ai',provider:'gatelink',day:'2026-10-30',raw:'203.42130100',profit:'58.99217729'},
  {id:'9a8266bc-3df5-4510-b34c-7ae0ee10b6ad',email:'dev3@sartel.ai',provider:'gatelink',day:'2026-10-30',raw:'43.52740600',profit:'12.62294774'},
  {id:'80937669-cc7c-48ac-9692-9f2e7456a917',email:'dev4@sartel.ai',provider:'gatelink',day:'2026-10-30',raw:'0.90842500',profit:'0.26344325'},
  {id:'567af9c1-aae5-4581-b315-2e0fcc01973e',email:'junior1@sartel.ai',provider:'gatelink',day:'2026-10-30',raw:'19.34791100',profit:'5.61089419'},
  {id:'8642d5ef-237a-4c74-ae73-6e830f37e647',email:'junior3@sartel.ai',provider:'gatelink',day:'2026-10-30',raw:'0.84696500',profit:'0.24561985'},
  {id:'dcd5dfed-8cf2-4493-aacc-8534fa570509',email:'rhinasofi@hotmail.com',provider:'gatelink',day:'2026-10-31',raw:'115.54776200',profit:'33.50885098'},
] as const;

async function exactInvoice(tx:DB,actor:Row,user:Row,usageIds:string[]) {
  const items=await tx.query(`SELECT e.* FROM earnings e JOIN usage_days u ON u.id=e.usage_id
    LEFT JOIN invoice_items ii ON ii.earning_id=e.id
    WHERE e.user_id=$1 AND e.usage_id=ANY($2::text[]) AND u.state='final' AND ii.earning_id IS NULL ORDER BY e.id`,[user.id,usageIds]);
  assert(items.length===usageIds.length,'CCMAX automatic reconciliation invoice item mismatch',409);
  await assertUsageAccounting(tx,usageIds);
  const totals=['gross_usd','downstream_usd','profit_usd'].map(field=>usd(sum(items.map(item=>item[field]))));
  const invoiceId=id(),days=TARGETS.filter(target=>usageIds.includes(target.id)).map(target=>target.day).sort();
  const [invoice]=await tx.query(`INSERT INTO invoices(id,number,user_id,payer_id,date_from,date_to,gross_usd,downstream_usd,profit_usd,created_by,automatic,estimated)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,false) RETURNING *`,[invoiceId,`CC-RECONCILE-${invoiceId.slice(0,8).toUpperCase()}`,
    user.id,user.parent_id,days[0],days.at(-1),...totals,actor.id]);
  for(const item of items) await tx.query('INSERT INTO invoice_items(earning_id,invoice_id) VALUES($1,$2)',[item.id,invoiceId]);
  await audit(tx,actor.id,'invoice.create',invoiceId,{repair:REFERENCE,usageIds});
  return invoice;
}

// Exact production fingerprints make this deploy-time repair safe to rerun and
// fail closed if the source data changes before deployment.
export async function applySettlementAutoReconciliation(tx:DB) {
  const [jaden]=await tx.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[JADEN]);
  if(!jaden)return;
  const [owner]=await tx.query("SELECT * FROM users WHERE role='owner' FOR UPDATE");
  assert(owner&&jaden.parent_id===owner.id,'CCMAX automatic reconciliation hierarchy mismatch',409);
  const rows=await tx.query(`SELECT u.*,b.id AS binding_id,a.email,a.owner_id,a.ownership_verified,c.provider
    FROM usage_days u JOIN bindings b ON b.id=u.binding_id JOIN accounts a ON a.id=b.account_id
    JOIN connections c ON c.id=b.connection_id WHERE u.id=ANY($1::text[]) FOR UPDATE OF u`,[TARGETS.map(target=>target.id)]);
  assert(rows.length===TARGETS.length,'CCMAX automatic reconciliation fingerprint mismatch',409);
  for(const target of TARGETS) {
    const row=rows.find(candidate=>candidate.id===target.id);
    assert(row&&row.email===target.email&&row.provider===target.provider&&row.day===target.day
      &&new Decimal(row.raw_usd).eq(target.raw)&&row.owner_id===JADEN&&row.ownership_verified,
    'CCMAX automatic reconciliation fingerprint mismatch',409);
  }
  const linked=await tx.query(`SELECT e.usage_id,i.state,l.id AS ledger_id,l.amount_usd FROM earnings e
    JOIN invoice_items x ON x.earning_id=e.id JOIN invoices i ON i.id=x.invoice_id
    LEFT JOIN ledger l ON l.reference_id=i.id AND l.user_id=e.user_id AND l.kind='settlement'
    WHERE e.user_id=$1 AND e.usage_id=ANY($2::text[])`,[JADEN,TARGETS.map(target=>target.id)]);
  const unresolved=TARGETS.filter(target=>{
    const existing=linked.find(row=>row.usage_id===target.id);
    if(!existing)return true;
    assert(existing.state==='confirmed'&&existing.ledger_id&&new Decimal(existing.amount_usd).isFinite(),
      'CCMAX automatic reconciliation target has an incomplete invoice',409);
    return false;
  });
  if(!unresolved.length)return;
  assert(unresolved.every(target=>rows.find(row=>row.id===target.id)?.state==='provisional')
    &&linked.every(row=>!unresolved.some(target=>target.id===row.usage_id)),
  'CCMAX automatic reconciliation target is not safely repairable',409);
  for(const target of unresolved) {
    const row=rows.find(candidate=>candidate.id===target.id)!;
    await ingestUsage(tx,{bindingId:row.binding_id,day:target.day,rawUsd:target.raw,final:true,source:'reviewed_statement',evidence:REFERENCE});
  }
  const usageIds=unresolved.map(target=>target.id);
  const earnings=await tx.query('SELECT usage_id,profit_usd FROM earnings WHERE user_id=$1 AND usage_id=ANY($2::text[])',[JADEN,usageIds]);
  assert(earnings.length===unresolved.length&&unresolved.every(target=>new Decimal(earnings.find(row=>row.usage_id===target.id)?.profit_usd).eq(target.profit)),
    'CCMAX automatic reconciliation amount mismatch',409);
  const rootInvoice=await exactInvoice(tx,owner,owner,usageIds);
  await confirmInvoiceInTransaction(tx,owner,rootInvoice.id,REFERENCE);
  const jadenInvoice=await exactInvoice(tx,owner,jaden,usageIds);
  await confirmInvoiceInTransaction(tx,owner,jadenInvoice.id,REFERENCE);
}
