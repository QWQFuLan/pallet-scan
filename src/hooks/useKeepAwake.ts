import { useEffect, useRef, useState } from 'react';

/**
 * 屏幕常亮（Wake Lock API）。浏览器不支持或用户拒绝时给出提示。
 */
export function useKeepAwake(enabled: boolean): { supported: boolean; active: boolean; message: string } {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  const sentinelRef = useRef<any>(null);
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!supported) {
      setMessage('当前浏览器不支持屏幕常亮（Wake Lock），请手动把系统休眠时间调长。');
      return;
    }
    let cancelled = false;

    const request = async () => {
      try {
        const sentinel = await (navigator as any).wakeLock.request('screen');
        if (cancelled) {
          void sentinel.release?.();
          return;
        }
        sentinelRef.current = sentinel;
        setActive(true);
        setMessage('');
        sentinel.addEventListener?.('release', () => setActive(false));
      } catch (error) {
        setActive(false);
        setMessage(`屏幕常亮申请失败：${(error as Error).message}`);
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && enabled) void request();
    };

    if (enabled) {
      void request();
      document.addEventListener('visibilitychange', onVisibility);
    } else {
      void sentinelRef.current?.release?.();
      sentinelRef.current = null;
      setActive(false);
    }

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (!enabled) return;
      void sentinelRef.current?.release?.();
      sentinelRef.current = null;
    };
  }, [enabled, supported]);

  return { supported, active, message };
}
