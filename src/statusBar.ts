import * as vscode from 'vscode';
import { PlatformProvider, BalanceInfo, UsageRecord, UserSummary } from './platforms/types';

enum Level { Normal, Low, Critical }

export class StatusBarManager implements vscode.Disposable {
    private item: vscode.StatusBarItem;
    private provider: PlatformProvider;
    private timer?: NodeJS.Timeout;
    private _summary?: UserSummary;
    usageRecords: UsageRecord[] = [];

    constructor(context: vscode.ExtensionContext, provider: PlatformProvider) {
        this.provider = provider;
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = 'deepseek-usage.showDetail';
        this._applyProviderLabel();
        this.item.show();
        this._startAutoRefresh();
    }

    /** 切换平台 Provider */
    setProvider(provider: PlatformProvider): void {
        this.provider = provider;
        this.usageRecords = [];
        this._summary = undefined;
        if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
        this._applyProviderLabel();
        this._startAutoRefresh();
        this.refresh();
    }

    private _applyProviderLabel(): void {
        const prefix = this.provider.statusBarPrefix;
        this.item.text = `$(pulse) ${prefix}`;
        this.item.tooltip = `${this.provider.displayName}用量查询`;
    }

    // ========== 刷新 ==========

    async refresh(): Promise<void> {
        const prefix = this.provider.statusBarPrefix;
        try {
            const configured = await this.provider.isConfigured();
            if (!configured) {
                this.item.text = `$(pulse) ${prefix}: 未配置`;
                this.item.backgroundColor = undefined;
                return;
            }

            const summary = await this.provider.getUserSummary();
            this._summary = summary ?? undefined;
            const balance = await this.provider.getBalance().catch(() => [] as BalanceInfo[]);

            // 获取今日用量
            const today = new Date().toISOString().split('T')[0];
            const usage = await this.provider.getUsage(today, today).catch(() => []);

            if (usage.length > 0) {
                const map = new Map(this.usageRecords.map(r => [`${r.date}-${r.model}`, r]));
                for (const u of usage) map.set(`${u.date}-${u.model}`, u);
                this.usageRecords = Array.from(map.values());
            }

            this._update(balance);

        } catch {
            this.item.text = `$(error) ${prefix}: 查询失败`;
            this.item.backgroundColor = undefined;
        }
    }

    // ========== 点击弹窗 ==========

