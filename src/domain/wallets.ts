import { sumMinor } from './money';
import type { AppData, Wallet } from './types';
import type { Minor } from './money';

export function walletBalance(data: AppData, walletId: string): Minor {
  const wallet = data.wallets.find((item) => item.id === walletId);
  if (!wallet) throw new Error('Wallet does not exist');

  const movements: Minor[] = [wallet.openingBalanceMinor];
  for (const entry of data.walletEntries) {
    if (entry.walletId === walletId) movements.push(entry.direction === 'in' ? entry.amountMinor : -entry.amountMinor);
  }
  for (const transfer of data.walletTransfers) {
    if (transfer.fromWalletId === walletId) movements.push(-transfer.amountMinor);
    if (transfer.toWalletId === walletId) movements.push(transfer.amountMinor);
  }
  for (const expense of data.expenses) {
    if (expense.walletId === walletId) movements.push(-expense.amountMinor);
  }
  for (const expense of data.messExpenses) {
    if (expense.walletId === walletId) movements.push(-expense.amountMinor);
  }
  return sumMinor(movements);
}

export function walletIsReferenced(data: AppData, walletId: string): boolean {
  return data.walletEntries.some((entry) => entry.walletId === walletId)
    || data.walletTransfers.some((transfer) => transfer.fromWalletId === walletId || transfer.toWalletId === walletId)
    || data.expenses.some((expense) => expense.walletId === walletId)
    || data.messExpenses.some((expense) => expense.walletId === walletId);
}

export function walletsInCurrency(wallets: Wallet[], currency: string): Wallet[] {
  return wallets.filter((wallet) => wallet.currency === currency);
}
