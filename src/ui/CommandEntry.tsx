import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { addDays } from '../domain/dates';
import { findDuplicateExpense } from '../domain/duplicates';
import { USER_CURRENCIES, formatMoney, parseMoney } from '../domain/money';
import { checkDraft } from '../domain/parser/draft';
import { parseCommand, SUPPORTED_HELP, type CommandDraft, type CommandKind, type DraftField } from '../domain/parser/parse';
import { EXPENSE_CATEGORIES } from '../domain/types';
import { useApp } from '../state/AppProvider';
import { Banner, Button, Card, Chips, Field, SectionTitle } from './components';
import { type as typography, useTheme } from './theme';

const KIND_LABEL: Record<CommandKind, string> = { expense: 'Add expense', task: 'Add task', reminder: 'Add reminder' };
const KIND_BY_LABEL: Record<string, CommandKind> = { Expense: 'expense', Task: 'task', Reminder: 'reminder' };
const LABEL_BY_KIND: Record<CommandKind, string> = { expense: 'Expense', task: 'Task', reminder: 'Reminder' };

/**
 * Local rule-based command entry (not generative AI). Parsing never saves anything: the user must
 * press Confirm on the review card, and Confirm is only enabled when `checkDraft` finds the draft valid.
 */
export function CommandEntry() {
  const { data, today, addExpense, addTask } = useApp();
  const { c } = useTheme();
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<CommandDraft | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false); // blocks a double-tap from saving twice

  const check = draft ? checkDraft(draft, today) : null;
  const dup = check?.action?.type === 'addExpense' ? findDuplicateExpense(data.expenses, check.action.value) : null;

  function review() {
    setSaveError(null);
    const r = parseCommand(text, today);
    if (!r.ok) { setDraft(null); setRejected(r.error); return; }
    setRejected(null);
    setDraft(r.draft);
    setEditing(!checkDraft(r.draft, today).action); // open the editor straight away when something needs fixing
  }

  /** Any user edit updates the preview and clears that field's parse-time question. */
  function edit(patch: Partial<CommandDraft>, field?: DraftField) {
    setDraft((d) => (d ? { ...d, ...patch, questions: field ? { ...d.questions, [field]: undefined } : d.questions } : d));
  }

  function cancel() { setDraft(null); setRejected(null); setEditing(false); setSaveError(null); }

  async function confirm() {
    if (busy.current || !check?.action) return;
    busy.current = true;
    setSaving(true);
    try {
      const a = check.action;
      const err = a.type === 'addExpense' ? await addExpense(a.value) : await addTask(a.value);
      if (err) { setSaveError(err); return; }
      setText(''); cancel();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save this entry.');
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  const issue = (f: DraftField) => check?.issues[f] ?? null;
  const amountMinor = draft ? parseMoney(draft.amountText, draft.currency ?? 'BDT') : null;
  const row = (label: string, value: string | null, field?: DraftField) => (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingVertical: 3 }}>
      <Text style={{ color: c.sub, width: 96, fontSize: 15 }}>{label}</Text>
      <Text style={{ color: value ? c.text : c.danger, flex: 1, fontSize: 15, fontWeight: '600' }}>
        {value ?? `Needs input${field && issue(field) ? `: ${issue(field)}` : ''}`}
      </Text>
    </View>
  );

  return (
    <>
      <SectionTitle>Quick command</SectionTitle>
      <Card>
        <Text style={[typography.secondary, { color: c.sub, marginBottom: 10 }]}>
          A local command parser, not AI. It understands common English, বাংলা and Banglish phrases on your device. Nothing is saved until you confirm.
        </Text>
        <Field label="Type or paste a command" value={text} onChangeText={(t) => { setText(t); if (rejected) setRejected(null); }}
          multiline maxLength={500} placeholder="e.g. I spent 120 taka on transport yesterday" />
        <Button label="Review" disabled={!text.trim()} onPress={review} />
        {rejected ? <View style={{ marginTop: 8 }}><Banner tone="warn" text={rejected.includes('Try e.g.') ? rejected : `${rejected} ${SUPPORTED_HELP}`} /></View> : null}
      </Card>

      {draft && check ? (
        <Card style={{ borderColor: c.primary, borderWidth: 1.5 }}>
          <Text accessibilityRole="header" style={{ color: c.text, fontSize: 17, fontWeight: '800', marginBottom: 6 }}>Review before saving</Text>
          <View style={{ paddingVertical: 3 }}>
            <Text style={{ color: c.sub, fontSize: 14 }}>You wrote</Text>
            <Text selectable style={{ color: c.text, fontSize: 15, fontStyle: 'italic' }}>{`"${draft.original}"`}</Text>
          </View>
          {row('Action', draft.kind ? KIND_LABEL[draft.kind] : null, 'kind')}
          {row(draft.kind === 'expense' ? 'Description' : 'Title', draft.title.trim() || (draft.kind === 'expense' ? 'None' : null), 'title')}
          {draft.kind === 'expense' ? (
            <>
              {row('Amount', draft.amountText && amountMinor ? (draft.currency ? formatMoney(amountMinor, draft.currency) : `${draft.amountText} - currency not chosen`) : null, draft.currency ? 'amount' : 'currency')}
              {row('Category', draft.category, 'category')}
            </>
          ) : null}
          {draft.kind ? row('Date', draft.date ?? (draft.kind === 'task' && !issue('date') ? 'None' : null), 'date') : null}
          {draft.time || issue('time') ? row('Time', draft.time, 'time') : null}

          {draft.assumptions.map((a, i) => <Text key={i} style={{ color: c.warn, fontSize: 14, marginTop: 4 }}>Assumption: {a}</Text>)}
          {Object.entries(check.issues).filter(([f]) => !['kind', 'title', 'amount', 'currency', 'category', 'date', 'time'].includes(f)).map(([f, m]) => <Text key={f} style={{ color: c.danger, marginTop: 4 }}>{m}</Text>)}
          {dup ? <View style={{ marginTop: 8 }}><Banner tone="warn" text={`An identical expense already exists - ${formatMoney(dup.amountMinor, dup.currency)} on ${dup.date}. Confirming will add another.`} /></View> : null}
          {saveError ? <View style={{ marginTop: 8 }}><Banner tone="danger" text={saveError} /></View> : null}

          {editing ? (
            <View style={{ marginTop: 12 }}>
              <Chips label="Create a…" options={['Expense', 'Task', 'Reminder']} value={draft.kind ? LABEL_BY_KIND[draft.kind] : ('' as 'Expense')}
                onChange={(v) => edit({ kind: KIND_BY_LABEL[v] }, 'kind')} />
              <Field label={draft.kind === 'expense' ? 'Description - optional' : 'Title'} value={draft.title} onChangeText={(t) => edit({ title: t }, 'title')} maxLength={500} />
              {draft.kind === 'expense' ? (
                <>
                  <Field label="Amount" value={draft.amountText} onChangeText={(t) => edit({ amountText: t }, 'amount')} keyboardType="decimal-pad" error={issue('amount')} />
                  <Chips label="Currency" options={USER_CURRENCIES} value={(draft.currency ?? '') as string} onChange={(v) => edit({ currency: v }, 'currency')} />
                  {issue('currency') ? <Text style={{ color: c.danger, marginBottom: 8 }}>{issue('currency')}</Text> : null}
                  <Chips label="Category" options={EXPENSE_CATEGORIES} value={(draft.category ?? '') as (typeof EXPENSE_CATEGORIES)[number]} onChange={(v) => edit({ category: v }, 'category')} />
                  {issue('category') ? <Text style={{ color: c.danger, marginBottom: 8 }}>{issue('category')}</Text> : null}
                </>
              ) : null}
              <Field label="Date - YYYY-MM-DD" value={draft.date ?? ''} onChangeText={(t) => edit({ date: t.trim() ? t.trim() : null }, 'date')} maxLength={10} error={issue('date')} />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                <Button kind="secondary" label="Yesterday" onPress={() => edit({ date: addDays(today, -1) }, 'date')} />
                <Button kind="secondary" label="Today" onPress={() => edit({ date: today }, 'date')} />
                <Button kind="secondary" label="Tomorrow" onPress={() => edit({ date: addDays(today, 1) }, 'date')} />
                {draft.kind === 'task' ? <Button kind="secondary" label="No date" onPress={() => edit({ date: null, time: null }, 'date')} /> : null}
              </View>
              {draft.kind !== 'expense' ? (
                <>
                  <Field label="Time - HH:mm, optional" value={draft.time ?? ''} onChangeText={(t) => edit({ time: t.trim() ? t.trim() : null }, 'time')} maxLength={5} error={issue('time')} />
                  <Chips label="Priority" options={['low', 'medium', 'high'] as const} value={draft.priority} onChange={(p) => edit({ priority: p })} />
                </>
              ) : null}
            </View>
          ) : null}

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            <Button label={saving ? 'Saving…' : dup ? 'Add anyway' : 'Confirm'} disabled={!check.action || saving} onPress={confirm} style={{ flex: 1, minWidth: 110 }} />
            <Button kind="secondary" label={editing ? 'Done editing' : 'Edit'} onPress={() => setEditing((e) => !e)} style={{ flex: 1, minWidth: 110 }} />
            <Button kind="secondary" label="Cancel" onPress={cancel} style={{ flex: 1, minWidth: 110 }} />
          </View>
          {!check.action ? <Text style={{ color: c.sub, fontSize: 13, marginTop: 8 }}>Confirm unlocks when every required detail is filled in.</Text> : null}
        </Card>
      ) : null}
    </>
  );
}
