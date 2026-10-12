/**
 * 冒烟测试：用 https:// 请求 preview 服务器，确认页面与资源都能正常返回。
 *   node tests/smoke-https.mjs [port]
 */
import https from 'node:https';

const port = Number(process.argv[2] ?? 4173);

function get(path) {
  return new Promise((resolve, reject) => {
    https
      .get({ host: 'localhost', port, path, rejectUnauthorized: false }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

const index = await get('/');
console.log('index status:', index.status);
const html = index.body.toString('utf8');
console.log('标题存在:', html.includes('仓库扫码分卡板'));
const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
console.log('引用资源:', assets.join(' '));

let ok = index.status === 200 && html.includes('仓库扫码分卡板');
for (const asset of assets) {
  const res = await get(asset.startsWith('/') ? asset : `/${asset}`);
  const isJs = asset.endsWith('.js');
  const body = res.body.toString('utf8');
  const looksRight = isJs ? !body.trimStart().startsWith('<!') : body.includes('{');
  console.log(`${asset} -> ${res.status} ${res.body.length} bytes${looksRight ? '' : '  <-- 内容异常'}`);
  if (res.status !== 200 || !looksRight) ok = false;
}

// 资源里不应出现任何外部 CDN
const external = [...html.matchAll(/https?:\/\/[^"')\s]+/g)].map((m) => m[0]);
console.log('页面里的外链:', external.length ? external.join(' ') : '（无）');

console.log(ok ? '\n冒烟测试通过 ✅（HTTPS 可直接访问）' : '\n冒烟测试失败 ❌');
process.exit(ok ? 0 : 1);
