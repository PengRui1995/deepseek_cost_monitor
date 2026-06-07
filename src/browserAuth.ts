import * as vscode from 'vscode';
import * as http from 'http';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { WebSocket } from 'ws';

const LOGIN_URL = 'https://platform.deepseek.com/usage';
const CDP_PORT = 9229;

/**
 * 通过 CDP (Chrome DevTools Protocol) 自动登录并获取平台 Token
 * 对标 MiMo Usage Monitor 的自动登录方案
 */
export async function extractTokenViaCDP(): Promise<string | null> {
    const browserPath = _findBrowser();
    if (!browserPath) {
        vscode.window.showErrorMessage('未找到 Chrome/Edge 浏览器，请手动设置 Token');
        return null;
    }

    const userDataDir = path.join(os.tmpdir(), 'deepseek-cdp-' + Date.now());
    fs.mkdirSync(userDataDir, { recursive: true });

    const proc = cp.spawn(browserPath, [
        `--remote-debugging-port=${CDP_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${userDataDir}`,
        LOGIN_URL,
    ], {
        detached: true,
        stdio: 'ignore',
    });

    // 确保进程在 VS Code 退出时被清理
    proc.unref();

    try {
        console.log(`[CDP] 浏览器已启动: ${browserPath}`);
        // 等待浏览器启动 + CDP 就绪
        const wsUrl = await _waitForCDP(CDP_PORT, 15000);
        if (!wsUrl) throw new Error('CDP 连接超时，请确保浏览器正常启动');

        console.log('[CDP] WebSocket 已连接，等待登录...');
        const token = await _extractToken(wsUrl, 120000);

        // 清理临时目录
        _rmdir(userDataDir);
        _killBrowser(proc);

        return token;
    } catch (err) {
        _rmdir(userDataDir);
        _killBrowser(proc);
        throw err;
    }
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

async function _waitForCDP(port: number, timeoutMs: number): Promise<string | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const data = await _httpGet(`http://localhost:${port}/json`);
            const pages: any[] = JSON.parse(data);
            const page = pages.find((p: any) => p.type === 'page' && p.url && p.url.includes('deepseek'));
            if (page?.webSocketDebuggerUrl) {
                return page.webSocketDebuggerUrl;
            }
        } catch { /* CDP 尚未就绪 */ }
        await _sleep(800);
    }
    return null;
}

async function _extractToken(wsUrl: string, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve, reject) => {
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

            // 启用 Network 域——捕获所有 API 请求（用于发现余额端点）
            _send(ws, ++msgId, 'Network.enable');

            // 启动轮询：每 2 秒检测一次登录状态
            pollTimer = setInterval(() => {
                const id = ++msgId;
                _send(ws, id, 'Runtime.evaluate', {
                    expression: `(function(){
                        try {
                            var href = window.location.href;
                            var raw = localStorage.getItem('userToken');
                            var token = null;
                            if (raw) {
                                try {
                                    var p = JSON.parse(raw);
                                    token = typeof p === 'string' ? p : (p.value || p.token || null);
                                } catch(e) { token = raw; }
                            }
                            return JSON.stringify({url: href, token: token || null});
                        } catch(e) { return JSON.stringify({url: '', token: null, err: e.message}); }
                    })()`,
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
                        console.log(`[CDP] 轮询: url=${(info.url||'').slice(0,60)}, token=${info.token ? '***有***' : '无'}`);
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
                if (url.includes('platform.deepseek.com') && (url.includes('/api/') || url.includes('/auth-api/'))) {
                    console.log(`[CDP] ${req.method || 'GET'} ${url.replace(/^https?:\/\/[^\/]+/, '')}`);
                }
            }
        });

        ws.on('error', (err) => { finish(null); console.log(`[CDP] WS错误: ${err.message}`); });
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
