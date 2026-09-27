import path from "node:path";
import { readSheet as readXlsxSheet } from "read-excel-file/node";

export const DEFAULT_WORKBOOK_PATH = "/repos/mtgenai/docs/Protocolo GenAIDevIssues.xlsx";
export const DEFAULT_SHEET_NAME = "Clasificación Arxiv Alexis";

export type CellValue = string | number | boolean | Date | null;

export interface WorkbookRow {
  excelRow: number;
  values: CellValue[];
}

export interface WorkbookData {
  filePath: string;
  sheetName: string;
  columns: { letter: string; header: string }[];
  rows: WorkbookRow[];
}

function columnLetter(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function normalizeCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}

export async function readLocalWorkbook(
  filePath = DEFAULT_WORKBOOK_PATH,
  sheetName = DEFAULT_SHEET_NAME,
  headerRow = 1,
): Promise<WorkbookData> {
  if (!Number.isInteger(headerRow) || headerRow < 1) {
    throw new Error("headerRow debe ser un número de fila positivo.");
  }

  const absolutePath = path.resolve(filePath);
  let sheet: unknown[][];
  try {
    sheet = await readXlsxSheet(absolutePath, sheetName);
  } catch (error) {
    throw new Error(`No se pudo leer la pestaña "${sheetName}" en ${absolutePath}.`, { cause: error });
  }

  const values = sheet.slice(headerRow - 1);
  const width = Math.max(0, ...values.map((row) => row.length));
  const headers = values[0] ?? [];
  const columns = Array.from({ length: width }, (_, index) => ({
    letter: columnLetter(index),
    header: String(headers[index] ?? ""),
  }));
  const rows = values.slice(1).map((row, index) => ({
    excelRow: headerRow + index + 1,
    values: Array.from({ length: width }, (_, column) => normalizeCell(row[column])),
  }));

  return { filePath: absolutePath, sheetName, columns, rows };
}
