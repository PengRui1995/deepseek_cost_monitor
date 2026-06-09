# LLM 用量监控 (llm-usage-monitor)

VSCode 扩展，帮助开发者在 VSCode 中实时查看多平台 AI API 余额与用量，无需登录官网。

支持平台：**DeepSeek** · **智谱GLM** · **小米MiMo**（可扩展更多）

## 技术栈

- TypeScript 5.x + ESBuild 打包
- Axios（HTTP 请求）
- ECharts 5.5（用量图表，CDN 加载）
- VS Code SecretStorage（凭证加密存储）
- Chrome DevTools Protocol（浏览器自动提取凭证）

## 项目结构

```
src/
├── extension.ts              # 入口：命令注册、平台切换
├── api.ts                    # 向后兼容 re-export（DeepSeekAPI = DeepSeekProvider）
├── dashboard.ts              # DashboardViewProvider：侧边栏 WebView
├── statusBar.ts              # StatusBarManager：状态栏 + 悬停详情
├── browserAuth.ts            # CDP 通用工具：localStorage / cookie 凭证提取
└── platforms/
    ├── types.ts              # PlatformProvider 接口 + 通用数据模型
    ├── registry.ts           # PlatformRegistry：平台注册/切换/持久化
    ├── deepseek/
    │   └── provider.ts       # DeepSeekProvider：余额+用量+CSV
    ├── glm/
    │   └── provider.ts       # GLMProvider：余额+账单+用量
    └── mimo/
        └── provider.ts       # MimoProvider：余额+Token Plan 用量
```

## 核心架构

### PlatformProvider 接口

每个平台实现此接口，dashboard/statusBar 完全与平台解耦：

```typescript
interface PlatformProvider {
    id: string;                      // 'deepseek' | 'glm'
    displayName: string;             // 面板/状态栏显示
    statusBarPrefix: string;         // 'DS' | 'GLM'
    currencyUnit: string;
    warningThresholds: { low, critical };
    loginConfig: CdpLoginConfig | null;

    isConfigured(): Promise<boolean>;
    clearCredentials(): Promise<void>;
    getBalance(): Promise<BalanceInfo[]>;
    getUserSummary(): Promise<UserSummary | null>;
    getUsage(start, end): Promise<UsageRecord[]>;
    parseUsageCsv(content): UsageRecord[];
}
```

### 认证模型对比

| 平台 | 凭证 | 来源 | 余额 API | 用量 API |
|------|------|------|----------|----------|
| **DeepSeek** | API Key + Platform Token | localStorage `userToken` | `GET /user/balance` | `GET /api/v0/usage/amount` |
| **智谱GLM** | JWT Token（单一凭证） | cookie `bigmodel_token_production` | `GET /api/biz/account/query-customer-account-report` | `GET /api/monitor/usage/model-usage` |
| **小米MiMo** | Cookie（小米账号 SSO） | 全部 cookie（含 HttpOnly） | `GET /api/v1/balance` | `GET /tokenPlan/usage` |

### 平台选择器

面板顶部 `<select>` 下拉切换平台，发送 `switchPlatform` 消息 → extension 切换 Provider → 状态栏/面板同步刷新。

### WebView 消息协议

每条消息携带平台上下文：

```typescript
{
    command: 'needConfig' | 'data',
    platformId: string;          // 当前平台 ID
    displayName: string;          // 显示名称
    currencyUnit: string;         // 货币单位
    platforms: PlatformMeta[];    // 所有可选平台
    // ...原有数据字段
}
```

## 命令列表

| 命令 | 说明 |
|------|------|
| `deepseek-usage.setApiKey` | DeepSeek: 设置 API Key |
| `deepseek-usage.setToken` | DeepSeek: 设置平台 Token |
| `deepseek-usage.loginPlatform` | DeepSeek: 登录获取 Token（CDP） |
| `deepseek-usage.refresh` | 手动刷新余额 & 用量 |
| `deepseek-usage.openDashboard` | 打开侧边栏用量面板 |
| `deepseek-usage.importCsv` | 导入用量 CSV |
| `deepseek-usage.exportCsv` | 导出用量 CSV |
| `deepseek-usage.clearApiKey` | 清除 API Key |
| `deepseek-usage.clearToken` | 清除平台 Token |
| `deepseek-usage.clearConfig` | 清空全部配置 |
| `llm-usage.setGLMToken` | GLM: 设置 Token |
| `llm-usage.loginGLM` | GLM: 登录获取 Token（CDP） |
| `llm-usage.clearGLMToken` | GLM: 清除 Token |
| `llm-usage.switchPlatform` | 切换监控平台（命令面板） |
| `llm-usage.setMimoCookie` | MiMo: 设置 Cookie |
| `llm-usage.loginMimo` | MiMo: 登录获取 Cookie（CDP） |
| `llm-usage.clearMimoToken` | MiMo: 清除 Cookie |

## 配置项

- `deepseekUsage.apiKey`：DeepSeek 明文 API Key（不推荐，建议用命令）
- `deepseekUsage.autoRefresh`：自动刷新开关（默认 false）
- `deepseekUsage.refreshInterval`：刷新间隔秒数（默认 60，范围 10-3600）
- `deepseekUsage.baseUrl`：DeepSeek API 基础地址

## 扩展新平台

只需实现 `PlatformProvider` 接口，然后在 `registry.ts` 和 `extension.ts` 的 `PLATFORM_META` 中注册：

```typescript
// 1. 创建 src/platforms/xxx/provider.ts
class XXXProvider implements PlatformProvider { ... }

// 2. registry.ts 注册
this.providers.set(xxx.id, xxx);

// 3. extension.ts 添加元数据
{ id: 'xxx', displayName: 'XXX', loginCommand: '...', setTokenCommand: '...' }
```

## 开发命令

```bash
npm run compile   # esbuild 构建
npm run watch     # esbuild watch 模式
npm run lint      # ESLint 检查
```

## 历史决策

| 决策 | 原因 |
|------|------|
| PlatformProvider 接口抽象 | 解耦平台实现，Dashboard/StatusBar 不感知具体平台 |
| 双凭证体系（DeepSeek） | 余额和用量分属不同 API 域名，认证方式不同 |
| Cookie JWT 提取（GLM） | GLM web 控制台用 cookie 认证，CDP 需支持 cookie 读取 |
| CdpLoginConfig.credentialSource | 支持 localStorage 和 cookie 两种凭证来源 |
| SecretStorage 存凭证 | 安全，避免明文泄漏到 settings.json / git |
| ECharts CDN 加载 | 减小 VSIX 体积，加载时需 nonce 放开 CSP |
| 面板平台选择器 | 消息携带平台列表，WebView 动态渲染，无需重建 |

## 踩坑记录

| 问题 | 解决 |
|------|------|
| `/user/usage` 端点 404 | DeepSeek 无公开 Usage API，改用 CSV 导入方案 |
| CSP 阻止 ECharts CDN | 添加 nonce + `script-src` 白名单 |
| Platform Token 返回 401 | Token 需从浏览器 LocalStorage 提取（非 API Key） |
| GLM 余额 API 需 cookie | CDP 支持 cookie 提取，非 localStorage |
| MiMo 需 HttpOnly cookie | CDP `Network.getCookies` 提取全部 cookie（含 HttpOnly） |
| MiMo API 无公开文档 | 通过 CDP 网络嗅探 + JS Bundle 逆向分析发现端点 |
