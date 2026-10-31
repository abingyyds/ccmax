# 代理 API 接入

每位代理可以使用自己的 API 密钥，将自己的网站或后端接入 CCMAX。API 复用网站的账号、团队、上号、用量和结算服务，数据范围与密钥所属账号一致。

支持的 provider：`A`、`B`、`C`、`D`，分别显示为平台 A、平台 B、平台 C、平台 D。请求、响应、报价字典和筛选条件统一使用这些字母；平台连接以不透明 UUID 区分。代理与匿名邀请预览不会获得来源名称、网址、主账号标签或凭据。平台管理的真实来源资料仅供平台管理员本人查看。

## 获取密钥

1. 登录 CCMAX，进入「设置与审计 → API 接入」。
2. 点击「创建 API 密钥」，填写名称、权限和有效期，输入当前密码确认。
3. 保存完整密钥：只显示一次，服务器仅保存 SHA-256 摘要，列表不能再次取回。
4. 页面显示当前平台的 **API 基础地址**。打开「接入文档」查看完整接口，下载 OpenAPI 文件导入 Postman、Insomnia 等工具。

每个账号最多保留 10 个有效密钥，有效期可选 30、90、365 天。撤销后，后续请求立即失效；已开始执行的请求或后台任务不会被撤回。修改登录密码或由上级重置密码会撤销该账号的全部密钥。账号或任一上级停用时，密钥不能访问 API。

## 调用方式

代理的网站浏览器调用代理自己的后端，再由其后端调用 CCMAX。密钥放在代理后端的环境变量 `CCMAX_API_KEY` 中，不能写入公开网页、URL 或公开仓库。本接口面向服务端集成，不开放浏览器跨域 CORS，也不需要独立域名解析、第三方托管令牌或平台新增环境变量。

以设置页显示的基础地址作为 `CCMAX_BASE_URL`：

```bash
curl "$CCMAX_BASE_URL/api/accounts" \
  -H "Authorization: Bearer $CCMAX_API_KEY"
```

Node.js 后端示例：

```js
const base = process.env.CCMAX_BASE_URL;
const token = process.env.CCMAX_API_KEY;

async function ccmax(path, method = 'GET', body) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok) {
    // 传输超时或 5xx 后先查询操作状态，不盲目重试写入。
    throw new Error(`${response.status} ${data.code}: ${data.error} (${data.requestId})`);
  }
  return data;
}

const { accounts } = await ccmax('/api/accounts');
console.log(accounts);

// 需要 accounts:write；userId 由密钥确定，不能指定其他账号的身份。
const { account } = await ccmax('/api/accounts', 'POST', {
  email: 'claude@example.com',
  label: 'My website account',
});
console.log(account.id);
```

Bearer 请求不需要网页登录 Cookie 或 `x-ccmax-request` 标记；网站 Cookie 会话继续检查 CSRF。提供了无效 Bearer 密钥时，即使同时携带有效 Cookie 也不会回退到网页登录。

## 权限

| 权限 | 功能 |
| --- | --- |
| `read`（必选，默认） | 查询获准访问的团队、账号、平台选项、用量、任务、财务及审计，导出 CSV |
| `team:write` | 创建直属下级、调整状态、重置密码及设置结算折扣 |
| `accounts:write` | 创建本人账号、固定出口代理、绑定代理、OAuth 上号与重新授权、RT 导入、启停和代理同步 |
| `finance:write` | 创建/确认账单、申请提现、登记已付款或驳回提现 |

权限不会扩大原有团队范围。不能管理其他团队、修改非直属下级，或更换已核实的账号归属。财务写权限应只授予确有需要的后端；实际向外部账户付款仍是线下操作。

密钥管理、自己的登录密码、平台主账号配置、管理员归属分配和日账单导入仅支持网页登录，不能用 API 密钥调用。所有角色的 `name` / `connection_name` 平台显示字段都使用字母平台名称与连接编号，不返回主账号内部标签或登录邮箱。登录凭据仅在配置时输入，查询不返回；下级也看不到管理员上游合同价或其他团队的数据。

## 接口文档

- 在线文档：`GET /api/docs`，无需登录，自带请求结构、权限和异步任务说明。
- 机器可读契约：`GET /api/openapi.json`，OpenAPI 3.1，版本 `1.0.0`。
- 完整接口清单与认证白名单共用 [shared/integration.ts](../shared/integration.ts)，避免文档中开放了实际不可调用的接口。

常用查询接口：

