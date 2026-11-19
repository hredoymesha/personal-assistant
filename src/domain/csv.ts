import { isValidDateStr } from './dates';
import { decimalsFor, parseMoney, toDecimalString } from './money';
import type { Expense } from './types';

const HEADER = ['date', 'amount', 'currency', 'category', 'note'];

/** Neutralise spreadsheet formula injection when opened in Excel/Sheets. */
function cell(v: string): string {
  let s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function expensesToCsv(expenses: Expense[]): string {
  const rows = expenses.map((e) =>
    [e.date, toDecimalString(e.amountMinor, e.currency), e.currency, e.category, e.note].map(cell).join(','),
  );
  return [HEADER.join(','), ...rows].join('\n') + '\n';
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

export interface CsvImportRow { line: number; expense?: Omit<Expense, 'id' | 'sample' | 'originalText'>; error?: string }

/** Parses expense CSV into reviewable rows; nothing is saved here. */
export function parseExpenseCsv(text: string, defaultCurrency: string): CsvImportRow[] {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (n: string) => head.indexOf(n);
  if (idx('date') < 0 || idx('amount') < 0) {
    return [{ line: 1, error: 'Header must include "date" and "amount" columns' }];
  }
  return rows.slice(1).map((r, i) => {
    const line = i + 2;
    const get = (n: string) => (idx(n) >= 0 ? (r[idx(n)] ?? '').trim() : '');
    const currency = (get('currency') || defaultCurrency).toUpperCase();
    const date = get('date');
    if (!isValidDateStr(date)) return { line, error: `Invalid date "${date}" (use YYYY-MM-DD)` };
    if (!/^[A-Z]{3}$/.test(currency)) return { line, error: `Invalid currency "${currency}"` };
    const amountMinor = parseMoney(get('amount'), currency);
    if (amountMinor === null || amountMinor === 0) {
      return { line, error: `Invalid amount "${get('amount')}" (max ${decimalsFor(currency)} decimals)` };
    }
    if (!/^[A-Z]{3}$/.test(currency)) return { line, error: `Invalid currency "${currency}"` };
    const category = get('category') || 'Other';
    if (category.length > 40) return { line, error: 'Category is longer than 40 characters' };
    if (get('note').length > 500) return { line, error: 'Note is longer than 500 characters' };
    return { line, expense: { date, amountMinor, currency, category, note: get('note'), walletId: null } };
  });
}
