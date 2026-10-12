/**
 * 一键跑「真实浏览器端到端验证」：
 *   1) 构建产物（如果 dist 不存在或 --build）
 *   2) 启动 vite preview（有 certs/ 就用 https，否则 http）
 *   3) 用 Playwright + Chromium 跑 tests/browser-e2e.mjs
 *   4) 关闭服务器
 *
 *   npm run test:browser
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import httpsModule from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

function findFreePort(start) {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(start, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
    server.on('error', () => resolvePort(findFreePort(start + 1)));
  });
}

function run(command, args, options = {}) {
  // 某些受限环境不允许 esbuild 清理系统临时目录，把临时目录指到工程内更稳
  const tempDir = join(root, '.tmp', 'esbuild-tmp');
  mkdirSync(tempDir, { recursive: true });
  return spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir },
    ...options,
  });
}

/**
 * 等待服务器就绪。
 * 注意：本地是自签名证书，不能用 fetch（会因证书不受信任直接失败），
 * 所以 https 用 node:https + rejectUnauthorized:false 探测。
 */
function probe(url) {
  return new Promise((resolveProbe) => {
    if (url.startsWith('https://')) {
      const { request } = httpsModule;
      const req = request(url, { rejectUnauthorized: false, method: 'GET', timeout: 3000 }, (res) => {
        res.resume();
        resolveProbe(res.statusCode === 200);
      });
      req.on('error', () => resolveProbe(false));
      req.on('timeout', () => {
        req.destroy();
        resolveProbe(false);
      });
      req.end();
      return;
    }
    fetch(url, { method: 'GET' })
      .then((res) => resolveProbe(res.ok))
      .catch(() => resolveProbe(false));
  });
}

function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveReady, reject) => {
    const attempt = async () => {
      if (await probe(url)) return resolveReady();
      if (Date.now() > deadline) return reject(new Error(`等待服务器超时：${url}`));
      setTimeout(attempt, 300);
    };
    void attempt();
  });
}

const useHttps = existsSync(join(root, 'certs', 'cert.pem'));
const port = await findFreePort(4173);
const protocol = useHttps ? 'https' : 'http';
const baseURL = `${protocol}://localhost:${port}`;

if (!existsSync(join(root, 'dist', 'index.html'))) {
  console.log('[test:browser] 没有 dist，先构建…');
  const build = run(process.execPath, [join(root, 'scripts', 'build.mjs')]);
  await new Promise((done, fail) =>
    build.on('exit', (code) => (code === 0 ? done() : fail(new Error(`构建失败：${code}`)))),
  );
}

console.log(`[test:browser] 启动预览服务器 ${baseURL}`);
const server = run(process.execPath, [viteBin, 'preview', '--port', String(port), '--strictPort']);

let exitCode = 1;
try {
  await waitForServer(baseURL);
  const test = run(process.execPath, [join(here, 'browser-e2e.mjs'), baseURL]);
  exitCode = await new Promise((done) => test.on('exit', (code) => done(code ?? 1)));
  if (exitCode === 0) {
    console.log('\n— 摄像头容错自检 —');
    const cameraTest = run(process.execPath, [join(here, 'camera-resilience.mjs'), baseURL]);
    exitCode = await new Promise((done) => cameraTest.on('exit', (code) => done(code ?? 1)));
  }
} catch (error) {
  console.error(error.message);
} finally {
  server.kill();
}

process.exit(exitCode);
