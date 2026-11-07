// Stable public identities only. Private upstream metadata stays on the server.
export const platformNames = {A:'平台 A',B:'平台 B',C:'平台 C',D:'平台 D',E:'平台 E (coding)',X:'Platform X (✨ Anti-Ban)'} as const;
export function platformName(provider:string):string {
  return platformNames[provider as keyof typeof platformNames]??'—';
}
