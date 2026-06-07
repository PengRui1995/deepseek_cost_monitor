# VSCode 插件：DeepSeek用量查询

## 目标
对标 MiMo Usage Monitor，开发 VSCode 插件帮助开发者在 VSCode 中实时查看 DeepSeek API 余额与用量。

## 参考
- MiMo Usage Monitor: https://marketplace.visualstudio.com/items?itemName=Buggo404.mimo-usage-monitor
- DeepSeek API 余额文档: https://api-docs.deepseek.com/zh-cn/api/get-user-balance

---

## 阶段规划

### Phase 1: 项目脚手架 ✔️
- [x] 初始化 VSCode Extension 项目
- [x] package.json（displayName: DeepSeek用量查询）
- [x] tsconfig、eslint
- [x] .vscode/launch.json + tasks.json
- [x] .gitignore、.vscodeignore
- [x] media/icon.svg（activitybar 图表图标）

### Phase 2: API 数据层 ✔️
- [x] DeepSeekAPI 类 — axios 封装
- [x] getBalance() — `GET /user/balance`（官方接口，已验证可用）
- [x] SecretStorage 加密存储 API Key
- [x] CSV 用量解析（DeepSeek 无公开 Usage API，数据从 Web 平台导出）

### Phase 3: StatusBar（对标 MiMo）✔️
- [x] 底部状态栏实时显示余额
- [x] 颜色编码：正常 / 低余额黄(警告) / 严重低红(错误)
- [x] 点击状态栏弹出详情
- [x] 自动刷新（默认60秒）
- [x] 手动刷新命令

### Phase 4: Sidebar Dashboard ✔️
- [x] WebView 侧边栏面板
- [x] 余额卡片（总余额、充值、赠送）
- [x] 用量统计（今日/本月 Token、记录数、费用）
- [x] ECharts 堆叠柱状图（按日期按模型）
- [x] CSP nonce 安全策略

### Phase 5: CSV 导入/导出 ✔️
- [x] 导入 DeepSeek 官方 CSV
- [x] 智能列名匹配（中英文兼容）
- [x] 导出 CSV

### Phase 6: 优化与发布
- [ ] 验证真实 API Key 测试
- [ ] 修复 CDN ECharts 加载（改本地 bundle）
- [ ] README、CHANGELOG
- [ ] 打包 vsce package

### P2（后续版本）
- [ ] 用量预警通知
- [ ] 多账号管理
- [ ] 更多 Provider 支持

---

## 关键决策
| 决策 | 原因 |
|------|------|
| 不调用 Usage API | DeepSeek 无公开 /user/usage 端点，改为 CSV 导入方案 |
| StatusBar 为主 UI | 对标 MiMo，点击弹详情，侧边栏为辅 |
| 余额颜色编码 | 对标 MiMo：黄(<¥10) / 红(<¥2) |
| SecretStorage 存 Key | 安全，对标 MiMo 的 Cookie 存储方式 |

## 错误记录
| 错误 | 解决 |
|------|------|
| `/user/usage` 404 | 移除该调用，改为 CSV 导入 |
| handleError 弹窗干扰 | 改为 console.error 静默，仅 401/403/429 提示 |
| CSP 阻止 ECharts CDN | 添加 nonce + script-src |
