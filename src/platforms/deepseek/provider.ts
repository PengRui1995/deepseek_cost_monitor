import * as vscode from 'vscode';
import axios, { AxiosInstance } from 'axios';
import {
    PlatformProvider, CdpLoginConfig,
    BalanceInfo, UserSummary, UsageRecord,
} from '../types';

// ====================================================================
// 日志通道（模块级，所有 Provider 共享）
// ====================================================================

let _channel: vscode.OutputChannel | null = null;
function _log(msg: string): void {
    if (!_channel) _channel = vscode.window.createOutputChannel('LLM用量查询');
    _channel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ====================================================================
// DeepSeekProvider
// ====================================================================

export class DeepSeekProvider implements PlatformProvider {
    // ---- PlatformProvider 元数据 ----

    readonly id = 'deepseek';
    readonly displayName = 'DeepSeek';
    readonly statusBarPrefix = 'DS';
    readonly currencyUnit = 'CNY';
    readonly warningThresholds = { low: 10, critical: 2 };

    readonly loginConfig: CdpLoginConfig = {
        loginUrl: 'https://platform.deepseek.com/usage',
        credentialSource: 'localStorage',
        credentialKey: 'userToken',
        tokenParser: (raw: string): string | null => {
            try {
                const parsed = JSON.parse(raw);
                return typeof parsed === 'string'
                    ? parsed
                    : (parsed.value || parsed.token || null);
            } catch {
                return raw;
            }
        },
    };

    // ---- 内部状态 ----

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
            timeout: 8000,
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        });

        this.platformClient = axios.create({
            baseURL: 'https://platform.deepseek.com',
            timeout: 8000,
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        });
    }

    // ====================================================================
    // PlatformProvider 接口实现
    // ====================================================================

    async isConfigured(): Promise<boolean> {
        const token = await this.getPlatformToken();
        return !!token;
    }

    async clearCredentials(): Promise<void> {
        await this.context.secrets.delete(this.SECRET_API_KEY);
        await this.context.secrets.delete(this.SECRET_TOKEN);
    }

    // ---- 数据查询 ----

    async getBalance(): Promise<BalanceInfo[]> {
        const key = await this.getApiKey();
        if (!key) {
            // 回退：尝试通过平台摘要获取余额
            try {
                const summary = await this.getUserSummary();
                if (summary) return this.summaryToBalance(summary);
            } catch { /* 忽略 */ }
            throw new Error('未配置 API Key');
        }

        const res = await this.apiClient.get('/user/balance', {
            headers: { 'Authorization': `Bearer ${key}` },
        });
        const data = res.data;
        if (data.is_available !== undefined && Array.isArray(data.balance_infos)) {
            return data.balance_infos;
        }
        return Array.isArray(data) ? data : [data];
    }

    async getUserSummary(): Promise<UserSummary | null> {
        const token = await this.getPlatformToken();
        if (!token) {
            _log('未配置 Platform Token，跳过摘要查询');
            throw new Error('未配置平台 Token');
        }

        const headers = {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'Mozilla/5.0 Chrome/131.0.0.0',
            'Referer': 'https://platform.deepseek.com/usage',
        };

        const res = await this.platformClient.get('/api/v0/users/get_user_summary', { headers });
        const biz = res.data?.data?.biz_data;
        if (!biz) throw new Error('摘要数据为空');

        _log(`摘要: 充值${biz.normal_wallets?.[0]?.balance || '0'} + 赠送${biz.bonus_wallets?.[0]?.balance || '0'}, 本月花费${biz.monthly_costs?.[0]?.amount || '0'}`);

        return {
            normal_wallets: biz.normal_wallets || [],
            bonus_wallets: biz.bonus_wallets || [],
            monthly_costs: biz.monthly_costs || [],
            monthly_token_usage: biz.monthly_token_usage || '0',
            total_available_token_estimation: biz.total_available_token_estimation || '0',
        };
    }

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
            _log(`请求 amount + cost: month=${month}, year=${year}`);
            const [amountRes, costRes] = await Promise.all([
                this.platformClient.get('/api/v0/usage/amount', { headers, params: { month, year } }),
                this.platformClient.get('/api/v0/usage/cost', { headers, params: { month, year } }),
            ]);

            _log(`amount → HTTP ${amountRes.status}, cost → HTTP ${costRes.status}`);

            const amountDays = amountRes.data?.data?.biz_data?.days || [];
            const costDays = costRes.data?.data?.biz_data?.[0]?.days || costRes.data?.data?.biz_data?.days || [];

            // 构建 cost 查找表
            const costMap = new Map<string, number>();
            for (const day of costDays) {
                for (const item of day.data || []) {
                    const totalCost = (item.usage || []).reduce(
                        (s: number, u: any) => s + parseFloat(u.amount || '0'), 0
                    );
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
                const status = err.response?.status || 'N/A';
                const msg = err.response?.data?.error?.message || err.message || '';
                _log(`→ HTTP ${status} ${msg.slice(0, 200)}`);
            } else {
                _log(`→ 网络异常: ${(err as Error).message || '未知错误'}`);
            }
        }

        _log('用量端点无数据');
        _channel?.show(true);
        return [];
    }

    // ---- CSV ----

    parseUsageCsv(csvContent: string): UsageRecord[] {
        return _parseUsageCsv(csvContent);
    }

    // ====================================================================
    // DeepSeek 特有：凭证管理（extension.ts 命令使用）
    // ====================================================================

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

    // ====================================================================
    // DeepSeek 特有：余额转换
    // ====================================================================

    /** 将平台摘要转为 BalanceInfo（兼容旧接口） */
    summaryToBalance(summary: UserSummary): BalanceInfo[] {
        const result: BalanceInfo[] = [];
        for (const w of summary.normal_wallets) {
            const bonus = summary.bonus_wallets.find(b => b.currency === w.currency);
            result.push({
                currency: w.currency,
                total_balance: String((parseFloat(w.balance) + parseFloat(bonus?.balance || '0')).toFixed(6)),
                topped_up_balance: w.balance,
                granted_balance: bonus?.balance || '0',
            });
        }
        // bonus only (no normal wallet)
        for (const b of summary.bonus_wallets) {
            if (!summary.normal_wallets.find(w => w.currency === b.currency)) {
                result.push({
                    currency: b.currency,
                    total_balance: b.balance,
                    topped_up_balance: '0',
                    granted_balance: b.balance,
                });
            }
        }
        return result;
    }
}

// ====================================================================
// CSV 解析（通用，可被多个 Provider 复用）
// ====================================================================

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

function _parseUsageCsv(csvContent: string): UsageRecord[] {
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
