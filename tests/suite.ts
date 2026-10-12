/**
 * 核心逻辑自检（不需要浏览器、不需要摄像头）：
 *   - 模式二配板：条码归板、数量排序、层号计算、超限拆分、异常统计
 *   - Excel 解析：货单/模式一表头识别、卡板号标准化
 *   - JSON 备份：导出 -> 解析 -> 数据一致
 *   - 扫码业务规则：重复条码累加数量、上限拦截、撤销
 *
 * 运行：node scripts/run-tests.mjs
 */
import type { ImportedOrderData, ImportedScanData, OrderItem } from '@/types';
import { DEFAULT_SETTINGS } from '@/types';
import { allocate, buildPalletMap, planAllocation } from '@/services/allocation';
import { buildColumnMap, findHeaderRow, normalizeBoxCode, normalizePalletCode, parseQty, parseOrderWorkbook, parseScanWorkbook } from '@/services/excel';
import { parseBackup, buildBackup } from '@/services/backup';
import * as XLSX from 'xlsx';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: unknown, extra?: unknown): void {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${extra === undefined ? '' : ` -> ${JSON.stringify(extra)}`}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1;
    return;
  }
  failures.push(`${name} -> ${JSON.stringify({ actual, expected })}`);
}

/* ------------------------------------------------------------------ */
/* 1. Excel 解析辅助                                                   */
/* ------------------------------------------------------------------ */

function testExcelHelpers(): void {
  eq('parseQty 数字', parseQty(12), 12);
  eq('parseQty 带单位', parseQty('12 箱'), 12);
  eq('parseQty 空值', parseQty(''), 0);
  eq('normalizePalletCode P001', normalizePalletCode('P001'), 'P001');
  eq('normalizePalletCode 1', normalizePalletCode(1), 'P001');
  eq('normalizePalletCode p1-2', normalizePalletCode('p1-2'), 'P001-2');
  eq('normalizePalletCode 空', normalizePalletCode('', 3), 'P003');

  const headers = ['卡板号', '箱号', '箱序号', '条码', '箱内序号', '型号', '数量'];
  const map = buildColumnMap(headers);
  eq('列映射-卡板号', map.palletCode, 0);
  eq('列映射-箱号', map.boxCode, 1);
  eq('列映射-箱序号', map.boxIndex, 2);
  eq('列映射-条码', map.barcode, 3);
  eq('列映射-箱内序号', map.itemIndex, 4);
  eq('列映射-型号', map.model, 5);
  eq('列映射-数量', map.qty, 6);

  const withTitle: unknown[][] = [
    ['某某公司入库明细表', '', ''],
    ['制表人：张三', '', ''],
    ['条码', '数量', '型号'],
    ['SN-000001', 1, 'M-100'],
  ];
  eq('表头行识别', findHeaderRow(withTitle, ['编号', '条码', '数量']), 2);

  // 货单解析
  const orderWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(orderWb, XLSX.utils.aoa_to_sheet([...withTitle]), '货单');
  const parsedOrder = parseOrderWorkbook(orderWb, 'order.xlsx');
  eq('货单条码数', parsedOrder.items.length, 1);
  eq('货单总数量', parsedOrder.totalQty, 1);
  eq('货单型号列', parsedOrder.items[0].model, 'M-100');

  // 模式一导出解析（含汇总行，应被跳过）
  const scanRows = [
    ['卡板号', '箱号', '箱序号', '条码', '箱内序号', '型号', '数量', '扫描时间'],
    ['P001', 'B001', 1, 'A1', 1, 'M-100', 1, '2025-01-01 09:00:00'],
    ['P001', 'B001', 1, 'A2', 2, 'M-100', 1, '2025-01-01 09:01:00'],
    ['P002', 'B001', 1, 'A3', 1, 'M-200', 1, '2025-01-01 09:02:00'],
    [],
    ['合计', '', 3, 3, '', '', '', ''],
  ];
  const scanWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(scanWb, XLSX.utils.aoa_to_sheet(scanRows), '条码明细');
  const parsedScan = parseScanWorkbook(scanWb, 'scan.xlsx');
  eq('模式一条码数', parsedScan.barcodeCount, 3);
  eq('模式一卡板数', parsedScan.palletCount, 2);
  eq('模式一箱数', parsedScan.boxCount, 2);
  eq('模式一解析出型号', parsedScan.items[0].model, 'M-100');
  eq('模式一解析出箱号', parsedScan.items[0].boxCode, 'B001');
  eq('模式一解析出箱内序号', parsedScan.items[1].itemIndex, 2);

  // 箱号标准化
  eq('normalizeBoxCode b1', normalizeBoxCode('b1'), 'B001');
  eq('normalizeBoxCode 空', normalizeBoxCode('', 5), 'B005');
}

