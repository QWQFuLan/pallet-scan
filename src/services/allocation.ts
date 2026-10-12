import type {
  AllocationResult,
  Anomaly,
  BarcodePalletMap,
  ImportedOrderData,
  ImportedScanData,
  OrderItem,
  PickBox,
  PickPallet,
  SplitRecord,
} from '@/types';
import { formatTime, now } from '@/utils/format';
import { exportSheets, type Row, type SheetSpec } from '@/services/excel-export';

/**
 * 模式二：按货单配卡板（纯函数，方便单测）。
 *
 * 规则：
 *  1. 用模式一数据建立 条码 -> 主卡板 映射：出现箱数最多的卡板（并列取最早出现），并标记冲突。
 *  2. 货单每项的「数量」= 箱数，一箱一行（qty=1），便于逐箱堆放与层号计算。
 *  3. 同条码优先放在同一卡板；超过每板上限时拆到新卡板（P001-2、P001-3…），同条码保持连续。
 *  4. 卡板内排序：先按条码总箱数降序（多的在底层），并列按货单原始顺序 / 条码字典序。
 *  5. 层号：每层最多 boxesPerLayer 箱（默认 5），同层内保持条码连续性，
 *     层按数量降序从下往上排（layerIndex=1 为最底层）。
 */

export interface AllocateOptions {
  maxBoxesPerPallet: number;
  boxesPerLayer: number;
  /** 未匹配条码是否也排到卡板上（默认 true，并标红提示） */
  placeUnmatched?: boolean;
}

export interface AllocationPlan {
  pallets: {
    palletCode: string;
    /** 模式一里的原始卡板号 */
    sourcePalletCode: string;
    isSplit: boolean;
    layers: { layerIndex: number; boxes: { barcode: string; name?: string; remark?: string; orderIndex: number }[] }[];
  }[];
  anomalies: Anomaly[];
  barcodeMap: BarcodePalletMap[];
  splits: SplitRecord[];
  orderItems: (OrderItem & { name?: string; remark?: string })[];
  stats: AllocationResult['stats'];
}

interface GroupItem {
  barcode: string;
  name?: string;
  remark?: string;
  orderIndex: number;
  totalQty: number;
  sourcePalletCode: string;
}

/* ---------------- 第一步：条码 -> 主卡板 映射 ---------------- */

export function buildPalletMap(scan: ImportedScanData): {
  map: Map<string, BarcodePalletMap>;
  conflicts: BarcodePalletMap[];
} {
  const grouped = new Map<string, Map<string, { qty: number; firstSeen: number }>>();
  const firstSeenPalletOrder = new Map<string, number>();
  let cursor = 0;

  for (const item of scan.items) {
    if (!firstSeenPalletOrder.has(item.palletCode)) firstSeenPalletOrder.set(item.palletCode, cursor++);
    let perPallet = grouped.get(item.barcode);
    if (!perPallet) {
      perPallet = new Map();
      grouped.set(item.barcode, perPallet);
    }
    const entry = perPallet.get(item.palletCode);
    if (entry) entry.qty += 1;
    else perPallet.set(item.palletCode, { qty: 1, firstSeen: firstSeenPalletOrder.get(item.palletCode) ?? 0 });
  }

  const map = new Map<string, BarcodePalletMap>();
  const conflicts: BarcodePalletMap[] = [];
  for (const [barcode, perPallet] of grouped) {
    const allPallets = [...perPallet.entries()]
      .map(([palletCode, v]) => ({ palletCode, qty: v.qty, firstSeen: v.firstSeen }))
      .sort((a, b) => b.qty - a.qty || a.firstSeen - b.firstSeen);
    const winner = allPallets[0];
    const conflict = allPallets.length > 1;
    const record: BarcodePalletMap = {
      barcode,
      palletCode: winner.palletCode,
      qtyInPallet: winner.qty,
      allPallets: allPallets.map(({ palletCode, qty }) => ({ palletCode, qty })),
      conflict,
    };
    map.set(barcode, record);
    if (conflict) conflicts.push(record);
  }
  return { map, conflicts };
}

/* ---------------- 第二步：按卡板分组并排序 ---------------- */

