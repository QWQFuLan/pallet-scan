/**
 * 条码识别引擎自检（无需摄像头）：
 *   用 ZXing 的编码器生成 Code128 / EAN-13 / QR 的位图，
 *   再走项目里真正使用的那条解码链路（scanner.ts 的 ZXing 分支、decodeFromCanvas）
 *   还原成文本，验证「一维码 + 二维码」识别链路可用。
 *
 * 摄像头取帧（getUserMedia）无法在无摄像头环境自动验证，这里验证的是「一帧图像 -> 条码文本」。
 */
import { createDetector } from '@/services/scanner';

declare const require: (id: string) => any;

const zxing = require('@zxing/library');

export interface BarcodeTestResult {
  passed: number;
  failures: string[];
}

/** 把 ZXing 的 BitMatrix 转成「假 canvas」 */
function canvasFromBits(bits: { get: (x: number, y: number) => boolean; getWidth: () => number; getHeight: () => number }, scale = 3, quiet = 4) {
  const bw = bits.getWidth();
  const bh = bits.getHeight();
  const width = (bw + quiet * 2) * scale;
  const height = (bh + quiet * 2) * scale;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const bx = Math.floor(x / scale) - quiet;
      const by = Math.floor(y / scale) - quiet;
      const dark = bx >= 0 && by >= 0 && bx < bw && by < bh && bits.get(bx, by);
      if (!dark) continue;
      const idx = (y * width + x) * 4;
      data[idx] = 0;
      data[idx + 1] = 0;
      data[idx + 2] = 0;
    }
  }
  return {
    width,
    height,
    nodeName: 'CANVAS',
    getContext: () => ({
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data, width: w, height: h }),
    }),
  } as unknown as HTMLCanvasElement;
}

// CJS 版本的 @zxing/library 只导出部分 Writer（没有一维码编码器），
// 所以一维码和二维码都用 bwip-js 生成（仅测试用的开发依赖）。
const bwip = require('bwip-js');

/**
 * bwip-js 的 toBuffer 返回 PNG，这里做一个最小 PNG 解码
 * （仅支持 bitdepth=8、colortype=6、非隔行，也就是 bwip-js 的输出格式），
 * 然后转成 ZXing 能读的「假 canvas」。
 */
async function canvasFromBwip(bcid: string, text: string, scale = 3): Promise<HTMLCanvasElement> {
  const png = (await bwip.toBuffer({
    bcid,
    text,
    scale,
    height: 20,
    includetext: false,
    paddingwidth: 12,
    paddingheight: 4,
  })) as Buffer;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bitDepth = png[24];
  const colorType = png[25];
  const interlace = png[28];
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`不支持的 PNG 格式：depth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
  }

  // 收集 IDAT
  const chunks: Buffer[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.slice(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') chunks.push(png.slice(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  const zlib = require('node:zlib') as typeof import('node:zlib');
  const raw = zlib.inflateSync(Buffer.concat(chunks));

  // 反滤波（每行 1 字节滤波器 + width*4 字节 RGBA）
  const stride = width * 4;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = line[x];
      const left = x >= 4 ? data[y * stride + x - 4] : 0;
      const up = y > 0 ? data[prevStart + x] : 0;
      const upLeft = y > 0 && x >= 4 ? data[prevStart + x - 4] : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + left;
          break;
        case 2:
          value = rawByte + up;
          break;
        case 3:
          value = rawByte + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = rawByte + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          value = rawByte;
      }
      data[y * stride + x] = value & 0xff;
    }
  }

  return {
    width,
    height,
    nodeName: 'CANVAS',
    getContext: () => ({
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data, width: w, height: h }),
    }),
  } as unknown as HTMLCanvasElement;
}

function makeCode128(text: string): Promise<HTMLCanvasElement> {
  return canvasFromBwip('code128', text, 3);
}

function makeEan13(text: string): Promise<HTMLCanvasElement> {
  return canvasFromBwip('ean13', text, 4);
}

function makeQr(text: string): Promise<HTMLCanvasElement> {
  return canvasFromBwip('qrcode', text, 4);
}

export async function runBarcodeTests(): Promise<BarcodeTestResult> {
  const failures: string[] = [];
  let passed = 0;
  const check = (name: string, ok: unknown, extra?: unknown) => {
    if (ok) passed += 1;
    else failures.push(`${name}${extra === undefined ? '' : ` -> ${JSON.stringify(extra)}`}`);
  };

  // 强制走 ZXing 分支（无摄像头、无原生 BarcodeDetector 的环境）
  const detector = await createDetector();
  check('识别引擎可用', !!detector);
  check('使用 ZXing 分支', detector.info.engine === 'zxing', detector.info.engine);

  // 1) Code128（仓库最常用的一维码）
  const code128Text = '6901234567892';
  const code128 = await detector.detect(await makeCode128(code128Text));
  check('Code128 可识别', code128[0] === code128Text, code128);

  // 2) 非数字的一维码（内部物料编码）
  const sku = 'ABC-1001-XYZ';
  const code128b = await detector.detect(await makeCode128(sku));
  check('Code128 含字母可识别', code128b[0] === sku, code128b);

  // 3) EAN-13
  const ean = await detector.detect(await makeEan13('6901234567892'));
  check('EAN-13 可识别', ean[0] === '6901234567892', ean);

  // 4) 二维码
  const qrText = 'PALLET-P001-BOX12';
  const qr = await detector.detect(await makeQr(qrText));
  check('二维码可识别', qr[0] === qrText, qr);

  // 5) 空白画面不应误报（防止把噪点当成条码）
  const blank = {
    width: 300,
    height: 200,
    getContext: () => ({
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4).fill(255),
        width: w,
        height: h,
      }),
    }),
  } as unknown as HTMLCanvasElement;
  const nothing = await detector.detect(blank);
  check('空白画面不误报', nothing.length === 0, nothing);

  // 6) 同一帧连续解码稳定（模拟连续扫描）
  const repeated = await makeCode128(code128Text);
  let hits = 0;
  for (let i = 0; i < 3; i += 1) {
    const found = await detector.detect(repeated);
    if (found[0] === code128Text) hits += 1;
  }
  check('连续解码稳定', hits === 3, hits);

  detector.dispose();
  return { passed, failures };
}
