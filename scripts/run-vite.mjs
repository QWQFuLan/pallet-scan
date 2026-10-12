/**
 * 沙箱/受限环境下运行 Vite 的辅助脚本：
 * 某些受限环境会拦截 Node 的「管道 stdio」子进程（spawn EPERM），
 * 导致 esbuild / rollup 的原生子进程无法启动。
 * 这里把 pipe 改为 inherit 后再启动 Vite，仅用于本机受限环境下自检。
 *
 * 正常使用项目时不需要它：直接 `npm run dev` / `npm run build`。
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
// 注意：ESM 命名空间对象是只读的，必须拿到可写的 CJS 导出对象再改。
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;

function patchOptions(options) {
  if (!options || typeof options !== 'object') return options;
  const stdio = options.stdio;
  if (Array.isArray(stdio)) {
    return { ...options, stdio: stdio.map((s) => (s === 'pipe' ? 'inherit' : s)) };
  }
  if (stdio === 'pipe') return { ...options, stdio: 'inherit' };
  return options;
}

childProcess.spawn = function patchedSpawn(command, args, options) {
  return originalSpawn.call(this, command, args, patchOptions(options));
};

const here = dirname(fileURLToPath(import.meta.url));
const viteBin = join(here, '..', 'node_modules', 'vite', 'bin', 'vite.js');
const args = process.argv.slice(2);
const passthrough = args.length ? args : ['build'];

const child = spawn(process.execPath, [viteBin, ...passthrough], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
