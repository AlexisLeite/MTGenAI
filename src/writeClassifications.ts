import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const ALLOWED = new Set(["Definitely include", "Maybe include", "Definitely exclude"]);

export interface CellClassification {
  excelRow: number;
  classification: string;
}

function attribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return tag.match(new RegExp(`(?:\\s|<)${escaped}="([^"]*)"`))?.[1];
}

function sheetEntry(entries: Record<string, Uint8Array>, sheetName: string): string {
  const workbook = entries["xl/workbook.xml"];
  const relationships = entries["xl/_rels/workbook.xml.rels"];
  if (!workbook || !relationships) throw new Error("El archivo no contiene la estructura esperada de Excel.");

  const sheetTag = (strFromU8(workbook).match(/<sheet\b[^>]*\/>/g) ?? [])
    .find((tag) => attribute(tag, "name") === sheetName);
  const relationId = sheetTag && attribute(sheetTag, "r:id");
  if (!relationId) throw new Error(`No se encontró la pestaña "${sheetName}".`);

  const relationTag = (strFromU8(relationships).match(/<Relationship\b[^>]*\/>/g) ?? [])
    .find((tag) => attribute(tag, "Id") === relationId);
  const target = relationTag && attribute(relationTag, "Target");
  if (!target) throw new Error(`No se encontró el XML de la pestaña "${sheetName}".`);
  return target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join("xl", target));
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function updateSheetXml(xml: string, classifications: Map<number, string>): string {
  const updated = new Set<number>();
  const next = xml.replace(/<row\b[^>]*>[\s\S]*?<\/row>/g, (rowXml) => {
    const openTag = rowXml.match(/^<row\b[^>]*>/)?.[0];
    const rowNumber = Number(openTag && attribute(openTag, "r"));
    const classification = classifications.get(rowNumber);
    if (!classification) return rowXml;

    let foundCell = false;
    const changedRow = rowXml.replace(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g, (cellXml) => {
      const cellTag = cellXml.match(/^<c\b[^>]*>/)?.[0];
      if (!cellTag || attribute(cellTag, "r") !== `J${rowNumber}`) return cellXml;
      foundCell = true;
      const style = attribute(cellTag, "s");
      const styleAttribute = style ? ` s="${style}"` : "";
      return `<c r="J${rowNumber}"${styleAttribute} t="inlineStr"><is><t>${escapeXml(classification)}</t></is></c>`;
    });
    if (!foundCell) throw new Error(`No se encontró la celda J${rowNumber} en el archivo Excel.`);
    updated.add(rowNumber);
    return changedRow;
  });
  if (updated.size !== classifications.size) {
    throw new Error("No se pudieron actualizar todas las filas solicitadas en Excel.");
  }
  return next;
}

export async function writeClassifications(
  filePath: string,
  sheetName: string,
  results: readonly CellClassification[],
): Promise<void> {
  if (results.length === 0) return;
  const classifications = new Map<number, string>();
  for (const result of results) {
    if (!Number.isInteger(result.excelRow) || result.excelRow < 2 || result.excelRow > 62) {
      throw new Error(`La fila ${result.excelRow} está fuera del rango autorizado 2-62.`);
    }
    if (!ALLOWED.has(result.classification)) {
      throw new Error(`Clasificación no permitida en la fila ${result.excelRow}.`);
    }
    if (classifications.has(result.excelRow)) throw new Error(`Fila repetida: ${result.excelRow}.`);
    classifications.set(result.excelRow, result.classification);
  }

  const absolutePath = path.resolve(filePath);
  const entries = unzipSync(await readFile(absolutePath));
  const entry = sheetEntry(entries, sheetName);
  if (!entries[entry]) throw new Error(`No existe ${entry} en el archivo Excel.`);
  entries[entry] = strToU8(updateSheetXml(strFromU8(entries[entry]), classifications));

  const backupPath = absolutePath.replace(/\.xlsx$/i, ".before-classification.xlsx");
  try {
    await copyFile(absolutePath, backupPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const tempPath = `${absolutePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, zipSync(entries));
  await rename(tempPath, absolutePath);
}
