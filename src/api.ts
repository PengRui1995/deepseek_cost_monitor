import * as vscode from 'vscode';
import axios, { AxiosInstance } from 'axios';

export interface BalanceInfo {
    currency: string;
    total_balance: string;
    granted_balance: string;
    topped_up_balance: string;
}

export interface UsageRecord {
    date: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost: number;
}

let _channel: vscode.OutputChannel | null = null;
function _log(msg: string): void {
    if (!_channel) _channel = vscode.window.createOutputChannel('DeepSeek用量查询');
    _channel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

export class DeepSeekAPI {
    private apiClient: AxiosInstance;
    private platformClient: AxiosInstance;
    private context: vscode.ExtensionContext;
    private readonly SECRET_API_KEY = 'deepseek-api-key';
    private readonly SECRET_TOKEN = 'deepseek-platform-token';

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        const config = vscode.workspace.getConfiguration('deepseekUsage');

        this.apiClient = axios.create({
            baseURL: config.get<string>('baseUrl', 'https://api.deepseek.com'),
            timeout: 15000,
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
        });

        this.platformClient = axios.create({
            baseURL: 'https://platform.deepseek.com',
            timeout: 15000,
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
        });
    }

    // ========== API Key（用于余额查询） ==========

    async getApiKey(): Promise<string | undefined> {
        return await this.context.secrets.get(this.SECRET_API_KEY)
            || vscode.workspace.getConfiguration('deepseekUsage').get<string>('apiKey')
            || undefined;
    }

    async setApiKey(key: string): Promise<void> {
        await this.context.secrets.store(this.SECRET_API_KEY, key);
    }

    async clearApiKey(): Promise<void> {
        await this.context.secrets.delete(this.SECRET_API_KEY);
    }

    // ========== Platform Token（用于用量查询） ==========

    async getPlatformToken(): Promise<string | undefined> {
        return await this.context.secrets.get(this.SECRET_TOKEN);
    }

    async setPlatformToken(token: string): Promise<void> {
        // 自动解析 localStorage JSON 包装: {"value":"xxx","__version":"0"} → xxx
        try {
            const parsed = JSON.parse(token.trim());
            if (parsed.value && typeof parsed.value === 'string') {
                token = parsed.value;
            }
        } catch { /* 不是 JSON，直接用原始值 */ }
        await this.context.secrets.store(this.SECRET_TOKEN, token.trim());
    }

    async clearPlatformToken(): Promise<void> {
        await this.context.secrets.delete(this.SECRET_TOKEN);
    }

    // ========== 余额（官方 API） ==========

    async getBalance(): Promise<BalanceInfo[]> {
        const key = await this.getApiKey();
        if (!key) throw new Error('未配置 API Key');

        const res = await this.apiClient.get('/user/balance', {
            headers: { 'Authorization': `Bearer ${key}` }
        });
        const data = res.data;
        if (data.is_available !== undefined && Array.isArray(data.balance_infos)) {
            return data.balance_infos;
        }
        return Array.isArray(data) ? data : [data];
    }

    // ========== 用量（平台内部 API /api/v0/usage/amount） ==========

    /**
     * 查询用量
     * 端点: GET https://platform.deepseek.com/api/v0/usage/amount?month=6&year=2026
     * 认证: Authorization: Bearer <platform_token>
     *
     * Token 获取:
     * 1. 打开 https://platform.deepseek.com 并登录
     * 2. F12 → Application → Local Storage → userToken
     * 3. VS Code: DeepSeek: 设置平台 Token → 粘贴
     */
    async getUsage(startDate: string, endDate: string): Promise<UsageRecord[]> {
        const token = await this.getPlatformToken();
        if (!token) {
            _log('未配置 Platform Token，跳过用量查询');
            return [];
        }

        const [yearStr, monthStr] = startDate.split('-');
        const month = parseInt(monthStr, 10);
        const year = parseInt(yearStr, 10);
        const headers = {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'Mozilla/5.0 Chrome/131.0.0.0',
            'Referer': 'https://platform.deepseek.com/usage',
        };

        try {
            // 同时请求 Token 用量 + 费用
            _log(`请求 amount + cost: month=${month}, year=${year}`);
            const [amountRes, costRes] = await Promise.all([
                this.platformClient.get('/api/v0/usage/amount', { headers, params: { month, year } }),
                this.platformClient.get('/api/v0/usage/cost', { headers, params: { month, year } }),
            ]);

            _log(`amount → HTTP ${amountRes.status}, cost → HTTP ${costRes.status}`);

            // 从 days 提取 token 数据
            const amountDays = amountRes.data?.data?.biz_data?.days || [];
            // 从 days 提取 cost 数据（结构相同但 amount 是 CNY）
            const costDays = costRes.data?.data?.biz_data?.[0]?.days || costRes.data?.data?.biz_data?.days || [];

            // 构建 cost 查找表: key="date-model" → cost
            const costMap = new Map<string, number>();
            for (const day of costDays) {
                for (const item of day.data || []) {
                    const totalCost = (item.usage || []).reduce((s: number, u: any) => s + parseFloat(u.amount || '0'), 0);
                    costMap.set(`${day.date}-${item.model}`, totalCost);
                }
            }

            // 解析 token 数据并合并 cost
            const records: UsageRecord[] = [];
            for (const day of amountDays) {
                for (const item of day.data || []) {
                    const model = item.model || '';
                    const usageList = item.usage || [];
                    let totalTokens = 0, inputTokens = 0, outputTokens = 0;

                    for (const u of usageList) {
                        const amt = parseInt(u.amount || '0', 10);
                        totalTokens += amt;
                        if (u.type?.includes('PROMPT') || u.type?.includes('CACHE')) inputTokens += amt;
                        else if (u.type?.includes('RESPONSE')) outputTokens += amt;
                    }

                    if (totalTokens > 0) {
                        const key = `${day.date}-${model}`;
                        records.push({
                            date: day.date,
                            model,
                            input_tokens: inputTokens,
                            output_tokens: outputTokens,
                            total_tokens: totalTokens,
                            cost: costMap.get(key) || 0,
                        });
                    }
                }
            }

            _log(`→ 合并结果: ${records.length}条`);
            if (records.length > 0) _channel?.show(true);
            return records;

        } catch (err) {
            if (axios.isAxiosError(err)) {
                _log(`→ HTTP ${err.response?.status} ${JSON.stringify(err.response?.data || '').slice(0, 300)}`);
            } else {
                _log(`→ 异常: ${err}`);
            }
        }

        _log('用量端点无数据');
        _channel?.show(true);
        return [];
    }

    // ========== CSV 导入 ==========

    parseUsageCsv(csvContent: string): UsageRecord[] {
        const lines = csvContent.trim().split('\n');
        if (lines.length < 2) return [];

        const headers = _parseCsvLine(lines[0])
            .map(h => h.toLowerCase().replace(/['"]/g, '').trim());

        const idx = {
            date: headers.findIndex(h => h.includes('date') || h.includes('时间')),
            model: headers.findIndex(h => h.includes('model') || h.includes('模型')),
            input: headers.findIndex(h => h.includes('input') || h.includes('prompt') || h.includes('输入')),
            output: headers.findIndex(h => h.includes('output') || h.includes('completion') || h.includes('输出')),
            total: headers.findIndex(h => h === 'total_tokens' || h.includes('total')),
            cost: headers.findIndex(h => h.includes('cost') || h.includes('费用')),
        };

        const records: UsageRecord[] = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = _parseCsvLine(lines[i]);
            if (cols.length === 0) continue;

            const input = idx.input >= 0 ? parseInt(cols[idx.input]?.trim() || '0', 10) : 0;
            const output = idx.output >= 0 ? parseInt(cols[idx.output]?.trim() || '0', 10) : 0;
            const total = idx.total >= 0
                ? parseInt(cols[idx.total]?.trim() || '0', 10)
                : input + output;

            const date = idx.date >= 0 ? cols[idx.date]?.trim() : '';
            if (date && total > 0) {
                records.push({
                    date,
                    model: idx.model >= 0 ? cols[idx.model]?.trim() : '',
                    input_tokens: input || 0,
                    output_tokens: output || 0,
                    total_tokens: total || 0,
                    cost: idx.cost >= 0 ? parseFloat(cols[idx.cost]?.trim() || '0') : 0,
                });
            }
        }
        return records;
    }

    // ========== 内部 ==========

}

function _parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
        if (ch === '"') { inQuotes = !inQuotes; }
        else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
        else { current += ch; }
    }
    result.push(current);
    return result;
}
