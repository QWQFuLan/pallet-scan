import type { Barcode, Box, ScanStatus } from '@/types';
import { now, uid } from '@/utils/format';

/**
 * 模式一的扫码业务规则（纯函数，便于单测；store 只负责落地状态与持久化）。
 *
 * 现场作业（按确认的流程）：
 *  卡板 → 箱 → 条码
 *  - 一板 50~60 箱，一箱大约 20 条条码；
 *  - 先「加箱子」：弹窗里扫/输这一箱的**型号**，确认后开始扫条码（每箱都要重新扫型号）；
 *  - 一箱一个型号，箱内条码**唯一**（一件物品一个条码）；
 *  - 扫到重复条码：数量不 +1，只提示「条码重复」，扫完可一键删除重复；
 *  - 先**封箱**（这一箱扫完），再**封板**（整板装满）。
 */

export interface BoxScanState {
  model: string;
  barcodes: Barcode[];
}

export interface ScanOutcome {
  ok: boolean;
  /** 条码重复（箱内已存在） */
  duplicated: boolean;
  message: string;
  /** 变更后的条码列表 */
  barcodes: Barcode[];
  /** 当前箱条码数 */
  total: number;
  /** 受影响的条码 id */
  barcodeId?: string;
  index?: number;
  existing?: Barcode;
}

/* ---------------- 条码的基本操作 ---------------- */

/** 排序：箱内序号 -> 内部顺序号（两个字段都稳定，不会来回抖动） */
function compareBarcodes(a: Barcode, b: Barcode): number {
  return a.index - b.index || a.seq - b.seq;
}

/** 重新编号（1 起，连续） */
export function reindexBarcodes(barcodes: Barcode[]): Barcode[] {
  return [...barcodes].sort(compareBarcodes).map((item, i) => ({ ...item, index: i + 1, seq: i }));
}

function appendBarcode(barcodes: Barcode[], item: Barcode): Barcode[] {
  return reindexBarcodes([...barcodes, { ...item, seq: Number.MAX_SAFE_INTEGER }]);
}

/** 最近扫的那一条 */
export function latestBarcode(barcodes: Barcode[]): Barcode | undefined {
  return barcodes.reduce<Barcode | undefined>((latest, item) => {
    if (!latest) return item;
    return item.seq >= latest.seq ? item : latest;
  }, undefined);
}

/** 找出箱内重复的条码（同一 code 出现多条，保留最早一条，其余视为重复） */
export function findDuplicateBarcodes(barcodes: Barcode[]): { duplicateIds: Set<string>; codes: string[] } {
  const firstSeen = new Map<string, Barcode>();
  const duplicateIds = new Set<string>();
  const codes = new Set<string>();
  for (const item of [...barcodes].sort(compareBarcodes)) {
    if (!firstSeen.has(item.code)) {
      firstSeen.set(item.code, item);
      continue;
    }
    duplicateIds.add(item.id);
    codes.add(item.code);
  }
  return { duplicateIds, codes: [...codes] };
}

/* ---------------- 扫码 / 撤销 / 删除 ---------------- */

/** 扫一条条码：箱内唯一，重复只提示 */
export function applyScan(
  state: BoxScanState,
  rawCode: string,
  options: { manual?: boolean; at?: number } = {},
): ScanOutcome {
  const code = (rawCode ?? '').trim();
  const timestamp = options.at ?? now();
  const current = state.barcodes.length;

  if (!code) {
    return { ok: false, duplicated: false, message: '条码为空', barcodes: state.barcodes, total: current };
  }

  const existing = state.barcodes.find((b) => b.code === code);
  if (existing) {
    return {
      ok: false,
      duplicated: true,
      message: `条码重复：${code} 本箱已有（第 ${existing.index} 条），不加 1`,
      barcodes: state.barcodes,
      total: current,
      barcodeId: existing.id,
      index: existing.index,
      existing,
    };
  }

  const status: ScanStatus = options.manual ? 'manual' : 'ok';
  const item: Barcode = {
    id: uid(),
    code,
    index: current + 1,
    scannedAt: timestamp,
    seq: -1,
    status,
  };
  const barcodes = appendBarcode(state.barcodes, item);
  const stored = barcodes.find((b) => b.id === item.id) ?? item;
  return {
    ok: true,
    duplicated: false,
    message: `${code} 已记录（本箱第 ${stored.index} 条）`,
    barcodes,
    total: barcodes.length,
    barcodeId: stored.id,
    index: stored.index,
  };
}

/** 撤销最近扫的一条 */
export function applyUndo(state: BoxScanState, lastTouchedId?: string): ScanOutcome {
  if (state.barcodes.length === 0) {
    return { ok: false, duplicated: false, message: '本箱还没有条码', barcodes: state.barcodes, total: 0 };
  }
  const touched = lastTouchedId ? state.barcodes.find((b) => b.id === lastTouchedId) : undefined;
  const last = touched ?? latestBarcode(state.barcodes)!;
  const barcodes = reindexBarcodes(state.barcodes.filter((b) => b.id !== last.id));
  return {
    ok: true,
    duplicated: false,
    message: `已撤销：${last.code}`,
    barcodes,
    total: barcodes.length,
  };
}

/** 删除指定条码 */
export function applyRemoveBarcode(state: BoxScanState, barcodeId: string): ScanOutcome {
  const found = state.barcodes.find((b) => b.id === barcodeId);
  if (!found) {
    return {
      ok: false,
      duplicated: false,
      message: '找不到该条码',
      barcodes: state.barcodes,
      total: state.barcodes.length,
    };
  }
  const barcodes = reindexBarcodes(state.barcodes.filter((b) => b.id !== barcodeId));
  return {
    ok: true,
    duplicated: false,
    message: `已删除 ${found.code}`,
    barcodes,
    total: barcodes.length,
  };
}

/** 一键删除本箱重复条码（每个条码保留最早一条） */
export function applyRemoveDuplicates(state: BoxScanState): ScanOutcome & { removed: number } {
  const { duplicateIds, codes } = findDuplicateBarcodes(state.barcodes);
  if (duplicateIds.size === 0) {
    return {
      ok: false,
      duplicated: false,
      removed: 0,
      message: '本箱没有重复条码',
      barcodes: state.barcodes,
      total: state.barcodes.length,
    };
  }
  const barcodes = reindexBarcodes(state.barcodes.filter((b) => !duplicateIds.has(b.id)));
  return {
    ok: true,
    duplicated: true,
    removed: duplicateIds.size,
    message: `已删除 ${duplicateIds.size} 条重复条码（${codes.slice(0, 3).join('、')}${codes.length > 3 ? '…' : ''}）`,
    barcodes,
    total: barcodes.length,
  };
}

/* ---------------- 箱 / 板的统计 ---------------- */

export function boxBarcodeCount(box: Box): number {
  return box.barcodes.length;
}

export function palletBoxCount(pallet: { boxes: Box[] }): number {
  return pallet.boxes.length;
}

export function palletBarcodeCount(pallet: { boxes: Box[] }): number {
  return pallet.boxes.reduce((sum, box) => sum + box.barcodes.length, 0);
}

export function palletModels(pallet: { boxes: Box[] }): string[] {
  return [...new Set(pallet.boxes.map((b) => b.model).filter(Boolean))];
}

export function emptyBox(palletId: string, index: number, code: string, model: string): Box {
  return {
    id: uid(),
    palletId,
    code,
    index,
    status: 'scanning',
    model: model.trim(),
    barcodes: [],
    totalBarcodes: 0,
    createdAt: now(),
  };
}
