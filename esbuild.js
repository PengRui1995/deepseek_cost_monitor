const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

// 清理 out/ 目录（esbuild 只产出一个 extension.js）
function cleanOut() {
    const outDir = path.join(__dirname, 'out');
    if (fs.existsSync(outDir)) {
        for (const f of fs.readdirSync(outDir)) {
            fs.unlinkSync(path.join(outDir, f));
        }
    }
}

async function build() {
    cleanOut();

    /** @type {import('esbuild').BuildOptions} */
    const opts = {
        entryPoints: ['src/extension.ts'],
        bundle: true,
        outfile: 'out/extension.js',
        external: ['vscode'],
        platform: 'node',
        target: 'node16',
        format: 'cjs',
        sourcemap: isWatch,
        minify: false,
        keepNames: true,
    };

    if (isWatch) {
        const ctx = await esbuild.context(opts);
        await ctx.watch();
        console.log('esbuild watching...');
    } else {
        await esbuild.build(opts);
        console.log('esbuild build complete');
    }
}

build().catch((e) => { console.error(e); process.exit(1); });
