import * as vscode from 'vscode';
import axios, { AxiosInstance } from 'axios';
import {
    PlatformProvider, CdpLoginConfig,
    BalanceInfo, UserSummary, UsageRecord,
} from '../types';

// ====================================================================
// GLMProvider —— 智谱 AI (open.bigmodel.cn)
//
// 认证模型：单一 JWT Token（从 cookie bigmodel_token_production 提取）
// - 余额: GET /api/biz/account/query-customer-account-report
// - 用量: GET /api/anthropic/api/monitor/usage/model-usage
// - 费用: GET /api/finance/monthlyBill/aggregatedMonthlyBills
// ====================================================================

export class GLMProvider implements PlatformProvider {
    // ---- PlatformProvider 元数据 ----

    readonly id = 'glm';
    readonly displayName = '智谱GLM';
    readonly statusBarPrefix = 'GLM';
    readonly currencyUnit = 'CNY';
    readonly warningThresholds = { low: 10, critical: 2 };

    readonly loginConfig: CdpLoginConfig = {
        loginUrl: 'https://open.bigmodel.cn/finance/overview',
        credentialSource: 'cookie',
        credentialKey: 'bigmodel_token_production',
        // JWT 直接使用，不需要额外解析
    };

    // ---- 内部状态 ----

    private billingClient: AxiosInstance;   // www.bigmodel.cn — 余额/账单
    private monitorClient: AxiosInstance;   // open.bigmodel.cn/api/anthropic — 用量
    private context: vscode.ExtensionContext;

    private readonly SECRET_JWT = 'glm-jwt-token';

    constructor(context: vscode.ExtensionContext) {
        this.context = context;

        this.billingClient = axios.create({
            baseURL: 'https://www.bigmodel.cn',
            timeout: 10000,
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        });

        this.monitorClient = axios.create({
            baseURL: 'https://open.bigmodel.cn/api/anthropic',
            timeout: 10000,
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        });
    }

    // ====================================================================
    // PlatformProvider 接口实现
    // ====================================================================

    async isConfigured(): Promise<boolean> {
        const jwt = await this.getJwt();
        return !!jwt;
    }

    async clearCredentials(): Promise<void> {
        await this.context.secrets.delete(this.SECRET_JWT);
    }

    // ---- 数据查询 ----

