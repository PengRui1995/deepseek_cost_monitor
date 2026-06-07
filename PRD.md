目标
参考：https://marketplace.visualstudio.com/items?itemName=Buggo404.mimo-usage-monitor

帮助开发者在 VSCode 中实时查看 DeepSeek API 使用情况，无需登录官网。

用户场景
Claude Code 使用 DeepSeek
Cline 使用 DeepSeek
Continue 使用 DeepSeek
RooCode 使用 DeepSeek
OpenAI Compatible 接口转 DeepSeek
核心功能

P0：

状态栏余额
Token统计
手动刷新
自动刷新

P1：

WebView图表
多账号
Cost分析
导出CSV

P2：

用量预警
Slack通知
企业团队统计
可直接复用的技术栈
{
  "typescript": "^5.x",
  "axios": "^1.x",
  "echarts": "^5.x",
  "@types/vscode": "^1.100.0"
}

整体风格建议完全对标 mimo-usage-monitor：

StatusBar 实时指标
Sidebar Dashboard
ECharts 图表
自动刷新
零配置体验

这样最符合 VSCode 用户习惯，也最容易获得安装量。

具备扩展性，后续可能需要支持更多provider的用量查询