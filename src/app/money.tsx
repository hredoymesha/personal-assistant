import { useRef, useState } from 'react';
import { Text, useWindowDimensions, View } from 'react-native';
import { isValidDateStr } from '../domain/dates';
import { USER_CURRENCIES, formatMoney, parseMoney } from '../domain/money';
import { categoryTotals, goalProgress, monthTotals, netDebt, trackedExpensesForTotals } from '../domain/summaries';
import type { Debt, DebtDirection } from '../domain/types';
import { EXPENSE_CATEGORIES } from '../domain/types';
import { useApp } from '../state/AppProvider';
import { findDuplicateExpense } from '../domain/duplicates';
import { Button, Card, Chips, ConfirmButton, EmptyState, Field, Loading, ProgressBar, Screen, SectionTitle } from '../ui/components';
import { type as typography, useTheme } from '../ui/theme';
import { ReceiptAttachments } from '../ui/ReceiptAttachments';
import Wallets from '../ui/Wallets';
import Mess from '../ui/Mess';
import { DebtReminderModal } from '../ui/DebtReminderModal';

const TABS = ['Expenses', 'Savings', 'Debts', 'Wallets', 'Mess'] as const;
type Tab = (typeof TABS)[number];

export default function Money() {
  const app = useApp();
  const { c } = useTheme();
  const [tab, setTab] = useState<Tab>('Expenses');
  if (app.status === 'loading') return <Screen title="Money"><Loading /></Screen>;
  return (
    <Screen title="Money">
      <Chips label="Section" options={TABS} value={tab} onChange={setTab} />
      {tab === 'Expenses' ? <Expenses /> : tab === 'Savings' ? <Savings /> : tab === 'Debts' ? <Debts /> : tab === 'Wallets' ? <Wallets /> : <Mess />}
      <Text style={[typography.caption, { color: c.sub, marginTop: 16 }]}>Amounts are stored as whole minor units, for example poisha, so totals are exact. Different currencies are never added together.</Text>
    </Screen>
  );
}

