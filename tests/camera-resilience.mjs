/**
 * 摄像头容错验证（真实 Chromium + 假摄像头）：
 *  1) 保存的摄像头 id 已失效（换手机/系统更新后的典型情况）-> 必须自动改用默认摄像头，不能卡死
 *  2) 正常情况 -> 能打开摄像头并显示分辨率
 *  3) 设置页「测试摄像头」-> 给出明确结果
 *  4) 没有摄像头接口时 -> 提示手动输入，不白屏
 *
 *   node tests/camera-resilience.mjs [baseURL]
 */
import { chromium } from 'playwright';

const baseURL = process.argv[2] ?? 'http://localhost:4173';

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

/** 打开页面并进入「已添加一个箱子、可以扫条码」的状态 */
async function openReadyPage(context, { injectSettings } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  // 记录页面里真实的摄像头调用，方便定位问题
  await page.addInitScript(() => {
    window.__cameraCalls = [];
    if (navigator.mediaDevices?.getUserMedia) {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const record = { constraints: JSON.parse(JSON.stringify(constraints ?? {})), result: '', deviceId: '' };
        window.__cameraCalls.push(record);
        try {
          const stream = await original(constraints);
          record.result = 'ok';
          record.deviceId = stream.getVideoTracks()[0]?.getSettings?.().deviceId ?? '';
          return stream;
        } catch (error) {
          record.result = `${error?.name}: ${error?.message}`;
          throw error;
        }
      };
    }
  });
  await page.goto(baseURL, { waitUntil: 'load' });
  if (injectSettings) {
    await page.evaluate((settings) => {
      return new Promise((resolve) => {
        const req = indexedDB.open('pallet-scan');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ key: 'settings', value: settings });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      });
    }, injectSettings);
    await page.reload({ waitUntil: 'load' });
  }
  await page.waitForSelector('.app', { timeout: 15000 });
  // 建任务 + 加箱子
  await page.click('button:has-text("新建任务")');
  await page.waitForSelector('.modal input.input');
  await page.fill('.modal input.input', '摄像头容错自检');
  await page.click('.modal button:has-text("创建任务")');
  await page.waitForSelector('.pallet-code');
  await page.click('button:has-text("添加箱子")');
  await page.waitForSelector('.modal input.input');
  await page.fill('.modal input.input', 'M-100');
  await page.click('.modal button:has-text("确认并开始扫条码")');
  await page.waitForTimeout(400);
  return { page, errors };
}

async function readPanel(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.scanner-panel');
    const video = panel?.querySelector('video');
    return {
      active: panel?.dataset.active,
      scanning: panel?.dataset.scanning,
      cameraActive: panel?.dataset.camera,
      error: panel?.dataset.cameraError ?? '',
      placeholderText: (panel?.querySelector('.scan-placeholder')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      hasStream: !!video?.srcObject,
      width: video?.videoWidth ?? 0,
      notice: (panel?.textContent ?? '').includes('已自动改用默认摄像头'),
    };
  });
}

const startCamera = (page) =>
  page.evaluate(() => {
    const panel = document.querySelector('.scanner-panel');
    const btn = [...(panel?.querySelectorAll('button') ?? [])].find((b) =>
      (b.textContent ?? '').includes('开始扫描'),
    );
    btn?.click();
    return !!btn;
  });