/* ------------------------------------------------------------------ */
/* 2. 模式二配板                                                       */
/* ------------------------------------------------------------------ */

function makeScan(rows: { palletCode: string; barcode: string; qty?: number; boxCode?: string }[]): ImportedScanData {
  const items = rows.map((r, i) => ({
    palletCode: r.palletCode,
    boxCode: r.boxCode ?? 'B001',
    boxIndex: 1,
    itemIndex: i + 1,
    barcode: r.barcode,
    qty: r.qty ?? 1,
  }));
  return {
    fileName: 'scan.xlsx',
    headers: [],
    items,
    palletCount: new Set(items.map((b) => b.palletCode)).size,
    boxCount: new Set(items.map((b) => `${b.palletCode}/${b.boxCode}`)).size,
    barcodeCount: items.length,
  };
}

function makeOrder(items: { barcode: string; qty: number; name?: string }[]): ImportedOrderData {
  const orderItems: OrderItem[] = items.map((it, i) => ({
    barcode: it.barcode,
    qty: it.qty,
    name: it.name,
    orderIndex: i,
    status: 'matched',
  }));
  return {
    fileName: 'order.xlsx',
    headers: [],
    items: orderItems,
    totalQty: orderItems.reduce((s, i) => s + i.qty, 0),
    barcodeCount: new Set(orderItems.map((i) => i.barcode)).size,
  };
}

/** 层号 & 排序不变量检查 */
function checkInvariants(label: string, result: ReturnType<typeof allocate>, limit: number, perLayer: number): void {
  for (const pallet of result.pallets) {
    if (pallet.palletCode === '未匹配') continue;
    check(`${label}: ${pallet.palletCode} 不超上限(实际 ${pallet.totalBoxes})`, pallet.totalBoxes <= limit);
    // 堆放顺序必须连续 1..N，且与层号递增一致
    let expected = 1;
    let ok = true;
    let prevLayer = 1;
    for (const box of pallet.boxes) {
      if (box.stackOrder !== expected) ok = false;
      if (box.layerIndex < prevLayer) ok = false;
      prevLayer = box.layerIndex;
      expected += 1;
    }
    check(`${label}: ${pallet.palletCode} 堆放顺序连续`, ok);
    // 同层不超过每层箱数
    const layerCounts = new Map<number, number>();
    pallet.boxes.forEach((b) => layerCounts.set(b.layerIndex, (layerCounts.get(b.layerIndex) ?? 0) + 1));
    const perLayerOk = [...layerCounts.values()].every((c) => c <= perLayer);
    check(`${label}: ${pallet.palletCode} 每层不超 ${perLayer} 箱`, perLayerOk, [...layerCounts.entries()]);
    // 同条码必须连续堆放
    const seen = new Set<string>();
    let continuous = true;
    let last = '';
    for (const box of pallet.boxes) {
      if (box.barcode !== last) {
        if (seen.has(box.barcode)) continuous = false;
        seen.add(box.barcode);
        last = box.barcode;
      }
    }
    check(`${label}: ${pallet.palletCode} 同条码连续堆放`, continuous);
    // 层号越大 → 数量越少（层与层之间）：取每层数量总和
    const layerTotals = new Map<number, number>();
    pallet.boxes.forEach((b) => layerTotals.set(b.layerIndex, (layerTotals.get(b.layerIndex) ?? 0) + b.qty));
    const sorted = [...layerTotals.entries()].sort((a, b) => a[0] - b[0]);
    let descending = true;
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i][1] > sorted[i - 1][1]) descending = false;
    }
    check(`${label}: ${pallet.palletCode} 层数量从底到顶递减`, descending, sorted);
  }
}