    async getBalance(): Promise<BalanceInfo[]> {
        const jwt = await this.getJwt();
        if (!jwt) throw new Error('未配置 GLM Token');

        try {
            const res = await this.billingClient.get(
                '/api/biz/account/query-customer-account-report',
                { headers: { 'Authorization': jwt } }
            );

            const data = res.data?.data || res.data || {};
            // 返回字段: balance, rechargeAmount, giveAmount, totalSpendAmount, availableBalance
            const total = parseFloat(data.balance || '0');
            const toppedUp = parseFloat(data.rechargeAmount || '0');
            const granted = parseFloat(data.giveAmount || '0');

            return [{
                currency: 'CNY',
                total_balance: total.toFixed(6),
                topped_up_balance: toppedUp.toFixed(6),
                granted_balance: granted.toFixed(6),
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
        const jwt = await this.getJwt();
        if (!jwt) throw new Error('未配置 GLM Token');

        try {
            // 同时获取余额 + 本月账单
            const [balanceRes, billRes] = await Promise.all([
                this.billingClient.get('/api/biz/account/query-customer-account-report', {
                    headers: { 'Authorization': jwt },
                }),
                this._getMonthlyBills(jwt),
            ]);

            const bal = balanceRes.data?.data || balanceRes.data || {};
            const totalBal = parseFloat(bal.balance || '0');
            const toppedUp = parseFloat(bal.rechargeAmount || '0');
            const granted = parseFloat(bal.giveAmount || '0');

            // 计算本月花费
            const monthCost = billRes?.thisMonthCost || 0;
            const monthTokens = billRes?.thisMonthTokens || 0;

            return {
                normal_wallets: [{
                    currency: 'CNY',
                    balance: toppedUp.toFixed(6),
                    token_estimation: '0',
                }],
                bonus_wallets: [{
                    currency: 'CNY',
                    balance: granted.toFixed(6),
                    token_estimation: '0',
                }],
                monthly_costs: [{
                    currency: 'CNY',
                    amount: monthCost.toFixed(4),
                }],
                monthly_token_usage: String(monthTokens),
                total_available_token_estimation: String(totalBal),
            };
        } catch (err) {
            if (axios.isAxiosError(err)) {
                throw new Error(`摘要查询失败 HTTP ${err.response?.status || 'N/A'}`);
            }
            throw err;
        }
    }

    async getUsage(_startDate: string, _endDate: string): Promise<UsageRecord[]> {
        const jwt = await this.getJwt();
        if (!jwt) return [];

        try {
            // 尝试 Anthropic 兼容的用量监控 API
            const now = new Date();
            const start = new Date(now);
            start.setDate(now.getDate() - 1);
            start.setMinutes(0, 0, 0);
            const end = new Date(now);
            end.setMinutes(59, 59, 999);

            const zFormat = (d: Date) =>
                `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

            const q = `?startTime=${encodeURIComponent(zFormat(start))}&endTime=${encodeURIComponent(zFormat(end))}`;

            const res = await this.monitorClient.get(`/api/monitor/usage/model-usage${q}`, {
                headers: { 'Authorization': jwt },
            });

            const mData = res.data?.data || {};

            // 解析返回的时序数据
            const records: UsageRecord[] = [];
            if (Array.isArray(mData.x_time)) {
                // 24h 用量合并为一条当日记录
                const totalCalls = mData.totalUsage?.totalModelCallCount || 0;
                const totalTokens = mData.totalUsage?.totalTokensUsage || 0;

                if (totalTokens > 0) {
                    const today = new Date().toISOString().split('T')[0];
                    records.push({
                        date: today,
                        model: 'glm-all',
                        input_tokens: totalTokens, // API 不区分 input/output
                        output_tokens: 0,
                        total_tokens: totalTokens,
                        cost: 0,
                    });
                }
            }

            return records;
        } catch (err) {
            // 用量 API 失败不作为致命错误
            if (axios.isAxiosError(err)) {
                console.log(`[GLM] 用量 API 失败: HTTP ${err.response?.status || 'N/A'}`);
            }
            return [];
        }
    }

    // ---- CSV ----

    parseUsageCsv(csvContent: string): UsageRecord[] {
        return _parseUsageCsv(csvContent);
    }

    // ====================================================================
    // GLM 特有：JWT 凭证管理
    // ====================================================================

    async getJwt(): Promise<string | undefined> {
        return await this.context.secrets.get(this.SECRET_JWT);
    }

    async setJwt(token: string): Promise<void> {
        await this.context.secrets.store(this.SECRET_JWT, token.trim());
    }

    async clearJwt(): Promise<void> {
        await this.context.secrets.delete(this.SECRET_JWT);
    }

    // ====================================================================
    // 内部
    // ====================================================================

    /** 获取本月账单摘要 */
    private async _getMonthlyBills(jwt: string): Promise<{ thisMonthCost: number; thisMonthTokens: number }> {
        const now = new Date();
        const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const end = start;

        try {
            const res = await this.billingClient.get(
                '/api/finance/monthlyBill/aggregatedMonthlyBills',
                {
                    headers: { 'Authorization': jwt },
                    params: {
                        billingMonthStart: `${now.getFullYear()}-01`,
                        billingMonthEnd: end,
                        pageNum: 1,
                        pageSize: 12,
                    },
                }
            );

            const records = res.data?.data?.records || [];
            let thisMonthCost = 0;
            let thisMonthTokens = 0;

            if (records.length > 0) {
                // 最后一条是本月
                const last = records[records.length - 1];
                thisMonthCost = parseFloat(last.totalAmount || '0');
                thisMonthTokens = parseInt(last.totalTokens || '0', 10);
            }

            return { thisMonthCost, thisMonthTokens };
        } catch {
            return { thisMonthCost: 0, thisMonthTokens: 0 };
        }
    }
}

// ====================================================================
// CSV 解析（复用通用逻辑）
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
