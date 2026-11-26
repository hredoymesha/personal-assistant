import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import type { PDFDocument as PDFDocumentType, PDFFont, PDFPage } from 'pdf-lib';
import * as XLSX from 'xlsx';
import { formatMoney, toDecimalString } from '../domain/money';
import type { DailyExpenseEntry, DailyExpenseField, DailyExpenseSheet, ReceiptAttachment } from '../domain/types';
import { base64Decode } from '../crypto/bytes';
import { exportBinaryFile } from './files';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Excel refuses worksheet names with : \ / ? * [ ] and anything over 31 characters.
export function worksheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '').slice(0, 31).trim();
  const reserved = ['receipts', 'history'];
  return cleaned && !reserved.includes(cleaned.toLowerCase()) ? cleaned : 'Expenses';
}

function columns(fields: DailyExpenseField[]): string[] {
  return ['Date', 'Place', 'Amount', 'Currency', 'Note', ...fields.map((field) => field.name)];
}

function rows(sheet: DailyExpenseSheet, entries: DailyExpenseEntry[], fields: DailyExpenseField[]): string[][] {
  const output: string[][] = [columns(fields)];
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  let currentDate: string | null = null;
  for (const entry of sorted) {
    if (currentDate && currentDate !== entry.date) {
      output.push(['', `Total for ${currentDate}`, dailyTotals(sorted.filter((item) => item.date === currentDate)).join(' / '), '', '', ...fields.map(() => '')]);
    }
    currentDate = entry.date;
    output.push([
      entry.date,
      entry.category,
      toDecimalString(entry.amountMinor, entry.currency),
      entry.currency,
      entry.note ?? '',
      ...fields.map((field) => entry.customValues[field.id] ?? ''),
    ]);
  }
  if (currentDate) output.push(['', `Total for ${currentDate}`, dailyTotals(sorted.filter((item) => item.date === currentDate)).join(' / '), '', '', ...fields.map(() => '')]);
  output.push(['', 'Grand Total', dailyTotals(sorted).join(' / '), '', '', ...fields.map(() => '')]);
  return output;
}

function dailyTotals(entries: DailyExpenseEntry[]): string[] {
  const byCurrency = new Map<string, number>();
  for (const entry of entries) byCurrency.set(entry.currency, (byCurrency.get(entry.currency) ?? 0) + entry.amountMinor);
  return [...byCurrency.entries()].map(([currency, amount]) => formatMoney(amount, currency));
}

