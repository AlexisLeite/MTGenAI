import "dotenv/config";
import { readLocalWorkbook } from "./localWorkbook.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "inspect";
  if (command !== "inspect" && command !== "read") {
    throw new Error("Uso: npm run sheet:inspect | npm run sheet:read");
  }
  const headerRow = Number(process.env.SHEET_HEADER_ROW ?? "1");
  const data = await readLocalWorkbook(
    process.env.XLSX_PATH || undefined,
    process.env.XLSX_SHEET || undefined,
    headerRow,
  );
  if (command === "read") {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    filePath: data.filePath,
    sheetName: data.sheetName,
    columns: data.columns,
    totalRows: data.rows.length,
    sampleRows: data.rows.slice(0, 3).map((row) => ({
      excelRow: row.excelRow,
      values: row.values.map((value) => String(value ?? "").slice(0, 80)),
    })),
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
