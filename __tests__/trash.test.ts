import { createTrashRecord, daysRemainingInTrash, isTrashExpired, purgeExpiredTrash, validateTrashRecord } from '../src/domain/trash';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('trash lifecycle helpers', () => {
  it('creates and validates records for supported domains', () => {
    const record = createTrashRecord('wallet', { id: 'wallet-1', name: 'Cash' }, 'wallet-1', 'Cash', 'BDT');
    expect(validateTrashRecord(record)).toEqual({ ok: true, value: record });
  });

  it('keeps records for 30 days and purges expired records', () => {
    const now = new Date('2026-01-31T00:00:00.000Z');
    const recent = createTrashRecord('task', { id: 'task-1' }, 'task-1', 'Recent', undefined, '2026-01-15T00:00:00.000Z');
    const expired = createTrashRecord('task', { id: 'task-2' }, 'task-2', 'Expired', undefined, '2025-12-01T00:00:00.000Z');

    expect(daysRemainingInTrash(recent.deletedAt, now)).toBe(14);
    expect(isTrashExpired(expired.deletedAt, now)).toBe(true);
    expect(purgeExpiredTrash([recent, expired], now)).toEqual([recent]);
  });

  it('rejects malformed records', () => {
    expect(validateTrashRecord({ id: 'x', itemType: 'unknown' })).toEqual({
      ok: false,
      error: 'Trash record itemType is invalid',
    });
  });

  it('keeps the approved provider lifecycle surface connected', () => {
    const source = readFileSync(join(process.cwd(), 'src/state/AppProvider.tsx'), 'utf8');
    expect(source).toContain('restoreTrash:');
    expect(source).toContain('purgeTrash:');
    expect(source).toContain('deleteTrashItem:');
    expect(source).toContain('emptyTrash:');
    for (const type of ['task', 'expense', 'goal', 'debt', 'wallet', 'mess_group', 'daily_expense', 'cycle_bill', 'cycle_income']) {
      expect(source).toContain(`'${type}'`);
    }
  });

  it('restores daily expense fields to every existing sheet', () => {
    const source = readFileSync(join(process.cwd(), 'src/state/AppProvider.tsx'), 'utf8');
    expect(source).toContain('dailyExpenseSheets: d.dailyExpenseSheets.map');
    expect(source).toContain('fieldIds.includes(field.id)');
    expect(source).toContain('fieldIds: [...sheet.fieldIds, field.id]');
  });

  it('preserves Cycle group bill relationships for restore', () => {
    const source = readFileSync(join(process.cwd(), 'src/state/AppProvider.tsx'), 'utf8');
    expect(source).toContain('billIds: linkedBillIds');
    expect(source).toContain('billIds.includes(bill.id)');
    expect(source).toContain('groupId: group.id, group: group.name');
  });
});
