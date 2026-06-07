import * as vscode from 'vscode';
import { DeepSeekAPI } from './api';
import { StatusBarManager } from './statusBar';
import { DashboardViewProvider } from './dashboard';
import { extractTokenViaCDP } from './browserAuth';

export function activate(context: vscode.ExtensionContext) {
    console.log('DeepSeek用量查询 已激活');

    const api = new DeepSeekAPI(context);
    const statusBar = new StatusBarManager(context, api);
    const dashboard = new DashboardViewProvider(context.extensionUri, api);

    // 侧边栏 WebView
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(DashboardViewProvider.viewType, dashboard)
    );

    // === 首次安装欢迎提示 ===
    const HAS_SHOWN_WELCOME = 'deepseekUsage.welcomeShown';
    if (!context.globalState.get<boolean>(HAS_SHOWN_WELCOME)) {
        context.globalState.update(HAS_SHOWN_WELCOME, true);
        // 延迟显示，等窗口完全加载
        setTimeout(() => _showWelcome(), 1500);
    }

    // === 同步用量数据 ===
    function syncUsage(records: ReturnType<typeof api.parseUsageCsv>) {
        if (records.length > 0) {
            const existing = new Map(statusBar.usageRecords.map(r => [`${r.date}-${r.model}`, r]));
            for (const u of records) existing.set(`${u.date}-${u.model}`, u);
            statusBar.usageRecords = Array.from(existing.values());
            dashboard.usageRecords = statusBar.usageRecords;
        }
    }

    // === 命令注册 ===

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
                // 不自动进入面板，仅通知欢迎界面更新按钮状态
                dashboard.notifyConfigChanged();
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
                prompt: '请输入 DeepSeek 平台 Token（推荐使用"登录获取"命令自动提取）',
                password: true,
                ignoreFocusOut: true,
                placeHolder: '粘贴 Token 到此处',
                validateInput: v => !v?.trim() ? 'Token 不能为空' : null
            });
            if (token) {
                await api.setPlatformToken(token.trim());
                vscode.window.showInformationMessage('Platform Token 已保存 ✅');
                dashboard.notifyConfigChanged();
            }
        })
    );

    // 登录平台自动获取 Token（通过 CDP，对标 MiMo）
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.loginPlatform', async () => {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '正在启动浏览器...' },
                async (progress) => {
                    try {
                        progress.report({ message: '请在浏览器中登录 DeepSeek' });
                        const token = await extractTokenViaCDP();
                        if (token) {
                            await api.setPlatformToken(token);
                            vscode.window.showInformationMessage('✅ Token 已自动获取并保存！');
                            dashboard.notifyConfigChanged();
                        } else {
                            vscode.window.showErrorMessage('未能提取 Token，请尝试手动设置');
                        }
                    } catch (err) {
                        vscode.window.showErrorMessage(
                            `自动登录失败: ${(err as Error).message || '未知错误'}。请使用"设置平台 Token"手动粘贴`
                        );
                    }
                }
            );
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

    // 清空全部配置（API Key + Platform Token）
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.clearConfig', async () => {
            const ok = await vscode.window.showWarningMessage(
                '确定清空全部配置？（平台 Token 将被删除）',
                '确定清空', '取消'
            );
            if (ok === '确定清空') {
                await api.clearApiKey();
                await api.clearPlatformToken();
                statusBar.usageRecords = [];
                dashboard.usageRecords = [];
                await statusBar.refresh();
                dashboard.refresh();
                vscode.window.showInformationMessage('已清空全部配置 ✅');
            }
        })
    );

    // 点击状态栏 → 详情
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.showDetail', () => statusBar.showDetail())
    );

    // 手动刷新
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
    // 状态栏自动检测凭证并决定是否启动刷新
}

export function deactivate() {
    console.log('DeepSeek用量查询 已停用');
}

// ========== 首次安装欢迎提示 ==========

async function _showWelcome(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
        '👋 欢迎使用 DeepSeek用量查询！',
        { modal: false },
        '登录获取 Token',
        '手动设置 Token',
        '查看使用说明'
    );

    if (choice === '登录获取 Token') {
        vscode.commands.executeCommand('deepseek-usage.loginPlatform');
    } else if (choice === '手动设置 Token') {
        vscode.commands.executeCommand('deepseek-usage.setToken');
    } else if (choice === '查看使用说明') {
        const readme = vscode.Uri.parse('https://github.com/PengRui1995/deepseek_cost_monitor#readme');
        vscode.env.openExternal(readme);
    }
}

