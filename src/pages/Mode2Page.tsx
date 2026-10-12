import { useMemo, useState } from 'react';
import { useStore } from '@/store';
import { FileButton, Modal, Stat } from '@/components/Modal';
import { parseOrderWorkbook, parseScanWorkbook, readWorkbookFile, downloadTemplates } from '@/services/excel';
import { allocate, exportPickResult, describeResult } from '@/services/allocation';
import { beep, vibrate } from '@/services/feedback';
import type { AnomalyType, PickPallet } from '@/types';

const ANOMALY_META: Record<AnomalyType, { label: string; color: string }> = {
  unmatched: { label: '未匹配', color: 'red' },
  qty_mismatch: { label: '数量差异', color: 'yellow' },
  conflict: { label: '条码冲突', color: 'yellow' },
  overflow_split: { label: '超限拆分', color: 'orange' },
  same_barcode_multi_pallet: { label: '同条码多板', color: 'yellow' },
};

export default function Mode2Page() {
  const order = useStore((s) => s.mode2Order);
  const scan = useStore((s) => s.mode2Scan);
  const result = useStore((s) => s.mode2Result);
  const setOrder = useStore((s) => s.setMode2Order);
  const setScan = useStore((s) => s.setMode2Scan);
  const setResult = useStore((s) => s.setMode2Result);
  const clearMode2 = useStore((s) => s.clearMode2);
  const task = useStore((s) => s.task);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const toast = useStore((s) => s.toast);

  const [busy, setBusy] = useState(false);
  const [detailPallet, setDetailPallet] = useState<PickPallet | null>(null);
  const [showAnomalies, setShowAnomalies] = useState(false);
  const [useCurrentTask, setUseCurrentTask] = useState(true);

  const currentTaskBoxes = useMemo(() => {
    if (!task) return 0;
    return task.pallets.reduce((s, p) => s + p.totalBoxes, 0);
  }, [task]);

  const importOrder = async (file: File) => {
    setBusy(true);
    try {
      const wb = await readWorkbookFile(file);
      const parsed = parseOrderWorkbook(wb, file.name);
      setOrder(parsed);
      toast(`货单导入成功：${parsed.items.length} 个条码 / 共 ${parsed.totalQty} 箱`, 'success');
    } catch (error) {
      toast(`货单导入失败：${(error as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const importScan = async (file: File) => {
    setBusy(true);
    try {
      const wb = await readWorkbookFile(file);
      const parsed = parseScanWorkbook(wb, file.name);
      setScan(parsed);
      toast(
        `模式一数据导入成功：${parsed.palletCount} 板 / ${parsed.boxCount} 箱 / ${parsed.barcodeCount} 条条码`,
        'success',
      );
    } catch (error) {
      toast(`模式一数据导入失败：${(error as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const useCurrentTaskData = () => {
    if (!task) {
      toast('当前没有任务数据', 'warn');
      return;
    }
    const items = task.pallets.flatMap((p) =>
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
          note: code.note,
        })),
      ),
    );
    if (items.length === 0) {
      toast('当前任务还没有扫描数据', 'warn');
      return;
    }
    setScan({
      fileName: `当前任务：${task.name}`,
      headers: ['卡板号', '箱号', '箱序号', '条码', '箱内序号', '型号', '数量', '扫描时间'],
      items,
      palletCount: task.pallets.length,
      boxCount: task.pallets.reduce((s, p) => s + p.boxes.length, 0),
      barcodeCount: items.length,
    });
    toast('已使用当前任务的扫描数据', 'success');
  };

  const runAllocation = () => {
    if (!order || !scan) {
      toast('请先导入货单和模式一数据', 'warn');
      return;
    }
    try {
      const r = allocate(order, scan, {
        maxBoxesPerPallet: settings.maxBoxesPerPallet,
        boxesPerLayer: settings.boxesPerLayer,
        placeUnmatched: true,
      });
      setResult(r);
      beep.seal();
      vibrate(80, settings.vibrateEnabled);
      toast(describeResult(r), 'success');
    } catch (error) {
      toast(`配板失败：${(error as Error).message}`, 'error');
    }
  };

  const anomalyCounts = useMemo(() => {
    const counts = new Map<AnomalyType, number>();
    result?.anomalies.forEach((a) => counts.set(a.type, (counts.get(a.type) ?? 0) + 1));
    return counts;
  }, [result]);

  return (
    <div className="page">
      <section className="card">
        <h2>模式二：按货单配卡板</h2>
        <p className="muted small">
          导入货单 Excel + 模式一扫描数据，按相同条码归入相同卡板，卡板内按数量从多到少「底层→顶层」堆放，
          超过上限自动拆分。
        </p>
        <div className="btn-row">
          <FileButton accept=".xlsx,.xls,.csv" onFile={importOrder} className="btn btn-primary btn-block">
            ① 导入货单 Excel
          </FileButton>
        </div>
        {order && (
          <div className="import-info">
            <strong>{order.fileName}</strong>
            <span className="muted small">
              {order.items.length} 个条码 · 共 {order.totalQty} 箱
            </span>
          </div>
        )}

        <div className="btn-row">
          <FileButton accept=".xlsx,.xls" onFile={importScan} className="btn btn-primary btn-block">
            ② 导入模式一 Excel
          </FileButton>
        </div>
        {scan && (
          <div className="import-info">
            <strong>{scan.fileName}</strong>
            <span className="muted small">
              {scan.palletCount} 板 · {scan.boxCount} 箱 · {scan.barcodeCount} 条条码
            </span>
          </div>
        )}
        <label className="checkline">
          <input type="checkbox" checked={useCurrentTask} onChange={(e) => setUseCurrentTask(e.target.checked)} />
          <span className="muted small">允许直接使用当前任务数据（{currentTaskBoxes} 箱）</span>
        </label>
        {useCurrentTask && (
          <button type="button" className="btn btn-ghost btn-block" onClick={useCurrentTaskData} disabled={!task}>
            直接使用当前任务的扫描数据
          </button>
        )}

        <div className="card-sub">
          <div className="row-between">
            <span className="label">每板上限</span>
            <div className="btn-row">
              {[40, 50].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`btn btn-sm ${settings.maxBoxesPerPallet === n ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => updateSettings({ maxBoxesPerPallet: n })}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="row-between">
            <span className="label">每层箱数（算层号用）</span>
            <div className="btn-row">
              {[4, 5, 6].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`btn btn-sm ${settings.boxesPerLayer === n ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => updateSettings({ boxesPerLayer: n })}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button type="button" className="btn btn-success btn-block btn-lg" onClick={runAllocation} disabled={busy || !order || !scan}>
          ③ 开始配板
        </button>
        <div className="btn-row">
          <button type="button" className="btn btn-ghost" onClick={() => downloadTemplates()}>
            下载 Excel 模板
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              clearMode2();
              toast('已清空模式二数据', 'info');
            }}
          >
            清空
          </button>
        </div>
      </section>

      {result && (
        <>
          <section className="card">
            <div className="row-between">
              <h3>配货结果</h3>
              <span className="muted small">{new Date(result.createdAt).toLocaleString('zh-CN')}</span>
            </div>
            <div className="stat-grid">
              <Stat label="卡板数" value={result.stats.palletCount} />
              <Stat label="已配箱数" value={result.stats.allocatedQty} />
              <Stat label="货单总箱数" value={result.stats.orderTotalQty} />
              <Stat label="拆分卡板" value={result.stats.splitPalletCount} tone="orange" />
              <Stat label="未匹配" value={result.stats.unmatchedCount} tone="red" />
              <Stat label="数量差异" value={result.stats.mismatchCount} tone="yellow" />
            </div>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary btn-lg btn-block"
                onClick={() => {
                  exportPickResult(result, task?.name);
                  toast('配货 Excel 已导出', 'success');
                }}
              >
                导出配货 Excel
              </button>
            </div>
            <div className="btn-row">
              <button type="button" className="btn btn-ghost" onClick={() => setShowAnomalies(true)}>
                查看异常（{result.anomalies.length}）
              </button>
            </div>
            <div className="legend">
              <span className="chip chip-green">已匹配</span>
              <span className="chip chip-red">未匹配</span>
              <span className="chip chip-yellow">数量差异</span>
              <span className="chip chip-orange">超限拆分</span>
            </div>
          </section>

          <section className="card">
            <h3>卡板堆放顺序（底层 → 顶层）</h3>
            {result.pallets.map((p) => (
              <button type="button" key={p.palletCode} className="pick-card" onClick={() => setDetailPallet(p)}>
                <div className="row-between">
                  <strong className={p.palletCode === '未匹配' ? 'text-red' : ''}>{p.palletCode}</strong>
                  <span className="muted small">
                    {p.totalBoxes} 箱 · {p.barcodeKinds} 种 · {p.layerCount} 层
                    {p.isSplit ? ' · 拆分' : ''}
                  </span>
                </div>
                <div className="layer-list">
                  {[...p.layerSummary].reverse().map((layer) => (
                    <div className="layer-row" key={layer.layerIndex}>
                      <span className="layer-tag">第{layer.layerIndex}层</span>
                      <span className="layer-text">{layer.label}</span>
                    </div>
                  ))}
                </div>
                {p.isSplit && <div className="chip chip-orange">由 {p.sourcePalletCode} 超限拆分</div>}
              </button>
            ))}
          </section>
        </>
      )}

      <Modal open={!!detailPallet} title={`${detailPallet?.palletCode ?? ''} 堆放明细`} onClose={() => setDetailPallet(null)}>
        {detailPallet && (
          <div className="stack-list">
            {[...detailPallet.boxes]
              .sort((a, b) => b.stackOrder - a.stackOrder)
              .map((b) => (
                <div className="stack-row" key={b.id}>
                  <span className="stack-order">#{b.stackOrder}</span>
                  <span className="stack-layer">第{b.layerIndex}层</span>
                  <span className="stack-barcode">{b.barcode}</span>
                  <span className="muted small">{b.name ?? ''}</span>
                </div>
              ))}
            <p className="muted small">列表从顶层往底层显示，实际堆板时请从列表底部开始放。</p>
          </div>
        )}
      </Modal>

      <Modal open={showAnomalies} title="异常明细" onClose={() => setShowAnomalies(false)}>
        <div className="legend">
          {(Object.keys(ANOMALY_META) as AnomalyType[])
            .filter((k) => anomalyCounts.get(k))
            .map((k) => (
              <span key={k} className={`chip chip-${ANOMALY_META[k].color}`}>
                {ANOMALY_META[k].label} {anomalyCounts.get(k)}
              </span>
            ))}
        </div>
        {result?.anomalies.length === 0 && <p className="muted">没有异常，全部条码匹配且数量一致。</p>}
        {result?.anomalies.map((a, i) => (
          <div key={`${a.type}-${a.barcode}-${i}`} className={`anomaly-row anomaly-${ANOMALY_META[a.type]?.color ?? 'yellow'}`}>
            <strong>{ANOMALY_META[a.type]?.label ?? a.type}</strong>
            <span className="stack-barcode">{a.barcode}</span>
            {a.palletCode && <span className="muted small">{a.palletCode}</span>}
            <div className="muted small">{a.detail}</div>
          </div>
        ))}
      </Modal>

      {busy && <div className="busy-mask">正在解析文件…</div>}
    </div>
  );
}
