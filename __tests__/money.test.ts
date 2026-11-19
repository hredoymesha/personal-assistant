import {
  addCurrencyAmounts,
  formatMoney,
  parseMoney,
  percent,
  sumCurrencyAmounts,
  sumMinor,
  toDecimalString,
  toCurrencyAmount,
  totalsByCurrency,
  type CurrencyAmount,
} from '../src/domain/money';
import { categoryCurrencyTotal } from '../src/domain/summaries';
import type { Expense } from '../src/domain/types';

function assertCurrencyTypesStayDistinct(bdt: CurrencyAmount<'BDT'>, usd: CurrencyAmount<'USD'>): void {
  addCurrencyAmounts(bdt, bdt);
  // @ts-expect-error: compile-time currency brands must not be mixed.
  addCurrencyAmounts(bdt, usd);
}

describe('parseMoney', () => {
  it.each([
    ['500', 50000], ['1,250.50', 125050], ['0.1', 10], ['৫০০', 50000], ['১২.৫০', 1250], [' 7 ', 700],
  ])('parses %s', (s, minor) => expect(parseMoney(s)).toBe(minor));

  it.each(['', 'abc', '-5', '1e3', '1.234', '1..2', '.5', '5.', '1 000'])('rejects %j', (s) =>
    expect(parseMoney(s)).toBeNull());

  it('respects currency decimals', () => {
    expect(parseMoney('500', 'JPY')).toBe(500);
    expect(parseMoney('5.5', 'JPY')).toBeNull();
  });
  it('rejects unsafe-large values', () => expect(parseMoney('99999999999999999999')).toBeNull());
});

