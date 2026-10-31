import { platformNames } from './platforms.js';
export const apiScopes = ['read', 'team:write', 'accounts:write', 'finance:write', 'key:write'] as const;
export type ApiScope = typeof apiScopes[number];
type Schema = Record<string, unknown>;
export type ApiEndpoint = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT'; path: string; scope: ApiScope;
  summary: string; body?: Schema; query?: Record<string, Schema>; csv?: boolean;
};
const text = { type: 'string' }, uuid = { type: 'string', format: 'uuid' };
const date = { type: 'string', format: 'date' }, boolean = { type: 'boolean' };
const email = { type: 'string', format: 'email', maxLength: 200 };
const password = { type: 'string', minLength: 12, maxLength: 200 };
const provider = { type: 'string', enum: Object.keys(platformNames) };
const key = { type: 'string', minLength: 8, maxLength: 100, description: 'Client-generated idempotency key. Reuse only for the identical request.' };
const upstreamKey = { type: 'string', minLength: 8, maxLength: 1000, writeOnly: true, description: 'Upstream API key. Accepted only over HTTPS and never returned.' };
const rate = { type: 'number', minimum: 0, maximum: 1, multipleOf: 0.0001 };
const money = { type: 'string', pattern: '^(0|[1-9]\\d{0,15})(\\.\\d{1,8})?$', example: '10.00000000' };
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const options = object({ accountType: { type: 'string', enum: ['speed', 'stable', 'team', 'max', 'pro'] }, policyTemplateId: text, groupIds: { type: 'array', items: text, maxItems: 30 }, ccTemplateId: text }, []);
const period = { from: date, to: date };

