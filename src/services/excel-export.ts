import * as XLSX from 'xlsx';

export type Row = (string | number)[];

export interface SheetSpec {
  name: string;
  rows: Row[];
  widths?: number[];
}

/** 生成 xlsx 并触发浏览器下载（纯前端，不上传任何数据） */
export function exportSheets(fileName: string, sheets: SheetSpec[]): void {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    if (sheet.widths?.length) ws['!cols'] = sheet.widths.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
  }
  XLSX.writeFile(wb, fileName, { bookType: 'xlsx', compression: true });
}

export function toRows(rows: unknown[][]): Row[] {
  return rows.map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : (cell as string | number))));
}

/** Excel 表格里难免有换行/逗号，统一清洗 */
export function cellText(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
}
