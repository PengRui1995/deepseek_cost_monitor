import * as vscode from 'vscode';
import { PlatformProvider, BalanceInfo, UsageRecord } from './platforms/types';

/** 平台概要信息（发送给 WebView） */
export interface PlatformMeta {
    id: string;
    displayName: string;
    /** 主题色（十六进制） */
    color: string;
    loginCommand: string;
    setTokenCommand: string;
}

export class DashboardViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'deepseekUsage.dashboard';
    private _view?: vscode.WebviewView;
    private provider: PlatformProvider;
    usageRecords: UsageRecord[] = [];
    private _autoRefreshTimer?: ReturnType<typeof setInterval>;
    private _autoRefreshOn = false;
    private _refreshSeconds = 60;
    private _platforms: PlatformMeta[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        provider: PlatformProvider,
        platforms: PlatformMeta[]
    ) {
        this.provider = provider;
        this._platforms = platforms;
    }

    setProvider(provider: PlatformProvider): void {
        this.provider = provider;
        this.usageRecords = [];
        this.refresh();
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        webviewView.webview.html = this._html(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'refresh': await this.refresh(); break;
                case 'openDashboard': await this.refresh(); break;
                case 'setToken':
                    vscode.commands.executeCommand(this._getMeta().setTokenCommand);
                    break;
                case 'login':
                    vscode.commands.executeCommand(this._getMeta().loginCommand);
                    break;
                case 'clearConfig': vscode.commands.executeCommand('deepseek-usage.clearConfig'); break;
                case 'switchPlatform':
                    vscode.commands.executeCommand('llm-usage.switchToPlatform', msg.platformId);
                    break;
                case 'importCsv': await this._importCsv(); break;
                case 'exportCsv': await this._exportCsv(); break;
                case 'toggleAutoRefresh': this._autoRefreshOn = !!msg.on; this._autoRefreshOn ? this._startTimer() : this._stopTimer(); break;
                case 'setRefreshInterval': this._refreshSeconds = parseInt(msg.seconds, 10) || 60; if (this._autoRefreshOn) { this._stopTimer(); this._startTimer(); } break;
            }
        });

        this.refresh();
    }

    async notifyConfigChanged(): Promise<void> {
        if (!this._view) return;
        const configured = await this.provider.isConfigured();
        this._view.webview.postMessage({ command: 'needConfig', hasToken: configured, ...this._platformContext() });
    }

    notifyPlatformChanged(): void {
        if (!this._view) return;
        this._view.webview.postMessage({ command: 'platformChanged', ...this._platformContext() });
    }

    private _getMeta(): PlatformMeta {
        return this._platforms.find(p => p.id === this.provider.id) || this._platforms[0];
    }

    private _platformContext() {
        return {
            platformId: this.provider.id,
            displayName: this.provider.displayName,
            currencyUnit: this.provider.currencyUnit,
            platforms: this._platforms,
        };
    }

    private _startTimer(): void { this._stopTimer(); this._autoRefreshTimer = setInterval(() => this.refresh(), this._refreshSeconds * 1000); }
    private _stopTimer(): void { if (this._autoRefreshTimer) { clearInterval(this._autoRefreshTimer); this._autoRefreshTimer = undefined; } }

    async refresh(): Promise<void> {
        if (!this._view) return;

        const configured = await this.provider.isConfigured();
        if (!configured) {
            this._view.webview.postMessage({ command: 'needConfig', hasToken: false, ...this._platformContext() });
            return;
        }

        try {
            const balance = await this.provider.getBalance().catch(() => [] as BalanceInfo[]);
            const today = new Date().toISOString().split('T')[0];
            const usage = await this.provider.getUsage(today, today).catch(() => []);
            if (usage.length > 0) {
                const existing = new Map(this.usageRecords.map(r => [`${r.date}-${r.model}`, r]));
                for (const u of usage) existing.set(`${u.date}-${u.model}`, u);
                this.usageRecords = Array.from(existing.values());
            }
            const summary = await this.provider.getUserSummary().catch(() => null);

            this._view.webview.postMessage({
                command: 'data', balance, usage: this.usageRecords, hasToken: true,
                autoRefresh: this._autoRefreshOn, refreshInterval: this._refreshSeconds,
                summary, ...this._platformContext(),
            });
        } catch (err) {
            const msg = (err as any)?.response?.status
                ? `HTTP ${(err as any).response.status}` : (err as Error).message || '未知错误';
            this._view.webview.postMessage({ command: 'error', message: msg });
        }
    }

    private async _importCsv(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'CSV': ['csv'] }, title: `导入 ${this.provider.displayName} 用量 CSV` });
        if (!uris?.length) return;
        try {
            const data = await vscode.workspace.fs.readFile(uris[0]);
            const records = this.provider.parseUsageCsv(Buffer.from(data).toString('utf-8'));
            if (!records.length) { vscode.window.showWarningMessage(`CSV 解析失败，请使用 ${this.provider.displayName} 官方导出的文件`); return; }
            this.usageRecords = records;
            await this.refresh();
            vscode.window.showInformationMessage(`已导入 ${records.length} 条用量记录`);
        } catch (err) { vscode.window.showErrorMessage(`导入失败: ${err}`); }
    }

    private async _exportCsv(): Promise<void> {
        if (!this.usageRecords.length) { vscode.window.showWarningMessage('暂无用量数据'); return; }
        const h = ['date', 'model', 'input_tokens', 'output_tokens', 'total_tokens', 'cost'];
        const rows = this.usageRecords.map(u => [u.date, u.model, u.input_tokens, u.output_tokens, u.total_tokens, u.cost].join(','));
        const csv = [h.join(','), ...rows].join('\n');
        const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${this.provider.id}-usage.csv`), filters: { 'CSV': ['csv'] } });
        if (uri) { await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf-8')); vscode.window.showInformationMessage('已导出'); }
    }

    // ====================================================================
    // WebView HTML — 玻璃拟态 + 主题色 + Tab 切换 + 骨架屏 + 数字动画
    // ====================================================================

    private _html(webview: vscode.Webview): string {
        const nonce = _nonce();
        // 平台主题色注入为 CSS 变量
        const platformColors = this._platforms.map(p =>
            `[data-platform="${p.id}"] { --platform-color: ${p.color}; --platform-color-dim: ${p.color}22; --platform-color-bg: ${p.color}10; }`
        ).join('\n');

        return `<!DOCTYPE html>
<html lang="zh-CN" data-platform="${this.provider.id}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; style-src 'unsafe-inline';">
<style>
    :root {
        --platform-color: #4F8FF7;
        --platform-color-dim: #4F8FF722;
        --platform-color-bg: #4F8FF710;
        --glass-bg: var(--vscode-sideBar-background, #1e1e2e);
        --glass-border: rgb(255 255 255 / .08);
        --glass-shadow: 0 4px 24px rgb(0 0 0 / .2);
        --radius: 12px;
        --radius-sm: 8px;
        --transition: .25s cubic-bezier(.4,0,.2,1);
    }
    ${platformColors}

    *{margin:0;padding:0;box-sizing:border-box;}
    body{
        font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
        font-size: 12px;
        padding: 12px 10px;
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background, #1a1a2e);
        line-height: 1.4;
    }

    /* ===== 平台 Tab 切换器 ===== */
    .tabs{
        display: flex;
        gap: 4px;
        margin-bottom: 12px;
        padding: 4px;
        border-radius: var(--radius-sm);
        background: var(--vscode-sideBarSectionHeader-background, rgb(128 128 128 / .08));
    }
    .tab{
        flex: 1;
        padding: 6px 12px;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
        text-align: center;
        background: transparent;
        color: var(--vscode-foreground);
        opacity: .55;
        transition: all var(--transition);
        white-space: nowrap;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
    }
    .tab:hover{ opacity: .8; background: rgb(255 255 255 / .04); }
    .tab.active{
        opacity: 1;
        background: var(--platform-color-dim);
        color: var(--platform-color);
        font-weight: 600;
        box-shadow: 0 1px 3px rgb(0 0 0 / .15);
    }
    .tab-dot{
        width: 7px; height: 7px;
        border-radius: 50%;
        background: var(--platform-color);
        flex-shrink: 0;
    }

    /* ===== 工具栏 ===== */
    .toolbar{
        display: flex; gap: 5px; margin-bottom: 12px;
        flex-wrap: wrap; align-items: center;
    }
    .btn{
        background: var(--vscode-button-secondaryBackground, rgb(255 255 255 / .08));
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        border: 1px solid var(--glass-border);
        padding: 5px 10px; border-radius: 6px;
        cursor: pointer; font-size: 11px;
        transition: all var(--transition);
        display: inline-flex; align-items: center; gap: 4px;
    }
    .btn:hover{ background: rgb(255 255 255 / .14); transform: translateY(-1px); }
    .btn.primary{ background: var(--platform-color); color: #fff; border-color: var(--platform-color); font-weight: 600; }
    .btn.primary:hover{ filter: brightness(1.15); }
    .btn.danger{ color: var(--vscode-errorForeground, #f87171); }
    .btn.danger:hover{ background: rgb(248 113 113 / .15); }
    .btn:active{ transform: translateY(0); }

    .spacer{ flex: 1; }

    /* ===== 自动刷新开关 ===== */
    .toggle-row{ display: flex; align-items: center; gap: 6px; font-size: 10px; opacity: .7; }
    .toggle-sw{ position: relative; display: inline-block; width: 32px; height: 18px; flex-shrink: 0; }
    .toggle-sw input{ display: none; }
    .toggle-sw .knob{
        position: absolute; inset: 0;
        background: var(--vscode-input-background, rgb(128 128 128 / .3));
        border-radius: 10px; cursor: pointer; transition: var(--transition);
    }
    .toggle-sw .knob::after{
        content: ''; position: absolute; top: 2px; left: 2px;
        width: 14px; height: 14px; border-radius: 50%;
        background: var(--vscode-foreground); transition: var(--transition);
    }
    .toggle-sw input:checked+.knob{ background: var(--platform-color); }
    .toggle-sw input:checked+.knob::after{ left: 16px; }
    .toggle-sw input:checked+.knob::after{ background: #fff; }

    .sel-sm{
        background: var(--vscode-input-background, rgb(255 255 255 / .06));
        color: var(--vscode-input-foreground);
        border: 1px solid var(--glass-border);
        padding: 2px 5px; border-radius: 4px; font-size: 10px;
    }

    /* ===== 玻璃拟态卡片 ===== */
    .cards-grid{
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 8px;
        margin-bottom: 10px;
    }
    .cards-grid.col3{ grid-template-columns: repeat(3, 1fr); }

    .glass-card{
        position: relative;
        background: linear-gradient(135deg, rgb(255 255 255 / .05), rgb(255 255 255 / .02));
        border: 1px solid var(--glass-border);
        border-radius: var(--radius);
        padding: 12px;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        transition: all var(--transition);
        overflow: hidden;
    }
    .glass-card::before{
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 2px;
        background: linear-gradient(90deg, transparent, var(--platform-color), transparent);
        opacity: .4;
    }
    .glass-card:hover{
        border-color: var(--platform-color-dim);
        box-shadow: var(--glass-shadow), 0 0 0 1px var(--platform-color-dim);
        transform: translateY(-1px);
    }
    .glass-card .icon{
        font-size: 18px; margin-bottom: 6px; opacity: .7;
    }
    .glass-card .label{
        font-size: 10px; opacity: .5;
        text-transform: uppercase; letter-spacing: .5px;
        margin-bottom: 4px;
    }
    .glass-card .value{
        font-size: 18px; font-weight: 700;
        background: linear-gradient(135deg, var(--vscode-foreground), var(--platform-color));
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
    }
    .glass-card .sub{
        font-size: 10px; opacity: .4; margin-top: 2px;
    }

    /* ===== 余额环形指示器 ===== */
    .ring-container{
        display: flex; align-items: center; gap: 12px;
    }
    .ring-svg{
        width: 52px; height: 52px;
        flex-shrink: 0;
    }
    .ring-bg{ fill: none; stroke: rgb(255 255 255 / .06); stroke-width: 4; }
    .ring-fg{
        fill: none; stroke: var(--platform-color);
        stroke-width: 4; stroke-linecap: round;
        transform: rotate(-90deg); transform-origin: center;
        transition: stroke-dashoffset 1.2s cubic-bezier(.4,0,.2,1);
    }
    .ring-text{ font-size: 11px; font-weight: 700; fill: var(--vscode-foreground); text-anchor: middle; dominant-baseline: central; }

    /* ===== 错误提示 ===== */
    .err-msg{
        color: var(--vscode-errorForeground);
        padding: 10px 12px; margin-bottom: 10px;
        background: var(--vscode-inputValidation-errorBackground, rgb(248 113 113 / .1));
        border-radius: var(--radius-sm); font-size: 11px;
        border: 1px solid rgb(248 113 113 / .2);
    }

    /* ===== 分割线 ===== */
    .divider{
        border: none;
        border-top: 1px solid var(--glass-border);
        margin: 10px 0;
    }

    /* ===== 区块标题 ===== */
    .section-title{
        font-size: 11px; font-weight: 600; opacity: .7;
        margin-bottom: 8px; letter-spacing: .3px;
        display: flex; align-items: center; gap: 6px;
    }
    .section-title .dot{
        width: 6px; height: 6px; border-radius: 50%;
        background: var(--platform-color);
    }

    /* ===== 欢迎页 ===== */
    .welcome{
        text-align: center; padding: 40px 16px;
        display: flex; flex-direction: column; align-items: center;
    }
    .welcome .hero-icon{
        font-size: 48px; margin-bottom: 12px;
        animation: float 3s ease-in-out infinite;
    }
    @keyframes float{
        0%,100%{ transform: translateY(0); }
        50%{ transform: translateY(-8px); }
    }
    .welcome h3{ font-size: 15px; font-weight: 700; margin-bottom: 4px; }
    .welcome .subtitle{ font-size: 11px; opacity: .5; margin-bottom: 20px; }
    .welcome .actions{ display: flex; flex-direction: column; gap: 8px; align-items: center; }
    .welcome .btn{ min-width: 180px; justify-content: center; padding: 8px 16px; }
    .welcome .query-btn{ min-width: 200px; padding: 10px 20px; font-size: 13px; }
    .welcome-footer{ margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--glass-border); width: 100%; max-width: 260px; }
    .welcome-footer .hint{ font-size: 10px; opacity: .4; margin-top: 6px; }

    /* ===== 骨架屏 ===== */
    @keyframes shimmer{
        0%{ background-position: -200px 0; }
        100%{ background-position: calc(200px + 100%) 0; }
    }
    .skeleton{
        background: linear-gradient(90deg, rgb(255 255 255 / .03) 25%, rgb(255 255 255 / .08) 37%, rgb(255 255 255 / .03) 63%);
        background-size: 200px 100%;
        animation: shimmer 1.5s ease-in-out infinite;
        border-radius: var(--radius-sm);
    }
    .skeleton-card{ height: 72px; border-radius: var(--radius); }
    .skeleton-text{ height: 14px; width: 60%; margin: 8px 0; }
    .skeleton-text.short{ width: 35%; }

    /* ===== 数字滚动 ===== */
    .num-roll{ display: inline-block; transition: all .6s cubic-bezier(.4,0,.2,1); }

    /* ===== 图表容器 ===== */
    .chart-box{
        width: 100%; height: 200px;
        border-radius: var(--radius-sm);
        background: rgb(255 255 255 / .02);
        border: 1px solid var(--glass-border);
        margin-top: 8px;
    }
    .no-data{
        text-align: center; padding: 20px; font-size: 11px; opacity: .4;
    }

    /* ===== 响应式 ===== */
    @media (max-width: 260px){
        .cards-grid{ grid-template-columns: 1fr; }
        .cards-grid.col3{ grid-template-columns: 1fr 1fr; }
    }
</style>
</head>
<body>

<!-- 平台 Tab -->
<div class="tabs" id="tabs"></div>

<!-- 工具栏 -->
<div class="toolbar">
    <button class="btn" id="btnRefresh">🔄 刷新</button>
    <button class="btn" id="btnImport">📥 导入</button>
    <button class="btn" id="btnExport">📤 导出</button>
    <button class="btn danger" id="btnClear">🗑</button>
    <span class="spacer"></span>
    <label class="toggle-row">
        <span class="toggle-sw">
            <input type="checkbox" id="chkAuto">
            <span class="knob"></span>
        </span>
        <span>自动刷新</span>
    </label>
    <select class="sel-sm" id="selInterval" style="display:none">
        <option value="10">10s</option>
        <option value="60">60s</option>
        <option value="600">10min</option>
        <option value="3600">1h</option>
    </select>
</div>

<!-- 错误 -->
<div class="err-msg" id="error" style="display:none"></div>

<!-- 加载骨架屏 -->
<div id="skeleton" style="display:none">
    <div class="cards-grid">
        <div class="skeleton skeleton-card"></div>
        <div class="skeleton skeleton-card"></div>
        <div class="skeleton skeleton-card"></div>
        <div class="skeleton skeleton-card"></div>
    </div>
</div>

<!-- 欢迎页 -->
<div id="empty" style="display:none">
    <div class="welcome">
        <div class="hero-icon">🔑</div>
        <h3>欢迎使用 <span id="welcomeName">-</span> 用量查询</h3>
        <p class="subtitle">配置凭证后开始监控用量</p>
        <div class="actions">
            <button class="btn primary" id="btnLogin">🔑 登录获取 Token</button>
            <span style="font-size:10px;opacity:.4;">自动提取（推荐）</span>
            <button class="btn" id="btnSetToken">🛡️ 手动设置 Token</button>
        </div>
        <div class="welcome-footer">
            <button class="btn primary query-btn" id="btnQuery" disabled>📊 查询用量</button>
            <p class="hint" id="btnQueryHint">请先登录平台获取 Token</p>
        </div>
    </div>
</div>

<!-- 数据面板 -->
<div id="content" style="display:none">
    <!-- 余额卡片 -->
    <div class="section-title"><span class="dot"></span>余额概览</div>
    <div class="cards-grid">
        <div class="glass-card">
            <div class="ring-container">
                <svg class="ring-svg" viewBox="0 0 52 52">
                    <circle class="ring-bg" cx="26" cy="26" r="22"/>
                    <circle class="ring-fg" id="ringFg" cx="26" cy="26" r="22"
                        stroke-dasharray="138.2" stroke-dashoffset="30"/>
                    <text class="ring-text" id="ringPct" x="26" y="26">-</text>
                </svg>
                <div>
                    <div class="label">总余额</div>
                    <div class="value" id="totalBal">-</div>
                </div>
            </div>
        </div>
        <div class="glass-card">
            <div class="icon">💎</div>
            <div class="label">充值余额</div>
            <div class="value" id="toppedUp">-</div>
        </div>
        <div class="glass-card">
            <div class="icon">🎁</div>
            <div class="label">赠送余额</div>
            <div class="value" id="granted">-</div>
        </div>
        <div class="glass-card">
            <div class="icon" id="statusIcon">✅</div>
            <div class="label">状态</div>
            <div class="value" id="status">-</div>
        </div>
    </div>

    <div class="divider"></div>

    <!-- 用量卡片 -->
    <div class="section-title"><span class="dot"></span>用量统计</div>
    <div class="cards-grid col3">
        <div class="glass-card">
            <div class="icon">📅</div>
            <div class="label">今日 Token</div>
            <div class="value" id="todayToken">-</div>
            <div class="sub" id="todayCost">-</div>
        </div>
        <div class="glass-card">
            <div class="icon">📈</div>
            <div class="label">本周 Token</div>
            <div class="value" id="weekToken">-</div>
            <div class="sub" id="weekCost">-</div>
        </div>
        <div class="glass-card">
            <div class="icon">📊</div>
            <div class="label">本月 Token</div>
            <div class="value" id="monthToken">-</div>
            <div class="sub" id="monthCost">-</div>
        </div>
    </div>

    <!-- 图表 -->
    <div id="chart" class="chart-box"></div>
    <div class="section-title" style="margin-top:10px;"><span class="dot"></span>本周用量趋势</div>
    <div id="chartWeek" class="chart-box"></div>
    <div class="section-title" style="margin-top:10px;"><span class="dot"></span>本月用量趋势</div>
    <div id="chartMonth" class="chart-box"></div>
    <div class="no-data" id="noData">暂无用量数据，请导入 CSV 或配置凭证</div>
</div>

<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
<script nonce="${nonce}">
    const v = acquireVsCodeApi();
    let CUR = 'CNY';
    let chart = null, chartWeek = null, chartMonth = null;
    let currentPlatformId = '${this.provider.id}';
    let platformMeta = {};

    // ===== Tab 切换 =====
    const tabsEl = document.getElementById('tabs');

    function buildTabs(platforms, activeId) {
        tabsEl.innerHTML = '';
        platformMeta = {};
        (platforms || []).forEach(p => {
            const btn = document.createElement('button');
            btn.className = 'tab' + (p.id === activeId ? ' active' : '');
            btn.innerHTML = '<span class="tab-dot" style="background:' + p.color + '"></span>' + p.displayName;
            btn.onclick = () => v.postMessage({ command: 'switchPlatform', platformId: p.id });
            tabsEl.appendChild(btn);
            platformMeta[p.id] = p;
        });
        currentPlatformId = activeId;
        // 切换全局主题
        document.documentElement.setAttribute('data-platform', activeId);
    }

    // ===== 事件绑定 =====
    document.getElementById('btnRefresh').onclick = () => v.postMessage({ command: 'refresh' });
    document.getElementById('btnImport').onclick = () => v.postMessage({ command: 'importCsv' });
    document.getElementById('btnExport').onclick = () => v.postMessage({ command: 'exportCsv' });
    document.getElementById('btnClear').onclick = () => v.postMessage({ command: 'clearConfig' });
    document.getElementById('btnSetToken').onclick = () => v.postMessage({ command: 'setToken' });
    document.getElementById('btnLogin').onclick = () => v.postMessage({ command: 'login' });
    document.getElementById('btnQuery').onclick = () => v.postMessage({ command: 'openDashboard' });
    document.getElementById('chkAuto').onchange = function () {
        document.getElementById('selInterval').style.display = this.checked ? 'inline-block' : 'none';
        v.postMessage({ command: 'toggleAutoRefresh', on: this.checked });
    };
    document.getElementById('selInterval').onchange = function () {
        v.postMessage({ command: 'setRefreshInterval', seconds: this.value });
    };

    // ===== 工具函数 =====
    function fmt(t) { return t >= 1e6 ? (t / 1e6).toFixed(1) + 'M' : t >= 1e3 ? (t / 1e3).toFixed(1) + 'K' : t.toLocaleString(); }

    function animateValue(el, newVal, suffix) {
        if (!el) return;
        const oldText = el.textContent || '0';
        const oldVal = parseFloat(oldText.replace(/[^0-9.]/g, '')) || 0;
        const newNum = typeof newVal === 'string' ? parseFloat(newVal) : newVal;
        if (isNaN(newNum)) { el.textContent = String(newVal); return; }
        const duration = 400;
        const start = performance.now();
        function step(ts) {
            const progress = Math.min((ts - start) / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3); // ease-out
            const current = oldVal + (newNum - oldVal) * eased;
            el.textContent = (suffix ? current.toFixed(suffix) : Math.round(current).toLocaleString());
            if (progress < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }

    // ===== 环形进度 =====
    function updateRing(balance) {
        const ring = document.getElementById('ringFg');
        const text = document.getElementById('ringPct');
        if (!ring || !text) return;
        const total = balance.reduce((s, b) => s + parseFloat(b.total_balance || 0), 0);
        const topped = balance.reduce((s, b) => s + parseFloat(b.topped_up_balance || 0), 0);
        // 用充值余额占比做环形进度（有充值=有意识在用）
        const pct = total > 0 ? Math.min((topped / Math.max(total, 0.01)) * 100, 100) : 0;
        const circumference = 138.2; // 2*PI*22
        const offset = circumference - (circumference * pct / 100);
        ring.style.strokeDashoffset = offset;
        text.textContent = total > 0 ? Math.round(pct) + '%' : '-';
    }

    // ===== ECharts =====
    function drawChart(data) {
        const dom = document.getElementById('chart');
        if (!dom || typeof echarts == 'undefined') return;
        if (chart) chart.dispose();
        chart = echarts.init(dom);
        const dates = [...new Set(data.map(d => d.date))].sort();
        const models = [...new Set(data.map(d => d.model))];
        const tc = getComputedStyle(document.body).color || '#ccc';
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--platform-color').trim() || '#4F8FF7';
        chart.setOption({
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
            legend: { data: models, textStyle: { color: tc, fontSize: 9 }, top: 0 },
            grid: { left: '3%', right: '4%', bottom: '3%', top: 28, containLabel: true },
            xAxis: { type: 'category', data: dates, axisLabel: { color: tc, rotate: 45, fontSize: 8 } },
            yAxis: { type: 'value', axisLabel: { color: tc, fontSize: 8, formatter: v => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v } },
            series: models.map(m => ({
                name: m, type: 'bar', stack: 'total',
                itemStyle: { borderRadius: [3, 3, 0, 0] },
                data: dates.map(d => { const i = data.find(r => r.date === d && r.model === m); return i ? i.total_tokens : 0; })
            }))
        });
    }

    function _drawLine(domId, inst, dates, values, label) {
        const dom = document.getElementById(domId);
        if (!dom || typeof echarts == 'undefined') return inst;
        if (inst) inst.dispose();
        const nc = echarts.init(dom);
        const tc = getComputedStyle(document.body).color || '#ccc';
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--platform-color').trim() || '#4F8FF7';
        nc.setOption({
            tooltip: { trigger: 'axis' },
            grid: { left: '3%', right: '4%', bottom: '3%', top: 10, containLabel: true },
            xAxis: { type: 'category', data: dates, axisLabel: { color: tc, fontSize: 8 } },
            yAxis: { type: 'value', axisLabel: { color: tc, fontSize: 8, formatter: v => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v } },
            series: [{
                name: label, type: 'line', data: values,
                lineStyle: { width: 2, color: accent },
                itemStyle: { color: accent },
                areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: accent + '40' }, { offset: 1, color: accent + '04' }
                ])}
            }]
        });
        return nc;
    }

    function drawWeekChart(usage) {
        const d = new Date(); const dow = d.getDay();
        const mon = new Date(d); mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
        const days = []; for (let i = 0; i < 7; i++) { const dt = new Date(mon); dt.setDate(mon.getDate() + i); days.push(dt.toISOString().split('T')[0]); }
        const values = days.map(dd => usage.filter(u => u.date === dd).reduce((s, u) => s + u.total_tokens, 0));
        chartWeek = _drawLine('chartWeek', chartWeek, days.map(dd => dd.slice(5)), values, 'Token');
    }

    function drawMonthChart(usage) {
        const now = new Date(); const y = now.getFullYear(), m = now.getMonth();
        const daysInMonth = new Date(y, m + 1, 0).getDate();
        const days = []; for (let i = 1; i <= daysInMonth; i++) { days.push(y + '-' + (String(m + 1).padStart(2, '0')) + '-' + (String(i).padStart(2, '0'))); }
        const values = days.map(dd => usage.filter(u => u.date === dd).reduce((s, u) => s + u.total_tokens, 0));
        chartMonth = _drawLine('chartMonth', chartMonth, days.map(dd => dd.slice(5)), values, 'Token');
    }

    // ===== 消息处理 =====
    function applyPlatform(m) {
        if (m.platforms) buildTabs(m.platforms, m.platformId);
        if (m.displayName) document.getElementById('welcomeName').textContent = m.displayName;
        if (m.currencyUnit) CUR = m.currencyUnit;
    }

    window.addEventListener('message', e => {
        const m = e.data;

        if (m.command === 'platformChanged') { applyPlatform(m); return; }

        if (m.command === 'error') {
            applyPlatform(m);
            document.getElementById('error').style.display = 'block';
            document.getElementById('error').textContent = m.message;
        }

        if (m.command === 'needConfig') {
            applyPlatform(m);
            document.getElementById('error').style.display = 'none';
            document.getElementById('skeleton').style.display = 'none';
            document.getElementById('empty').style.display = 'block';
            document.getElementById('content').style.display = 'none';
            const btnQ = document.getElementById('btnQuery');
            const hint = document.getElementById('btnQueryHint');
            if (m.hasToken) { btnQ.disabled = false; btnQ.title = ''; hint.style.display = 'none'; }
            else { btnQ.disabled = true; hint.style.display = 'block'; }
            return;
        }

        if (m.command !== 'data') return;

        applyPlatform(m);
        document.getElementById('error').style.display = 'none';
        document.getElementById('skeleton').style.display = 'none';

        // 自动刷新控件
        const chk = document.getElementById('chkAuto');
        chk.checked = !!m.autoRefresh;
        document.getElementById('selInterval').style.display = m.autoRefresh ? 'inline-block' : 'none';
        if (m.refreshInterval) document.getElementById('selInterval').value = String(m.refreshInterval);

        const bal = m.balance || [], usage = m.usage || [];
        if (bal.length === 0) {
            document.getElementById('empty').style.display = 'block';
            document.getElementById('content').style.display = 'none';
            return;
        }

        document.getElementById('empty').style.display = 'none';
        document.getElementById('content').style.display = 'block';

        // 余额
        const tb = bal.reduce((s, b) => s + parseFloat(b.total_balance || 0), 0);
        const tu = bal.reduce((s, b) => s + parseFloat(b.topped_up_balance || 0), 0);
        const tg = bal.reduce((s, b) => s + parseFloat(b.granted_balance || 0), 0);
        document.getElementById('totalBal').textContent = tb.toFixed(2) + ' ' + CUR;
        document.getElementById('toppedUp').textContent = tu.toFixed(2) + ' ' + CUR;
        document.getElementById('granted').textContent = tg.toFixed(2) + ' ' + CUR;
        document.getElementById('status').textContent = tb > 0 ? '✅ 可用' : '⚠️ 余额不足';
        document.getElementById('statusIcon').textContent = tb > 0 ? '✅' : '⚠️';
        updateRing(bal);

        // 用量统计
        const today = new Date().toISOString().split('T')[0];
        const month = today.slice(0, 7);
        const d = new Date(); const dow = d.getDay();
        const mon = new Date(d); mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
        const monStr = mon.toISOString().split('T')[0];

        const todayU = usage.filter(u => u.date === today);
        const weekU = usage.filter(u => u.date >= monStr);
        const monthU = usage.filter(u => u.date.startsWith(month));

        const todayT = todayU.reduce((s, u) => s + u.total_tokens, 0);
        const todayC = todayU.reduce((s, u) => s + (u.cost || 0), 0);
        const weekT = weekU.reduce((s, u) => s + u.total_tokens, 0);
        const weekC = weekU.reduce((s, u) => s + (u.cost || 0), 0);
        const monthT = monthU.reduce((s, u) => s + u.total_tokens, 0);
        const monthC = monthU.reduce((s, u) => s + (u.cost || 0), 0);

        document.getElementById('todayToken').textContent = fmt(todayT);
        document.getElementById('todayCost').textContent = todayC > 0 ? todayC.toFixed(4) + ' ' + CUR : '-';
        document.getElementById('weekToken').textContent = fmt(weekT);
        document.getElementById('weekCost').textContent = weekC > 0 ? weekC.toFixed(4) + ' ' + CUR : '-';
        document.getElementById('monthToken').textContent = fmt(monthT);
        document.getElementById('monthCost').textContent = monthC > 0 ? monthC.toFixed(4) + ' ' + CUR : '-';

        // 图表
        if (usage.length > 0) {
            document.getElementById('chart').style.display = 'block';
            document.getElementById('chartWeek').style.display = 'block';
            document.getElementById('chartMonth').style.display = 'block';
            document.getElementById('noData').style.display = 'none';
            drawChart(usage);
            drawWeekChart(usage);
            drawMonthChart(usage);
        } else {
            document.getElementById('chart').style.display = 'none';
            document.getElementById('chartWeek').style.display = 'none';
            document.getElementById('chartMonth').style.display = 'none';
            document.getElementById('noData').style.display = 'block';
        }
    });

    window.addEventListener('resize', () => {
        if (chart) chart.resize();
        if (chartWeek) chartWeek.resize();
        if (chartMonth) chartMonth.resize();
    });
</script>
</body>
</html>`;
    }
}

function _nonce(): string {
    let t = '';
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) t += c.charAt(Math.floor(Math.random() * c.length));
    return t;
}