| 接口 | 返回 |
| --- | --- |
| `GET /api/auth/me` | `{user, today}`，当前密钥所属账号及北京时间账单日 |
| `GET /api/dashboard` | 汇总、余额、每日趋势、团队及平台概况 |
| `GET /api/accounts` | `{accounts, providers}`；账号包含 `bindings` 和固定代理状态 |
| `GET /api/team?from=2026-10-01&to=2026-10-18` | `{users, rates, upcoming, period, providers, pricing}` |
| `GET /api/connections` | `{connections, providers, today}`，自己的结算价和平台能力 |
| `GET /api/proxies` | `{proxies}`，仅本人添加、无认证密码的代理列表 |
| `GET /api/usage?from=2026-10-01&to=2026-10-18&page=1` | `{rows, totals, total, page}`，每页 12 条 |
| `GET /api/finance?tab=mine&source=all&page=1` | `{balance, pendingProfit, invoicesTotal, withdrawalsTotal, invoices, withdrawals, ledger}`，`source` 可选 `all`、`account`、`key`，账单和提现各每页 12 条 |
| `GET /api/finance/check` | `{ok:true, balance, checkedAt}`，只核对密钥所属用户的钱包、利润来源与冻结/释放流水；异常返回 409 |

## Key 供货工作空间

登录账号可以在主工作空间和 Key 供货工作空间之间切换。Key 任务由管理员绑定一个供货平台连接并发布；连接模板支持标准 New API 和 KeyMan NewAPI 定制适配器。KeyMan 任务还绑定一个网关，成员提交表单会透传类型、批量密钥、组织、API 地址、模型、分组、模型重定向和高级 JSON 设置。成员只有在任务存在当前价格时才能提交上游 Key。完整 Key 只在服务端加密保存，接口仅返回 `token_masked` 和渠道状态。

管理员通过 `POST /api/new-api-connections` 创建连接，`adapterType` 可取 `standard_new_api` 或 `keyman_newapi`；KeyMan 连接可用 `GET /api/new-api-connections/:id/gateways` 查询网关。KeyMan 租户若开启验证码，连接凭据需带浏览器取得的 `captchaVerification`，也可以直接使用管理访问令牌。创建任务时把 `templateType` 和 `gatewayId` 绑定到 `POST /api/key-tasks`。KeyMan 的 `POST /api/key-tasks/:id/models` 可在不落库的情况下从上游拉取模型；批量提交使用 `POST /api/key-tasks/:id/channels` 的 `secrets` 数组，服务端逐条创建渠道并保留每个 Key 的指纹和幂等记录。

KeyMan 验证失败时仍会加密保存连接，创建或编辑响应包含 `verified:false` 和 `warning`，连接列表保留 `status:error` 和错误原因。管理员可在设置中「编辑并验证」，对应 `PATCH /api/new-api-connections/:id`；不传凭据字段会复用加密保存的凭据或会话，更换认证方式时需填写新凭据。KeyMan 登录得到的访问令牌及刷新令牌会加密保存，后台同步刷新令牌时更新原连接。修改连接名称不会清除验证错误，手工设置 `status:connected` 也必须重新通过上游验证。

创建、发布和恢复发布任务要求连接处于 `connected`，KeyMan 同时验证所选网关仍对该连接可用；异常或停用连接不能接受新 Key。网关列表仅管理员可读取，界面在加载失败时显示原因并提供重试。已关闭任务不能重新发布。

带 `read` 权限的密钥可以读取 `/api/workspaces`、`/api/key-tasks`、`/api/key-tasks/:id/rates`、`/api/key-tasks/:id/channels`、`/api/key-usage` 和 `/api/key-settlements`。需要额外开启 `key:write` 才能调用 `POST /api/key-tasks/:id/channels` 提交 Key，以及 `PATCH /api/key-channels/:id` 轮换、暂停、恢复或删除自己的渠道、`POST /api/key-channels/:id/test` 测试渠道。管理员的 New API 凭据、连接管理、任务创建/发布/定价和后台同步仍然只支持网页登录。

标准 New API 渠道每 5 分钟同步一次 `used_quota`，并按 `/api/status` 返回的 `quota_per_unit` 换算 USD；KeyMan 渠道读取 `/newapi/channel/page`、`/newapi/channel/stat`，优先使用连接或网关返回的额度换算单位。同步产生的任务流水直接进入统一钱包；重复快照不会重复入账，计数回退会生成 `task_adjustment` 负向流水。`GET /api/finance?source=key` 可单独读取 Key 任务来源的统一账本流水。
| `GET /api/jobs?id=<UUID>` | `{jobs}`，按任务编号查状态；不传编号时最多最近 100 条可见任务 |
| `GET /api/audits` | `{rows}`，最多最近 300 条可见审计 |

