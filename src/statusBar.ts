import * as vscode from 'vscode';
import { DeepSeekAPI, BalanceInfo, UsageRecord } from './api';

enum Level { Normal, Low, Critical }

export class StatusBarManager implements vscode.Disposable {
    private item: vscode.StatusBarItem;
    private api: DeepSeekAPI;
    private timer?: NodeJS.Timeout;
    usageRecords: UsageRecord[] = [];

    constructor(context: vscode.ExtensionContext, api: DeepSeekAPI) {
        this.api = api;
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = 'deepseek-usage.showDetail';
        this.item.text = '$(pulse) DeepSeek';
        this.item.tooltip = 'DeepSeek用量查询';
        this.item.show();
        this._startAutoRefresh();
    }

    // ========== 刷新 ==========

    async refresh(): Promise<void> {
        try {
            const key = await this.api.getApiKey();
            if (!key) {
                this.item.text = '$(pulse) DeepSeek: 未配置';
                this.item.backgroundColor = undefined;
                return;
            }

            const balance = await this.api.getBalance();

            // 获取今日用量
            const today = new Date().toISOString().split('T')[0];
            const usage = await this.api.getUsage(today, today).catch(() => []);

            if (usage.length > 0) {
                const map = new Map(this.usageRecords.map(r => [`${r.date}-${r.model}`, r]));
                for (const u of usage) map.set(`${u.date}-${u.model}`, u);
                this.usageRecords = Array.from(map.values());
            }

            this._update(balance);

        } catch {
            this.item.text = '$(error) DeepSeek: 查询失败';
            this.item.backgroundColor = undefined;
        }
    }

    // ========== 点击弹窗 ==========

    async showDetail(): Promise<void> {
        const key = await this.api.getApiKey();
        if (!key) {
            const a = await vscode.window.showInformationMessage(
                'DeepSeek — 未配置', '设置 API Key', '设置平台 Token', '取消'
            );
            if (a === '设置 API Key') vscode.commands.executeCommand('deepseek-usage.setApiKey');
            if (a === '设置平台 Token') vscode.commands.executeCommand('deepseek-usage.setToken');
            return;
        }

        try {
            const balance = await this.api.getBalance();
            this._update(balance);

            const totalBal = balance.reduce((s: number, b: BalanceInfo) => s + parseFloat(b.total_balance || '0'), 0);
            const toppedUp = balance.reduce((s: number, b: BalanceInfo) => s + parseFloat(b.topped_up_balance || '0'), 0);
            const granted = balance.reduce((s: number, b: BalanceInfo) => s + parseFloat(b.granted_balance || '0'), 0);
            const currency = balance[0]?.currency || 'CNY';

            const today = new Date().toISOString().split('T')[0];
            const month = today.slice(0, 7);
            const todayRecords = this.usageRecords.filter(u => u.date === today);
            const todayTokens = todayRecords.reduce((s: number, u: UsageRecord) => s + u.total_tokens, 0);
            const todayCost = todayRecords.reduce((s: number, u: UsageRecord) => s + (u.cost || 0), 0);
            const monthTokens = this.usageRecords.filter(u => u.date.startsWith(month))
                .reduce((s: number, u: UsageRecord) => s + u.total_tokens, 0);
            const monthCost = this.usageRecords.filter(u => u.date.startsWith(month))
                .reduce((s: number, u: UsageRecord) => s + (u.cost || 0), 0);

            const lines = [
                `💰 余额: ¥${totalBal.toFixed(2)}（充值${toppedUp.toFixed(2)} + 赠送${granted.toFixed(2)}）`,
            ];
            if (this.usageRecords.length > 0) {
                lines.push(`📈 今日: ${this._fmt(todayTokens)} Token`);
                if (todayCost > 0) lines.push(`💵 今日费用: ¥${todayCost.toFixed(4)}`);
                lines.push(`📅 本月: ${this._fmt(monthTokens)} Token`);
                if (monthCost > 0) lines.push(`💵 本月费用: ¥${monthCost.toFixed(4)}`);
            } else {
                lines.push('⚠️ 暂无用量数据');
            }

            await vscode.window.showInformationMessage(
                `DeepSeek: ¥${totalBal.toFixed(2)}`,
                { modal: false, detail: lines.filter(Boolean).join(' | ') },
                '刷新', '打开面板', '导入CSV'
            ).then(a => {
                if (a === '刷新') vscode.commands.executeCommand('deepseek-usage.refresh');
                if (a === '打开面板') vscode.commands.executeCommand('deepseekUsage.dashboard.focus');
                if (a === '导入CSV') vscode.commands.executeCommand('deepseek-usage.importCsv');
            });

        } catch (err) {
            const msg = (err as any)?.response?.status
                ? `HTTP ${(err as any).response.status}`
                : (err as Error).message || '未知错误';
            vscode.window.showErrorMessage(`查询失败: ${msg}`);
        }
    }

