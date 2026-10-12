import { create } from 'zustand';
import type {
  AllocationResult,
  AppSettings,
  Box,
  ImportedOrderData,
  ImportedScanData,
  Pallet,
  Task,
  TaskMeta,
} from '@/types';
import { DEFAULT_SETTINGS } from '@/types';
import { now, uid } from '@/utils/format';
import {
  applyRemoveBarcode,
  applyRemoveDuplicates,
  applyScan,
  applyUndo,
  emptyBox,
  palletBarcodeCount,
  reindexBarcodes,
} from '@/services/scanRules';
import { dbClearAll, dbDeleteTask, dbGetTask, dbListTasks, dbPutTask, kvGet, kvSet, toMeta } from '@/db';

export type TabKey = 'mode1' | 'mode2' | 'data' | 'settings';

export interface ToastItem {
  id: string;
  text: string;
  kind: 'info' | 'success' | 'warn' | 'error';
  at: number;
}

interface AppState {
  ready: boolean;
  tasks: TaskMeta[];
  task: Task | null;
  /** 当前卡板 */
  activePalletId: string | null;
  /** 当前正在扫条码的箱子 */
  activeBoxId: string | null;
  /** 扫描会话是否开启（摄像头预览 + 连扫） */
  scanning: boolean;
  settings: AppSettings;
  tab: TabKey;
  toasts: ToastItem[];
  revision: number;

  // 模式二
  mode2Order: ImportedOrderData | null;
  mode2Scan: ImportedScanData | null;
  mode2Result: AllocationResult | null;

  init(): Promise<void>;
  setTab(tab: TabKey): void;
  updateSettings(patch: Partial<AppSettings>): void;
  toast(text: string, kind?: ToastItem['kind']): void;
  dismissToast(id: string): void;

  newTask(name: string, maxBoxesPerPallet?: number): Promise<void>;
  switchTask(id: string): Promise<void>;
  removeTask(id: string): Promise<void>;
  finishTask(): Promise<void>;
  reopenTask(): Promise<void>;
  clearCurrentTask(): Promise<void>;
  clearAllData(): Promise<void>;
  renameTask(name: string): void;

  setActivePallet(palletId: string): void;
  setScanning(on: boolean): void;

  /** 加一个箱子：先给型号，确认后开始扫条码 */
  addBox(model: string, opts?: { palletId?: string }): { ok: boolean; message: string; box: Box | null };
  /** 封箱（这一箱扫完），返回结果 */
  sealBox(boxId: string): { ok: boolean; message: string; box: Box | null };
  /** 删除一个箱子 */
  removeBox(boxId: string): void;
  /** 切换当前箱（继续扫某个未封的箱） */
  setActiveBox(boxId: string): void;
  /** 修改箱的型号 */
  updateBoxModel(boxId: string, model: string): void;

  scanBarcode(code: string, opts?: { manual?: boolean }): {
    ok: boolean;
    message: string;
    duplicated: boolean;
    index: number;
    boxCode: string;
  };
  undoLastBarcode(): { ok: boolean; message: string };
  removeBarcode(barcodeId: string): void;
  /** 一键删除当前箱的重复条码 */
  removeDuplicateBarcodes(boxId?: string): { removed: number; message: string };

  sealActivePallet(): Promise<{ ok: boolean; message: string; pallet: Pallet | null }>;
  unsealPallet(palletId: string): void;
  createPallet(): Pallet | null;
  removePallet(palletId: string): void;

  setMode2Order(data: ImportedOrderData | null): void;
  setMode2Scan(data: ImportedScanData | null): void;
  setMode2Result(result: AllocationResult | null): void;
  clearMode2(): void;

  replaceAll(tasks: Task[], currentTaskId?: string): Promise<void>;
}

export { formatShortTime, formatTime, now } from '@/utils/format';
export { uid } from '@/utils/format';