`/api/usage/export`、`/api/ledger/export`、`/api/invoices/:id/export` 返回 CSV，不能按 JSON 解析。用量导出最多 100,000 条，超限必须缩小范围；不会静默截断。

多条同平台连接通过 `id` / `connection_id` 区分，不能用显示名称识别唯一连接。当前报价从 `/api/connections` 的 `settlement_rate` 读取；历史用量和账单 CSV 的 `rate` 是原冻结价格。账单预览各平台的 `ready_rates` 列出所选结算成员、本次未开票记录的不同冻结折扣（无记录时为空数组），不能用当前报价替代。

金额使用 USD 十进制字符串，最多 8 位小数；后端使用十进制计算，避免浮点误差。折扣写入值为 0–1 的数字，返回数据库中的折扣通常是十进制字符串。账单日期统一按 `Asia/Shanghai`，不是浏览器本地时区。日期参数为 `YYYY-MM-DD`。

## 上号流程

1. 查询 `/api/connections` 和 `/api/connections/:id/options`，确定平台连接、能力和可用配置。
2. `POST /api/accounts` 创建本人账号；`POST /api/proxies` 添加本人固定出口代理；`POST /api/accounts/:id/proxy` 以 `{proxyId}` 绑定或更换已核实账号的固定代理。该请求返回 `{account,jobs,reauthorizeConnectionIds}`，后台自动将同一账号代理同步到已接入的 平台 B / C / D；后续上号和重新授权自动沿用，不能逐个平台指定不同代理。平台 A 旧绑定如需重新授权，会列在 `reauthorizeConnectionIds`，完成 OAuth 即自动应用固定代理。原账号、平台绑定和财务历史保持不变。
3. `POST /api/accounts/:id/authorize`，提交 `{targets:[{connectionId,options:{}}],key}`，获得 `{jobs}`。每次逻辑操作使用新的 UUID 作为 `key`。
4. 轮询 `/api/jobs?id=<任务编号>`；授权链接生成后从 `/api/accounts/:id/attempts` 获取 `authorization_url`。每个平台分别授权，不能复用授权码。
5. `POST /api/oauth/:id/exchange`，其中 `:id` 是授权流程编号，提交 `{callback,key}`。四个平台均要求完整回调 URL 或 `code#state`，不能只提交 code；state 必须匹配目标流程，同一 code 不能跨平台重复提交。校验失败时流程保留为 pending，可纠正后提交。继续轮询任务，确认实际成功。授权链接必须不包含真实来源资料；如上游生成的链接暴露来源域名或名称，代理端不返回链接并提示联系管理员核对配置，不会改写签名或回调参数。
6. 平台 B / C / D 可用 `/api/accounts/:id/import-token` 代替 OAuth，提交 `{connectionId,refreshToken,options:{},key}`。RT 为一次性敏感凭据，不能写入自己的访问日志。

任务可能为 `queued`、`running`、`succeeded`、`failed`、`needs_attention`。只有 `succeeded` 表示完成；`needs_attention` 先人工核对上游，不能直接重复提交。代理固定绑定、每个平台配置和旧账号归属核对规则与网站完全一致，平台 C 使用服务端固定默认配置。

`GET /api/proxies` 仅返回调用者本人添加的代理，不包含上级、下级、兄弟或其他成员的代理；管理员也按本人范围返回。代理修改和账号绑定只能操作本人的代理及本人账号。团队账号列表仅保留其他成员账号是否已绑定代理、是否启用及各平台是否同步的状态，不暴露其代理 ID、名称或出口。一个账号固定绑定一条代理，同一代理不能重复占用。账号返回 `proxy_bound`、`proxy_sync_state`、`proxy_sync_error`，各平台绑定返回 `proxy_verified` 和 `usage_enabled`；可据此显示同步进度和失败原因。`POST /api/bindings/:id/status` 在平台 A 主账号具有管理员权限时修改上游状态；权限不足时，停用自动改为暂停 CCMAX 内使用，之后通过同一接口启用即可恢复。`POST /api/bindings/:id/local-status` 仍可由已核实账号本人或平台管理员显式暂停或恢复 CCMAX 内使用，不修改上游状态。

