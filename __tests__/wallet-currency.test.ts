import { formatMoney, parseMoney } from '../src/domain/money';
import { walletBalance } from '../src/domain/wallets';
import { emptyData } from '../src/domain/types';
import type { AppData, MessGroup, MessMember, Wallet } from '../src/domain/types';
import { validateAppData } from '../src/domain/validation';
import { parseData } from '../src/storage/repository';

/**
 * Checks the report that a wallet created in the wrong currency gives wrong totals.
 * These tests reproduce each way the wrong-currency state could reach a total and show which guard (if any) stops it.
 * They exercise the domain/validation/repository layers only; no UI renderer is available, so UI wiring is not covered.
 */
const wallet = (id: string, currency: string, openingBalanceMinor = 0): Wallet => ({
  id, name: id, currency, openingBalanceMinor, createdAt: '2026-11-06T00:00:00.000Z',
});

function dataWithUsdWalletAndBdtExpense(): AppData {
  const data = emptyData();
  data.wallets.push(wallet('usd_card', 'USD', 7500));
  data.expenses.push({
    id: 'e1', amountMinor: 25000, currency: 'BDT', category: 'Food', note: '', date: '2026-11-06',
    walletId: 'usd_card', originalText: null, sample: false,
  });
  return data;
}

describe('wrong-currency wallet and totals (fictional data)', () => {
  it('CHARACTERIZATION: walletBalance is not currency-aware, so mixed-currency data would give a silently wrong total', () => {
    const data = dataWithUsdWalletAndBdtExpense();
    // 7500 USD minor - 25000 BDT minor = -17500: meaningless. Safety must therefore come from validation, not from walletBalance.
    expect(walletBalance(data, 'usd_card')).toBe(-17500);
  });

  it('validation rejects an expense whose currency differs from its wallet, so that state cannot be saved or loaded', () => {
    expect(validateAppData(dataWithUsdWalletAndBdtExpense())).toMatchObject({
      ok: false,
      error: expect.stringContaining('does not match its wallet'),
    });
  });

  it('the load/restore path (parseData) rejects the same state, so no stored wrong total can appear after reload or restore', () => {
    const parsed = parseData(JSON.stringify(dataWithUsdWalletAndBdtExpense()));
    expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining('does not match its wallet') });
    // Control: the same envelope without the mismatch loads fine, so the rejection above is for the currency reason only.
    const control = dataWithUsdWalletAndBdtExpense();
    control.expenses[0].currency = 'USD';
    expect(parseData(JSON.stringify(control)).ok).toBe(true);
  });

  it('validation rejects a mess expense paid from a wallet in a different currency than the mess group', () => {
    const data = emptyData();
    const group: MessGroup = { id: 'g1', name: 'Flat', currency: 'BDT', createdAt: '2026-11-06T00:00:00.000Z' };
    const self: MessMember = { id: 'self', groupId: 'g1', name: 'Me', contactId: null, isSelf: true };
    data.wallets.push(wallet('usd_card', 'USD', 10000));
    data.messGroups.push(group);
    data.messMembers.push(self);
    data.messExpenses.push({
      id: 'm1', groupId: 'g1', amountMinor: 500, date: '2026-11-06', category: 'Food', note: '',
      payerMemberId: 'self', walletId: 'usd_card', allocationMode: 'equal', mealRangeStart: null, mealRangeEnd: null,
      allocations: [{ memberId: 'self', amountMinor: 500 }],
    });
    expect(validateAppData(data)).toMatchObject({ ok: false, error: expect.stringContaining('invalid wallet') });
  });

  it('choosing the wrong currency for the same typed opening balance changes the stored minor amount (scale), not the arithmetic', () => {
    // A user who types 1000 meaning BDT but picks JPY stores 1000 minor; BDT stores 100000 minor. Each is internally consistent.
    expect(parseMoney('1000', 'BDT')).toBe(100000);
    expect(parseMoney('1000', 'JPY')).toBe(1000);
    const data = emptyData();
    data.wallets.push(wallet('w', 'JPY', 1000));
    expect(validateAppData(data).ok).toBe(true);
    expect(formatMoney(walletBalance(data, 'w'), 'JPY')).toContain('1,000');
  });

  it('the default currency for new data is BDT', () => {
    expect(emptyData().settings.currency).toBe('BDT');
  });
});