    // ========== 内部 ==========

    private _update(balance: BalanceInfo[]): void {
        if (balance.length === 0) {
            this.item.text = '$(pulse) DeepSeek: 无数据';
            this.item.backgroundColor = undefined;
            return;
        }

        const totalBal = balance.reduce((s: number, b: BalanceInfo) => s + parseFloat(b.total_balance || '0'), 0);
        const currency = balance[0]?.currency || 'CNY';
        const level = totalBal < 2 ? Level.Critical : totalBal < 10 ? Level.Low : Level.Normal;

        const today = new Date().toISOString().split('T')[0];
        const todayRecords = this.usageRecords.filter(u => u.date === today);
        const todayCost = todayRecords.reduce((s: number, u: UsageRecord) => s + (u.cost || 0), 0);

        const costStr = todayCost > 0 ? ` | -¥${todayCost.toFixed(2)}` : '';

        switch (level) {
            case Level.Critical:
                this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                this.item.text = `$(error) DS: ¥${totalBal.toFixed(2)}${costStr}`;
                break;
            case Level.Low:
                this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                this.item.text = `$(warning) DS: ¥${totalBal.toFixed(2)}${costStr}`;
                break;
            default:
                this.item.backgroundColor = undefined;
                this.item.text = `$(pulse) DS: ¥${totalBal.toFixed(2)}${costStr}`;
        }

        const toppedUp = parseFloat(balance[0].topped_up_balance || '0');
        const granted = parseFloat(balance[0].granted_balance || '0');
        let tip = `**DS: ¥${totalBal.toFixed(2)}** | 充值${toppedUp.toFixed(2)} | 赠送${granted.toFixed(2)}`;
        if (todayCost > 0) tip += `\n今日费用: ¥${todayCost.toFixed(4)}`;
        this.item.tooltip = new vscode.MarkdownString(tip + '\n\n点击查看详情');
    }

    private async _startAutoRefresh(): Promise<void> {
        // 检查是否有凭证，没有则不启动
        const key = await this.api.getApiKey();
        const token = await this.api.getPlatformToken();
        if (!key && !token) {
            this.item.text = '$(pulse) DeepSeek: 点击配置';
            this.item.tooltip = '未配置 API Key 或平台 Token，点击设置';
            this.item.command = 'deepseek-usage.showDetail';
            return; // 不启动自动刷新
        }

        const config = vscode.workspace.getConfiguration('deepseekUsage');
        if (config.get<boolean>('autoRefresh', false)) {
            const interval = Math.max(10, config.get<number>('refreshInterval', 60));
            setTimeout(() => {
                this.refresh();
                this.timer = setInterval(() => this.refresh(), interval * 1000);
            }, 2000);
        }
    }

    _fmt(t: number): string {
        return t >= 1000000 ? `${(t / 1000000).toFixed(1)}M` : t >= 1000 ? `${(t / 1000).toFixed(1)}K` : t.toLocaleString();
    }

    dispose(): void {
        this.item.dispose();
        if (this.timer) clearInterval(this.timer);
    }
}
