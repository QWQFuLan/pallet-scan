import * as XLSX from 'xlsx';
import type { Box, ImportedOrderData, ImportedScanData, OrderItem, Pallet, Task } from '@/types';
import { formatTime } from '@/utils/format';
import { exportSheets, type Row, type SheetSpec } from '@/services/excel-export';

/**
 * Excel 导入导出（SheetJS，本地打包，无 CDN）。
 *
 * 明细表按「一物一行」导出：卡板号 / 箱号 / 箱序号 / 条码 / 序号 / 型号 / 数量 / 扫描时间
 *  - 模式一：单板 Excel（本板明细 + 汇总）、任务总 Excel（总览 / 卡板汇总 / 箱汇总 / 条码明细）
 *  - 模式二：配货总览 / 配货明细 / 异常（见 allocation.ts）
 */

export const DETAIL_HEADERS = ['卡板号', '箱号', '箱序号', '条码', '箱内序号', '型号', '数量', '扫描时间', '备注'];

function boxRows(pallet: Pallet, box: Box): Row[] {
  if (box.barcodes.length === 0) {
    return [[pallet.code, box.code, box.index, '', '', box.model ?? '', 0, '', box.note ?? '']];
  }
  return [...box.barcodes]
    .sort((a, b) => a.index - b.index)
    .map((item) => [
      pallet.code,
      box.code,
      box.index,
      item.code,
      item.index,
      box.model ?? '',
      1,
      formatTime(item.scannedAt),
      item.note ?? '',
    ]);
}

function palletDetailRows(pallet: Pallet): Row[] {
  return [...pallet.boxes]
    .sort((a, b) => a.index - b.index)
    .flatMap((box) => boxRows(pallet, box));
}

function palletSummaryLine(pallet: Pallet): string {
  const grouped = new Map<string, number>();
  for (const box of pallet.boxes) {
    for (const item of box.barcodes) grouped.set(item.code, (grouped.get(item.code) ?? 0) + 1);
  }
  return [...grouped.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, qty]) => `${code}×${qty}`)
    .join('，');
}

export function safeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|\s]+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 60) || 'export'
  );
}

/* ------------------------------------------------------------------ */
/* 模式一导出                                                          */
/* ------------------------------------------------------------------ */

/** 单卡板 Excel 内容（纯函数，便于测试） */
export function palletSheet(pallet: Pallet, task: Task): SheetSpec {
  const rows: Row[] = [DETAIL_HEADERS, ...palletDetailRows(pallet)];
  rows.push([]);
  const models = [...new Set(pallet.boxes.map((b) => b.model).filter(Boolean))];
  rows.push(['汇总', '箱数', pallet.boxes.length, '条码数', pallet.totalBarcodes, '型号数', models.length, '', '']);
  rows.push(['任务', task.name, '卡板号', pallet.code, '封板时间', formatTime(pallet.sealedAt), '', '', '']);
  if (pallet.boxes.length > task.maxBoxesPerPallet) {
    rows.push(['提示', `本板超过上限 ${task.maxBoxesPerPallet} 箱，请核对`]);
  }
  return { name: pallet.code || '卡板明细', rows, widths: [12, 10, 8, 22, 9, 18, 8, 20, 18] };
}

/** 单卡板 Excel */
export function exportSinglePallet(pallet: Pallet, task: Task): void {
  exportSheets(`${safeFileName(task.name)}_${pallet.code}_单板明细.xlsx`, [palletSheet(pallet, task)]);
}

