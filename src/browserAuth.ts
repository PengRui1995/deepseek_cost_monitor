import * as vscode from 'vscode';
import * as http from 'http';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { WebSocket } from 'ws';
import type { CdpLoginConfig } from './platforms/types';

const CDP_PORT = 9229;

/**
 * 通用 CDP 登录：接受 CdpLoginConfig 参数
 * 每个平台 Provider 通过 `loginConfig` 提供自己的配置
 */
export async function extractTokenViaCDPWithConfig(config: CdpLoginConfig): Promise<string | null> {
    const browserPath = _findBrowser();
    if (!browserPath) {
        vscode.window.showErrorMessage('未找到 Chrome/Edge 浏览器，请手动设置 Token');
        return null;
    }

    const userDataDir = path.join(os.tmpdir(), `llm-cdp-${Date.now()}`);
    fs.mkdirSync(userDataDir, { recursive: true });

    const proc = cp.spawn(browserPath, [
        `--remote-debugging-port=${CDP_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${userDataDir}`,
        config.loginUrl,
    ], {
        detached: true,
        stdio: 'ignore',
    });

    proc.unref();

    try {
        console.log(`[CDP] 浏览器已启动: ${browserPath}`);
        const wsUrl = await _waitForCDP(CDP_PORT, 15000, config.loginUrl);
        if (!wsUrl) throw new Error('CDP 连接超时，请确保浏览器正常启动');

        console.log('[CDP] WebSocket 已连接，等待登录...');
        const token = await _extractTokenGeneric(wsUrl, 120000, config);

        _rmdir(userDataDir);
        _killBrowser(proc);
        return token;
    } catch (err) {
        _rmdir(userDataDir);
        _killBrowser(proc);
        throw err;
    }
}

/**
 * DeepSeek 专用 CDP 登录（向后兼容）
 * 对标 MiMo Usage Monitor 的自动登录方案
 */
