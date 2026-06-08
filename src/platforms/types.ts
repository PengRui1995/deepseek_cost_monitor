// ====================================================================
// 平台无关的通用数据模型 & PlatformProvider 接口
// 每个平台（DeepSeek / GLM / OpenAI / ...）实现此接口
// ====================================================================

/** 余额信息（通用结构） */
export interface BalanceInfo {
    currency: string;
    total_balance: string;
    granted_balance: string;
    topped_up_balance: string;
}

/** 平台 Token 获取的用户摘要（余额 + 用量概览） */
export interface UserSummary {
    /** 充值钱包 */
    normal_wallets: { currency: string; balance: string; token_estimation: string }[];
    /** 赠送钱包 */
    bonus_wallets: { currency: string; balance: string; token_estimation: string }[];
    /** 本月花费 */
    monthly_costs: { currency: string; amount: string }[];
    /** 本月 Token 用量 */
    monthly_token_usage: string;
    /** 预估可用 Token */
    total_available_token_estimation: string;
}

/** 用量明细记录 */
export interface UsageRecord {
    date: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost: number;
}

/** 凭证来源类型 */
export type CredentialSource = 'localStorage' | 'cookie';

/** CDP 浏览器登录配置 */
export interface CdpLoginConfig {
    /** 浏览器打开的登录页 URL */
    loginUrl: string;
    /** 凭证来源类型 */
    credentialSource: CredentialSource;
    /** 凭证 key 名（localStorage key 或 cookie name） */
    credentialKey: string;
    /** 可选的 Token 解析器：从原始值提取 token */
    tokenParser?: (raw: string) => string | null;
}

// ====================================================================
// PlatformProvider 接口
// ====================================================================

export interface PlatformProvider {
    /** 平台唯一标识，如 'deepseek' | 'glm' | 'openai' */
    readonly id: string;
    /** 显示名称，如 'DeepSeek' | '智谱GLM' */
    readonly displayName: string;
    /** 状态栏前缀，如 'DS' | 'GLM' */
    readonly statusBarPrefix: string;
    /** 货币单位，如 'CNY' | 'USD' */
    readonly currencyUnit: string;
    /** 余额告警阈值 */
    readonly warningThresholds: { low: number; critical: number };
    /** CDP 登录配置，null 表示不支持自动登录 */
    readonly loginConfig: CdpLoginConfig | null;

    // ---- 认证 ----

    /** 是否已配置有效凭证（至少一套） */
    isConfigured(): Promise<boolean>;

    /** 清除该平台所有凭证 */
    clearCredentials(): Promise<void>;

    // ---- 数据查询 ----

    /** 查询余额 */
    getBalance(): Promise<BalanceInfo[]>;

    /** 查询用户摘要（余额 + 用量概览），可能返回 null */
    getUserSummary(): Promise<UserSummary | null>;

    /** 查询指定日期范围的用量明细 */
    getUsage(startDate: string, endDate: string): Promise<UsageRecord[]>;

    // ---- CSV ----

    /** 解析该平台官方导出的用量 CSV */
    parseUsageCsv(content: string): UsageRecord[];
}