/** 任务总 Excel 内容：总览 / 卡板汇总 / 箱汇总 / 条码明细 */
export function taskSheets(task: Task): SheetSpec[] {
  const totalBoxes = task.pallets.reduce((s, p) => s + p.boxes.length, 0);
  const totalBarcodes = task.pallets.reduce((s, p) => s + p.totalBarcodes, 0);
  const allBarcodes = new Set<string>();
  for (const p of task.pallets) for (const box of p.boxes) for (const item of box.barcodes) allBarcodes.add(item.code);
  const sealedCount = task.pallets.filter((p) => p.status === 'sealed').length;

  // Sheet1 总览
  const overview: Row[] = [
    ['项目', '内容'],
    ['任务名', task.name],
    ['任务状态', task.status === 'finished' ? '已结束' : '扫描中'],
    ['创建时间', formatTime(task.createdAt)],
    ['最后更新', formatTime(task.updatedAt)],
    ['结束时间', task.finishedAt ? formatTime(task.finishedAt) : ''],
    ['卡板数', task.pallets.length],
    ['已封板卡板数', sealedCount],
    ['总箱数', totalBoxes],
    ['总条码数', totalBarcodes],
    ['不同条码数', allBarcodes.size],
    ['每板箱数上限', task.maxBoxesPerPallet],
    [],
    ['条码', '型号', '数量', '出现卡板数'],
  ];
  const barcodeAgg = aggregateBarcodes(task);
  for (const item of barcodeAgg) overview.push([item.barcode, item.model ?? '', item.qty, item.pallets.length]);

  // Sheet2 卡板汇总
  const summary: Row[] = [
    ['卡板号', '状态', '箱数', '条码数', '不同条码数', '型号', '各条码数量明细', '创建时间', '封板时间'],
  ];
  for (const p of task.pallets) {
    const kinds = new Set<string>();
    for (const box of p.boxes) for (const item of box.barcodes) kinds.add(item.code);
    const models = [...new Set(p.boxes.map((b) => b.model).filter(Boolean))];
    summary.push([
      p.code,
      p.status === 'sealed' ? '已封板' : '扫描中',
      p.boxes.length,
      p.totalBarcodes,
      kinds.size,
      models.join('、'),
      palletSummaryLine(p),
      formatTime(p.createdAt),
      p.sealedAt ? formatTime(p.sealedAt) : '',
    ]);
  }
  summary.push([]);
  summary.push(['合计', '', totalBoxes, totalBarcodes, allBarcodes.size, '', '', '', '']);

  // Sheet3 箱汇总（每个箱子一行）
  const boxSummary: Row[] = [['卡板号', '箱号', '箱序号', '型号', '条码数', '状态', '创建时间', '封箱时间', '备注']];
  for (const p of task.pallets) {
    for (const box of [...p.boxes].sort((a, b) => a.index - b.index)) {
      boxSummary.push([
        p.code,
        box.code,
        box.index,
        box.model ?? '',
        box.barcodes.length,
        box.status === 'sealed' ? '已封箱' : '扫码中',
        formatTime(box.createdAt),
        box.sealedAt ? formatTime(box.sealedAt) : '',
        box.note ?? '',
      ]);
    }
  }
  boxSummary.push([]);
  boxSummary.push(['合计', '', totalBoxes, '', totalBarcodes, '', '', '', '']);

  // Sheet4 条码明细（一物一行）
  const detail: Row[] = [DETAIL_HEADERS];
  for (const p of task.pallets) detail.push(...palletDetailRows(p));
  detail.push([]);
  detail.push(['合计', '', totalBoxes, totalBarcodes, allBarcodes.size, '', '', '', '']);

  return [
    { name: '总览', rows: overview, widths: [16, 18, 30, 14] },
    { name: '卡板汇总', rows: summary, widths: [12, 10, 8, 10, 12, 24, 60, 20, 20] },
    { name: '箱汇总', rows: boxSummary, widths: [12, 10, 8, 18, 9, 10, 20, 20, 18] },
    { name: '条码明细', rows: detail, widths: [12, 10, 8, 22, 9, 18, 8, 20, 18] },
  ];
}

/** 任务总 Excel */
export function exportTask(task: Task): void {
  exportSheets(`${safeFileName(task.name)}_总表.xlsx`, taskSheets(task));
}

export interface BarcodeAgg {
  barcode: string;
  model?: string;
  qty: number;
  pallets: { palletCode: string; qty: number }[];
}

