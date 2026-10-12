import { useEffect, useRef, useState } from 'react';
import { useCamera } from '@/hooks/useCamera';
import { unlockAudio } from '@/services/feedback';
import { isSecureContextOk, listCameras } from '@/services/scanner';

/**
 * 复用的扫码面板：摄像头预览 + 开始/暂停 + 手动输入 + 切换摄像头。
 *
 * 同一个面板会用在两个地方：
 *  - 扫「箱子型号」（添加箱子弹窗里）
 *  - 扫「箱内条码」（主扫码区）
 * 扫码结果统一交给 onDetect，由调用方决定怎么处理（型号 / 条码）。
 */

export interface ScannerPanelProps {
  /** 面板是否处于「要扫码」的状态（false 时关闭摄像头省电） */
  active: boolean;
  onDetect: (code: string) => void;
  /** 结果提示文案，例如「已记录 SN-000001（B001 第 3 条）」 */
  hint?: string;
  /** 手动输入框的占位文字 */
  placeholder?: string;
  /** 面板标题，例如「扫描这一箱的型号」 */
  title?: string;
  /** 紧凑模式（弹窗里用，高度小一点） */
  compact?: boolean;
  /** 摄像头无法使用时的替代方案文字（例如「也可以手动输入型号」） */
  fallbackHint?: string;
  /** 自动开始（进入面板就打开摄像头） */
  autoStart?: boolean;
  /** 每次扫码后的处理交给调用方，这里只负责清空输入框 */
  onManualSubmit?: (code: string) => void;
}

export function ScannerPanel({
  active,
  onDetect,
  hint,
  placeholder = '手动输入后回车',
  title,
  compact,
  fallbackHint,
  autoStart = false,
}: ScannerPanelProps) {
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState('');
  const [cameraCount, setCameraCount] = useState(0);
  const [preferredCameraId, setPreferredCameraId] = useState('');
  const startedOnce = useRef(false);
  const secure = isSecureContextOk();

  const camera = useCamera({
    enabled: active && scanning,
    cameraId: preferredCameraId,
    onDetect,
  });

  // 只探测「有几个摄像头」，不自动把某个 id 记下来 ——
  // 否则一处失效就变成「打开失败」，让用户以为程序坏了。
  // 想固定用某个摄像头时，在设置页里手动选择（那个值才是用户确认过的）。
  useEffect(() => {
    void listCameras().then((devices) => setCameraCount(devices.length));
  }, []);

  // 面板进入时自动开始（弹窗里体验更好）
  useEffect(() => {
    if (!active) {
      setScanning(false);
      startedOnce.current = false;
      return;
    }
    if (autoStart && !startedOnce.current) {
      startedOnce.current = true;
      unlockAudio();
      setScanning(true);
    }
  }, [active, autoStart]);

  const submitManual = () => {
    const code = manual.trim();
    if (!code) return;
    setManual('');
    onDetect(code);
  };

  return (
    <div
      className={`scanner-panel ${compact ? 'scanner-compact' : ''}`}
      data-active={active ? '1' : '0'}
      data-scanning={scanning ? '1' : '0'}
      data-camera={camera.active ? '1' : '0'}
      data-camera-error={camera.error ?? ''}
      data-fallback-notice={camera.fallbackNotice ?? ''}
      data-actual-camera={camera.actualCameraId}
    >
      {title && <div className="label">{title}</div>}

      <div className="scan-stage" style={compact ? { aspectRatio: '16 / 10', maxHeight: '26vh' } : undefined}>
        <video
          ref={camera.videoRef}
          className={`scan-video ${camera.active ? '' : 'hidden'}`}
          data-ready={camera.active ? '1' : '0'}
          data-engine={camera.engine?.engine ?? ''}
          playsInline
          muted
        />
        {!camera.active && (
          <div className="scan-placeholder">
            <div className="scan-placeholder-icon">📷</div>
            <p>
              {!active
                ? '当前不需要扫码'
                : scanning
                  ? camera.starting
                    ? '正在启动摄像头…'
                    : '准备中…'
                  : secure
                    ? '点「开始扫描」调用摄像头'
                    : '当前不是安全上下文，无法调用摄像头'}
            </p>
            {camera.error && <p className="error-text camera-error">{camera.error}</p>}
            {!secure && (
              <p className="error-text">
                必须用 https:// 或 localhost 打开。手机请访问 https://电脑IP:5173
              </p>
            )}
            {camera.fallbackNotice && <p className="muted small">{camera.fallbackNotice}</p>}
            {fallbackHint && <p className="muted small">{fallbackHint}</p>}
            {active && (camera.error || scanning) && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  unlockAudio();
                  setScanning(true);
                  void camera.restart();
                }}
              >
                重试打开摄像头
              </button>
            )}
          </div>
        )}
        {camera.active && (
          <>
            <div className="scan-frame" />
            <div className="scan-hint">
              {camera.engine?.engine === 'barcode-detector' ? '原生识别' : 'ZXing 识别'} · 对准条码自动识别
            </div>
          </>
        )}
      </div>

      {camera.active && camera.fallbackNotice && (
        <div className="muted small" style={{ marginTop: 6 }}>
          {camera.fallbackNotice}
        </div>
      )}

      {hint && <div className="last-code">{hint}</div>}

      <div className="btn-row" style={{ marginTop: 10 }}>
        {!scanning ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!active}
            onClick={() => {
              unlockAudio();
              setScanning(true);
            }}
          >
            开始扫描
          </button>
        ) : (
          <button type="button" className="btn btn-warn" onClick={() => setScanning(false)}>
            暂停扫描
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          disabled={cameraCount < 2}
          onClick={() => {
            void listCameras().then((devices) => {
              if (devices.length < 2) return;
              const index = devices.findIndex((d) => d.deviceId === preferredCameraId);
              const next = devices[(index + 1) % devices.length];
              setPreferredCameraId(next.deviceId);
            });
          }}
        >
          切换摄像头
        </button>
      </div>

      <form
        className="manual-form"
        onSubmit={(e) => {
          e.preventDefault();
          submitManual();
        }}
      >
        <input
          className="input"
          autoComplete="off"
          placeholder={active ? placeholder : '当前不需要扫码'}
          value={manual}
          disabled={!active}
          onChange={(e) => setManual(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={!active}>
          添加
        </button>
      </form>
    </div>
  );
}