    async showDetail(): Promise<void> {
        const configured = await this.provider.isConfigured();
        const name = this.provider.displayName;
        if (!configured) {
            const a = await vscode.window.showInformationMessage(
                `${name} — 未配置`, '登录获取 Token', '手动设置 Token', '取消'
            );
            if (a === '登录获取 Token') vscode.commands.executeCommand('deepseek-usage.loginPlatform');
            if (a === '手动设置 Token') vscode.commands.executeCommand('deepseek-usage.setToken');
            return;
        }

        try {
            const summary = await this.provider.getUserSummary();
            this._summary = summary ?? undefined;
            const balance = await this.provider.getBalance().catch(() => [] as BalanceInfo[]);
            this._update(balance);

            const totalBal = balance.reduce((s: number, b: BalanceInfo) => s + parseFloat(b.total_balance || '0'), 0);
            const toppedUp = balance.reduce((s: number, b: BalanceInfo) => s + parseFloat(b.topped_up_balance || '0'), 0);
            const granted = balance.reduce((s: number, b: BalanceInfo) => s + parseFloat(b.granted_balance || '0'), 0);
            const currency = balance[0]?.currency || this.provider.currencyUnit;
            const monthCost = summary?.monthly_costs?.reduce((s, c) => s + parseFloat(c.amount || '0'), 0) || 0;

            const today = new Date().toISOString().split('T')[0];
            const month = today.slice(0, 7);
            const todayRecords = this.usageRecords.filter(u => u.date === today);
            const todayTokens = todayRecords.reduce((s: number, u: UsageRecord) => s + u.total_tokens, 0);
            const todayCost = todayRecords.reduce((s: number, u: UsageRecord) => s + (u.cost || 0), 0);
            const monthTokens = this.usageRecords.filter(u => u.date.startsWith(month))
                .reduce((s: number, u: UsageRecord) => s + u.total_tokens, 0);

            const lines = [
                `💰 余额: ¥${totalBal.toFixed(2)}（充值${toppedUp.toFixed(2)} + 赠送${granted.toFixed(2)}）`,
            ];
            const monthlyTokenUsage = parseInt(summary?.monthly_token_usage || '0');
            if (monthlyTokenUsage > 0) {
                lines.push(`📅 本月用量: ${this._fmt(monthlyTokenUsage)} Token`);
                if (monthCost > 0) lines.push(`💵 本月费用: ¥${monthCost.toFixed(4)}`);
            }
            if (this.usageRecords.length > 0) {
                lines.push(`📈 今日明细: ${this._fmt(todayTokens)} Token`);
                if (todayCost > 0) lines.push(`💵 今日费用: ¥${todayCost.toFixed(4)}`);
            } else if (monthlyTokenUsage === 0) {
                lines.push('⚠️ 暂无用量数据');
            }

            await vscode.window.showInformationMessage(
                `${name}: ¥${totalBal.toFixed(2)}`,
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
        const prefix = this.provider.statusBarPrefix;
        const thresholds = this.provider.warningThresholds;
        if (balance.length === 0) {
            this.item.text = `$(pulse) ${prefix}: 无数据`;
            this.item.backgroundColor = undefined;
            return;
        }

        const totalBal = balance.reduce((s: number, b: BalanceInfo) => s + parseFloat(b.total_balance || '0'), 0);
        const level = totalBal < thresholds.critical ? Level.Critical
            : totalBal < thresholds.low ? Level.Low
            : Level.Normal;

        // 今日用量
        const today = new Date().toISOString().split('T')[0];
        const todayU = this.usageRecords.filter(u => u.date === today);
        const todayTokens = todayU.reduce((s, u) => s + u.total_tokens, 0);
        const todayCost = todayU.reduce((s, u) => s + (u.cost || 0), 0);

        // 拼接状态栏文本
        let extra = '';
        if (todayTokens > 0) {
            extra += ` | ${this._fmt(todayTokens)}T`;
            if (todayCost > 0) extra += ` ¥${todayCost.toFixed(2)}`;
        }

        switch (level) {
            case Level.Critical:
                this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                this.item.text = `$(error) ${prefix}: ¥${totalBal.toFixed(2)}${extra}`;
                break;
            case Level.Low:
                this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                this.item.text = `$(warning) ${prefix}: ¥${totalBal.toFixed(2)}${extra}`;
                break;
            default:
                this.item.backgroundColor = undefined;
                this.item.text = `$(pulse) ${prefix}: ¥${totalBal.toFixed(2)}${extra}`;
        }

        const toppedUp = parseFloat(balance[0].topped_up_balance || '0');
        const granted = parseFloat(balance[0].granted_balance || '0');
        let tip = `**余额: ¥${totalBal.toFixed(2)}**\n充值 ¥${toppedUp.toFixed(2)} | 赠送 ¥${granted.toFixed(2)}`;
        if (todayTokens > 0) {
            tip += `\n今日: ${this._fmt(todayTokens)} Token`;
            if (todayCost > 0) tip += ` | 费用 ¥${todayCost.toFixed(4)}`;
        }
        this.item.tooltip = new vscode.MarkdownString(tip + '\n\n点击查看详情');
    }

    private async _startAutoRefresh(): Promise<void> {
        const prefix = this.provider.statusBarPrefix;
        // 检查是否有平台凭证，没有则不启动
        const configured = await this.provider.isConfigured();
        if (!configured) {
            this.item.text = `$(pulse) ${prefix}: 点击配置`;
            this.item.tooltip = '未配置凭证，点击设置';
            this.item.command = 'deepseek-usage.showDetail';
            return;
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
        return t >= 1000000 ? `${(t / 1000000).toFixed(1)}M`
            : t >= 1000 ? `${(t / 1000).toFixed(1)}K`
            : t.toLocaleString();
    }

    dispose(): void {
        this.item.dispose();
        if (this.timer) clearInterval(this.timer);
    }
}
