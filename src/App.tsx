import { useEffect, useMemo } from 'react';
import { useStore, palletBarcodeTotal, type TabKey } from '@/store';import Mode1Page from '@/pages/Mode1Page';
import Mode2Page from '@/pages/Mode2Page';
import DataPage from '@/pages/DataPage';
import SettingsPage from '@/pages/SettingsPage';
import { ToastHost } from '@/components/Modal';
import { useKeepAwake } from '@/hooks/useKeepAwake';

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'mode1', label: '扫码建板', icon: '📷' },
  { key: 'mode2', label: '按单配板', icon: '📦' },
  { key: 'data', label: '数据导出', icon: '📤' },
  { key: 'settings', label: '设置', icon: '⚙️' },
];

export default function App() {
  const ready = useStore((s) => s.ready);
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const task = useStore((s) => s.task);
  const keepAwake = useStore((s) => s.settings.keepAwake);
  const scanning = useStore((s) => s.scanning);
  const revision = useStore((s) => s.revision);

  useKeepAwake(keepAwake && scanning);

  // main.tsx 里已经调用过 init()，这里只处理异常情况：
  // 如果本地数据库打不开（隐私模式/存储被禁用），也不能让界面卡在「正在读取数据」。
  useEffect(() => {
    if (ready) return;
    const timer = window.setTimeout(() => {
      const state = useStore.getState();
      if (state.ready) return;
      void state
        .init()
        .catch(() => undefined)
        .finally(() => {
          const current = useStore.getState();
          if (!current.ready) {
            useStore.setState({ ready: true });
            current.toast('本地数据库不可用（可能处于无痕模式），数据将无法保存', 'error');
          }
        });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [ready]);

  const totalBoxes = useMemo(
    () => (task ? task.pallets.reduce((sum, p) => sum + palletBarcodeTotal(p), 0) : 0),
    [task, revision],
  );

  if (!ready) {
    return (
      <div className="app-loading">
        <div className="spinner" />
        <p>正在读取本地数据…</p>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <strong>仓库扫码分卡板</strong>
          <span className="app-sub">
            {task ? `${task.name} · ${task.pallets.length} 板 · ${totalBoxes} 箱` : '未创建任务'}
          </span>
        </div>
        <span className="badge-offline" title="所有数据只保存在本机浏览器">
          本地离线
        </span>
      </header>

      <main className="app-main">
        {tab === 'mode1' && <Mode1Page />}
        {tab === 'mode2' && <Mode2Page />}
        {tab === 'data' && <DataPage />}
        {tab === 'settings' && <SettingsPage />}
      </main>

      <nav className="tabbar">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`tab ${tab === item.key ? 'tab-active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            <span className="tab-icon">{item.icon}</span>
            <span className="tab-label">{item.label}</span>
          </button>
        ))}
      </nav>

      <ToastHost />
    </div>
  );
}