`POST /api/accounts/:id/proxy/sync` 提交 `{key}`，可在账号层统一重试代理同步；返回 `{jobs,reauthorizeConnectionIds}`，已有执行中的任务不会重复排队。旧的逐平台同步接口保留兼容。启用 平台 B / C / D 已有账号时，如尚未同步代理，服务端会先核对账号身份、自动应用并读回固定代理，再启用；失败会保留未核实状态。平台 A 旧绑定需重新授权时不会假报同步成功。

### 修复已有平台账号

`POST /api/bindings/:id/reauthorize`（`accounts:write`）提交 `{options:{},key}`，返回单个 `{id,state}` 任务。仅账号已核实的本人或管理员可用，授权流程和链接仍只返回给发起人。平台连接和账号固定代理必须已启用；各平台自动沿用账号代理，无需逐个平台重新选择或绑定，其他平台的代理同步状态不会阻塞本次授权。`options` 不能指定代理或上游目标 ID；服务端固定原绑定和代理。已有有效授权流程或执行中上号任务时返回 409，使用相同 key 和参数重试则返回原任务。

授权链接、回调、查询和单次 code 规则沿用上述流程。成功时只更新原绑定的授权状态、代理核实和同步时间；原平台 ID、归属、用量和财务历史保持原样。请授权原 Claude 邮箱；如上游 ID 或邮箱不符，任务为 `needs_attention`，不替换本地绑定，先人工核对上游实际结果。启停也先核对上游身份，写入后读回实际状态，不能仅凭受理响应显示成功。平台 A 启停须主账号具有上游管理员权限。

## 结算与重试

已有报价变更从次日北京时间生效，已封账价格保持固定。每日账单可由后台自动生成，`automatic` 标记自动出账，`estimated` 标记包含日终快照预估；用量的 `source_at` 是预估的数据截止时间。自动出账不代表回款确认。账单使用已封账日用量，按平台到直属代理再到下一级的顺序确认；提现先冻结可用余额，再由付款人登记打款或驳回。

上游改价保留下级原合同价，显示风险而不自动级联修改。`GET /api/team/pricing`（`read`）返回 `{today,effectiveDate,prices,risks,directUsers}`，只包含本人应收价、直属下级风险和成员，不包含上级合同或兄弟团队数据。`risks` 的 `kind` 为 `inverted`、`missing_own` 或 `missing_child`；倒挂的 `lossPer100Usd` 是每 $100 平台账单的损失。

`POST /api/team/rates/preview` 与 `POST /api/team/rates/batch` 要求 `team:write`。预览参数为 `{provider,userIds,mode,value?}`，最多 500 位不重复直属下级；`mode` 为 `fixed`（统一折扣）、`scale`（次日有效价乘以下调比例，向下截到四位）或 `cap`（仅降低超过本人次日应收价的部分）。`fixed/scale` 必须提供 0–1 的 `value`。未定价成员需用 `fixed` 补价。

预览返回 `{provider,effectiveDate,items,risks,changedCount,snapshot}`。核对每位成员当前/原次日/新次日价格、本人差价及被调整代理对其直属下级的风险。提交批量时携带相同参数和 `snapshot`；有风险还须 `acknowledgeRisk:true`。报价、团队或北京时间日期变化后返回 409，必须重新预览；不会部分写入。只修改次日价格，历史及其他平台不变；更深层级由各上级管理。

倒挂按冻结合同如实记负利润。确认后负数扣减本人余额，负余额不能新申请提现，后续利润先抵扣亏损。缺价、原始金额或归属不一致仍禁止入账或结算，来源核对与逐级确认仍必须完成。

接受 `key` 的任务、提现接口支持业务幂等：同一逻辑操作发生网络失败时使用同一 `key` 和完全相同的业务参数，不要把这个 `key` 用在不同请求上。其他写接口不要盲目重试，先查询最终状态。

账单确认前复核原冻结价格、完整代理收益链、明细归属和汇总金额；不是按今天的价格重新计算历史。提现及审核会自动核对利润来源、等额冻结和释放流水。提现审核以相同 `action` 和 `reference` 重试时返回原记录，不重复扣款或退回；已处理记录的冲突决定返回 409。`GET /api/finance` 的 `funds` 区分累计上游 gross、当前 gross 资金和已覆盖/未覆盖的团队待付款；这些准备金不会进入利润提现，CCMAX 也不会自动转账。实际支付仍由线下完成，付款后在下级账单填写凭证并确认，核对通过不能证明外部回款或现金准备金充足。

