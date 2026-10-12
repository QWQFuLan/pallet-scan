/**
 * 反馈工具：扫描成功声音 + 震动 + Toast，仓库环境戴手套单手操作也能感知。
 */

let audioCtx: AudioContext | null = null;
let muted = false;

/** 设置里关闭「扫描提示音」时调用 */
export function setMuted(value: boolean): void {
  muted = value;
}

function getCtx(): AudioContext | null {
  try {
    if (!audioCtx) {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

/** 用户手势里调用一次，解锁 iOS/Android 的音频权限 */
export function unlockAudio(): void {
  getCtx();
}

function tone(freq: number, durationMs: number, gain = 0.18, type: OscillatorType = 'square'): void {
  if (muted) return;
  const ctx = getCtx();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(gain, ctx.currentTime);
    amp.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
    osc.connect(amp);
    amp.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durationMs / 1000);
  } catch {
    /* 忽略音频错误，不影响扫码 */
  }
}

export const beep = {
  /** 扫码成功：双短音 */
  success(): void {
    tone(1500, 70);
    window.setTimeout(() => tone(2000, 80), 80);
  },
  /** 重复扫描（同条码冷却中）：低音提示 */
  duplicate(): void {
    tone(400, 160, 0.2, 'sawtooth');
  },
  /** 出错 / 卡板已满 */
  error(): void {
    tone(300, 260, 0.22, 'sawtooth');
  },
  /** 封板 */
  seal(): void {
    tone(900, 90);
    window.setTimeout(() => tone(1200, 90), 100);
    window.setTimeout(() => tone(1600, 160), 200);
  },
  tap(): void {
    tone(1000, 40, 0.1, 'sine');
  },
};

export function vibrate(pattern: number | number[] = 60, enabled = true): void {
  if (!enabled) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* 部分浏览器不支持震动 */
  }
}

export function isVibrateSupported(): boolean {
  return typeof navigator !== 'undefined' && 'vibrate' in navigator;
}
