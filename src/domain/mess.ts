import { isValidDateStr } from './dates';
import { normalizeDigits, sumMinor } from './money';
import type { Minor } from './money';
import type { AppData, MessAllocation, MessMember } from './types';

export interface MemberMealWeight {
  memberId: string;
  halfMealUnits: number;
}

export interface MessMemberBalance {
  memberId: string;
  halfMealUnits: number;
  paidMinor: Minor;
  shareMinor: Minor;
  balanceMinor: Minor;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertAllocationInput(amountMinor: number, weights: MemberMealWeight[]): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new RangeError('Expense amount must be a positive safe integer');
  if (!weights.length) throw new RangeError('At least one member is required');
  const ids = new Set<string>();
  let totalWeight = 0;
  for (const item of weights) {
    if (!item.memberId || ids.has(item.memberId)) throw new Error('Member ids must be unique');
    if (!Number.isSafeInteger(item.halfMealUnits) || item.halfMealUnits <= 0) throw new RangeError('Allocation weights must be positive safe integers');
    ids.add(item.memberId);
    totalWeight += item.halfMealUnits;
    if (!Number.isSafeInteger(totalWeight)) throw new RangeError('Total meal count exceeds safe range');
  }
  return totalWeight;
}

function allocateProportionally(amountMinor: number, weights: MemberMealWeight[]): MessAllocation[] {
  const totalWeight = assertAllocationInput(amountMinor, weights);
  const denominator = BigInt(totalWeight);
  const rows = weights.map((item) => {
    const product = BigInt(amountMinor) * BigInt(item.halfMealUnits);
    const share = product / denominator;
    return {
      memberId: item.memberId,
      amountMinor: Number(share),
      remainder: product % denominator,
    };
  });
  let assigned = sumMinor(rows.map((item) => item.amountMinor));
  rows.sort((a, b) => a.remainder === b.remainder ? compareIds(a.memberId, b.memberId) : a.remainder > b.remainder ? -1 : 1);
  let remaining = amountMinor - assigned;
  for (let i = 0; remaining > 0; i++, remaining--) rows[i].amountMinor += 1;
  assigned = sumMinor(rows.map((item) => item.amountMinor));
  if (assigned !== amountMinor) throw new Error('Could not allocate the full expense amount');
  rows.sort((a, b) => a.memberId.localeCompare(b.memberId));
  return rows.map(({ memberId, amountMinor: share }) => ({ memberId, amountMinor: share }));
}

export function allocateEqually(amountMinor: number, memberIds: string[]): MessAllocation[] {
  return allocateProportionally(amountMinor, memberIds.map((memberId) => ({ memberId, halfMealUnits: 1 })));
}

export function allocateByMeals(amountMinor: number, weights: MemberMealWeight[]): MessAllocation[] {
  return allocateProportionally(amountMinor, weights);
}

export function validateCustomAllocation(amountMinor: number, allocations: MessAllocation[]): MessAllocation[] {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new RangeError('Expense amount must be a positive safe integer');
  if (!allocations.length) throw new Error('At least one allocation is required');
  const ids = new Set<string>();
  for (const allocation of allocations) {
    if (!allocation.memberId || ids.has(allocation.memberId)) throw new Error('Member ids must be unique');
    if (!Number.isSafeInteger(allocation.amountMinor) || allocation.amountMinor < 0) throw new RangeError('Custom shares must be non-negative safe integers');
    ids.add(allocation.memberId);
  }
  if (sumMinor(allocations.map((item) => item.amountMinor)) !== amountMinor) {
    throw new Error('Custom shares must add up to the full expense amount');
  }
  return allocations;
}

export function parseHalfMealUnits(input: string): number | null {
  const raw = normalizeDigits(input).trim();
  if (!/^\d+(?:\.5)?$/.test(raw)) return null;
  const units = Number(raw) * 2;
  return Number.isSafeInteger(units) && units > 0 ? units : null;
}

export function formatHalfMeals(halfMealUnits: number): string {
  return `${Math.floor(halfMealUnits / 2)}${halfMealUnits % 2 ? '.5' : ''}`;
}

