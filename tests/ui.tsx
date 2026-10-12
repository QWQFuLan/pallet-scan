/**
 * 真正的「界面 + 业务」端到端自检（在 happy-dom 里跑真实的 React 组件）：
 *   新建任务 -> 手动扫码（含重复条码累加）-> 撤销 -> 封板 -> 下一板
 *   -> 导出（拦截下载，校验 xlsx 内容）-> 模式二导入并配板 -> 导出配货表
 *   -> IndexedDB 持久化（Dexie 在 happy-dom 的假 IndexedDB 上真实读写）
 *
 * 摄像头相关的 UI（video 元素）会被跳过，无法在无摄像头环境下验证的部分单独提示。
 */
import { Window } from 'happy-dom';

// 测试文件由 tests/transpile-src.mjs 转成 CommonJS 执行，require 直接可用
declare const require: (id: string) => any;

const window = new Window({ url: 'https://localhost:5173/' });

// happy-dom 没有 IndexedDB：用 fake-indexeddb 提供真实的内存实现，
// 这样 Dexie 的读写是真的走 IndexedDB，可以验证「刷新后数据不丢」。
const fakeIndexedDB = require('fake-indexeddb');
const fakeApi = fakeIndexedDB.indexedDB ?? fakeIndexedDB.default;
Object.defineProperty(window, 'indexedDB', {
  value: fakeApi,
  writable: true,
  configurable: true,
});
Object.defineProperty(window, 'IDBKeyRange', {
  value: fakeIndexedDB.IDBKeyRange ?? fakeIndexedDB.default?.IDBKeyRange,
  writable: true,
  configurable: true,
});

const globalRef = globalThis as unknown as Record<string, unknown>;
// React 18 需要这个标记才会认为处于测试环境（否则 act() 不生效）
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const windowProps = [
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'HTMLVideoElement',
  'HTMLCanvasElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'PointerEvent',
  'File',
  'FileList',
  'Blob',
  'FormData',
  'DOMException',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'matchMedia',
  'indexedDB',
  'IDBKeyRange',
  'CSS',
  'Audio',
  'Image',
];
for (const key of windowProps) {
  const value = (window as any)[key];
  if (value === undefined) continue;
  // Node 自带的 navigator / crypto 等是只读 getter，需要用 defineProperty 覆盖
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}
Object.defineProperty(globalThis, 'self', { value: window, configurable: true, writable: true });
Object.defineProperty(globalThis, 'top', { value: window, configurable: true, writable: true });

// happy-dom 缺少的 API 补齐
const nodeCrypto = require('node:crypto');
if (!(globalThis as any).crypto?.randomUUID) {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      randomUUID: () => nodeCrypto.randomUUID(),
      getRandomValues: (arr: Uint8Array) => nodeCrypto.webcrypto.getRandomValues(arr),
    },
    writable: true,
    configurable: true,
  });
}
if (!(globalThis as any).URL.createObjectURL) {
  (globalThis as any).URL.createObjectURL = () => 'blob:mock';
  (globalThis as any).URL.revokeObjectURL = () => undefined;
}

const React = require('react') as typeof import('react');
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const act = (React as unknown as { act: (fn: () => unknown) => Promise<void> }).act;
const XLSX = require('xlsx') as typeof import('xlsx');
const { findDuplicateBarcodes } = require('@/services/scanRules') as typeof import('@/services/scanRules');

export interface UiTestResult {
  passed: number;
  failures: string[];
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* 工具：渲染、查询、点击                                              */
/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await sleep(6);
    });
  }
}

/**
 * 模拟用户输入：React 会给 input 打上 value tracker，
 * 直接赋值 + dispatch input 事件会被 React 判定为「值没变」而忽略，
 * 必须走原型上的原生 setter 才能触发 onChange。
 */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      (globalThis as any).HTMLInputElement.prototype,
      'value',
    )?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new (globalThis as any).Event('input', { bubbles: true }));
  });
}