// This catalog is both the Bearer-token allowlist and the published API contract.
// Session-only operations (passwords, keys, upstream administration) stay outside it.
export const apiEndpoints: ApiEndpoint[] = [
  { method: 'GET', path: '/api/auth/me', scope: 'read', summary: 'Current user and Beijing billing date' },
  { method: 'GET', path: '/api/dashboard', scope: 'read', summary: 'Team overview, balances and platform totals' },
  { method: 'GET', path: '/api/team', scope: 'read', summary: 'Own team tree, prices and period totals', query: period },
  { method: 'GET', path: '/api/team/pricing', scope: 'read', summary: 'Personal current/next rates and direct-downline margin risks; existing contracts remain unchanged' },
  { method: 'POST', path: '/api/team/rates/preview', scope: 'team:write', summary: 'Preview direct-child rate changes and affected margins', body: object({ provider, userIds: { type: 'array', items: uuid, minItems: 1, maxItems: 500, uniqueItems: true }, mode: { type: 'string', enum: ['fixed', 'scale', 'cap'] }, value: rate }, ['provider', 'userIds', 'mode']) },
  { method: 'POST', path: '/api/team/rates/batch', scope: 'team:write', summary: 'Apply a reviewed batch atomically for the next Beijing day; stale snapshots and unacknowledged risks return 409', body: object({ provider, userIds: { type: 'array', items: uuid, minItems: 1, maxItems: 500, uniqueItems: true }, mode: { type: 'string', enum: ['fixed', 'scale', 'cap'] }, value: rate, snapshot: { type: 'string', pattern: '^[a-f0-9]{64}$' }, acknowledgeRisk: boolean }, ['provider', 'userIds', 'mode', 'snapshot']) },
  { method: 'POST', path: '/api/team', scope: 'team:write', summary: 'Create a direct child agent with explicitly agreed platform rates', body: object({ name: { ...text, maxLength: 80 }, email, password, rates: { type: 'object', properties: Object.fromEntries(Object.keys(platformNames).map(key=>[key,rate])), minProperties: 1, additionalProperties: false }, effectiveFrom: date }, ['name', 'email', 'password', 'rates']) },
  { method: 'PATCH', path: '/api/team/:id', scope: 'team:write', summary: 'Suspend/reactivate a direct child or reset their password', body: { ...object({ active: boolean, newPassword: password }, []), minProperties: 1 } },
  { method: 'PUT', path: '/api/team/:id/rates', scope: 'team:write', summary: 'Set a direct child price; existing prices change from the next Beijing day', body: object({ provider, rate, effectiveFrom: date }, ['provider', 'rate']) },
  { method: 'GET', path: '/api/connections', scope: 'read', summary: 'Platform capabilities and the calling agent’s settlement prices' },
  { method: 'GET', path: '/api/connections/:id/options', scope: 'read', summary: 'Available onboarding options for one platform' },
  { method: 'GET', path: '/api/proxies', scope: 'read', summary: 'Only the calling user’s fixed egress proxies, without authentication secrets' },
  { method: 'POST', path: '/api/proxies', scope: 'accounts:write', summary: 'Add a fixed egress proxy', body: object({ name: { ...text, maxLength: 80 }, url: { ...text, maxLength: 2000, example: 'http://user:password@proxy.example.com:8080' } }) },
  { method: 'PATCH', path: '/api/proxies/:id', scope: 'accounts:write', summary: 'Rename or enable/disable an owned proxy', body: object({ name: { ...text, maxLength: 80 }, enabled: boolean }, []) },
  { method: 'GET', path: '/api/accounts', scope: 'read', summary: 'Own team accounts and verified platform bindings' },
  { method: 'GET', path: '/api/telemetry/platforms', scope: 'read', summary: 'Platform activity cards: account-attributed totals across all usage windows, with freshness coverage',
    query:{scope:{type:'string',enum:['self','descendants','team'],default:'team'},provider,accountId:uuid,connectionId:uuid,ownerId:uuid,search:{...text,maxLength:200}} },
  ...['/api/telemetry','/api/telemetry/trend'].map(path=>({method:'GET' as const,path,scope:'read' as const,summary:'Account-attributed upstream model telemetry and sampled rates; null means unavailable, coverage excludes stale accounts',
    query:{scope:{type:'string',enum:['self','descendants','team'],default:'team'},provider,accountId:uuid,connectionId:uuid,ownerId:uuid,search:{...text,maxLength:200},period:{type:'string',enum:['today','5h','7d','30d'],default:'today'},...(path.endsWith('/trend')?{}:{page:{type:'integer',minimum:1,default:1}})}})),
  { method: 'POST', path: '/api/accounts', scope: 'accounts:write', summary: 'Create an owned account; same owned email returns the existing account', body: object({ email, label: { ...text, maxLength: 100 } }, ['email']) },
  { method: 'POST', path: '/api/accounts/:id/proxy', scope: 'accounts:write', summary: 'Bind or rotate an owned verified account proxy and automatically synchronize supported platforms', body: object({ proxyId: uuid }) },
  { method: 'POST', path: '/api/accounts/:id/proxy/sync', scope: 'accounts:write', summary: 'Retry account-wide fixed proxy synchronization; Platform A legacy bindings may require reauthorization', body: object({ key }) },
  { method: 'POST', path: '/api/accounts/:id/authorize', scope: 'accounts:write', summary: 'Queue OAuth authorization for selected platforms', body: object({ targets: { type: 'array', minItems: 1, maxItems: 10, items: object({ connectionId: uuid, options }) }, key }) },
  { method: 'POST', path: '/api/bindings/:id/reauthorize', scope: 'accounts:write', summary: 'Reauthorize an owned verified platform account while preserving its binding and financial history', body: object({ options, key }) },
  { method: 'GET', path: '/api/accounts/:id/attempts', scope: 'read', summary: 'OAuth authorization URLs and attempts for an owned account' },
  { method: 'POST', path: '/api/oauth/:id/exchange', scope: 'accounts:write', summary: 'Submit a platform OAuth callback and queue the exchange', body: object({ callback: { ...text, maxLength: 8000 }, key }) },
  { method: 'POST', path: '/api/accounts/:id/import-token', scope: 'accounts:write', summary: 'Queue refresh-token import for a supported platform', body: object({ connectionId: uuid, refreshToken: { ...text, minLength: 10, maxLength: 10000 }, options, key }) },
  { method: 'POST', path: '/api/bindings/:id/proxy/sync', scope: 'accounts:write', summary: 'Queue fixed proxy synchronization for an owned verified binding', body: object({ key }) },
  { method: 'POST', path: '/api/bindings/:id/status', scope: 'accounts:write', summary: 'Queue enable/disable for an owned verified binding; Platform A falls back to a local usage pause when the upstream master is not an administrator', body: object({ enabled: boolean, key }) },
  { method: 'POST', path: '/api/bindings/:id/local-status', scope: 'accounts:write', summary: 'Pause or resume Platform A usage inside CCMAX when upstream account status permissions are unavailable', body: object({ enabled: boolean, key }) },
  { method: 'GET', path: '/api/jobs', scope: 'read', summary: 'Last 100 visible jobs or one job by id', query: { id: uuid } },
  { method: 'GET', path: '/api/usage', scope: 'read', summary: 'Paginated team usage (12 rows per page), totals and personal earnings', query: { ...period, provider, search: { ...text, maxLength: 200 }, page: { type: 'integer', minimum: 1, default: 1, maximum: 1000000 } } },
  { method: 'GET', path: '/api/usage/export', scope: 'read', summary: 'Export up to 100,000 matching usage rows as CSV', query: { ...period, provider, search: text }, csv: true },
  { method: 'GET', path: '/api/workspaces', scope: 'read', summary: 'Workspaces available to the calling user' },
  { method: 'GET', path: '/api/key-tasks', scope: 'read', summary: 'Visible Key supply tasks and frozen prices' },
  { method: 'GET', path: '/api/key-tasks/:id/rates', scope: 'read', summary: 'Task prices visible to the calling user' },
  { method: 'GET', path: '/api/key-tasks/:id/channels', scope: 'read', summary: 'Visible masked channels for a Key task' },
  { method: 'POST', path: '/api/key-tasks/:id/channels', scope: 'key:write', summary: 'Submit an encrypted upstream API key to a published task', body: object({ secret: upstreamKey, name: { ...text, maxLength: 120 }, site: { ...text, maxLength: 120 }, models: { type: 'array', items: text, maxItems: 100 }, idempotencyKey: { ...uuid, description: 'Reuse after a transport failure only with the identical submission.' } }, ['secret']) },
  { method: 'PATCH', path: '/api/key-channels/:id', scope: 'key:write', summary: 'Rotate, pause, resume or delete an owned Key channel', body: object({ state: { type: 'string', enum: ['active', 'paused', 'deleted'] }, secret: upstreamKey }, []) },
  { method: 'POST', path: '/api/key-channels/:id/test', scope: 'key:write', summary: 'Test an owned New API channel' },
  { method: 'GET', path: '/api/key-usage', scope: 'read', summary: 'Current masked channel usage and New API sync freshness', query: { taskId: uuid, page: { type: 'integer', minimum: 1, default: 1 } } },
  { method: 'GET', path: '/api/key-settlements', scope: 'read', summary: 'Key task settlement entries and price snapshots' },
  { method: 'GET', path: '/api/finance', scope: 'read', summary: 'Balances, invoices, withdrawals and latest ledger entries (12 rows per page)', query: { tab: { type: 'string', enum: ['all', 'mine', 'children'], default: 'all' }, source: { type: 'string', enum: ['all', 'account', 'key'], default: 'all' }, page: { type: 'integer', minimum: 1, default: 1, maximum: 1000000 } } },
  { method: 'GET', path: '/api/ledger/export', scope: 'read', summary: 'Export the calling agent’s ledger as CSV', csv: true },
  { method: 'GET', path: '/api/finance/check', scope: 'read', summary: 'Reconcile own ledger sources, frozen usage chains and withdrawals; 409 if any inconsistency exists' },
  { method: 'GET', path: '/api/invoices/preview', scope: 'read', summary: 'Read-only frozen invoice preview for self or a direct child; excludes unassigned, unverified and already invoiced usage', query: { userId: uuid, ...period } },
  { method: 'POST', path: '/api/invoices', scope: 'finance:write', summary: 'Create a settlement invoice for self or a direct child; an optional previewToken rejects changed earning rows', body: object({ userId: uuid, ...period, previewToken: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['userId', 'from', 'to']) },
  { method: 'POST', path: '/api/invoices/:id/confirm', scope: 'finance:write', summary: 'Confirm an invoice as its payer; records profit in the ledger', body: object({ reference: { ...text, minLength: 3, maxLength: 500 } }) },
  { method: 'GET', path: '/api/invoices/:id/export', scope: 'read', summary: 'Export an invoice belonging to the calling user or its payer', csv: true },
  { method: 'POST', path: '/api/withdrawals', scope: 'finance:write', summary: 'Request a withdrawal and reserve the balance; no external transfer is executed', body: object({ amount: money, method: { ...text, maxLength: 80, example: '币安 ID' }, destination: { ...text, minLength: 3, maxLength: 500 }, key }) },
  { method: 'POST', path: '/api/withdrawals/:id/review', scope: 'finance:write', summary: 'As the direct payer, record payment or reject a withdrawal', body: object({ action: { type: 'string', enum: ['paid', 'rejected'] }, reference: { ...text, minLength: 3, maxLength: 500 } }) },
  { method: 'GET', path: '/api/audits', scope: 'read', summary: 'Latest 300 audit records visible to the calling user' },
];

export function integrationSpec(baseUrl: string) {
  const errorResponse = { description: 'Request rejected', content: { 'application/json': { schema: { type: 'object', properties: { error: text, code: text, requestId: text }, required: ['error'] } } } };
  const paths: Record<string, Record<string, unknown>> = {};
  for (const endpoint of apiEndpoints) {
    const path = endpoint.path.replace(/:([a-zA-Z]+)/g, '{$1}');
    const parameters: object[] = [...endpoint.path.matchAll(/:([a-zA-Z]+)/g)].map(match => ({ name: match[1], in: 'path', required: true, schema: uuid }));
    for (const [name, schema] of Object.entries(endpoint.query || {})) parameters.push({ name, in: 'query', schema });
    (paths[path] ||= {})[endpoint.method.toLowerCase()] = {
      operationId: `${endpoint.method.toLowerCase()}${endpoint.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
      summary: endpoint.summary, tags: [endpoint.scope], 'x-required-scope': endpoint.scope,
      description: `Requires scope: ${endpoint.scope}. Existing account ownership and direct-child rules also apply.`,
      security: [{ bearerAuth: [] }], parameters,
      ...(endpoint.body ? { requestBody: { required: true, content: { 'application/json': { schema: endpoint.body } } } } : {}),
      responses: {
        '200': { description: 'Success. See the integration guide for response fields and asynchronous job handling.', content: { [endpoint.csv ? 'text/csv' : 'application/json']: { schema: endpoint.csv ? text : { type: 'object', additionalProperties: true } } } },
        '400': errorResponse, '401': errorResponse, '403': errorResponse, '404': errorResponse, '409': errorResponse,
        '429': { ...errorResponse, headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait' } } },
        '500': errorResponse, '502': errorResponse,
      },
    };
  }
  return {
    openapi: '3.1.0', info: { title: 'CCMAX Agent API', version: '1.0.0', description: 'Server-to-server API for agent integrations. Store API keys on your backend. Amounts are USD decimal strings with 8 decimal places; billing dates use Asia/Shanghai. Requests are limited to 120/minute per user per application instance and 240/minute per IP. This API manages the CCMAX workspace; it does not proxy model inference.' },
    servers: [{ url: new URL(baseUrl).origin }], paths,
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'ccmax_sk_…', description: 'Create a scoped API key in Settings → API access.' } } },
  };
}
