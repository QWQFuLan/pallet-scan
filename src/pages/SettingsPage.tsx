import { useEffect, useState } from 'react';
import { useStore } from '@/store';
import { isVibrateSupported, beep, unlockAudio } from '@/services/feedback';
import { getBarcodeDetectorCtor, isSecureContextOk, listCameras, openCameraWithFallback } from '@/services/scanner';
import { LIMIT_OPTIONS } from '@/types';

export default function SettingsPage() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const toast = useStore((s) => s.toast);
  const task = useStore((s) => s.task);
  const renameTask = useStore((s) => s.renameTask);

  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [taskName, setTaskName] = useState(task?.name ?? '');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setTaskName(task?.name ?? '');
  }, [task?.name]);

  useEffect(() => {
    void listCameras().then(setCameras);
  }, []);

  const detector = getBarcodeDetectorCtor();
  const secure = isSecureContextOk();
  const hasGetUserMedia = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  /** 真实打开一次摄像头，把结果原样告诉用户（排查现场问题时最有用） */
  const testCamera = async () => {
    setTesting(true);
    setTestResult(null);
    unlockAudio();
    try {
      const result = await openCameraWithFallback(settings.preferredCameraId);
      const track = result.stream.getVideoTracks()[0];
      const s = track?.getSettings?.() ?? {};
      setTestResult({
        ok: true,
        text: `✅ 摄像头可用：${track?.label || '(无名称)'}｜分辨率 ${s.width ?? '?'}×${s.height ?? '?'}${
          result.fellBack ? '｜原选择的摄像头已失效，已自动改用默认摄像头' : ''
        }${result.relaxed ? '｜降级为默认分辨率' : ''}`,
      });
      // 拿到权限后再刷新一次列表（这时才能看到摄像头名称）
      setCameras(await listCameras());
      result.stream.getTracks().forEach((t) => t.stop());
    } catch (error) {
      setTestResult({ ok: false, text: `❌ ${(error as Error).message}` });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="page">
      <section className="card">
        <h2>扫码与反馈</h2>
        <div className="row-between">
          <span>扫描提示音</span>
          <Toggle
            checked={settings.soundEnabled}
            onChange={(v) => {
              updateSettings({ soundEnabled: v });
              if (v) {
                unlockAudio();
                beep.success();
              }
              toast(v ? '已开启提示音' : '已关闭提示音', 'info');
            }}
          />
        </div>
        <div className="row-between">
          <span>扫描震动 {isVibrateSupported() ? '' : '（本机不支持）'}</span>
          <Toggle
            checked={settings.vibrateEnabled}
            onChange={(v) => {
              updateSettings({ vibrateEnabled: v });
              if (v) navigator.vibrate?.(60);
            }}
          />
        </div>
        <div className="row-between">
          <span>屏幕常亮（扫描时）</span>
          <Toggle checked={settings.keepAwake} onChange={(v) => updateSettings({ keepAwake: v })} />
        </div>
        <div className="row-between">
          <span>进入扫码页自动开始</span>
          <Toggle checked={settings.autoPlayScan} onChange={(v) => updateSettings({ autoPlayScan: v })} />
        </div>
        <label className="field">
          <span className="field-label">同一条码防重复间隔（毫秒）</span>
          <input
            className="input"
            type="number"
            min={300}
            max={5000}
            step={100}
            value={settings.duplicateCooldownMs}
            onChange={(e) => updateSettings({ duplicateCooldownMs: Math.max(300, Number(e.target.value) || 1500) })}
          />
          <span className="muted small">
            间隔内重复扫到同一条码只提示、不重复计数；超过间隔再扫到则数量 +1。
          </span>
        </label>
      </section>

      <section className="card">
        <h2>卡板规则</h2>
        <div className="row-between">
          <span>每板箱数上限</span>
          <div className="btn-row">
            {LIMIT_OPTIONS.map((n) => (
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
        <label className="field">
          <span className="field-label">自定义上限（40~60 箱）</span>
          <input
            className="input"
            type="number"
            min={1}
            max={200}
            value={settings.maxBoxesPerPallet}
            onChange={(e) => updateSettings({ maxBoxesPerPallet: Math.max(1, Number(e.target.value) || 40) })}
          />
          {task && (
            <span className="muted small">
              修改后当前任务的上限会同步更新（当前任务：{task.maxBoxesPerPallet} 箱/板）。
            </span>
          )}
        </label>
        <div className="row-between">
          <span>模式二每层箱数</span>
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
        <label className="field">
          <span className="field-label">卡板号前缀</span>
          <input
            className="input"
            value={settings.palletCodePrefix}
            maxLength={4}
            onChange={(e) => updateSettings({ palletCodePrefix: e.target.value.toUpperCase() || 'P' })}
          />
          <span className="muted small">新任务的卡板号形如 {settings.palletCodePrefix}001。</span>
        </label>
      </section>

      <section className="card">
        <h2>摄像头</h2>
        <label className="field">
          <span className="field-label">选择摄像头</span>
          <select
            className="input"
            value={settings.preferredCameraId}
            onChange={(e) => updateSettings({ preferredCameraId: e.target.value })}
          >
            <option value="">自动（优先后置摄像头）</option>
            {cameras.map((c, i) => (
              <option key={c.deviceId || `cam-${i}`} value={c.deviceId}>
                {c.label || `摄像头 ${i + 1}`}
              </option>
            ))}
          </select>
          <span className="muted small">
            如果之前选的摄像头在当前手机上不存在了，程序会自动改用默认摄像头，不会卡住。
          </span>
        </label>
        <ul className="info-list">
          <li>
            安全上下文：{secure ? '✅ 已满足（https 或 localhost）' : '❌ 未满足，手机无法使用摄像头'}
          </li>
          <li>
            摄像头接口：{hasGetUserMedia ? '✅ 可用' : '❌ 不可用（浏览器太旧或不是 https）'}
          </li>
          <li>
            识别引擎：{detector ? '✅ 原生 BarcodeDetector（一维码 + 二维码）' : '⚙️ ZXing（打包在本地）'}
          </li>
          <li>检测到摄像头数量：{cameras.length}</li>
          <li>离线可用：全部依赖本地打包，无 CDN 请求</li>
        </ul>

        <div className="btn-row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              void listCameras().then((devices) => {
                setCameras(devices);
                toast(devices.length ? `检测到 ${devices.length} 个摄像头` : '没有检测到摄像头', devices.length ? 'success' : 'warn');
              });
            }}
          >
            重新检测摄像头
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void testCamera()} disabled={testing}>
            {testing ? '正在测试…' : '测试摄像头'}
          </button>
        </div>
        {testResult && (
          <div className={`alert ${testResult.ok ? 'alert-ok' : 'alert-warn'}`} style={{ wordBreak: 'break-all' }}>
            {testResult.text}
          </div>
        )}
        {!secure && (
          <div className="alert alert-warn">
            请用 https 地址访问：例如 https://192.168.x.x:5173（详见 README 的 HTTPS 配置）。localhost
            一直被浏览器视为安全上下文。
          </div>
        )}
      </section>

      {task && (
        <section className="card">
          <h2>任务名</h2>
          <div className="manual-form">
            <input className="input" value={taskName} onChange={(e) => setTaskName(e.target.value)} />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                renameTask(taskName);
                toast('任务名已更新', 'success');
              }}
            >
              保存
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <h2>关于</h2>
        <p className="muted small">
          仓库扫码分卡板 · 纯本地离线应用。数据保存在本机浏览器 IndexedDB（数据库名 pallet-scan），
          不含任何联网上传逻辑。刷新页面、关掉浏览器再打开，数据都还在。
        </p>
      </section>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      className={`toggle ${checked ? 'toggle-on' : ''}`}
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
    >
      <span className="toggle-knob" />
    </button>
  );
}
