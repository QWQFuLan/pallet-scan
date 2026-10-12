import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 本地 HTTPS 配置（手机摄像头必须处于安全上下文才能调用 getUserMedia）。
 *
 * 优先级：
 *   1. 环境变量 SSL_CERT / SSL_KEY 指定的证书（例如 mkcert 生成）
 *   2. certs/cert.pem + certs/key.pem（可用 `npm run cert` 或 mkcert 生成）
 *   3. vite-plugin-mkcert（自动生成本地受信任证书，首次运行会申请安装本地 CA）
 *   4. 都没有 -> 使用纯 HTTP（仅电脑本机 localhost 可用摄像头；手机需走 1/2/3）
 *
 * `npm run dev:http` 使用 insecure 模式，强制 HTTP，便于只用电脑调试界面。
 */
function resolveHttpsOptions(): { https?: any; note: string } {
  const fromEnvCert = process.env.SSL_CERT;
  const fromEnvKey = process.env.SSL_KEY;
  if (fromEnvCert && fromEnvKey && existsSync(fromEnvCert) && existsSync(fromEnvKey)) {
    return {
      https: { cert: readFileSync(fromEnvCert), key: readFileSync(fromEnvKey) },
      note: `HTTPS 证书来自环境变量 SSL_CERT/SSL_KEY`,
    };
  }

  const certPath = resolve(process.cwd(), 'certs/cert.pem');
  const keyPath = resolve(process.cwd(), 'certs/key.pem');
  if (existsSync(certPath) && existsSync(keyPath)) {
    return {
      https: { cert: readFileSync(certPath), key: readFileSync(keyPath) },
      note: 'HTTPS 证书来自 certs/cert.pem + certs/key.pem',
    };
  }

  return { note: 'HTTPS 证书由 vite-plugin-mkcert 自动生成' };
}

export default defineConfig(async ({ mode }) => {
  const insecure = mode === 'insecure';
  const plugins: PluginOption[] = [react()];
  const resolved = resolveHttpsOptions();

  let https: any = resolved.https;
  if (!insecure && !https) {
    // mkcert：生成本地受信任证书；离线/失败时自动降级为 HTTP，不阻塞启动。
    try {
      const mod: any = await import('vite-plugin-mkcert');
      plugins.push(mod.default({ force: false, savePath: resolve(process.cwd(), '.mkcert') }));
      console.log('\n[pallet-scan] ' + resolved.note + '（首次运行可能需要授权安装本地 CA）');
    } catch (error) {
      console.warn('\n[pallet-scan] mkcert 插件不可用，降级为 HTTP：', (error as Error).message);
    }
  } else {
    console.log('\n[pallet-scan] ' + resolved.note);
  }

  return {
    plugins,
    base: './',
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      host: true, // 监听 0.0.0.0，手机可通过局域网 IP 访问
      port: 5173,
      strictPort: false,
      https,
    },
    preview: {
      host: true,
      port: 4173,
      strictPort: false,
      https,
    },
    build: {
      target: 'es2020',
      chunkSizeWarningLimit: 2048,
      rollupOptions: {
        output: {
          manualChunks: {
            xlsx: ['xlsx'],
            zxing: ['@zxing/browser', '@zxing/library'],
            vendor: ['react', 'react-dom', 'zustand', 'dexie'],
          },
        },
      },
    },
  };
});
