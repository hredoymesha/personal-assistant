import { isValidDateStr } from './dates';
import { decimalsFor, isSupportedCurrency, parseMoney, sumMinor, toDecimalString } from './money';
import type { DateStr } from './dates';
import type { DailyExpenseEntry, DailyExpenseField, DailyExpenseSheet } from './types';

export type ExpenseSheetResult<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): ExpenseSheetResult<T> => ({ ok: true, value });
const fail = (error: string): ExpenseSheetResult<never> => ({ ok: false, error });

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
export function normalizeBengaliDigits(value: string): string {
  return value.replace(/[০-৯]/g, (digit) => String(BN_DIGITS.indexOf(digit)));
}
export const bengaliDigitsToAscii = normalizeBengaliDigits;

/** Accepts ISO dates and the common Bengali/English D/M/Y forms. */
export function parseExpenseSheetDate(value: string): DateStr | null {
  const raw = normalizeBengaliDigits(value).trim();
  if (isValidDateStr(raw)) return raw;
  const text: string = raw;
  const match = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]), month = Number(match[2]), year = Number(match[3]);
  const iso = `${year.toString().padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isValidDateStr(iso) ? iso : null;
}
export const parseBengaliDate = parseExpenseSheetDate;

export interface DailyExpenseValidationOptions {
  fields?: DailyExpenseField[];
  sheet?: DailyExpenseSheet;
}

export function validateDailyExpenseField(value: unknown): ExpenseSheetResult<DailyExpenseField> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Daily expense field must be an object');
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id || v.id.length > 64) return fail('Daily expense field id is invalid');
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 80) return fail('Daily expense field name is required');
  if (v.type !== 'text' && v.type !== 'number' && v.type !== 'choice') return fail('Daily expense field type is invalid');
  if (!Array.isArray(v.options) || !v.options.every((x) => typeof x === 'string' && x.length <= 100) || (v.type === 'choice' && v.options.length === 0)) {
    return fail('Daily expense field options are invalid');
  }
  if (typeof v.required !== 'boolean') return fail('Daily expense field required flag is invalid');
  return ok({ id: v.id, name: v.name.trim(), type: v.type, options: v.options, required: v.required, sample: v.sample === true ? true : undefined });
}

export function validateDailyExpenseSheet(value: unknown): ExpenseSheetResult<DailyExpenseSheet> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Daily expense sheet must be an object');
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id || v.id.length > 64) return fail('Daily expense sheet id is invalid');
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 100) return fail('Daily expense sheet name is required');
  if (typeof v.currency !== 'string' || !isSupportedCurrency(v.currency)) return fail('Daily expense sheet currency is invalid');
  if (!Array.isArray(v.fieldIds) || !v.fieldIds.every((x) => typeof x === 'string')) return fail('Daily expense sheet fields are invalid');
  if (typeof v.createdAt !== 'string' || !v.createdAt) return fail('Daily expense sheet creation time is invalid');
  return ok(v as unknown as DailyExpenseSheet);
}

export function validateDailyExpenseEntry(value: unknown, options: DailyExpenseValidationOptions = {}): ExpenseSheetResult<DailyExpenseEntry> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Daily expense entry must be an object');
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id || v.id.length > 64) return fail('Daily expense entry id is invalid');
  if (typeof v.sheetId !== 'string' || !v.sheetId) return fail('Daily expense entry sheet is invalid');
  if (!parseExpenseSheetDate(String(v.date))) return fail('Daily expense entry date is invalid');
  if (!Number.isSafeInteger(v.amountMinor) || (v.amountMinor as number) <= 0) return fail('Daily expense amount must be a positive integer minor unit');
  if (typeof v.currency !== 'string' || !isSupportedCurrency(v.currency)) return fail('Daily expense currency is invalid');
  if (typeof v.category !== 'string' || !v.category.trim() || v.category.length > 80) return fail('Daily expense category is required');
  if (typeof v.note !== 'string' || v.note.length > 500) return fail('Daily expense note is too long');
  if (!v.customValues || typeof v.customValues !== 'object' || Array.isArray(v.customValues)) return fail('Daily expense custom values are invalid');
  const fields = options.fields ?? [];
  for (const field of fields) {
    const raw = (v.customValues as Record<string, unknown>)[field.id];
    if (field.required && (typeof raw !== 'string' || !raw.trim())) return fail(`Custom field "${field.name}" is required`);
    if (raw !== undefined && typeof raw !== 'string') return fail(`Custom field "${field.name}" is invalid`);
    if (field.type === 'choice' && typeof raw === 'string' && !field.options.includes(raw)) return fail(`Custom field "${field.name}" has an invalid choice`);
  }
  return ok({ ...v, date: parseExpenseSheetDate(String(v.date))!, category: v.category.trim() } as unknown as DailyExpenseEntry);
}
export const validateExpenseSheetEntry = validateDailyExpenseEntry;

export interface DailyExpenseGroupTotal { key: string; date?: DateStr; category?: string; currency: string; amountMinor: number; count: number }
export function groupedDailyExpenseTotals(entries: DailyExpenseEntry[], groupBy: 'date' | 'category' | 'currency' = 'date'): DailyExpenseGroupTotal[] {
  const groups = new Map<string, DailyExpenseGroupTotal>();
  for (const entry of entries) {
    const key = entry[groupBy] as string;
    const id = `${groupBy}:${key}:${entry.currency}`;
    const current = groups.get(id);
    const amountMinor = current ? sumMinor([current.amountMinor, entry.amountMinor]) : entry.amountMinor;
    groups.set(id, { key, ...(groupBy === 'date' ? { date: key } : {}), ...(groupBy === 'category' ? { category: key } : {}), currency: entry.currency, amountMinor, count: (current?.count ?? 0) + 1 });
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}
export const groupDailyExpenseTotals = groupedDailyExpenseTotals;

export interface DailyExpenseFilter extends Partial<Pick<DailyExpenseEntry, 'sheetId' | 'date' | 'category' | 'currency'>> {
  from?: DateStr;
  to?: DateStr;
  query?: string;
}

export const filterDailyExpenseEntries = (entries: DailyExpenseEntry[], filter: DailyExpenseFilter): DailyExpenseEntry[] => {
  const q = filter.query?.trim().toLowerCase();
  return entries.filter((entry) => {
    if (filter.sheetId && entry.sheetId !== filter.sheetId) return false;
    if (filter.date && entry.date !== filter.date) return false;
    if (filter.category && entry.category !== filter.category) return false;
    if (filter.currency && entry.currency !== filter.currency) return false;
    if (filter.from && entry.date < filter.from) return false;
    if (filter.to && entry.date > filter.to) return false;
    if (q) {
      const matchCat = entry.category.toLowerCase().includes(q);
      const matchNote = entry.note ? entry.note.toLowerCase().includes(q) : false;
      const matchCustom = Object.values(entry.customValues).some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
      if (!matchCat && !matchNote && !matchCustom) return false;
    }
    return true;
  });
};

function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
export function dailyExpenseEntriesToCsv(entries: DailyExpenseEntry[], fields: DailyExpenseField[] = []): string {
  // Same column order as the XLSX export. Import reads headers case-insensitively and accepts Place or category.
  const header = ['Date', 'Place', 'Amount', 'Currency', 'Note', ...fields.map((field) => field.name)];
  const rows = entries.map((e) => [
    e.date,
    e.category,
    toDecimalString(e.amountMinor, e.currency),
    e.currency,
    e.note ?? '',
    ...fields.map((field) => e.customValues[field.id] ?? ''),
  ].map(csvCell).join(','));
  return [header.map(csvCell).join(','), ...rows].join('\n') + '\n';
}
export const exportDailyExpenseCsv = dailyExpenseEntriesToCsv;

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; }
    else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); if (row.some(Boolean)) rows.push(row); }
  return rows;
}

export interface DailyExpenseImportPreview { line: number; entry?: Omit<DailyExpenseEntry, 'id'>; duplicate: boolean; error?: string }
export function previewDailyExpenseCsv(text: string, defaultCurrency = 'BDT', existing: DailyExpenseEntry[] = [], fields: DailyExpenseField[] = []): DailyExpenseImportPreview[] {
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (!rows.length) return [];
  const headers = rows[0].map((x) => x.trim().toLowerCase());
  const index = (name: string) => headers.indexOf(name.trim().toLowerCase());
  if (index('date') < 0 || index('amount') < 0) return [{ line: 1, duplicate: false, error: 'Header must include "date" and "amount" columns' }];
  const key = (e: Omit<DailyExpenseEntry, 'id'>) => [e.date, e.amountMinor, e.currency, e.category, e.note].join('\u001f');
  const seen = new Set(existing.map(key));
  return rows.slice(1).map((row, i): DailyExpenseImportPreview | null => {
    const get = (name: string) => (index(name) >= 0 ? (row[index(name)] ?? '').trim() : '');
    const rawDate = get('date');
    const rawCategory = get('category') || get('place');
    if (!rawDate && (/^total for\b/i.test(rawCategory) || /^grand total$/i.test(rawCategory))) return null;
    const date = parseExpenseSheetDate(get('date'));
    const currency = (get('currency') || defaultCurrency).toUpperCase();
    const amountMinor = isSupportedCurrency(currency) ? parseMoney(get('amount'), currency) : null;
    if (!date) return { line: i + 2, duplicate: false, error: `Invalid date "${get('date')}"` };
    if (!isSupportedCurrency(currency) || amountMinor === null || amountMinor <= 0) return { line: i + 2, duplicate: false, error: `Invalid amount "${get('amount')}" (max ${decimalsFor(currency)} decimals)` };
    const customValues: Record<string, string> = {};
    for (const field of fields) customValues[field.id] = get(field.name);
    const entry: Omit<DailyExpenseEntry, 'id'> = { sheetId: get('sheetId'), date, amountMinor, currency, category: rawCategory || 'Other', note: get('note'), customValues };
    if (entry.category.length > 80 || entry.note.length > 500) return { line: i + 2, duplicate: false, error: 'Category or note is too long' };
    const duplicate = seen.has(key(entry)); seen.add(key(entry));
    return { line: i + 2, entry, duplicate };
  }).filter((row): row is DailyExpenseImportPreview => row !== null);
}

export const parseDailyExpenseCsv = previewDailyExpenseCsv;
export const importDailyExpenseCsvPreview = previewDailyExpenseCsv;
