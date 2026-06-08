import * as vscode from 'vscode';
import { PlatformProvider } from './types';
import { DeepSeekProvider } from './deepseek/provider';
import { GLMProvider } from './glm/provider';

/**
 * 平台注册中心：管理所有平台 Provider，支持切换当前活跃平台
 */
export class PlatformRegistry {
    private providers: Map<string, PlatformProvider> = new Map();
    private _activeId: string;

    constructor(context: vscode.ExtensionContext) {
        const ds = new DeepSeekProvider(context);
        const glm = new GLMProvider(context);
        this.providers.set(ds.id, ds);
        this.providers.set(glm.id, glm);

        // 默认活跃平台：从全局状态恢复，否则 DeepSeek
        this._activeId = context.globalState.get<string>('llmUsage.activePlatform', 'deepseek') || 'deepseek';
    }

    /** 所有已注册平台 */
    list(): PlatformProvider[] {
        return Array.from(this.providers.values());
    }

    /** 当前活跃平台 */
    get active(): PlatformProvider {
        return this.providers.get(this._activeId)!;
    }

    /** 根据 ID 获取 */
    get(id: string): PlatformProvider | undefined {
        return this.providers.get(id);
    }

    /** 切换活跃平台 */
    switchTo(id: string): PlatformProvider {
        const p = this.providers.get(id);
        if (!p) throw new Error(`未知平台: ${id}`);
        this._activeId = id;
        return p;
    }

    /** 持久化当前选择 */
    async persist(context: vscode.ExtensionContext): Promise<void> {
        await context.globalState.update('llmUsage.activePlatform', this._activeId);
    }
}
