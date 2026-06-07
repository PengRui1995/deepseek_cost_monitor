# Progress Log — DeepSeek用量查询

## Session 2026-06-07

### ✅ 核心功能完成

| 功能 | 状态 | 说明 |
|------|------|------|
| 余额查询 | ✅ | `GET /user/balance` (API Key) |
| Token 用量 | ✅ | `GET /api/v0/usage/amount` (Platform Token) |
| 费用查询 | ✅ | `GET /api/v0/usage/cost` (Platform Token) |
| 状态栏显示 | ✅ | 余额 + 今日费用，颜色编码 |
| 自动刷新 | ✅ | 可配置间隔 |
| Sidebar Dashboard | ✅ | ECharts 图表 + 卡片 |
| CSV 导入/导出 | ✅ | DeepSeek 官方 CSV 兼容 |

### API 端点发现

| 端点 | 域名 | 认证 |
|------|------|------|
| `/user/balance` | api.deepseek.com | API Key (Bearer) |
| `/api/v0/usage/amount` | platform.deepseek.com | Platform Token (Bearer) |
| `/api/v0/usage/cost` | platform.deepseek.com | Platform Token (Bearer) |

### Token 获取
- 浏览器 → platform.deepseek.com → F12 → Local Storage → `userToken`
- 插件命令: `DeepSeek: 设置平台 Token`

### 待完成 (P1/P2)
- [ ] 多账号管理
- [ ] 用量预警
- [ ] README / 打包发布