function palletCode(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(3, '0')}`;
}

function boxCode(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(3, '0')}`;
}

function makePallet(task: Task, index: number): Pallet {
  return {
    id: uid(),
    taskId: task.id,
    code: palletCode(task.__prefix ?? 'P', index),
    index,
    status: 'scanning',
    boxes: [],
    totalBoxes: 0,
    totalBarcodes: 0,
    createdAt: now(),
  };
}

/** 重算卡板统计并给箱重新编号 */
function recalcPallet(pallet: Pallet, boxPrefix = 'B'): void {
  pallet.boxes = [...pallet.boxes]
    .sort((a, b) => a.index - b.index || a.createdAt - b.createdAt)
    .map((box, i) => {
      const barcodes = reindexBarcodes(box.barcodes);
      return {
        ...box,
        palletId: pallet.id,
        index: i + 1,
        code: box.code && box.code !== 'AUTO' ? box.code : boxCode(boxPrefix, i + 1),
        barcodes,
        totalBarcodes: barcodes.length,
      };
    });
  pallet.totalBoxes = pallet.boxes.length;
  pallet.totalBarcodes = palletBarcodeCount(pallet);
}

function touch(task: Task): void {
  task.updatedAt = now();
}

/** 每个箱最近一次操作的那条条码 id（撤销时优先撤销它） */
const lastTouchedBarcode = new Map<string, string>();

/** 落盘调度：按任务 id 分别防抖，写入时同步取快照 */
const pendingWrites = new Map<string, number>();

function snapshotOf(task: Task): Task {
  return JSON.parse(JSON.stringify(task)) as Task;
}

function cancelScheduledWrite(taskId: string): void {
  const timer = pendingWrites.get(taskId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    pendingWrites.delete(taskId);
  }
}

function schedulePersist(getTask: () => Task | null, immediate = false): void {
  const task = getTask();
  if (!task) return;
  const taskId = task.id;
  const snapshot = snapshotOf(task);
  cancelScheduledWrite(taskId);
  if (immediate) {
    void dbPutTask(snapshot);
    return;
  }
  pendingWrites.set(
    taskId,
    window.setTimeout(() => {
      pendingWrites.delete(taskId);
      void dbPutTask(snapshot);
    }, 250),
  );
}

/** 立即写出当前任务排队中的写入（页面隐藏/关闭前调用） */
export function flushPendingWritesNow(): void {
  const task = useStore.getState().task;
  if (!task) return;
  if (!pendingWrites.has(task.id)) return;
  cancelScheduledWrite(task.id);
  void dbPutTask(snapshotOf(task));
}

