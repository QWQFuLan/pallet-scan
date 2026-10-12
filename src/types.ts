/** 任务状态 */
export type TaskStatus = 'scanning' | 'finished';

/** 卡板状态 */
export type PalletStatus = 'scanning' | 'sealed';

/** 扫码记录状态：ok 正常 / manual 手动录入 / sealed 封板后补录 */
export type ScanStatus = 'ok' | 'manual' | 'sealed';

/** 箱状态：scanning 正在扫条码 / sealed 已封箱 */
export type BoxStatus = 'scanning' | 'sealed';

/**
 * 条码（一个箱子里的一件物品）。
 * 一件物品只有一个条码，条码在同一个箱子里唯一。
 */
export interface Barcode {
  id: string;
  /** 条码/编号内容 */
  code: string;
  /** 箱内顺序（1 起） */
  index: number;
  scannedAt: number;
  /** 内部排序号（用于判断「最近扫的那一条」） */
  seq: number;
  note?: string;
  status: ScanStatus;
}

/**
 * 箱（模式一的核心单位）：
 *  - 一个箱子一个型号（Model），每加一箱都要重新扫一次型号；
 *  - 一箱大约 20 条条码；
 *  - 先封箱，再封板。
 */
export interface Box {
  id: string;
  palletId: string;
  /** 箱号，例如 B001（板内序号） */
  code: string;
  /** 板内第几箱，1 起 */
  index: number;
  status: BoxStatus;
  /** 该箱型号（Model） */
  model: string;
  /** 箱内条码 */
  barcodes: Barcode[];
  /** 条码数量 = barcodes.length */
  totalBarcodes: number;
  createdAt: number;
  sealedAt?: number;
  note?: string;
}

/** 卡板：一板 50~60 箱 */
export interface Pallet {
  id: string;
  taskId: string;
  /** 例如 P001 */
  code: string;
  /** 第几板，1 起 */
  index: number;
  status: PalletStatus;
  boxes: Box[];
  /** 箱数 = boxes.length */
  totalBoxes: number;
  /** 条码总数 = 各箱条码数之和 */
  totalBarcodes: number;
  createdAt: number;
  sealedAt?: number;
  note?: string;
  /** 模式二使用：本板内每箱的堆放层号（1 = 最底层） */
  layerIndex?: number;
}

/** 任务 */
export interface Task {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  status: TaskStatus;
  /** 每板箱数上限，默认 60（可配置 50/55/60） */
  maxBoxesPerPallet: number;
  pallets: Pallet[];
  finishedAt?: number;
  /** 卡板号前缀（保存在任务里，保证导入导出后号码一致） */
  __prefix?: string;
}

/** 任务元信息（不含卡板明细，用于历史列表） */
export interface TaskMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  status: TaskStatus;
  maxBoxesPerPallet: number;
  palletCount: number;
  totalBoxes: number;
}

/** 货单项 */
export interface OrderItem {
  barcode: string;
  qty: number;
  name?: string;
  /** 型号（货单里有型号列时带上） */
  model?: string;
  remark?: string;
  /** 货单里的原始行号，用于同数量时保持货单顺序 */
  orderIndex: number;
  matchedPalletCode?: string;
  status: 'matched' | 'unmatched' | 'qty_mismatch';
  /** 模式一中该条码的总数量，用于差异对比 */
  sourceQty?: number;
}

/** 从模式一导出的 Excel 中解析出的一条条码明细 */
export interface ImportedBarcode {
  palletCode: string;
  /** 箱号，例如 B001；老文件可能没有 */
  boxCode?: string;
  /** 箱序号（板内第几箱） */
  boxIndex?: number;
  /** 箱内序号 */
  itemIndex?: number;
  /** 条码/编号 */
  barcode: string;
  /** 型号（现在挂在箱上，导出时每行都带上） */
  model?: string;
  /** 数量：一件一行时恒为 1（兼容按箱计数的老数据） */
  qty: number;
  scannedAt?: number;
  note?: string;
}

