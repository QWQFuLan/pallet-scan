/**
 * 受限环境自检脚本：用 esbuild 的 WASM 版本在「进程内」打包指定入口，
 * 不启动任何子进程（某些沙箱会拦截 Node 的管道子进程）。
 *
 *   node scripts/wasm-bundle.mjs tests/index.ts .tmp/tests.cjs
 */
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.argv[2] ?? 'tests/index.ts';
const outfile = process.argv[3] ?? '.tmp/tests.cjs';

const wasmBinaryPath = join(root, 'node_modules', 'esbuild-wasm', 'esbuild.wasm');
if (!existsSync(wasmBinaryPath)) {
  console.error('[wasm-bundle] 找不到 esbuild-wasm，请先运行：npm install --save-dev esbuild-wasm');
  process.exit(1);
}

const esbuild = await import('esbuild-wasm');
// Node 版本的 esbuild-wasm 会自己读取包内的 esbuild.wasm，无需指定路径
await esbuild.initialize({ worker: false });

await esbuild.build({
  absWorkingDir: root,
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info',
  alias: { '@': join(root, 'src') },
  define: { 'process.env.NODE_ENV': '"test"' },
});

console.log(`[wasm-bundle] 已生成 ${resolve(root, outfile)}`);
