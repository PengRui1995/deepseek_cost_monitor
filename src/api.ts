// ====================================================================
// 向后兼容 re-export
// 原 DeepSeekAPI 类已迁移至 src/platforms/deepseek/provider.ts
// 旧代码 `import { DeepSeekAPI } from './api'` 仍然有效
// ====================================================================

export { DeepSeekProvider as DeepSeekAPI } from './platforms/deepseek/provider';
export type { BalanceInfo, UserSummary, UsageRecord } from './platforms/types';