function Expenses() {
  const { data, today, addExpense, deleteExpense } = useApp();
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const compact = width < 420;
  const cur = data.settings.currency;
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(cur);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [category, setCategory] = useState<string>('Food');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [ackSig, setAckSig] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  async function save() {
    if (savingRef.current) return;
    const minor = parseMoney(amount, currency);
    if (minor === null || minor === 0) return setError(`Enter an amount greater than 0 with at most ${currency === 'JPY' ? 0 : 2} decimals, e.g. 250 or 250.50.`);
    if (!isValidDateStr(date)) return setError('Date must be a real date like 2026-10-10.');
    const linkedWallet = data.wallets.find((wallet) => wallet.id === walletId && wallet.currency === currency);
    const candidate = { amountMinor: minor, currency, category, note: note.trim(), date, walletId: linkedWallet?.id ?? null };
    const sig = JSON.stringify(candidate);
    const dup = findDuplicateExpense(data.expenses, candidate);
    if (dup && ackSig !== sig) {
      setAckSig(sig);
      return setError(`This looks identical to an existing expense: ${formatMoney(dup.amountMinor, dup.currency)}, ${dup.category}, ${dup.date}. Press "Add anyway" to save it again.`);
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const saveError = await addExpense(candidate);
      if (saveError) { setError(saveError); return; }
      setAmount(''); setNote(''); setError(null); setAckSig(null); setOpen(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save this expense.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const liveSig = JSON.stringify({ amountMinor: parseMoney(amount, currency), currency, category, note: note.trim(), date, walletId });
  const currencyWallets = data.wallets.filter((wallet) => wallet.currency === currency);
  const sorted = [...data.expenses].sort((a, b) => b.date.localeCompare(a.date));
  const trackedExpenses = trackedExpensesForTotals(data);
  const month = Object.entries(monthTotals(trackedExpenses, today));
  const monthItems = trackedExpenses.filter((e) => e.date.startsWith(today.slice(0, 7)));
  const breakdown = categoryTotals(monthItems, cur);

  return (
    <>
      <Card>
        <Text style={[typography.secondary, { color: c.sub }]}>This month - {monthItems.length} expenses</Text>
        {month.length ? month.map(([k, v]) => <Text key={k} style={[typography.body, { color: c.text, fontSize: 24, lineHeight: 32, fontWeight: '800' }]}>{formatMoney(v, k)}</Text>) : <Text style={[typography.body, { color: c.text, fontSize: 24, lineHeight: 32, fontWeight: '800' }]}>{formatMoney(0, cur)}</Text>}
        {breakdown.map((b) => <Text key={b.category} style={[typography.body, { color: c.sub }]}>{b.category}: {formatMoney(b.total, cur)}</Text>)}
        <Text style={[typography.caption, { color: c.sub, marginTop: 6 }]}>Includes mess expenses paid from your wallets; details are in the Mess section.</Text>
      </Card>
      {open ? (
        <Card>
          <Field label={`Amount - ${currency}`} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" autoFocus />
          <Chips label="Currency" options={USER_CURRENCIES} value={currency} onChange={(value) => { setCurrency(value); if (!data.wallets.some((wallet) => wallet.id === walletId && wallet.currency === value)) setWalletId(null); }} />
          {currencyWallets.length ? (
            <Chips
              label="Wallet - optional, lowers that wallet's balance"
              options={['none', ...currencyWallets.map((wallet) => wallet.id)]}
              labels={{ none: 'No wallet', ...Object.fromEntries(currencyWallets.map((wallet) => [wallet.id, wallet.name])) }}
              value={walletId && currencyWallets.some((wallet) => wallet.id === walletId) ? walletId : 'none'}
              onChange={(value) => setWalletId(value === 'none' ? null : value)}
            />
          ) : null}
          <Chips label="Category" options={EXPENSE_CATEGORIES} value={category as (typeof EXPENSE_CATEGORIES)[number]} onChange={setCategory} />
          <Field label="Note - optional" value={note} onChangeText={setNote} maxLength={500} />
          <Field label="Date - YYYY-MM-DD" value={date} onChangeText={setDate} maxLength={10} />
          {error ? <Text accessibilityRole="alert" style={{ color: c.danger, marginBottom: 8 }}>{error}</Text> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label={saving ? 'Saving…' : ackSig === liveSig ? 'Add anyway' : 'Save expense'} disabled={saving} onPress={save} style={{ flex: 1 }} />
            <Button kind="secondary" label="Cancel" disabled={saving} onPress={() => setOpen(false)} style={{ flex: 1 }} />
          </View>
        </Card>
      ) : <Button label="＋ Add expense" onPress={() => { setCurrency(cur); setWalletId(null); setOpen(true); }} />}
      <SectionTitle>All expenses</SectionTitle>
      {sorted.length === 0 ? <EmptyState title="No expenses yet" hint="Add one above to start tracking." /> : sorted.map((e) => (
        <Card key={e.id}>
          <View style={{ flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', gap: 8 }}>
          <View style={{ flex: compact ? undefined : 1, width: compact ? '100%' : undefined }}>
            <Text style={[typography.cardTitle, { color: c.text }]}>{formatMoney(e.amountMinor, e.currency)} · {e.category}</Text>
            <Text style={[typography.secondary, { color: c.sub }]}>{e.date}{e.note ? ` · ${e.note}` : ''}</Text>
          </View>
          <ConfirmButton label="Delete" onConfirm={() => deleteExpense(e.id)} />
          </View>
          <ReceiptAttachments recordType="expense" recordId={e.id} />
        </Card>
      ))}
    </>
  );
}

function Savings() {
  const { data, addGoal, contributeToGoal, deleteGoal } = useApp();
  const { c } = useTheme();
  const cur = data.settings.currency;
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [add, setAdd] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [cardErr, setCardErr] = useState<Record<string, string>>({});

  function contribute(id: string, currency: string) {
    const m = parseMoney(add[id] ?? '', currency);
    if (m === null || m === 0) return setCardErr({ ...cardErr, [id]: 'Enter an amount greater than 0, e.g. 500 or 500.50.' });
    contributeToGoal(id, m);
    setAdd({ ...add, [id]: '' }); setCardErr({ ...cardErr, [id]: '' });
  }

  function create() {
    const t = parseMoney(target, cur);
    if (!name.trim()) return setError('Give the goal a name.');
    if (t === null || t === 0) return setError('Target must be an amount greater than 0.');
    addGoal({ name: name.trim(), targetMinor: t, currency: cur });
    setName(''); setTarget(''); setError(null);
  }
  return (
    <>
      <Card>
        <Field label="New goal name" value={name} onChangeText={setName} maxLength={100} />
        <Field label={`Target - ${cur}`} value={target} onChangeText={setTarget} keyboardType="decimal-pad" />
        {error ? <Text accessibilityRole="alert" style={{ color: c.danger, marginBottom: 8 }}>{error}</Text> : null}
        <Button label="Add goal" onPress={create} />
      </Card>
      {data.goals.length === 0 ? <EmptyState title="No savings goals" hint="Create one above." /> : data.goals.map((g) => (
        <Card key={g.id}>
          <Text style={[typography.cardTitle, { color: c.text, marginBottom: 6 }]}>{g.name}</Text>
          <ProgressBar pct={goalProgress(g)} label={`${g.name} ${goalProgress(g)} percent`} />
          <Text style={[typography.body, { color: c.sub, marginVertical: 6 }]}>{formatMoney(g.savedMinor, g.currency)} of {formatMoney(g.targetMinor, g.currency)} · {goalProgress(g)}%</Text>
          <Field label={`Add savings - ${g.currency}`} value={add[g.id] ?? ''} onChangeText={(v) => setAdd({ ...add, [g.id]: v })} keyboardType="decimal-pad" error={cardErr[g.id]} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label="Add" style={{ flex: 1 }} onPress={() => contribute(g.id, g.currency)} />
            <ConfirmButton label="Delete goal" confirmLabel="Tap again to delete" onConfirm={() => deleteGoal(g.id)} />
          </View>
        </Card>
      ))}
    </>
  );
}

function Debts() {
  const { data, addDebt, payDebt, deleteDebt } = useApp();
  const { c } = useTheme();
  const cur = data.settings.currency;
  const [person, setPerson] = useState('');
  const [amount, setAmount] = useState('');
  const [dir, setDir] = useState<DebtDirection>('i_owe');
  const [pay, setPay] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [cardErr, setCardErr] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [reminderDebt, setReminderDebt] = useState<Debt | null>(null);
  const net = netDebt(data, cur);

  async function record(id: string, currency: string) {
    const m = parseMoney(pay[id] ?? '', currency);
    if (m === null || m === 0) return setCardErr({ ...cardErr, [id]: 'Enter an amount greater than 0, e.g. 500 or 500.50.' });
    const error = await payDebt(id, m);
    if (error) return setCardErr({ ...cardErr, [id]: error });
    setPay({ ...pay, [id]: '' }); setCardErr({ ...cardErr, [id]: '' });
  }

  async function create() {
    const m = parseMoney(amount, cur);
    if (!person.trim()) return setError('Enter a name.');
    if (m === null || m === 0) return setError('Amount must be greater than 0.');
    setSaving(true);
    try {
      const saveError = await addDebt({ person: person.trim(), direction: dir, amountMinor: m, currency: cur, dueDate: null });
      if (saveError) {
        setError(saveError);
        return;
      }
      setPerson('');
      setAmount('');
      setError(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save this debt.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <Card>
        <Text style={[typography.cardTitle, { color: c.text, marginBottom: 10 }]}>Open balances</Text>
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
            <Text style={[typography.body, { color: c.sub, flex: 1 }]}>Owed to me</Text>
            <Text style={[typography.body, { color: c.text, fontWeight: '700' }]}>{formatMoney(net.owedToMe, cur)}</Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
            <Text style={[typography.body, { color: c.sub, flex: 1 }]}>I owe</Text>
            <Text style={[typography.body, { color: c.text, fontWeight: '700' }]}>{formatMoney(net.iOwe, cur)}</Text>
          </View>
        </View>
        <Text style={[typography.secondary, { color: c.sub, marginTop: 12 }]}>Open means amount minus paid, per record, in {cur} only.</Text>
        <Text style={[typography.caption, { color: c.sub, marginTop: 8 }]}>Payments apply oldest-first to dated debts for the same person, type, and currency. Imported debts with unknown creation dates are paid only from their own record.</Text>
      </Card>
      <Card>
        <Chips label="Type" options={['i_owe', 'owed_to_me'] as const} value={dir} onChange={setDir} labels={{ i_owe: 'I owe someone', owed_to_me: 'Someone owes me' }} />
        <Field label="Person" value={person} onChangeText={setPerson} maxLength={100} />
        <Field label={`Amount - ${cur}`} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
        {error ? <Text accessibilityRole="alert" style={{ color: c.danger, marginBottom: 8 }}>{error}</Text> : null}
        <Button label={saving ? 'Adding…' : 'Add'} disabled={saving} onPress={create} />
      </Card>
      {data.debts.length === 0 ? <EmptyState title="No debts or loans" hint="Add one above." /> : data.debts.map((d) => {
        const openMinor = Math.max(0, d.amountMinor - d.paidMinor);
        return (
          <Card key={d.id}>
            <Text style={[typography.cardTitle, { color: c.text }]}>{d.direction === 'i_owe' ? 'I owe' : 'Owed to me'} · {d.person}</Text>
            <Text style={[typography.secondary, { color: c.sub, marginBottom: 8 }]}>{formatMoney(d.paidMinor, d.currency)} paid of {formatMoney(d.amountMinor, d.currency)}</Text>
            <Field label={`Record payment - ${d.currency}`} value={pay[d.id] ?? ''} onChangeText={(v) => setPay({ ...pay, [d.id]: v })} keyboardType="decimal-pad" error={cardErr[d.id]} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Button label="Record" style={{ flexGrow: 1, minWidth: 112 }} onPress={() => { void record(d.id, d.currency); }} />
              {openMinor > 0 ? (
                <Button label="Reminder" kind="secondary" onPress={() => setReminderDebt(d)} />
              ) : null}
              <ConfirmButton label="Delete" onConfirm={() => deleteDebt(d.id)} />
            </View>
            <ReceiptAttachments recordType="debt" recordId={d.id} />
          </Card>
        );
      })}
      {reminderDebt ? (
        <DebtReminderModal
          debt={reminderDebt}
          contacts={data.syncedContacts}
          onClose={() => setReminderDebt(null)}
        />
      ) : null}
    </>
  );
}
