/**
 * 生成自签 HTTPS 证书（离线可用，不需要 mkcert、不联网）。
 *
 *   npm run cert
 *
 * 生成的 certs/cert.pem + certs/key.pem 会被 vite.config.ts 自动使用，
 * 手机首次访问 https://<电脑IP>:5173 时点击「高级 → 继续访问」即可（浏览器会警告自签证书）。
 *
 * 想要手机不报警告，推荐用 mkcert：
 *   mkcert -install && mkcert -cert-file certs/cert.pem -key-file certs/key.pem <电脑IP> localhost 127.0.0.1
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const certDir = resolve(root, 'certs');

function localIPv4List() {
  const result = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) result.push(info.address);
    }
  }
  return result;
}

const ips = ['127.0.0.1', ...localIPv4List()];

let selfsigned;
try {
  const mod = await import('selfsigned');
  selfsigned = mod.default ?? mod;
} catch {
  console.error('[cert] 缺少依赖 selfsigned，请先运行：npm install');
  process.exit(1);
}

const altNames = [
  { type: 2, value: 'localhost' },
  { type: 7, ip: '127.0.0.1' },
  ...ips.filter((ip) => ip !== '127.0.0.1').map((ip) => ({ type: 7, ip })),
];

const attrs = [{ name: 'commonName', value: ips[1] ?? 'localhost' }];
const pems = selfsigned.generate(attrs, {
  days: 3650,
  keySize: 2048,
  algorithm: 'sha256',
  extensions: [
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ],
});

if (!existsSync(certDir)) mkdirSync(certDir, { recursive: true });
writeFileSync(resolve(certDir, 'key.pem'), pems.private);
writeFileSync(resolve(certDir, 'cert.pem'), pems.cert);

console.log('[cert] 已生成 certs/cert.pem 与 certs/key.pem');
console.log('[cert] 证书包含的地址：');
console.log('       https://localhost:5173');
for (const ip of ips.filter((i) => i !== '127.0.0.1')) {
  console.log(`       https://${ip}:5173   <- 手机用这个地址`);
}
console.log('[cert] 手机首次访问会提示证书不受信任，选择「高级 → 继续前往」即可。');
