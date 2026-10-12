import { useMemo, useState } from 'react';
import { useStore, formatTime } from '@/store';
import { dbListTasks } from '@/db';
import { ConfirmBar, FileButton, Modal, Stat } from '@/components/Modal';
import { exportSinglePallet, exportTask, downloadTemplates } from '@/services/excel';
import { exportPickResult } from '@/services/allocation';
import { downloadBackup, parseBackup } from '@/services/backup';

export default function DataPage() {
  const task = useStore((s) => s.task);
  const revision = useStore((s) => s.revision);
  const tasks = useStore((s) => s.tasks);
  const settings = useStore((s) => s.settings);
  const toast = useStore((s) => s.toast);
  const switchTask = useStore((s) => s.switchTask);
  const removeTask = useStore((s) => s.removeTask);
  const clearCurrentTask = useStore((s) => s.clearCurrentTask);
  const clearAllData = useStore((s) => s.clearAllData);
  const replaceAll = useStore((s) => s.replaceAll);
  const result = useStore((s) => s.mode2Result);

  const [confirm, setConfirm] = useState<null | 'clear-task' | 'clear-all' | 'delete-task'>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);

  const stats = useMemo(() => {
    if (!task) return { pallets: 0, boxes: 0, barcodes: 0, kinds: 0, sealed: 0 };
    const kinds = new Set<string>();
    let boxes = 0;
    let barcodes = 0;
    task.pallets.forEach((p) => {
      boxes += p.boxes.length;
      p.boxes.forEach((box) => {
        barcodes += box.barcodes.length;
        box.barcodes.forEach((item) => kinds.add(item.code));
      });
    });
    return {
      pallets: task.pallets.length,
      boxes,
      barcodes,
      kinds: kinds.size,
      sealed: task.pallets.filter((p) => p.status === 'sealed').length,
    };
  }, [task, revision]);

  const backup = async (): Promise<void> => {
    const all = await dbListTasks();
    if (all.length === 0) {
      toast('没有可备份的数据', 'warn');
      return;
    }
    const filename = downloadBackup(all, settings, task?.id);
    toast(`已导出备份：${filename}`, 'success');
  };

  const restore = async (file: File) => {
    setBusy(true);
    try {
      const text = await file.text();
      const parsed = parseBackup(text);
      await replaceAll(parsed.tasks, parsed.currentTaskId);
      toast(`已恢复 ${parsed.tasks.length} 个任务`, 'success');
    } catch (error) {
      toast(`恢复失败：${(error as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <section className="card">
        <div className="row-between">
          <h2>当前任务数据</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowHistory(true)}>
            历史任务（{tasks.length}）
          </button>
        </div>
        {task ? (
          <>
            <div className="value-strong">{task.name}</div>
            <div className="muted small">
              创建于 {formatTime(task.createdAt)} · {task.status === 'finished' ? '已结束' : '扫描中'} · 上限{' '}
              {task.maxBoxesPerPallet} 箱/板
            </div>
            <div className="stat-grid">
              <Stat label="卡板数" value={stats.pallets} />
              <Stat label="已封板" value={stats.sealed} />
              <Stat label="总箱数" value={stats.boxes} />
              <Stat label="总条码数" value={stats.barcodes} />
              <Stat label="不同条码" value={stats.kinds} />
            </div>
          </>
        ) : (
          <p className="muted">还没有任务。请到「扫码建板」新建任务。</p>
        )}
      </section>

      <section className="card">
        <h3>导出 Excel</h3>
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={!task}
          onClick={() => {
            if (!task) return;
            exportTask(task);
            toast('总 Excel 已导出（总览/卡板汇总/箱明细）', 'success');
          }}
        >
          导出总 Excel（3 个 Sheet）
        </button>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!task}
            onClick={() => {
              if (!task) return;
              const last = [...task.pallets].reverse().find((p) => p.totalBoxes > 0);
              if (!last) {
                toast('还没有已扫描的卡板', 'warn');
                return;
              }
              exportSinglePallet(last, task);
              toast(`已导出 ${last.code} 单板 Excel`, 'success');
            }}
          >
            导出最后一个卡板
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => downloadTemplates()}>
            下载 Excel 模板
          </button>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-block"
          disabled={!result}
          onClick={() => {
            if (!result) return;
            exportPickResult(result, task?.name);
            toast('配货结果 Excel 已导出', 'success');
          }}
        >
          {result ? '导出模式二配货结果 Excel' : '模式二配货结果（尚未生成）'}
        </button>
      </section>

      <section className="card">
        <h3>本地数据安全</h3>
        <p className="muted small">
          全部数据保存在本机浏览器的 IndexedDB 中，不会上传。建议每天收工后导出一次 JSON 备份。
        </p>
        {task && (
          <div className="card-sub">
            {task.pallets.map((p) => (
              <div className="row-between" key={p.id}>
                <span>
                  {p.code} <span className="muted small">{p.status === 'sealed' ? '已封板' : '扫描中'}</span>
                </span>
                <span className="btn-row">
                  <span className="muted small">{p.totalBoxes} 箱</span>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      exportSinglePallet(p, task);
                      toast(`已导出 ${p.code}`, 'success');
                    }}
                  >
                    导出
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={() => void backup()}>
            导出 JSON 备份
          </button>
          <FileButton accept=".json,application/json" onFile={restore} className="btn btn-ghost">
            导入 JSON 恢复
          </FileButton>
        </div>
        <div className="btn-row">
          <button type="button" className="btn btn-warn" disabled={!task} onClick={() => setConfirm('clear-task')}>
            清空当前任务
          </button>
          <button type="button" className="btn btn-danger" onClick={() => setConfirm('clear-all')}>
            清空全部数据
          </button>
        </div>
      </section>

      <Modal open={showHistory} title="历史任务" onClose={() => setShowHistory(false)}>
        {tasks.length === 0 && <p className="muted">没有历史任务。</p>}
        {tasks.map((t) => (
          <div className={`history-row ${t.id === task?.id ? 'history-row-active' : ''}`} key={t.id}>
            <div className="history-main">
              <strong>{t.name}</strong>
              <div className="muted small">
                {formatTime(t.createdAt)} · {t.palletCount} 板 · {t.totalBoxes} 箱
                {t.status === 'finished' ? ' · 已结束' : ''}
              </div>
            </div>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={async () => {
                  await switchTask(t.id);
                  setShowHistory(false);
                  toast(`已切换到 ${t.name}`, 'success');
                }}
              >
                打开
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => {
                  setShowHistory(false);
                  setPendingDeleteId(t.id);
                  setConfirm('delete-task');
                }}
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </Modal>

      {confirm === 'clear-task' && (
        <ConfirmBar
          title="清空当前任务？"
          message="当前任务的所有卡板和箱明细都会被删除（任务名和设置保留），此操作不可撤销。建议先导出备份。"
          confirmText="确认清空"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await clearCurrentTask();
            setConfirm(null);
            toast('当前任务已清空', 'info');
          }}
        />
      )}
      {confirm === 'clear-all' && (
        <ConfirmBar
          title="清空全部数据？"
          message="所有任务、卡板、箱明细都会从本机删除，且无法恢复。请确认已经导出 JSON 备份。"
          confirmText="我确认全部删除"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await clearAllData();
            setConfirm(null);
            toast('全部数据已清空', 'info');
          }}
        />
      )}
      {confirm === 'delete-task' && (
        <ConfirmBar
          title="删除这个任务？"
          message="该任务及其卡板明细会被永久删除。"
          confirmText="确认删除"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const id = pendingDeleteId;
            setConfirm(null);
            setPendingDeleteId(null);
            if (id) {
              await removeTask(id);
              toast('任务已删除', 'info');
            }
          }}
        />
      )}

      {busy && <div className="busy-mask">正在处理…</div>}
    </div>
  );
}
