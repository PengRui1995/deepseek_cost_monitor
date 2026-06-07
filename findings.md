# Findings — DeepSeek API 用量监控插件

## DeepSeek API 接口调研

### 余额查询
- URL: `https://api.deepseek.com/user/balance`
- Method: GET
- Headers: `Authorization: Bearer <API_KEY>`
- Response:
```json
{
  "is_available": true,
  "balance_infos": [
    {
      "currency": "CNY",
      "total_balance": "100.00",
      "granted_balance": "50.00",
      "topped_up_balance": "50.00"
    }
  ]
}
```

### 用量查询
- URL: `https://api.deepseek.com/user/usage`
- Method: GET
- Query: `?start_date=2024-01-01&end_date=2024-01-31`
- Headers: `Authorization: Bearer <API_KEY>`
- Response:
```json
{
  "usage": [
    {
      "date": "2024-01-01",
      "model": "deepseek-chat",
      "input_tokens": 1000,
      "output_tokens": 500,
      "total_tokens": 1500,
      "cost": "0.05"
    }
  ]
}
```

> ⚠️ 以上为参考格式，实际以官方文档为准。需要验证。

---

## 对标插件分析（mimo-usage-monitor）
- 使用 StatusBar 显示核心指标（余额/Token）
- 使用 WebView 展示图表
- ECharts 5 做数据可视化
- 自动刷新间隔默认 60s
- 零配置：自动读取 VSCode settings 中的 API Key

---

## 技术决策

### API Key 存储
- 使用 VSCode `SecretStorage`（`context.secrets`）安全存储 API Key
- 避免明文存储在 settings.json 中
- 提供设置命令：`Set API Key`

### 刷新策略
- 自动刷新：默认 60s，可配置
- 手动刷新：命令面板 + StatusBar 点击
- 防抖：避免频繁调用 API

### WebView 资源加载
- ECharts 使用 CDN 或本地 bundle
- 推荐本地 bundle（离线可用）
- WebView 内使用 `webview.asWebviewUri` 加载本地资源

---

## 待验证
- [ ] DeepSeek API 实际响应格式
- [ ] 是否支持跨域（CORS）在 WebView 中
- [ ] ECharts 在 WebView 中的性能