export function aggregateBarcodes(task: Task): BarcodeAgg[] {
  const map = new Map<string, BarcodeAgg>();
  for (const pallet of task.pallets) {
    for (const box of pallet.boxes) {
      for (const item of box.barcodes) {
        let entry = map.get(item.code);
        if (!entry) {
          entry = { barcode: item.code, model: box.model, qty: 0, pallets: [] };
          map.set(item.code, entry);
        }
        if (!entry.model && box.model) entry.model = box.model;
        entry.qty += 1;
        const existing = entry.pallets.find((p) => p.palletCode === pallet.code);
        if (existing) existing.qty += 1;
        else entry.pallets.push({ palletCode: pallet.code, qty: 1 });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.qty - a.qty || a.barcode.localeCompare(b.barcode));
}

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

/** 找到明细数据的结束行（遇到「合计/汇总/总计/小计」行就停止） */
export function findDataEndRow(rows: unknown[][], headerIdx: number): number {
  for (let i = headerIdx + 1; i < rows.length; i += 1) {
    const first = String(rows[i][0] ?? '').trim();
    if (/^(合计|汇总|总计|小计)/.test(first)) return i;
  }
  return rows.length;
}

/** 读成二维数组（去掉空行） */
export function sheetToRows(ws: XLSX.WorkSheet): unknown[][] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: '' });
  return rows.filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
}

export function sheetToObjects(ws: XLSX.WorkSheet): Record<string, unknown>[] {
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: true });
}

/** 找出真正的表头行（兼容标题行/说明行在前的货单） */
export function findHeaderRow(rows: unknown[][], keywords: string[], maxScan = 15): number {
  let best = 0;
  let bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, maxScan); i += 1) {
    const cells = rows[i].map((c) => normalizeHeader(c));
    const score = cells.filter((c) => c && keywords.some((k) => c.includes(k))).length;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return bestScore >= 1 ? best : 0;
}

export function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[:：*]/g, '')
    .toLowerCase();
}

const COLUMN_ALIASES: Record<string, string[]> = {
  palletCode: ['卡板号', '卡板', '板号', '托盘号', 'pallet', 'palletno', 'palletcode', '栈板号'],
  boxCode: ['箱号', '箱编码', '箱编号', '箱码', 'box', 'boxcode', 'carton'],
  boxIndex: ['箱序号', '箱次', '第几箱', '箱顺序'],
  itemIndex: ['箱内序号', '箱内顺序', '箱内编号', '序号', '顺序号', 'no', 'index', 'seq'],
  barcode: [
    '条码',
    '条形码',
    '编号',
    '物料编码',
    '物料编号',
    '货号',
    '编码',
    '序列号',
    'sn',
    'barcode',
    'sku',
    'code',
    'ean',
  ],
  model: ['型号', '规格型号', '规格', '机型', 'model', 'type', 'item'],
  qty: ['数量', '箱数', '件数', '数目', 'qty', 'quantity', 'count', 'pcs'],
  name: ['名称', '品名', '物料名称', '商品名称', '货品名称', 'name', 'product'],
  note: ['备注', '说明', 'remark', 'note', 'memo'],
  time: ['扫描时间', '时间', '扫描日期', 'date', 'time'],
};

/** 表头里出现这些词说明这一列是「统计数字」而不是条码/数量本身 */
const HEADER_NEGATIVE = ['不同条码', '条码数', '条码种数', '种条码', '合计', '汇总', '总计', '小计'];

export function buildColumnMap(headers: unknown[]): Record<string, number> {
  const map: Record<string, number> = {};
  const cells = headers.map((h) => normalizeHeader(h));
  // 先匹配条码/箱号/型号这类具体列，再匹配数量
  const fieldOrder = ['palletCode', 'boxCode', 'boxIndex', 'barcode', 'itemIndex', 'model', 'name', 'note', 'time', 'qty'];
  const taken = new Set<number>();
  const matches = (field: string, idx: number, exact: boolean): boolean => {
    const h = cells[idx];
    if (!h) return false;
    if (HEADER_NEGATIVE.some((neg) => h.includes(neg))) return false;
    const aliases = (COLUMN_ALIASES[field] ?? []).map((a) => normalizeHeader(a));
    return exact ? aliases.includes(h) : aliases.some((a) => h.includes(a));
  };

  // 第一轮：只认完全相同的表头，避免「箱序号」被「序号」抢走
  for (const exact of [true, false]) {
    for (const field of fieldOrder) {
      if (map[field] !== undefined) continue;
      for (let idx = 0; idx < cells.length; idx += 1) {
        if (taken.has(idx)) continue;
        if (matches(field, idx, exact)) {
          map[field] = idx;
          taken.add(idx);
          break;
        }
      }
    }
  }
  return map;
}

