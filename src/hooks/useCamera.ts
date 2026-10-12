import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createDetector,
  isSecureContextOk,
  openCameraWithFallback,
  type DetectorSession,
  type ScanEngineInfo,
} from '@/services/scanner';

/**
 * 摄像头连续扫码 hook。
 *
 * 设计要点（仓库场景稳定优先）：
 *  - 摄像头流自己管理，识别引擎自动选择（BarcodeDetector -> ZXing）。
 *  - 每帧节流解码，避免手机发热掉帧；本帧识别到的多个条码一起上报。
 *  - 同一个条码的重复上报由上层做冷却判断，这里只保证「不丢帧、不刷屏」。
 */

export interface UseCameraReturn {
  videoRef: React.RefObject<HTMLVideoElement>;
  active: boolean;
  starting: boolean;
  error: string | null;
  engine: ScanEngineInfo | null;
  frames: number;
  /** 实际打开的摄像头 id（可能和外部指定的不同：指定的失效时会自动换） */
  actualCameraId: string;
  /** 自动降级提示（例如「原来记住的摄像头已不可用」） */
  fallbackNotice: string | null;
  start: () => Promise<void>;
  stop: () => void;
  restart: () => Promise<void>;
}

interface Options {
  enabled: boolean;
  cameraId?: string;
  onDetect: (code: string) => void;
  onError?: (message: string) => void;
}

const MAX_CANVAS_WIDTH = 800;

export function useCamera({ enabled, cameraId, onDetect, onError }: Options): UseCameraReturn {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<DetectorSession | null>(null);
  const rafRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const strictTimerRef = useRef<number | null>(null);
  const onDetectRef = useRef(onDetect);
  const onErrorRef = useRef(onError);

  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<ScanEngineInfo | null>(null);
  const [frames, setFrames] = useState(0);
  const [actualCameraId, setActualCameraId] = useState('');
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);

  useEffect(() => {
    onDetectRef.current = onDetect;
  }, [onDetect]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const getCanvas = useCallback((): HTMLCanvasElement => {
    if (!canvasRef.current) canvasRef.current = document.createElement('canvas');
    return canvasRef.current;
  }, []);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (strictTimerRef.current !== null) {
      window.clearTimeout(strictTimerRef.current);
      strictTimerRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    generationRef.current += 1;
    stopLoop();
    const stream = streamRef.current;
    stream?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    detectorRef.current?.dispose();
    detectorRef.current = null;
    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        /* 某些浏览器在未播放时 pause 会抛错 */
      }
      video.srcObject = null;
    }
    setActive(false);
    setFrames(0);
  }, [stopLoop]);

  const start = useCallback(async () => {
    if (!isSecureContextOk()) {
      const message =
        '当前不是安全上下文（https 或 localhost），手机浏览器无法调用摄像头。请用 https 地址打开本程序。';
      setError(message);
      onErrorRef.current?.(message);
      return;
    }
    if (starting || active) return;
    setStarting(true);
    setError(null);
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    try {
      const opened = await openCameraWithFallback(cameraId);
      const { stream, fellBack, relaxed, deviceId: actualDeviceId } = opened;
      if (generationRef.current !== generation) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.setAttribute('playsinline', 'true');
        video.muted = true;
        await video.play().catch(() => undefined);
      }
      if (!detectorRef.current) {
        detectorRef.current = await createDetector();
        setEngine(detectorRef.current.info);
      }
      // 记下「真正打开了哪个摄像头」，下次直接用
      setActualCameraId(actualDeviceId);
      // 明确判断三种情况：记住的摄像头失效 / 参数被降级 / 正常
      let notice: string | null = null;
      if (fellBack) {
        notice = cameraId
          ? '原来记住的那个摄像头已不可用，已自动改用默认摄像头（可在设置里重新选择）'
          : '已自动改用默认摄像头';
      } else if (relaxed) {
        notice = '当前摄像头不支持高清参数，已用默认分辨率打开';
      }
      setFallbackNotice(notice);
      setActive(true);
      setStarting(false);

      const canvas = getCanvas();
      const ctx = canvas.getContext('2d', { willReadFrequently: false });
      let lastDecode = 0;
      const interval = detectorRef.current?.info.engine === 'zxing' ? 200 : 130;

      const loop = (timestamp: number) => {
        if (generationRef.current !== generation) return;
        rafRef.current = requestAnimationFrame(loop);
        const el = videoRef.current;
        const session = detectorRef.current;
        if (!el || !session || !ctx) return;
        if (timestamp - lastDecode < interval) return;
        if (el.readyState < 2 || !el.videoWidth) return;
        lastDecode = timestamp;

        const scale = Math.min(1, MAX_CANVAS_WIDTH / el.videoWidth);
        const w = Math.max(1, Math.round(el.videoWidth * scale));
        const h = Math.max(1, Math.round(el.videoHeight * scale));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        try {
          ctx.drawImage(el, 0, 0, w, h);
        } catch {
          return;
        }
        setFrames((f) => (f + 1) % 100000);
        void session.detect(canvas).then((codes) => {
          if (generationRef.current !== generation) return;
          codes.forEach((code) => onDetectRef.current(code));
        });
      };

      rafRef.current = requestAnimationFrame(loop);
    } catch (err) {
      const message = (err as Error)?.message ?? '摄像头打开失败';
      setError(message);
      setStarting(false);
      setActive(false);
      onErrorRef.current?.(message);
    }
  }, [active, cameraId, getCanvas, starting]);

  const restart = useCallback(async () => {
    stop();
    window.setTimeout(() => void start(), 150);
  }, [start, stop]);

  // 组件卸载时释放摄像头
  useEffect(() => stop, [stop]);

  // 外部开关（进入/离开扫码页）
  useEffect(() => {
    if (enabled) {
      void start();
    } else {
      stop();
    }
    // 只在开关变化时执行，避免重复开关摄像头
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // 切换摄像头
  useEffect(() => {
    if (!active) return;
    void restart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId]);

  return {
    videoRef,
    active,
    starting,
    error,
    engine,
    frames,
    actualCameraId,
    fallbackNotice,
    start,
    stop,
    restart,
  };
}
