import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  decimalsFor,
  formatMoney,
  isSupportedCurrency,
  parseMoney,
  sumCurrencyAmounts,
  toCurrencyAmount,
} from '../src/domain/money';
import {
  validateDebt,
  validateExpense,
  validateGoal,
  validateMessGroup,
  validateSettings,
  validateWallet,
} from '../src/domain/validation';
import {
  validateCurrency,
  validateCycleBill,
  validateCycleIncome,
  validateCyclePayment,
} from '../src/domain/cycle';
import { checkDraft } from '../src/domain/parser/draft';
import { parseCommand } from '../src/domain/parser/parse';

describe('Own-property currency validation across domain, parser and models', () => {
  const TODAY = '2026-11-09';
  function parse(s: string) {
    const r = parseCommand(s, TODAY);
    if (!r.ok) throw new Error(`Unexpected parse failure: ${r.error}`);
    return r.draft;
  }
  const PROTOTYPE_PROPERTIES = [
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
  ];

  const SUPPORTED_CODES = Object.keys(CURRENCIES);

  describe('isSupportedCurrency own-property guard', () => {
    it('accepts every supported currency', () => {
      expect(SUPPORTED_CODES).toEqual(['BDT', 'USD', 'EUR', 'GBP', 'JPY']);
      for (const code of SUPPORTED_CODES) {
        expect(isSupportedCurrency(code)).toBe(true);
      }
    });

    it('rejects all inherited Object prototype property names', () => {
      for (const bad of PROTOTYPE_PROPERTIES) {
        expect(isSupportedCurrency(bad)).toBe(false);
      }
    });

    it('rejects unsupported strings, lowercase codes, and non-currency strings', () => {
      expect(isSupportedCurrency('bdt')).toBe(false);
      expect(isSupportedCurrency('usd')).toBe(false);
      expect(isSupportedCurrency('CAD')).toBe(false);
      expect(isSupportedCurrency('AUD')).toBe(false);
      expect(isSupportedCurrency('')).toBe(false);
      expect(isSupportedCurrency('   ')).toBe(false);
      expect(isSupportedCurrency('123')).toBe(false);
    });
  });

  describe('Decimal parsing, formatting and typed amounts with prototype safety', () => {
    it('decimalsFor handles supported currencies and falls back safely without executing prototype methods', () => {
      expect(decimalsFor('BDT')).toBe(2);
      expect(decimalsFor('USD')).toBe(2);
      expect(decimalsFor('JPY')).toBe(0);
      for (const bad of PROTOTYPE_PROPERTIES) {
        expect(decimalsFor(bad)).toBe(2);
      }
    });

    it('formatMoney formats supported currencies with their symbol and never accesses prototype methods', () => {
      expect(formatMoney(25000, 'BDT')).toBe('৳250.00');
      expect(formatMoney(1000, 'USD')).toBe('$10.00');
      expect(formatMoney(500, 'JPY')).toBe('¥500');
      for (const bad of PROTOTYPE_PROPERTIES) {
        // Must safely format with fallback label rather than throwing or evaluating function toString
        expect(formatMoney(1000, bad)).toBe(`${bad} 10.00`);
      }
    });

    it('parseMoney parses numbers correctly and never accesses prototype properties', () => {
      expect(parseMoney('250.50', 'BDT')).toBe(25050);
      expect(parseMoney('500', 'JPY')).toBe(500);
      for (const bad of PROTOTYPE_PROPERTIES) {
        expect(parseMoney('10.50', bad as any)).toBe(1050);
      }
    });

    it('toCurrencyAmount and sumCurrencyAmounts reject prototype properties and unsupported currencies', () => {
      for (const bad of PROTOTYPE_PROPERTIES) {
        expect(() => toCurrencyAmount(1000, bad as any)).toThrow(/Unsupported currency/i);
        expect(() => sumCurrencyAmounts([], bad as any)).toThrow(/Unsupported currency/i);
      }
      expect(() => toCurrencyAmount(1000, 'CAD' as any)).toThrow(/Unsupported currency/i);

      const validAmount = toCurrencyAmount(5000, 'USD');
      expect(validAmount).toEqual({ currency: 'USD', amountMinor: 5000 });
      expect(sumCurrencyAmounts([validAmount], 'USD')).toEqual({ currency: 'USD', amountMinor: 5000 });
    });
  });

  describe('Domain model validation rejects inherited currency names', () => {
    it('validateSettings rejects inherited currency property names and unsupported currencies', () => {
      for (const bad of PROTOTYPE_PROPERTIES) {
        const res = validateSettings({ currency: bad, theme: 'system', language: 'en' });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toBe('Currency is not supported');
      }
      expect(validateSettings({ currency: 'CAD', theme: 'system', language: 'en' }).ok).toBe(false);
      expect(validateSettings({ currency: DEFAULT_CURRENCY, theme: 'system', language: 'en' }).ok).toBe(true);
    });

    it('validateWallet rejects inherited currency property names', () => {
      const baseWallet = {
        id: 'w1',
        name: 'Main Wallet',
        openingBalanceMinor: 0,
        createdAt: '2026-11-09T00:00:00.000Z',
      };
      for (const bad of PROTOTYPE_PROPERTIES) {
        const res = validateWallet({ ...baseWallet, currency: bad });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toBe('Wallet currency is invalid');
      }
      expect(validateWallet({ ...baseWallet, currency: 'BDT' }).ok).toBe(true);
    });

    it('validateMessGroup rejects inherited currency property names', () => {
      const baseMess = {
        id: 'mg1',
        name: 'Flat Mess',
        createdAt: '2026-11-09T00:00:00.000Z',
      };
      for (const bad of PROTOTYPE_PROPERTIES) {
        const res = validateMessGroup({ ...baseMess, currency: bad });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toBe('Mess group currency is invalid');
      }
      expect(validateMessGroup({ ...baseMess, currency: 'BDT' }).ok).toBe(true);
    });

    it('validateCycleBill, validateCyclePayment, and validateCycleIncome reject inherited currency names', () => {
      for (const bad of PROTOTYPE_PROPERTIES) {
        expect(validateCurrency(bad).ok).toBe(false);

        const bill = {
          id: 'cb1',
          userId: 'u1',
          name: 'Internet',
          expectedAmountMinor: 100000,
          currency: bad,
          dueDay: 5,
          isVariable: false,
          isPaused: false,
          autopay: false,
          completedInstallments: 0,
          paidBy: 'self',
        };
        expect(validateCycleBill(bill).ok).toBe(false);

        const payment = {
          id: 'cp1',
          billId: 'cb1',
          userId: 'u1',
          monthKey: '2026-11',
          amountMinor: 50000,
          currency: bad,
          paidAt: '2026-11-05T00:00:00.000Z',
        };
        expect(validateCyclePayment(payment).ok).toBe(false);

        const income = {
          id: 'ci1',
          userId: 'u1',
          source: 'Salary',
          amountMinor: 5000000,
          currency: bad,
          monthKey: '2026-11',
          receivedAt: '2026-11-01',
        };
        expect(validateCycleIncome(income).ok).toBe(false);
      }
    });

    it('validateExpense, validateGoal, and validateDebt reject prototype property names', () => {
      const baseExpense = {
        id: 'e1',
        amountMinor: 5000,
        category: 'Food',
        note: 'Lunch',
        date: '2026-11-09',
        originalText: null,
        sample: false,
      };
      const baseGoal = {
        id: 'g1',
        name: 'Emergency',
        targetMinor: 100000,
        savedMinor: 20000,
        sample: false,
      };
      const baseDebt = {
        id: 'd1',
        person: 'Rahim',
        direction: 'i_owe',
        amountMinor: 10000,
        paidMinor: 0,
        dueDate: null,
        createdAt: '2026-11-09T00:00:00.000Z',
        sample: false,
      };

      for (const bad of PROTOTYPE_PROPERTIES) {
        expect(validateExpense({ ...baseExpense, currency: bad }).ok).toBe(false);
        expect(validateGoal({ ...baseGoal, currency: bad }).ok).toBe(false);
        expect(validateDebt({ ...baseDebt, currency: bad }).ok).toBe(false);
      }

      // uppercase 3-letter codes that are not in supported CURRENCIES (e.g. XXX, ABC, CAD) are rejected
      for (const unsupported of ['XXX', 'ABC', 'CAD', 'XYZ', 'FOO']) {
        expect(validateExpense({ ...baseExpense, currency: unsupported }).ok).toBe(false);
        expect(validateGoal({ ...baseGoal, currency: unsupported }).ok).toBe(false);
        expect(validateDebt({ ...baseDebt, currency: unsupported }).ok).toBe(false);
      }

      expect(validateExpense({ ...baseExpense, currency: 'BDT' }).ok).toBe(true);
      expect(validateGoal({ ...baseGoal, currency: 'USD' }).ok).toBe(true);
      expect(validateDebt({ ...baseDebt, currency: 'EUR' }).ok).toBe(true);
    });
  });

  describe('Parser and draft check rejects inherited property names without silent conversion', () => {
    const TODAY = '2026-11-09';

    it('checkDraft rejects inherited currency property names on edited drafts', () => {
      const parsed = parse('Add expense 250 for lunch today');
      for (const bad of PROTOTYPE_PROPERTIES) {
        const check = checkDraft({ ...parsed, currency: bad }, TODAY);
        expect(check.issues.currency).toMatch(/not supported/i);
        expect(check.action).toBeNull();
      }
    });

    it('checkDraft does not silently convert invalid currency to default BDT', () => {
      const parsed = parse('Add expense 250 for lunch today');
      const check = checkDraft({ ...parsed, currency: 'XYZ' }, TODAY);
      expect(check.issues.currency).toBe('That currency is not supported.');
      expect(check.action).toBeNull();
      // Check the currency field was not mutated or silently replaced
      expect(parsed.currency).toBeNull();
    });

    it('parse never resolves prototype property names from currency symbol or word lookup', () => {
      // Input mentioning "toString" or "constructor" should not be treated as a currency symbol or code
      const parsed1 = parse('Add expense 250 toString for lunch today');
      expect(parsed1.currency).toBeNull();

      const parsed2 = parse('Add expense 250 constructor for lunch today');
      expect(parsed2.currency).toBeNull();
    });

    it('parse correctly resolves genuine currency symbols and codes', () => {
      expect(parse('Spent ৳250 on food today').currency).toBe('BDT');
      expect(parse('Spent $50 on food today').currency).toBe('USD');
      expect(parse('Spent €30 on food today').currency).toBe('EUR');
      expect(parse('Spent £20 on food today').currency).toBe('GBP');
      expect(parse('Spent ৳500 on food today').currency).toBe('BDT');
      expect(parse('Spent ¥1000 on food today').currency).toBe('JPY');
    });
  });
});
