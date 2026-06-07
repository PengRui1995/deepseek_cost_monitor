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
        this.item.tooltip = 'DeepSeek用量查询';
        this.item.show();
        this._startAutoRefresh();
    }

    async refresh(): Promise<void> {
        try {
            const key = await this.api.getApiKey();
            if (!key) {
                this.item.text = '$(pulse) DeepSeek: 未配置';
                this.item.backgroundColor = undefined;
                return;
            }

            const balance = await this.api.getBalance();

            // 获取今日用量（API Key 直接查询 /v1/usage）
            const today = new Date().toISOString().split('T')[0];
            const usage = await this.api.getUsage(today, today).catch(() => []);

            // 合并到 records
            if (usage.length > 0) {
                const map = new Map(this.usageRecords.map(r => [`${r.date}-${r.model}`, r]));
                for (const u of usage) map.set(`${u.date}-${u.model}`, u);
                this.usageRecords = Array.from(map.values());
            }

            this._update(balance);

        } catch {
            this.item.text = '$(warning) DeepSeek: 查询失败';
            this.item.backgroundColor = undefined;
        }
    }

    async showDetail(): Promise<void> {
        const key = await this.api.getApiKey();
        if (!key) {
            const a = await vscode.window.showInformationMessage(
                'DeepSeek — 未配置 API Key', '设置 API Key', '取消'
            );
            if (a === '设置 API Key') vscode.commands.executeCommand('deepseek-usage.setApiKey');
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
                lines.push(
                    `📈 今日: ${this._fmt(todayTokens)} Token`,
                    todayCost > 0 ? `💵 今日费用: ¥${todayCost.toFixed(4)}` : '',
                    `📅 本月: ${this._fmt(monthTokens)} Token`,
                    monthCost > 0 ? `💵 本月费用: ¥${monthCost.toFixed(4)}` : '',
                );
            } else {
                lines.push('⚠️ 暂无用量数据');
            }

            await vscode.window.showInformationMessage(
                `DeepSeek: ${totalBal.toFixed(2)} ${currency}`,
                { modal: false, detail: lines.join(' | ') },
                '刷新', '打开面板', '导入CSV'
            ).then(a => {
                if (a === '刷新') vscode.commands.executeCommand('deepseek-usage.refresh');
                if (a === '打开面板') vscode.commands.executeCommand('deepseekUsage.dashboard.focus');
                if (a === '导入CSV') vscode.commands.executeCommand('deepseek-usage.importCsv');
            });

        } catch (err) {
            vscode.window.showErrorMessage(`查询失败: ${err}`);
        }
    }

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
        const todayTokens = todayRecords.reduce((s: number, u: UsageRecord) => s + u.total_tokens, 0);
        const todayCost = todayRecords.reduce((s: number, u: UsageRecord) => s + (u.cost || 0), 0);

        // 状态栏: 余额 | -¥今日费用
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
        let tip = `**余额: ¥${totalBal.toFixed(2)}** | 充值${toppedUp.toFixed(2)} | 赠送${granted.toFixed(2)}`;
        if (todayTokens > 0) tip += `\n今日Token: ${this._fmt(todayTokens)}`;
        if (todayCost > 0) tip += ` | 费用: ¥${todayCost.toFixed(4)}`;
        this.item.tooltip = new vscode.MarkdownString(tip + '\n\n点击查看详情');
    }

    private _startAutoRefresh(): void {
        const config = vscode.workspace.getConfiguration('deepseekUsage');
        if (config.get<boolean>('autoRefresh', true)) {
            this.timer = setInterval(() => this.refresh(), Math.max(10, config.get<number>('refreshInterval', 60)) * 1000);
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
