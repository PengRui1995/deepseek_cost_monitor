import * as vscode from 'vscode';
import { DeepSeekAPI, BalanceInfo, UsageRecord } from './api';

export class DashboardViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'deepseekUsage.dashboard';
    private _view?: vscode.WebviewView;
    private api: DeepSeekAPI;
    usageRecords: UsageRecord[] = [];
    private _autoRefreshTimer?: ReturnType<typeof setInterval>;
    private _autoRefreshOn = false;
    private _refreshSeconds = 60;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        api: DeepSeekAPI
    ) {
        this.api = api;
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
                case 'setKey': vscode.commands.executeCommand('deepseek-usage.setApiKey'); break;
                case 'setToken': vscode.commands.executeCommand('deepseek-usage.setToken'); break;
                case 'clearConfig': vscode.commands.executeCommand('deepseek-usage.clearConfig'); break;
                case 'importCsv': await this._importCsv(); break;
                case 'exportCsv': await this._exportCsv(); break;
                case 'toggleAutoRefresh': this._autoRefreshOn = !!msg.on; this._autoRefreshOn ? this._startTimer() : this._stopTimer(); break;
                case 'setRefreshInterval': this._refreshSeconds = parseInt(msg.seconds, 10) || 60; if (this._autoRefreshOn) { this._stopTimer(); this._startTimer(); } break;
            }
        });

        this.refresh();
    }

    /** 通知 WebView 更新凭证状态（不加载数据，仅刷新欢迎界面按钮） */
    async notifyConfigChanged(): Promise<void> {
        if (!this._view) return;
        const key = await this.api.getApiKey();
        const token = await this.api.getPlatformToken();
        if (!key && !token) {
            this._view.webview.postMessage({ command: 'needConfig', hasKey: false, hasToken: false });
            return;
        }
        // 凭证已配置但用户尚未点击"查询用量"，仍显示欢迎界面但启用按钮
        this._view.webview.postMessage({ command: 'needConfig', hasKey: !!key, hasToken: !!token });
    }

    private _startTimer(): void {
        this._stopTimer();
        this._autoRefreshTimer = setInterval(() => this.refresh(), this._refreshSeconds * 1000);
    }

    private _stopTimer(): void {
        if (this._autoRefreshTimer) { clearInterval(this._autoRefreshTimer); this._autoRefreshTimer = undefined; }
    }

    async refresh(): Promise<void> {
        if (!this._view) return;

        // 检查是否已配置任一种凭证
        const key = await this.api.getApiKey();
        const token = await this.api.getPlatformToken();
        if (!key && !token) {
            this._view.webview.postMessage({ command: 'needConfig', hasKey: false, hasToken: false });
            return;
        }

        try {
            const balance = key ? await this.api.getBalance().catch(() => []) : [];

            // 尝试获取用量（需要平台 Token）
            if (token) {
                const today = new Date().toISOString().split('T')[0];
                const usage = await this.api.getUsage(today, today).catch(() => []);
                if (usage.length > 0) {
                    const existing = new Map(this.usageRecords.map(r => [`${r.date}-${r.model}`, r]));
                    for (const u of usage) existing.set(`${u.date}-${u.model}`, u);
                    this.usageRecords = Array.from(existing.values());
                }
            }

            this._view.webview.postMessage({
                command: 'data',
                balance,
                usage: this.usageRecords,
                hasKey: !!key,
                hasToken: !!token,
                autoRefresh: this._autoRefreshOn,
                refreshInterval: this._refreshSeconds,
            });
        } catch (err) {
            const msg = (err as any)?.response?.status
                ? `HTTP ${(err as any).response.status}`
                : (err as Error).message || '未知错误';
            this._view.webview.postMessage({ command: 'error', message: msg });
        }
    }

    private async _importCsv(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'CSV': ['csv'] },
            title: '导入 DeepSeek 用量 CSV'
        });
        if (!uris || uris.length === 0) return;
        try {
            const data = await vscode.workspace.fs.readFile(uris[0]);
            const records = this.api.parseUsageCsv(Buffer.from(data).toString('utf-8'));
            if (records.length === 0) {
                vscode.window.showWarningMessage('CSV 解析失败，请使用 DeepSeek 官方导出的文件');
                return;
            }
            this.usageRecords = records;
            await this.refresh();
            vscode.window.showInformationMessage(`已导入 ${records.length} 条用量记录`);
        } catch (err) {
            vscode.window.showErrorMessage(`导入失败: ${err}`);
        }
    }

    private async _exportCsv(): Promise<void> {
        if (this.usageRecords.length === 0) {
            vscode.window.showWarningMessage('暂无用量数据');
            return;
        }
        const h = ['date', 'model', 'input_tokens', 'output_tokens', 'total_tokens', 'cost'];
        const rows = this.usageRecords.map(u => [u.date, u.model, u.input_tokens, u.output_tokens, u.total_tokens, u.cost].join(','));
        const csv = [h.join(','), ...rows].join('\n');
        const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file('deepseek-usage.csv'), filters: { 'CSV': ['csv'] } });
        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf-8'));
            vscode.window.showInformationMessage('已导出');
        }
    }

    // ========== WebView HTML ==========

    private _html(webview: vscode.Webview): string {
        const nonce = _nonce();
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; style-src 'unsafe-inline';">
    <style>
        *{margin:0;padding:0;box-sizing:border-box;}
        body{
            font-family:var(--vscode-font-family);
            font-size:var(--vscode-font-size,12px);
            padding:10px;
            color:var(--vscode-foreground);
            background:var(--vscode-sideBar-background);
        }
        .row{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;}
        button{
            background:var(--vscode-button-background);
            color:var(--vscode-button-foreground);
            border:none;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:11px;
        }
        button:hover{background:var(--vscode-button-hoverBackground);}
        button.s{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);}
        button.s:hover{background:var(--vscode-button-secondaryHoverBackground);}
        .card{
            padding:8px 10px;border-radius:4px;
            background:var(--vscode-sideBarSectionHeader-background,rgba(128,128,128,.1));
            border:1px solid var(--vscode-widget-border,transparent);
        }
        .cards{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;}
        .cl{font-size:10px;opacity:.7;margin-bottom:2px;}
        .cv{font-size:14px;font-weight:600;}
        .chart{width:100%;height:200px;border-radius:4px;margin-top:10px;
            background:var(--vscode-sideBarSectionHeader-background,rgba(128,128,128,.1));
            border:1px solid var(--vscode-widget-border,transparent);}
        .empty{text-align:center;padding:30px 16px;opacity:.7;}
        .empty p{margin-bottom:10px;}
        .err{color:var(--vscode-errorForeground);padding:8px;margin:6px 0;
            background:var(--vscode-inputValidation-errorBackground);border-radius:3px;font-size:11px;}
        hr{border:none;border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.2));margin:8px 0;}
        .sec{font-size:11px;font-weight:600;opacity:.8;margin-bottom:6px;}
        a{color:var(--vscode-textLink-foreground);}
        .toggle{display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;user-select:none;}
        .toggle input{display:none;}
        .toggle .knob{width:28px;height:16px;border-radius:10px;background:var(--vscode-input-background,rgba(128,128,128,.3));position:relative;transition:.2s;flex-shrink:0;}
        .toggle .knob::after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--vscode-foreground);transition:.2s;}
        .toggle input:checked+.knob{background:var(--vscode-button-background);}
        .toggle input:checked+.knob::after{left:14px;}
        .autoRow{display:flex;align-items:center;gap:8px;font-size:11px;}
        .autoRow select{
            background:var(--vscode-input-background);color:var(--vscode-input-foreground);
            border:1px solid var(--vscode-input-border,var(--vscode-widget-border));padding:2px 4px;border-radius:3px;font-size:11px;
        }
        .autoRow select option{
            background:var(--vscode-input-background);color:var(--vscode-input-foreground);
        }
    </style>