export async function runUiTests(): Promise<UiTestResult> {
  const failures: string[] = [];
  const notes: string[] = [];
  let passed = 0;

  const check = (name: string, ok: unknown, extra?: unknown) => {
    if (ok) passed += 1;
    else failures.push(`${name}${extra === undefined ? '' : ` -> ${JSON.stringify(extra)}`}`);
  };

  const doc = (globalThis as any).document as Document;
  const container = doc.createElement('div');
  doc.body.appendChild(container);

  // 拦截 SheetJS 的写文件，避免自检往项目目录里丢 xlsx；顺便记录导出内容
  const downloads: { name: string; data: ArrayBuffer }[] = [];
  const originalWriteFile = (XLSX as any).writeFile;
  (XLSX as any).writeFile = (wb: any, filename: string) => {
    const out = (XLSX as any).write(wb, { bookType: 'xlsx', type: 'array' });
    downloads.push({ name: filename, data: out as ArrayBuffer });
  };

  const { default: App } = require('@/App') as typeof import('@/App');
  const { useStore } = require('@/store') as typeof import('@/store');

  // 入口 main.tsx 会调用 init()，测试里手动触发一次
  await act(async () => {
    await useStore.getState().init();
  });
  // 清空可能残留的数据（本次运行内存里的 IndexedDB 是干净的，这里只是保险）
  await act(async () => {
    await useStore.getState().clearAllData();
  });

  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(App));
  });
  await tick(10);

  const text = () => container.textContent ?? '';
  if (!text().includes('仓库扫码分卡板')) {
    failures.push(
      `应用没渲染出标题，当前 DOM：${container.innerHTML.slice(0, 400)} / store.ready=${useStore.getState().ready}`,
    );
  }
  check('渲染出应用标题', text().includes('仓库扫码分卡板'), text().slice(0, 60));
  check('无任务时提示新建', text().includes('还没有任务'));

  const clickByText = async (needle: string, selector = 'button') => {
    const nodes = Array.from(container.querySelectorAll(selector));
    const target = nodes.find((n) => (n.textContent ?? '').includes(needle));
    if (!target) {
      failures.push(`找不到按钮：${needle}`);
      return null;
    }
    await act(async () => {
      (target as HTMLElement).click();
    });
    await tick();
    return target as HTMLElement;
  };

  await clickByText('新建任务');
  const nameInput = container.querySelector('input.input') as HTMLInputElement | null;
  check('弹出新建任务输入框', !!nameInput);
  if (nameInput) {
    await typeInto(nameInput, 'UI 自检任务');
    await tick();
  }
  await clickByText('创建任务');
  await tick(6);

  check('任务创建成功', useStore.getState().task?.name === 'UI 自检任务', useStore.getState().task?.name);
  check('自动创建第一个卡板', useStore.getState().task?.pallets.length === 1);
  check('卡板号为 P001', text().includes('P001'));
  check('显示 0/60 箱', text().includes('0/60'), text().slice(0, 200));
  check('提示先添加箱子', text().includes('还没有箱子'), text().slice(0, 300));

  /* ---------- 2. 添加箱子：先扫型号 -> 确认 -> 扫条码 ---------- */

  const pallet = () => useStore.getState().task!.pallets[0];
  const boxAt = (i = 0) => pallet().boxes[i];
  const barcodesOf = (i = 0) => boxAt(i).barcodes.map((b) => b.code);

  const addBoxWithModel = async (model: string) => {
    await clickByText('添加箱子');
    await tick(2);
    const input = container.querySelector('.modal input.input') as HTMLInputElement | null;
    if (!input) {
      failures.push('添加箱子弹窗里没有型号输入框');
      return false;
    }
    await typeInto(input, model);
    await clickByText('确认并开始扫条码');
    await tick(3);
    return true;
  };

  check('未添加箱子时提示先加箱', !!container.querySelector('button.btn-primary') && text().includes('添加箱子'));
  await addBoxWithModel('M-100');
  check('箱已创建', pallet().boxes.length === 1, pallet().boxes.length);
  check('箱号 B001', boxAt().code === 'B001', boxAt().code);
  check('箱型号 M-100', boxAt().model === 'M-100', boxAt().model);
  check('页面显示当前箱型号', text().includes('型号 M-100'), text().slice(0, 300));

  const manualForm = container.querySelector('form.manual-form') as HTMLFormElement | null;
  check('存在手动输入表单', !!manualForm);
  const manualInput = manualForm?.querySelector('input') as HTMLInputElement | null;
  if (!manualInput) {
    failures.push(`手动输入框缺失：DOM=${container.innerHTML.slice(0, 300)}`);
    return { passed, failures, notes };
  }

  const submitManual = async (code: string) => {
    await typeInto(manualInput!, code);
    await act(async () => {
      manualForm!.dispatchEvent(new (globalThis as any).Event('submit', { bubbles: true, cancelable: true }));
    });
    await tick(3);
  };

  await submitManual('SN-000001');
  await submitManual('SN-000002');
  await submitManual('SN-000001'); // 箱内重复条码：不计数，只提示

  check('箱内 2 条条码（重复不加）', boxAt().barcodes.length === 2, barcodesOf());
  check('条码序号连续', boxAt().barcodes.map((b) => b.index), [1, 2]);
  check('重复条码没有被写进列表', !findDuplicateBarcodes(boxAt().barcodes).codes.length);
  check('提示条码重复', text().includes('条码重复'), text().slice(-200));

  /* ---------- 3. 遗留重复条码：标红 + 一键删除 ---------- */

  await act(async () => {
    const box = useStore.getState().task!.pallets[0].boxes[0];
    box.barcodes.push({ ...box.barcodes[0], id: 'legacy-dup', index: box.barcodes.length + 1, seq: 99 });
    useStore.setState({ revision: useStore.getState().revision + 1 });
  });
  await tick(3);
  // 展开箱子看明细
  await act(async () => {
    (container.querySelector('.box-head') as HTMLElement)?.click();
  });
  await tick(3);
  check('检测到重复条码', findDuplicateBarcodes(boxAt().barcodes).codes.length === 1);
  check('列表标出重复行', container.querySelectorAll('.code-row-dup').length === 1, container.querySelectorAll('.code-row-dup').length);
  check('出现一键删除重复按钮', !!container.querySelector('.dup-warn button'));

  const dedupBtn = container.querySelector('.dup-warn button') as HTMLElement | null;
  if (dedupBtn) {
    await act(async () => dedupBtn.click());
    await tick(3);
  }
  check('删除重复后剩 2 条', boxAt().barcodes.length === 2, boxAt().barcodes.length);
  check('重复提示已消失', !container.querySelector('.dup-warn'));

  /* ---------- 4. 撤销 / 删除单条 ---------- */

  await submitManual('SN-000003');
  check('第 3 条已入库', boxAt().barcodes.length === 3, barcodesOf());
  await clickByText('撤销上一条');
  await tick(3);
  check('撤销后剩 2 条', boxAt().barcodes.length === 2, barcodesOf());
  check('撤销掉的是最后一条', !barcodesOf().includes('SN-000003'), barcodesOf());

  await submitManual('SN-000003');
  const delBtn = container.querySelector('.code-row .btn-delete') as HTMLElement | null;
  check('存在删除按钮', !!delBtn);
  const codesBeforeDelete = boxAt().barcodes.length;
  if (delBtn) {
    await act(async () => delBtn.click());
    await tick(2);
  }
  check('删除后少一条', boxAt().barcodes.length === codesBeforeDelete - 1, barcodesOf());

  // 补到 20 条（模拟一箱约 20 个条码）
  for (let i = 0; i < 40 && boxAt().barcodes.length < 20; i += 1) {
    await submitManual(`SN-${String(900000 + i)}`);
  }
  check('一箱 20 条条码', boxAt().barcodes.length === 20, boxAt().barcodes.length);

  /* ---------- 5. 封箱 ---------- */

  const sealBoxBtn = Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').trim().startsWith('封箱 B001'),
  ) as HTMLElement | undefined;
  check('存在封箱按钮', !!sealBoxBtn, sealBoxBtn?.textContent);
  if (sealBoxBtn) {
    await act(async () => sealBoxBtn.click());
    await tick(2);
  }
  check('封箱前二次确认', text().includes('封箱 B001？'), text().slice(-200));
  const confirmSealBoxBtn = Array.from(container.querySelectorAll('.modal button')).find((b) =>
    (b.textContent ?? '').includes('确认封箱'),
  ) as HTMLElement | undefined;
  check('存在确认封箱按钮', !!confirmSealBoxBtn);
  if (confirmSealBoxBtn) {
    await act(async () => confirmSealBoxBtn.click());
    await tick(4);
  }
  check('第 1 箱已封箱', boxAt().status === 'sealed', boxAt().status);
  check('封箱提示包含条数', text().includes('已封箱（20 条条码'), text().slice(-200));
  check('封箱后提示先加箱子', text().includes('已封箱') && text().includes('添加箱子'));

  /* ---------- 6. 第二箱：重新扫型号 ---------- */

  await addBoxWithModel('M-200');
  check('第二箱已创建', pallet().boxes.length === 2, pallet().boxes.length);
  check('第二箱型号 M-200', boxAt(1).model === 'M-200', boxAt(1).model);
  check('第二箱箱号 B002', boxAt(1).code === 'B002', boxAt(1).code);
  check('第二箱是空的', boxAt(1).barcodes.length === 0);

  // 未封箱时再加第三箱应被拒绝
  await clickByText('添加箱子');
  await tick(2);
  const input2 = container.querySelector('.modal input.input') as HTMLInputElement | null;
  if (input2) await typeInto(input2, 'M-300');
  await clickByText('确认并开始扫条码');
  await tick(3);
  check('未封箱时不允许加新箱', pallet().boxes.length === 2, pallet().boxes.length);
  const rejectToast = Array.from(container.querySelectorAll('.toast'))
    .map((t) => t.textContent ?? '')
    .join(' | ');
  check('提示先封箱', rejectToast.includes('还没封箱'), rejectToast || text().slice(-200));

  // 关掉「添加箱子」弹窗（点它里面的取消），否则会挡住后面的操作
  const cancelAddBox = Array.from(container.querySelectorAll('.modal button')).find(
    (b) => (b.textContent ?? '').trim() === '取消',
  ) as HTMLElement | undefined;
  if (cancelAddBox) {
    await act(async () => cancelAddBox.click());
    await tick(2);
  }
  check('添加箱子弹窗已关闭', !container.querySelector('.modal-mask'), container.querySelector('.modal')?.textContent?.slice(0, 40));

  await submitManual('B2-001');
  if (!barcodesOf(1).includes('B2-001')) {
    failures.push(
      `第二箱条码未入库：box2=${JSON.stringify(
        boxAt(1).barcodes.map((b) => b.code),
      )} box2状态=${boxAt(1).status} 当前箱=${useStore.getState().activeBoxId} 页面提示=${(
        container.textContent ?? ''
      )
        .slice(-260)
        .replace(/\s+/g, ' ')}`,
    );
  }
  check('第二箱条码入库', barcodesOf(1).includes('B2-001'), barcodesOf(1));

  /* ---------- 7. 封板（需要先封箱） ---------- */

  const beforeSeal = pallet().boxes.length;
  // B002 还没封箱，先点封板应被拒绝
  const sealPalletBtn = Array.from(container.querySelectorAll('button.btn-success')).find((b) =>
    (b.textContent ?? '').trim().startsWith('封板'),
  ) as HTMLElement | undefined;
  check('存在封板按钮', !!sealPalletBtn, sealPalletBtn?.textContent?.slice(0, 40));
  if (sealPalletBtn) {
    await act(async () => sealPalletBtn.click());
    await tick(2);
  }
  check('未封箱时不能封板', text().includes('还没封箱'), text().slice(-200));
  check('未封箱时没有创建新卡板', pallet().pallets === undefined || useStore.getState().task!.pallets.length === 1);
  // 关掉提示（改点「取消」）
  const cancelBtn = Array.from(container.querySelectorAll('.modal button')).find((b) =>
    (b.textContent ?? '').trim() === '取消',
  ) as HTMLElement | undefined;
  if (cancelBtn) {
    await act(async () => cancelBtn.click());
    await tick(1);
  }

  // 封掉 B002 再封板
  const sealBox2 = Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').trim().startsWith('封箱 B002'),
  ) as HTMLElement | undefined;
  if (sealBox2) {
    await act(async () => sealBox2.click());
    await tick(1);
    const ok = Array.from(container.querySelectorAll('.modal button')).find((b) =>
      (b.textContent ?? '').includes('确认封箱'),
    ) as HTMLElement | undefined;
    if (ok) {
      await act(async () => ok.click());
      await tick(3);
    }
  }
  check('第二箱已封箱', useStore.getState().task!.pallets[0].boxes[1].status === 'sealed');

  if (sealPalletBtn) {
    await act(async () => sealPalletBtn.click());
    await tick(2);
  }
  check('封板前出现二次确认', text().includes('封板 P001？'), text().slice(-200));
  const confirmBtn = Array.from(container.querySelectorAll('.modal button')).find((b) =>
    (b.textContent ?? '').includes('确认封板'),
  ) as HTMLElement | undefined;
  check('存在确认封板按钮', !!confirmBtn);
  if (confirmBtn) {
    await act(async () => confirmBtn.click());
    await tick(8);
  }

  const task = (useStore.getState().task ?? useStore.getState().task)!;
  check(
    '封板后有 2 个卡板',
    task?.pallets.length === 2,
    `pallets=${task?.pallets.map((p) => `${p.code}:${p.status}:${p.boxes.length}箱`).join(',')} toast=${
      container.querySelector('.toast')?.textContent ?? ''
    }`,
  );
  check('第一板已封板', task?.pallets[0].status === 'sealed');
  check('第一板箱数正确', task?.pallets[0].boxes.length === beforeSeal, task?.pallets[0].boxes.length);
  check('自动创建 P002', task?.pallets[1]?.code === 'P002' && task?.pallets[1]?.status === 'scanning');
  check('当前卡板切到 P002', useStore.getState().activePalletId === task?.pallets[1]?.id);
  if (task?.pallets.length !== 2) {
    return { passed, failures, notes };
  }

  // 导出单板 Excel 会触发下载；这里只确认点击不报错
  let exportError: unknown = null;
  try {
    await clickByText('导出本板 Excel');
    await tick(2);
  } catch (error) {
    exportError = error;
  }
  check('导出单板 Excel 不报错', !exportError, String(exportError));

  /* ---------- 7. 第二板：加箱到满板，测试箱数上限 ---------- */

  // 第二板：连加箱子直到 60 箱上限（每箱 1 条条码）
  for (let i = 0; i < 70; i += 1) {
    await clickByText('添加箱子');
    await tick(1);
    const modelField = container.querySelector('.modal input.input') as HTMLInputElement | null;
    if (!modelField) break;
    await typeInto(modelField, `MX-${String(i).padStart(3, '0')}`);
    await clickByText('确认并开始扫条码');
    await tick(2);
    await typeInto(manualInput!, `P2-${String(i).padStart(3, '0')}`);
    await act(async () => {
      manualForm!.dispatchEvent(new (globalThis as any).Event('submit', { bubbles: true, cancelable: true }));
    });
    await clickByText(`封箱 B${String(i + 1).padStart(3, '0')}`);
    await clickByText('确认封箱');
    await tick(1);
  }
  await tick(3);

  const p2 = useStore.getState().task!.pallets[1];
  check('第二板不超过箱数上限 60', p2.boxes.length === 60, p2.boxes.length);
  check('每箱各 1 条条码', p2.totalBarcodes === 60, p2.totalBarcodes);
  check('满板提示出现', text().includes('已满'));

  /* ---------- 8. 刷新页面后数据不丢（丢弃模块缓存，用全新的 Dexie 连接重新读取） ---------- */

  const snapshotBoxes = useStore.getState().task!.pallets.reduce((s, p) => s + p.boxes.length, 0);
  const snapshotBarcodes = useStore.getState().task!.pallets.reduce((s, p) => s + p.totalBarcodes, 0);

  // Tab 栏检查要在卸载之前做
  const tabs = Array.from(container.querySelectorAll('.tab')) as HTMLElement[];
  check('底部有 4 个 Tab', tabs.length === 4, tabs.length);
  for (const key of ['mode1', 'mode2', 'data', 'settings'] as const) {
    await act(async () => {
      useStore.getState().setTab(key);
    });
  }
  await tick(2);
  check('切换 Tab 不报错', (container.textContent ?? '').length > 0);
  await act(async () => {
    useStore.getState().setTab('mode1');
  });

  await act(async () => {
    root.unmount();
  });
  await tick(2);
  // 等待防抖落盘
  await act(async () => {
    await sleep(400);
  });
  // 模拟刷新：清掉模块缓存，重新加载 db / store（新的 Dexie 实例读同一个 IndexedDB）
  // 注意：编译后的测试文件位于 .tmp/lib/tests，所以这里使用相对路径
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/store')];
  const freshStore = (require('../src/store') as typeof import('@/store')).useStore;
  await act(async () => {
    await freshStore.getState().init();
  });
  await tick(3);
  const afterReload = freshStore.getState().task;
  check('刷新后任务还在', !!afterReload && afterReload.name === 'UI 自检任务', afterReload?.name);
  check(
    '刷新后箱数一致',
    afterReload?.pallets.reduce((s, p) => s + p.boxes.length, 0) === snapshotBoxes,
    afterReload?.pallets.reduce((s, p) => s + p.boxes.length, 0),
  );
  check(
    '刷新后条码数一致',
    afterReload?.pallets.reduce((s, p) => s + p.totalBarcodes, 0) === snapshotBarcodes,
    afterReload?.pallets.reduce((s, p) => s + p.totalBarcodes, 0),
  );
  check('刷新后封箱状态保留', afterReload?.pallets[0].boxes[0].status === 'sealed');
  check('刷新后型号保留', afterReload?.pallets[0].boxes[0].model === 'M-100', afterReload?.pallets[0].boxes[0].model);
  check('刷新后封板状态保留', afterReload?.pallets[0].status === 'sealed');
  check('刷新后卡板号保留', afterReload?.pallets[1].code === 'P002', afterReload?.pallets[1].code);

  /* ---------- 9. 模式二：用模式一的数据配板 ---------- */

  const taskNow = useStore.getState().task!;
  const items = taskNow.pallets.flatMap((p) =>
    p.boxes.flatMap((box) =>
      box.barcodes.map((code) => ({
        palletCode: p.code,
        boxCode: box.code,
        boxIndex: box.index,
        itemIndex: code.index,
        barcode: code.code,
        model: box.model,
        qty: 1,
        scannedAt: code.scannedAt,
      })),
    ),
  );
  useStore.getState().setMode2Scan({
    fileName: '当前任务',
    headers: [],
    items,
    palletCount: taskNow.pallets.length,
    boxCount: snapshotBoxes,
    barcodeCount: items.length,
  });
  // 货单：P001 的一条 + P002 的一条（数量 3 制造数量差异）+ 一个未匹配
  const countOf = (code: string) => items.filter((i) => i.barcode === code).length;
  const p1Code = taskNow.pallets[0].boxes[0].barcodes[0].code;
  const p2Code = taskNow.pallets[1].boxes[0].barcodes[0].code;
  check('P001 能取到条码', !!p1Code, p1Code);
  check('P002 能取到条码', !!p2Code, p2Code);
  useStore.getState().setMode2Order({
    fileName: '货单.xlsx',
    headers: [],
    items: [
      { barcode: p1Code, qty: countOf(p1Code) || 1, orderIndex: 0, status: 'matched' },
      { barcode: p2Code, qty: (countOf(p2Code) || 1) + 2, orderIndex: 1, status: 'matched' },
      { barcode: 'NOT-EXIST', qty: 2, orderIndex: 2, status: 'matched' },
    ],
    totalQty: (countOf(p1Code) || 1) + (countOf(p2Code) || 1) + 4,
    barcodeCount: 3,
  });
  await tick(2);

  const { allocate, exportPickResult } = require('@/services/allocation') as typeof import('@/services/allocation');
  const { exportTask: exportTaskFn } = require('@/services/excel') as typeof import('@/services/excel');
  const result = allocate(useStore.getState().mode2Order!, useStore.getState().mode2Scan!, {
    maxBoxesPerPallet: 40,
    boxesPerLayer: 5,
  });
  useStore.getState().setMode2Result(result);
  await tick(2);

  check('配板生成结果', !!useStore.getState().mode2Result);
  check('未匹配条码被识别', result.stats.unmatchedCount === 1, result.stats.unmatchedCount);
  check('数量差异被识别', result.stats.mismatchCount === 1, result.stats.mismatchCount);
  check(
    '已配件数 = 前两个货单项之和',
    result.stats.allocatedQty === (countOf(p1Code) || 1) + (countOf(p2Code) || 1) + 2,
    {
      allocatedQty: result.stats.allocatedQty,
      expected: (countOf(p1Code) || 1) + (countOf(p2Code) || 1) + 2,
    },
  );

  /* ---------- 10. 导出配货 Excel：读取上面拦截到的内容 ---------- */

  try {
    exportPickResult(result, 'UI 自检任务');
    exportTaskFn(useStore.getState().task!);
  } catch (error) {
    failures.push(`导出 Excel 抛错：${String(error)}`);
  }

  check(
    '共导出 4 个文件（封箱不导出 / 封板导出单板 + 配货 + 总表）',
    downloads.length >= 3,
    downloads.map((d) => d.name),
  );
  check(
    '封板时导出了单板表',
    downloads.some((d) => d.name.includes('单板明细')),
    downloads.map((d) => d.name),
  );
  const pickFile = downloads.find((d) => d.name.includes('配货结果'));
  check('配货文件名正确', !!pickFile, downloads.map((d) => d.name));
  if (pickFile) {
    const wb = XLSX.read(pickFile.data, { type: 'array' });
    check('配货表含 3 个 Sheet', wb.SheetNames.length === 3, wb.SheetNames);
    check(
      '配货表 Sheet 名称正确',
      JSON.stringify(wb.SheetNames) === JSON.stringify(['配货总览', '配货明细', '异常']),
      wb.SheetNames,
    );
    const detail = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['配货明细'], { defval: '' });
    check('配货明细有数据行', detail.length >= 4, detail.length);
    const anomaly = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['异常'], { defval: '' });
    check(
      '异常表记录了未匹配',
      anomaly.some((r) => String(r['异常类型'] ?? '').includes('未匹配')),
      anomaly.slice(0, 3),
    );
  }

  const taskFile = downloads.find((d) => d.name.includes('总表'));
  check('任务总表文件名正确', !!taskFile, downloads.map((d) => d.name));
  if (taskFile) {
    const wb = XLSX.read(taskFile.data, { type: 'array' });
    check(
      '总表 Sheet 名称正确',
      JSON.stringify(wb.SheetNames) === JSON.stringify(['总览', '卡板汇总', '箱汇总', '条码明细']),
      wb.SheetNames,
    );
    const detail = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['条码明细'], { defval: '' });
    check('总表条码明细行数 = 条码数', detail.length >= snapshotBarcodes, {
      detailRows: detail.length,
      snapshotBarcodes,
    });
    const boxRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['箱汇总'], { defval: '' });
    check(
      '总表箱汇总行数 = 箱数',
      boxRows.filter((r) => String(r['卡板号'] ?? '').startsWith('P')).length === snapshotBoxes,
      boxRows.length,
    );
  }

  /* ---------- 11. JSON 备份 / 恢复 ---------- */

  const { buildBackup, parseBackup } = require('@/services/backup') as typeof import('@/services/backup');
  const backup = buildBackup([useStore.getState().task!], useStore.getState().settings, useStore.getState().task!.id);
  const restored = parseBackup(JSON.stringify(backup));
  check('备份可恢复', restored.tasks.length === 1);
  check(
    '备份箱数一致',
    restored.tasks[0].pallets.reduce((s, p) => s + p.boxes.length, 0) === snapshotBoxes,
    restored.tasks[0].pallets.reduce((s, p) => s + p.boxes.length, 0),
  );
  check(
    '备份条码数一致',
    restored.tasks[0].pallets.reduce((s, p) => s + p.totalBarcodes, 0) === snapshotBarcodes,
    restored.tasks[0].pallets.reduce((s, p) => s + p.totalBarcodes, 0),
  );
  check('备份保留型号', restored.tasks[0].pallets[0].boxes[0].model === 'M-100');

  /* ---------- 11. Tab 切换在卸载前已检查完毕 ---------- */

  notes.push('摄像头/条码识别部分无法在无摄像头环境自动验证，请按 README 用手机实测。');

  (XLSX as any).writeFile = originalWriteFile;
  return { passed, failures, notes };
}
