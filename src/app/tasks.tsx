import { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { addDays, isValidDateStr, isValidTimeStr } from '../domain/dates';
import { activeTasks, isOverdueTask } from '../domain/summaries';
import type { Priority, Recurrence, Task } from '../domain/types';
import { TASK_CATEGORIES } from '../domain/types';
import { useApp } from '../state/AppProvider';
import { Button, Card, Chips, EmptyState, Field, Loading, Screen } from '../ui/components';
import { MIN_TOUCH, space, type as typography, useTheme } from '../ui/theme';

const PRIORITIES: readonly Priority[] = ['low', 'medium', 'high'];
const RECURRENCES: readonly Recurrence[] = ['none', 'daily', 'weekly', 'monthly'];
const PRIORITY_LABELS: Record<Priority, string> = { low: 'Low', medium: 'Medium', high: 'High' };
const RECURRENCE_LABELS: Record<Recurrence, string> = { none: 'None', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

export default function Tasks() {
  const { status, data, today, addTask, updateTask, toggleTask, deleteTask } = useApp();
  const { c } = useTheme();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [category, setCategory] = useState<string>('Personal');
  const [recurrence, setRecurrence] = useState<Recurrence>('none');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return activeTasks(data.tasks)
      .filter((t) => !needle || (t.title + ' ' + t.notes + ' ' + t.category).toLowerCase().includes(needle))
      .sort((a, b) => Number(a.done) - Number(b.done) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
  }, [data.tasks, q]);

  function open(t?: Task) {
    setEditing(t ? t.id : 'new');
    setTitle(t?.title ?? ''); setNotes(t?.notes ?? ''); setDueDate(t?.dueDate ?? ''); setDueTime(t?.dueTime ?? '');
    setPriority(t?.priority ?? 'medium'); setCategory(t?.category ?? 'Personal'); setRecurrence(t?.recurrence ?? 'none'); setError(null);
  }

  async function save() {
    if (savingRef.current) return;
    if (!title.trim()) return setError('Please enter a title.');
    if (dueDate && !isValidDateStr(dueDate)) return setError('Date must be a real date like 2026-10-31.');
    if (dueTime && !isValidTimeStr(dueTime)) return setError('Time must look like 14:30.');
    if (dueTime && !dueDate) return setError('Add a date to use a time.');
    if (recurrence !== 'none' && !dueDate) return setError('Repeating tasks need a due date.');
    const fields = { title: title.trim(), notes: notes.trim(), dueDate: dueDate || null, dueTime: dueTime || null, priority, category, recurrence };
    if (editing === 'new') {
      savingRef.current = true;
      setSaving(true);
      try {
        const saveError = await addTask(fields);
        if (saveError) { setError(saveError); return; }
        setEditing(null);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : 'Could not save this task.');
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
      return;
    }
    if (editing) {
      savingRef.current = true;
      setSaving(true);
      try {
        const saveError = await updateTask(editing, fields);
        if (saveError) { setError(saveError); return; }
        setEditing(null);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : 'Could not save this task.');
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  if (status === 'loading') return <Screen title="Tasks"><Loading /></Screen>;

  return (
    <Screen title="Tasks" right={editing ? null : <Button label="＋ New" onPress={() => open()} />}
      footer={editing ? (
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: c.bg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border }}>
          <Button label={saving ? 'Saving…' : 'Save'} disabled={saving} onPress={save} style={{ flex: 1 }} />
          <Button kind="secondary" label="Cancel" disabled={saving} onPress={() => setEditing(null)} style={{ flex: 1 }} />
        </View>
      ) : undefined}>
      {editing ? (
        <Card>
          <Field label="Title" value={title} onChangeText={setTitle} maxLength={200} />
          <Field label="Notes - optional" value={notes} onChangeText={setNotes} multiline maxLength={2000} />
          <Field label="Due date - YYYY-MM-DD, optional" value={dueDate} onChangeText={setDueDate} keyboardType="numbers-and-punctuation" maxLength={10} />
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
            <Button kind="secondary" label="Today" onPress={() => setDueDate(today)} />
            <Button kind="secondary" label="Tomorrow" onPress={() => setDueDate(addDays(today, 1))} />
            <Button kind="secondary" label="None" onPress={() => { setDueDate(''); setDueTime(''); }} />
          </View>
          <Field label="Time - HH:mm, optional" value={dueTime} onChangeText={setDueTime} keyboardType="numbers-and-punctuation" maxLength={5} />
          <Chips label="Priority" options={PRIORITIES} labels={PRIORITY_LABELS} value={priority} onChange={setPriority} />
          <Chips label="Category" options={TASK_CATEGORIES} value={category as (typeof TASK_CATEGORIES)[number]} onChange={setCategory} />
          <Chips label="Repeat" options={RECURRENCES} labels={RECURRENCE_LABELS} value={recurrence} onChange={setRecurrence} />
          {error ? <Text accessibilityRole="alert" style={{ color: c.danger, marginBottom: 8 }}>{error}</Text> : null}
        </Card>
      ) : (
        <>
          <Field label="Search tasks" value={q} onChangeText={setQ} placeholder="Search…" />
          {list.length === 0 ? (
            <EmptyState title={q ? 'No matching tasks' : 'No tasks yet'} hint={q ? 'Try a different search.' : 'Tap ＋ New to add your first task.'} />
          ) : list.map((t) => (
            <Card key={t.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: t.done }} accessibilityLabel={`Complete ${t.title}`}
                onPress={() => toggleTask(t.id)} style={{ width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={[typography.body, { fontSize: 26, lineHeight: 32, color: t.done ? c.success : c.sub }]}>{t.done ? '☑' : '☐'}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${t.title}`} onPress={() => open(t)} style={{ flex: 1, minHeight: MIN_TOUCH, justifyContent: 'center' }}>
                <Text style={[typography.cardTitle, { color: c.text, textDecorationLine: t.done ? 'line-through' : 'none' }]}>{t.title}</Text>
                <Text style={[typography.secondary, { color: isOverdueTask(t, today) ? c.danger : c.sub }]}>
                  {PRIORITY_LABELS[t.priority]} · {t.category}{t.dueDate ? ` · ${t.dueDate}${t.dueTime ? ' ' + t.dueTime : ''}` : ''}{t.recurrence !== 'none' ? ` · repeats ${t.recurrence}` : ''}
                </Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`Delete ${t.title}`} onPress={() => deleteTask(t.id)} style={{ width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={[typography.body, { fontSize: 20, lineHeight: 24, color: c.danger }]}>🗑</Text>
              </Pressable>
            </Card>
          ))}
        </>
      )}
    </Screen>
  );
}
