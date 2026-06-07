import * as vscode from 'vscode';
import { DeepSeekAPI } from './api';
import { StatusBarManager } from './statusBar';
import { DashboardViewProvider } from './dashboard';

export function activate(context: vscode.ExtensionContext) {
    console.log('DeepSeek用量查询 已激活');

    const api = new DeepSeekAPI(context);
    const statusBar = new StatusBarManager(context, api);
    const dashboard = new DashboardViewProvider(context.extensionUri, api);

    // 侧边栏 WebView
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(DashboardViewProvider.viewType, dashboard)
    );

    // === 命令注册 ===

    function syncUsage(records: ReturnType<typeof api.parseUsageCsv>) {
        if (records.length > 0) {
            const existing = new Map(statusBar.usageRecords.map(r => [`${r.date}-${r.model}`, r]));
            for (const u of records) existing.set(`${u.date}-${u.model}`, u);
            statusBar.usageRecords = Array.from(existing.values());
            dashboard.usageRecords = statusBar.usageRecords;
        }
    }

    // 设置 API Key
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.setApiKey', async () => {
            const key = await vscode.window.showInputBox({
                prompt: '请输入 DeepSeek API Key',
                password: true,
                ignoreFocusOut: true,
                validateInput: v =>
                    !v?.trim() ? 'API Key 不能为空' :
                    !v.startsWith('sk-') ? 'API Key 应以 sk- 开头' : null
            });
            if (key) {
                await api.setApiKey(key.trim());
                vscode.window.showInformationMessage('DeepSeek API Key 已保存 ✅');
                await statusBar.refresh();
                dashboard.refresh();
            }
        })
    );

    // 清除 API Key
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.clearApiKey', async () => {
            const ok = await vscode.window.showWarningMessage('确定清除 API Key？', '确定', '取消');
            if (ok === '确定') {
                await api.clearApiKey();
                statusBar.usageRecords = [];
                dashboard.usageRecords = [];
                await statusBar.refresh();
                dashboard.refresh();
                vscode.window.showInformationMessage('API Key 已清除');
            }
        })
    );

    // 设置 Platform Token
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.setToken', async () => {
            const token = await vscode.window.showInputBox({
                prompt: '请输入 platform.deepseek.com 的 Token',
                password: true,
                ignoreFocusOut: true,
                placeHolder: '浏览器 F12 → Application → Local Storage → userToken',
                validateInput: v => !v?.trim() ? 'Token 不能为空' : null
            });
            if (token) {
                await api.setPlatformToken(token.trim());
                vscode.window.showInformationMessage('Platform Token 已保存 ✅');
                await statusBar.refresh();
                dashboard.refresh();
            }
        })
    );

    // 清除 Platform Token
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.clearToken', async () => {
            const ok = await vscode.window.showWarningMessage('确定清除 Platform Token？', '确定', '取消');
            if (ok === '确定') {
                await api.clearPlatformToken();
                vscode.window.showInformationMessage('Platform Token 已清除');
            }
        })
    );

    // 点击状态栏 → 详情
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.showDetail', () => statusBar.showDetail())
    );

    // 刷新
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.refresh', () =>
            vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: '刷新 DeepSeek...' },
                async () => { await statusBar.refresh(); dashboard.refresh(); }
            )
        )
    );

    // 打开面板
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.openDashboard', () =>
            vscode.commands.executeCommand('deepseekUsage.dashboard.focus')
        )
    );

    // 导入 CSV
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.importCsv', async () => {
            const uris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { 'CSV': ['csv'] },
                title: '导入 DeepSeek 用量 CSV'
            });
            if (!uris?.length) return;
            const data = await vscode.workspace.fs.readFile(uris[0]);
            const records = api.parseUsageCsv(Buffer.from(data).toString('utf-8'));
            if (!records.length) {
                vscode.window.showWarningMessage('CSV 解析失败，请使用 DeepSeek 官方导出文件');
                return;
            }
            syncUsage(records);
            await statusBar.refresh();
            dashboard.refresh();
            vscode.window.showInformationMessage(`已导入 ${records.length} 条用量记录`);
        })
    );

    // 导出 CSV
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.exportCsv', async () => {
            const records = dashboard.usageRecords;
            if (!records.length) { vscode.window.showWarningMessage('暂无用量数据'); return; }
            const h = ['date', 'model', 'input_tokens', 'output_tokens', 'total_tokens', 'cost'];
            const csv = [h.join(','), ...records.map(r => [r.date, r.model, r.input_tokens, r.output_tokens, r.total_tokens, r.cost].join(','))].join('\n');
            const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file('deepseek-usage.csv'), filters: { 'CSV': ['csv'] } });
            if (uri) { await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf-8')); vscode.window.showInformationMessage('已导出'); }
        })
    );

    context.subscriptions.push(statusBar);
    statusBar.refresh();
}

export function deactivate() {
    console.log('DeepSeek用量查询 已停用');
}