function groupItemsByPallet(
  items: OrderItem[],
  barcodeMap: Map<string, BarcodePalletMap>,
): Map<string, GroupItem[]> {
  const byPallet = new Map<string, Map<string, GroupItem>>();
  for (const item of items) {
    const mapped = barcodeMap.get(item.barcode);
    const pallet = mapped?.palletCode ?? '未匹配';
    if (!byPallet.has(pallet)) byPallet.set(pallet, new Map());
    const groups = byPallet.get(pallet)!;
    const existing = groups.get(item.barcode);
    if (existing) {
      existing.totalQty += item.qty;
      existing.remark = existing.remark ?? item.remark;
    } else {
      groups.set(item.barcode, {
        barcode: item.barcode,
        name: item.name,
        remark: item.remark,
        orderIndex: item.orderIndex,
        totalQty: item.qty,
        sourcePalletCode: pallet,
      });
    }
  }

  const result = new Map<string, GroupItem[]>();
  for (const [pallet, groups] of byPallet) {
    result.set(
      pallet,
      [...groups.values()].sort(
        (a, b) => b.totalQty - a.totalQty || a.orderIndex - b.orderIndex || a.barcode.localeCompare(b.barcode),
      ),
    );
  }
  return result;
}

/* ---------------- 第三步：分配到卡板 + 计算层号 ---------------- */

