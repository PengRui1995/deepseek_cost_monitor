import * as vscode from 'vscode';
import axios, { AxiosInstance } from 'axios';
import {
    PlatformProvider, CdpLoginConfig,
    BalanceInfo, UserSummary, UsageRecord,
} from '../types';

// ====================================================================
// MimoProvider —— 小米 MiMo (platform.xiaomimimo.com)
//
// 认证模型：Cookie（小米账号 SSO 登录后获得）
// - 余额: GET /api/v1/balance
// - Token Plan 用量: GET /tokenPlan/usage
// - 用户信息: GET /api/v1/userProfile
//
// 双模式：按量付费（看余额）和 Token Plan 订阅制（看套餐用量）
// ====================================================================

export class MimoProvider implements PlatformProvider {
    // ---- PlatformProvider 元数据 ----

    readonly id = 'mimo';
    readonly displayName = '小米MiMo';
    readonly statusBarPrefix = 'MiMo';
    readonly currencyUnit = 'CNY';
    readonly warningThresholds = { low: 10, critical: 2 };

    readonly loginConfig: CdpLoginConfig = {
        loginUrl: 'https://platform.xiaomimimo.com/console/balance',
        credentialSource: 'cookie',
        credentialKey: '', // 使用通用 cookie 提取（提取全部 cookie）
    };

    // ---- 内部状态 ----

    private client: AxiosInstance;
    private context: vscode.ExtensionContext;

    private readonly SECRET_COOKIE = 'mimo-cookie';

    constructor(context: vscode.ExtensionContext) {
        this.context = context;

        this.client = axios.create({
            baseURL: 'https://platform.xiaomimimo.com',
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
        });
    }

    // ====================================================================
    // PlatformProvider 接口实现
    // ====================================================================

    async isConfigured(): Promise<boolean> {
        const cookie = await this.getCookie();
        return !!cookie;
    }

    async clearCredentials(): Promise<void> {
        await this.context.secrets.delete(this.SECRET_COOKIE);
    }

    // ---- 数据查询 ----

    async getBalance(): Promise<BalanceInfo[]> {
        const cookie = await this.getCookie();
        if (!cookie) throw new Error('未配置 MiMo Cookie');

        try {
            const res = await this.client.get('/api/v1/balance', {
                headers: { 'Cookie': cookie },
            });

            const data = res.data?.data || res.data || {};
            // balance: 总余额, cashBalance: 现金余额, giftBalance: 赠送余额
            const total = parseFloat(data.balance || '0');
            const cash = parseFloat(data.cashBalance || '0');
            const gift = parseFloat(data.giftBalance || '0');

            return [{
                currency: data.currency || 'CNY',
                total_balance: total.toFixed(6),
                topped_up_balance: cash.toFixed(6),
                granted_balance: gift.toFixed(6),
            }];
        } catch (err) {
            if (axios.isAxiosError(err)) {
                const status = err.response?.status || 'N/A';
                throw new Error(`余额查询失败 HTTP ${status}`);
            }
            throw err;
        }
    }

    async getUserSummary(): Promise<UserSummary | null> {
        const cookie = await this.getCookie();
        if (!cookie) throw new Error('未配置 MiMo Cookie');

        try {
            // 并行获取余额和 Token Plan 信息
            const [balanceRes, tpDetail] = await Promise.all([
                this.client.get('/api/v1/balance', { headers: { 'Cookie': cookie } }),
                this._getTokenPlanDetail(cookie),
            ]);

            const bal = balanceRes.data?.data || balanceRes.data || {};
            const totalBal = parseFloat(bal.balance || '0');
            const cash = parseFloat(bal.cashBalance || '0');
            const gift = parseFloat(bal.giftBalance || '0');

            const summary: UserSummary = {
                normal_wallets: [{
                    currency: bal.currency || 'CNY',
                    balance: cash.toFixed(6),
                    token_estimation: '0',
                }],
                bonus_wallets: [{
                    currency: bal.currency || 'CNY',
                    balance: gift.toFixed(6),
                    token_estimation: '0',
                }],
                monthly_costs: [],
                monthly_token_usage: '0',
                total_available_token_estimation: String(totalBal),
            };

            // Token Plan 信息（如果有）
            if (tpDetail) {
                const used = tpDetail.usedCredits || tpDetail.used || 0;
                const total = tpDetail.totalCredits || tpDetail.total || 0;
                const remaining = Math.max(0, total - used);

                summary.monthly_token_usage = String(used);
                summary.total_available_token_estimation = String(remaining);
                summary.monthly_costs = [{
                    currency: 'CNY',
                    amount: String(used),
                }];
            }

            return summary;
        } catch (err) {
            if (axios.isAxiosError(err)) {
                const status = err.response?.status || 'N/A';
                throw new Error(`摘要查询失败 HTTP ${status}`);
            }
            throw err;
        }
    }

