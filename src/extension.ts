import * as vscode from 'vscode';
import { DeepSeekAPI } from './api';
import { GLMProvider } from './platforms/glm/provider';
import { PlatformRegistry } from './platforms/registry';
import { StatusBarManager } from './statusBar';
import { DashboardViewProvider, PlatformMeta } from './dashboard';
import { extractTokenViaCDP, extractTokenViaCDPWithConfig } from './browserAuth';

// 全局引用，用于平台切换
let registry: PlatformRegistry;
let statusBar: StatusBarManager;
let dashboard: DashboardViewProvider;

/** 所有平台的 WebView 元数据 */
const PLATFORM_META: PlatformMeta[] = [
    { id: 'deepseek', displayName: 'DeepSeek', color: '#4F8FF7', loginCommand: 'deepseek-usage.loginPlatform', setTokenCommand: 'deepseek-usage.setToken' },
    { id: 'glm', displayName: '智谱GLM', color: '#A78BFA', loginCommand: 'llm-usage.loginGLM', setTokenCommand: 'llm-usage.setGLMToken' },
];

export function activate(context: vscode.ExtensionContext) {
    console.log('LLM用量查询 已激活');

    // 初始化平台注册中心
    registry = new PlatformRegistry(context);
    const active = registry.active;

    // 初始化 UI 组件（传入平台列表）
    statusBar = new StatusBarManager(context, active);
    dashboard = new DashboardViewProvider(context.extensionUri, active, PLATFORM_META);

    // 侧边栏 WebView
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(DashboardViewProvider.viewType, dashboard)
    );

    // === 首次安装欢迎提示 ===
    const HAS_SHOWN_WELCOME = 'deepseekUsage.welcomeShown';
    if (!context.globalState.get<boolean>(HAS_SHOWN_WELCOME)) {
        context.globalState.update(HAS_SHOWN_WELCOME, true);
        setTimeout(() => _showWelcome(active.displayName), 1500);
    }

    // === 用量数据同步 ===
    function syncUsage(records: ReturnType<typeof active.parseUsageCsv>) {
        if (records.length > 0) {
            const existing = new Map(statusBar.usageRecords.map(r => [`${r.date}-${r.model}`, r]));
            for (const u of records) existing.set(`${u.date}-${u.model}`, u);
            statusBar.usageRecords = Array.from(existing.values());
            dashboard.usageRecords = statusBar.usageRecords;
        }
    }

    // === 核心命令注册 ===

    // 设置 API Key（DeepSeek 专用，向后兼容）
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.setApiKey', async () => {
            const ds = registry.get('deepseek') as DeepSeekAPI;
            const key = await vscode.window.showInputBox({
                prompt: '请输入 DeepSeek API Key',
                password: true,
                ignoreFocusOut: true,
                validateInput: v =>
                    !v?.trim() ? 'API Key 不能为空' :
                    !v.startsWith('sk-') ? 'API Key 应以 sk- 开头' : null
            });
            if (key) {
                await ds.setApiKey(key.trim());
                vscode.window.showInformationMessage('DeepSeek API Key 已保存 ✅');
                _switchToPlatform('deepseek');
                dashboard.notifyConfigChanged();
            }
        })
    );

    // 清除 API Key
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.clearApiKey', async () => {
            const ok = await vscode.window.showWarningMessage('确定清除 API Key？', '确定', '取消');
            if (ok === '确定') {
                const ds = registry.get('deepseek') as DeepSeekAPI;
                await ds.clearApiKey();
                if (registry.active.id === 'deepseek') {
                    statusBar.usageRecords = [];
                    dashboard.usageRecords = [];
                    await statusBar.refresh();
                    dashboard.refresh();
                }
                vscode.window.showInformationMessage('API Key 已清除');
            }
        })
    );

    // 设置 Platform Token（DeepSeek 专用）
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.setToken', async () => {
            const ds = registry.get('deepseek') as DeepSeekAPI;
            const token = await vscode.window.showInputBox({
                prompt: '请输入 DeepSeek 平台 Token',
                password: true,
                ignoreFocusOut: true,
                placeHolder: '粘贴 Token 到此处',
                validateInput: v => !v?.trim() ? 'Token 不能为空' : null
            });
            if (token) {
                await ds.setPlatformToken(token.trim());
                vscode.window.showInformationMessage('Platform Token 已保存 ✅');
                _switchToPlatform('deepseek');
                dashboard.notifyConfigChanged();
            }
        })
    );

    // 登录 DeepSeek 平台
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.loginPlatform', async () => {
            await _cdpLogin('deepseek', 'DeepSeek');
        })
    );

    // 清除 DeepSeek Token
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.clearToken', async () => {
            const ok = await vscode.window.showWarningMessage('确定清除 DeepSeek 平台 Token？', '确定', '取消');
            if (ok === '确定') {
                const ds = registry.get('deepseek') as DeepSeekAPI;
                await ds.clearPlatformToken();
                vscode.window.showInformationMessage('Platform Token 已清除');
            }
        })
    );

    // ====== GLM 命令 ======

    // 设置 GLM Token
    context.subscriptions.push(
        vscode.commands.registerCommand('llm-usage.setGLMToken', async () => {
            const glm = registry.get('glm') as GLMProvider;
            const token = await vscode.window.showInputBox({
                prompt: '请输入 GLM JWT Token（推荐使用"登录GLM"命令自动提取）',
                password: true,
                ignoreFocusOut: true,
                placeHolder: '粘贴 JWT Token 到此处',
                validateInput: v => !v?.trim() ? 'Token 不能为空' : null
            });
            if (token) {
                await glm.setJwt(token.trim());
                vscode.window.showInformationMessage('GLM Token 已保存 ✅');
                _switchToPlatform('glm');
                dashboard.notifyConfigChanged();
            }
        })
    );

    // 登录 GLM 平台
    context.subscriptions.push(
        vscode.commands.registerCommand('llm-usage.loginGLM', async () => {
            await _cdpLogin('glm', '智谱AI');
        })
    );

    // 清除 GLM Token
    context.subscriptions.push(
        vscode.commands.registerCommand('llm-usage.clearGLMToken', async () => {
            const ok = await vscode.window.showWarningMessage('确定清除 GLM Token？', '确定', '取消');
            if (ok === '确定') {
                const glm = registry.get('glm') as GLMProvider;
                await glm.clearJwt();
                vscode.window.showInformationMessage('GLM Token 已清除');
            }
        })
    );

    // ====== 通用命令 ======

    // 切换平台（命令面板）
    context.subscriptions.push(
        vscode.commands.registerCommand('llm-usage.switchPlatform', async () => {
            const platforms = registry.list();
            const items = platforms.map(p => ({
                label: p.id === registry.active.id ? `$(check) ${p.displayName}` : p.displayName,
                description: p.id === registry.active.id ? '当前' : '',
                id: p.id,
            }));
            const choice = await vscode.window.showQuickPick(items, {
                placeHolder: '选择监控平台',
            });
            if (choice) {
                await _switchToPlatform(choice.id);
            }
        })
    );

    // 切换平台（WebView 面板直接指定 ID）
    context.subscriptions.push(
        vscode.commands.registerCommand('llm-usage.switchToPlatform', async (platformId: string) => {
            if (platformId && registry.get(platformId)) {
                await _switchToPlatform(platformId);
            }
        })
    );

    // 清空全部配置
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.clearConfig', async () => {
            const ok = await vscode.window.showWarningMessage(
                '确定清空全部平台配置？',
                '确定清空', '取消'
            );
            if (ok === '确定清空') {
                for (const p of registry.list()) {
                    await p.clearCredentials();
                }
                statusBar.usageRecords = [];
                dashboard.usageRecords = [];
                await statusBar.refresh();
                dashboard.refresh();
                vscode.window.showInformationMessage('已清空全部配置 ✅');
            }
        })
    );

    // 状态栏点击 → 详情
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.showDetail', () => statusBar.showDetail())
    );

    // 手动刷新
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-usage.refresh', () =>
            vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: '刷新用量...' },
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
                title: '导入用量 CSV'
            });
            if (!uris?.length) return;
            const data = await vscode.workspace.fs.readFile(uris[0]);
            const records = registry.active.parseUsageCsv(Buffer.from(data).toString('utf-8'));
            if (!records.length) {
                vscode.window.showWarningMessage('CSV 解析失败，请使用官方导出的文件');
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
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`${registry.active.id}-usage.csv`),
                filters: { 'CSV': ['csv'] }
            });
            if (uri) { await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf-8')); vscode.window.showInformationMessage('已导出'); }
        })
    );

    context.subscriptions.push(statusBar);

    // ====== 内部辅助 ======

    async function _switchToPlatform(id: string): Promise<void> {
        const provider = registry.switchTo(id);
        await registry.persist(context);
        statusBar.setProvider(provider);
        dashboard.setProvider(provider);
        dashboard.notifyPlatformChanged();
        vscode.window.showInformationMessage(`已切换到 ${provider.displayName}`);
    }

    async function _cdpLogin(platformId: string, displayName: string): Promise<void> {
        const provider = registry.get(platformId);
        const config = provider?.loginConfig;
        if (!config || !provider) {
            vscode.window.showErrorMessage(`${displayName} 不支持自动登录`);
            return;
        }
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: '正在启动浏览器...' },
            async (progress) => {
                try {
                    progress.report({ message: `请在浏览器中登录 ${displayName}` });
                    const token = await extractTokenViaCDPWithConfig(config);
                    if (token) {
                        // 根据平台类型存储
                        if (platformId === 'deepseek') {
                            await (provider as DeepSeekAPI).setPlatformToken(token);
                        } else if (platformId === 'glm') {
                            await (provider as GLMProvider).setJwt(token);
                        }
                        vscode.window.showInformationMessage(`✅ ${displayName} Token 已自动获取并保存！`);
                        _switchToPlatform(platformId);
                        dashboard.notifyConfigChanged();
                    } else {
                        vscode.window.showErrorMessage('未能提取 Token，请尝试手动设置');
                    }
                } catch (err) {
                    vscode.window.showErrorMessage(
                        `自动登录失败: ${(err as Error).message || '未知错误'}。请使用手动设置`
                    );
                }
            }
        );
    }
}

export function deactivate() {
    console.log('LLM用量查询 已停用');
}

// ========== 首次安装欢迎提示 ==========

async function _showWelcome(displayName: string): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
        `👋 欢迎使用 ${displayName}用量查询！`,
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