function testAllocationNormal(): void {
  const scan = makeScan([
    { palletCode: 'P001', barcode: 'A', qty: 10 },
    { palletCode: 'P001', barcode: 'B', qty: 5 },
    { palletCode: 'P002', barcode: 'C', qty: 20 },
  ]);
  const order = makeOrder([
    { barcode: 'A', qty: 10 },
    { barcode: 'B', qty: 5 },
  ]);
  const result = allocate(order, scan, { maxBoxesPerPallet: 40, boxesPerLayer: 5 });

  eq('普通配板卡板数', result.stats.palletCount, 1);
  eq('普通配板箱数', result.stats.allocatedQty, 15);
  eq('普通配板无异常', result.anomalies.length, 0);
  const pallet = result.pallets[0];
  eq('普通配板号', pallet.palletCode, 'P001');
  if (pallet.boxes.length !== 15) {
    failures.push(
      `普通配板箱数异常：${JSON.stringify(
        result.pallets.map((p) => ({
          code: p.palletCode,
          total: p.totalBoxes,
          boxes: p.boxes.map((b) => `${b.barcode}@L${b.layerIndex}`),
        })),
      )} splits=${JSON.stringify(result.splits)}`,
    );
    return;
  }
  // A 在底层（10 箱 -> 第 1、2 层），B 在上层（5 箱 -> 第 3 层）
  eq('A 在第 1 层', pallet.boxes[0].barcode, 'A');
  eq('A 第 1 层 layerIndex', pallet.boxes[0].layerIndex, 1);
  eq('A 占 2 层后 B 从第 3 层开始', pallet.boxes[10].barcode, 'B');
  eq('B layerIndex', pallet.boxes[10].layerIndex, 3);
  checkInvariants('普通配板', result, 40, 5);
}

function testAllocationOverflow(): void {
  const scan = makeScan([
    { palletCode: 'P001', barcode: 'A', qty: 30 },
    { palletCode: 'P001', barcode: 'B', qty: 25 },
  ]);
  const order = makeOrder([
    { barcode: 'A', qty: 30 },
    { barcode: 'B', qty: 25 },
  ]);
  const result = allocate(order, scan, { maxBoxesPerPallet: 40, boxesPerLayer: 5 });

  eq('超限拆分卡板数', result.stats.palletCount, 2);
  eq('超限拆分数量', result.stats.allocatedQty, 55);
  eq('拆分记录数', result.splits.length, 1);
  eq('拆分来源', result.splits[0].from, 'P001');
  eq('拆分目标为新卡板号', result.splits[0].to, 'P002');
  const [p1, p2] = result.pallets;
  if (result.stats.allocatedQty !== 55 || result.pallets.length !== 2) {
    failures.push(
      `超限拆分异常：${JSON.stringify(
        result.pallets.map((p) => ({
          code: p.palletCode,
          split: p.isSplit,
          total: p.totalBoxes,
          boxes: p.boxes.map((b) => `${b.barcode}@L${b.layerIndex}`),
        })),
      )} splits=${JSON.stringify(result.splits)} anomalies=${JSON.stringify(result.anomalies)}`,
    );
    return;
  }
  eq('第一板 40 箱', p1.totalBoxes, 40);
  eq('第二板 15 箱', p2.totalBoxes, 15);
  check('第二板标记为拆分板', p2.isSplit);
  checkInvariants('超限拆分', result, 40, 5);
}

function testAllocationAnomalies(): void {
  const scan = makeScan([
    { palletCode: 'P001', barcode: 'A', qty: 10 },
    { palletCode: 'P002', barcode: 'A', qty: 4 }, // 冲突：A 在两块板
    { palletCode: 'P002', barcode: 'B', qty: 3 },
  ]);
  const order = makeOrder([
    { barcode: 'A', qty: 8 }, // 数量差异（模式一 14，货单 8）
    { barcode: 'B', qty: 3 },
    { barcode: 'Z', qty: 2 }, // 未匹配
  ]);
  const result = allocate(order, scan, { maxBoxesPerPallet: 50, boxesPerLayer: 5 });

  eq('冲突数', result.stats.conflictCount, 1);
  eq('数量差异数', result.stats.mismatchCount, 1);
  eq('未匹配数', result.stats.unmatchedCount, 1);

  const { map } = buildPalletMap(scan);
  eq('冲突条码选数量最多的板', map.get('A')!.palletCode, 'P001');
  eq('冲突条码板数', map.get('A')!.allPallets.length, 2);

  const unmatchedPallet = result.pallets.find((p) => p.palletCode === '未匹配');
  check('存在未匹配卡板', !!unmatchedPallet);
  eq('未匹配箱数', unmatchedPallet?.totalBoxes, 2);
  eq('已配箱数不含未匹配', result.stats.allocatedQty, 11);

  const types = result.anomalies.map((a) => a.type).sort();
  eq('异常类型', types, ['conflict', 'qty_mismatch', 'unmatched'].sort());
  checkInvariants('异常场景', result, 50, 5);
}

