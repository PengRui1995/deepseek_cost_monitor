# DeepSeek用量查询

在 VS Code 底部状态栏实时查看 DeepSeek API 余额与用量。

![](https://img.shields.io/badge/VS%20Code-%3E%3D1.100.0-blue)

## 功能

- **💰 状态栏余额** — 实时显示余额，颜色编码（黄 < ¥10，红 < ¥2）
- **📊 Token 用量** — 按天查看 Token 消耗，支持按模型分类
- **💵 费用统计** — 今日/本月花费一目了然
- **📈 ECharts 图表** — 侧边栏柱状图展示每日用量分布
- **🔄 自动刷新** — 默认 60 秒，可自定义间隔
- **📥 CSV 导入** — 支持导入 DeepSeek 官方导出的用量 CSV
- **🔒 加密存储** — API Key 和 Token 使用 VS Code SecretStorage 安全存储

## 快速开始

### 1. 设置 API Key（余额查询）
1. `Ctrl+Shift+P` → `DeepSeek: 设置 API Key`
2. 粘贴你的 DeepSeek API Key（以 `sk-` 开头）
3. 状态栏会立即显示余额

### 2. 设置 Platform Token（用量查询）
1. 浏览器打开 https://platform.deepseek.com 并登录
2. `F12` → `Application` → `Local Storage` → 复制 `userToken` 的值
3. `Ctrl+Shift+P` → `DeepSeek: 设置平台 Token` → 粘贴
4. 状态栏会显示今日消耗费用，侧边栏可查看详细图表

## 命令

| 命令 | 说明 |
|------|------|
| `DeepSeek: 设置 API Key` | 设置 API Key（余额查询） |
| `DeepSeek: 设置平台 Token` | 设置 Platform Token（用量查询） |
| `DeepSeek: 刷新余额` | 手动刷新数据 |
| `DeepSeek: 打开用量面板` | 打开侧边栏 Dashboard |
| `DeepSeek: 导入用量 CSV` | 导入 DeepSeek 官方导出的 CSV |
| `DeepSeek: 导出用量 CSV` | 导出当前用量数据 |
| `DeepSeek: 清除 API Key` | 清除已保存的 Key |
| `DeepSeek: 清除平台 Token` | 清除已保存的 Token |

## 设置项

| 设置 | 默认值 | 说明 |
|------|--------|------|
| `deepseekUsage.autoRefresh` | `true` | 启用自动刷新 |
| `deepseekUsage.refreshInterval` | `60` | 刷新间隔（秒） |
| `deepseekUsage.baseUrl` | `https://api.deepseek.com` | API 基础地址 |
| `deepseekUsage.apiKey` | `""` | API Key（推荐用命令设置） |

## 技术实现

- **余额**: `GET https://api.deepseek.com/user/balance` (API Key)
- **用量**: `GET https://platform.deepseek.com/api/v0/usage/amount` (Platform Token)
- **费用**: `GET https://platform.deepseek.com/api/v0/usage/cost` (Platform Token)

## 开发

```bash
npm install
npm run compile
# F5 启动调试
```

## 许可

MIT