/** 数量解析：文本里的第一个数字，四舍五入 */
export function parseQty(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const matched = String(value ?? '').match(/-?\d+(\.\d+)?/);
  if (!matched) return 0;
  const num = Number(matched[0]);
  return Number.isFinite(num) ? Math.max(0, Math.round(num)) : 0;
}

/** 卡板号标准化：1 / 001 / p1 -> P001 */
export function normalizePalletCode(raw: unknown, fallbackIndex = 0): string {
  const text = String(raw ?? '').trim();
  if (!text) return `P${String(fallbackIndex).padStart(3, '0')}`;
  const match = text.match(/^([A-Za-z]*)[-_ ]?(\d+)(?:[-_/](\d+))?$/);
  if (match) {
    const prefix = (match[1] || 'P').toUpperCase();
    const main = String(Number(match[2])).padStart(3, '0');
    const sub = match[3] ? `-${Number(match[3])}` : '';
    return `${prefix}${main}${sub}`;
  }
  return text.toUpperCase();
}

/** 箱号标准化：1 / B1 / b001 -> B001 */
export function normalizeBoxCode(raw: unknown, fallbackIndex = 0): string {
  const text = String(raw ?? '').trim();
  if (!text) return `B${String(fallbackIndex).padStart(3, '0')}`;
  const match = text.match(/^([A-Za-z]*)[-_ ]?(\d+)$/);
  if (match) {
    const prefix = (match[1] || 'B').toUpperCase();
    return `${prefix}${String(Number(match[2])).padStart(3, '0')}`;
  }
  return text.toUpperCase();
}

export async function readWorkbookFile(file: File): Promise<XLSX.WorkBook> {
  const buffer = await file.arrayBuffer();
  return XLSX.read(buffer, { type: 'array', cellDates: false, raw: false });
}

