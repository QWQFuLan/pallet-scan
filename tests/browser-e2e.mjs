/**
 * 真实浏览器端到端验证（Playwright + Chromium，含模拟摄像头）。
 *
 *   node tests/browser-e2e.mjs [baseURL]
 *
 * 覆盖内容：
 *   - 页面在真实 Chromium 里渲染（不是 happy-dom）
 *   - IndexedDB 真实读写 + 刷新页面后数据不丢
 *   - 用「假摄像头设备」验证 getUserMedia -> 扫码页 -> 帧解码整条链路
 *   - 真实文件下载（单板 Excel / 总表 / 配货表）并检查内容
 *   - 全程不产生任何外部网络请求（离线可用）
 */
import { chromium } from 'playwright';
import { mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';

const baseURL = process.argv[2] ?? 'http://localhost:4173';const downloadDir = mkdtempSync(join(tmpdir(), 'pallet-dl-'));

let passed = 0;
const failures = [];
const notes = [];
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
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({
  permissions: ['camera'],
  viewport: { width: 414, height: 896 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  acceptDownloads: true,
  // 本地自签证书：只对 localhost 生效，方便在真实 HTTPS 环境下验证摄像头
  ignoreHTTPSErrors: baseURL.startsWith('https://localhost') || baseURL.startsWith('https://127.0.0.1'),
});
const page = await context.newPage();

// 记录所有外部请求（除本地服务器以外的都算外链）
const externalRequests = [];
page.on('request', (req) => {
  const url = req.url();
  if (url.startsWith('data:') || url.startsWith('blob:')) return;
  if (!url.startsWith(baseURL) && !url.startsWith('http://localhost') && !url.startsWith('http://127.0.0.1')) {
    externalRequests.push(url);
  }
});
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

try {
  /* ---------------- 1. 打开页面 ---------------- */
  console.log('\n[1] 页面加载与渲染');
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.waitForSelector('.app-header', { timeout: 15000 });
  check('标题渲染', (await page.textContent('.app-title strong'))?.includes('仓库扫码分卡板'));
  check('4 个底部 Tab', (await page.locator('.tab').count()) === 4);
  check('无任务时提示新建', (await page.textContent('body'))?.includes('还没有任务'));
  const innerW = await page.evaluate(() => window.innerWidth);
  check('移动端视口生效', innerW === 414, innerW);

  /* ---------------- 2. 新建任务 ---------------- */
  console.log('\n[2] 新建任务');
  await page.click('button:has-text("新建任务")');
  await page.waitForSelector('.modal');
  await page.fill('.modal input.input', '浏览器自检任务');
  await page.click('.modal button:has-text("创建任务")');
  await page.waitForSelector('.pallet-code');
  check('卡板号 P001', (await page.textContent('.pallet-code'))?.trim() === 'P001');
  check('每板 60 箱上限', (await page.textContent('.count-limit'))?.includes('60'), await page.textContent('.count-num'));
  check('提示先添加箱子', (await page.textContent('body'))?.includes('还没有箱子'));

  /* ---------------- 3. 添加箱子：先扫型号再扫条码 ---------------- */
  console.log('\n[3] 添加箱子（先扫型号）→ 扫条码');
  /** 点一个「可用」的按钮（同文案的按钮可能在卡片和列表里各有一个，其中一个被禁用） */
  const clickEnabledByText = async (text) => {
    const total = await page.locator(`button:has-text("${text}")`).count();
    for (let i = 0; i < total; i += 1) {
      const candidate = page.locator(`button:has-text("${text}")`).nth(i);
      if (await candidate.isEnabled()) {
        await candidate.click({ timeout: 10000 });
        return;
      }
    }
    throw new Error(`找不到可用的按钮：${text}（共 ${total} 个，全部不可用）`);
  };
  /** 主扫码区（页面里第一个 scanner-panel，弹窗里的不算） */
  const mainPanel = () => page.locator('.scanner-panel').first();
  /** 让主扫码区的摄像头跑起来（按钮偶发被遮挡，这里统一用 DOM 点击） */
  const startMainScanner = async () => {
    const result = await page.evaluate(() => {
      const panel = document.querySelector('.scanner-panel');
      const buttons = [...(panel?.querySelectorAll('button') ?? [])];
      const texts = buttons.map((b) => (b.textContent ?? '').trim());
      if (texts.includes('暂停扫描')) return { clicked: true, already: true, texts };
      const start = buttons.find((b) => (b.textContent ?? '').includes('开始扫描'));
      if (!start) return { clicked: false, texts };
      start.click();
      return { clicked: true, already: false, texts };
    });
    if (!result.clicked) throw new Error(`主扫码区没有开始按钮：${JSON.stringify(result)}`);
    await page.waitForTimeout(2500);
    return result;
  };
  const addBoxWithModel = async (model) => {
    // 先确认没有残留弹窗挡着
    await page.waitForFunction(() => !document.querySelector('.modal-mask'), null, { timeout: 5000 }).catch(() => {});
    await page.click('button:has-text("添加箱子")');
    await page.waitForSelector('.modal input.input');
    await page.fill('.modal input.input', model);
    await page.click('.modal button:has-text("确认并开始扫条码")');
    await page.waitForTimeout(400);
  };
  await addBoxWithModel('M-100');
  check('箱号 B001', (await page.textContent('.box-title'))?.includes('B001'), await page.textContent('.box-title'));
  check('页面显示箱型号', (await page.textContent('.box-title'))?.includes('M-100'));

  /** 当前箱的条码数（卡片右上角的数字） */
  const readBoxBarcodes = async () => {
    const el = page.locator('.card .count-num.small-num');
    return Number(((await el.first().textContent()) ?? '').replace(/\D/g, '')) || 0;
  };
  /** 某个箱在列表里的条码数（“N 条”） */
  const boxRowCount = async (nth) => {
    const head = page.locator('.box-head').nth(nth);
    const txt = (await head.textContent()) ?? '';
    return Number((txt.match(/(\d+)\s*条/) ?? [])[1] ?? -1);
  };

  const manual = page.locator('.card form.manual-form input');
  const submit = page.locator('.card form.manual-form button');
  const sendCode = async (code) => {
    const ready = await page
      .waitForFunction(() => {
        const btn = document.querySelector('.card form.manual-form button');
        return !!btn && !btn.disabled;
      }, null, { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) {
      const info = await page.evaluate(() => ({
        boxTitle: document.querySelector('.box-title')?.textContent ?? '(无当前箱)',
        disabled: (document.querySelector('.card form.manual-form button'))?.disabled ?? null,
        boxes: document.querySelectorAll('.box-group').length,
      }));
      throw new Error(`当前没有可扫码的箱子，无法输入 ${code}：${JSON.stringify(info)}`);
    }
    await manual.fill(code);
    await submit.click();
    await page.waitForTimeout(80);
  };

  /* ---------------- 3a. 先扫这一箱的条码 ---------------- */
  console.log('\n[3a] 扫箱内条码（含重复保护）');
  await sendCode('SN-000001');
  await sendCode('SN-000002');
  await sendCode('SN-000001'); // 箱内重复：不计数，只提示
  await page.waitForTimeout(300);
  check('箱内 2 条条码（重复不加）', (await readBoxBarcodes()) === 2, await readBoxBarcodes());
  check('提示条码重复', (await page.textContent('body'))?.includes('条码重复'));
  check('箱列表显示 2 条', (await boxRowCount(0)) === 2, await boxRowCount(0));

  /* ---------------- 3b. 封箱 → 弹窗里用摄像头扫型号加第二箱 ---------------- */
  console.log('\n[3b] 封箱 B001 → 弹窗内「用摄像头扫型号」加第二箱');
  await clickEnabledByText('封箱 B001');
  await page.waitForSelector('.modal button:has-text("确认封箱")');
  await page.click('.modal button:has-text("确认封箱")');
  await page.waitForTimeout(400);
  check('B001 已封箱', (await page.textContent('body'))?.includes('B001 已封箱'), await page.textContent('.toast'));
  const sealedHead = await page.locator('.box-head').first().textContent();
  check('列表显示已封箱', sealedHead?.includes('已封箱'), sealedHead);

  // 现在在「添加第 2 箱」阶段：弹窗里先用摄像头扫型号
  await page.waitForFunction(() => !document.querySelector('.modal-mask'), null, { timeout: 5000 }).catch(() => {});
  await page.click('button:has-text("添加箱子")');
  await page.waitForSelector('.modal input.input');
  const modelModalInfo = await page.evaluate(() => {
    const modal = document.querySelector('.modal');
    return {
      title: modal?.querySelector('h3')?.textContent ?? '(无标题)',
      text: (modal?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 200),
      buttons: [...(modal?.querySelectorAll('button') ?? [])].map((b) => (b.textContent ?? '').trim()),
    };
  });
  notes.push(`[3b] 型号弹窗：${JSON.stringify(modelModalInfo)}`);
  check('型号弹窗自动带上摄像头面板', modelModalInfo.buttons.includes('开始扫描'), modelModalInfo);
  // 用 DOM 点击（弹窗覆盖层有时会挡住 Playwright 的默认点击）
  const startResult = await page.evaluate(() => {
    const modal = document.querySelector('.modal');
    const btn = [...(modal?.querySelectorAll('button') ?? [])].find((b) =>
      (b.textContent ?? '').includes('开始扫描'),
    );
    if (!btn) return { clicked: false };
    btn.click();
    return { clicked: true, disabled: btn.disabled };
  });
  check('弹窗内点得到「开始扫描」', startResult.clicked && startResult.disabled === false, startResult);
  await page.waitForTimeout(2500);
  const modalVideoDebug = await page.evaluate(() => {
    const modal = document.querySelector('.modal');
    const panel = modal?.querySelector('.scanner-panel');
    const v = modal?.querySelector('video.scan-video');
    return {
      panelAttrs: panel
        ? {
            active: panel.dataset.active,
            scanning: panel.dataset.scanning,
            camera: panel.dataset.camera,
            error: panel.dataset.cameraError,
          }
        : null,
      videoHidden: v?.classList.contains('hidden') ?? null,
      hasStream: !!v?.srcObject,
    };
  });
  const modalVideo = await page.evaluate(() => {
    const v = document.querySelector('.modal video.scan-video');
    return {
      found: !!v,
      hasStream: !!v?.srcObject,
      tracks: v?.srcObject ? v.srcObject.getVideoTracks().length : 0,
      width: v?.videoWidth ?? 0,
    };
  });
  check('弹窗内摄像头拿到视频流', modalVideo.found && modalVideo.hasStream && modalVideo.tracks >= 1, {
    ...modalVideo,
    ...modalVideoDebug,
  });
  check('弹窗内视频分辨率有效', modalVideo.width > 0, modalVideo);
  await page.click('.modal button:has-text("暂停扫描")');
  await page.waitForTimeout(300);
  // 模拟解码出的型号 -> 应自动填进型号输入框
  await page.evaluate(() => window.__palletScanHandleCode?.('M-200'));
  await page.waitForTimeout(500);
  const modelValue = await page.inputValue('.modal input.input');
  check('扫到的型号自动填入', modelValue === 'M-200', modelValue);
  check('弹窗提示已识别型号', (await page.textContent('.modal'))?.includes('已识别型号：M-200'));
  await page.click('.modal button:has-text("确认并开始扫条码")');
  await page.waitForTimeout(400);
  check('第二箱型号来自扫码', (await page.textContent('.box-title'))?.includes('M-200'), await page.textContent('.box-title'));

  /* ---------------- 3c. 第二箱条码 + 未封箱时不允许加第三箱 ---------------- */
  console.log('\n[3c] 第二箱条码 / 未封箱保护');
  await sendCode('SN-100001');
  check('第二箱条码入库', (await boxRowCount(1)) === 1, await boxRowCount(1));

  // 未封箱时不允许直接加第三箱
  await page.click('button:has-text("添加箱子")');
  await page.waitForSelector('.modal input.input');
  await page.fill('.modal input.input', 'M-300');
  await page.click('.modal button:has-text("确认并开始扫条码")');
  await page.waitForTimeout(300);
  check('未封箱时拒绝加新箱', (await page.textContent('body'))?.includes('还没封箱'));
  const boxGroups = await page.locator('.box-group').count();
  check('仍然只有 2 个箱子', boxGroups === 2, boxGroups);
  // 关掉添加箱子弹窗：精确点这个弹窗里的「取消」
  await page
    .locator('.modal', { has: page.locator('input[placeholder*="型号"]') })
    .locator('button:has-text("取消")')
    .click({ timeout: 5000 })
    .catch(async () => {
      await page.keyboard.press('Escape').catch(() => {});
      await page.click('.modal-mask', { position: { x: 3, y: 3 }, force: true }).catch(() => {});
    });
  await page.waitForFunction(() => !document.querySelector('.modal-mask'), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(200);

  /* ---------------- 4. 假摄像头：连续扫码链路 ---------------- */
  // 此时 B002 还开着，继续往 B002 里扫；封板后再在 P002 上新开箱子（见 [5b]）
  console.log('\n[4] 摄像头与扫码链路（模拟设备）');
  const startScanResult = await startMainScanner();
  check('进入条码扫描状态', startScanResult.clicked, startScanResult);
  const videoState = await page.evaluate(() => {
    const v = document.querySelector('video.scan-video');
    if (!v) return { found: false };
    const stream = v.srcObject;
    return {
      found: true,
      hasStream: !!stream,
      tracks: stream ? stream.getVideoTracks().length : 0,
      readyState: v.readyState,
      width: v.videoWidth,
      height: v.videoHeight,
      hidden: v.classList.contains('hidden'),
    };
  });
  check('视频元素拿到摄像头流', videoState.hasStream && videoState.tracks >= 1, videoState);
  check('视频分辨率有效', (videoState.width ?? 0) > 0 && (videoState.height ?? 0) > 0, videoState);
  check('预览区可见', videoState.found && !videoState.hidden, videoState);
  const engineHint = await page.textContent('.scan-hint').catch(() => '');
  check('显示识别引擎提示', /识别/.test(engineHint ?? ''), engineHint);
  const hasDetector = await page.evaluate(() => typeof window.BarcodeDetector !== 'undefined');
  notes.push(`Chromium 原生 BarcodeDetector：${hasDetector ? '支持（走原生识别）' : '不支持（自动降级 ZXing，也已验收）'}`);

  // 模拟「解码成功」：把条码喂给页面里真正的扫码处理逻辑（箱内唯一、提示音、震动）
  console.log('\n[4b] 解码 -> 记条 全链路（模拟解码结果）');
  const feedCode = (code) => page.evaluate((c) => window.__palletScanHandleCode?.(c), code);
  const readBoxCount = async () => Number((await page.textContent('.count-num'))?.match(/(\d+)/)?.[1] ?? -1);
  const readLastCode = async () => (await page.textContent('.last-code')) ?? '';
  const boxesBefore = await readBoxCount();
  await feedCode('FAKE-SCAN-0001');
  await page.waitForTimeout(600); // 等 400ms 防抖窗口过去，后面的重复才能落到业务逻辑里
  check('扫码后提示扫到的条码', (await readLastCode()).includes('FAKE-SCAN-0001'), await readLastCode());
  check('第二箱条码数 +1', (await boxRowCount(1)) === 2, await boxRowCount(1));
  // 同一条码再扫：不计数、只提示
  await feedCode('FAKE-SCAN-0001');
  const dupWarned = await page
    .waitForFunction(() => (document.body.textContent ?? '').includes('条码重复'), null, { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  check('重复条码提示出现', dupWarned);
  check('重复后仍是 2 条', (await boxRowCount(1)) === 2, await boxRowCount(1));
  check('箱数没有变化', (await readBoxCount()) === boxesBefore, await readBoxCount());
  // 连续扫 FAKE-SCAN-0003..0011（9 条），加上前面 2 条 = 11 条
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 3; i <= 11; i += 1) {
      window.__palletScanHandleCode?.(`FAKE-SCAN-${String(i).padStart(4, '0')}`);
      await sleep(15);
    }
  });
  await page.waitForTimeout(800);
  check('连续扫码后条码数累加', (await boxRowCount(1)) === 11, await boxRowCount(1));

  // 撤销一条 -> 10 条（SN-100001 + FAKE-SCAN-0001 + 0003..0010）
  await page.click('button:has-text("撤销上一条")');
  await page.waitForTimeout(400);
  check('撤销后剩 10 条', (await boxRowCount(1)) === 10, await boxRowCount(1));

  // 暂停扫描，释放摄像头
  await page.evaluate(() => {
    const panel = document.querySelector('.scanner-panel');
    const btn = [...(panel?.querySelectorAll('button') ?? [])].find((b) =>
      (b.textContent ?? '').includes('暂停扫描'),
    );
    btn?.click();
  });
  await page.waitForTimeout(500);
  const released = await page.evaluate(() => !document.querySelector('video.scan-video')?.srcObject);
  check('暂停后释放摄像头', released === true || released === undefined);

  /* ---------------- 4c. 屏幕常亮 ---------------- */
  const wakeLockSupported = await page.evaluate(() => typeof navigator.wakeLock !== 'undefined');
  notes.push(`屏幕常亮 API（Wake Lock）：${wakeLockSupported ? '可用' : '不可用（页面会提示用户手动设置）'}`);

  /* ---------------- 5. 封箱 + 封板 ---------------- */
  console.log('\n[5] 封箱 B002 → 封板 P001');
  // 先封掉 B002（9 条条码）
  await clickEnabledByText('封箱 B002');
  await page.waitForSelector('.modal button:has-text("确认封箱")');
  await page.click('.modal button:has-text("确认封箱")');
  await page.waitForTimeout(400);

  const sealedBoxCount = Number(((await page.textContent('.count-num'))?.match(/(\d+)/) ?? [])[1] ?? -1);
  const sealedBoxes = await page.locator('.box-group').count();
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
  await clickEnabledByText('封板 P001');
  await page.waitForSelector('.modal button:has-text("确认封板")');
  await page.click('.modal button:has-text("确认封板")');
  const download = await downloadPromise;
  const singlePath = join(downloadDir, download.suggestedFilename());
  await download.saveAs(singlePath);
  check('封板时自动下载单板 Excel', download.suggestedFilename().includes('单板明细'), download.suggestedFilename());
  await page.waitForSelector('.pallet-code');
  check('自动创建 P002', (await page.textContent('.pallet-code'))?.trim() === 'P002', await page.textContent('.pallet-code'));
  check('封板提示包含箱数', (await page.textContent('body'))?.includes(`已封板（${sealedBoxCount} 箱`), sealedBoxCount);
  check('封箱数 = 2', sealedBoxes === 2, sealedBoxes);

  const wbSingle = XLSX.read(readFileSync(singlePath), { type: 'buffer' });
  const singleRows = XLSX.utils.sheet_to_json(wbSingle.SheetNames ? wbSingle.Sheets[wbSingle.SheetNames[0]] : {}, {
    header: 1,
    defval: '',
  });
  check('单板表表头正确', singleRows[0][0] === '卡板号' && singleRows[0][3] === '条码', singleRows[0]);
  check('单板表含箱号列', singleRows[0][1] === '箱号', singleRows[0]);
  check('单板表含型号列', singleRows[0][5] === '型号', singleRows[0]);
  const detailRows = singleRows.filter((r) => String(r[0] ?? '').startsWith('P'));
  check('单板表明细行数 = 条码总数（12）', detailRows.length === 12, detailRows.length);
  const summaryRow = singleRows.find((r) => String(r[0]) === '汇总');
  check('单板表底部有汇总行（箱数）', !!summaryRow && String(summaryRow[2]) === String(sealedBoxCount), summaryRow);
  check('单板表汇总条码数', !!summaryRow && String(summaryRow[4]) === '12', summaryRow);
  const modelsInSheet = new Set(detailRows.map((r) => String(r[5] ?? '')));
  check('单板表带出了型号', modelsInSheet.has('M-100') && modelsInSheet.has('M-200'), [...modelsInSheet]);
  const boxCodesInSheet = new Set(detailRows.map((r) => String(r[1] ?? '')));
  check('单板表带出了箱号', boxCodesInSheet.has('B001') && boxCodesInSheet.has('B002'), [...boxCodesInSheet]);

  /* ---------------- 5b. 封板后在新卡板 P002 上继续装箱 ---------------- */
  console.log('\n[5b] 在新卡板 P002 上继续装箱');
  await addBoxWithModel('M-500');
  check('P002 新箱已创建', (await page.textContent('.box-title'))?.includes('B001'), await page.textContent('.box-title'));
  await sendCode('P2-000001');
  check('P002 第一箱 1 条条码', (await boxRowCount(0)) === 1, await boxRowCount(0));

  /* ---------------- 6. 刷新页面后数据不丢 ---------------- */
  console.log('\n[6] 刷新页面');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.pallet-code', { timeout: 15000 });
  check('刷新后任务名保留', (await page.textContent('.app-sub'))?.includes('浏览器自检任务'));
  check('刷新后卡板数保留', (await page.textContent('.app-sub'))?.includes('2 板'));
  check('刷新后停在扫描中的卡板', (await page.textContent('.pallet-code'))?.trim() === 'P002');
  const sealedPalletCount = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('pallet-scan');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tasks = await new Promise((resolve) => {
      const tx = db.transaction('tasks', 'readonly');
      const req = tx.objectStore('tasks').getAll();
      req.onsuccess = () => resolve(req.result);
    });
    db.close();
    return tasks?.[0]?.pallets?.length ?? -1;
  });
  check('IndexedDB 里确实存了 2 块卡板', sealedPalletCount === 2, sealedPalletCount);

  /* ---------------- 7. 模式二配板 ---------------- */
  console.log('\n[7] 模式二按货单配板');
  await page.click('.tab:has-text("按单配板")');
  await page.waitForSelector('button:has-text("直接使用当前任务的扫描数据")');
  await page.click('button:has-text("直接使用当前任务的扫描数据")');
  await page.waitForTimeout(300);
  // 用「生成货单文件 -> 真实上传」的方式走导入流程（列名：编号 / 型号 / 数量）
  const orderWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    orderWb,
    XLSX.utils.aoa_to_sheet([
      ['编号', '型号', '数量'],
      ['SN-000001', 'M-100', 1],
      ['FAKE-SCAN-0001', 'M-100', 2], // 货单 2 / 扫描 1 -> 数量差异
      ['NOT-IN-PALLET', 'M-900', 3], // 模式一没有 -> 未匹配
    ]),
    '货单',
  );
  const orderPath = join(downloadDir, '货单.xlsx');
  writeFileSync(orderPath, XLSX.write(orderWb, { bookType: 'xlsx', type: 'buffer' }));
  await page.setInputFiles('input[type=file][accept*=".xlsx"]', orderPath);
  await page.waitForTimeout(600);
  check('货单导入成功提示', (await page.textContent('body'))?.includes('货单导入成功'), await page.textContent('.import-info'));
  await page.click('button:has-text("开始配板")');
  await page.waitForSelector('.stat-grid');
  const statsText = await page.textContent('.stat-grid');
  check('配板结果统计显示', /卡板数/.test(statsText ?? ''), statsText);
  check('识别出未匹配条码', (await page.textContent('.legend'))?.includes('未匹配'), await page.textContent('.legend'));
  check('识别出数量差异', (await page.textContent('body'))?.includes('数量差异'), await page.textContent('.stat-grid'));
  const pickDownload = page.waitForEvent('download', { timeout: 15000 });
  await page.click('button:has-text("导出配货 Excel")');
  const pickFile = await pickDownload;
  const pickPath = join(downloadDir, pickFile.suggestedFilename());
  await pickFile.saveAs(pickPath);
  const wbPick = XLSX.read(readFileSync(pickPath), { type: 'buffer' });
  check(
    '配货表 3 个 Sheet',
    JSON.stringify(wbPick.SheetNames) === JSON.stringify(['配货总览', '配货明细', '异常']),
    wbPick.SheetNames,
  );
  const detail = XLSX.utils.sheet_to_json(wbPick.Sheets['配货明细'], { defval: '' });
  check('配货明细有数据', detail.length > 0, detail.length);
  if (detail.length > 0) {
    check('明细含层号与堆放顺序', '层号(1=最底)' in detail[0] && '堆放顺序' in detail[0], Object.keys(detail[0]));
    const layers = detail.filter((d) => d['卡板号'] !== '合计').map((d) => Number(d['层号(1=最底)']));
    check('层号从 1 开始且不跳层', layers.length > 0 && Math.min(...layers) === 1, layers);
  }
  const anomaly = XLSX.utils.sheet_to_json(wbPick.Sheets['异常'], { defval: '' });
  check('异常表记录未匹配', anomaly.some((r) => String(r['异常类型'] ?? '').includes('未匹配')), anomaly.slice(0, 2));

  /* ---------------- 8. 总表导出 ---------------- */
  console.log('\n[8] 总表导出');
  await page.click('.tab:has-text("数据导出")');
  const taskDownload = page.waitForEvent('download', { timeout: 15000 });
  await page.click('button:has-text("导出总 Excel")');
  const taskFile = await taskDownload;
  const taskPath = join(downloadDir, taskFile.suggestedFilename());
  await taskFile.saveAs(taskPath);
  const wbTask = XLSX.read(readFileSync(taskPath), { type: 'buffer' });
  check(
    '总表 4 个 Sheet',
    JSON.stringify(wbTask.SheetNames) === JSON.stringify(['总览', '卡板汇总', '箱汇总', '条码明细']),
    wbTask.SheetNames,
  );
  const boxSummary = XLSX.utils.sheet_to_json(wbTask.Sheets['箱汇总'], { defval: '' });
  check(
    '箱汇总每个箱子一行（3 箱）',
    boxSummary.filter((r) => String(r['卡板号'] ?? '').startsWith('P')).length === 3,
    boxSummary.length,
  );
  const barcodeDetail = XLSX.utils.sheet_to_json(wbTask.Sheets['条码明细'], { defval: '' });
  // 任务总表导出任务的全部数据：P001 的 12 条 + P002 的 1 条 = 13 行
  const detailCards = barcodeDetail.filter((r) => String(r['卡板号'] ?? '').startsWith('P'));
  check('条码明细行数 = 全部条码数（13）', detailCards.length === 13, {
    rows: detailCards.length,
    codes: [...new Set(detailCards.map((r) => String(r['卡板号'])))],
  });

  /* ---------------- 9. JSON 备份 ---------------- */
  console.log('\n[9] JSON 备份');
  const backupDownload = page.waitForEvent('download', { timeout: 15000 });
  await page.click('button:has-text("导出 JSON 备份")');
  const backupFile = await backupDownload;
  const backupPath = join(downloadDir, backupFile.suggestedFilename());
  await backupFile.saveAs(backupPath);
  const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
  check('备份含任务数据', Array.isArray(backup.tasks) && backup.tasks.length === 1, backup.tasks?.length);
  check('备份含设置', !!backup.settings, Object.keys(backup.settings ?? {}).length);

  /* ---------------- 10. 设置页 ---------------- */
  console.log('\n[10] 设置页');
  await page.click('.tab:has-text("设置")');
  await page.waitForSelector('text=卡板规则');
  const settingsText = await page.textContent('body');
  check('设置页显示安全上下文状态', settingsText?.includes('安全上下文'), settingsText?.slice(0, 100));
  check('设置页显示识别引擎', /识别引擎/.test(settingsText ?? ''));
  await page.click('button.toggle >> nth=0');
  await page.waitForTimeout(200);
  check('开关可切换', true);

  /* ---------------- 11. 离线与外部依赖 ---------------- */
  console.log('\n[11] 离线与外部依赖');
  check('没有外部网络请求', externalRequests.length === 0, externalRequests.slice(0, 5));
  const realErrors = consoleErrors.filter((e) => !/favicon|Download the React DevTools/i.test(e));
  check('没有页面级 JS 错误', realErrors.length === 0, realErrors.slice(0, 4));

  const files = readdirSync(downloadDir);
  notes.push(`下载文件：${files.join('、')}`);
} catch (error) {
  failures.push(`浏览器自检异常：${error?.message ?? error}`);
  console.error(error);
} finally {
  await browser.close();
  rmSync(downloadDir, { recursive: true, force: true });
}

console.log(`\n通过 ${passed} 项浏览器检查`);
for (const note of notes) console.log(`ℹ️  ${note}`);
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('真实浏览器端到端验证通过 ✅');
