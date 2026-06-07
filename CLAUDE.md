# DeepSeek 用量查询 (deepseek-usage-monitor)

VSCode 扩展，帮助开发者在 VSCode 中实时查看 DeepSeek API 余额与用量，无需登录官网。

## 技术栈

- TypeScript 5.x + ESBuild 打包
- Axios（HTTP 请求）
- ECharts 5.5（用量图表，CDN 加载）
- VS Code SecretStorage（API Key / Token 加密存储）

## 项目结构

```
src/
├── extension.ts    # 入口：激活、命令注册、欢迎提示
├── api.ts          # DeepSeekAPI 类：余额/用量查询、CSV 解析、凭证管理
├── dashboard.ts    # DashboardViewProvider：侧边栏 WebView（HTML/CSS/JS 内联）
└── statusBar.ts    # StatusBarManager：状态栏余额显示、点击弹窗详情
```

## 核心架构

### 认证体系（双凭证）

| 凭证 | 用途 | 获取方式 |
|------|------|----------|
| API Key (`sk-*`) | 查余额 `/user/balance` | DeepSeek 官网 API Keys 页面 |
| Platform Token | 查用量 `/api/v0/usage/*` | platform.deepseek.com → F12 → LocalStorage → userToken |

两者独立存储于 `SecretStorage`，支持只配一种。

### 面板显示逻辑（dashboard.ts refresh()）

1. 无 Key 且无 Token → 发送 `needConfig`，显示欢迎界面
2. 有凭证 → 查余额（需 Key）+ 查用量（需 Token），合并后发送 `data`
3. 欢迎界面按钮状态由 `hasKey`/`hasToken` 字段控制:
   - 未配置 → "查询用量"按钮禁用
   - 已配置 → "查询用量"按钮启用，点击后加载面板

### 状态栏（statusBar.ts）

- 右侧状态栏显示 `DS: ¥余额`，颜色按阈值分三级（<2 红色 / <10 黄色 / 正常）
- 点击弹出详情：余额 + 今日/本月 Token + 费用
- 仅在 autoRefresh=true 时启动定时刷新

## 命令列表

| 命令 | 说明 |
|------|------|
| `deepseek-usage.setApiKey` | 设置 API Key（加密存储） |
| `deepseek-usage.setToken` | 设置平台 Token |
| `deepseek-usage.refresh` | 手动刷新余额 & 用量 |
| `deepseek-usage.openDashboard` | 打开侧边栏用量面板 |
| `deepseek-usage.importCsv` | 导入官方用量 CSV |
| `deepseek-usage.exportCsv` | 导出用量 CSV |
| `deepseek-usage.clearApiKey` | 清除 API Key |
| `deepseek-usage.clearToken` | 清除平台 Token |
| `deepseek-usage.clearConfig` | 清空全部配置 |

## 配置项

- `deepseekUsage.apiKey`：明文 API Key（不推荐，建议用命令）
- `deepseekUsage.autoRefresh`：自动刷新开关（默认 false）
- `deepseekUsage.refreshInterval`：刷新间隔秒数（默认 60，范围 10-3600）
- `deepseekUsage.baseUrl`：API 基础地址（默认 `https://api.deepseek.com`）

## 开发命令

```bash
npm run compile   # esbuild 构建
npm run watch     # esbuild watch 模式
npm run lint      # ESLint 检查
```

## 发布流程

每次提交前必须重新编译 VSIX 并同步到 `release/` 目录：

```bash
npm run compile && npx vsce package && cp deepseek-usage-monitor-*.vsix release/
git add -A && git commit -m "..." && git push
```

## 关键设计原则

- **零配置体验**：安装后通过状态栏/欢迎界面引导配置，不需要手动改 settings.json
- **安全第一**：API Key 和 Token 存 SecretStorage（系统级加密），不在 settings.json 明文存储
- **欢迎界面流**：配置凭证后不自动进入面板，用户通过"查询用量"按钮主动进入

## 参考项目

- [MiMo Usage Monitor](https://marketplace.visualstudio.com/items?itemName=Buggo404.mimo-usage-monitor) — UI/UX 对标参考

## API 端点详情

| 端点 | 域名 | 认证 | 说明 |
|------|------|------|------|
| `GET /user/balance` | api.deepseek.com | API Key (Bearer) | 余额查询 |
| `GET /api/v0/usage/amount` | platform.deepseek.com | Platform Token (Bearer) | Token 用量 |
| `GET /api/v0/usage/cost` | platform.deepseek.com | Platform Token (Bearer) | 费用查询 |

Platform Token 获取：浏览器登录 platform.deepseek.com → F12 → Application → Local Storage → `userToken`

## 历史决策

| 决策 | 原因 |
|------|------|
| 双凭证体系（API Key + Platform Token） | 余额和用量分属不同 API 域名，认证方式不同 |
| SecretStorage 存 Key | 安全，避免明文泄漏到 settings.json / git |
| 余额颜色编码 <2 红 / <10 黄 | 对标 MiMo 的警告阈值 |
| 配置后不自动进入面板 | 避免半配状态（如只配了 Key 还没配 Token）就加载失败 |
| ECharts CDN 加载 | 减小 VSIX 体积，加载时需 nonce 放开 CSP |

## 踩坑记录

| 问题 | 解决 |
|------|------|
| `/user/usage` 端点 404 | DeepSeek 无公开 Usage API，改用 CSV 导入方案 |
| CSP 阻止 ECharts CDN | 添加 nonce + `script-src` 白名单 |
| Platform Token 返回 401 | Token 需从浏览器 LocalStorage 提取（非 API Key） |
