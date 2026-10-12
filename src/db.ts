import Dexie, { type Table } from 'dexie';
import type { Task, TaskMeta } from '@/types';

/**
 * 本地存储：IndexedDB（Dexie）。
 * 全部数据只存在手机/电脑本地浏览器里，不上传任何服务器。
 *
 * 表结构：
 *  - tasks：完整任务（含卡板与箱，作为嵌套 JSON 存储，保证「刷新不丢数据」）
 *  - kv：键值表，存当前任务 id、设置等
 */
export interface KvRecord {
  key: string;
  value: unknown;
}

class PalletScanDB extends Dexie {
  tasks!: Table<Task, string>;
  kv!: Table<KvRecord, string>;

  constructor() {
    super('pallet-scan');
    this.version(1).stores({
      tasks: 'id, createdAt, updatedAt, status',
      kv: 'key',
    });
  }
}

export const db = new PalletScanDB();

export async function dbListTasks(): Promise<Task[]> {
  const rows = await db.tasks.toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function dbGetTask(id: string): Promise<Task | undefined> {
  return db.tasks.get(id);
}

export async function dbPutTask(task: Task): Promise<void> {
  await db.tasks.put(task);
}

export async function dbDeleteTask(id: string): Promise<void> {
  await db.tasks.delete(id);
}

export async function dbClearAll(): Promise<void> {
  await db.tasks.clear();
  await db.kv.clear();
}

export async function dbCountTasks(): Promise<number> {
  return db.tasks.count();
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const row = await db.kv.get(key);
  return row ? (row.value as T) : undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value });
}

export function toMeta(task: Task): TaskMeta {
  const totalBoxes = task.pallets.reduce((sum, p) => sum + p.totalBoxes, 0);
  return {
    id: task.id,
    name: task.name,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    status: task.status,
    maxBoxesPerPallet: task.maxBoxesPerPallet,
    palletCount: task.pallets.length,
    totalBoxes,
  };
}