function testTieBreakByOrderIndex(): void {
  const scan = makeScan([
    { palletCode: 'P001', barcode: 'LATE', qty: 4 },
    { palletCode: 'P001', barcode: 'EARLY', qty: 4 },
  ]);
  const order = makeOrder([
    { barcode: 'EARLY', qty: 4 },
    { barcode: 'LATE', qty: 4 },
  ]);
  const result = allocate(order, scan, { maxBoxesPerPallet: 40, boxesPerLayer: 4 });
  eq('同数量按货单顺序', result.pallets[0].boxes[0].barcode, 'EARLY');
  checkInvariants('同数量平局', result, 40, 4);
}

function testPlanKeepsBarcodeContinuousAcrossLimit(): void {
  const scan = makeScan([{ palletCode: 'P001', barcode: 'A', qty: 12 }]);
  const order = makeOrder([{ barcode: 'A', qty: 12 }]);
  const plan = planAllocation(order, scan, { maxBoxesPerPallet: 5, boxesPerLayer: 2 });
  // 12 箱 / 每板 5 箱 -> 3 块板（5、5、2）
  eq('小上限拆分卡板数', plan.pallets.length, 3);
  eq('每板箱数', plan.pallets.map((p) => p.layers.reduce((s, l) => s + l.boxes.length, 0)), [5, 5, 2]);
}

/** 不能生成空卡板：刚好放满、以及剩余空间刚好等于下一堆箱数的情况 */
function testNoEmptyPallets(): void {
  // A 刚好占满一整板
  const exact = allocate(
    makeOrder([{ barcode: 'A', qty: 40 }]),
    makeScan([{ palletCode: 'P001', barcode: 'A', qty: 40 }]),
    { maxBoxesPerPallet: 40, boxesPerLayer: 5 },
  );
  eq('刚好满板时卡板数', exact.stats.palletCount, 1);
  check('刚好满板不产生空板', exact.pallets.every((p) => p.totalBoxes > 0));

  // A 用掉 30，B 刚好 10（剩余空间刚好放完）—— 历史 bug：这里会多出一个空板
  const exactFill = allocate(
    makeOrder([
      { barcode: 'A', qty: 30 },
      { barcode: 'B', qty: 10 },
    ]),
    makeScan([
      { palletCode: 'P001', barcode: 'A', qty: 30 },
      { palletCode: 'P001', barcode: 'B', qty: 10 },
    ]),
    { maxBoxesPerPallet: 40, boxesPerLayer: 5 },
  );
  eq('刚好放满时卡板数', exactFill.stats.palletCount, 1);
  eq('刚好放满时总箱数', exactFill.stats.allocatedQty, 40);
  check('没有空的卡板', exactFill.pallets.every((p) => p.totalBoxes > 0), exactFill.pallets.map((p) => p.totalBoxes));
  check('没有多余的拆分记录', exactFill.splits.length === 0, exactFill.splits);

  // 三种条码，跨板时每板都要有箱子
  const mixed = allocate(
    makeOrder([
      { barcode: 'A', qty: 35 },
      { barcode: 'B', qty: 25 },
      { barcode: 'C', qty: 5 },
    ]),
    makeScan([
      { palletCode: 'P001', barcode: 'A', qty: 35 },
      { palletCode: 'P001', barcode: 'B', qty: 25 },
      { palletCode: 'P001', barcode: 'C', qty: 5 },
    ]),
    { maxBoxesPerPallet: 40, boxesPerLayer: 5 },
  );
  eq('混合场景总箱数', mixed.stats.allocatedQty, 65);
  check('混合场景无空板', mixed.pallets.every((p) => p.totalBoxes > 0), mixed.pallets.map((p) => p.totalBoxes));
  // 同一条码不能被拆到两块板（除非它自己就超过每板上限）
  for (const pallet of mixed.pallets) {
    const seen = new Set<string>();
    let last = '';
    let continuous = true;
    for (const box of pallet.boxes) {
      if (box.barcode !== last) {
        if (seen.has(box.barcode)) continuous = false;
        seen.add(box.barcode);
        last = box.barcode;
      }
    }
    check(`混合场景 ${pallet.palletCode} 同条码连续`, continuous);
  }
  // 折板不能撞号
  const codes = mixed.pallets.map((p) => p.palletCode);
  eq('卡板号不重复', codes.length, new Set(codes).size);
}