export function summarizeMessGroup(
  data: AppData,
  groupId: string,
  startDate: string,
  endDate: string,
): MessMemberBalance[] {
  if (!isValidDateStr(startDate) || !isValidDateStr(endDate) || startDate > endDate) {
    throw new Error('Date range is invalid');
  }
  const members = data.messMembers.filter((member) => member.groupId === groupId);
  if (!data.messGroups.some((group) => group.id === groupId)) throw new Error('Mess group does not exist');
  const memberIds = new Set(members.map((member) => member.id));
  const mealCounts = new Map<string, number>();
  const paid = new Map<string, Minor>();
  const shares = new Map<string, Minor>();

  for (const meal of data.messMeals) {
    if (meal.groupId !== groupId || meal.date < startDate || meal.date > endDate) continue;
    const next = (mealCounts.get(meal.memberId) ?? 0) + meal.halfMealUnits;
    if (!Number.isSafeInteger(next)) throw new RangeError('Meal count exceeds safe range');
    mealCounts.set(meal.memberId, next);
  }
  for (const expense of data.messExpenses) {
    if (expense.groupId !== groupId || expense.date < startDate || expense.date > endDate) continue;
    if (!memberIds.has(expense.payerMemberId)) throw new Error('Mess expense payer is not in this group');
    paid.set(expense.payerMemberId, sumMinor([paid.get(expense.payerMemberId) ?? 0, expense.amountMinor]));
    for (const allocation of expense.allocations) {
      if (!memberIds.has(allocation.memberId)) throw new Error('Mess allocation member is not in this group');
      shares.set(allocation.memberId, sumMinor([shares.get(allocation.memberId) ?? 0, allocation.amountMinor]));
    }
  }
  return members
    .map((member) => {
      const paidMinor = paid.get(member.id) ?? 0;
      const shareMinor = shares.get(member.id) ?? 0;
      return {
        memberId: member.id,
        halfMealUnits: mealCounts.get(member.id) ?? 0,
        paidMinor,
        shareMinor,
        balanceMinor: sumMinor([paidMinor, -shareMinor]),
      };
    })
    .sort((a, b) => compareIds(a.memberId, b.memberId));
}

export function membersForGroup(members: MessMember[], groupId: string): MessMember[] {
  return members.filter((member) => member.groupId === groupId);
}

export interface MessSettlementOptions {
  allowedMemberIds?: string[] | Set<string>;
  currency?: string;
}

export type MessSettlementValidationResult =
  | { ok: true; memberCount: number; netBalanceMinor: 0; currency?: string }
  | { ok: false; error: string };

/**
 * Checks member balances before a settlement: each member must exist and appear once, amounts
 * must be safe integers, and the balances must add up to exactly zero. It only checks; it
 * doesn't create any transactions.
 */
export function validateMessSettlementInput(
  balances: MessMemberBalance[],
  options?: MessSettlementOptions,
): MessSettlementValidationResult {
  if (!Array.isArray(balances) || balances.length === 0) {
    return { ok: false, error: 'At least one member balance is required for settlement.' };
  }

  if (options?.currency !== undefined && (typeof options.currency !== 'string' || !/^[A-Z]{3}$/.test(options.currency))) {
    return { ok: false, error: 'Settlement currency is invalid.' };
  }

  const allowed = options?.allowedMemberIds
    ? (options.allowedMemberIds instanceof Set ? options.allowedMemberIds : new Set(options.allowedMemberIds))
    : null;

  const seen = new Set<string>();

  for (const b of balances) {
    if (!b || typeof b !== 'object') {
      return { ok: false, error: 'Member balance entry must be an object.' };
    }
    if (typeof b.memberId !== 'string' || !b.memberId.trim()) {
      return { ok: false, error: 'Member id is required and cannot be empty.' };
    }
    if (seen.has(b.memberId)) {
      return { ok: false, error: `Duplicate member balance entry for member: ${b.memberId}` };
    }
    seen.add(b.memberId);

    if (allowed && !allowed.has(b.memberId)) {
      return { ok: false, error: `Member ${b.memberId} does not belong to the settlement group.` };
    }

    if (typeof b.balanceMinor !== 'number' || !Number.isSafeInteger(b.balanceMinor)) {
      return { ok: false, error: `Balance for member ${b.memberId} must be a safe integer minor unit.` };
    }

    if (typeof b.paidMinor === 'number') {
      if (!Number.isSafeInteger(b.paidMinor) || b.paidMinor < 0) {
        return { ok: false, error: `Paid amount for member ${b.memberId} must be a non-negative safe integer.` };
      }
    }

    if (typeof b.shareMinor === 'number') {
      if (!Number.isSafeInteger(b.shareMinor) || b.shareMinor < 0) {
        return { ok: false, error: `Share amount for member ${b.memberId} must be a non-negative safe integer.` };
      }
    }

    if (typeof b.paidMinor === 'number' && typeof b.shareMinor === 'number') {
      if (b.balanceMinor !== b.paidMinor - b.shareMinor) {
        return { ok: false, error: `Balance for member ${b.memberId} does not match paid minus share.` };
      }
    }
  }

  let totalNet: Minor;
  try {
    totalNet = sumMinor(balances.map((b) => b.balanceMinor));
  } catch (error) {
    if (error instanceof RangeError) {
      return { ok: false, error: 'Total settlement balance exceeds the safe integer range.' };
    }
    throw error;
  }

  if (totalNet !== 0) {
    return {
      ok: false,
      error: `Mess settlement refuses unbalanced input: sum of member balances must be zero (current net sum: ${totalNet}).`,
    };
  }

  return {
    ok: true,
    memberCount: balances.length,
    netBalanceMinor: 0,
    currency: options?.currency,
  };
}