describe('arithmetic is exact', () => {
  it('adds amounts only when their currency types match', () => {
    const bdt = { currency: 'BDT' as const, amountMinor: parseMoney('1', 'BDT')! };
    const total = addCurrencyAmounts(bdt, bdt);
    expect(total).toEqual({ currency: 'BDT', amountMinor: 200 });
    expect(assertCurrencyTypesStayDistinct).toBeDefined();
  });

  it('0.1 + 0.2 == 0.3', () => {
    expect(sumMinor([parseMoney('0.1')!, parseMoney('0.2')!])).toBe(parseMoney('0.3'));
  });
  it('sums many small amounts without drift', () => {
    expect(sumMinor(Array(1000).fill(parseMoney('0.10')!))).toBe(10000);
  });
  it('throws on overflow instead of losing precision', () => {
    expect(() => sumMinor([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
  });
  it('totals per currency without mixing', () => {
    expect(totalsByCurrency([
      { amountMinor: 100, currency: 'BDT' }, { amountMinor: 50, currency: 'USD' }, { amountMinor: 25, currency: 'BDT' },
    ])).toEqual({ BDT: 125, USD: 50 });
  });
});

describe('formatting', () => {
  it('formats with grouping', () => expect(formatMoney(125050)).toBe('৳1,250.50'));
  it('formats zero-decimal currency', () => expect(formatMoney(1500, 'JPY')).toBe('¥1,500'));
  it('formats negatives', () => expect(formatMoney(-5, 'USD')).toBe('-$0.05'));
  it('round-trips through decimal string', () => {
    expect(parseMoney(toDecimalString(123456))).toBe(123456);
  });
});

describe('percent', () => {
  it('clamps and uses integer math', () => {
    expect(percent(25, 100)).toBe(25);
    expect(percent(200, 100)).toBe(100);
    expect(percent(5, 0)).toBe(0);
    expect(percent(1, 3)).toBe(33);
  });
});

describe('comma handling (regression: "12,5" was read as 125: a 10x misread in decimal-comma locales)', () => {
  it.each(['12,5', '1,25', '12,50', '1,2345', ',5', '5,', '1,,000'])('rejects ambiguous/invalid grouping %j', (v) => expect(parseMoney(v)).toBeNull());
  it.each([['1,250', 125000], ['1,250.50', 125050], ['12,34,567', 123456700], ['1,234,567.89', 123456789]])('accepts only valid thousands/lakh grouping: %j', (v, want) => expect(parseMoney(v as string)).toBe(want));
});

describe('cross-currency rejection at compile time and runtime', () => {
  it('combines same-currency amounts correctly at runtime', () => {
    const bdt1 = toCurrencyAmount(10000, 'BDT');
    const bdt2 = toCurrencyAmount(25050, 'BDT');
    const result = addCurrencyAmounts(bdt1, bdt2);
    expect(result).toEqual({
      currency: 'BDT',
      amountMinor: 35050,
    });
  });

  it('rejects adding different currencies at runtime with an explicit error', () => {
    const bdt = toCurrencyAmount(10000, 'BDT');
    const usd = toCurrencyAmount(5000, 'USD');
    // @ts-expect-error compile-time guard rejects mixed currencies
    expect(() => addCurrencyAmounts(bdt, usd)).toThrow('Cannot add amounts in different currencies');
  });

  it('rejects unvalidated broad string types at compile time', () => {
    const broadCurrency: string = 'BDT';
    // @ts-expect-error compile-time guard rejects broad string without narrowing to SupportedCurrency
    toCurrencyAmount(100, broadCurrency);
  });

  it('catches widened union operands at compile time due to brand invariance, and runtime mismatch if bypassed', () => {
    type MultiCurrencyAmount = CurrencyAmount<'BDT'> | CurrencyAmount<'USD'>;
    const bdtUnion: MultiCurrencyAmount = toCurrencyAmount(100, 'BDT');
    const usdUnion: MultiCurrencyAmount = toCurrencyAmount(200, 'USD');

    // 1. Specific union variables are rejected at compile time due to NoInfer<C>
    // @ts-expect-error compile-time guard rejects mixed narrowed union operands
    expect(() => addCurrencyAmounts(bdtUnion, usdUnion)).toThrow('Cannot add amounts in different currencies');

    // 2. Un-narrowed union parameter types are ALSO rejected at compile time because CurrencyMinor is invariant
    function addDynamicUnionAmounts(left: MultiCurrencyAmount, right: MultiCurrencyAmount) {
      // @ts-expect-error compile-time guard rejects union types because CurrencyMinor brand is invariant
      return addCurrencyAmounts(left, right);
    }
    expect(() => addDynamicUnionAmounts(bdtUnion, usdUnion)).toThrow('Cannot add amounts in different currencies');

    // 3. If types are cast or bypassed, runtime guard throws on mismatch
    const bypassedUsd = usdUnion as unknown as CurrencyAmount<'BDT'>;
    expect(() => addCurrencyAmounts(toCurrencyAmount(100, 'BDT'), bypassedUsd)).toThrow(
      'Cannot add amounts in different currencies',
    );
  });

  it('sums an array of same-currency amounts and rejects mismatched elements', () => {
    const a = toCurrencyAmount(100, 'BDT');
    const b = toCurrencyAmount(200, 'BDT');
    const c = toCurrencyAmount(300, 'BDT');
    expect(sumCurrencyAmounts([a, b, c], 'BDT')).toEqual({ currency: 'BDT', amountMinor: 600 });
    expect(sumCurrencyAmounts([], 'BDT')).toEqual({ currency: 'BDT', amountMinor: 0 });

    const usd = toCurrencyAmount(50, 'USD');
    // @ts-expect-error compile-time guard rejects array with mixed currency elements
    expect(() => sumCurrencyAmounts([a, usd], 'BDT')).toThrow(
      'Cannot sum item in currency USD with target currency BDT',
    );

    // Bypassed cast to verify runtime mismatch rejection
    const bypassed = [a, usd as unknown as CurrencyAmount<'BDT'>];
    expect(() => sumCurrencyAmounts(bypassed, 'BDT')).toThrow(
      'Cannot sum item in currency USD with target currency BDT',
    );

    // Unsupported currency rejection
    // @ts-expect-error compile-time guard rejects unsupported currency
    expect(() => sumCurrencyAmounts([], 'INVALID')).toThrow('Unsupported currency: INVALID');
  });

  it('converts amounts safely and validates supported currency and safe integer bounds', () => {
    expect(() => toCurrencyAmount(1.5, 'BDT')).toThrow('safe integer');
    expect(() => toCurrencyAmount(NaN, 'BDT')).toThrow('safe integer');
    // @ts-expect-error runtime rejection of unsupported currency
    expect(() => toCurrencyAmount(100, 'INVALID')).toThrow('Unsupported currency');
    const valid = toCurrencyAmount(500, 'BDT');
    expect(valid).toEqual({ currency: 'BDT', amountMinor: 500 });
  });

  it('groups totals by currency without cross-currency addition', () => {
    const items = [
      { amountMinor: 100, currency: 'BDT' },
      { amountMinor: 250, currency: 'BDT' },
      { amountMinor: 50, currency: 'USD' },
      { amountMinor: 75, currency: 'EUR' },
    ];
    expect(totalsByCurrency(items)).toEqual({
      BDT: 350,
      USD: 50,
      EUR: 75,
    });
    expect(() => totalsByCurrency([{ amountMinor: 1.5, currency: 'BDT' }])).toThrow('safe integer');
  });

  it('integrates with real domain calculations via categoryCurrencyTotal', () => {
    const expenses: Expense[] = [
      {
        id: 'e1',
        amountMinor: 50000,
        currency: 'BDT',
        category: 'Food',
        date: '2026-11-01',
        note: '',
        walletId: null,
        originalText: null,
        sample: false,
      },
      {
        id: 'e2',
        amountMinor: 25000,
        currency: 'BDT',
        category: 'Food',
        date: '2026-11-02',
        note: '',
        walletId: null,
        originalText: null,
        sample: false,
      },
      {
        id: 'e3',
        amountMinor: 1000,
        currency: 'USD',
        category: 'Food',
        date: '2026-11-03',
        note: '',
        walletId: null,
        originalText: null,
        sample: false,
      },
      {
        id: 'e4',
        amountMinor: 40000,
        currency: 'BDT',
        category: 'Transport',
        date: '2026-11-04',
        note: '',
        walletId: null,
        originalText: null,
        sample: false,
      },
    ];

    const bdtFood = categoryCurrencyTotal(expenses, 'Food', 'BDT');
    expect(bdtFood).toEqual({
      currency: 'BDT',
      amountMinor: 75000,
    });

    const usdFood = categoryCurrencyTotal(expenses, 'Food', 'USD');
    expect(usdFood).toEqual({
      currency: 'USD',
      amountMinor: 1000,
    });

    const eurFood = categoryCurrencyTotal(expenses, 'Food', 'EUR');
    expect(eurFood).toEqual({
      currency: 'EUR',
      amountMinor: 0,
    });
  });

  it('verifies compile-time type guard function compiles and holds', () => {
    const bdt = toCurrencyAmount(1000, 'BDT');
    const usd = toCurrencyAmount(2000, 'USD');
    expect(() => assertCurrencyTypesStayDistinct(bdt, usd)).toThrow('Cannot add amounts in different currencies');
  });
});
