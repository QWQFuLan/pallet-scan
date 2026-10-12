import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { flushPendingWritesNow, useStore } from './store';
import { setMuted } from './services/feedback';

/**
 * 出错时不要留一片空白：把错误显示在页面上，方便现场排查（手机上看不到控制台）。
 */
function showFatal(message: string, detail?: string): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.innerHTML = `
    <div style="min-height:100dvh;padding:20px;background:#0f172a;color:#f1f5f9;
                font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif">
      <h2 style="margin:0 0 8px;font-size:20px">⚠️ 程序启动失败</h2>
      <p style="color:#94a3b8;font-size:15px;line-height:1.5">
        请把下面这段文字截图发给开发者。数据仍在浏览器本地，不会因为报错丢失。
      </p>
      <pre style="white-space:pre-wrap;word-break:break-all;background:#1e293b;border:1px solid #334155;
                  border-radius:10px;padding:12px;font-size:13px;line-height:1.5">${message}${
                    detail ? `\n\n${detail}` : ''
                  }</pre>
      <div style="color:#94a3b8;font-size:13px;line-height:1.7">
        <div>常见原因：</div>
        <div>1. 浏览器版本太旧（建议 Chrome 90+ / iOS 15+ 的 Safari）；</div>
        <div>2. 用 http:// 打开导致部分功能被限制（请用 https:// 电脑IP:5173）；</div>
        <div>3. 浏览器处于无痕模式、禁用了本地存储。</div>
      </div>
      <button onclick="location.reload()"
        style="margin-top:16px;width:100%;padding:14px;border-radius:12px;border:none;
               background:#2563eb;color:#fff;font-size:17px;font-weight:600">重新加载</button>
    </div>`;
}

window.addEventListener('error', (event) => {
  // 资源加载失败（例如缓存了旧的 js 文件名）也提示出来
  const target = event.target as HTMLElement | null;
  if (target && target !== (window as unknown as HTMLElement) && (target.tagName === 'SCRIPT' || target.tagName === 'LINK')) {
    showFatal(
      '页面资源加载失败（可能是浏览器缓存了旧版本）',
      `资源：${(target as HTMLScriptElement).src || (target as HTMLLinkElement).href}\n请强制刷新：手机浏览器里清除本站数据，或用无痕窗口重新打开。`,
    );
    return;
  }
  showFatal(event.message || '未知脚本错误', `${event.filename ?? ''}:${event.lineno ?? 0}`);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as { message?: string; stack?: string } | undefined;
  showFatal(reason?.message ?? String(event.reason), reason?.stack);
});

try {
  // 首次进入就初始化本地数据（IndexedDB -> store）
  void useStore
    .getState()
    .init()
    .then(() => {
      setMuted(!useStore.getState().settings.soundEnabled);
    })
    .catch((error: Error) => {
      // 数据库打不开也先把界面渲染出来（只读可用），并提示数据无法保存
      console.warn('本地数据库初始化失败：', error);
      useStore.setState({ ready: true });
      useStore
        .getState()
        .toast(`本地数据库不可用（${error.message}），数据将无法保存`, 'error');
    });

  // 页面隐藏/关闭前把排队中的写入立刻落盘，保证「刷新页面数据不丢」
  const flush = () => {
    try {
      flushPendingWritesNow();
    } catch {
      /* 忽略：落盘失败不应该阻塞页面关闭 */
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);

  const container = document.getElementById('root');
  if (!container) throw new Error('页面结构异常：找不到 #root 节点');

  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} catch (error) {
  showFatal((error as Error).message, (error as Error).stack);
}