export async function exportDailyExpenseXlsx(
  filename: string,
  sheet: DailyExpenseSheet,
  entries: DailyExpenseEntry[],
  fields: DailyExpenseField[],
  receipts: ReceiptAttachment[] = [],
): Promise<void> {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows(sheet, entries, fields));
  worksheet['!cols'] = [
    { wch: 14 },
    { wch: 34 },
    { wch: 16 },
    { wch: 12 },
    { wch: 38 },
    ...fields.map(() => ({ wch: 22 })),
  ];
  worksheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(columns(fields).length - 1)}${rows(sheet, entries, fields).length}` };
  worksheet['!rows'] = rows(sheet, entries, fields).map((_, index) => ({
    hpt: index === 0 ? 24 : 28,
  }));
  const range = XLSX.utils.decode_range(worksheet['!ref'] ?? 'A1');
  for (let row = range.s.r; row <= range.e.r; row++) {
    for (let column = range.s.c; column <= range.e.c; column++) {
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = worksheet[address];
      if (!cell) continue;
      cell.s = {
        alignment: { vertical: 'center', wrapText: true },
        font: row === 0 ? { bold: true } : undefined,
        fill: row === 0 ? { patternType: 'solid', fgColor: { rgb: 'DDE6FF' } } : undefined,
      };
    }
  }
  XLSX.utils.book_append_sheet(workbook, worksheet, worksheetName(sheet.name));
  if (receipts.length > 0) {
    // A cell holds at most 32,767 characters, so a photo can't go in as text. The PDF
    // export carries the images; this tab lists which entry each receipt belongs to.
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const receiptRows = [
      ['Date', 'Place', 'File name', 'Type', 'Size (KB)'],
      ...receipts.map((receipt) => {
        const entry = byId.get(receipt.recordId);
        return [entry?.date ?? '', entry?.category ?? '', receipt.fileName, receipt.mimeType, String(Math.ceil(receipt.sizeBytes / 1024))];
      }),
      [],
      ['Receipt images are included in the PDF export and in encrypted backups.'],
    ];
    const receiptSheet = XLSX.utils.aoa_to_sheet(receiptRows);
    receiptSheet['!cols'] = [{ wch: 14 }, { wch: 28 }, { wch: 36 }, { wch: 16 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(workbook, receiptSheet, 'Receipts');
  }
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  await exportBinaryFile(filename, new Uint8Array(bytes), XLSX_MIME);
}

type PdfTextOptions = NonNullable<Parameters<PDFPage['drawText']>[1]>;

function drawText(page: PDFPage, font: PDFFont, text: string, x: number, y: number, size: number, color?: PdfTextOptions['color']) {
  page.drawText(text.slice(0, 48), { x, y, size, font, color });
}

function fitTableText(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const ellipsis = '...';
  let fitted = text;
  while (fitted.length > 0 && font.widthOfTextAtSize(fitted + ellipsis, size) > maxWidth) {
    fitted = fitted.slice(0, -1);
  }
  return fitted ? fitted + ellipsis : ellipsis;
}

async function loadBengaliFont(): Promise<Uint8Array> {
  const asset = Asset.fromModule(require('../../assets/fonts/NotoSerifBengali.ttf'));
  await asset.downloadAsync();
  if (asset.localUri) return new File(asset.localUri).bytes();
  const response = await fetch(asset.uri);
  return new Uint8Array(await response.arrayBuffer());
}

export async function exportDailyExpensePdf(
  filename: string,
  sheet: DailyExpenseSheet,
  entries: DailyExpenseEntry[],
  fields: DailyExpenseField[],
  receipts: ReceiptAttachment[] = [],
): Promise<void> {
  const [pdfLib, fontkit] = await Promise.all([import('pdf-lib'), import('@pdf-lib/fontkit')]);
  const bytes = await renderDailyExpensePdf(pdfLib, fontkit, await loadBengaliFont(), sheet, entries, fields, receipts);
  await exportBinaryFile(filename, bytes, 'application/pdf');
}

export async function renderDailyExpensePdf(
  { PDFDocument, rgb }: typeof import('pdf-lib'),
  fontkit: Parameters<PDFDocumentType['registerFontkit']>[0],
  fontBytes: Uint8Array,
  sheet: DailyExpenseSheet,
  entries: DailyExpenseEntry[],
  fields: DailyExpenseField[],
  receipts: ReceiptAttachment[] = [],
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  // Subsetting this font with pdf-lib drops glyph outlines and leaves text invisible, so embed it whole.
  const font = await pdf.embedFont(fontBytes, { subset: false });
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const pages: PDFPage[] = [];
  const labels = ['Date', 'Place', 'Amount', 'Currency', 'Note', ...fields.map((field) => field.name)];
  const baseWidths = [80, 130, 70, 50, 110, ...fields.map(() => 100)];
  const scale = Math.min(1, 770 / baseWidths.reduce((sum, width) => sum + width, 0));
  const widths = baseWidths.map((width) => width * scale);
  const positions = widths.reduce<number[]>((out, width, index) => [...out, (out[index - 1] ?? 36) + (index ? 0 : -0)], []);
  for (let index = 1; index < positions.length; index++) positions[index] = positions[index - 1] + widths[index - 1];
  let page = pdf.addPage([842, 595]);
  pages.push(page);
  let y = 555;
  const margin = 36;
  drawText(page, font, sheet.name, margin, y, 16);
  y -= 26;
  const drawHeader = () => {
    page.drawRectangle({ x: margin - 4, y: y - 5, width: 770, height: 20, color: rgb(0.9, 0.92, 0.98) });
    labels.forEach((value, index) => {
      const fitted = fitTableText(font, value, 8, widths[index] - 4);
      drawText(page, font, fitted, positions[index], y, 8);
    });
    y -= 24;
  };
  drawHeader();
  let currentDate: string | null = null;
  for (const entry of sorted) {
    if (y < 70) {
      page = pdf.addPage([842, 595]);
      pages.push(page);
      y = 555;
      drawHeader();
    }
    if (currentDate && currentDate !== entry.date) {
      page.drawRectangle({ x: margin - 4, y: y - 5, width: 770, height: 20, color: rgb(0.95, 0.95, 0.95) });
      drawText(page, font, `Total for ${currentDate}`, margin, y, 9);
      drawText(page, font, dailyTotals(sorted.filter((item) => item.date === currentDate)).join(' / '), 350, y, 9);
      y -= 24;
      if (y < 70) {
        page = pdf.addPage([842, 595]);
        pages.push(page);
        y = 555;
        drawHeader();
      }
    }
    currentDate = entry.date;
    [entry.date, entry.category, toDecimalString(entry.amountMinor, entry.currency), entry.currency, entry.note ?? '', ...fields.map((field) => entry.customValues[field.id] ?? '')]
      .forEach((value, index) => {
        const fitted = fitTableText(font, value, 8, widths[index] - 4);
        drawText(page, font, fitted, positions[index], y, 8);
      });
    y -= 18;
  }
  if (currentDate) {
    page.drawRectangle({ x: margin - 4, y: y - 5, width: 770, height: 20, color: rgb(0.95, 0.95, 0.95) });
    drawText(page, font, `Total for ${currentDate}`, margin, y, 9);
    drawText(page, font, dailyTotals(sorted.filter((item) => item.date === currentDate)).join(' / '), 350, y, 9);
    y -= 24;
  }
  page.drawRectangle({ x: margin - 4, y: y - 5, width: 770, height: 20, color: rgb(0.86, 0.9, 1) });
  drawText(page, font, 'Grand Total', margin, y, 9);
  drawText(page, font, dailyTotals(sorted).join(' / '), 350, y, 9);
  if (receipts.length > 0) {
    page = pdf.addPage([842, 595]);
    pages.push(page);
    y = 555;
    drawText(page, font, 'Receipts', margin, y, 16);
    y -= 28;
    for (const receipt of receipts) {
      if (y < 110) {
        page = pdf.addPage([842, 595]);
        pages.push(page);
        y = 555;
      }
      drawText(page, font, `${receipt.fileName} - ${receipt.mimeType} - ${receipt.sizeBytes} bytes`, margin, y, 9);
      y -= 18;
      if (receipt.mimeType === 'image/png' || receipt.mimeType === 'image/jpeg') {
        const bytes = base64Decode(receipt.dataBase64);
        if (bytes) {
          try {
            const image = receipt.mimeType === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
            const scale = Math.min(1, 520 / image.width, 360 / image.height);
            page.drawImage(image, { x: margin, y: Math.max(50, y - image.height * scale), width: image.width * scale, height: image.height * scale });
            y -= image.height * scale + 18;
          } catch {
            drawText(page, font, 'Image could not be embedded; receipt remains available in the backup.', margin + 12, y, 8);
            y -= 16;
          }
        }
      }
    }
  }
  pages.forEach((item, index) => drawText(item, font, `Page ${index + 1} of ${pages.length}`, 730, 24, 8, rgb(0.35, 0.35, 0.35)));
  return new Uint8Array(await pdf.save());
}
