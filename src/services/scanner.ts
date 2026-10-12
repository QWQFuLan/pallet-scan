import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

/**
 * 摄像头连续扫码。
 *
 * 优先使用浏览器原生 BarcodeDetector（Android Chrome 上最快、最省电，支持一维码 + 二维码）；
 * 不支持时自动降级到打包在本地的 ZXing（@zxing/browser），完全离线，不依赖任何 CDN。
 *
 * 安全上下文要求：getUserMedia 只在 https 或 localhost 下可用。
 */

export interface ScanEngineInfo {
  engine: 'barcode-detector' | 'zxing';
  formats: string[];
}

interface DetectedBarcodeLike {
  rawValue: string;
  format?: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcodeLike[]>;
}

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

const WANTED_1D = ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar', 'code_93'];
const WANTED_2D = ['qr_code', 'data_matrix', 'pdf417', 'aztec'];

export function getBarcodeDetectorCtor(): BarcodeDetectorCtor | null {
  const ctor = (globalThis as any).BarcodeDetector as BarcodeDetectorCtor | undefined;
  return ctor ?? null;
}

export function isSecureContextOk(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return window.isSecureContext || host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}

export interface CameraConstraints {
  deviceId?: string;
}

export function buildConstraints(preferredCameraId?: string): MediaStreamConstraints {
  const video: MediaTrackConstraints = {
    facingMode: preferredCameraId ? undefined : { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    // @ts-expect-error 非标准但移动端常用
    focusMode: 'continuous',
  };
  if (preferredCameraId) {
    video.deviceId = { exact: preferredCameraId };
    delete video.facingMode;
  }
  return { video, audio: false };
}

/** 当前可用的摄像头 id 列表（没有权限时也能拿到 id，只是 label 为空） */
async function availableCameraIds(): Promise<string[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d) => d.deviceId)
      .filter((id) => id && id.length > 0);
  } catch {
    return [];
  }
}

export interface OpenCameraResult {
  stream: MediaStream;
  /** 实际使用的 deviceId（可能和传入的不同：传入的失效时会自动换一个） */
  deviceId: string;
  /** 传入的 deviceId 失效、已自动改用默认摄像头 */
  fellBack: boolean;
  /** 降级到最宽松的约束 */
  relaxed: boolean;
}

/**
 * 打开摄像头。
 *
 * 逐级降级（手机现场最怕「一开就失败」）：
 *   1) 指定的摄像头（先校验 deviceId 是否还存在，失效就直接跳过，避免 NotFoundError）
 *   2) 后置摄像头（facingMode: environment）
 *   3) 只带分辨率偏好
 *   4) 完全默认（video: true）
 * 每一步失败都记录下来，最后抛出「最接近成功」的那个错误，并把错误名一起带上，方便排查。
 */
export async function openCameraWithFallback(preferredCameraId?: string): Promise<OpenCameraResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'NOT_SUPPORTED：当前浏览器不支持摄像头。需要用 https:// 打开（或 localhost），并且浏览器版本不要太旧。',
    );
  }

  const ids = await availableCameraIds();
  const wanted = (preferredCameraId ?? '').trim();
  const wantedValid = !!wanted && (ids.length === 0 || ids.includes(wanted));

  // 需要标记「已降级」的尝试：设备列表里能查到、且指定的设备确实不在列表里
  const replacedIds = new Set<string>();
  const attempts: { label: string; constraints: MediaStreamConstraints; fellBack?: boolean; relaxed?: boolean }[] = [];
  if (wantedValid) {
    const knownMissing = ids.length > 0 && !ids.includes(wanted);
    if (knownMissing) replacedIds.add(wanted);
    attempts.push({
      label: '指定摄像头',
      constraints: buildConstraints(wanted),
      fellBack: knownMissing,
    });
  }
  attempts.push({
    label: '后置摄像头',
    constraints: { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
    fellBack: !!wanted,
  });
  attempts.push({
    label: '默认分辨率',
    constraints: { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
    fellBack: !!wanted,
    relaxed: true,
  });
  attempts.push({ label: '浏览器默认', constraints: { video: true, audio: false }, fellBack: !!wanted, relaxed: true });

  const errors: { label: string; error: { name?: string; message?: string } }[] = [];
  for (const attempt of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(attempt.constraints);
      const track = stream.getVideoTracks()[0];
      const settingsDeviceId = track?.getSettings?.().deviceId ?? '';
      // 有些浏览器不会因为 deviceId 不存在而报错，而是静默换成另一个摄像头。
      // 先用设备列表判断；列表查不到时，看下次是否能再打开同一个设备来确认。
      let switched = attempt.fellBack === true;
      if (!switched && wanted && settingsDeviceId && settingsDeviceId !== wanted) {
        switched = replacedIds.has(wanted) || (await canOpenDevice(settingsDeviceId));
      }
      return {
        stream,
        deviceId: settingsDeviceId || wanted,
        fellBack: switched,
        relaxed: attempt.relaxed === true,
      };
    } catch (error) {
      errors.push({ label: attempt.label, error: error as { name?: string; message?: string } });
      // 权限被拒绝就没必要继续试了
      if ((error as { name?: string })?.name === 'NotAllowedError') break;
    }
  }

  const preferredError =
    errors.find((e) => e.label === '后置摄像头') ?? errors[0] ?? { label: '', error: {} };
  const detailed = errors.map((e) => `${e.label}: ${e.error.name ?? 'Error'} ${e.error.message ?? ''}`).join('；');
  throw normalizeCameraError(preferredError.error, detailed);
}

