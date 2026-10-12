/**
 * 线上部署验证：直接对 Cloudflare Pages 的线上地址跑一遍真实流程。
 *
 *   node tests/verify-deployed.mjs https://pallet-scan.pages.dev
 */
import { chromium, devices } from 'playwright';

const baseURL = (process.argv[2] ?? 'https://pallet-scan.pages.dev').replace(/\/$/, '');

let passed = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${extra === undefined ? '' : ` -> ${JSON.stringify(extra)}`}`);
    console.log(`  ✗ ${name}${extra === undefined ? '' : ` -> ${JSON.stringify(extra)}`}`);
  }
}

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

try {
  const context = await browser.newContext({
    ...devices['Pixel 5'],
    permissions: ['camera'],
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const externalRequests = [];
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('request', (req) => {
    const url = req.url();
    if (!url.startsWith(baseURL) && !url.startsWith('data:') && !url.startsWith('blob:')) {
      externalRequests.push(url);
    }
  });

  console.log(`\n[1] 打开线上地址 ${baseURL}`);
  const response = await page.goto(baseURL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('.app', { timeout: 20000 });
  check('HTTP 200', response?.status() === 200, response?.status());
  check('安全上下文（摄像头可用）', await page.evaluate(() => window.isSecureContext));
  check('标题正确', (await page.title()).includes('仓库扫码分卡板'), await page.title());
  check('没有「程序启动失败」页面', (await page.locator('text=程序启动失败').count()) === 0);

  console.log('\n[2] 完整作业流程：加箱子（扫型号）→ 扫条码 → 封箱 → 封板');
  await page.click('button:has-text("新建任务")');
  await page.waitForSelector('.modal input.input');
  await page.fill('.modal input.input', '线上验证任务');
  await page.click('.modal button:has-text("创建任务")');
  await page.waitForSelector('.pallet-code');
  check('卡板号 P001', (await page.textContent('.pallet-code'))?.trim() === 'P001');

  // 加箱子：弹窗里用摄像头扫型号
  await page.click('button:has-text("添加箱子")');
  await page.waitForSelector('.modal input.input');
  await page.evaluate(() => {
    const modal = document.querySelector('.modal');
    const btn = [...(modal?.querySelectorAll('button') ?? [])].find((b) =>
      (b.textContent ?? '').includes('开始扫描'),
    );
    btn?.click();
  });
  await page.waitForTimeout(2500);
  const modalCam = await page.evaluate(() => {
    const v = document.querySelector('.modal video.scan-video');
    return { hasStream: !!v?.srcObject, width: v?.videoWidth ?? 0 };
  });
  check('线上弹窗内摄像头可用', modalCam.hasStream && modalCam.width > 0, modalCam);
  await page.evaluate(() => {
    const modal = document.querySelector('.modal');
    const btn = [...(modal?.querySelectorAll('button') ?? [])].find((b) =>
      (b.textContent ?? '').includes('暂停扫描'),
    );
    btn?.click();
  });
  await page.evaluate(() => window.__palletScanHandleCode?.('M-100'));
  await page.waitForTimeout(400);
  check('扫码得到的型号自动填入', (await page.inputValue('.modal input.input')) === 'M-100');
  await page.click('.modal button:has-text("确认并开始扫条码")');
  await page.waitForTimeout(400);
  check('进入扫码状态', (await page.textContent('.box-title'))?.includes('B001'), await page.textContent('.box-title'));

  // 手动录 3 条（含一条重复）
  const manual = page.locator('.card form.manual-form input');
  const submit = page.locator('.card form.manual-form button');
  for (const code of ['ONLINE-0001', 'ONLINE-0002', 'ONLINE-0001']) {
    await manual.fill(code);
    await submit.click();
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(400);
  const boxOneBarcodes = await page.evaluate(() => {
    const el = document.querySelector('.card .count-num.small-num');
    return Number((el?.textContent ?? '').replace(/\D/g, ''));
  });
  check('重复条码不计数（2 条）', boxOneBarcodes === 2, boxOneBarcodes);
  check('提示条码重复', (await page.textContent('body'))?.includes('条码重复'));

  // 封箱
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').startsWith('封箱 B001') && !b.disabled,
    );
    btn?.click();
  });
  await page.waitForSelector('.modal button:has-text("确认封箱")');
  await page.click('.modal button:has-text("确认封箱")');
  await page.waitForTimeout(500);
  check('已封箱提示', (await page.textContent('body'))?.includes('B001 已封箱'));

  // 封板（下载单板 Excel）
  const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').startsWith('封板 P001') && !b.disabled,
    );
    btn?.click();
  });
  await page.waitForSelector('.modal button:has-text("确认封板")');
  await page.click('.modal button:has-text("确认封板")');
  const download = await downloadPromise;
  check('封板后自动下载单板 Excel', !!download && download.suggestedFilename().includes('单板明细'), download?.suggestedFilename());
  await page.waitForTimeout(600);
  check('自动创建 P002', (await page.textContent('.pallet-code'))?.trim() === 'P002', await page.textContent('.pallet-code'));

  console.log('\n[3] 数据持久化（刷新后不丢）');
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.pallet-code', { timeout: 20000 });
  check('刷新后任务保留', (await page.textContent('.app-sub'))?.includes('线上验证任务'));
  check('刷新后卡板保留', (await page.textContent('.app-sub'))?.includes('2 板'), await page.textContent('.app-sub'));
  // 切回已封板的 P001 查看箱子
  await page.click('button:has-text("卡板列表")');
  await page.waitForTimeout(300);
  await page.click('.pallet-row:has-text("P001")');
  await page.waitForTimeout(500);
  check('刷新后箱号与条码数保留', (await page.textContent('.box-head'))?.includes('2 条'), await page.textContent('.box-head'));
  check('刷新后型号保留', (await page.textContent('.box-head'))?.includes('M-100'), await page.textContent('.box-head'));

  console.log('\n[4] 布局与查看条码（Pixel 5 视口）');
  const stage = await page.evaluate(() => {
    const rect = document.querySelector('.scan-stage')?.getBoundingClientRect();
    return rect ? { w: Math.round(rect.width), h: Math.round(rect.height), ratio: +(rect.width / rect.height).toFixed(2) } : null;
  });
  check('取景框是横向长方形', stage && stage.ratio >= 1.4, stage);
  await page.click('button:has-text("查看条码")');
  await page.waitForTimeout(400);
  const fullView = await page.evaluate(() => {
    const modal = document.querySelector('.modal');
    const scroll = modal?.querySelector('.code-scroll.full');
    return {
      title: modal?.querySelector('h3')?.textContent ?? '',
      rows: scroll?.querySelectorAll('.code-row').length ?? 0,
      scrollable: scroll ? getComputedStyle(scroll).overflowY : '',
    };
  });
  check('「查看条码」能列出条码', fullView.rows === 2 && fullView.scrollable === 'auto', fullView);
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => {
    const modal = document.querySelector('.modal');
    const close = [...(modal?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('✕'));
    close?.click();
  });
  await page.waitForTimeout(300);
  check('查看条码弹窗已关闭', (await page.locator('.modal-mask').count()) === 0);

  console.log('\n[5] 离线与安全');
  check('没有外部网络请求（纯本地）', externalRequests.length === 0, externalRequests.slice(0, 5));
  check('没有控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3));
  const thirdParty = await page.evaluate(() =>
    [...document.querySelectorAll('script[src], link[href]')]
      .map((el) => el.getAttribute('src') ?? el.getAttribute('href') ?? '')
      .filter((u) => u.startsWith('http')),
  );
  check('没有第三方 CDN 依赖', thirdParty.length === 0, thirdParty);

  await context.close();
} catch (error) {
  failures.push(`线上验证异常：${error?.message ?? error}`);
  console.error(error);
} finally {
  await browser.close();
}

console.log(`\n通过 ${passed} 项线上检查`);
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`线上部署验证通过 ✅  ${baseURL}`);
