/**
 * 多设备复现脚本：在 Android Chrome（移动仿真）、iOS Safari（WebKit）、
 * 以及各代桌面浏览器内核下打开页面，记录控制台错误与最终 DOM，定位「一片蓝色/白屏」。
 *
 *   node tests/device-check.mjs [baseURL]
 */
import { chromium, webkit, devices } from 'playwright';

const baseURL = process.argv[2] ?? 'http://localhost:4173';

const targets = [
  { name: 'Android Chrome（Pixel 5 仿真）', browser: 'chromium', device: 'Pixel 5' },
  { name: 'Android Chrome（Galaxy S9 仿真）', browser: 'chromium', device: 'Galaxy S9+' },
  { name: 'iOS Safari（iPhone 13 仿真）', browser: 'webkit', device: 'iPhone 13' },
  { name: 'iOS Safari（iPhone SE 仿真）', browser: 'webkit', device: 'iPhone SE' },
  { name: 'iPad Safari（iPad Pro 11 仿真）', browser: 'webkit', device: 'iPad Pro 11' },
  { name: '桌面 Chrome', browser: 'chromium', device: null },
];

let problems = 0;

for (const target of targets) {
  const browserType = target.browser === 'webkit' ? webkit : chromium;
  const browser = await browserType.launch();
  const deviceConfig = target.device ? devices[target.device] : { viewport: { width: 1280, height: 800 } };
  const context = await browser.newContext({
    ...deviceConfig,
    ignoreHTTPSErrors: true,
    permissions: ['camera'],
  });
  const page = await context.newPage();
  const errors = [];
  const logs = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => errors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`));

  let outcome = '';
  try {
    await page.goto(baseURL, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(2500);
    const info = await page.evaluate(() => ({
      rootChildren: document.getElementById('root')?.children.length ?? -1,
      html: (document.body.innerText || '').slice(0, 120).replace(/\s+/g, ' '),
      bg: getComputedStyle(document.body).backgroundColor,
      hasApp: !!document.querySelector('.app'),
      hasLoading: !!document.querySelector('.app-loading'),
      ua: navigator.userAgent.slice(0, 80),
      secure: window.isSecureContext,
      hasIndexedDB: typeof indexedDB !== 'undefined',
      hasCryptoUUID: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function',
    }));
    const ok = info.hasApp || info.hasLoading;
    outcome = `${ok ? '✅ 渲染正常' : '❌ 页面空白'} | app=${info.hasApp} loading=${info.hasLoading} root子节点=${info.rootChildren} 背景=${info.bg}`;
    outcome += `\n      内容前 120 字：${info.html}`;
    outcome += `\n      安全上下文=${info.secure} IndexedDB=${info.hasIndexedDB} crypto.randomUUID=${info.hasCryptoUUID}`;
    if (!ok) problems += 1;
  } catch (error) {
    outcome = `❌ 打开失败：${error.message}`;
    problems += 1;
  }
  console.log(`\n【${target.name}】\n      ${outcome}`);
  if (errors.length) console.log(`      页面错误：\n        - ${errors.slice(0, 5).join('\n        - ')}`);
  if (logs.length) console.log(`      控制台：\n        - ${logs.slice(0, 5).join('\n        - ')}`);
  await context.close();
  await browser.close();
}

console.log(problems === 0 ? '\n所有设备渲染正常 ✅' : `\n有 ${problems} 个设备渲染异常 ❌`);
process.exit(problems === 0 ? 0 : 1);