</head>
<body>
    <div class="row">
        <button id="btnRefresh">🔄 刷新</button>
        <button id="btnImport" class="s">📥 导入CSV</button>
        <button id="btnExport" class="s">📤 导出</button>
        <button id="btnClear" class="s" style="color:var(--vscode-errorForeground)">🗑 清空配置</button>
        <span style="flex-grow:1;"></span>
        <label class="toggle" id="autoToggle">
            <input type="checkbox" id="chkAuto">
            <span class="knob"></span>
            <span>自动刷新</span>
        </label>
        <select id="selInterval" style="display:none;">
            <option value="10">10s</option>
            <option value="60">60s</option>
            <option value="60">1min</option>
            <option value="600">10min</option>
            <option value="3600">1h</option>
        </select>
    </div>
    <div id="error" class="err" style="display:none"></div>

    <div id="empty" style="display:none">
        <div class="empty">
            <p style="font-size:32px;margin-bottom:8px;">🔑</p>
            <p style="font-weight:600;margin-bottom:4px;">欢迎使用 DeepSeek 用量查询</p>
            <p style="font-size:11px;opacity:.7;margin-bottom:16px;">请至少配置一种凭证后开始使用</p>
            <div style="display:flex;flex-direction:column;gap:8px;align-items:center;">
                <button id="btnSetKey" style="width:180px;">🔐 设置 API Key</button>
                <span style="font-size:10px;opacity:.5;">查询余额（推荐）</span>
                <button id="btnSetToken" style="width:180px;">🛡️ 设置平台 Token</button>
                <span style="font-size:10px;opacity:.5;">查询用量明细</span>
            </div>
            <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.2));">
                <button id="btnQuery" style="width:200px;padding:6px 16px;font-size:12px;font-weight:600;" disabled>📊 查询用量</button>
                <p style="font-size:10px;opacity:.5;margin-top:6px;" id="btnQueryHint">请先设置 API Key</p>
            </div>
            <p style="font-size:10px;opacity:.5;margin-top:16px;">
                也可以在 VS Code 设置中手动填入<br>
                <code>deepseekUsage.apiKey</code>
            </p>
        </div>
    </div>

    <div id="content" style="display:none">
        <div class="sec">💰 余额</div>
        <div class="cards">
            <div class="card"><div class="cl">总余额</div><div class="cv" id="totalBal">-</div></div>
            <div class="card"><div class="cl">充值余额</div><div class="cv" id="toppedUp">-</div></div>
            <div class="card"><div class="cl">赠送余额</div><div class="cv" id="granted">-</div></div>
            <div class="card"><div class="cl">状态</div><div class="cv" id="status">-</div></div>
        </div>

        <hr>
        <div class="sec">📊 用量统计 <span style="font-weight:normal;opacity:.6;font-size:10px;">(CSV)</span></div>
        <div class="cards">
            <div class="card"><div class="cl">今日 Token</div><div class="cv" id="todayToken">-</div></div>
            <div class="card"><div class="cl">今日费用</div><div class="cv" id="todayCost">-</div></div>
            <div class="card"><div class="cl">本周 Token</div><div class="cv" id="weekToken">-</div></div>
            <div class="card"><div class="cl">本周费用</div><div class="cv" id="weekCost">-</div></div>
            <div class="card"><div class="cl">本月 Token</div><div class="cv" id="monthToken">-</div></div>
            <div class="card"><div class="cl">本月费用</div><div class="cv" id="monthCost">-</div></div>
        </div>
        <div id="chart" class="chart"></div>
        <div class="sec" style="margin-top:8px;">📈 本周用量</div>
        <div id="chartWeek" class="chart"></div>
        <div class="sec" style="margin-top:8px;">📈 本月用量</div>
        <div id="chartMonth" class="chart"></div>
        <div id="noData" style="text-align:center;padding:16px;font-size:11px;opacity:.6;">
            暂无用量数据<br>
            <span style="font-size:10px;">
                前往 <a href="https://platform.deepseek.com/usage">DeepSeek Usage</a> 导出CSV
            </span>
        </div>
    </div>

    <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let chart=null, chartWeek=null, chartMonth=null;

        document.getElementById('btnRefresh').addEventListener('click', ()=>vscode.postMessage({command:'refresh'}));
        document.getElementById('btnImport').addEventListener('click', ()=>vscode.postMessage({command:'importCsv'}));
        document.getElementById('btnExport').addEventListener('click', ()=>vscode.postMessage({command:'exportCsv'}));
        document.getElementById('btnClear').addEventListener('click', ()=>vscode.postMessage({command:'clearConfig'}));
        document.getElementById('btnSetKey').addEventListener('click', ()=>vscode.postMessage({command:'setKey'}));
        document.getElementById('btnSetToken').addEventListener('click', ()=>vscode.postMessage({command:'setToken'}));
        document.getElementById('btnQuery').addEventListener('click', ()=>vscode.postMessage({command:'openDashboard'}));
        document.getElementById('chkAuto').addEventListener('change', function(){
            const on=this.checked;
            document.getElementById('selInterval').style.display=on?'inline-block':'none';
            vscode.postMessage({command:'toggleAutoRefresh',on:on});
        });
        document.getElementById('selInterval').addEventListener('change', function(){
            vscode.postMessage({command:'setRefreshInterval',seconds:this.value});
        });

        function fmt(t){return t>=1e6?(t/1e6).toFixed(1)+'M':t>=1e3?(t/1e3).toFixed(1)+'K':t.toLocaleString();}

        function drawChart(data){
            const dom=document.getElementById('chart');
            if(!dom||typeof echarts==='undefined')return;
            if(chart)chart.dispose();
            chart=echarts.init(dom);
            const dates=[...new Set(data.map(d=>d.date))].sort();
            const models=[...new Set(data.map(d=>d.model))];
            const tc=getComputedStyle(document.body).color||'#ccc';
            chart.setOption({
                tooltip:{trigger:'axis',axisPointer:{type:'shadow'}},
                legend:{data:models,textStyle:{color:tc,fontSize:9},top:0},
                grid:{left:'3%',right:'4%',bottom:'3%',top:28,containLabel:true},
                xAxis:{type:'category',data:dates,axisLabel:{color:tc,rotate:45,fontSize:8}},
                yAxis:{type:'value',axisLabel:{color:tc,fontSize:8,formatter:v=>v>=1e6?(v/1e6).toFixed(1)+'M':v>=1e3?(v/1e3).toFixed(0)+'K':v}},
                series:models.map(m=>({
                    name:m,type:'bar',stack:'total',
                    data:dates.map(d=>{const i=data.find(r=>r.date===d&&r.model===m);return i?i.total_tokens:0;})
                }))
            });
        }

        function _drawLine(domId, inst, dates, values, label){
            const dom=document.getElementById(domId);
            if(!dom||typeof echarts==='undefined')return inst;
            if(inst)inst.dispose();
            const nc=echarts.init(dom);
            const tc=getComputedStyle(document.body).color||'#ccc';
            nc.setOption({
                tooltip:{trigger:'axis'},
                grid:{left:'3%',right:'4%',bottom:'3%',top:10,containLabel:true},
                xAxis:{type:'category',data:dates,axisLabel:{color:tc,fontSize:8}},
                yAxis:{type:'value',axisLabel:{color:tc,fontSize:8,formatter:v=>v>=1e6?(v/1e6).toFixed(1)+'M':v>=1e3?(v/1e3).toFixed(0)+'K':v}},
                series:[{
                    name:label,type:'line',data:values,
                    lineStyle:{width:2},itemSize:4,
                    areaStyle:{opacity:0.08}
                }]
            });
            return nc;
        }

        function drawWeekChart(usage){
            const d=new Date();const dow=d.getDay();
            const mon=new Date(d);mon.setDate(d.getDate()-(dow===0?6:dow-1));
            const days=[];for(let i=0;i<7;i++){const dt=new Date(mon);dt.setDate(mon.getDate()+i);days.push(dt.toISOString().split('T')[0]);}
            const values=days.map(dd=>usage.filter(u=>u.date===dd).reduce((s,u)=>s+u.total_tokens,0));
            chartWeek=_drawLine('chartWeek',chartWeek,days.map(dd=>dd.slice(5)),values,'Token');
        }

        function drawMonthChart(usage){
            const now=new Date();const y=now.getFullYear(),m=now.getMonth();
            const daysInMonth=new Date(y,m+1,0).getDate();
            const days=[];for(let i=1;i<=daysInMonth;i++){days.push(y+'-'+(String(m+1).padStart(2,'0'))+'-'+(String(i).padStart(2,'0')));}
            const values=days.map(dd=>usage.filter(u=>u.date===dd).reduce((s,u)=>s+u.total_tokens,0));
            chartMonth=_drawLine('chartMonth',chartMonth,days.map(dd=>dd.slice(5)),values,'Token');
        }

        window.addEventListener('message',e=>{
            const m=e.data;
            if(m.command==='error'){
                document.getElementById('error').style.display='block';
                document.getElementById('error').textContent=m.message;
            }
            if(m.command==='needConfig'){
                document.getElementById('error').style.display='none';
                document.getElementById('empty').style.display='block';
                document.getElementById('content').style.display='none';
                // 根据凭证状态启用/禁用"查询用量"按钮
                const btnQuery=document.getElementById('btnQuery');
                const hint=document.getElementById('btnQueryHint');
                if(m.hasKey||m.hasToken){
                    btnQuery.disabled=false;
                    btnQuery.title='';
                    hint.style.display='none';
                }else{
                    btnQuery.disabled=true;
                    btnQuery.title='请先设置 API Key 或平台 Token';
                    hint.style.display='block';
                }
                return;
            }
            if(m.command!=='data')return;
            document.getElementById('error').style.display='none';

            // 同步自动刷新控件状态
            const chk=document.getElementById('chkAuto');
            const sel=document.getElementById('selInterval');
            chk.checked=!!m.autoRefresh;
            sel.style.display=m.autoRefresh?'inline-block':'none';
            if(m.refreshInterval)sel.value=String(m.refreshInterval);

            const bal=m.balance||[],usage=m.usage||[];
            if(bal.length===0){
                document.getElementById('empty').style.display='block';
                document.getElementById('content').style.display='none';
                return;
            }
            document.getElementById('empty').style.display='none';
            document.getElementById('content').style.display='block';

            const tb=bal.reduce((s,b)=>s+parseFloat(b.total_balance||0),0);
            const tu=bal.reduce((s,b)=>s+parseFloat(b.topped_up_balance||0),0);
            const tg=bal.reduce((s,b)=>s+parseFloat(b.granted_balance||0),0);
            const cur=bal[0]?.currency||'CNY';

            document.getElementById('totalBal').textContent=tb.toFixed(2)+' '+cur;
            document.getElementById('toppedUp').textContent=tu.toFixed(2)+' '+cur;
            document.getElementById('granted').textContent=tg.toFixed(2)+' '+cur;
            document.getElementById('status').textContent=tb>0?'✅ 可用':'⚠️ 余额不足';

            const today=new Date().toISOString().split('T')[0];
            const month=today.slice(0,7);

            // 本周一
            const d=new Date();const dow=d.getDay();
            const mon=new Date(d);mon.setDate(d.getDate()-(dow===0?6:dow-1));
            const monStr=mon.toISOString().split('T')[0];

            const todayU=usage.filter(u=>u.date===today);
            const weekU=usage.filter(u=>u.date>=monStr);
            const monthU=usage.filter(u=>u.date.startsWith(month));

            const todayT=todayU.reduce((s,u)=>s+u.total_tokens,0);
            const todayC=todayU.reduce((s,u)=>s+(u.cost||0),0);
            const weekT=weekU.reduce((s,u)=>s+u.total_tokens,0);
            const weekC=weekU.reduce((s,u)=>s+(u.cost||0),0);
            const monthT=monthU.reduce((s,u)=>s+u.total_tokens,0);
            const monthC=monthU.reduce((s,u)=>s+(u.cost||0),0);

            document.getElementById('todayToken').textContent=fmt(todayT);
            document.getElementById('todayCost').textContent=todayC>0?todayC.toFixed(4)+' '+cur:'-';
            document.getElementById('weekToken').textContent=fmt(weekT);
            document.getElementById('weekCost').textContent=weekC>0?weekC.toFixed(4)+' '+cur:'-';
            document.getElementById('monthToken').textContent=fmt(monthT);
            document.getElementById('monthCost').textContent=monthC>0?monthC.toFixed(4)+' '+cur:'-';

            if(usage.length>0){
                document.getElementById('chart').style.display='block';
                document.getElementById('chartWeek').style.display='block';
                document.getElementById('chartMonth').style.display='block';
                document.getElementById('noData').style.display='none';
                drawChart(usage);
                drawWeekChart(usage);
                drawMonthChart(usage);
            }else{
                document.getElementById('chart').style.display='none';
                document.getElementById('chartWeek').style.display='none';
                document.getElementById('chartMonth').style.display='none';
                document.getElementById('noData').style.display='block';
            }
        });
        window.addEventListener('resize',()=>{if(chart)chart.resize();if(chartWeek)chartWeek.resize();if(chartMonth)chartMonth.resize();});
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