/* ------------------------------------------------------------------ */
/* 3. 备份 JSON                                                        */
/* ------------------------------------------------------------------ */

function testBackup(): void {
  const backup = buildBackup(
    [
      {
        id: 'task-1',
        name: '测试任务',
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
        status: 'scanning',
        maxBoxesPerPallet: 60,
        pallets: [
          {
            id: 'p1',
            taskId: 'task-1',
            code: 'P001',
            index: 1,
            status: 'sealed',
            createdAt: 1700000000000,
            sealedAt: 1700000001000,
            totalBoxes: 2,
            totalBarcodes: 3,
            boxes: [
              {
                id: 'box-1',
                palletId: 'p1',
                code: 'B001',
                index: 1,
                status: 'sealed',
                model: 'M-100',
                totalBarcodes: 2,
                createdAt: 1700000000000,
                sealedAt: 1700000000500,
                barcodes: [
                  { id: 'c1', code: 'A', index: 1, scannedAt: 1700000000000, seq: 0, status: 'ok' },
                  { id: 'c2', code: 'B', index: 2, scannedAt: 1700000000100, seq: 1, status: 'ok' },
                ],
              },
              {
                id: 'box-2',
                palletId: 'p1',
                code: 'B002',
                index: 2,
                status: 'scanning',
                model: 'M-200',
                totalBarcodes: 1,
                createdAt: 1700000000600,
                barcodes: [{ id: 'c3', code: 'C', index: 1, scannedAt: 1700000000600, seq: 0, status: 'manual' }],
              },
            ],
          },
        ],
      },
    ],
    { ...DEFAULT_SETTINGS, maxBoxesPerPallet: 50 },
    'task-1',
  );

  const text = JSON.stringify(backup);
  const parsed = parseBackup(text);
  eq('备份任务数', parsed.tasks.length, 1);
  eq('备份任务名', parsed.tasks[0].name, '测试任务');
  eq('备份卡板数', parsed.tasks[0].pallets.length, 1);
  eq('备份箱数', parsed.tasks[0].pallets[0].boxes.length, 2);
  eq('备份条码总数', parsed.tasks[0].pallets[0].totalBarcodes, 3);
  eq('备份箱号', parsed.tasks[0].pallets[0].boxes[0].code, 'B001');
  eq('备份箱型号', parsed.tasks[0].pallets[0].boxes[0].model, 'M-100');
  eq('备份条码', parsed.tasks[0].pallets[0].boxes[0].barcodes[0].code, 'A');
  eq('备份手工标记保留', parsed.tasks[0].pallets[0].boxes[1].barcodes[0].status, 'manual');
  eq('备份设置', parsed.settings.maxBoxesPerPallet, 50);
  check('新格式备份不标记为旧版', parsed.legacy === false);

  // 兼容旧格式（只有任务数组 / 没有箱子层）
  const legacy = parseBackup(
    JSON.stringify({
      tasks: [
        {
          id: 'legacy',
          name: '旧任务',
          pallets: [{ code: 'P001', boxes: [{ barcode: 'X', qty: 1, model: 'M-1', scanIndex: 1 }] }],
        },
      ],
    }),
  );
  eq('旧格式任务数', legacy.tasks.length, 1);
  check('旧格式被识别出来', legacy.legacy === true);
  eq('旧格式默认上限（60）', legacy.tasks[0].maxBoxesPerPallet, 60);
  eq('旧格式按型号整理成 1 箱', legacy.tasks[0].pallets[0].boxes.length, 1);
  eq('旧格式箱内条码', legacy.tasks[0].pallets[0].boxes[0].barcodes[0].code, 'X');
  eq('旧格式箱数重算', legacy.tasks[0].pallets[0].totalBoxes, 1);

  let threw = false;
  try {
    parseBackup('{ not json');
  } catch {
    threw = true;
  }
  check('非法 JSON 抛错', threw);
}

/* ------------------------------------------------------------------ */

export function runAll(): { passed: number; failures: string[] } {
  testExcelHelpers();
  testAllocationNormal();
  testAllocationOverflow();
  testAllocationAnomalies();
  testTieBreakByOrderIndex();
  testPlanKeepsBarcodeContinuousAcrossLimit();
  testNoEmptyPallets();
  testBackup();
  return { passed, failures };
}
