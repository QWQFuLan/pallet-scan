import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useStore,
  useActivePallet,
  useActiveBox,
  formatShortTime,
  formatTime,
  palletBarcodeTotal,
} from '@/store';
import { beep, unlockAudio, vibrate } from '@/services/feedback';
import { exportSinglePallet, exportTask } from '@/services/excel';
import { findDuplicateBarcodes } from '@/services/scanRules';
import { Modal, ConfirmBar } from '@/components/Modal';
import { ScannerPanel } from '@/components/ScannerPanel';

type ScanTarget = 'off' | 'model' | 'barcode';

export default function Mode1Page() {
  const task = useStore((s) => s.task);
  const pallet = useActivePallet();
  const box = useActiveBox();
  const revision = useStore((s) => s.revision);
  const settings = useStore((s) => s.settings);
  const toast = useStore((s) => s.toast);
  const addBox = useStore((s) => s.addBox);
  const sealBox = useStore((s) => s.sealBox);
  const removeBox = useStore((s) => s.removeBox);
  const setActiveBox = useStore((s) => s.setActiveBox);
  const scanBarcode = useStore((s) => s.scanBarcode);
  const undoLastBarcode = useStore((s) => s.undoLastBarcode);
  const removeBarcode = useStore((s) => s.removeBarcode);
  const removeDuplicateBarcodes = useStore((s) => s.removeDuplicateBarcodes);
  const sealActivePallet = useStore((s) => s.sealActivePallet);
  const setActivePallet = useStore((s) => s.setActivePallet);
  const newTask = useStore((s) => s.newTask);
  const finishTask = useStore((s) => s.finishTask);
  const reopenTask = useStore((s) => s.reopenTask);

  /** 摄像头当前服务的对象：不扫 / 扫型号 / 扫条码 */
  const [scanTarget, setScanTarget] = useState<ScanTarget>('off');
  const [showNewTask, setShowNewTask] = useState(false);
  const [showAddBox, setShowAddBox] = useState(false);
  const [showBatch, setShowBatch] = useState(false);
  const [showPallets, setShowPallets] = useState(false);
  const [taskName, setTaskName] = useState('');
  const [batchText, setBatchText] = useState('');
  const [boxModel, setBoxModel] = useState('');
  const [lastCode, setLastCode] = useState('');
  const [lastModel, setLastModel] = useState('');
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);
  /** 全屏查看某个箱子的条码 */
  const [fullBoxId, setFullBoxId] = useState<string | null>(null);
  const [confirmSealBox, setConfirmSealBox] = useState(false);
  const [confirmSealPallet, setConfirmSealPallet] = useState(false);
  const [confirmFinish, setConfirmFinish] = useState(false);

  const lastScanRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });

  const totals = useMemo(() => {
    if (!task) return { boxes: 0, barcodes: 0, pallets: 0 };
    const boxes = task.pallets.reduce((s, p) => s + p.boxes.length, 0);
    const barcodes = task.pallets.reduce((s, p) => s + palletBarcodeTotal(p), 0);
    return { boxes, barcodes, pallets: task.pallets.length };
  }, [task, revision]);

  /** 当前展开查看的箱（默认当前箱） */
  const viewBox = useMemo(() => {
    if (!pallet) return null;
    if (selectedBoxId) {
      const found = pallet.boxes.find((b) => b.id === selectedBoxId);
      if (found) return found;
    }
    return box;
  }, [pallet, box, selectedBoxId, revision]);

  /** 同一条码在极短时间里重复上报（摄像头连帧）直接忽略，避免刷屏 */
  const throttle = (code: string): boolean => {
    const now = Date.now();
    if (lastScanRef.current.code === code && now - lastScanRef.current.at < 400) return true;
    lastScanRef.current = { code, at: now };
    return false;
  };

  /** 摄像头扫到「型号」 */
  const handleModelScan = (raw: string) => {
    const code = raw.trim();
    if (!code) return;
    if (throttle(code)) return;
    setBoxModel(code);
    setLastModel(code);
    beep.success();
    vibrate(50, settings.vibrateEnabled);
    toast(`型号已识别：${code}`, 'success');
  };

  /** 摄像头扫到「箱内条码」 */
  const handleBarcodeScan = (raw: string) => {
    const code = raw.trim();
    if (!code) return;
    const now = Date.now();
    if (lastScanRef.current.code === code && now - lastScanRef.current.at < 400) return;
    lastScanRef.current = { code, at: now };
    const result = scanBarcode(code);
    if (result.ok) {
      beep.success();
      vibrate(60, settings.vibrateEnabled);
      setLastCode(code);
      // 只提示扫到了哪一条，不滚动、不跳转
      toast(`已记录 ${code}（${result.boxCode} 第 ${result.index} 条）`, 'success');
    } else if (result.duplicated) {
      beep.duplicate();
      vibrate([30, 40, 30], settings.vibrateEnabled);
      toast(result.message, 'warn');
    } else {
      beep.error();
      vibrate([120, 60, 120], settings.vibrateEnabled);
      toast(result.message, 'error');
    }
  };

  const handleDetect = (code: string) => {
    if (scanTarget === 'model') handleModelScan(code);
    else handleBarcodeScan(code);
  };

  // 自动化测试钩子：把「解码得到的条码」直接交给当前扫码逻辑（型号 / 条码，不影响正常使用）
  useEffect(() => {
    const host = window as unknown as { __palletScanHandleCode?: (code: string) => void };
    host.__palletScanHandleCode = handleDetect;
    return () => {
      if (host.__palletScanHandleCode === handleDetect) delete host.__palletScanHandleCode;
    };
  });

  const limit = task?.maxBoxesPerPallet ?? 60;
  const boxCount = pallet?.boxes.length ?? 0;
  const isPalletFull = boxCount >= limit;
  const scanningBox = box && box.status === 'scanning';

  if (!task) {
    return (
      <div className="page">
        <section className="card">
          <h2>还没有任务</h2>
          <p className="muted">
            新建任务开始装箱。作业顺序：卡板 → 箱子（先扫型号）→ 箱内条码 → 封箱 → 装满后封板。
          </p>
          <button type="button" className="btn btn-primary btn-lg" onClick={() => setShowNewTask(true)}>
            新建任务
          </button>
        </section>
        <NewTaskModal
          open={showNewTask}
          onClose={() => setShowNewTask(false)}
          value={taskName}
          onChange={setTaskName}
          onCreate={async () => {
            await newTask(taskName);
            setShowNewTask(false);
            setTaskName('');
            toast('任务已创建，请先添加箱子', 'success');
          }}
        />
      </div>
    );
  }

  const openAddBox = () => {
    setBoxModel('');
    setLastModel('');
    setShowAddBox(true);
    setScanTarget('model');
  };

  const closeAddBox = () => {
    setShowAddBox(false);
    setScanTarget(scanningBox ? 'barcode' : 'off');
  };

  const confirmAddBox = () => {
    const r = addBox(boxModel);
    if (!r.ok) {
      toast(r.message, 'error');
      return;
    }
    setShowAddBox(false);
    setBoxModel('');
    setSelectedBoxId(r.box?.id ?? null);
    setScanTarget('barcode');
    toast(r.message, 'success');
    beep.tap();
  };

  return (
    <div className="page">
      {/* 任务信息 */}
      <section className="card card-tight">
        <div className="row-between">
          <div>
            <div className="label">当前任务</div>
            <div className="value-strong">{task.name}</div>
            <div className="muted small">
              {totals.pallets} 板 · {totals.boxes} 箱 · {totals.barcodes} 条条码
              {task.status === 'finished' ? ' · 已结束' : ''}
            </div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => setShowPallets(true)}>
            卡板列表
          </button>
        </div>
      </section>

      {/* 当前卡板 + 当前箱 */}
      <section className={`card pallet-card ${isPalletFull ? 'pallet-full' : ''}`}>
        <div className="row-between">
          <div>
            <div className="label">当前卡板</div>
            <div className="pallet-code">{pallet?.code ?? '-'}</div>
          </div>
          <div className="count-box">
            <div className="count-num">
              {boxCount}
              <span className="count-limit">/{limit} 箱</span>
            </div>
            <div className="muted small">本板箱数</div>
          </div>
        </div>
        <div className="progress">
          <div className="progress-bar" style={{ width: `${Math.min(100, (boxCount / limit) * 100)}%` }} />
        </div>
        {isPalletFull && <div className="alert alert-warn">本板已满（{limit} 箱），请封板后再继续。</div>}
        {!isPalletFull && (
          <div className="muted small" style={{ marginTop: 8 }}>
            本板条码数合计 {pallet ? palletBarcodeTotal(pallet) : 0} 条
          </div>
        )}
      </section>

      {/* 当前箱子 */}
      <section className="card">
        {scanningBox && box ? (
          <>
            <div className="row-between">
              <div>
                <div className="label">当前箱（正在扫条码）</div>
                <div className="box-title">
                  {box.code}
                  {box.model && <span className="chip chip-blue">型号 {box.model}</span>}
                </div>
              </div>
              <div className="count-box">
                <div className="count-num small-num">{box.barcodes.length}</div>
                <div className="muted small">已扫条码</div>
              </div>
            </div>
            <div className="alert alert-info">对着这一箱里的条码逐个扫，扫完点「封箱」。</div>
          </>
        ) : (
          <>
            <div className="label">当前箱</div>
            <div className="value-strong muted">{box ? `${box.code} 已封箱` : '还没有箱子'}</div>
            <button
              type="button"
              className="btn btn-primary btn-block btn-lg"
              style={{ marginTop: 10 }}
              disabled={isPalletFull}
              onClick={openAddBox}
            >
              ＋ 添加箱子（先扫型号）
            </button>
            {isPalletFull && <div className="alert alert-warn">本板已满 {limit} 箱，请先封板。</div>}
          </>
        )}

        {/* 扫码面板：弹窗打开时摄像头给型号用，否则给条码用 */}
        <ScannerPanel
          active={scanTarget !== 'off'}
          onDetect={handleDetect}
          title={
            scanTarget === 'model'
              ? '扫描这一箱的型号（也可以手动输入）'
              : scanningBox
                ? '扫描箱内条码'
                : undefined
          }
          hint={
            scanTarget === 'model'
              ? lastModel
                ? `已识别型号：${lastModel}`
                : undefined
              : lastCode
                ? `上次扫描：${lastCode}${box?.model ? ` · 型号 ${box.model}` : ''}`
                : undefined
          }
          placeholder={scanTarget === 'model' ? '手动输入型号后回车' : '手动输入条码后回车'}
          fallbackHint={
            scanTarget === 'model' ? '摄像头不可用时，直接在下面输入型号也可以。' : undefined
          }
        />

        <div className="btn-row">
          {scanTarget === 'barcode' && scanningBox ? (
            <button type="button" className="btn btn-warn" onClick={() => setScanTarget('off')}>
              暂停扫描
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!scanningBox}
              onClick={() => setScanTarget('barcode')}
            >
              开始扫条码
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-lg"
            disabled={!scanningBox}
            onClick={() => {
              const r = undoLastBarcode();
              toast(r.message, r.ok ? 'success' : 'warn');
            }}
          >
            撤销上一条
          </button>
        </div>

        <div className="btn-row">
          <button
            type="button"
            className="btn btn-success"
            disabled={!scanningBox || (box?.barcodes.length ?? 0) === 0}
            onClick={() => setConfirmSealBox(true)}
          >
            封箱 {box?.code ?? ''}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setShowBatch(true)}
            disabled={!scanningBox}
          >
            批量粘贴条码
          </button>
        </div>

        <div className="btn-row">
          <button type="button" className="btn btn-ghost" disabled={isPalletFull} onClick={openAddBox}>
            添加箱子
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              unlockAudio();
              toast('提示音已启用', 'info');
            }}
          >
            测试提示音
          </button>
        </div>
      </section>

      {/* 箱子列表（按箱折叠） */}
      <section className="card">
        <div className="row-between">
          <h3>
            本板箱子（{boxCount}/{limit}）
          </h3>
          <span className="muted small">{formatTime(pallet?.createdAt)}</span>
        </div>
        <p className="muted small list-hint">点箱号展开/收起；点「查看条码」可以全屏翻看这一箱的所有条码。</p>
        <div className="box-list">
          {boxCount === 0 && <p className="muted">还没有箱子，点「添加箱子（先扫型号）」开始。</p>}
          {(pallet?.boxes ?? []).map((item) => {
            const isOpen = item.status === 'scanning';
            const expanded = viewBox?.id === item.id;
            const dup = findDuplicateBarcodes(item.barcodes);
            return (
              <div key={item.id} className={`box-group ${isOpen ? 'box-group-open' : ''}`}>
                <div className="box-head-row">
                  <button
                    type="button"
                    className="box-head"
                    onClick={() => setSelectedBoxId(expanded ? null : item.id)}
                  >
                    <span className="box-index">{item.index}</span>
                    <span className="box-head-main">
                      <span className="box-code">{item.code}</span>
                      {item.model && <span className="chip chip-blue">{item.model}</span>}
                      <span className={`chip ${isOpen ? 'chip-green' : 'chip-gray'}`}>
                        {isOpen ? '扫码中' : '已封箱'}
                      </span>
                      {dup.codes.length > 0 && <span className="chip chip-red">重复 {dup.codes.length}</span>}
                    </span>
                    <span className="muted small">{item.barcodes.length} 条</span>
                    <span className="chevron">{expanded ? '▾' : '▸'}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm box-view-btn"
                    onClick={() => setFullBoxId(item.id)}
                  >
                    查看条码
                  </button>
                </div>

                {expanded && (
                  <div className="box-body">
                    {dup.codes.length > 0 && (
                      <div className="dup-warn">
                        <div>
                          <strong>
                            {item.code} 有 {dup.codes.length} 个重复条码
                          </strong>
                          <div className="small muted">清理时每个条码保留最早的一条。</div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-danger"
                          onClick={() => {
                            const r = removeDuplicateBarcodes(item.id);
                            if (r.removed > 0) {
                              beep.seal();
                              toast(`已删除 ${r.removed} 条重复条码`, 'success');
                            } else {
                              toast(r.message, 'info');
                            }
                          }}
                        >
                          一键删除重复
                        </button>
                      </div>
                    )}
                    {item.barcodes.length === 0 && <p className="muted small">这一箱还没有条码。</p>}
                    {/* 条码明细可独立滚动：条码多的时候也能翻看 */}
                    <div className="code-scroll">
                      {item.barcodes.map((code) => (
                        <div
                          className={`code-row ${dup.duplicateIds.has(code.id) ? 'code-row-dup' : ''}`}
                          key={code.id}
                        >
                          <span className="code-index">{code.index}</span>
                          <span className="code-value">{code.code}</span>
                          <span className="muted small">{formatShortTime(code.scannedAt)}</span>
                          {dup.duplicateIds.has(code.id) && <span className="chip chip-red">重复</span>}
                          {item.status === 'scanning' && (
                            <button
                              type="button"
                              className="btn-delete"
                              onClick={() => {
                                removeBarcode(code.id);
                                toast(`已删除 ${code.code}`, 'info');
                              }}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    {item.barcodes.length > 6 && (
                      <div className="muted small scroll-tip">上下滑动查看全部 {item.barcodes.length} 条 ↑↓</div>
                    )}
                    <div className="btn-row" style={{ marginTop: 8 }}>
                      {isOpen ? (
                        <button
                          type="button"
                          className="btn btn-success btn-sm"
                          disabled={item.barcodes.length === 0}
                          onClick={() => {
                            const r = sealBox(item.id);
                            if (r.ok) {
                              beep.seal();
                              vibrate([80, 60, 80], settings.vibrateEnabled);
                            }
                            toast(r.message, r.ok ? 'success' : 'warn');
                          }}
                        >
                          封箱 {item.code}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setActiveBox(item.id);
                            setSelectedBoxId(item.id);
                            setScanTarget('barcode');
                          }}
                        >
                          继续扫这一箱
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => {
                          removeBox(item.id);
                          toast(`已删除 ${item.code}`, 'info');
                        }}
                      >
                        删除整箱
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* 封板 / 结束任务 */}
      <section className="card">
        <button
          type="button"
          className="btn btn-success btn-block btn-lg"
          disabled={boxCount === 0}
          onClick={() => setConfirmSealPallet(true)}
        >
          封板 {pallet?.code}（{boxCount} 箱 / {pallet ? palletBarcodeTotal(pallet) : 0} 条）
        </button>
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              if (!pallet) return;
              exportSinglePallet(pallet, task);
              toast('已导出本板 Excel', 'success');
            }}
          >
            导出本板 Excel
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              exportTask(task);
              toast('已导出总 Excel', 'success');
            }}
          >
            导出总 Excel
          </button>
        </div>
        {task.status === 'scanning' ? (
          <button
            type="button"
            className="btn btn-danger btn-block"
            style={{ marginTop: 10 }}
            onClick={() => setConfirmFinish(true)}
          >
            结束本次任务
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-ghost btn-block"
            style={{ marginTop: 10 }}
            onClick={() => void reopenTask()}
          >
            任务已结束，点击重新打开继续扫描
          </button>
        )}
      </section>

      {/* 添加箱子弹窗：先扫/输型号，再确认开始扫条码 */}
      <Modal open={showAddBox} title={`添加第 ${boxCount + 1} 箱`} onClose={closeAddBox}>
        <p className="muted small">
          每个箱子的型号可能不同，所以每加一箱都要先扫一次型号：用下面的摄像头扫型号条码，
          或者直接手动输入，然后点「确认并开始扫条码」。
        </p>
        <label className="field">
          <span className="field-label">这一箱的型号（Model）</span>
          <input
            className="input"
            autoComplete="off"
            placeholder="扫码枪扫型号，或手动输入"
            value={boxModel}
            onChange={(e) => setBoxModel(e.target.value)}
          />
        </label>

        {/* 弹窗里也能用摄像头扫型号：点按钮调起摄像头，扫到的型号自动填进上面的输入框 */}
        {!scanTarget || scanTarget !== 'model' ? (
          <button
            type="button"
            className="btn btn-ghost btn-block"
            onClick={() => {
              setLastModel('');
              setScanTarget('model');
            }}
          >
            📷 用摄像头扫型号
          </button>
        ) : (
          <>
            <div className="modal-divider">摄像头扫型号（扫到后自动填入上面）</div>
            <ScannerPanel
              active
              compact
              autoStart
              onDetect={handleModelScan}
              hint={lastModel ? `已识别型号：${lastModel}` : undefined}
              placeholder="手动输入型号后回车"
              fallbackHint="摄像头不可用时，直接在上面手动输入型号也可以。"
            />
          </>
        )}

        <div className="btn-row" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-ghost btn-lg" onClick={closeAddBox}>
            取消
          </button>
          <button type="button" className="btn btn-primary btn-lg" onClick={confirmAddBox}>
            确认并开始扫条码
          </button>
        </div>
      </Modal>

      {confirmSealBox && box && (
        <ConfirmBar
          title={`封箱 ${box.code}？`}
          message={`这一箱共 ${box.barcodes.length} 条条码${box.model ? `，型号 ${box.model}` : ''}。封箱后可以继续添加下一个箱子；一板装满后再封板。`}
          confirmText="确认封箱"
          onCancel={() => setConfirmSealBox(false)}
          onConfirm={() => {
            const r = sealBox(box.id);
            setConfirmSealBox(false);
            if (r.ok) {
              beep.seal();
              vibrate([80, 60, 80], settings.vibrateEnabled);
              setScanTarget('off');
            }
            toast(r.message, r.ok ? 'success' : 'warn');
          }}
        />
      )}

      {confirmSealPallet && pallet && (
        <ConfirmBar
          title={`封板 ${pallet.code}？`}
          message={`共 ${pallet.boxes.length} 箱 / ${palletBarcodeTotal(pallet)} 条条码。封板后会导出本板 Excel，并自动创建下一块卡板。`}
          confirmText="确认封板"
          onCancel={() => setConfirmSealPallet(false)}
          onConfirm={async () => {
            const sealed = pallet;
            const result = await sealActivePallet();
            setConfirmSealPallet(false);
            if (!result.ok) {
              toast(result.message, 'error');
              return;
            }
            beep.seal();
            vibrate([80, 60, 80], settings.vibrateEnabled);
            setScanTarget('off');
            toast(result.message, 'success');
            exportSinglePallet(sealed, task);
          }}
        />
      )}

      {confirmFinish && (
        <ConfirmBar
          title="结束本次任务？"
          message={`共 ${totals.pallets} 板 / ${totals.boxes} 箱 / ${totals.barcodes} 条条码。结束后会导出总 Excel，之后仍可重新打开任务继续扫描。`}
          confirmText="结束并导出总表"
          onCancel={() => setConfirmFinish(false)}
          onConfirm={async () => {
            await finishTask();
            setScanTarget('off');
            setConfirmFinish(false);
            exportTask(task);
            toast('任务已结束，总 Excel 已导出', 'success');
          }}
        />
      )}

      {/* 全屏查看某个箱子的条码：条码多的时候在这里上下滑动翻看 */}
      <Modal
        open={!!fullBoxId}
        title={(() => {
          const target = pallet?.boxes.find((b) => b.id === fullBoxId);
          return target ? `${target.code} 条码明细（${target.barcodes.length} 条）` : '条码明细';
        })()}
        onClose={() => setFullBoxId(null)}
      >
        {(() => {
          const target = pallet?.boxes.find((b) => b.id === fullBoxId);
          if (!target) return null;
          const dup = findDuplicateBarcodes(target.barcodes);
          return (
            <div className="full-code-view">
              <div className="muted small">
                {target.model ? `型号 ${target.model} · ` : ''}
                {target.status === 'sealed' ? '已封箱' : '扫码中'}
                {dup.codes.length > 0 ? ` · 重复 ${dup.codes.length} 个` : ''}
              </div>
              {target.barcodes.length === 0 && <p className="muted">这一箱还没有条码。</p>}
              <div className="code-scroll full">
                {target.barcodes.map((code) => (
                  <div
                    className={`code-row ${dup.duplicateIds.has(code.id) ? 'code-row-dup' : ''}`}
                    key={code.id}
                  >
                    <span className="code-index">{code.index}</span>
                    <span className="code-value">{code.code}</span>
                    <span className="muted small">{formatShortTime(code.scannedAt)}</span>
                    {code.status === 'manual' && <span className="chip chip-gray">手动</span>}
                    {dup.duplicateIds.has(code.id) && <span className="chip chip-red">重复</span>}
                    {target.status === 'scanning' && (
                      <button
                        type="button"
                        className="btn-delete"
                        onClick={() => {
                          removeBarcode(code.id);
                          toast(`已删除 ${code.code}`, 'info');
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="muted small scroll-tip">上下滑动查看全部 ↑↓（共 {target.barcodes.length} 条）</div>
            </div>
          );
        })()}
      </Modal>

      <Modal open={showBatch} title="批量粘贴条码" onClose={() => setShowBatch(false)}>        <p className="muted small">
          每行一个条码，都会记到当前箱（{box?.code ?? '-'}
          {box?.model ? ` · 型号 ${box.model}` : ''}）。重复条码不会计数。
        </p>
        <textarea
          className="input textarea"
          rows={6}
          value={batchText}
          onChange={(e) => setBatchText(e.target.value)}
          placeholder={'SN-000001\nSN-000002\nSN-000003'}
        />
        <div className="btn-row">
          <button type="button" className="btn btn-ghost" onClick={() => setShowBatch(false)}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const codes = batchText
                .split(/[\n,，;；\t]+/)
                .map((c) => c.trim())
                .filter(Boolean);
              if (codes.length === 0) {
                toast('没有可添加的条码', 'warn');
                return;
              }
              let ok = 0;
              let dup = 0;
              let lastMessage = '';
              for (const code of codes) {
                const r = scanBarcode(code, { manual: true });
                if (r.ok) ok += 1;
                else if (r.duplicated) dup += 1;
                else lastMessage = r.message;
              }
              setBatchText('');
              setShowBatch(false);
              if (lastMessage) toast(`添加 ${ok} 条，失败：${lastMessage}`, 'warn');
              else if (dup > 0) toast(`添加 ${ok} 条，跳过 ${dup} 条重复`, 'warn');
              else {
                toast(`已添加 ${ok} 条条码`, 'success');
                beep.success();
              }
            }}
          >
            添加
          </button>
        </div>
      </Modal>

      <Modal open={showPallets} title="卡板列表" onClose={() => setShowPallets(false)}>
        {task.pallets.map((p) => (
          <button
            type="button"
            key={p.id}
            className={`pallet-row ${p.id === pallet?.id ? 'pallet-row-active' : ''}`}
            onClick={() => {
              setActivePallet(p.id);
              setShowPallets(false);
              setScanTarget('off');
            }}
          >
            <span className="pallet-row-code">{p.code}</span>
            <span className={`chip ${p.status === 'sealed' ? 'chip-green' : 'chip-blue'}`}>
              {p.status === 'sealed' ? '已封板' : '扫描中'}
            </span>
            <span className="muted small">
              {p.boxes.length} 箱 · {palletBarcodeTotal(p)} 条
            </span>
          </button>
        ))}
        <div className="btn-row">
          <button type="button" className="btn btn-primary btn-block" onClick={() => setShowNewTask(true)}>
            新建任务
          </button>
        </div>
      </Modal>

      <NewTaskModal
        open={showNewTask}
        onClose={() => setShowNewTask(false)}
        value={taskName}
        onChange={setTaskName}
        onCreate={async () => {
          await newTask(taskName);
          setShowNewTask(false);
          setTaskName('');
          toast('任务已创建，请先添加箱子', 'success');
        }}
      />
    </div>
  );
}

function NewTaskModal({
  open,
  onClose,
  value,
  onChange,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  value: string;
  onChange: (v: string) => void;
  onCreate: () => void | Promise<void>;
}) {
  const limit = useStore((s) => s.settings.maxBoxesPerPallet);
  const updateSettings = useStore((s) => s.updateSettings);
  return (
    <Modal open={open} title="新建任务" onClose={onClose}>
      <label className="field">
        <span className="field-label">任务名（可留空）</span>
        <input
          className="input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`例如：${new Date().toLocaleDateString('zh-CN')} 早班入库`}
        />
      </label>
      <label className="field">
        <span className="field-label">每板箱数上限</span>
        <div className="btn-row">
          {[50, 55, 60].map((n) => (
            <button
              type="button"
              key={n}
              className={`btn ${limit === n ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => updateSettings({ maxBoxesPerPallet: n })}
            >
              {n} 箱
            </button>
          ))}
        </div>
      </label>
      <div className="btn-row">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void onCreate()}>
          创建任务
        </button>
      </div>
    </Modal>
  );
}