export const useStore = create<AppState>()((set, get) => {
  const persist = (immediate = false) => schedulePersist(() => get().task, immediate);
  const bump = () => set((s) => ({ revision: s.revision + 1 }));

  const refreshTaskList = async (currentTaskId?: string | null) => {
    const all = await dbListTasks();
    const id = currentTaskId ?? get().task?.id;
    const metas = all.map(toMeta);
    const current = id ? all.find((t) => t.id === id) ?? null : null;
    set({ tasks: metas, task: current });
    return current;
  };

  const activePallet = (): Pallet | null => {
    const task = get().task;
    if (!task) return null;
    return task.pallets.find((p) => p.id === get().activePalletId) ?? task.pallets[task.pallets.length - 1] ?? null;
  };

  const activeBox = (): Box | null => {
    const pallet = activePallet();
    if (!pallet) return null;
    return pallet.boxes.find((b) => b.id === get().activeBoxId) ?? pallet.boxes[pallet.boxes.length - 1] ?? null;
  };

  /** 定位某个箱子属于哪块板 */
  const findBox = (boxId: string): { pallet: Pallet; box: Box } | null => {
    const task = get().task;
    if (!task) return null;
    for (const pallet of task.pallets) {
      const box = pallet.boxes.find((b) => b.id === boxId);
      if (box) return { pallet, box };
    }
    return null;
  };

  return {
    ready: false,
    tasks: [],
    task: null,
    activePalletId: null,
    activeBoxId: null,
    scanning: false,
    settings: { ...DEFAULT_SETTINGS },
    tab: 'mode1',
    toasts: [],
    revision: 0,
    mode2Order: null,
    mode2Scan: null,
    mode2Result: null,

    async init() {
      const settings = { ...DEFAULT_SETTINGS, ...((await kvGet<AppSettings>('settings')) ?? {}) };
      const currentTaskId = (await kvGet<string>('currentTaskId')) ?? null;
      const all = await dbListTasks();
      const current = (currentTaskId ? all.find((t) => t.id === currentTaskId) : null) ?? all[0] ?? null;
      const pallet =
        current?.pallets.find((p) => p.status === 'scanning') ?? current?.pallets[current.pallets.length - 1];
      const box = pallet?.boxes.find((b) => b.status === 'scanning') ?? pallet?.boxes[pallet.boxes.length - 1];
      set({
        ready: true,
        settings,
        tasks: all.map(toMeta),
        task: current,
        activePalletId: pallet?.id ?? null,
        activeBoxId: box?.id ?? null,
      });
    },

    setTab: (tab) => set({ tab }),

    updateSettings(patch) {
      const settings = { ...get().settings, ...patch };
      set({ settings });
      void kvSet('settings', settings);
      const task = get().task;
      if (task && patch.maxBoxesPerPallet && patch.maxBoxesPerPallet !== task.maxBoxesPerPallet) {
        task.maxBoxesPerPallet = patch.maxBoxesPerPallet;
        touch(task);
        persist(true);
        bump();
      }
    },

    toast(text, kind = 'info') {
      const item: ToastItem = { id: uid(), text, kind, at: now() };
      set((s) => ({ toasts: [...s.toasts.slice(-3), item] }));
      window.setTimeout(() => get().dismissToast(item.id), kind === 'error' ? 4200 : 2600);
    },

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },

    async newTask(name, maxBoxesPerPallet) {
      const limit = maxBoxesPerPallet ?? get().settings.maxBoxesPerPallet;
      const task: Task = {
        id: uid(),
        name: name.trim() || `任务 ${new Date().toLocaleString('zh-CN')}`,
        createdAt: now(),
        updatedAt: now(),
        status: 'scanning',
        maxBoxesPerPallet: limit,
        pallets: [],
      };
      task.__prefix = get().settings.palletCodePrefix || 'P';
      const first = makePallet(task, 1);
      task.pallets.push(first);
      await dbPutTask(snapshotOf(task));
      await kvSet('currentTaskId', task.id);
      set({ task, activePalletId: first.id, activeBoxId: null, scanning: false, tab: 'mode1' });
      await refreshTaskList(task.id);
      bump();
    },

    async switchTask(id) {
      const task = await dbGetTask(id);
      if (!task) return;
      await kvSet('currentTaskId', id);
      const pallet =
        task.pallets.find((p) => p.status === 'scanning') ?? task.pallets[task.pallets.length - 1];
      const box = pallet?.boxes.find((b) => b.status === 'scanning') ?? pallet?.boxes[pallet.boxes.length - 1];
      set({
        task,
        activePalletId: pallet?.id ?? null,
        activeBoxId: box?.id ?? null,
        scanning: false,
      });
      bump();
    },

    async removeTask(id) {
      cancelScheduledWrite(id);
      await dbDeleteTask(id);
      const remaining = await dbListTasks();
      const next = remaining[0] ?? null;
      await kvSet('currentTaskId', next?.id ?? '');
      const pallet = next?.pallets[next.pallets.length - 1];
      set({
        tasks: remaining.map(toMeta),
        task: next,
        activePalletId: pallet?.id ?? null,
        activeBoxId: pallet?.boxes[pallet.boxes.length - 1]?.id ?? null,
        scanning: false,
      });
      bump();
    },

    async finishTask() {
      const task = get().task;
      if (!task) return;
      task.status = 'finished';
      task.finishedAt = now();
      touch(task);
      cancelScheduledWrite(task.id);
      await dbPutTask(snapshotOf(task));
      set({ scanning: false });
      await refreshTaskList(task.id);
      bump();
    },

    async reopenTask() {
      const task = get().task;
      if (!task) return;
      task.status = 'scanning';
      delete task.finishedAt;
      touch(task);
      cancelScheduledWrite(task.id);
      await dbPutTask(snapshotOf(task));
      await refreshTaskList(task.id);
      bump();
    },

    async clearCurrentTask() {
      const task = get().task;
      if (!task) return;
      task.pallets = [];
      task.status = 'scanning';
      delete task.finishedAt;
      touch(task);
      const first = makePallet(task, 1);
      task.pallets.push(first);
      lastTouchedBarcode.clear();
      cancelScheduledWrite(task.id);
      await dbPutTask(snapshotOf(task));
      set({ activePalletId: first.id, activeBoxId: null, scanning: false });
      await refreshTaskList(task.id);
      bump();
    },

    async clearAllData() {
      pendingWrites.forEach((timer) => window.clearTimeout(timer));
      pendingWrites.clear();
      lastTouchedBarcode.clear();
      await dbClearAll();
      set({
        tasks: [],
        task: null,
        activePalletId: null,
        activeBoxId: null,
        scanning: false,
        mode2Order: null,
        mode2Scan: null,
        mode2Result: null,
      });
      bump();
    },

    renameTask(name) {
      const task = get().task;
      if (!task) return;
      task.name = name;
      touch(task);
      persist(true);
      void refreshTaskList(task.id);
      bump();
    },

    setActivePallet(palletId) {
      const task = get().task;
      const pallet = task?.pallets.find((p) => p.id === palletId) ?? null;
      const box = pallet?.boxes.find((b) => b.status === 'scanning') ?? pallet?.boxes[pallet.boxes.length - 1] ?? null;
      set({ activePalletId: palletId, activeBoxId: box?.id ?? null, scanning: false });
    },

    setScanning(on) {
      set({ scanning: on });
    },

    setActiveBox(boxId) {
      const found = findBox(boxId);
      if (!found) return;
      if (found.box.status === 'sealed') {
        get().toast(`${found.box.code} 已封箱，不能再扫`, 'warn');
        return;
      }
      set({ activePalletId: found.pallet.id, activeBoxId: boxId, scanning: false });
    },

    addBox(model, opts) {
      const task = get().task;
      if (!task) return { ok: false, message: '请先新建任务', box: null };
      const pallet =
        (opts?.palletId ? task.pallets.find((p) => p.id === opts.palletId) : null) ?? activePallet();
      if (!pallet) return { ok: false, message: '没有可用卡板', box: null };
      if (pallet.status === 'sealed') {
        return { ok: false, message: `${pallet.code} 已封板，请先新建/切换卡板`, box: null };
      }
      if (pallet.boxes.length >= task.maxBoxesPerPallet) {
        return {
          ok: false,
          message: `本板已满（${pallet.boxes.length}/${task.maxBoxesPerPallet} 箱），请封板`,
          box: null,
        };
      }
      // 还有没封的箱 -> 不允许直接加新箱，避免漏封
      const openBox = pallet.boxes.find((b) => b.status === 'scanning');
      if (openBox) {
        return {
          ok: false,
          message: `${openBox.code} 还没封箱，请先「封箱」再添加下一个箱子`,
          box: null,
        };
      }
      const prefix = get().settings.boxCodePrefix || 'B';
      const box = emptyBox(pallet.id, pallet.boxes.length + 1, boxCode(prefix, pallet.boxes.length + 1), model);
      pallet.boxes.push(box);
      recalcPallet(pallet, prefix);
      touch(task);
      persist(true);
      set({ activePalletId: pallet.id, activeBoxId: box.id, scanning: false });
      bump();
      return {
        ok: true,
        message: `${box.code} 已添加${box.model ? `（型号 ${box.model}）` : ''}，开始扫条码`,
        box,
      };
    },

    sealBox(boxId) {
      const found = findBox(boxId);
      if (!found) return { ok: false, message: '找不到该箱', box: null };
      const { pallet, box } = found;
      if (box.status === 'sealed') return { ok: false, message: `${box.code} 已经是封箱状态`, box };
      if (box.barcodes.length === 0) return { ok: false, message: `${box.code} 还没有条码，不能封箱`, box };
      box.status = 'sealed';
      box.sealedAt = now();
      recalcPallet(pallet, get().settings.boxCodePrefix || 'B');
      touch(get().task!);
      persist(true);
      bump();
      return {
        ok: true,
        message: `${box.code} 已封箱（${box.barcodes.length} 条条码${box.model ? ` · 型号 ${box.model}` : ''}）`,
        box,
      };
    },

    removeBox(boxId) {
      const task = get().task;
      if (!task) return;
      const found = findBox(boxId);
      if (!found) return;
      const { pallet } = found;
      pallet.boxes = pallet.boxes.filter((b) => b.id !== boxId);
      recalcPallet(pallet, get().settings.boxCodePrefix || 'B');
      if (get().activeBoxId === boxId) {
        const next = pallet.boxes.find((b) => b.status === 'scanning') ?? pallet.boxes[pallet.boxes.length - 1];
        set({ activeBoxId: next?.id ?? null });
      }
      touch(task);
      persist(true);
      bump();
    },

    updateBoxModel(boxId, model) {
      const task = get().task;
      if (!task) return;
      const found = findBox(boxId);
      if (!found) return;
      found.box.model = model.trim();
      touch(task);
      persist();
      bump();
    },

    scanBarcode(code, opts) {
      const task = get().task;
      const pallet = activePallet();
      const box = activeBox();
      if (!task || !pallet) {
        return { ok: false, message: '请先新建任务', duplicated: false, index: 0, boxCode: '' };
      }
      if (!box) {
        return { ok: false, message: '请先「添加箱子」并扫描型号', duplicated: false, index: 0, boxCode: '' };
      }
      if (box.status === 'sealed') {
        return {
          ok: false,
          message: `${box.code} 已封箱，请添加新箱子`,
          duplicated: false,
          index: 0,
          boxCode: box.code,
        };
      }
      if (pallet.status === 'sealed') {
        return {
          ok: false,
          message: `${pallet.code} 已封板，请先新建/切换卡板`,
          duplicated: false,
          index: 0,
          boxCode: box.code,
        };
      }
      const outcome = applyScan({ model: box.model, barcodes: box.barcodes }, code, { manual: opts?.manual });
      if (!outcome.ok) {
        return {
          ok: false,
          message: outcome.message,
          duplicated: outcome.duplicated,
          index: outcome.existing?.index ?? 0,
          boxCode: box.code,
        };
      }
      box.barcodes = outcome.barcodes;
      box.totalBarcodes = outcome.total;
      if (outcome.barcodeId) lastTouchedBarcode.set(box.id, outcome.barcodeId);
      recalcPallet(pallet, get().settings.boxCodePrefix || 'B');
      touch(task);
      persist();
      bump();
      return {
        ok: true,
        message: outcome.message,
        duplicated: false,
        index: outcome.index ?? 0,
        boxCode: box.code,
      };
    },

    undoLastBarcode() {
      const task = get().task;
      const pallet = activePallet();
      const box = activeBox();
      if (!task || !pallet || !box) return { ok: false, message: '没有正在扫描的箱子' };
      if (box.status === 'sealed') return { ok: false, message: `${box.code} 已封箱，无法撤销`, };
      const outcome = applyUndo(
        { model: box.model, barcodes: box.barcodes },
        lastTouchedBarcode.get(box.id),
      );
      if (!outcome.ok) return { ok: false, message: outcome.message };
      box.barcodes = outcome.barcodes;
      box.totalBarcodes = outcome.total;
      lastTouchedBarcode.set(box.id, outcome.barcodes[outcome.barcodes.length - 1]?.id ?? '');
      recalcPallet(pallet, get().settings.boxCodePrefix || 'B');
      touch(task);
      persist();
      bump();
      return { ok: true, message: outcome.message };
    },

    removeBarcode(barcodeId) {
      const task = get().task;
      if (!task) return;
      for (const pallet of task.pallets) {
        for (const box of pallet.boxes) {
          if (!box.barcodes.some((b) => b.id === barcodeId)) continue;
          const outcome = applyRemoveBarcode({ model: box.model, barcodes: box.barcodes }, barcodeId);
          box.barcodes = outcome.barcodes;
          box.totalBarcodes = outcome.total;
          if (lastTouchedBarcode.get(box.id) === barcodeId) lastTouchedBarcode.delete(box.id);
          recalcPallet(pallet, get().settings.boxCodePrefix || 'B');
          touch(task);
          persist();
          bump();
          return;
        }
      }
    },

    removeDuplicateBarcodes(boxId) {
      const task = get().task;
      if (!task) return { removed: 0, message: '没有任务' };
      const found = boxId ? findBox(boxId) : (() => {
        const box = activeBox();
        const pallet = activePallet();
        return box && pallet ? { box, pallet } : null;
      })();
      if (!found) return { removed: 0, message: '没有可清理的箱子' };
      const outcome = applyRemoveDuplicates({ model: found.box.model, barcodes: found.box.barcodes });
      if (!outcome.ok) return { removed: 0, message: outcome.message };
      found.box.barcodes = outcome.barcodes;
      found.box.totalBarcodes = outcome.total;
      lastTouchedBarcode.delete(found.box.id);
      recalcPallet(found.pallet, get().settings.boxCodePrefix || 'B');
      touch(task);
      persist(true);
      bump();
      return { removed: outcome.removed, message: outcome.message };
    },

    async sealActivePallet() {
      const task = get().task;
      const pallet = activePallet();
      if (!task) return { ok: false, message: '没有任务', pallet: null };
      if (!pallet) return { ok: false, message: '没有卡板', pallet: null };
      if (pallet.boxes.length === 0) return { ok: false, message: `${pallet.code} 还没有箱子，不能封板`, pallet: null };
      const openBox = pallet.boxes.find((b) => b.status === 'scanning');
      if (openBox) {
        return { ok: false, message: `${openBox.code} 还没封箱，请先封箱再封板`, pallet: null };
      }
      recalcPallet(pallet, get().settings.boxCodePrefix || 'B');
      pallet.status = 'sealed';
      pallet.sealedAt = now();
      touch(task);
      const next = makePallet(task, task.pallets.length + 1);
      task.pallets.push(next);
      cancelScheduledWrite(task.id);
      await dbPutTask(snapshotOf(task));
      set({ activePalletId: next.id, activeBoxId: null });
      await refreshTaskList(task.id);
      bump();
      return {
        ok: true,
        message: `${pallet.code} 已封板（${pallet.boxes.length} 箱 / ${pallet.totalBarcodes} 条条码），已创建 ${next.code}`,
        pallet,
      };
    },

    unsealPallet(palletId) {
      const task = get().task;
      if (!task) return;
      const pallet = task.pallets.find((p) => p.id === palletId);
      if (!pallet) return;
      const laterHasData = task.pallets.some((p) => p.index > pallet.index && p.boxes.length > 0);
      if (laterHasData) {
        get().toast('该卡板后面已有其他卡板的数据，无法解封', 'warn');
        return;
      }
      pallet.status = 'scanning';
      delete pallet.sealedAt;
      task.pallets = task.pallets.filter((p) => p.index <= pallet.index || p.boxes.length > 0);
      task.pallets.forEach((p, i) => {
        p.index = i + 1;
        p.code = palletCode(task.__prefix ?? get().settings.palletCodePrefix ?? 'P', p.index);
      });
      const box = [...pallet.boxes].reverse().find((b) => b.status === 'scanning') ?? pallet.boxes[pallet.boxes.length - 1];
      touch(task);
      persist(true);
      set({ activePalletId: pallet.id, activeBoxId: box?.id ?? null });
      bump();
    },

    createPallet() {
      const task = get().task;
      if (!task) return null;
      const pallet = makePallet(task, task.pallets.length + 1);
      task.pallets.push(pallet);
      touch(task);
      persist(true);
      set({ activePalletId: pallet.id, activeBoxId: null });
      bump();
      return pallet;
    },

    removePallet(palletId) {
      const task = get().task;
      if (!task) return;
      task.pallets = task.pallets.filter((p) => p.id !== palletId);
      task.pallets.forEach((p, i) => {
        p.index = i + 1;
        p.code = palletCode(task.__prefix ?? get().settings.palletCodePrefix ?? 'P', p.index);
      });
      if (task.pallets.length === 0) {
        const first = makePallet(task, 1);
        task.pallets.push(first);
        set({ activePalletId: first.id, activeBoxId: null });
      } else if (!task.pallets.some((p) => p.id === get().activePalletId)) {
        const last = task.pallets[task.pallets.length - 1];
        set({
          activePalletId: last.id,
          activeBoxId: last.boxes[last.boxes.length - 1]?.id ?? null,
        });
      }
      touch(task);
      persist(true);
      bump();
    },

    setMode2Order: (data) => set({ mode2Order: data, mode2Result: null }),
    setMode2Scan: (data) => set({ mode2Scan: data, mode2Result: null }),
    setMode2Result: (result) => set({ mode2Result: result }),
    clearMode2: () => set({ mode2Order: null, mode2Scan: null, mode2Result: null }),

    async replaceAll(tasks, currentTaskId) {
      pendingWrites.forEach((timer) => window.clearTimeout(timer));
      pendingWrites.clear();
      await dbClearAll();
      for (const task of tasks) {
        await dbPutTask(task);
      }
      const current = (currentTaskId ? tasks.find((t) => t.id === currentTaskId) : null) ?? tasks[0] ?? null;
      await kvSet('currentTaskId', current?.id ?? '');
      const pallet = current?.pallets[current.pallets.length - 1];
      set({
        tasks: tasks.map(toMeta),
        task: current,
        activePalletId: pallet?.id ?? null,
        activeBoxId: pallet?.boxes[pallet.boxes.length - 1]?.id ?? null,
        scanning: false,
      });
      bump();
    },
  };
});

/** 当前卡板 */
export function useActivePallet(): Pallet | null {
  return useStore((s) => {
    if (!s.task) return null;
    return s.task.pallets.find((p) => p.id === s.activePalletId) ?? s.task.pallets[s.task.pallets.length - 1] ?? null;
  });
}

/** 当前正在扫条码的箱子 */
export function useActiveBox(): Box | null {
  const pallet = useActivePallet();
  const activeBoxId = useStore((s) => s.activeBoxId);
  if (!pallet) return null;
  return pallet.boxes.find((b) => b.id === activeBoxId) ?? pallet.boxes[pallet.boxes.length - 1] ?? null;
}

/** 兼容旧调用名 */
export const palletTotalQty = palletBarcodeTotal;

/** 卡板条码总数（含未封箱） */
export function palletBarcodeTotal(pallet: Pallet): number {
  return pallet.boxes.reduce((sum, box) => sum + box.barcodes.length, 0);
}
