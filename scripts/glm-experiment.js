/**
 * GLM 诊断实验：通过 CDP 抓取登录后的 API 调用和 cookie
 *
 * 用法: node scripts/glm-experiment.js
 *
 * 流程:
 * 1. 启动 Chrome 打开 GLM 控制台
 * 2. 用户手动登录
 * 3. 脚本实时打印所有 API 请求 + 提取 cookie
 * 4. 60 秒后自动结束
 */

const http = require('http');
const cp = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { WebSocket } = require('ws');

const CDP_PORT = 9230;

// ===== 找浏览器 =====

function findBrowser() {
    if (process.platform === 'win32') {
        const paths = [
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ];
        for (const p of paths) {
            if (fs.existsSync(p)) return p;
        }
    } else if (process.platform === 'darwin') {
        const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
        if (fs.existsSync(p)) return p;
    } else {
        for (const cmd of ['google-chrome', 'chromium', 'microsoft-edge']) {
            try {
                return cp.execSync(`which ${cmd}`, { encoding: 'utf8' }).trim();
            } catch {}
        }
    }
    return null;
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ===== 主流程 =====

async function main() {
    const browserPath = findBrowser();
    if (!browserPath) {
        console.error('未找到浏览器');
        process.exit(1);
    }
    console.log(`浏览器: ${browserPath}`);

    // 启动浏览器，打开 GLM 用量控制台
    const GLM_URL = 'https://open.bigmodel.cn/finance/overview';
    const userDataDir = path.join(os.tmpdir(), 'glm-cdp-' + Date.now());
    fs.mkdirSync(userDataDir, { recursive: true });

    const proc = cp.spawn(browserPath, [
        `--remote-debugging-port=${CDP_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${userDataDir}`,
        GLM_URL,
    ], {
        detached: true,
        stdio: 'ignore',
    });
    proc.unref();

    console.log('\n📡 等待 CDP 就绪...');
    let wsUrl = null;
    const start = Date.now();
    while (Date.now() - start < 20000) {
        try {
            const data = await httpGet(`http://localhost:${CDP_PORT}/json`);
            const pages = JSON.parse(data);
            console.log(`   页面数: ${pages.length}`, pages.map(p => p.url?.slice(0, 60)));
            const page = pages.find(p =>
                p.type === 'page' && p.url && (p.url.includes('bigmodel.cn') || p.url.includes('z.ai'))
            );
            if (page?.webSocketDebuggerUrl) {
                wsUrl = page.webSocketDebuggerUrl;
                console.log(`✅ CDP 已连接: ${page.url}`);
                break;
            }
        } catch (e) {
            // 尚未就绪
        }
        await sleep(1000);
    }

    if (!wsUrl) {
        console.error('❌ CDP 连接超时');
        killBrowser(proc);
        process.exit(1);
    }

    console.log('\n🔑 请在浏览器中登录 GLM...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('监听中: 所有 GLM API 请求 (60秒)');
    console.log('━'.repeat(50));

    const ws = new WebSocket(wsUrl);
    let msgId = 0;
    let capturedEndpoints = new Set();
    let cookieString = '';

    ws.on('open', () => {
        // 启用 Network 域
        ws.send(JSON.stringify({ id: ++msgId, method: 'Network.enable' }));

        // 每 5 秒检查一次 cookie
        const cookieTimer = setInterval(async () => {
            const id = ++msgId;
            ws.send(JSON.stringify({
                id, method: 'Runtime.evaluate',
                params: { expression: 'document.cookie', returnByValue: true }
            }));
        }, 5000);

        // 60 秒后自动结束
        setTimeout(() => {
            clearInterval(cookieTimer);
            console.log('\n' + '━'.repeat(50));
            console.log('\n📊 诊断结果汇总:');
            console.log('━'.repeat(50));
            console.log('\n捕获到的 API 端点:');
            if (capturedEndpoints.size === 0) {
                console.log('  (无) — 可能未登录或页面未发起请求');
            } else {
                Array.from(capturedEndpoints).sort().forEach(e => console.log(`  ${e}`));
            }
            console.log('\nCookie:');
            if (cookieString) {
                // 解析 cookie 展示关键字段
                const cookies = {};
                cookieString.split(';').forEach(c => {
                    const [k, v] = c.trim().split('=');
                    if (k) cookies[k] = v ? v.substring(0, 20) + (v.length > 20 ? '...' : '') : '(empty)';
                });
                Object.entries(cookies).forEach(([k, v]) => console.log(`  ${k} = ${v}`));
            } else {
                console.log('  (无 cookie)');
            }
            console.log('\n✅ 实验结束，浏览器自动关闭');
            killBrowser(proc);
            process.exit(0);
        }, 60000);
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        // 接收 cookie 查询结果
        if (msg.id && msg.result?.result?.value) {
            cookieString = msg.result.result.value;
            console.log('\n🍪 Cookie 已捕获:');
            cookieString.split(';').forEach(c => {
                const [k, v] = c.trim().split('=');
                const short = v ? v.substring(0, 30) + (v.length > 30 ? '...' : '') : '';
                console.log(`   ${k.trim()} = ${short}`);
            });
            console.log('');
        }

        // 捕获 Network 请求
        if (msg.method === 'Network.requestWillBeSent') {
            const req = msg.params?.request || {};
            const url = req.url || '';
            // 只关注 bigmodel.cn 相关 API
            if ((url.includes('bigmodel.cn') || url.includes('z.ai')) && url.includes('/api/')) {
                const method = req.method || 'GET';
                const headers = req.headers || {};
                const authHeader = headers['Authorization'] || headers['authorization'] || '(无)';
                const cookieHeader = headers['Cookie'] || headers['cookie'] || '(无)';

                // 提取路径部分
                const pathOnly = url.replace(/^https?:\/\/[^\/]+/, '');
                if (capturedEndpoints.has(pathOnly)) return; // 去重
                capturedEndpoints.add(pathOnly);

                console.log(`\n📡 ${method} ${pathOnly}`);
                console.log(`   Authorization: ${typeof authHeader === 'string' ? authHeader.substring(0, 50) + (authHeader.length > 50 ? '...' : '') : authHeader}`);
                console.log(`   Cookie: ${typeof cookieHeader === 'string' ? cookieHeader.substring(0, 80) + (cookieHeader.length > 80 ? '...' : '') : cookieHeader}`);
            }
        }
    });

    ws.on('error', (err) => {
        console.error(`WS 错误: ${err.message}`);
    });

    ws.on('close', () => {
        console.log('WS 连接关闭');
    });
}

function killBrowser(proc) {
    try {
        if (process.platform === 'win32') {
            cp.execSync(`taskkill /PID ${proc.pid} /T /F 2>nul`, { stdio: 'ignore' });
        } else {
            process.kill(-proc.pid, 'SIGTERM');
        }
    } catch {}
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