/** 从 xlsx 里解析「模式一条码明细」 */
export function parseScanWorkbook(wb: XLSX.WorkBook, fileName: string): ImportedScanData {
  const sheetName =
    wb.SheetNames.find((n) => normalizeHeader(n).includes('条码明细')) ??
    wb.SheetNames.find((n) => normalizeHeader(n).includes('箱明细')) ??
    wb.SheetNames.find((n) => normalizeHeader(n).includes('明细')) ??
    wb.SheetNames[0];
  const rows = sheetToRows(wb.Sheets[sheetName]);
  const headerIdx = findHeaderRow(rows, ['卡板', '箱号', '条码', '编号', '型号', '数量', '箱序']);
  const headers = (rows[headerIdx] ?? []).map((c) => String(c ?? '').trim()).filter(Boolean);
  const map = buildColumnMap(rows[headerIdx] ?? []);

  if (map.barcode === undefined) {
    throw new Error('未在文件中找到「条码/编号」列，请检查表头（需包含：卡板号、箱号、条码、型号）');
  }

  const items: ImportedScanData['items'] = [];
  const pallets = new Set<string>();
  const boxes = new Set<string>();
  const dataEnd = findDataEndRow(rows, headerIdx);
  let fallbackPallet = 'P001';
  let fallbackBox = 'B001';
  let lastBoxKey = '';

  for (let i = headerIdx + 1; i < dataEnd; i += 1) {
    const row = rows[i];
    const barcode = String(row[map.barcode] ?? '').trim();
    if (!barcode) continue;
    if (/^(合计|汇总|总计|小计)/.test(barcode)) continue;

    const palletRaw = map.palletCode !== undefined ? row[map.palletCode] : '';
    const palletCode = normalizePalletCode(palletRaw, 1) || fallbackPallet;
    if (String(palletRaw ?? '').trim()) fallbackPallet = palletCode;

    const boxRaw = map.boxCode !== undefined ? row[map.boxCode] : '';
    const boxIndexRaw = map.boxIndex !== undefined ? parseQty(row[map.boxIndex]) : 0;
    const boxCode =
      String(boxRaw ?? '').trim() !== ''
        ? normalizeBoxCode(boxRaw, boxIndexRaw || 1)
        : normalizeBoxCode('', boxIndexRaw || 1);
    const boxKey = `${palletCode}/${boxCode}`;
    if (boxKey !== lastBoxKey) lastBoxKey = boxKey;
    fallbackBox = boxCode;

    const qty = map.qty !== undefined ? parseQty(row[map.qty]) || 1 : 1;
    const model =
      map.model !== undefined
        ? String(row[map.model] ?? '').trim()
        : map.name !== undefined
          ? String(row[map.name] ?? '').trim()
          : '';
    const note = map.note !== undefined ? String(row[map.note] ?? '').trim() : '';
    const itemIndex = map.itemIndex !== undefined ? parseQty(row[map.itemIndex]) : undefined;

    pallets.add(palletCode);
    boxes.add(boxKey);
    items.push({
      palletCode,
      boxCode,
      boxIndex: boxIndexRaw || Number(boxCode.replace(/\D/g, '')) || undefined,
      itemIndex: itemIndex || undefined,
      barcode,
      model: model || undefined,
      qty,
      note: note || undefined,
    });
  }

  if (items.length === 0) {
    throw new Error('文件中没有解析到任何条码明细数据');
  }
  void fallbackBox;
  return {
    fileName,
    headers,
    items,
    palletCount: pallets.size,
    boxCount: boxes.size,
    barcodeCount: items.length,
  };
}

/** 兼容旧版「卡板汇总」sheet（各条码数量明细：条码×数量） */
export function parseSummarySheet(wb: XLSX.WorkBook): ImportedScanData['items'] {
  const name = wb.SheetNames.find((n) => normalizeHeader(n).includes('卡板汇总'));
  if (!name) return [];
  const rows = sheetToRows(wb.Sheets[name]);
  const headerIdx = findHeaderRow(rows, ['卡板', '明细', '箱数', '条码']);
  const header = rows[headerIdx] ?? [];
  const map = buildColumnMap(header);
  const codeIdx = map.palletCode ?? 0;
  const detailIdx = header.findIndex((c) => /明细/i.test(String(c ?? '')));
  const fallbackIdx = detailIdx < 0 ? header.findIndex((c) => /条码/i.test(String(c ?? ''))) : detailIdx;
  if (fallbackIdx < 0) return [];
  const out: ImportedScanData['items'] = [];
  const dataEnd = findDataEndRow(rows, headerIdx);
  for (let i = headerIdx + 1; i < dataEnd; i += 1) {
    const row = rows[i];
    const detail = String(row[fallbackIdx] ?? '');
    if (!detail || /^(合计|汇总|总计)/.test(detail)) continue;
    const code = normalizePalletCode(row[codeIdx], i);
    for (const part of detail.split(/[，,;；]/)) {
      const match = part.trim().match(/^(.*?)[×x*](\d+)$/);
      if (!match) continue;
      out.push({
        palletCode: code,
        boxCode: 'B001',
        barcode: match[1].trim(),
        qty: 1,
      });
    }
  }
  return out;
}

