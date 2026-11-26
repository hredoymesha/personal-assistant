import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfLib from 'pdf-lib';
import * as XLSX from 'xlsx';
import type { DailyExpenseEntry, DailyExpenseField, DailyExpenseSheet, ReceiptAttachment } from '../src/domain/types';

const exported: { name: string; bytes: Uint8Array }[] = [];
jest.mock('../src/services/files', () => ({
  exportBinaryFile: jest.fn(async (name: string, bytes: Uint8Array) => { exported.push({ name, bytes }); }),
}));

const fontBytes = readFileSync(join(__dirname, '..', 'assets', 'fonts', 'NotoSerifBengali.ttf'));
// eslint-disable-next-line import/first
import { exportDailyExpenseXlsx, renderDailyExpensePdf } from '../src/services/expenseSheetFiles';

const sheet: DailyExpenseSheet = { id: 's1', name: 'Sample: Daily Travel & Meals', fieldIds: ['f1'], createdAt: '2026-11-01T00:00:00.000Z' } as DailyExpenseSheet;
const fields: DailyExpenseField[] = [{ id: 'f1', name: 'Transport type', type: 'text', options: [], required: false }];
const entries: DailyExpenseEntry[] = [
  { id: 'e1', sheetId: 's1', date: '2026-11-13', amountMinor: 22000, currency: 'BDT', category: 'Breakfast', note: 'on the way to work', customValues: { f1: 'Rickshaw' } },
  { id: 'e2', sheetId: 's1', date: '2026-11-14', amountMinor: 42000, currency: 'BDT', category: 'Household', note: 'cleaning supplies', customValues: { f1: 'CNG' } },
];
// A phone photo is far longer than one spreadsheet cell can hold once it's base64.
const bigReceipt: ReceiptAttachment = {
  id: 'r1', recordType: 'daily_expense', recordId: 'e1', fileName: 'receipt.jpg', mimeType: 'image/jpeg',
  sizeBytes: 60000, dataBase64: 'A'.repeat(80000), createdAt: '2026-11-13T08:00:00.000Z',
};

beforeEach(() => { exported.length = 0; });

describe('Excel export', () => {
  it('works with a receipt photo and lists it without the image data', async () => {
    await exportDailyExpenseXlsx('out.xlsx', sheet, entries, fields, [bigReceipt]);
    const book = XLSX.read(exported[0].bytes, { type: 'array' });
    expect(book.SheetNames).toEqual(['Sample Daily Travel & Meals', 'Receipts']);
    const rows = XLSX.utils.sheet_to_json<string[]>(book.Sheets.Receipts, { header: 1 });
    expect(rows[1]).toEqual(['2026-11-13', 'Breakfast', 'receipt.jpg', 'image/jpeg', '59']);
    for (const row of rows) for (const cell of row) expect(String(cell).length).toBeLessThan(32767);
  });
});

describe('PDF export', () => {
  it('embeds a font in which every drawn letter still has its shape', async () => {
    const bytes = await renderDailyExpensePdf(pdfLib, fontkit, new Uint8Array(fontBytes), sheet, entries, fields);
    const doc = await pdfLib.PDFDocument.load(bytes);
    let checked = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof pdfLib.PDFRawStream)) continue;
      let raw = Buffer.from(obj.contents);
      if (String(obj.dict.get(pdfLib.PDFName.of('Filter'))) === '/FlateDecode') raw = inflateSync(raw);
      if (!['00010000', '74727565', '4f54544f'].includes(raw.subarray(0, 4).toString('hex'))) continue;
      const font = fontkit.create(raw);
      for (const ch of 'SampleDailyTravelMealsBreakfast2026-11-13220.00BDTGrandTotalPage') {
        const glyph = font.glyphForCodePoint(ch.charCodeAt(0));
        expect([ch, glyph.id > 0 && glyph.path.toSVG().length > 0]).toEqual([ch, true]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