export async function extractTokenViaCDP(): Promise<string | null> {
    const config: CdpLoginConfig = {
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
    return extractTokenViaCDPWithConfig(config);
}

// ========== 查找浏览器 ==========

function _findBrowser(): string | null {
    if (process.platform === 'win32') {
        // Edge (Windows 自带)
        const edgePaths = [
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
        ];
        for (const p of edgePaths) {
            if (fs.existsSync(p)) return p;
        }

        // Chrome
        const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        if (fs.existsSync(chromePath)) return chromePath;

        const chromeX86 = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
        if (fs.existsSync(chromeX86)) return chromeX86;
    } else if (process.platform === 'darwin') {
        const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
        if (fs.existsSync(chrome)) return chrome;
    } else {
        // Linux
        for (const cmd of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
            try {
                const result = cp.execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf8' }).trim();
                if (result) return result;
            } catch { /* not found */ }
        }
    }
    return null;
}

// ========== CDP 协议 ==========

interface CDPMessage {
    id: number;
    method?: string;
    result?: any;
    error?: any;
    params?: any;
}

async function _waitForCDP(port: number, timeoutMs: number, loginUrl: string): Promise<string | null> {
    // 从 loginUrl 中提取域名关键词用于匹配页面
    const domainHint = new URL(loginUrl).hostname.split('.').slice(-2)[0]; // e.g. 'deepseek', 'bigmodel'
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const data = await _httpGet(`http://localhost:${port}/json`);
            const pages: any[] = JSON.parse(data);
            const page = pages.find((p: any) =>
                p.type === 'page' && p.url && (
                    p.url.includes(domainHint) || p.url.includes(loginUrl.replace(/^https?:\/\//, '').split('/')[0])
                )
            );
            if (page?.webSocketDebuggerUrl) {
                return page.webSocketDebuggerUrl;
            }
        } catch { /* CDP 尚未就绪 */ }
        await _sleep(800);
    }
    return null;
}

/** 通用 Token 提取：根据 CdpLoginConfig 从 localStorage 或 cookie 中提取凭证 */
async function _extractTokenGeneric(wsUrl: string, timeoutMs: number, config: CdpLoginConfig): Promise<string | null> {
    // 构建注入到浏览器中的 JS 表达式
    const tokenParserExpr = config.tokenParser
        ? `(${config.tokenParser.toString()})(raw)`
        : 'raw';

    // 根据凭证来源构建不同的提取逻辑
    let extractCode: string;
    if (config.credentialSource === 'cookie') {
        // 从 document.cookie 中提取指定名称的 cookie
        extractCode = `
            var raw = null;
            var cookies = document.cookie.split('; ');
            for (var i = 0; i < cookies.length; i++) {
                var parts = cookies[i].split('=');
                if (parts[0] === '${config.credentialKey}') {
                    raw = decodeURIComponent(parts.slice(1).join('='));
                    break;
                }
            }
        `;
    } else {
        // 从 localStorage 提取
        extractCode = `
            var raw = localStorage.getItem('${config.credentialKey}');
        `;
    }

    const expression = `(function(){
        try {
            var href = window.location.href;
            ${extractCode}
            var token = null;
            if (raw) {
                try { token = ${tokenParserExpr}; } catch(e) { token = raw; }
            }
            return JSON.stringify({url: href, token: token || null});
        } catch(e) { return JSON.stringify({url: '', token: null, err: e.message}); }
    })()`;

    // 提取域名用于 Network 请求过滤
    const domainHost = new URL(config.loginUrl).hostname;

    return new Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        let msgId = 0;
        const callbacks = new Map<number, (result: any) => void>();
        let timeout: NodeJS.Timeout;
        let pollTimer: NodeJS.Timeout;
        let done = false;

        const finish = (token: string | null) => {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            clearInterval(pollTimer);
            ws.close();
            resolve(token);
        };

        ws.on('open', () => {
            timeout = setTimeout(() => {
                console.log('[CDP] 轮询超时');
                finish(null);
            }, timeoutMs);

            // 启用 Network 域——捕获所有 API 请求（用于调试）
            _send(ws, ++msgId, 'Network.enable');

            // 启动轮询：每 2 秒检测一次 localStorage
            pollTimer = setInterval(() => {
                const id = ++msgId;
                _send(ws, id, 'Runtime.evaluate', {
                    expression,
                    returnByValue: true,
                });
                callbacks.set(id, (result) => {
                    try {
                        const value = result?.result?.value;
                        if (!value) {
                            console.log('[CDP] 轮询: 无返回值');
                            return;
                        }
                        const info = JSON.parse(value);
                        console.log(`[CDP] 轮询: url=${(info.url || '').slice(0, 60)}, token=${info.token ? '***有***' : '无'}`);
                        if (info.token) {
                            finish(info.token);
                        }
                    } catch (e) {
                        console.log(`[CDP] 轮询解析失败: ${e}`);
                    }
                });
            }, 2000);
        });

        ws.on('message', (data: Buffer) => {
            const msg: CDPMessage = JSON.parse(data.toString());
            if (msg.id && callbacks.has(msg.id)) {
                callbacks.get(msg.id)!(msg.result || msg.error);
                callbacks.delete(msg.id);
            }

            // 捕获 API 请求（调试用）
            if (msg.method === 'Network.requestWillBeSent') {
                const req = msg.params?.request || {};
                const url: string = req.url || '';
                if (url.includes(domainHost) && (url.includes('/api/') || url.includes('/auth-api/'))) {
                    console.log(`[CDP] ${req.method || 'GET'} ${url.replace(/^https?:\/\/[^\/]+/, '')}`);
                }
            }
        });

        ws.on('error', (err) => {
            finish(null);
            console.log(`[CDP] WS错误: ${err.message}`);
        });
        ws.on('close', () => { finish(null); });
    });
}

// ========== 工具函数 ==========

function _send(ws: WebSocket, id: number, method: string, params?: any): void {
    ws.send(JSON.stringify({ id, method, params }));
}

function _httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

function _sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

function _killBrowser(proc: cp.ChildProcess): void {
    try {
        if (process.platform === 'win32') {
            cp.execSync(`taskkill /PID ${proc.pid} /T /F 2>nul`, { stdio: 'ignore' });
        } else {
            process.kill(-proc.pid!, 'SIGTERM');
        }
    } catch { /* 已退出 */ }
}

function _rmdir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
}