export interface ImportedScanData {
  fileName: string;
  headers: string[];
  /** 逐条条码明细 */
  items: ImportedBarcode[];
  palletCount: number;
  /** 箱数 */
  boxCount: number;
  /** 条码总数 */
  barcodeCount: number;
}

export interface ImportedOrderData {
  fileName: string;
  headers: string[];
  items: OrderItem[];
  totalQty: number;
  barcodeCount: number;
}

/** 条码 -> 卡板 的映射信息（含冲突提示） */
export interface BarcodePalletMap {
  barcode: string;
  palletCode: string;
  /** 模式一中该条码出现在这个卡板的箱数 */
  qtyInPallet: number;
  /** 该条码在模式一中出现过的全部卡板 */
  allPallets: { palletCode: string; qty: number }[];
  conflict: boolean;
}

/** 已堆放到目标卡板上的箱 */
export interface PickBox {
  id: string;
  palletCode: string;
  /** 卡板内堆放顺序，1 起（先底层后上层） */
  stackOrder: number;
  layerIndex: number;
  layerOrder: number;
  barcode: string;
  qty: number;
  name?: string;
  remark?: string;
  palletBoxLimit: number;
  overflowFrom?: string;
}

export interface PickPallet {
  palletCode: string;
  index: number;
  totalBoxes: number;
  barcodeKinds: number;
  layerCount: number;
  boxes: PickBox[];
  /** 底层 -> 顶层 的层摘要 */
  layerSummary: { layerIndex: number; label: string }[];
  /** 该卡板是否为超限拆分出来的 */
  isSplit: boolean;
  overflowFrom?: string;
  sourcePalletCode: string;
}

export type AnomalyType =
  | 'unmatched'
  | 'qty_mismatch'
  | 'conflict'
  | 'overflow_split'
  | 'same_barcode_multi_pallet';

export interface Anomaly {
  type: AnomalyType;
  barcode: string;
  name?: string;
  palletCode?: string;
  detail: string;
  orderQty?: number;
  sourceQty?: number;
}

export interface AllocationResult {
  createdAt: number;
  orderFileName: string;
  scanFileName: string;
  maxBoxesPerPallet: number;
  boxesPerLayer: number;
  pallets: PickPallet[];
  anomalies: Anomaly[];
  barcodeMap: BarcodePalletMap[];
  /** 卡板超限拆分记录 */
  splits: SplitRecord[];
  stats: {
    orderTotalQty: number;
    allocatedQty: number;
    palletCount: number;
    splitPalletCount: number;
    unmatchedCount: number;
    mismatchCount: number;
    conflictCount: number;
  };
}

export interface SplitRecord {
  from: string;
  to: string;
  movedQty: number;
  detail: string;
}

export interface AppSettings {
  /** 每板箱数上限（一板 50~60 箱） */
  maxBoxesPerPallet: number;
  /** 一层的箱数，用于计算模式二 layerIndex */
  boxesPerLayer: number;
  palletCodePrefix: string;
  boxCodePrefix: string;
  duplicateCooldownMs: number;
  soundEnabled: boolean;
  vibrateEnabled: boolean;
  keepAwake: boolean;
  preferredCameraId: string;
  autoPlayScan: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  maxBoxesPerPallet: 60,
  boxesPerLayer: 5,
  palletCodePrefix: 'P',
  boxCodePrefix: 'B',
  duplicateCooldownMs: 1500,
  soundEnabled: true,
  vibrateEnabled: true,
  keepAwake: true,
  preferredCameraId: '',
  autoPlayScan: true,
};

/** 每板箱数上限的可选项 */
export const LIMIT_OPTIONS = [50, 55, 60];

export const STATUS_COLOR: Record<OrderItem['status'], string> = {
  matched: '#16a34a',
  unmatched: '#dc2626',
  qty_mismatch: '#d97706',
};