    async getUsage(_startDate: string, _endDate: string): Promise<UsageRecord[]> {
        const cookie = await this.getCookie();
        if (!cookie) return [];

        try {
            const res = await this.client.get('/tokenPlan/usage', {
                headers: { 'Cookie': cookie },
            });

            const data = res.data?.data || res.data || {};
            return this._parseTokenPlanUsage(data);
        } catch (err) {
            // Token Plan 用量 API 失败不作为致命错误（可能是没有购买 Token Plan）
            if (axios.isAxiosError(err)) {
                console.log(`[MiMo] Token Plan 用量 API 失败: HTTP ${err.response?.status || 'N/A'}`);
            }
            return [];
        }
    }

    // ---- CSV ----

    parseUsageCsv(csvContent: string): UsageRecord[] {
        return _parseUsageCsv(csvContent);
    }

    // ====================================================================
    // MiMo 特有：Cookie 凭证管理
    // ====================================================================

    async getCookie(): Promise<string | undefined> {
        return await this.context.secrets.get(this.SECRET_COOKIE);
    }

    async setCookie(cookie: string): Promise<void> {
        // 自动解析可能的 JSON 包装
        try {
            const parsed = JSON.parse(cookie.trim());
            if (parsed.value && typeof parsed.value === 'string') {
                cookie = parsed.value;
            }
        } catch { /* 不是 JSON，直接用原始值 */ }
        await this.context.secrets.store(this.SECRET_COOKIE, cookie.trim());
    }

    async clearCookie(): Promise<void> {
        await this.context.secrets.delete(this.SECRET_COOKIE);
    }

    // ====================================================================
    // 内部
    // ====================================================================

    /** 获取 Token Plan 详情（可能返回 null 表示未购买） */
    private async _getTokenPlanDetail(cookie: string): Promise<any | null> {
        try {
            const res = await this.client.get('/tokenPlan/detail', {
                headers: { 'Cookie': cookie },
            });
            return res.data?.data || res.data || null;
        } catch (err) {
            // Token Plan 未购买或 API 不可用
            if (axios.isAxiosError(err) && err.response?.status === 404) {
                return null;
            }
            console.log(`[MiMo] Token Plan 详情获取失败: ${(err as Error).message}`);
            return null;
        }
    }

    /** 解析 Token Plan usage API 响应 */
    private _parseTokenPlanUsage(data: any): UsageRecord[] {
        // 尝试多种可能的响应格式
        const records: UsageRecord[] = [];

        // 格式1: { dailyUsage: [{ date, tokens, ... }] }
        if (Array.isArray(data.dailyUsage)) {
            for (const day of data.dailyUsage) {
                records.push({
                    date: day.date || '',
                    model: day.model || 'mimo-all',
                    input_tokens: parseInt(day.inputTokens || day.input_tokens || '0', 10),
                    output_tokens: parseInt(day.outputTokens || day.output_tokens || '0', 10),
                    total_tokens: parseInt(day.tokens || day.totalTokens || day.total_tokens || '0', 10),
                    cost: parseFloat(day.cost || '0'),
                });
            }
            return records;
        }

        // 格式2: { usage: [{ ... }] }
        if (Array.isArray(data.usage)) {
            for (const item of data.usage) {
                records.push({
                    date: item.date || '',
                    model: item.model || 'mimo-all',
                    input_tokens: parseInt(item.inputTokens || item.input_tokens || '0', 10),
                    output_tokens: parseInt(item.outputTokens || item.output_tokens || '0', 10),
                    total_tokens: parseInt(item.tokens || item.totalTokens || item.total_tokens || '0', 10),
                    cost: parseFloat(item.cost || '0'),
                });
            }
            return records;
        }

        // 格式3: 汇总数据（无每日明细），生成一条今日汇总
        const totalUsed = parseInt(data.usedCredits || data.used || data.totalUsage || '0', 10);
        if (totalUsed > 0) {
            const today = new Date().toISOString().split('T')[0];
            records.push({
                date: today,
                model: 'mimo-all',
                input_tokens: totalUsed,
                output_tokens: 0,
                total_tokens: totalUsed,
                cost: 0,
            });
        }

        return records;
    }
}

// ====================================================================
// CSV 解析（通用）
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
