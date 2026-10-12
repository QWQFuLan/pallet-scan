import type { AppSettings, Barcode, Box, Task } from '@/types';
import { DEFAULT_SETTINGS } from '@/types';
import { now, uid } from '@/utils/format';
import { downloadBlob } from '@/services/excel';

/**
 * JSON 备份 / 恢复。备份文件包含全部任务、卡板、箱子、条码和设置，
 * 只在本机生成，不上传任何服务器。
 *
 * 兼容说明：v1 的数据结构是「卡板 → 条码」（没有箱子这一层），
 * 恢复 v1 备份时会按型号自动整理成箱子，保证老数据也能继续用。
 */

export const BACKUP_VERSION = 2;

export interface BackupFile {
  app: 'pallet-scan';
  version: number;
  exportedAt: number;
  currentTaskId?: string;
  settings: AppSettings;
  tasks: Task[];
}

export function buildBackup(tasks: Task[], settings: AppSettings, currentTaskId?: string): BackupFile {
  return {
    app: 'pallet-scan',
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    currentTaskId,
    settings,
    tasks,
  };
}

export function downloadBackup(tasks: Task[], settings: AppSettings, currentTaskId?: string): string {
  const backup = buildBackup(tasks, settings, currentTaskId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `仓库扫码分卡板_备份_${stamp}.json`;
  downloadBlob(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }), filename);
  return filename;
}

export interface ParsedBackup {
  tasks: Task[];
  settings: AppSettings;
  currentTaskId?: string;
  exportedAt?: number;
  /** 是否为旧版（没有箱子这一层）的备份 */
  legacy: boolean;
}

/** 解析并校验备份 JSON，尽量兼容手工编辑过的文件 */
export function parseBackup(text: string): ParsedBackup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的 JSON');
  }
  const data = raw as Partial<BackupFile> & { tasks?: unknown };
  const taskList = Array.isArray(data.tasks) ? data.tasks : Array.isArray(raw) ? (raw as Task[]) : null;
  if (!taskList) throw new Error('备份文件里没有 tasks 数据');

  let legacy = false;
  const tasks = taskList
    .map((item) => {
      const result = normalizeTask(item as Task);
      if (result?.legacy) legacy = true;
      return result?.task ?? null;
    })
    .filter(Boolean) as Task[];
  if (tasks.length === 0) throw new Error('备份文件里没有有效的任务');

  const settings: AppSettings = { ...DEFAULT_SETTINGS, ...((data.settings as AppSettings) ?? {}) };
  return { tasks, settings, currentTaskId: data.currentTaskId, exportedAt: data.exportedAt, legacy };
}

function normalizeBarcode(raw: Partial<Barcode>, index: number): Barcode {
  return {
    id: String(raw.id ?? uid()),
    code: String(raw.code ?? raw.id ?? '').trim(),
    index: Number(raw.index) || index + 1,
    scannedAt: Number(raw.scannedAt) || now(),
    seq: Number.isFinite(Number(raw.seq)) ? Number(raw.seq) : index,
    note: raw.note ? String(raw.note) : undefined,
    status: raw.status === 'manual' ? 'manual' : raw.status === 'sealed' ? 'sealed' : 'ok',
  };
}

/** 旧格式（v1）：一个卡板下面直接是一堆条码，没有箱子 */
interface LegacyBarcodeLike {
  id?: string;
  barcode?: string;
  code?: string;
  qty?: number;
  model?: string;
  scannedAt?: number;
  seq?: number;
  note?: string;
  status?: string;
}

function boxesFromLegacyPallet(palletId: string, rows: LegacyBarcodeLike[]): Box[] {
  // 按型号分组（旧数据里型号挂在条码上），同型号的合成一箱
  const groups = new Map<string, LegacyBarcodeLike[]>();
  for (const row of rows) {
    const model = String(row.model ?? '').trim();
    const list = groups.get(model) ?? [];
    list.push(row);
    groups.set(model, list);
  }
  const boxes: Box[] = [];
  for (const [model, list] of groups) {
    const index = boxes.length + 1;
    const barcodes = list.map((row, i) => normalizeBarcode({ ...row, code: row.barcode ?? row.code } as Partial<Barcode>, i));
    boxes.push({
      id: uid(),
      palletId,
      code: `B${String(index).padStart(3, '0')}`,
      index,
      status: 'sealed',
      model,
      barcodes,
      totalBarcodes: barcodes.length,
      createdAt: Number(list[0]?.scannedAt) || now(),
    });
  }
  return boxes;
}

function normalizeTask(task: Task): { task: Task; legacy: boolean } | null {
  if (!task || typeof task !== 'object' || !task.id) return null;
  const maxBoxes =
    Number(task.maxBoxesPerPallet) > 0 ? Number(task.maxBoxesPerPallet) : DEFAULT_SETTINGS.maxBoxesPerPallet;
  const pallets = Array.isArray(task.pallets) ? task.pallets : [];
  let legacy = false;

  const normalizedPallets = pallets.map((p) => {
    const palletId = String(p.id ?? `${task.id}-${p.code}`);
    const rawBoxes = Array.isArray(p.boxes) ? (p.boxes as unknown[]) : [];
    // v2 的箱子一定带 barcodes 数组；否则认为是没有箱子层的旧数据
    const isV2 = rawBoxes.length > 0 && rawBoxes.every((b) => Array.isArray((b as Box).barcodes));
    if (!isV2 && rawBoxes.length > 0) legacy = true;

    const boxes: Box[] = isV2
      ? (rawBoxes as Box[]).map((box, boxIndex) => {
          const barcodes = (Array.isArray(box.barcodes) ? box.barcodes : []).map((b, i) =>
            normalizeBarcode(b as Partial<Barcode>, i),
          );
          return {
            id: String(box.id ?? `${palletId}-B${boxIndex + 1}`),
            palletId,
            code: String(box.code ?? `B${String(boxIndex + 1).padStart(3, '0')}`),
            index: Number(box.index) || boxIndex + 1,
            status: box.status === 'sealed' ? 'sealed' : 'scanning',
            model: String(box.model ?? ''),
            barcodes,
            totalBarcodes: barcodes.length,
            createdAt: Number(box.createdAt) || now(),
            sealedAt: box.sealedAt ? Number(box.sealedAt) : undefined,
            note: box.note,
          };
        })
      : boxesFromLegacyPallet(palletId, rawBoxes as LegacyBarcodeLike[]);

    return {
      id: palletId,
      taskId: String(task.id),
      code: String(p.code ?? 'P000'),
      index: Number(p.index) || 1,
      status: p.status === 'sealed' ? ('sealed' as const) : ('scanning' as const),
      createdAt: Number(p.createdAt) || now(),
      sealedAt: p.sealedAt ? Number(p.sealedAt) : undefined,
      note: p.note,
      layerIndex: p.layerIndex,
      boxes,
      totalBoxes: boxes.length,
      totalBarcodes: boxes.reduce((sum, b) => sum + b.barcodes.length, 0),
    };
  });

  return {
    legacy,
    task: {
      id: String(task.id),
      name: String(task.name ?? '未命名任务'),
      createdAt: Number(task.createdAt) || now(),
      updatedAt: Number(task.updatedAt) || Number(task.createdAt) || now(),
      status: task.status === 'finished' ? 'finished' : 'scanning',
      maxBoxesPerPallet: maxBoxes,
      finishedAt: task.finishedAt ? Number(task.finishedAt) : undefined,
      __prefix: task.__prefix,
      pallets: normalizedPallets,
    },
  };
}