try {
  /* ---------- 1. 正常情况 ---------- */
  console.log('\n[1] 正常情况：能打开摄像头');
  {
    const context = await browser.newContext({ permissions: ['camera'], ignoreHTTPSErrors: true });
    const { page, errors } = await openReadyPage(context);
    await startCamera(page);
    await page.waitForTimeout(2500);
    const panel = await readPanel(page);
    check('摄像头已打开', panel.cameraActive === '1' && panel.hasStream, panel);
    check('分辨率有效', panel.width > 0, panel);
    check('没有报错', !panel.error, panel.error);
    check('没有页面级错误', errors.length === 0, errors);
    await context.close();
  }

  /* ---------- 2. 保存了一个失效的摄像头 id ---------- */
  console.log('\n[2] 失效的摄像头 id：必须自动降级，不能卡住');
  {
    const context = await browser.newContext({ permissions: ['camera'], ignoreHTTPSErrors: true });
    const { page, errors } = await openReadyPage(context, {
      injectSettings: {
        maxBoxesPerPallet: 55, // 顺便验证设置真的被注入（页面上会显示 /55 箱）
        boxesPerLayer: 5,
        palletCodePrefix: 'P',
        boxCodePrefix: 'B',
        duplicateCooldownMs: 1500,
        soundEnabled: false,
        vibrateEnabled: false,
        keepAwake: false,
        preferredCameraId: 'this-device-does-not-exist-123456',
        autoPlayScan: false,
      },
    });
    const limitText = await page.textContent('.count-limit');
    check('注入的设置已生效（上限 55）', (limitText ?? '').includes('55'), limitText);
    await startCamera(page);
    await page.waitForTimeout(3000);
    const panel = await readPanel(page);
    check('仍然成功打开摄像头（不退化成报错）', panel.cameraActive === '1' && panel.hasStream, panel);
    check('分辨率有效', panel.width > 0, panel);
    check('没有把 NotFoundError 抛给用户', !panel.error, panel.error);
    if (panel.notice) {
      passed += 1;
      console.log('  ✓ 页面提示已自动改用默认摄像头');
    } else {
      // 这个浏览器可能直接把设备补齐给了我们（Chromium 假摄像头就是这种），
      // 那就确认一下「确实打开的是可用摄像头」，同样算通过。
      const calls = await page.evaluate(() => window.__cameraCalls ?? []);
      const opened = calls.filter((c) => c.result === 'ok');
      check('至少成功打开了一次摄像头', opened.length > 0, calls);
      console.log('  · 该浏览器未发生设备替换，无需降级提示');
    }
    check('没有页面级错误', errors.length === 0, errors);

    // 降级后仍然能正常扫条码
    await page.fill('.card form.manual-form input', 'SN-DEGRADED-1');
    await page.click('.card form.manual-form button');
    await page.waitForTimeout(300);
    const rows = await page.locator('.code-row').count();
    check('降级后仍能记录条码', rows >= 1, rows);
    await context.close();
  }

  /* ---------- 3. 设置页的「测试摄像头」 ---------- */
  console.log('\n[3] 设置页摄像头自检');
  {
    const context = await browser.newContext({ permissions: ['camera'], ignoreHTTPSErrors: true });
    const { page } = await openReadyPage(context, {
      injectSettings: {
        maxBoxesPerPallet: 60,
        boxesPerLayer: 5,
        palletCodePrefix: 'P',
        boxCodePrefix: 'B',
        duplicateCooldownMs: 1500,
        soundEnabled: false,
        vibrateEnabled: false,
        keepAwake: false,
        preferredCameraId: 'stale-id-999',
        autoPlayScan: false,
      },
    });
    await page.click('.tab:has-text("设置")');
    await page.waitForSelector('text=摄像头');
    await page.click('button:has-text("测试摄像头")');
    await page.waitForTimeout(2500);
    const result = await page.textContent('.card:has-text("摄像头") .alert');
    check('测试结果提示成功', (result ?? '').includes('✅ 摄像头可用'), result);
    check('测试结果说明了自动降级', (result ?? '').includes('已自动改用默认摄像头'), result);
    await context.close();
  }

  /* ---------- 4. 没有摄像头接口（旧浏览器/非安全上下文） ---------- */
  console.log('\n[4] 没有摄像头接口时：提示手动输入');
  {
    const context = await browser.newContext({ permissions: ['camera'], ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    });
    await page.goto(baseURL, { waitUntil: 'load' });
    await page.waitForSelector('.app', { timeout: 15000 });
    await page.click('button:has-text("新建任务")');
    await page.waitForSelector('.modal input.input');
    await page.fill('.modal input.input', '无摄像头自检');
    await page.click('.modal button:has-text("创建任务")');
    await page.waitForSelector('.pallet-code');
    await page.click('button:has-text("添加箱子")');
    await page.waitForSelector('.modal input.input');
    await page.fill('.modal input.input', 'M-500');
    await page.click('.modal button:has-text("确认并开始扫条码")');
    await page.waitForTimeout(400);
    await startCamera(page);
    await page.waitForTimeout(1200);
    const panel = await readPanel(page);
    check('给出明确的中文提示', /不支持摄像头|权限|安全上下文/.test(panel.error + panel.placeholderText), {
      error: panel.error,
      text: panel.placeholderText,
    });
    check('界面没有白屏', (await page.locator('.app').count()) === 1);
    // 手动输入依然可用
    await page.fill('.card form.manual-form input', 'SN-NO-CAMERA');
    await page.click('.card form.manual-form button');
    await page.waitForTimeout(300);
    check('无摄像头时仍可手动录条码', (await page.locator('.code-row').count()) >= 1);
    await context.close();
  }
  /* ---------- 5. 小屏手机上的布局与「查看条码」 ---------- */
  console.log('\n[5] iPhone SE 小屏：取景框形状 + 条码列表能不能滑');
  {
    const context = await browser.newContext({
      permissions: ['camera'],
      ignoreHTTPSErrors: true,
      viewport: { width: 320, height: 568 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const { page } = await openReadyPage(context);
    // 扫 20 条，模拟一箱
    for (let i = 1; i <= 20; i += 1) {
      await page.fill('.card form.manual-form input', `SN-${String(i).padStart(6, '0')}`);
      await page.click('.card form.manual-form button');
    }
    await page.waitForTimeout(500);

    // 取景框形状
    const stage = await page.evaluate(() => {
      const el = document.querySelector('.scan-stage');
      const rect = el?.getBoundingClientRect();
      const frame = document.querySelector('.scan-frame')?.getBoundingClientRect();
      return rect
        ? {
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            ratio: +(rect.width / rect.height).toFixed(2),
            frameW: frame ? Math.round(frame.width) : 0,
            frameH: frame ? Math.round(frame.height) : 0,
            frameRatio: frame ? +(frame.width / frame.height).toFixed(2) : 0,
          }
        : null;
    });
    check('取景框是横向长方形（宽 > 高 1.4 倍以上）', stage && stage.ratio >= 1.4, stage);
    check('取景框高度不超过 240px', stage && stage.h < 240, stage);
    // 320px 屏幕减去页面与卡片内边距后约 266px
    check('取景框占满可用宽度', stage && stage.w >= 255, stage);
    // 摄像头打开后取景框内还应有一个横向的长方形瞄准框
    await startCamera(page);
    await page.waitForTimeout(2500);
    const frame = await page.evaluate(() => {
      const rect = document.querySelector('.scan-frame')?.getBoundingClientRect();
      return rect ? { w: Math.round(rect.width), h: Math.round(rect.height), ratio: +(rect.width / rect.height).toFixed(2) } : null;
    });
    check('瞄准框也是横向长方形', frame && frame.ratio >= 1.6 && frame.h <= 130, frame);

    // 展开箱子，检查条码列表能滚动
    await page.click('.box-head');
    await page.waitForTimeout(400);
    const listInfo = await page.evaluate(() => {
      const box = document.querySelector('.box-body');
      const scroll = document.querySelector('.code-scroll');
      if (!scroll) return { hasScroll: false, boxHeight: box?.getBoundingClientRect().height ?? 0 };
      return {
        hasScroll: true,
        clientH: scroll.clientHeight,
        scrollH: scroll.scrollHeight,
        canScroll: scroll.scrollHeight > scroll.clientHeight + 4,
        overflowY: getComputedStyle(scroll).overflowY,
        rows: scroll.querySelectorAll('.code-row').length,
      };
    });
    check('展开后有可滚动的条码区', listInfo.hasScroll && listInfo.overflowY === 'auto', listInfo);
    check('20 条条码全部渲染', listInfo.rows === 20, listInfo);
    check('内容确实超出（可滑动查看）', listInfo.canScroll, listInfo);

    // 真实滑动一下，确认能看到最后一条（跟滚动容器比，不是跟整个视口比）
    await page.evaluate(() => {
      const scroll = document.querySelector('.code-scroll');
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
    });
    await page.waitForTimeout(300);
    const scrolled = await page.evaluate(() => {
      const scroll = document.querySelector('.code-scroll');
      const last = scroll?.querySelector('.code-row:last-child');
      const rect = last?.getBoundingClientRect();
      const box = scroll?.getBoundingClientRect();
      return {
        scrollTop: scroll?.scrollTop ?? 0,
        lastCode: last?.querySelector('.code-value')?.textContent ?? '',
        lastVisibleInList: rect && box ? rect.top >= box.top - 2 && rect.bottom <= box.bottom + 2 : false,
      };
    });
    check('滑到底能看到最后一条条码', scrolled.scrollTop > 0 && scrolled.lastVisibleInList, scrolled);
    check('最后一条就是第 20 条', scrolled.lastCode === 'SN-000020', scrolled.lastCode);

    // 「查看条码」全屏视图
    await page.click('button:has-text("查看条码")');
    await page.waitForTimeout(400);
    const fullView = await page.evaluate(() => {
      const modal = document.querySelector('.modal');
      const scroll = modal?.querySelector('.code-scroll.full');
      return {
        title: modal?.querySelector('h3')?.textContent ?? '',
        rows: scroll?.querySelectorAll('.code-row').length ?? 0,
        canScroll: scroll ? scroll.scrollHeight > scroll.clientHeight + 4 : false,
        overflowY: scroll ? getComputedStyle(scroll).overflowY : '',
      };
    });
    check('全屏视图标题带箱号与条数', /B001 条码明细（20 条）/.test(fullView.title), fullView.title);
    check('全屏视图列出全部 20 条', fullView.rows === 20, fullView);
    check('全屏视图可滚动', fullView.canScroll && fullView.overflowY === 'auto', fullView);

    // 页面本身也要能滚动
    const pageScroll = await page.evaluate(() => ({
      pageScrollable: document.documentElement.scrollHeight > window.innerHeight,
      bodyOverflow: getComputedStyle(document.body).overflowY,
    }));
    check('页面内容可滚动', pageScroll.pageScrollable, pageScroll);
    await context.close();
  }
} catch (error) {
  failures.push(`摄像头容错自检异常：${error?.message ?? error}`);
  console.error(error);
} finally {
  await browser.close();
}

console.log(`\n通过 ${passed} 项摄像头容错检查`);
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('摄像头容错验证通过 ✅');