## 错误、限流和审计

错误形如 `{error, code, requestId}`。依据状态码和 `code` 判断结果，`error` 供人阅读，可能是中文或上游错误描述。

| HTTP / code | 含义 |
| --- | --- |
| 400 / `VALIDATION_ERROR` 或 `HTTP_400` | 参数或业务前提不满足 |
| 409 / `USAGE_ACCOUNTING_CONFLICT` | 冻结收益链、归属、付款关系或金额公式不一致 |
| 409 / `INVOICE_INTEGRITY_CONFLICT` | 账单为空，或明细、日期及汇总金额不一致 |
| 409 / `WALLET_INTEGRITY_CONFLICT` | 余额来源或原提现冻结/释放流水不一致 |
| 409 / `UPSTREAM_SETTLEMENT_REQUIRED` | 同一用量尚未被整条上级链的有效已确认账单和利润流水覆盖 |
| 400 / `AMOUNT_OUT_OF_RANGE` | 多条用量合计超出单笔账单范围，需缩短结算期间 |
| 401 / `INVALID_API_KEY` | 密钥无效、过期、撤销或所属账号停用 |
| 403 / `INSUFFICIENT_SCOPE` | 未授予所需权限 |
| 403 / `SESSION_REQUIRED` | 此接口只允许网页登录 |
| 403 / `HTTP_403` | 团队停用、资源归属或操作权限限制 |
| 404 | 资源不存在或对当前用户不可见 |
| 409 / `CONFLICT` 或 `HTTP_409` | 归属/状态冲突，或批量预览过期、风险未经明确确认 |
| 429 / `RATE_LIMITED` | 遵循 `Retry-After` 秒数退避 |
| 5xx | 服务器或上游暂时失败，先查询最终状态 |

API 密钥请求按**每个用户、每个应用实例 120 次/分钟**限流，多把密钥共享此额度；同时受现有每 IP 240 次/分钟限制。后台任务建议每几秒查询一次。初期仍按 README 使用一个应用副本，若扩容需先将限流存储改为共享存储。

API 写操作的额外审计记录密钥 ID、路由、状态码和请求 ID，具体业务操作继续记录原有审计。完整密钥、请求体、RT 和密码不进入 API 调用审计。请求与撤销可能并发，已在途请求及已提交后台任务不保证撤回。

本接口供二次开发工作台，不包含模型推理转发、CCMAX 模型 API Key 或令牌额度预扣。

## 上游模型活动查询

`read` 密钥可调用 `GET /api/telemetry` 与 `GET /api/telemetry/trend`。查询参数：`scope=self|descendants|team`（默认 team，含本人和全部下级）、`provider`、`accountId`、`connectionId`、`ownerId`（本人或自己子树内单个成员）、`search`、`period=today|5h|7d|30d`（默认 today），主查询另支持 `page`，每页 12 个平台绑定。所有汇总先按相同权限与条件筛选再分页；未核实归属账号不向代理开放。`ownerId` 表示精确成员筛选，覆盖 scope 的成员集合，但始终限制在调用者子树内。

主查询返回 `rows`、`total`、`page`、`pageSize`、`totals`、`platforms`、`members`。每项汇总为 `{value, covered, total}`：value 是十进制字符串或 null，covered 为有该项数据且快照有效的平台绑定数。一个 Claude 账号在两个平台有两个绑定，各平台调用分别计入。缺失、过期、停用、上游未检出的账号不当作零；未返回不等于无使用。

行内 `telemetry` 为严格白名单的账号运营数据：`activity`（rpm/tpm/concurrent/sessions）、`limits`、`quota`、`health`（24h 请求/成功/限流）、`periods`（请求数、Token、平台计费/官方原价/缓存补偿 USD、上游模型分类消费）、`sourceAt`、`collectedAt` 和 `modelsAt`。`detail=unavailable` 表示本轮没有补充详情；不代表列表中的指标无效。缓存 Token 和逐条日志目前缺乏安全的 Claude 账号归属来源，分别为 null 和 unavailable。

趋势返回 `samples`，每个点包含 `at`、RPM/TPM/并发的和及各项 `_covered`，只查询可见账号，最近 24 小时，5 分钟采样桶。缺口和覆盖差异需在客户端保留，不对采样求和还原请求数，不用来开结算账单。两个接口仅查询数据库，不触发上游请求，也不写账或发起资金转移。