/** 这个 deviceId 现在还能不能打开（用来确认「记住的摄像头是否失效」） */
async function canOpenDevice(deviceId: string): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } }, audio: false });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

/** 兼容旧调用：只关心拿到的流 */
export async function openCamera(preferredCameraId?: string): Promise<MediaStream> {
  const result = await openCameraWithFallback(preferredCameraId);
  return result.stream;
}

export function normalizeCameraError(error: unknown, detail?: string): Error {
  const err = error as { name?: string; message?: string };
  const suffix = detail ? `（${detail}）` : '';
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new Error(
        `摄像头权限被拒绝：请在浏览器里允许「摄像头」，并确认访问的是 https 地址${suffix}`,
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new Error(
        `没有找到可用摄像头（NotFound/Overconstrained）：请检查手机相机是否被其他应用占用，或在设置里手动选择摄像头${suffix}`,
      );
    case 'NotReadableError':
    case 'TrackStartError':
      return new Error(`摄像头被其他应用占用：请关闭相机、微信视频等应用后重试${suffix}`);
    case 'AbortError':
      return new Error(`摄像头启动被中断：请重新点一次「开始扫描」${suffix}`);
    default:
      return new Error(
        err?.message ? `摄像头打开失败：${err.name ?? ''} ${err.message}${suffix}` : `摄像头打开失败${suffix}`,
      );
  }
}

export interface DetectorSession {
  info: ScanEngineInfo;
  /** 扫描一帧画面，返回本帧识别到的所有条码 */
  detect(source: CanvasImageSource): Promise<string[]>;
  dispose(): void;
}

/** 创建识别引擎（自动选择原生或 ZXing） */
export async function createDetector(): Promise<DetectorSession> {
  const ctor = getBarcodeDetectorCtor();
  if (ctor) {
    try {
      let formats: string[] = [];
      if (typeof ctor.getSupportedFormats === 'function') {
        const supported = await ctor.getSupportedFormats();
        formats = [...WANTED_1D, ...WANTED_2D].filter((f) => supported.includes(f));
      }
      const detector = new ctor(formats.length ? { formats } : undefined);
      return {
        info: { engine: 'barcode-detector', formats },
        async detect(source) {
          try {
            const results = await detector.detect(source);
            return results.map((r) => (r.rawValue || '').trim()).filter(Boolean);
          } catch {
            return [];
          }
        },
        dispose() {
          /* 原生 API 无需释放 */
        },
      };
    } catch {
      /* 继续降级到 ZXing */
    }
  }

  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.CODE_128,
    BarcodeFormat.CODE_39,
    BarcodeFormat.CODE_93,
    BarcodeFormat.EAN_13,
    BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A,
    BarcodeFormat.UPC_E,
    BarcodeFormat.ITF,
    BarcodeFormat.CODABAR,
    BarcodeFormat.QR_CODE,
    BarcodeFormat.DATA_MATRIX,
    BarcodeFormat.PDF_417,
    BarcodeFormat.AZTEC,
  ]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new BrowserMultiFormatReader(hints as any, { delayBetweenScanAttempts: 80 });

  return {
    info: { engine: 'zxing', formats: ['1D', 'QR', 'DataMatrix', 'PDF417'] },
    async detect(source) {
      try {
        const result = reader.decodeFromCanvas(source as HTMLCanvasElement);
        const text = (result?.getText?.() || '').trim();
        return text ? [text] : [];
      } catch {
        // NotFoundException 属于正常情况（本帧没有条码）
        return [];
      }
    },
    dispose() {
      // ZXing 的 BrowserCodeReader 没有公开的释放方法；摄像头流由 useCamera 统一停止，
      // 这里只做空实现，保持与原生引擎一致的接口。
    },
  };
}
