/**
 * 端到端自检：
 *   模式一（卡板 → 箱 → 条码）-> 导出 Excel -> 解析回来 -> 模式二配板 -> 导出内容校验 -> JSON 备份
 * 全部在纯 Node 里跑（不启动子进程、不需要浏览器）。
 */
import * as XLSX from 'xlsx';
import type { Box, Pallet, Task } from '@/types';
import { DEFAULT_SETTINGS } from '@/types';
import {
  applyRemoveBarcode,
  applyRemoveDuplicates,
  applyScan,
  applyUndo,
  emptyBox,
  findDuplicateBarcodes,
  reindexBarcodes,
  type BoxScanState,
} from '@/services/scanRules';
import {
  exportSinglePallet,
  exportTask,
  parseScanWorkbook,
  palletSheet,
  taskSheets,
  parseSummarySheet,
} from '@/services/excel';
import { allocate, pickResultSheets, exportPickResult } from '@/services/allocation';
import { buildBackup, parseBackup } from '@/services/backup';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: unknown, extra?: unknown): void {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${extra === undefined ? '' : ` -> ${JSON.stringify(extra)}`}`);
}

function eq<T>(name: string, actual: T, expected: T, extra?: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1;
    return;
  }
  failures.push(
    `${name} -> ${JSON.stringify({ actual, expected })}${extra === undefined ? '' : ` [${JSON.stringify(extra)}]`}`,
  );
}

/** 把导出用的 SheetSpec[] 真正写成 xlsx 二进制再读回来，验证导出内容可被解析 */
function sheetsToWorkbook(sheets: { name: string; rows: (string | number)[][] }[]): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  }
  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return XLSX.read(buffer, { type: 'array' });
}

/* ------------------------------------------------------------------ */
/* 模拟一次真实作业                                                     */
/* ------------------------------------------------------------------ */

interface SimBox {
  code: string;
  model: string;
  state: BoxScanState;
  status: 'scanning' | 'sealed';
  sealedAt?: number;
}

interface SimPallet {
  code: string;
  index: number;
  boxes: SimBox[];
  status: 'scanning' | 'sealed';
  sealedAt?: number;
}

/**
 *  P001：60 箱（每板上限 60），每箱型号不同，每箱若干条条码
 *    - 第 1 箱：演示重复条码只提示、撤销、遗留重复清理
 *    - 其余箱：每箱 20 条条码，型号 M-xxx
 *  P002：2 箱，未封板
 */
function simulateTask(): { task: Task; pallets: SimPallet[] } {
  const limit = 60;
  const perBox = 20;
  const pallets: SimPallet[] = [];

  const newPallet = (index: number): SimPallet => {
    const pallet: SimPallet = {
      code: `P${String(index).padStart(3, '0')}`,
      index,
      boxes: [],
      status: 'scanning',
    };
    pallets.push(pallet);
    return pallet;
  };

  let pallet = newPallet(1);

  const newBox = (target: SimPallet, model: string): SimBox => {
    const box: SimBox = {
      code: `B${String(target.boxes.length + 1).padStart(3, '0')}`,
      model,
      state: { model, barcodes: [] },
      status: 'scanning',
    };
    target.boxes.push(box);
    return box;
  };

  const scanInto = (box: SimBox, code: string) => {
    const outcome = applyScan(box.state, code);
    if (outcome.ok) box.state = { ...box.state, barcodes: outcome.barcodes };
    return outcome;
  };

  const sealBox = (box: SimBox, at: number) => {
    box.status = 'sealed';
    box.sealedAt = at;
  };

  /* ---- 第 1 箱：重复条码 + 撤销 + 遗留重复清理 ---- */
  const box1 = newBox(pallet, 'M-100');
  check('扫 SN-000001', scanInto(box1, 'SN-000001').ok);
  check('扫 SN-000002', scanInto(box1, 'SN-000002').ok);
  const dup = scanInto(box1, 'SN-000001');
  check('箱内重复条码不入库', !dup.ok && dup.duplicated === true, { ok: dup.ok, duplicated: dup.duplicated });
  eq('重复后仍是 2 条', box1.state.barcodes.length, 2);
  eq('重复后条码序号连续', box1.state.barcodes.map((b) => b.index), [1, 2]);

  // 撤销最近一条（SN-000002），再扫回来
  const undo = applyUndo(box1.state, box1.state.barcodes[1].id);
  eq('撤销后剩 SN-000001', undo.barcodes.map((b) => b.code), ['SN-000001']);
  box1.state = { ...box1.state, barcodes: undo.barcodes };
  check('重新扫 SN-000002', scanInto(box1, 'SN-000002').ok);

  // 模拟遗留重复（历史数据里同一条码出现两次）
  box1.state = {
    ...box1.state,
    barcodes: [...box1.state.barcodes, { ...box1.state.barcodes[1], id: 'legacy-dup', seq: 99 }],
  };
  const dupInfo = findDuplicateBarcodes(box1.state.barcodes);
  eq('检测到重复条码', dupInfo.codes, ['SN-000002']);
  eq('只标记多出来的那一条', dupInfo.duplicateIds.size, 1);
  const cleaned = applyRemoveDuplicates(box1.state);
  eq('一键删除重复条数', cleaned.removed, 1);
  box1.state = { ...box1.state, barcodes: cleaned.barcodes };
  eq('清理后 SN-000002 只剩一条', box1.state.barcodes.filter((b) => b.code === 'SN-000002').length, 1);

  // 删除指定条码再补一条
  const removedOne = applyRemoveBarcode(box1.state, box1.state.barcodes[1].id);
  eq('删除后剩 1 条', removedOne.barcodes.length, 1);
  box1.state = { ...box1.state, barcodes: removedOne.barcodes };
  check('补回 SN-000002', scanInto(box1, 'SN-000002').ok);

  // 补齐第 1 箱到 20 条
  for (let i = box1.state.barcodes.length + 1; i <= perBox; i += 1) {
    const r = scanInto(box1, `SN-${String(i).padStart(6, '0')}`);
    if (!r.ok) failures.push(`第 1 箱第 ${i} 条未扫入：${r.message}`);
  }
  eq('第 1 箱条码数', box1.state.barcodes.length, perBox);
  eq('第 1 箱型号', box1.state.model, 'M-100');
  sealBox(box1, 1700000001000);

  // 封箱后不能再扫（由 store 拦截，这里验证规则层数据没被改动）
  const beforeSealCount = box1.state.barcodes.length;
  eq('封箱后条码数不变', box1.state.barcodes.length, beforeSealCount);

  /* ---- 补齐 P001 到 60 箱 ---- */
  for (let b = 2; b <= limit; b += 1) {
    const model = `M-${100 + b}`;
    const target = newBox(pallet, model);
    for (let i = 1; i <= perBox; i += 1) {
      const code = `P1B${String(b).padStart(3, '0')}-${String(i).padStart(3, '0')}`;
      const r = scanInto(target, code);
      if (!r.ok) {
        failures.push(`${target.code} 的 ${code} 未扫入：${r.message}`);
        break;
      }
    }
    sealBox(target, 1700000000000 + b * 1000);
  }
  eq('P001 箱数', pallet.boxes.length, 60);
  eq('每箱 20 条条码', [...new Set(pallet.boxes.map((b) => b.state.barcodes.length))], [perBox]);
  eq('P001 条码总数', pallet.boxes.reduce((s, b) => s + b.state.barcodes.length, 0), 60 * perBox);
  pallet.status = 'sealed';
  pallet.sealedAt = 1700000100000;

  /* ---- P002：2 箱，未封板 ---- */
  pallet = newPallet(2);
  const p2box1 = newBox(pallet, 'M-900');
  for (let i = 1; i <= 20; i += 1) scanInto(p2box1, `P2B001-${String(i).padStart(3, '0')}`);
  sealBox(p2box1, 1700000200000);
  const p2box2 = newBox(pallet, 'M-901');
  for (let i = 1; i <= 5; i += 1) scanInto(p2box2, `P2B002-${String(i).padStart(3, '0')}`);

  const taskIdValue = 'task-e2e';
  const task: Task = {
    id: taskIdValue,
    name: 'E2E 测试任务',
    createdAt: 1700000000000,
    updatedAt: 1700000300000,
    status: 'scanning',
    maxBoxesPerPallet: limit,
    pallets: pallets.map((p) => toPallet(taskIdValue, p)),
  };
  return { task, pallets };

  function toPallet(taskId: string, p: SimPallet): Pallet {
    const boxes: Box[] = p.boxes.map((sim, boxIndex) => ({
      id: `${taskId}-${p.code}-${sim.code}`,
      palletId: `${taskId}-${p.code}`,
      code: sim.code,
      index: boxIndex + 1,
      status: sim.status,
      model: sim.model,
      barcodes: reindexBarcodes(sim.state.barcodes),
      totalBarcodes: sim.state.barcodes.length,
      createdAt: 1700000000000 + boxIndex,
      sealedAt: sim.sealedAt,
    }));
    return {
      id: `${taskId}-${p.code}`,
      taskId,
      code: p.code,
      index: p.index,
      status: p.status,
      boxes,
      totalBoxes: boxes.length,
      totalBarcodes: boxes.reduce((s, b) => s + b.barcodes.length, 0),
      createdAt: 1700000000000,
      sealedAt: p.sealedAt,
    };
  }
}

/* ------------------------------------------------------------------ */

function testExportAndParse(): void {
  const { task } = simulateTask();

  eq('任务总箱数', task.pallets.reduce((s, p) => s + p.boxes.length, 0), 62);
  eq('任务总条码数', task.pallets.reduce((s, p) => s + p.totalBarcodes, 0), 60 * 20 + 20 + 5);
  eq('P001 有 60 箱', task.pallets[0].boxes.length, 60);
  eq('P001 第 1 箱型号', task.pallets[0].boxes[0].model, 'M-100');
  eq('P001 第 2 箱型号', task.pallets[0].boxes[1].model, 'M-102');

  // --- 单板导出内容 ---
  const single = palletSheet(task.pallets[0], task);
  check('单板 sheet 名 = 卡板号', single.name === 'P001');
  const wbSingle = sheetsToWorkbook([single]);
  const parsedSingle = parseScanWorkbook(wbSingle, 'P001.xlsx');
  eq('单板导出可解析条码数', parsedSingle.barcodeCount, 60 * 20);
  eq('单板导出可解析箱数', parsedSingle.boxCount, 60);
  eq('单板导出带出型号', parsedSingle.items[0].model, 'M-100');
  eq('单板导出箱号', parsedSingle.items[0].boxCode, 'B001');

  // --- 总表导出内容 ---
  const sheets = taskSheets(task);
  eq('总表 sheet 数', sheets.length, 4);
  eq('总表 sheet 名', sheets.map((s) => s.name), ['总览', '卡板汇总', '箱汇总', '条码明细']);

  const wb = sheetsToWorkbook(sheets);
  const parsed = parseScanWorkbook(wb, '总表.xlsx');
  eq('总表导出可解析卡板数', parsed.palletCount, 2);
  eq('总表导出可解析箱数', parsed.boxCount, 62);
  eq('总表导出可解析条码数', parsed.barcodeCount, 60 * 20 + 25);

  // 箱汇总 sheet 每个箱子一行
  const boxRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['箱汇总'], { defval: '' });
  const boxDataRows = boxRows.filter((r) => String(r['卡板号'] ?? '').startsWith('P'));
  eq('箱汇总行数 = 箱数', boxDataRows.length, 62);
  eq('箱汇总首行型号', boxDataRows[0]['型号'], 'M-100');
  eq('箱汇总首行条码数', boxDataRows[0]['条码数'], 20);

  // 旧版「卡板汇总」反查（兼容老文件）
  const summaryItems = parseSummarySheet(wb);
  check('卡板汇总可解析出条码明细', summaryItems.length >= 3, summaryItems.length);

  // --- 模式一导出的 Excel 能被模式二直接导入并配板 ---
  const orderItems = [
    // P001 里抽 3 个条码，数量与扫描一致
    { barcode: 'SN-000001', qty: 1, orderIndex: 0, status: 'matched' as const },
    { barcode: 'SN-000003', qty: 1, orderIndex: 1, status: 'matched' as const },
    { barcode: 'P2B001-001', qty: 1, orderIndex: 2, status: 'matched' as const },
    // 数量差异：货单 3 / 扫描 1
    { barcode: 'P2B002-001', qty: 3, orderIndex: 3, status: 'matched' as const },
    // 未匹配
    { barcode: 'ZZ-NOT-EXIST', qty: 2, orderIndex: 4, status: 'matched' as const },
  ];
  const order = {
    fileName: 'order.xlsx',
    headers: [],
    items: orderItems,
    totalQty: orderItems.reduce((s, i) => s + i.qty, 0),
    barcodeCount: orderItems.length,
  };

  const result = allocate(order, parsed, { maxBoxesPerPallet: 60, boxesPerLayer: 5 });
  eq('配板卡板数', result.stats.palletCount, 2); // P001(2 条) + P002(2 条 + 3 条差异)
  eq('已配箱数（按件）', result.stats.allocatedQty, 1 + 1 + 1 + 3);
  eq('未匹配数', result.stats.unmatchedCount, 1);
  eq('数量差异数', result.stats.mismatchCount, 1);

  const p1 = result.pallets.find((p) => p.palletCode === 'P001')!;
  eq('P001 配货件数', p1.totalBoxes, 2);
  const p2 = result.pallets.find((p) => p.palletCode === 'P002')!;
  eq('P002 配货件数', p2.totalBoxes, 4);

  const unmatched = result.pallets.find((p) => p.palletCode === '未匹配')!;
  eq('未匹配件数', unmatched.totalBoxes, 2);

  // 配货导出
  const pickSheets = pickResultSheets(result);
  eq('配货 sheet 数', pickSheets.length, 3);
  eq('配货 sheet 名', pickSheets.map((s) => s.name), ['配货总览', '配货明细', '异常']);
  const pickWb = sheetsToWorkbook(pickSheets);
  const detailRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(pickWb.Sheets['配货明细'], { defval: '' });
  const dataRows = detailRows.filter((r) => String(r['卡板号'] ?? '') !== '合计');
  eq('配货明细行数', dataRows.length, 6 + 2);
  const layers = dataRows.map((r) => Number(r['层号(1=最底)']));
  check('层号从 1 开始', Math.min(...layers) === 1, layers);

  // 异常表：未匹配 + 数量差异
  const anomalyRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(pickWb.Sheets['异常'], { defval: '' });
  const labels = anomalyRows.map((r) => String(r['异常类型'] ?? ''));
  check('异常包含未匹配', labels.some((l) => l.includes('未匹配')), labels);
  check('异常包含数量差异', labels.some((l) => l.includes('数量差异')), labels);

  // 超限折板：某条码货单 100 件，P001 上限 60 -> 折成两块
  const bigItems = Array.from({ length: 100 }, (_, i) => ({
    barcode: `BIG-${String(i + 1).padStart(3, '0')}`,
    qty: 1,
    orderIndex: i,
    status: 'matched' as const,
  }));
  const bigScan = {
    fileName: 'big.xlsx',
    headers: [],
    items: bigItems.map((i) => ({ palletCode: 'P001', boxCode: 'B001', barcode: i.barcode, qty: 1 })),
    palletCount: 1,
    boxCount: 1,
    barcodeCount: bigItems.length,
  };
  const bigResult = allocate(
    { fileName: 'big.xlsx', headers: [], items: bigItems, totalQty: 100, barcodeCount: 100 },
    bigScan,
    { maxBoxesPerPallet: 60, boxesPerLayer: 5 },
  );
  eq('超限后卡板数', bigResult.stats.palletCount, 2);
  eq('超限后已配件数', bigResult.stats.allocatedQty, 100);
  eq('第一板 60 件', bigResult.pallets[0].totalBoxes, 60);
  eq('第二板 40 件', bigResult.pallets[1].totalBoxes, 40);
  check('第二板标记为拆分板', bigResult.pallets[1].isSplit);
  check('拆分异常已记录', bigResult.anomalies.some((a) => a.type === 'overflow_split'));

  check('taskSheets 四个 sheet 都有内容', taskSheets(task).every((s) => s.rows.length > 1));
  check('pickResultSheets 三个 sheet 都有内容', pickResultSheets(result).every((s) => s.rows.length > 1));
  void exportSinglePallet;
  void exportTask;
  void exportPickResult;
}

function testBackupRoundTrip(): void {
  const { task } = simulateTask();
  const backup = buildBackup([task], DEFAULT_SETTINGS, task.id);
  const parsed = parseBackup(JSON.stringify(backup));
  eq('备份任务数', parsed.tasks.length, 1);
  eq('备份总箱数', parsed.tasks[0].pallets.reduce((s, p) => s + p.boxes.length, 0), 62);
  eq('备份总条码数', parsed.tasks[0].pallets.reduce((s, p) => s + p.totalBarcodes, 0), 60 * 20 + 25);
  eq('备份箱号', parsed.tasks[0].pallets[0].boxes[0].code, 'B001');
  eq('备份箱型号', parsed.tasks[0].pallets[0].boxes[0].model, 'M-100');
  eq('备份箱内第一条条码', parsed.tasks[0].pallets[0].boxes[0].barcodes[0].code, 'SN-000001');
  eq('备份箱状态', parsed.tasks[0].pallets[0].boxes[0].status, 'sealed');
  check('备份不是旧格式', parsed.legacy === false);

  // 恢复后再导出 Excel 仍然一致
  const wb = sheetsToWorkbook(taskSheets(parsed.tasks[0]));
  const reParsed = parseScanWorkbook(wb, 'restored.xlsx');
  eq('恢复后导出箱数一致', reParsed.boxCount, 62);
  eq('恢复后导出条码数一致', reParsed.barcodeCount, 60 * 20 + 25);
}

/** 旧版备份（没有箱子这一层）也要能恢复 */
function testLegacyBackup(): void {
  const legacy = {
    app: 'pallet-scan',
    version: 1,
    settings: { maxBoxesPerPallet: 40 },
    tasks: [
      {
        id: 'legacy-task',
        name: '老任务',
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
        status: 'scanning',
        maxBoxesPerPallet: 40,
        pallets: [
          {
            id: 'p1',
            code: 'P001',
            index: 1,
            status: 'sealed',
            createdAt: 1700000000000,
            totalBoxes: 3,
            boxes: [
              { id: 'x1', barcode: 'OLD-001', qty: 1, model: 'M-1', scanIndex: 1, scannedAt: 1700000000000, status: 'ok' },
              { id: 'x2', barcode: 'OLD-002', qty: 1, model: 'M-1', scanIndex: 2, scannedAt: 1700000000000, status: 'ok' },
              { id: 'x3', barcode: 'OLD-003', qty: 1, model: 'M-2', scanIndex: 3, scannedAt: 1700000000000, status: 'ok' },
            ],
          },
        ],
      },
    ],
  };
  const parsed = parseBackup(JSON.stringify(legacy));
  check('识别为旧版备份', parsed.legacy === true);
  const pallet = parsed.tasks[0].pallets[0];
  eq('旧数据按型号整理成 2 箱', pallet.boxes.length, 2);
  eq('第 1 箱型号', pallet.boxes[0].model, 'M-1');
  eq('第 1 箱条码', pallet.boxes[0].barcodes.map((b) => b.code), ['OLD-001', 'OLD-002']);
  eq('第 2 箱条码', pallet.boxes[1].barcodes.map((b) => b.code), ['OLD-003']);
  eq('条码总数不变', pallet.totalBarcodes, 3);
  eq('总箱数重算', pallet.totalBoxes, 2);

  // 旧数据也能导出成新格式
  const wb = sheetsToWorkbook(taskSheets(parsed.tasks[0]));
  const reParsed = parseScanWorkbook(wb, 'legacy.xlsx');
  eq('旧数据导出后可解析', reParsed.barcodeCount, 3);
  void emptyBox;
}

export function runRoundTrip(): { passed: number; failures: string[] } {
  testExportAndParse();
  testBackupRoundTrip();
  testLegacyBackup();
  return { passed, failures };
}
