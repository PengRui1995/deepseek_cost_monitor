import * as vscode from 'vscode';
import { DeepSeekAPI, BalanceInfo, UsageRecord } from './api';

export class DashboardViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'deepseekUsage.dashboard';
    private _view?: vscode.WebviewView;
    private api: DeepSeekAPI;
    usageRecords: UsageRecord[] = [];

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
                case 'setKey': vscode.commands.executeCommand('deepseek-usage.setApiKey'); break;
                case 'importCsv': await this._importCsv(); break;
                case 'exportCsv': await this._exportCsv(); break;
            }
        });

        this.refresh();
    }

    async refresh(): Promise<void> {
        if (!this._view) return;
        try {
            const balance = await this.api.getBalance().catch(() => []);

            // 尝试获取今日用量（API Key 或 Cookie 方式）
            const today = new Date().toISOString().split('T')[0];
            const usage = await this.api.getUsage(today, today).catch(() => []);
            if (usage.length > 0) {
                const existing = new Map(this.usageRecords.map(r => [`${r.date}-${r.model}`, r]));
                for (const u of usage) existing.set(`${u.date}-${u.model}`, u);
                this.usageRecords = Array.from(existing.values());
            }

            this._view.webview.postMessage({
                command: 'data',
                balance,
                usage: this.usageRecords
            });
        } catch (err) {
            this._view.webview.postMessage({ command: 'error', message: String(err) });
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
    </style>
</head>
<body>
    <div class="row">
        <button id="btnRefresh">🔄 刷新</button>
        <button id="btnImport" class="s">📥 导入CSV</button>
        <button id="btnExport" class="s">📤 导出</button>
    </div>
    <div id="error" class="err" style="display:none"></div>

    <div id="empty" style="display:none">
        <div class="empty">
            <p>🔑 请先设置 DeepSeek API Key</p>
            <button id="btnSetKey">设置 API Key</button>
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
            <div class="card"><div class="cl">今日 Token</div><div class="cv" id="today">-</div></div>
            <div class="card"><div class="cl">本月 Token</div><div class="cv" id="month">-</div></div>
            <div class="card"><div class="cl">记录数</div><div class="cv" id="count">-</div></div>
            <div class="card"><div class="cl">预估费用</div><div class="cv" id="cost">-</div></div>
        </div>
        <div id="chart" class="chart"></div>
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
        let chart = null;

        document.getElementById('btnRefresh').addEventListener('click', ()=>vscode.postMessage({command:'refresh'}));
        document.getElementById('btnImport').addEventListener('click', ()=>vscode.postMessage({command:'importCsv'}));
        document.getElementById('btnExport').addEventListener('click', ()=>vscode.postMessage({command:'exportCsv'}));
        document.getElementById('btnSetKey').addEventListener('click', ()=>vscode.postMessage({command:'setKey'}));

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

        window.addEventListener('message',e=>{
            const m=e.data;
            if(m.command==='error'){
                document.getElementById('error').style.display='block';
                document.getElementById('error').textContent=m.message;
            }
            if(m.command!=='data')return;
            document.getElementById('error').style.display='none';

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
            const todayT=usage.filter(u=>u.date===today).reduce((s,u)=>s+u.total_tokens,0);
            const monthT=usage.filter(u=>u.date.startsWith(month)).reduce((s,u)=>s+u.total_tokens,0);
            const cst=usage.reduce((s,u)=>s+(u.cost||0),0);

            document.getElementById('today').textContent=fmt(todayT);
            document.getElementById('month').textContent=fmt(monthT);
            document.getElementById('count').textContent=usage.length.toLocaleString();
            document.getElementById('cost').textContent=cst>0?cst.toFixed(4)+' '+cur:'-';

            if(usage.length>0){
                document.getElementById('chart').style.display='block';
                document.getElementById('noData').style.display='none';
                drawChart(usage);
            }else{
                document.getElementById('chart').style.display='none';
                document.getElementById('noData').style.display='block';
            }
        });
        window.addEventListener('resize',()=>{if(chart)chart.resize();});
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
