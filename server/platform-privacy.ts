import { platformNames } from '../shared/platforms.js';
import { assert } from './core.js';

// Server-only mapping. Stored account bindings, contract keys and hashes do not
// change when public platform identifiers are serialized as A–E and X.
const aliases = {gatelink:'A',ai008:'B',minicc:'C',maxchat:'D',aeromax:'E',accedra:'X'} as const;
export const upstreamNames = {gatelink:'Gatelink',ai008:'AI008',minicc:'Mini CC Gateway',maxchat:'MaxChat Gateway',aeromax:'E-coding',accedra:'Accedra'} as const;
type InternalProvider = keyof typeof aliases;
export const publicProvider = (provider:string) => aliases[provider as InternalProvider] ?? provider;
export const publicPlatformName = (provider:string) => platformNames[publicProvider(provider) as keyof typeof platformNames] ?? '—';
const internalProvider = (provider:string) => Object.entries(aliases).find(([,alias])=>alias===provider)?.[0] ?? provider;
const privateIdentities: [RegExp,string][] = [
  [/https?:\/\/accedra\.xyz[^\s<>"']*|Accedra/gi,'Platform X (✨ Anti-Ban)'],
  [/https?:\/\/cc\.gatelink\.dev[^\s<>"']*|cc\.gatelink\.dev/gi,'平台 A'],
  [/https?:\/\/ai008\.xyz[^\s<>"']*|ai008\.xyz/gi,'平台 B'],
  [/https?:\/\/207\.57\.170\.28(?::8096)?[^\s<>"']*|207\.57\.170\.28(?::8096)?/g,'平台 C'],
  [/https?:\/\/cldgtw\.maxchatapi\.com[^\s<>"']*|cldgtw\.maxchatapi\.com/gi,'平台 D'],
  [/https?:\/\/www\.aeromax\.one[^\s<>"']*|https?:\/\/aeromax\.one[^\s<>"']*|www\.aeromax\.one|aeromax\.one/gi,'平台 E'],
  [/Gatelink/gi,'平台 A'],[/AI008/gi,'平台 B'],[/Mini\s*CC(?:\s+Gateway)?|minicc/gi,'平台 C'],[/MaxChat(?:\s+Gateway)?/gi,'平台 D'],
  [/E-coding|AeroMax/gi,'平台 E'],
];
export const redactPlatformText = (value:string) => privateIdentities.reduce((text,[pattern,alias])=>text.replace(pattern,alias),value);
const plain = (value:any) => value && (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);

// Normalize only named platform contract fields. Never modify OAuth callbacks,
// tokens, monetary strings or identifiers to route a request.
export function decodePlatformRequest(value:any):any {
  if(Array.isArray(value))return value.map(decodePlatformRequest);
  if(!plain(value))return value;
  return Object.fromEntries(Object.entries(value).map(([key,item])=>{
    if(key==='provider'&&typeof item==='string')return [key,internalProvider(item)];
    if(key==='rates'&&plain(item)) {
      const entries=Object.entries(item as object).map(([provider,rate])=>[internalProvider(provider),rate]);
      assert(new Set(entries.map(([provider])=>provider)).size===entries.length,'平台价格不能重复设置');
      return [key,Object.fromEntries(entries)];
    }
    return [key,decodePlatformRequest(item)];
  }));
}

// Never rewrite a signed OAuth URL. An authorization URL containing private
// platform information must be reviewed by the owner before it is shared.
export function privateAuthorizationUrl(value:string):boolean {
  let decoded=value;
  for(let i=0;i<4;i++) {
    if(redactPlatformText(decoded)!==decoded)return true;
    try {const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next;}catch{break;}
  }
  return false;
}
const messages=new Set(['error','message','last_error','proxy_sync_error','connection_name']);
const authorizationFields=new Set(['authorization_url','authorizationUrl']);
export function encodePlatformResponse(value:any,owner=false,key=''):any {
  if(typeof value==='string') {
    if(key==='provider')return publicProvider(value);
    if((authorizationFields.has(key)||key==='url')&&!owner&&privateAuthorizationUrl(value))return '';
    return messages.has(key)?redactPlatformText(value):value;
  }
  if(Array.isArray(value))return value.map(item=>encodePlatformResponse(item,owner,key));
  if(!plain(value))return value;
  const result=Object.fromEntries(Object.entries(value).map(([field,item])=>[publicProvider(field),encodePlatformResponse(item,owner,field)]));
  const privateAttempt=[...authorizationFields].some(field=>typeof value[field]==='string'&&privateAuthorizationUrl(value[field]));
  const privateResult=key==='result'&&typeof value.url==='string'&&privateAuthorizationUrl(value.url);
  const privateJob=value.kind==='oauth_start'&&value.result&&Object.values(value.result).some(item=>typeof item==='string'&&privateAuthorizationUrl(item));
  if(!owner&&(privateAttempt||privateResult||privateJob))result.error='授权链接暂不可用，请联系管理员核对平台配置';
  return result;
}
