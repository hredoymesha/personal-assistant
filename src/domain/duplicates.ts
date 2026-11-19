import type { Expense } from './types';

type ExpenseLike = Pick<Expense, 'date' | 'amountMinor' | 'currency' | 'category' | 'note'>
  & Partial<Pick<Expense, 'walletId'>>;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Same date, amount, currency, category, note, and wallet => probable accidental duplicate. */
export function isSameExpense(a: ExpenseLike, b: ExpenseLike): boolean {
  return a.date === b.date && a.amountMinor === b.amountMinor && a.currency === b.currency
    && norm(a.category) === norm(b.category) && norm(a.note) === norm(b.note)
    && (a.walletId ?? null) === (b.walletId ?? null);
}

export function findDuplicateExpense(existing: Expense[], candidate: ExpenseLike): Expense | null {
  return existing.find((e) => isSameExpense(e, candidate)) ?? null;
}

/** Splits candidate rows into new ones and probable duplicates of already-saved expenses. */
export function partitionDuplicates<T extends ExpenseLike>(candidates: T[], existing: Expense[]): { fresh: T[]; duplicates: T[] } {
  const fresh: T[] = [], duplicates: T[] = [];
  for (const c of candidates) (findDuplicateExpense(existing, c) ? duplicates : fresh).push(c);
  return { fresh, duplicates };
}
