import { formatMoney, sumMinor } from './money';
import type { Debt } from './types';
import type { Minor } from './money';

export type DebtPaymentResult =
  | { ok: true; debts: Debt[] }
  | { ok: false; error: string };

function compareDebtsByCreation(a: Debt, b: Debt): number {
  if (a.createdAt !== b.createdAt) return a.createdAt! < b.createdAt! ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function applyDebtPayment(debts: Debt[], selectedDebtId: string, amountMinor: Minor): DebtPaymentResult {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return { ok: false, error: 'Payment must be a positive safe integer amount.' };
  }
  const selected = debts.find((debt) => debt.id === selectedDebtId);
  if (!selected) return { ok: false, error: 'Debt does not exist.' };

  const matching = debts.filter((debt) =>
    debt.person === selected.person
    && debt.direction === selected.direction
    && debt.currency === selected.currency
    && debt.paidMinor < debt.amountMinor);
  const payable = selected.createdAt === null
    ? matching.filter((debt) => debt.id === selected.id)
    : matching.filter((debt) => debt.createdAt !== null).sort(compareDebtsByCreation);
  let openMinor: Minor;
  try {
    openMinor = sumMinor(payable.map((debt) => debt.amountMinor - debt.paidMinor));
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, error: 'Open principal exceeds the safe amount range.' };
    throw error;
  }
  if (amountMinor > openMinor) {
    return { ok: false, error: 'Payment exceeds the open principal available for this person, debt type, and currency.' };
  }

  let remaining = amountMinor;
  const paymentByDebtId = new Map<string, Minor>();
  for (const debt of payable) {
    if (remaining === 0) break;
    const applied = Math.min(debt.amountMinor - debt.paidMinor, remaining);
    paymentByDebtId.set(debt.id, applied);
    remaining -= applied;
  }
  if (remaining !== 0) return { ok: false, error: 'Could not apply the full debt payment.' };

  return {
    ok: true,
    debts: debts.map((debt) => {
      const applied = paymentByDebtId.get(debt.id);
      return applied === undefined ? debt : { ...debt, paidMinor: sumMinor([debt.paidMinor, applied]) };
    }),
  };
}

/**
 * Phone number for a wa.me link: digits only, a leading 00 dropped, and 88 added in front of an
 * 11-digit Bangladeshi mobile number (01...). Other numbers are left as they are.
 */
export function normalizeWhatsAppNumber(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  if (/^01\d{9}$/.test(digits)) {
    digits = `88${digits}`;
  }
  return digits;
}

/** wa.me link, with the message filled in when there is one. */
export function whatsappLink(phone: string, text?: string): string {
  const normalized = normalizeWhatsAppNumber(phone);
  if (!normalized) return '';
  const baseUrl = `https://wa.me/${normalized}`;
  if (!text) return baseUrl;
  return `${baseUrl}?text=${encodeURIComponent(text)}`;
}

export interface DebtReminderOptions {
  person: string;
  direction: Debt['direction'];
  amountMinor: number;
  currency: string;
  lang: 'bn' | 'en';
}

/**
 * Polite reminder text in Bengali or English. "owed_to_me" asks for payment and "i_owe"
 * acknowledges what you owe; the two must never swap. No religious greetings, promises or
 * deadlines are added.
 */
export function buildDebtReminderText(options: DebtReminderOptions): string {
  const { person, direction, amountMinor, currency, lang } = options;
  const formattedAmount = formatMoney(amountMinor, currency);
  const trimmedPerson = person.trim() || (lang === 'bn' ? 'সুধী' : 'there');

  if (direction === 'owed_to_me') {
    if (lang === 'bn') {
      return `শুভেচ্ছা ${trimmedPerson}, Personal Assistant রেকর্ড অনুযায়ী আপনার কাছে ${formattedAmount} বাকি রয়েছে। সুবিধাজনক সময়ে পরিশোধের অনুরোধ জানাচ্ছি।`;
    }
    return `Greetings ${trimmedPerson}, according to Personal Assistant records, there is an outstanding balance of ${formattedAmount} owed to me. Please settle when convenient.`;
  }

  // direction === 'i_owe'
  if (lang === 'bn') {
    return `শুভেচ্ছা ${trimmedPerson}, Personal Assistant রেকর্ড অনুযায়ী আপনার ${formattedAmount} আমার পরিশোধ করা বাকি রয়েছে। সুবিধাজনক সময়ে এটি সমন্বয় করার অনুরোধ জানাচ্ছি।`;
  }
  return `Greetings ${trimmedPerson}, according to Personal Assistant records, I have an outstanding balance of ${formattedAmount} to pay you. Please let me know when we can settle this.`;
}