/** 解析货单 Excel */
export function parseOrderWorkbook(wb: XLSX.WorkBook, fileName: string): ImportedOrderData {
  const orderSheet = wb.SheetNames.find((n) => /货单|订单|配货|order/i.test(n)) ?? wb.SheetNames[0];
  const rows = sheetToRows(wb.Sheets[orderSheet]);
  const headerIdx = findHeaderRow(rows, ['编号', '条码', '型号', '数量', '编码', '货号']);
  const headers = (rows[headerIdx] ?? []).map((c) => String(c ?? '').trim()).filter(Boolean);
  const map = buildColumnMap(rows[headerIdx] ?? []);
  if (map.barcode === undefined || map.qty === undefined) {
    throw new Error('货单必须包含「条码/编号」列和「数量」列');
  }
  const items: OrderItem[] = [];
  const dataEnd = findDataEndRow(rows, headerIdx);
  for (let i = headerIdx + 1; i < dataEnd; i += 1) {
    const row = rows[i];
    const barcode = String(row[map.barcode] ?? '').trim();
    const qty = parseQty(row[map.qty]);
    if (!barcode) continue;
    if (/^(合计|汇总|总计|小计)/.test(barcode)) continue;
    if (qty <= 0) continue;
    const modelOrName =
      map.model !== undefined
        ? String(row[map.model] ?? '').trim()
        : map.name !== undefined
          ? String(row[map.name] ?? '').trim()
          : '';
    items.push({
      barcode,
      qty,
      name: modelOrName || undefined,
      model: map.model !== undefined ? String(row[map.model] ?? '').trim() || undefined : undefined,
      remark: map.note !== undefined ? String(row[map.note] ?? '').trim() || undefined : undefined,
      orderIndex: items.length,
      status: 'matched',
    });
  }
  if (items.length === 0) {
    throw new Error('货单里没有有效的条码/数量数据');
  }
  return {
    fileName,
    headers,
    items,
    totalQty: items.reduce((s, i) => s + i.qty, 0),
    barcodeCount: new Set(items.map((i) => i.barcode)).size,
  };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 生成 Excel 模板（货单模板 / 模式一导出样例） */
export function downloadTemplates(): void {
  const orderRows: Row[] = [
    ['条码', '型号', '数量', '名称', '备注'],
    ['SN-000001', 'M-100', 1, '矿泉水 550ml', '一件一行'],
    ['SN-000002', 'M-100', 1, '矿泉水 550ml', ''],
    ['SN-000010', 'M-200', 1, '抽纸 3 层', ''],
    ['ABC-1001', 'M-300', 12, '螺丝 M6', '按箱计数示例'],
  ];

  const scanRows: Row[] = [
    DETAIL_HEADERS,
    ['P001', 'B001', 1, 'SN-000001', 1, 'M-100', 1, '2025-01-01 09:00:00', ''],
    ['P001', 'B001', 1, 'SN-000002', 2, 'M-100', 1, '2025-01-01 09:00:20', ''],
    ['P001', 'B002', 2, 'SN-000010', 1, 'M-200', 1, '2025-01-01 09:02:00', ''],
    ['P002', 'B001', 1, 'ABC-1001', 1, 'M-300', 12, '2025-01-01 09:30:00', '按箱计数'],
  ];

  const readme: Row[] = [
    ['说明', '内容'],
    ['作业结构', '卡板（50~60 箱）→ 箱子（先扫型号，约 20 条条码）→ 条码（一件物品一个条码）'],
    ['货单模板', '最少两列：条码、数量；可选：型号、名称、备注。表头行可以在前 15 行内。'],
    ['模式一导出', '使用本程序「模式一」导出的 Excel 即可，程序会自动读取「条码明细」sheet。'],
    ['条码唯一', '同一个箱子内条码不会重复；扫到重复条码只提示、不计数，可用「一键删除重复」清理。'],
    ['型号 model', '型号挂在箱子上，每加一箱都要重新扫一次型号；导出时同一箱的每行都带同一个型号。'],
    ['条码格式', '条码建议存成文本，避免 Excel 把长数字变成科学计数法（可在单元格前加英文单引号）。'],
    ['层号规则', '模式二里 layerIndex=1 为最底层；每层默认 5 箱，数量多的在底层。'],
  ];

  exportSheets('仓库扫码分卡板_模板.xlsx', [
    { name: '货单模板', rows: orderRows, widths: [22, 14, 10, 24, 20] },
    { name: '模式一导出样例', rows: scanRows, widths: [12, 10, 8, 22, 9, 18, 8, 20, 18] },
    { name: '说明', rows: readme, widths: [18, 90] },
  ]);
}
