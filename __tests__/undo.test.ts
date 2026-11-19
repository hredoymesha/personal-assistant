import { sampleData } from '../src/domain/sample';
import { applyUndo, createUndo } from '../src/state/undo';

describe('undo safety (regression: undo used to revert later edits)', () => {
  const before = sampleData('2026-10-10');
  const after = { ...before, tasks: before.tasks.slice(1) };

  it('restores when nothing changed since', () => {
    expect(applyUndo(createUndo(before, after), after)).toBe(before);
  });
  it('refuses when data changed after the undoable action', () => {
    const later = { ...after, settings: { ...after.settings, theme: 'dark' as const } };
    expect(applyUndo(createUndo(before, after), later)).toBeNull();
  });
});
