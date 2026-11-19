/**
 * Decimal-safe money. Amounts are integers in minor units (e.g. poisha for BDT),
 * never floats. All parsing works on strings so 0.1 + 0.2 style errors cannot occur.
 */
export type Minor = number;

declare const currencyMinorBrand: unique symbol;

export type CurrencyMinor<C extends string = string> = Minor & {
  readonly [currencyMinorBrand]: (currency: C) => C;
};

export const CURRENCIES = {
  BDT: { symbol: '৳', decimals: 2 },
  USD: { symbol: '$', decimals: 2 },
  EUR: { symbol: '€', decimals: 2 },
  GBP: { symbol: '£', decimals: 2 },
  JPY: { symbol: '¥', decimals: 0 },
} as const;

export type SupportedCurrency = keyof typeof CURRENCIES;

export const USER_CURRENCIES: SupportedCurrency[] = ['BDT', 'USD', 'EUR', 'GBP'];

export interface CurrencyAmount<C extends SupportedCurrency = SupportedCurrency> {
  currency: C;
  amountMinor: CurrencyMinor<C>;
}

export const DEFAULT_CURRENCY = 'BDT';

export function isSupportedCurrency(currency: string): currency is SupportedCurrency {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, currency);
}

export function decimalsFor(currency: string): number {
  return isSupportedCurrency(currency) ? CURRENCIES[currency].decimals : 2;
}

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Convert Bangla digits to ASCII so "৫০০" parses like "500". */
export function normalizeDigits(input: string): string {
  return input.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
}

/**
 * Parse a user-typed amount ("1,250.50", "৫০০", "500") into minor units.
 * Returns null for anything ambiguous or invalid: negatives, exponents,
 * more fractional digits than the currency allows, empty, or unsafe-large values.
 */
export function parseMoney<C extends string = typeof DEFAULT_CURRENCY>(
  input: string,
  currency: C = DEFAULT_CURRENCY as C,
): CurrencyMinor<C> | null {
  const decimals = decimalsFor(currency);
  const raw = normalizeDigits(input).trim();
  // Commas are accepted only as thousands separators (1,250 or lakh-style 12,34,567). "12,5" would
  // otherwise be silently read as 125, a 10x error for people whose keyboard types a decimal comma.
  if (!/^(\d{1,3}(,\d{3})+|\d{1,2}(,\d{2})+,\d{3}|\d+)(\.\d+)?$/.test(raw)) return null;
  const s = raw.replace(/,/g, '');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) return null;
  const minor = Number(whole + frac.padEnd(decimals, '0'));
  return Number.isSafeInteger(minor) ? minor as CurrencyMinor<C> : null;
}

export function formatMoney(minor: Minor, currency = DEFAULT_CURRENCY): string {
  const decimals = decimalsFor(currency);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const base = 10 ** decimals;
  const whole = Math.floor(abs / base);
  const frac = String(abs % base).padStart(decimals, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = isSupportedCurrency(currency) ? CURRENCIES[currency].symbol : currency + ' ';
  return `${sign}${symbol}${grouped}${decimals ? '.' + frac : ''}`;
}

/** Plain decimal string for CSV/export, e.g. 125050 -> "1250.50". */
export function toDecimalString(minor: Minor, currency = DEFAULT_CURRENCY): string {
  const decimals = decimalsFor(currency);
  const abs = Math.abs(minor);
  const base = 10 ** decimals;
  const whole = Math.floor(abs / base);
  const frac = String(abs % base).padStart(decimals, '0');
  return `${minor < 0 ? '-' : ''}${whole}${decimals ? '.' + frac : ''}`;
}

/** Sum integers; throws rather than silently losing precision. */
export function sumMinor(values: Minor[]): Minor {
  let total = 0;
  for (const v of values) {
    total += v;
    if (!Number.isSafeInteger(total)) throw new RangeError('Money total exceeds safe range');
  }
  return total;
}

export function addCurrencyAmounts<C extends SupportedCurrency>(
  left: CurrencyAmount<C>,
  right: CurrencyAmount<NoInfer<C>>,
): CurrencyAmount<C> {
  if (left.currency !== right.currency) throw new Error('Cannot add amounts in different currencies');
  return {
    currency: left.currency,
    amountMinor: sumMinor([left.amountMinor, right.amountMinor]) as CurrencyMinor<C>,
  };
}

/** Adds amounts of one currency. Throws on an unsupported currency or an item in a different one. */
export function sumCurrencyAmounts<C extends SupportedCurrency>(
  amounts: CurrencyAmount<C>[],
  currency: C,
): CurrencyAmount<C> {
  if (!isSupportedCurrency(currency)) {
    throw new Error(`Unsupported currency: ${currency}`);
  }
  let total: Minor = 0;
  for (const item of amounts) {
    if (item.currency !== currency) {
      throw new Error(`Cannot sum item in currency ${item.currency} with target currency ${currency}`);
    }
    total = sumMinor([total, item.amountMinor]);
  }
  return {
    currency,
    amountMinor: total as CurrencyMinor<C>,
  };
}

/** Wraps an amount as CurrencyAmount<C>. Throws unless it's a safe integer in a supported currency. */
export function toCurrencyAmount<C extends SupportedCurrency>(
  amountMinor: Minor,
  currency: C,
): CurrencyAmount<C> {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError('Amount must be a safe integer minor unit');
  }
  if (!isSupportedCurrency(currency)) {
    throw new Error(`Unsupported currency: ${currency}`);
  }
  return {
    currency,
    amountMinor: amountMinor as CurrencyMinor<C>,
  };
}

/** Totals per currency. Different currencies are never added together. */
export function totalsByCurrency<T extends { amountMinor: Minor; currency: string }>(
  items: T[],
): Record<string, Minor> {
  const out: Record<string, Minor> = {};
  for (const i of items) {
    if (!Number.isSafeInteger(i.amountMinor)) {
      throw new RangeError('Amount must be a safe integer minor unit');
    }
    out[i.currency] = sumMinor([out[i.currency] ?? 0, i.amountMinor]);
  }
  return out;
}

/** Whole-number percentage progress, clamped to 0..100. Integer math only. */
export function percent(part: Minor, whole: Minor): number {
  if (whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((part * 100) / whole)));
}
