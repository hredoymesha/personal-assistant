import { useMemo, useState } from 'react';
import { Text, useWindowDimensions, View } from 'react-native';
import { isValidDateStr } from '../domain/dates';
import { allocateByMeals, allocateEqually, formatHalfMeals, parseHalfMealUnits, summarizeMessGroup, validateCustomAllocation } from '../domain/mess';
import { USER_CURRENCIES, formatMoney, parseMoney } from '../domain/money';
import type { MessAllocation, MessAllocationMode } from '../domain/types';
import { walletsInCurrency } from '../domain/wallets';
import { useApp } from '../state/AppProvider';
import { Button, Card, Chips, ConfirmButton, EmptyState, Field, SectionTitle } from './components';
import { ReceiptAttachments } from './ReceiptAttachments';
import { type as typography, useTheme } from './theme';

export default function Mess() {
  const app = useApp();
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const compact = width < 420;
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [selfName, setSelfName] = useState('Me');
  const [groupCurrency, setGroupCurrency] = useState(app.data.settings.currency);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(`${app.today.slice(0, 7)}-01`);
  const [endDate, setEndDate] = useState(app.today);
  const [memberName, setMemberName] = useState('');
  const [memberContactId, setMemberContactId] = useState<string | null>(null);
  const [contactSearch, setContactSearch] = useState('');
  const [memberError, setMemberError] = useState<string | null>(null);
  const [memberId, setMemberId] = useState('');
  const [mealCount, setMealCount] = useState('');
  const [mealDate, setMealDate] = useState(app.today);
  const [mealError, setMealError] = useState<string | null>(null);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseDate, setExpenseDate] = useState(app.today);
  const [expenseCategory, setExpenseCategory] = useState('Food');
  const [expenseNote, setExpenseNote] = useState('');
  const [payerMemberId, setPayerMemberId] = useState('');
  const [expenseWalletId, setExpenseWalletId] = useState('');
  const [allocationMode, setAllocationMode] = useState<MessAllocationMode>('meals');
  const [customShares, setCustomShares] = useState<Record<string, string>>({});
  const [expenseError, setExpenseError] = useState<string | null>(null);

  const group = app.data.messGroups.find((item) => item.id === selectedGroupId) ?? app.data.messGroups[0];
  const members = app.data.messMembers.filter((member) => member.groupId === group?.id);
  const self = members.find((member) => member.isSelf);
  const memberOptions = members.map((member) => member.id);
  const memberLabels = Object.fromEntries(members.map((member) => [member.id, member.isSelf ? `${member.name} - you` : member.name]));
  const groupWallets = group ? walletsInCurrency(app.data.wallets, group.currency) : [];
  const payer = members.find((member) => member.id === payerMemberId) ?? self;
  const availableContacts = app.data.syncedContacts.filter((contact) => {
    const query = contactSearch.trim().toLocaleLowerCase();
    return query && `${contact.fullName} ${contact.phones.join(' ')}`.toLocaleLowerCase().includes(query);
  }).slice(0, 8);

  const report = useMemo(() => {
    if (!group || !isValidDateStr(startDate) || !isValidDateStr(endDate) || startDate > endDate) return null;
    return summarizeMessGroup(app.data, group.id, startDate, endDate);
  }, [app.data, endDate, group, startDate]);

  async function createGroup() {
    if (!groupName.trim()) return setGroupError('Enter a mess group name.');
    if (!selfName.trim()) return setGroupError('Enter your name for this group.');
    const error = await app.addMessGroup({ name: groupName.trim(), currency: groupCurrency }, selfName.trim());
    if (error) return setGroupError(error);
    setSelectedGroupId('');
    setGroupName(''); setSelfName('Me'); setGroupError(null); setNewGroupOpen(false);
  }

  async function createMember() {
    if (!group) return;
    if (!memberName.trim()) return setMemberError('Enter a member name or choose a synced contact.');
    const error = await app.addMessMember({ groupId: group.id, name: memberName.trim(), contactId: memberContactId });
    if (error) return setMemberError(error);
    setMemberName(''); setMemberContactId(null); setContactSearch(''); setMemberError(null);
  }

  async function createMeal() {
    if (!group) return;
    const selectedMemberId = members.some((member) => member.id === memberId) ? memberId : members[0]?.id;
    if (!selectedMemberId) return setMealError('Choose a member.');
    const halfMealUnits = parseHalfMealUnits(mealCount);
    if (halfMealUnits === null) return setMealError('Enter a positive meal count in steps of 0.5.');
    if (!isValidDateStr(mealDate)) return setMealError('Enter a real date in YYYY-MM-DD format.');
    const error = await app.addMessMeal({ groupId: group.id, memberId: selectedMemberId, date: mealDate, halfMealUnits });
    if (error) return setMealError(error);
    setMealCount(''); setMealError(null);
  }

  function makeAllocations(amountMinor: number): MessAllocation[] {
    if (!group) throw new Error('Choose a mess group.');
    if (allocationMode === 'equal') return allocateEqually(amountMinor, members.map((member) => member.id));
    if (allocationMode === 'custom') {
      const allocations = members.map((member) => {
        const amount = parseMoney(customShares[member.id] ?? '', group.currency);
        if (amount === null) throw new Error(`Enter a valid ${group.currency} custom share for ${member.name}; use 0 for no share.`);
        return { memberId: member.id, amountMinor: amount };
      });
      return validateCustomAllocation(amountMinor, allocations);
    }
    if (!isValidDateStr(startDate) || !isValidDateStr(endDate) || startDate > endDate) {
      throw new Error('Enter a valid meal allocation date range.');
    }
    const totals = new Map<string, number>();
    for (const meal of app.data.messMeals) {
      if (meal.groupId !== group.id || meal.date < startDate || meal.date > endDate) continue;
      const next = (totals.get(meal.memberId) ?? 0) + meal.halfMealUnits;
      if (!Number.isSafeInteger(next)) throw new Error('Meal count exceeds the safe range.');
      totals.set(meal.memberId, next);
    }
    const weights = members
      .map((member) => ({ memberId: member.id, halfMealUnits: totals.get(member.id) ?? 0 }))
      .filter((weight) => weight.halfMealUnits > 0);
    if (!weights.length) throw new Error('No meal counts were recorded in this date range.');
    return allocateByMeals(amountMinor, weights);
  }

  async function createExpense() {
    if (!group) return setExpenseError('Choose a mess group.');
    if (!payer) return setExpenseError('Choose who paid.');
    const amountMinor = parseMoney(expenseAmount, group.currency);
    if (amountMinor === null || amountMinor === 0) return setExpenseError(`Enter an amount greater than zero in ${group.currency}.`);
    if (!isValidDateStr(expenseDate)) return setExpenseError('Enter a real date in YYYY-MM-DD format.');
    const walletId = payer.isSelf ? expenseWalletId : null;
    if (payer.isSelf && !walletId) return setExpenseError('Choose the wallet used for this payment.');
    let allocations: MessAllocation[];
    try { allocations = makeAllocations(amountMinor); }
    catch (error) { return setExpenseError(error instanceof Error ? error.message : 'Could not allocate this expense.'); }
    const error = await app.addMessExpense({
      groupId: group.id,
      amountMinor,
      date: expenseDate,
      category: expenseCategory.trim() || 'Other',
      note: expenseNote.trim(),
      payerMemberId: payer.id,
      walletId,
      allocationMode,
      mealRangeStart: allocationMode === 'meals' ? startDate : null,
      mealRangeEnd: allocationMode === 'meals' ? endDate : null,
      allocations,
    });
    if (error) return setExpenseError(error);
    setExpenseAmount(''); setExpenseNote(''); setExpenseError(null); setExpenseOpen(false);
  }

  return (
    <>
      <SectionTitle>Mess accounting</SectionTitle>
      <Text style={[typography.secondary, { color: c.sub, marginBottom: 8 }]}>Local-only group accounting. No automatic settlements or payments are created. Expense shares are frozen when saved.</Text>
      {app.data.messGroups.length ? (
        <Chips label="Mess group" options={app.data.messGroups.map((item) => item.id)} labels={Object.fromEntries(app.data.messGroups.map((item) => [item.id, `${item.name} - ${item.currency}`]))} value={group.id} onChange={(id) => { setSelectedGroupId(id); setPayerMemberId(''); setMemberId(''); setExpenseWalletId(''); }} />
      ) : <EmptyState title="No mess groups" hint="Create a group to track meals and shared costs." />}
      {!newGroupOpen ? <Button label="＋ Add mess group" onPress={() => { setGroupCurrency(app.data.settings.currency); setNewGroupOpen(true); }} /> : (
        <Card>
          <SectionTitle>New mess group</SectionTitle>
          <Field label="Group name" value={groupName} onChangeText={setGroupName} maxLength={100} />
          <Field label="Your name in this group" value={selfName} onChangeText={setSelfName} maxLength={100} />
          <Chips label="Group currency - fixed" options={USER_CURRENCIES} value={groupCurrency} onChange={setGroupCurrency} />
          {groupError ? <Text accessibilityRole="alert" style={{ color: c.danger, marginBottom: 8 }}>{groupError}</Text> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label="Create group" style={{ flex: 1 }} onPress={() => { void createGroup(); }} />
            <Button kind="secondary" label="Cancel" onPress={() => setNewGroupOpen(false)} />
          </View>
        </Card>
      )}
      {group ? (
        <>
          <Card>
            <Text style={[typography.cardTitle, { color: c.text, fontSize: 18 }]}>{group.name}</Text>
            <Text style={[typography.secondary, { color: c.sub, marginTop: 4 }]}>{group.currency} only · {members.length} members</Text>
            <View style={{ marginTop: 8 }}>
              {members.map((member) => (
                <View key={member.id} style={{ flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', gap: 8, paddingVertical: 4 }}>
                  <Text style={[typography.secondary, { color: c.text, flex: compact ? undefined : 1 }]}>{member.name}{member.isSelf ? ' · you' : ''}</Text>
                  {!member.isSelf ? <ConfirmButton label="Remove member" onConfirm={async () => setActionError(await app.deleteMessMember(member.id))} /> : null}
                </View>
              ))}
            </View>
            <ConfirmButton label="Delete empty group" onConfirm={async () => setActionError(await app.deleteMessGroup(group.id))} />
          </Card>
          {actionError ? <Text accessibilityRole="alert" style={{ color: c.danger, marginBottom: 8 }}>{actionError}</Text> : null}

          <SectionTitle>Members</SectionTitle>
          <Card>
            <Field label="Name - or search synced contacts" value={memberName} onChangeText={(value) => { setMemberName(value); setContactSearch(value); setMemberContactId(null); }} maxLength={100} />
            {availableContacts.map((contact) => (
              <Button key={contact.id} kind="secondary" label={`${contact.fullName || 'No name'}${contact.phones[0] ? ` · ${contact.phones[0]}` : ''}`} onPress={() => {
                setMemberName(contact.fullName || contact.phones[0] || 'Contact');
                setMemberContactId(contact.id);
                setContactSearch('');
              }} style={{ marginBottom: 6 }} />
            ))}
            {app.data.syncedContacts.length === 0 ? <Text style={{ color: c.sub, marginBottom: 8 }}>Sync contacts in Settings, or add a name manually.</Text> : null}
            {memberError ? <Text accessibilityRole="alert" style={{ color: c.danger, marginBottom: 8 }}>{memberError}</Text> : null}
            <Button label="Add member" onPress={() => { void createMember(); }} />
          </Card>

          <SectionTitle>Report date range</SectionTitle>
          <Card>
            <Field label="From - YYYY-MM-DD" value={startDate} onChangeText={setStartDate} maxLength={10} />
            <Field label="Through - YYYY-MM-DD" value={endDate} onChangeText={setEndDate} maxLength={10} />
            {!report ? <Text accessibilityRole="alert" style={{ color: c.danger }}>Enter a valid range where the start date is not after the end date.</Text> : (
              <>
                <Text style={[typography.secondary, { color: c.sub, marginBottom: 8 }]}>Overlapping report ranges are allowed; each saved expense keeps its original allocation.</Text>
                {report.map((balance) => {
                  const member = members.find((item) => item.id === balance.memberId)!;
                  return (
                    <View key={balance.memberId} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={[typography.secondary, { color: c.text, fontWeight: '600' }]}>{member.name}{member.isSelf ? ' · you' : ''}</Text>
                        <Text style={[typography.caption, { color: c.sub }]}>{formatHalfMeals(balance.halfMealUnits)} meals · paid {formatMoney(balance.paidMinor, group.currency)} · share {formatMoney(balance.shareMinor, group.currency)}</Text>
                      </View>
                      <Text style={[typography.secondary, { color: balance.balanceMinor >= 0 ? c.success : c.danger, fontWeight: '700' }]}>{formatMoney(balance.balanceMinor, group.currency)}</Text>
                    </View>
                  );
                })}
              </>
            )}
          </Card>

          <SectionTitle>Meal counts</SectionTitle>
          <Card>
            {members.length ? <Chips label="Member" options={memberOptions} labels={memberLabels} value={members.some((item) => item.id === memberId) ? memberId : members[0].id} onChange={setMemberId} /> : null}
            <Field label="Meals - whole or half, e.g. 2.5" value={mealCount} onChangeText={setMealCount} keyboardType="decimal-pad" />
            <Field label="Date - YYYY-MM-DD" value={mealDate} onChangeText={setMealDate} maxLength={10} />
            {mealError ? <Text accessibilityRole="alert" style={{ color: c.danger, marginBottom: 8 }}>{mealError}</Text> : null}
            <Button label="Record meals" onPress={() => { void createMeal(); }} />
          </Card>
          {app.data.messMeals.filter((meal) => meal.groupId === group.id && meal.date >= startDate && meal.date <= endDate).map((meal) => (
            <Card key={meal.id} style={{ flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', gap: 8 }}>
              <Text style={[typography.secondary, { color: c.text, flex: compact ? undefined : 1 }]}>{members.find((member) => member.id === meal.memberId)?.name ?? 'Member'} · {formatHalfMeals(meal.halfMealUnits)} meals · {meal.date}</Text>
              <ConfirmButton label="Delete" onConfirm={() => app.deleteMessMeal(meal.id)} />
            </Card>
          ))}

          <SectionTitle>Shared expenses</SectionTitle>
          {!expenseOpen ? <Button label="＋ Add mess expense" onPress={() => { setExpenseDate(app.today); setPayerMemberId(self?.id ?? members[0]?.id ?? ''); setExpenseWalletId(groupWallets[0]?.id ?? ''); setExpenseOpen(true); }} /> : (
            <Card>
              <Field label={`Amount - ${group.currency}`} value={expenseAmount} onChangeText={setExpenseAmount} keyboardType="decimal-pad" />
              <Field label="Date - YYYY-MM-DD" value={expenseDate} onChangeText={setExpenseDate} maxLength={10} />
              <Field label="Category" value={expenseCategory} onChangeText={setExpenseCategory} maxLength={40} />
              <Field label="Note - optional" value={expenseNote} onChangeText={setExpenseNote} maxLength={500} />
              {members.length ? <Chips label="Paid by" options={memberOptions} labels={memberLabels} value={members.some((item) => item.id === payerMemberId) ? payerMemberId : members[0].id} onChange={(id) => { setPayerMemberId(id); if (!members.find((member) => member.id === id)?.isSelf) setExpenseWalletId(''); else if (!expenseWalletId) setExpenseWalletId(groupWallets[0]?.id ?? ''); }} /> : null}
              {payer?.isSelf ? (
                groupWallets.length ? <Chips label="Paid from - required for your payment" options={groupWallets.map((wallet) => wallet.id)} labels={Object.fromEntries(groupWallets.map((wallet) => [wallet.id, wallet.name]))} value={groupWallets.some((wallet) => wallet.id === expenseWalletId) ? expenseWalletId : groupWallets[0].id} onChange={setExpenseWalletId} /> : <Text style={{ color: c.danger, marginBottom: 8 }}>Create a {group.currency} wallet before recording an expense paid by you.</Text>
              ) : null}
              <Chips label="Split method - shares freeze when saved" options={['meals', 'equal', 'custom'] as const} labels={{ meals: 'By meals', equal: 'Equal', custom: 'Custom amounts' }} value={allocationMode} onChange={setAllocationMode} />
              {allocationMode === 'meals' ? <Text style={[typography.secondary, { color: c.sub, marginBottom: 8 }]}>Uses meal counts from {startDate} through {endDate} and stores the resulting shares.</Text> : null}
              {allocationMode === 'custom' ? members.map((member) => (
                <Field key={member.id} label={`${member.name}'s exact share - ${group.currency}, enter 0 if none`} value={customShares[member.id] ?? ''} onChangeText={(value) => setCustomShares({ ...customShares, [member.id]: value })} keyboardType="decimal-pad" />
              )) : null}
              {expenseError ? <Text accessibilityRole="alert" style={{ color: c.danger, marginBottom: 8 }}>{expenseError}</Text> : null}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button label="Save expense" style={{ flex: 1 }} onPress={() => { void createExpense(); }} />
                <Button kind="secondary" label="Cancel" onPress={() => { setExpenseOpen(false); setExpenseError(null); }} />
              </View>
            </Card>
          )}
          {app.data.messExpenses.filter((expense) => expense.groupId === group.id && expense.date >= startDate && expense.date <= endDate).sort((a, b) => b.date.localeCompare(a.date)).map((expense) => (
            <Card key={expense.id}>
              <View style={{ flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', gap: 8 }}>
                <View style={{ flex: compact ? undefined : 1 }}>
                  <Text style={[typography.cardTitle, { color: c.text }]}>{formatMoney(expense.amountMinor, group.currency)} · {expense.category}</Text>
                  <Text style={[typography.secondary, { color: c.sub }]}>{expense.date} · paid by {members.find((member) => member.id === expense.payerMemberId)?.name ?? 'Member'}{expense.note ? ` · ${expense.note}` : ''}</Text>
                  <Text style={[typography.caption, { color: c.sub }]}>Split: {expense.allocationMode}{expense.mealRangeStart ? ` - ${expense.mealRangeStart} to ${expense.mealRangeEnd}` : ''}; shares are fixed.</Text>
                  {expense.allocations.map((allocation) => (
                    <Text key={allocation.memberId} style={[typography.caption, { color: c.sub }]}>{members.find((member) => member.id === allocation.memberId)?.name ?? 'Member'}: {formatMoney(allocation.amountMinor, group.currency)}</Text>
                  ))}
                </View>
                <ConfirmButton label="Delete" onConfirm={() => app.deleteMessExpense(expense.id)} />
              </View>
              <ReceiptAttachments recordType="mess_expense" recordId={expense.id} />
            </Card>
          ))}
        </>
      ) : null}
    </>
  );
}