export function planAllocation(
  order: ImportedOrderData,
  scan: ImportedScanData,
  options: AllocateOptions,
): AllocationPlan {
  const maxBoxesPerPallet = Math.max(1, Math.round(options.maxBoxesPerPallet || 50));
  const boxesPerLayer = Math.max(1, Math.round(options.boxesPerLayer || 5));
  const placeUnmatched = options.placeUnmatched !== false;

  const { map: barcodeMap, conflicts } = buildPalletMap(scan);
  const groupedByPallet = groupItemsByPallet(order.items, barcodeMap);

  // 模式一中的卡板顺序（用于输出排序）
  const sourceOrder: string[] = [];
  for (const item of scan.items) if (!sourceOrder.includes(item.palletCode)) sourceOrder.push(item.palletCode);

  const targetPallets = [...groupedByPallet.keys()].filter((code) => code !== '未匹配');
  targetPallets.sort((a, b) => {
    const ia = sourceOrder.indexOf(a);
    const ib = sourceOrder.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
  if (placeUnmatched && groupedByPallet.has('未匹配')) targetPallets.push('未匹配');

  const anomalies: Anomaly[] = [];
  const splits: SplitRecord[] = [];

  const plan: AllocationPlan['pallets'] = [];

  // 所有已被占用的卡板号（含模式一里的卡板号），保证折板时不会撞号
  const takenPalletCodes = new Set<string>([...sourceOrder, ...targetPallets]);
  let nextPalletNumber = 1;

  /** 生成一个新卡板号（从 P001 起，跳过已占用的号） */
  const allocPalletCode = (): string => {
    let code = `P${String(nextPalletNumber).padStart(3, '0')}`;
    while (takenPalletCodes.has(code)) {
      nextPalletNumber += 1;
      code = `P${String(nextPalletNumber).padStart(3, '0')}`;
    }
    takenPalletCodes.add(code);
    nextPalletNumber += 1;
    return code;
  };

  for (const target of targetPallets) {
    const groups = groupedByPallet.get(target) ?? [];
    const palletLabel = target === '未匹配' ? '未匹配' : target;

    // 当前正在填充的卡板
    let current: AllocationPlan['pallets'][number] = {
      palletCode: palletLabel,
      sourcePalletCode: target,
      isSplit: false,
      layers: [],
    };
    plan.push(current);
    let used = 0;
    let layerCursor = 1;
    let layerUsed = 0;

    /** 在当前卡板末尾追加一箱；一层的箱数满了就自动开新层 */
    const pushBox = (item: GroupItem) => {
      let layer = current.layers[current.layers.length - 1];
      if (!layer || layerUsed >= boxesPerLayer) {
        layer = { layerIndex: layerCursor++, boxes: [] };
        current.layers.push(layer);
        layerUsed = 0;
      }
      layer.boxes.push({
        barcode: item.barcode,
        name: item.name,
        remark: target === '未匹配' ? '未匹配：模式一中没有该条码' : item.remark,
        orderIndex: item.orderIndex,
      });
      layerUsed += 1;
      used += 1;
    };

    /**
     * 折一个新卡板并把这批箱子放进去（同条码连续）。
     * 规则：某个条码的整堆在当前卡板里放不下时，先折新板保证它整堆连续；
     * 新板一次最多放「每板上限」箱，超出部分由调用方继续循环折板。
     * 返回实际放下的箱数。
     */
    const overflowToNewPallet = (item: GroupItem, remaining: number): number => {
      const from = current.palletCode;
      current = {
        palletCode: allocPalletCode(),
        sourcePalletCode: target,
        isSplit: true,
        layers: [],
      };
      plan.push(current);
      used = 0;
      layerCursor = 1;
      layerUsed = 0;
      const moved = Math.min(remaining, maxBoxesPerPallet);
      for (let i = 0; i < moved; i += 1) pushBox(item);
      splits.push({
        from,
        to: current.palletCode,
        movedQty: moved,
        detail: `${from} 放不下 ${item.barcode} 的 ${remaining} 箱（每板上限 ${maxBoxesPerPallet} 箱），其中 ${moved} 箱拆到 ${current.palletCode}`,
      });
      anomalies.push({
        type: 'overflow_split',
        barcode: item.barcode,
        name: item.name,
        palletCode: current.palletCode,
        detail: `条码 ${item.barcode} 共 ${item.totalQty} 箱，${from} 装不下，拆到 ${current.palletCode}${
          remaining > maxBoxesPerPallet ? '（该条码超过每板上限，后续还会继续折板）' : ''
        }`,
      });
      return moved;
    };

    for (const group of groups) {
      if (target === '未匹配') {
        if (!placeUnmatched) continue;
        for (let i = 0; i < group.totalQty; i += 1) pushBox(group);
        continue;
      }

      let remaining = group.totalQty;
      for (let guard = 0; remaining > 0 && guard < 10000; guard += 1) {
        const free = maxBoxesPerPallet - used;
        // 放得下就整堆连续放下（同一卡板内不拆开）
        if (free >= remaining) {
          for (let i = 0; i < remaining; i += 1) pushBox(group);
          remaining = 0;
          break;
        }
        // 放不下：先用满当前卡板剩余空间，再折新板保证整堆连续
        for (let i = 0; i < free; i += 1) pushBox(group);
        remaining -= free;
        remaining -= overflowToNewPallet(group, remaining);
      }
      if (remaining > 0) {
        anomalies.push({
          type: 'overflow_split',
          barcode: group.barcode,
          name: group.name,
          detail: `条码 ${group.barcode} 还有 ${remaining} 箱无法放置，请检查每板上限设置`,
        });
      }
    }
  }

  /* ---------------- 异常：未匹配 / 数量差异 / 冲突 ---------------- */

  const sourceQtyMap = new Map<string, number>();
  for (const item of scan.items) sourceQtyMap.set(item.barcode, (sourceQtyMap.get(item.barcode) ?? 0) + (item.qty || 1));

  const orderItems: AllocationPlan['orderItems'] = order.items.map((item) => {
    const mapped = barcodeMap.get(item.barcode);
    const sourceQty = sourceQtyMap.get(item.barcode);
    const status: OrderItem['status'] = !mapped ? 'unmatched' : sourceQty !== undefined && sourceQty !== item.qty ? 'qty_mismatch' : 'matched';
    return {
      ...item,
      matchedPalletCode: mapped?.palletCode,
      sourceQty,
      status,
    };
  });

  for (const item of orderItems) {
    if (item.status === 'unmatched') {
      anomalies.push({
        type: 'unmatched',
        barcode: item.barcode,
        name: item.name,
        palletCode: '未匹配',
        detail: `货单条码 ${item.barcode} 在模式一数据中不存在，已单独堆放，请人工指定卡板`,
        orderQty: item.qty,
      });
    } else if (item.status === 'qty_mismatch') {
      anomalies.push({
        type: 'qty_mismatch',
        barcode: item.barcode,
        name: item.name,
        palletCode: item.matchedPalletCode,
        detail: `数量差异：货单 ${item.qty} 箱，模式一 ${item.sourceQty ?? 0} 箱（按货单数量配货）`,
        orderQty: item.qty,
        sourceQty: item.sourceQty,
      });
    }
  }

  for (const conflict of conflicts) {
    anomalies.push({
      type: 'conflict',
      barcode: conflict.barcode,
      palletCode: conflict.palletCode,
      detail: `同条码出现在多个卡板：${conflict.allPallets
        .map((p) => `${p.palletCode}(${p.qty}箱)`)
        .join('、')}，默认归入 ${conflict.palletCode}`,
    });
  }

  // 未匹配的箱也提示（含未匹配卡板里的条码）
  for (const pallet of plan) {
    if (pallet.palletCode !== '未匹配') continue;
    for (const layer of pallet.layers) {
      for (const b of layer.boxes) {
        if (!anomalies.some((a) => a.type === 'unmatched' && a.barcode === b.barcode)) {
          anomalies.push({
            type: 'unmatched',
            barcode: b.barcode,
            palletCode: '未匹配',
            detail: `货单条码 ${b.barcode} 未在模式一中匹配到卡板`,
            orderQty: 1,
          });
        }
      }
    }
  }

  const allocatedQty = plan
    .filter((p) => p.palletCode !== '未匹配')
    .reduce((sum, p) => sum + p.layers.reduce((s, l) => s + l.boxes.length, 0), 0);

  const stats: AllocationResult['stats'] = {
    orderTotalQty: order.totalQty,
    allocatedQty,
    palletCount: plan.filter((p) => p.palletCode !== '未匹配').length,
    splitPalletCount: plan.filter((p) => p.isSplit).length,
    unmatchedCount: orderItems.filter((i) => i.status === 'unmatched').length,
    mismatchCount: orderItems.filter((i) => i.status === 'qty_mismatch').length,
    conflictCount: conflicts.length,
  };

  return { pallets: plan, anomalies, barcodeMap: [...barcodeMap.values()], splits, orderItems, stats };
}

/* ---------------- 第四步：展开成最终结果（含堆放顺序） ---------------- */

export function planToResult(
  plan: AllocationPlan,
  order: ImportedOrderData,
  scan: ImportedScanData,
  options: AllocateOptions,
): AllocationResult {
  const pickPallets: PickPallet[] = plan.pallets.map((pallet, idx) => {
    const boxes: PickBox[] = [];
    let stackOrder = 0;
    // 层从下往上输出：数量多的层在底层
    pallet.layers.forEach((layer) => {
      layer.boxes.forEach((b, i) => {
        stackOrder += 1;
        boxes.push({
          id: `${pallet.palletCode}-${stackOrder}`,
          palletCode: pallet.palletCode,
          stackOrder,
          layerIndex: layer.layerIndex,
          layerOrder: i + 1,
          barcode: b.barcode,
          qty: 1,
          name: b.name,
          remark: b.remark,
          palletBoxLimit: Math.max(1, Math.round(options.maxBoxesPerPallet)),
          overflowFrom: pallet.isSplit ? pallet.sourcePalletCode : undefined,
        });
      });
    });
    const kinds = new Set(boxes.map((b) => b.barcode)).size;
    return {
      palletCode: pallet.palletCode,
      index: idx + 1,
      totalBoxes: boxes.length,
      barcodeKinds: kinds,
      layerCount: pallet.layers.length,
      boxes,
      layerSummary: pallet.layers.map((layer) => {
        const counter = new Map<string, number>();
        for (const b of layer.boxes) counter.set(b.barcode, (counter.get(b.barcode) ?? 0) + 1);
        const label = [...counter.entries()].map(([code, qty]) => `${code}×${qty}`).join('，');
        return { layerIndex: layer.layerIndex, label };
      }),
      isSplit: pallet.isSplit,
      overflowFrom: pallet.isSplit ? pallet.sourcePalletCode : undefined,
      sourcePalletCode: pallet.sourcePalletCode,
    };
  });

  return {
    createdAt: now(),
    orderFileName: order.fileName,
    scanFileName: scan.fileName,
    maxBoxesPerPallet: Math.max(1, Math.round(options.maxBoxesPerPallet)),
    boxesPerLayer: Math.max(1, Math.round(options.boxesPerLayer)),
    pallets: pickPallets,
    anomalies: plan.anomalies,
    barcodeMap: plan.barcodeMap,
    splits: plan.splits,
    stats: plan.stats,
  };
}

export function allocate(
  order: ImportedOrderData,
  scan: ImportedScanData,
  options: AllocateOptions,
): AllocationResult {
  const plan = planAllocation(order, scan, options);
  return planToResult(plan, order, scan, options);
}

/** 卡板校验：超过上限的卡板（正常情况下不会出现，作为兜底提示） */
export function findOverLimitPallets(result: AllocationResult): PickPallet[] {
  return result.pallets.filter((p) => {
    if (p.palletCode === '未匹配') return false;
    const limit = p.boxes[0]?.palletBoxLimit ?? result.maxBoxesPerPallet;
    return p.totalBoxes > limit;
  });
}

export function describeResult(result: AllocationResult): string {
  const s = result.stats;
  return `卡板 ${s.palletCount} 个，已配 ${s.allocatedQty}/${s.orderTotalQty} 箱，拆分 ${s.splitPalletCount} 板，未匹配 ${s.unmatchedCount} 项，数量差异 ${s.mismatchCount} 项，条码冲突 ${s.conflictCount} 项（${formatTime(
    result.createdAt,
  )}）`;
}

/* ---------------- 导出配货 Excel ---------------- */

const ANOMALY_LABEL: Record<Anomaly['type'], string> = {
  unmatched: '未匹配（红）',
  qty_mismatch: '数量差异（黄）',
  conflict: '条码冲突（黄）',
  overflow_split: '超限拆分（橙）',
  same_barcode_multi_pallet: '同条码多卡板（黄）',
};

export function pickResultSheets(result: AllocationResult): SheetSpec[] {
  // Sheet1 配货总览
  const overview: Row[] = [
    ['配货总览', ''],
    ['生成时间', formatTime(result.createdAt)],
    ['货单文件', result.orderFileName],
    ['模式一文件', result.scanFileName],
    ['每板上限', result.maxBoxesPerPallet],
    ['每层箱数', result.boxesPerLayer],
    ['货单总箱数', result.stats.orderTotalQty],
    ['已配箱数', result.stats.allocatedQty],
    ['卡板数', result.stats.palletCount],
    ['拆分卡板数', result.stats.splitPalletCount],
    ['未匹配条码数', result.stats.unmatchedCount],
    ['数量差异条码数', result.stats.mismatchCount],
    ['条码冲突数', result.stats.conflictCount],
    [],
    ['卡板号', '总箱数', '条码种数', '层数', '底层→顶层 条码顺序摘要', '是否拆分', '来源卡板'],
  ];
  overview.push(...result.pallets.map((p) => [
    p.palletCode,
    p.totalBoxes,
    p.barcodeKinds,
    p.layerCount,
    p.layerSummary.map((l) => `第${l.layerIndex}层: ${l.label}`).join(' | '),
    p.isSplit ? '是' : '',
    p.isSplit ? p.sourcePalletCode : '',
  ] as Row));

  // Sheet2 配货明细
  const detail: Row[] = [['卡板号', '堆放顺序', '层号(1=最底)', '层内顺序', '条码', '数量', '名称', '备注']];
  const palletsSorted = [...result.pallets].sort((a, b) => a.index - b.index);
  for (const p of palletsSorted) {
    for (const b of p.boxes) {
      detail.push([
        p.palletCode,
        b.stackOrder,
        b.layerIndex,
        b.layerOrder,
        b.barcode,
        b.qty,
        b.name ?? '',
        b.remark ?? '',
      ]);
    }
  }
  detail.push([]);
  detail.push([
    '合计',
    result.stats.allocatedQty,
    '',
    '',
    `${result.stats.palletCount} 板`,
    '',
    '',
    '',
  ]);

  // Sheet3 异常
  const anomalyRows: Row[] = [
    ['异常类型', '条码', '名称', '卡板号', '货单数量', '模式一数量', '说明'],
  ];
  for (const a of result.anomalies) {
    anomalyRows.push([
      ANOMALY_LABEL[a.type] ?? a.type,
      a.barcode,
      a.name ?? '',
      a.palletCode ?? '',
      a.orderQty ?? '',
      a.sourceQty ?? '',
      a.detail,
    ]);
  }
  if (result.anomalies.length === 0) anomalyRows.push(['无异常', '', '', '', '', '', '全部条码均已匹配且数量一致']);
  const limitRows: Row[] = [[], ['卡板超限拆分记录'], ['原卡板', '新卡板', '涉及箱数', '说明']];
  for (const s of result.splits) limitRows.push([s.from, s.to, s.movedQty, s.detail]);
  if (result.splits.length === 0) limitRows.push(['', '', '', '没有超限拆分']);
  anomalyRows.push(...limitRows);

  return [
    { name: '配货总览', rows: overview, widths: [16, 14, 12, 8, 80, 10, 12] },
    { name: '配货明细', rows: detail, widths: [14, 10, 12, 10, 24, 8, 20, 26] },
    { name: '异常', rows: anomalyRows, widths: [18, 22, 18, 14, 12, 12, 60] },
  ];
}

export function exportPickResult(result: AllocationResult, taskName?: string): void {
  const stamp = new Date(result.createdAt).toLocaleString('zh-CN').replace(/[/:]/g, '-');
  const title = taskName ? `${taskName}_` : '';
  exportSheets(`${title}配货结果_${stamp}.xlsx`, pickResultSheets(result));
}
