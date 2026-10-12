/**
 * 打包入口（等价于 `vite build`，但把 esbuild 的临时目录指到工程内）。
 *
 *   node scripts/build.mjs      # 或 npm run build
 *
 * 为什么不用 `vite build`：
 *   某些环境下 esbuild 无法删除系统临时目录里的文件（Windows 权限/安全软件/受限沙箱），
 *   会报 `[vite:esbuild-transpile] remove ...: Access is denied`。
 *   把 TMP/TEMP/TMPDIR 指到工程内的 .tmp/ 就能稳定构建，且不依赖任何环境设置。
 *   （Node 的 os.tmpdir() 会读取这些变量，esbuild 首次调用时才会缓存，所以这里设置是有效的。）
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = join(root, '.tmp', 'esbuild-tmp');
mkdirSync(tempDir, { recursive: true });

process.env.TMPDIR = tempDir;
process.env.TEMP = tempDir;
process.env.TMP = tempDir;

const { build } = await import('vite');

try {
  await build({ root });
  console.log('\n[build] 打包完成 -> dist/');
} catch (error) {
  console.error('\n[build] 打包失败：', error?.message ?? error);
  process.exit(1);
}
