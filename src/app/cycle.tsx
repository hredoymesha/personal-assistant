import { useMemo, useState } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { formatMoney, parseMoney } from '../domain/money';
import { useApp } from '../state/AppProvider';
import {
  CycleBill,
  BillPaidBy,
  BillFilterType,
  computeMonthSummary,
  computeGroupedMonthSheet,
  filterBillStates,
  formatMonthKey,
  getPreviousMonthKey,
  getUniformCurrency,
  DEFAULT_CYCLE_GROUP_NAMES,
} from '../domain/cycle';
import { Button, Card, Chips, ConfirmButton, EmptyState, Field, Loading, Screen, SectionTitle } from '../ui/components';
import { ReceiptAttachments } from '../ui/ReceiptAttachments';
import { type as typography, useTheme } from '../ui/theme';
import DailyExpenseSheet from '../ui/DailyExpenseSheet';

const SUB_TABS = ['Bills', 'Income', 'History', 'Month'] as const;
type SubTab = (typeof SUB_TABS)[number];

export default function CycleScreen() {
  const app = useApp();
  const { c } = useTheme();
  const [subTab, setSubTab] = useState<SubTab>('Bills');
  const [mode, setMode] = useState<'cycle' | 'daily'>('cycle');

  // Month navigation: default to today's month YYYY-MM
  const currentMonthKey = useMemo(() => app.today.slice(0, 7), [app.today]);
  const [selectedMonth, setSelectedMonth] = useState<string>(currentMonthKey);

  const userId = 'default_user';

  const summary = useMemo(() => {
    const bills = app.data.cycleBills ?? [];
    const payments = app.data.cyclePayments ?? [];
    const incomes = app.data.cycleIncomes ?? [];
    const months = app.data.cycleMonths ?? [];
    return computeMonthSummary(selectedMonth, userId, bills, payments, incomes, months, null, app.today as any, app.data.cycleBillOverrides ?? []);
  }, [selectedMonth, userId, app.data.cycleBills, app.data.cyclePayments, app.data.cycleIncomes, app.data.cycleMonths, app.data.cycleBillOverrides, app.today]);

  if (app.status === 'loading') {
    return (
      <Screen title="Money Cycle">
        <Loading />
      </Screen>
    );
  }

  function changeMonth(delta: number) {
    const [yStr, mStr] = selectedMonth.split('-');
    let y = parseInt(yStr, 10);
    let m = parseInt(mStr, 10) + delta;
    if (m > 12) {
      m = 1;
      y += 1;
    } else if (m < 1) {
      m = 12;
      y -= 1;
    }
    setSelectedMonth(formatMonthKey(y, m));
  }

  return (
    <Screen title="Money Cycle">
      <Chips label="View" options={['Cycle', 'Daily sheet']} labels={{ 'Daily sheet': 'Daily sheet' }} value={mode === 'cycle' ? 'Cycle' : 'Daily sheet'} onChange={(value) => setMode(value === 'Cycle' ? 'cycle' : 'daily')} />
      {mode === 'daily' ? <DailyExpenseSheet /> : (
      <>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 16 }}>
        <Button kind="secondary" label="← Prev" onPress={() => changeMonth(-1)} />
        <View style={{ alignItems: 'center' }}>
          <Text style={[typography.cardTitle, { color: c.text }]}>{selectedMonth}</Text>
          <Text style={[typography.caption, { color: summary.isClosed ? c.danger : c.primary, fontWeight: '600', textAlign: 'center' }]}>
            {summary.isClosed ? 'Closed · read-only' : 'Active month'}
          </Text>
        </View>
        <Button kind="secondary" label="Next →" onPress={() => changeMonth(1)} />
      </View>

      <Chips label="Section" options={SUB_TABS} value={subTab} onChange={setSubTab} />

      {subTab === 'Bills' ? (
        <BillsSection monthKey={selectedMonth} userId={userId} isClosed={summary.isClosed} />
      ) : subTab === 'Income' ? (
        <IncomeSection monthKey={selectedMonth} userId={userId} isClosed={summary.isClosed} />
      ) : subTab === 'History' ? (
        <HistorySection monthKey={selectedMonth} userId={userId} isClosed={summary.isClosed} />
      ) : (
        <MonthOverviewSection monthKey={selectedMonth} summary={summary} />
      )}
      </>)}
    </Screen>
  );
}

// Bills

function BillsSection({ monthKey, userId, isClosed }: { monthKey: string; userId: string; isClosed: boolean }) {
  const { width } = useWindowDimensions();
  const compact = width < 420;
  const {
    data,
    today,
    addCycleBill,
    updateCycleBill,
    deleteCycleBill,
    setCycleBillOverride,
    deleteCycleBillOverride,
    addCyclePayment,
    addCycleGroup,
    updateCycleGroup,
    deleteCycleGroup,
    reorderCycleGroups,
  } = useApp();
  const { c } = useTheme();
  const cur = data.settings.currency;
  const displayMoney = (amount: number, currency: string | null) => currency ? formatMoney(amount, currency) : 'Mixed currencies';

  const [openNew, setOpenNew] = useState(false);
  const [editingBill, setEditingBill] = useState<CycleBill | null>(null);
  const [showManageGroups, setShowManageGroups] = useState(false);
  const [payModalBill, setPayModalBill] = useState<CycleBill | null>(null);
  const [debtDeleteBill, setDebtDeleteBill] = useState<CycleBill | null>(null);

  // Filter chips state
  const [filter, setFilter] = useState<BillFilterType>('All');
  // Collapsed state per group
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = (key: string) => setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));

  // Group creation & management states
  const [newGroupName, setNewGroupName] = useState('');
  const [groupError, setGroupError] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');

  // New bill form, including the external-payer fields
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState<string>(''); // Default empty = No Group
  const [amountStr, setAmountStr] = useState('');
  const [dueDayStr, setDueDayStr] = useState('1');
  const [payee, setPayee] = useState('');
  const [isVariable, setIsVariable] = useState(false);
  const [autopay, setAutopay] = useState(false);
  const [installmentStr, setInstallmentStr] = useState('');
  const [paidBy, setPaidBy] = useState<BillPaidBy>('self');
  const [payerName, setPayerName] = useState('');
  const [repayDueDate, setRepayDueDate] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingTemplate, setLoadingTemplate] = useState(false);
  const [overrideBill, setOverrideBill] = useState<CycleBill | null>(null);
  const [overrideAmount, setOverrideAmount] = useState('');
  const [overrideGroupId, setOverrideGroupId] = useState('unchanged');
  const [overrideError, setOverrideError] = useState<string | null>(null);

  // Pay modal states
  const [payAmountStr, setPayAmountStr] = useState('');
  const [payError, setPayError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  const prevMonthKey = getPreviousMonthKey(monthKey);
  const bills = useMemo(() => (data.cycleBills ?? []).filter((b) => b.userId === userId), [data.cycleBills, userId]);
  const customGroups = useMemo(
    () => (data.cycleGroups ?? []).filter((g) => g.userId === userId).slice().sort((a, b) => a.sortOrder - b.sortOrder),
    [data.cycleGroups, userId]
  );

  async function handleLoadStarterTemplate() {
    if (customGroups.length || bills.length || loadingTemplate) return;
    setLoadingTemplate(true);
    for (const name of DEFAULT_CYCLE_GROUP_NAMES) {
      await addCycleGroup(name, userId);
    }
    setLoadingTemplate(false);
  }

  // Grouped month sheet; the month total is derived from its group subtotals
  const groupedSheet = useMemo(() => {
    return computeGroupedMonthSheet(
      monthKey,
      userId,
      data.cycleBills ?? [],
      data.cycleGroups ?? [],
      data.cyclePayments ?? [],
      data.cycleMonths ?? [],
      today as any,
      data.cycleBillOverrides ?? []
    );
  }, [monthKey, userId, data.cycleBills, data.cycleGroups, data.cyclePayments, data.cycleMonths, data.cycleBillOverrides, today]);

  function openOverride(bill: CycleBill) {
    const existing = (data.cycleBillOverrides ?? []).find((item) => item.billId === bill.id && item.monthKey === monthKey);
    setOverrideBill(bill);
    setOverrideAmount(formatMoney(existing?.expectedAmountMinor ?? bill.expectedAmountMinor, bill.currency).replace(/[^0-9.]/g, ''));
    setOverrideGroupId(existing?.groupId === undefined ? 'unchanged' : (existing.groupId ?? 'none'));
    setOverrideError(null);
  }

  function openBillEditor(bill: CycleBill) {
    setEditingBill(bill);
    setOpenNew(true);
    setName(bill.name);
    setGroupId(bill.groupId ?? customGroups.find((group) => group.name.toLowerCase() === bill.group?.toLowerCase())?.id ?? '');
    setAmountStr(formatMoney(bill.expectedAmountMinor, bill.currency).replace(/[^0-9.]/g, ''));
    setDueDayStr(String(bill.dueDay));
    setPayee(bill.payee);
    setIsVariable(bill.isVariable);
    setAutopay(bill.autopay);
    setInstallmentStr(bill.installmentCount == null ? '' : String(bill.installmentCount));
    setPaidBy(bill.paidBy ?? 'self');
    setPayerName(bill.payerName ?? '');
    setRepayDueDate(bill.repayDueDate ?? '');
    setFormError(null);
  }

  function resetBillForm() {
    setOpenNew(false);
    setEditingBill(null);
    setName('');
    setGroupId('');
    setAmountStr('');
    setDueDayStr('1');
    setPayee('');
    setIsVariable(false);
    setAutopay(false);
    setInstallmentStr('');
    setPaidBy('self');
    setPayerName('');
    setRepayDueDate('');
    setFormError(null);
  }

  async function saveOverride() {
    if (!overrideBill) return;
    const amount = parseMoney(overrideAmount, overrideBill.currency);
    if (amount === null) {
      setOverrideError('Enter a valid amount for this month.');
      return;
    }
    const group = customGroups.find((item) => item.id === overrideGroupId);
    const err = await setCycleBillOverride(overrideBill.id, monthKey, {
      expectedAmountMinor: amount,
      ...(overrideGroupId === 'unchanged' ? {} : { groupId: overrideGroupId === 'none' ? null : overrideGroupId, group: group?.name ?? null }),
    });
    if (err) setOverrideError(err);
    else setOverrideBill(null);
  }

  async function handleCreateBill() {
    setFormError(null);
    const formCurrency = editingBill?.currency ?? cur;
    const parsedAmt = parseMoney(amountStr, formCurrency);
    if (parsedAmt === null) {
      setFormError('Please enter a valid amount');
      return;
    }
    const dueDay = parseInt(dueDayStr, 10);
    if (isNaN(dueDay) || dueDay < 1 || dueDay > 31) {
      setFormError('Due day must be between 1 and 31');
      return;
    }
    const instCount = installmentStr.trim() ? parseInt(installmentStr, 10) : null;
    if (instCount !== null && (isNaN(instCount) || instCount <= 0)) {
      setFormError('Installments must be a positive number');
      return;
    }

    const matchedGroup = customGroups.find((g) => g.id === groupId);
    setSaving(true);
    const err = editingBill
      ? await updateCycleBill(editingBill.id, {
        name: name.trim(),
        groupId: groupId || undefined,
        group: matchedGroup ? matchedGroup.name : undefined,
        expectedAmountMinor: parsedAmt,
        dueDay,
        payee: payee.trim(),
        isVariable,
        autopay,
        installmentCount: instCount,
        paidBy,
        payerName: paidBy !== 'self' && payerName.trim() ? payerName.trim() : null,
        repayDueDate: paidBy !== 'self' && repayDueDate.trim() ? (repayDueDate.trim() as any) : null,
      })
      : await addCycleBill({
        userId,
        name: name.trim(),
        groupId: groupId ? groupId : undefined,
        group: matchedGroup ? matchedGroup.name : undefined,
        expectedAmountMinor: parsedAmt,
        currency: cur,
        dueDay,
        payee: payee.trim(),
        isVariable,
        isPaused: false,
        autopay,
        installmentCount: instCount,
        paidBy,
        payerName: paidBy !== 'self' && payerName.trim() ? payerName.trim() : null,
        repayDueDate: paidBy !== 'self' && repayDueDate.trim() ? (repayDueDate.trim() as any) : null,
      });
    setSaving(false);

    if (err) {
      setFormError(err);
    } else {
      resetBillForm();
    }
  }

  async function handleRecordPayment(bill: CycleBill, remainingMinor: number) {
    setPayError(null);
    const parsed = payAmountStr.trim() ? parseMoney(payAmountStr, cur) : remainingMinor;
    if (parsed === null || parsed <= 0) {
      setPayError('Please enter a valid payment amount');
      return;
    }

    setPaying(true);
    const err = await addCyclePayment({
      userId,
      billId: bill.id,
      monthKey,
      amountMinor: parsed,
      currency: cur,
      paidAt: new Date().toISOString(),
    });
    setPaying(false);

    if (err) {
      setPayError(err);
    } else {
      setPayModalBill(null);
      setPayAmountStr('');
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <View
        style={{
          flexDirection: compact ? 'column' : 'row',
          alignItems: compact ? 'stretch' : 'center',
          columnGap: compact ? 10 : 14,
          rowGap: 10,
          flexWrap: 'wrap',
        }}>
        <SectionTitle>{`Bills for ${monthKey}`}</SectionTitle>
        {!isClosed ? (
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            {!customGroups.length && !bills.length ? (
              <Button
                kind="secondary"
                label={loadingTemplate ? 'Adding categories…' : 'Add starter categories'}
                onPress={handleLoadStarterTemplate}
                disabled={loadingTemplate}
                style={{ flexShrink: 1 }}
              />
            ) : null}
            <Button
              kind="secondary"
              label={showManageGroups ? 'Close groups' : `Groups - ${customGroups.length}`}
              onPress={() => setShowManageGroups(!showManageGroups)}
              style={{ flexShrink: 1 }}
            />
            <Button kind="primary" label="＋ New bill" onPress={() => { resetBillForm(); setOpenNew(true); }} style={{ flexShrink: 1 }} />
          </View>
        ) : null}
      </View>

      <View style={{ backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: 8, padding: compact ? 12 : 10 }}>
        <Text style={[typography.caption, { color: c.sub, lineHeight: 19, textAlign: 'left' }]}>
          <Text style={[typography.caption, { color: c.text, fontWeight: '700' }]}>Reminders:</Text> in-app only. <Text style={[typography.caption, { color: c.primary, fontWeight: '700' }]}>DUE</Text> badges appear 3 days before a bill, and <Text style={[typography.caption, { color: c.danger, fontWeight: '700' }]}>OVERDUE</Text> badges appear after the due date. Background notifications are not enabled.
        </Text>
      </View>

      {showManageGroups ? (
        <Card style={{ borderColor: c.primary, borderWidth: 1 }}>
          <Text style={[typography.cardTitle, { color: c.text, marginBottom: 4 }]}>Custom bill groups</Text>
          <Text style={[typography.caption, { color: c.sub, marginBottom: 10 }]}>
            Create and organize categories. Bills may also stay ungrouped.
          </Text>

          <View style={{ flexDirection: compact ? 'column' : 'row', gap: 8, alignItems: compact ? 'stretch' : 'center', marginBottom: 10 }}>
            <View style={{ flex: 1 }}>
              <Field
                label="New group name"
                value={newGroupName}
                onChangeText={setNewGroupName}
                placeholder="e.g. Utilities, Subscriptions, Office"
              />
            </View>
            <Button
              kind="primary"
              label="Add group"
              size="compact"
              onPress={async () => {
                if (!newGroupName.trim()) return;
                const err = await addCycleGroup(newGroupName.trim(), userId);
                if (err) setGroupError(err);
                else {
                  setNewGroupName('');
                  setGroupError(null);
                }
              }}
            />
          </View>
          {groupError ? <Text style={[typography.caption, { color: c.danger, marginBottom: 6 }]}>{groupError}</Text> : null}

          {customGroups.length === 0 ? (
            <Text style={[typography.caption, { color: c.sub, fontStyle: 'italic', marginVertical: 6 }]}>
              No groups yet.
            </Text>
          ) : (
            <View style={{ gap: 6, marginTop: 4 }}>
              {customGroups.map((g, idx) => (
                <View
                  key={g.id}
                  style={{
                    flexDirection: compact ? 'column' : 'row',
                    alignItems: compact ? 'stretch' : 'center',
                    justifyContent: 'space-between',
                    paddingVertical: 6,
                    borderBottomWidth: idx < customGroups.length - 1 ? 1 : 0,
                    borderColor: c.border,
                  }}>
                  {editingGroupId === g.id ? (
                    <View style={{ flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                      <Field label="" value={editingGroupName} onChangeText={setEditingGroupName} style={{ flex: 1 }} />
                      <Button
                        kind="primary"
                        label="Save"
                        onPress={async () => {
                          const err = await updateCycleGroup(g.id, { name: editingGroupName });
                          if (err) setGroupError(err);
                          else {
                            setEditingGroupId(null);
                            setGroupError(null);
                          }
                        }}
                      />
                      <Button kind="secondary" label="Cancel" onPress={() => setEditingGroupId(null)} />
                    </View>
                  ) : (
                    <>
                      <Text style={[typography.secondary, { color: c.text, fontWeight: '600', flex: 1, marginBottom: compact ? 6 : 0 }]} numberOfLines={2}>{g.name}</Text>
                      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: compact ? 'flex-start' : 'flex-end' }}>
                        {idx > 0 ? (
                          <Button
                            kind="secondary"
                            label="↑"
                            accessibilityLabel={`Move ${g.name} up`}
                            size="compact"
                            onPress={() => {
                              const ids = customGroups.map((x) => x.id);
                              const tmp = ids[idx];
                              ids[idx] = ids[idx - 1];
                              ids[idx - 1] = tmp;
                              void reorderCycleGroups(ids);
                            }}
                          />
                        ) : null}

                        {idx < customGroups.length - 1 ? (
                          <Button
                            kind="secondary"
                            label="↓"
                            accessibilityLabel={`Move ${g.name} down`}
                            size="compact"
                            onPress={() => {
                              const ids = customGroups.map((x) => x.id);
                              const tmp = ids[idx];
                              ids[idx] = ids[idx + 1];
                              ids[idx + 1] = tmp;
                              void reorderCycleGroups(ids);
                            }}
                          />
                        ) : null}
                        <Button
                          kind="secondary"
                          label="✎"
                          accessibilityLabel={`Rename ${g.name}`}
                          size="compact"
                          onPress={() => {
                            setEditingGroupId(g.id);
                            setEditingGroupName(g.name);
                          }}
                        />
                        <ConfirmButton
                          label="×"
                          size="compact"
                          confirmLabel={(() => {
                            const linkedCount = bills.filter((b) => b.groupId === g.id || b.group?.toLowerCase() === g.name.toLowerCase()).length;
                            return linkedCount > 0
                              ? `${linkedCount} bills will become ungrouped. Tap to delete`
                              : 'Tap to delete group';
                          })()}
                          onConfirm={() => deleteCycleGroup(g.id)}
                        />
                      </View>
                    </>
                  )}
                </View>
              ))}
            </View>
          )}
        </Card>
      ) : null}

      {overrideBill ? (
        <Card style={{ borderColor: c.primary, borderWidth: 1, marginTop: 12 }}>
          <Text style={[typography.cardTitle, { color: c.text, marginBottom: 4 }]}>
            Change this bill for {monthKey}
          </Text>
          <Text style={[typography.caption, { color: c.sub, marginBottom: 8 }]}>
            This changes only the selected month. Other months keep the recurring bill settings.
          </Text>
          <Field label={`Amount - ${overrideBill.currency}`} value={overrideAmount} onChangeText={setOverrideAmount} placeholder="0.00" />
          <Chips
            label="Category for this month"
            options={['unchanged', 'none', ...customGroups.map((group) => group.id)]}
            labels={{ unchanged: 'Keep category', none: 'No category', ...Object.fromEntries(customGroups.map((group) => [group.id, group.name])) }}
            value={overrideGroupId}
            onChange={setOverrideGroupId}
          />
          {overrideError ? <Text style={[typography.caption, { color: c.danger, marginTop: 6 }]}>{overrideError}</Text> : null}
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
            <Button kind="primary" label="Save this month" onPress={saveOverride} size="compact" />
            <Button kind="secondary" label="Cancel" onPress={() => setOverrideBill(null)} size="compact" />
            {(data.cycleBillOverrides ?? []).some((item) => item.billId === overrideBill.id && item.monthKey === monthKey) ? (
              <Button kind="secondary" label="Use recurring bill" onPress={async () => {
                const err = await deleteCycleBillOverride(overrideBill.id, monthKey);
                if (err) setOverrideError(err);
                else setOverrideBill(null);
              }} size="compact" />
            ) : null}
          </View>
        </Card>
      ) : null}

      {openNew ? (
        <Card>
          <Text style={[typography.cardTitle, { color: c.text, marginBottom: 8 }]}>{editingBill ? 'Edit Recurring Bill' : 'Add Recurring Bill'}</Text>
          {editingBill ? (
            <Text style={[typography.caption, { color: c.sub, marginBottom: 8 }]}>
              Changes update the recurring bill. Use &quot;Change this month&quot; when only one month should be different.
            </Text>
          ) : null}
          <Field label="Bill name" value={name} onChangeText={setName} placeholder="e.g. Electricity, Internet, Rent" />

          {customGroups.length > 0 ? (
            <Chips
              label="Group - user-defined or none"
              options={['no_group', ...customGroups.map((g) => g.id)]}
              labels={{ no_group: 'No Group', ...Object.fromEntries(customGroups.map((g) => [g.id, g.name])) }}
              value={groupId || 'no_group'}
              onChange={(v) => setGroupId(v === 'no_group' ? '' : v)}
            />
          ) : (
            <View style={{ marginBottom: 12 }}>
              <Text style={[typography.caption, { color: c.sub, marginBottom: 4 }]}>
                Group: <Text style={{ fontStyle: 'italic' }}>No custom groups created yet. Bill will have no group - create one in &apos;Groups&apos;.</Text>
              </Text>
            </View>
          )}

          <Field label={`Expected amount - ${editingBill?.currency ?? cur}`} value={amountStr} onChangeText={setAmountStr} keyboardType="numeric" placeholder="0.00" />
          <Chips
            label="Amount flexibility"
            options={['Fixed', 'Variable'] as const}
            value={isVariable ? 'Variable' : 'Fixed'}
            onChange={(v) => setIsVariable(v === 'Variable')}
          />
          <Chips
            label="Payment mode"
            options={['Manual', 'Autopay'] as const}
            value={autopay ? 'Autopay' : 'Manual'}
            onChange={(v) => setAutopay(v === 'Autopay')}
          />
          <Field label="Due day of month - 1 to 31" value={dueDayStr} onChangeText={setDueDayStr} keyboardType="numeric" placeholder="5" />
          <Field label="Payee / provider" value={payee} onChangeText={setPayee} placeholder="e.g. DESCO, Dot Internet" />
          <Field label="Installment count - optional, leave empty if it never ends" value={installmentStr} onChangeText={setInstallmentStr} keyboardType="numeric" placeholder="e.g. 12" />

          <Chips
            label="Paid by - self or external party"
            options={['self', 'person', 'lender', 'credit'] as const}
            labels={{
              self: 'Self - me',
              person: 'Person - debt linked',
              lender: 'Lender - loan linked',
              credit: 'Credit Card',
            }}
            value={paidBy}
            onChange={(v) => setPaidBy(v as BillPaidBy)}
          />

          {paidBy !== 'self' ? (
            <View style={{ gap: 8, marginTop: 4, padding: 8, backgroundColor: c.card, borderRadius: 6, borderWidth: 1, borderColor: c.border }}>
              <Text style={{ color: c.sub, fontSize: 12 }}>
                ℹ️ When paid by an external party, this bill is counted as paid in monthly cash-flow and a linked liability entry is recorded in Debts.
              </Text>
              <Field
                label="Payer / lender name"
                value={payerName}
                onChangeText={setPayerName}
                placeholder="e.g. Rahim, Standard Chartered, Amex"
              />
              <Field
                label="Repayment due date - optional, YYYY-MM-DD"
                value={repayDueDate}
                onChangeText={setRepayDueDate}
                placeholder="YYYY-MM-DD"
              />
            </View>
          ) : null}

          {formError ? <Text style={{ color: c.danger, fontSize: 13, marginVertical: 4 }}>{formError}</Text> : null}

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Button kind="primary" label={saving ? 'Saving...' : editingBill ? 'Save Changes' : 'Save Bill'} onPress={handleCreateBill} disabled={saving} />
            <Button kind="secondary" label="Cancel" onPress={resetBillForm} />
          </View>
        </Card>
      ) : null}

      {payModalBill ? (() => {
        const state = groupedSheet.groups.flatMap((g) => g.billStates).find((s) => s.bill.id === payModalBill.id);
        const rem = state?.remainingMinor ?? 0;
        return (
          <Card style={{ borderColor: c.primary, borderWidth: 1 }}>
            <Text style={[typography.cardTitle, { color: c.text, marginBottom: 4 }]}>Pay: {payModalBill.name}</Text>
            <Text style={[typography.secondary, { color: c.sub, marginBottom: 10 }]}>
              Total Remaining for {monthKey}: {displayMoney(rem, payModalBill.currency)}
            </Text>
            <Field
              label={`Payment amount - ${cur}, partial or full`}
              value={payAmountStr}
              onChangeText={setPayAmountStr}
              keyboardType="numeric"
              placeholder={displayMoney(rem, payModalBill.currency).replace(/[^0-9.]/g, '')}
            />
            {payError ? <Text style={{ color: c.danger, fontSize: 13, marginVertical: 4 }}>{payError}</Text> : null}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Button kind="primary" label={paying ? 'Recording...' : 'Confirm Payment'} onPress={() => handleRecordPayment(payModalBill, rem)} disabled={paying} />
              <Button kind="secondary" label="Cancel" onPress={() => setPayModalBill(null)} />
            </View>
          </Card>
        );
      })() : null}

      {debtDeleteBill ? (
        <Card style={{ borderColor: c.danger, borderWidth: 1 }}>
          <Text style={{ color: c.danger, fontWeight: '700', fontSize: 15, marginBottom: 4 }}>
            Delete Bill Linked to Debt
          </Text>
          <Text style={{ color: c.text, fontSize: 13, marginBottom: 8 }}>
            Bill &quot;{debtDeleteBill.name}&quot; was paid externally by &quot;{debtDeleteBill.payerName || debtDeleteBill.paidBy}&quot; and has a linked debt record of {formatMoney(debtDeleteBill.expectedAmountMinor, debtDeleteBill.currency)}.
          </Text>
          <Text style={{ color: c.sub, fontSize: 12, marginBottom: 12 }}>
            Would you like to keep the debt record or delete both the bill and the debt?
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Button
              kind="secondary"
              label="Keep debt - bill only"
              onPress={async () => {
                await deleteCycleBill(debtDeleteBill.id, false);
                setDebtDeleteBill(null);
              }}
            />
            <Button
              kind="danger"
              label="Delete both - bill and debt"
              onPress={async () => {
                await deleteCycleBill(debtDeleteBill.id, true);
                setDebtDeleteBill(null);
              }}
            />
            <Button kind="secondary" label="Cancel" onPress={() => setDebtDeleteBill(null)} />
          </View>
        </Card>
      ) : null}

      <View style={{ marginVertical: 2 }}>
        <Chips
          label="Filter status"
          options={['All', 'Unpaid', 'Paid', 'Overdue', 'Carried'] as const}
          value={filter}
          onChange={(v) => setFilter(v as BillFilterType)}
        />
      </View>

      {groupedSheet.groups.every((g) => g.billStates.length === 0) ? (
        <EmptyState title="No bills found" hint="Add recurring bills to track your monthly commitments and carry-ins." />
      ) : (
        <View style={{ gap: 12 }}>
          {groupedSheet.groups.map((group) => {
            const groupKey = group.groupId ?? 'no_group';
            const isCollapsed = Boolean(collapsedGroups[groupKey]);
            const visibleBills = filterBillStates(group.billStates, filter);
            const groupCurrency = getUniformCurrency(group.billStates.map((state) => state.bill.currency));

            if (group.billStates.length === 0 || (filter !== 'All' && visibleBills.length === 0)) {
              return null;
            }

            return (
              <Card key={groupKey} style={{ gap: 10 }}>
                <View style={{ flexDirection: compact ? 'column' : 'row', gap: compact ? 8 : 12, justifyContent: 'space-between', alignItems: compact ? 'stretch' : 'center' }}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <Text style={[typography.cardTitle, { color: c.text }]}>{group.groupName}</Text>
                      <Text style={[typography.caption, { color: c.sub, lineHeight: 19 }]}>
                        {group.billStates.length} bill{group.billStates.length === 1 ? '' : 's'}
                      </Text>
                    </View>
                    <View style={{ gap: 2, marginTop: 4 }}>
                      <Text style={[typography.caption, { color: c.sub }]}>
                        Due {displayMoney(group.totalDueMinor, groupCurrency)} · Paid {displayMoney(group.totalPaidMinor, groupCurrency)}
                      </Text>
                      <Text style={[typography.caption, { color: c.sub }]}>
                        You {displayMoney(group.totalPaidSelfMinor, groupCurrency)} · Others {displayMoney(group.totalPaidExternalMinor, groupCurrency)} · Remaining {displayMoney(group.totalRemainingMinor, groupCurrency)}
                      </Text>
                    </View>
                  </View>
                  <Button
                    kind="secondary"
                    label={isCollapsed ? '▼ Expand' : '▲ Collapse'}
                    size="compact"
                    onPress={() => toggleGroup(groupKey)}
                    style={compact ? { alignSelf: 'flex-start' } : undefined}
                  />
                </View>

                {!isCollapsed ? (
                  visibleBills.length === 0 ? (
                    <Text style={[typography.caption, { color: c.sub, fontStyle: 'italic', paddingVertical: 4 }]}>
                      No bills match filter &quot;{filter}&quot; in this group.
                    </Text>
                  ) : (
                    <View style={{ gap: 8, marginTop: 4 }}>
                      {visibleBills.map((st) => {
                        const { bill, status, totalDueMinor, totalPaidMinor, remainingMinor, carryInMinor, computedDueDate } = st;
                        const isOverdue = status === 'overdue';
                        const isPaid = status === 'paid';
                        const isPaused = status === 'paused';
                        const isExternal = Boolean(bill.paidBy && bill.paidBy !== 'self');

                        return (
                          <View
                            key={bill.id}
                            style={{
                              backgroundColor: c.card,
                              borderColor: c.border,
                              borderWidth: 1,
                              borderRadius: 8,
                              padding: 10,
                              gap: 6,
                            }}>
                            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                              <View style={{ flex: 1 }}>
                                <Text style={[typography.cardTitle, { color: c.text }]}>{bill.name}</Text>
                                <Text style={[typography.caption, { color: c.sub }]}>
                                  Due {computedDueDate} - day {bill.dueDay} · {bill.payee || 'No payee'}
                                </Text>
                              </View>
                              <View style={{ alignItems: 'flex-end' }}>
                                <Text style={[typography.secondary, { color: isPaid ? c.primary : isOverdue ? c.danger : c.text, fontWeight: '700' }]}>
                                  {formatMoney(totalDueMinor, bill.currency)}
                                </Text>
                                <Text style={{
                                  color: isPaid ? c.primary : isOverdue ? c.danger : isPaused ? c.sub : c.primary,
                                  fontSize: 12,
                                  fontWeight: '600',
                                }}>
                                  {status.toUpperCase()}
                                </Text>
                              </View>
                            </View>

                            <Text style={[typography.caption, { color: c.sub }]}>
                              Expected {formatMoney(st.expectedAmountMinor, bill.currency)} · Paid {formatMoney(totalPaidMinor, bill.currency)} · Remaining {formatMoney(remainingMinor, bill.currency)}
                            </Text>

                            {isExternal ? (
                              <View style={{ backgroundColor: c.border, padding: 8, borderRadius: 8, gap: 2 }}>
                                <Text style={[typography.caption, { color: c.primary, fontWeight: '700' }]}>
                                  External payment · paid by {bill.payerName || bill.paidBy} · repay: {bill.repayStatus ?? 'unpaid'}
                                </Text>
                                <Text style={[typography.caption, { color: c.sub }]}>
                                  Linked debt liability: {formatMoney(bill.expectedAmountMinor, bill.currency)} recorded in Debts list.
                                </Text>
                              </View>
                            ) : null}

                            {carryInMinor > 0 ? (
                              <View style={{ backgroundColor: c.border, padding: 8, borderRadius: 8 }}>
                                <Text style={[typography.caption, { color: c.sub }]}>
                                  Carry-in liability: {formatMoney(carryInMinor, bill.currency)} from {prevMonthKey}
                                </Text>
                              </View>
                            ) : null}

                            {!isClosed && status !== 'completed' ? (
                              <View style={{ flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                                {!isPaid ? (
                                  <Button
                                    kind="primary"
                                    label="Pay - full or partial"
                                    size="compact"
                                    onPress={() => {
                                      setPayAmountStr(formatMoney(remainingMinor, bill.currency).replace(/[^0-9.]/g, ''));
                                      setPayModalBill(bill);
                                    }}
                                  />
                                ) : null}

                                <Button
                                  kind="secondary"
                                  label="Edit bill"
                                  size="compact"
                                  onPress={() => openBillEditor(bill)}
                                />

                                <Button
                                  kind="secondary"
                                  label="Change this month"
                                  size="compact"
                                  onPress={() => openOverride(bill)}
                                />

                                <Button
                                  kind="secondary"
                                  label={isPaused ? 'Resume' : 'Skip / Pause'}
                                  size="compact"
                                  onPress={() => updateCycleBill(bill.id, { isPaused: !isPaused })}
                                />

                                {bill.linkedDebtId ? (
                                  <Button
                                    kind="secondary"
                                    label="Delete..."
                                    size="compact"
                                    onPress={() => setDebtDeleteBill(bill)}
                                  />
                                ) : (
                                  <ConfirmButton
                                    label="Delete"
                                    size="compact"
                                    confirmLabel="Tap again to delete"
                                    onConfirm={() => deleteCycleBill(bill.id)}
                                  />
                                )}
                              </View>
                            ) : null}
                            <ReceiptAttachments recordType="cycle_bill" recordId={bill.id} />
                          </View>
                        );
                      })}
                    </View>
                  )
                ) : null}
              </Card>
            );
          })}

          <Card style={{ borderColor: c.primary, borderWidth: 1, marginTop: 4 }}>
            {(() => {
              const monthCurrency = getUniformCurrency(groupedSheet.groups.flatMap((group) => group.billStates.map((state) => state.bill.currency)));
              return (
                <>
            <Text style={[typography.cardTitle, { color: c.text, marginBottom: 8 }]}>
              Month total · {monthKey}
            </Text>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text style={[typography.secondary, { color: c.sub }]}>Total due</Text>
              <Text style={[typography.secondary, { color: c.text, fontWeight: '700' }]}>
                {displayMoney(groupedSheet.monthTotal.totalDueMinor, monthCurrency)}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
              <Text style={[typography.secondary, { color: c.sub }]}>Total paid</Text>
              <Text style={[typography.secondary, { color: c.primary, fontWeight: '700' }]}>
                {displayMoney(groupedSheet.monthTotal.totalPaidMinor, monthCurrency)}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2, paddingLeft: 8 }}>
              <Text style={[typography.caption, { color: c.sub }]}>Paid by you</Text>
              <Text style={[typography.caption, { color: c.text, fontWeight: '600' }]}>
                {displayMoney(groupedSheet.monthTotal.totalPaidSelfMinor, monthCurrency)}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4, paddingLeft: 8 }}>
              <Text style={[typography.caption, { color: c.sub }]}>Paid by others or credit</Text>
              <Text style={[typography.caption, { color: c.text, fontWeight: '600' }]}>
                {displayMoney(groupedSheet.monthTotal.totalPaidExternalMinor, monthCurrency)}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text style={[typography.secondary, { color: c.sub }]}>Remaining due</Text>
              <Text style={[typography.secondary, { color: groupedSheet.monthTotal.totalRemainingMinor > 0 ? c.danger : c.sub, fontWeight: '700' }]}>
                {displayMoney(groupedSheet.monthTotal.totalRemainingMinor, monthCurrency)}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderColor: c.border, paddingTop: 6, marginTop: 4 }}>
              <Text style={[typography.secondary, { color: c.sub, fontWeight: '600' }]}>Carried to next month</Text>
              <Text style={[typography.secondary, { color: c.danger, fontWeight: '700' }]}>
                {displayMoney(groupedSheet.monthTotal.carryOutMinor, monthCurrency)}
              </Text>
            </View>
                </>
              );
            })()}
          </Card>
        </View>
      )}
    </View>
  );
}

// Income

function IncomeSection({ monthKey, userId, isClosed }: { monthKey: string; userId: string; isClosed: boolean }) {
  const { data, today, addCycleIncome, deleteCycleIncome } = useApp();
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const compact = width < 420;
  const cur = data.settings.currency;
  const displayMoney = (amount: number, currency: string | null) => currency ? formatMoney(amount, currency) : 'Mixed currencies';

  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('Salary');
  const [amountStr, setAmountStr] = useState('');
  const [date, setDate] = useState(today);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const incomes = (data.cycleIncomes ?? []).filter((i) => i.userId === userId && i.monthKey === monthKey);
  const totalIncome = incomes.reduce((acc, i) => acc + i.amountMinor, 0);
  const incomeCurrency = getUniformCurrency(incomes.map((income) => income.currency));

  async function handleAddIncome() {
    setErr(null);
    const parsed = parseMoney(amountStr, cur);
    if (parsed === null || parsed <= 0) {
      setErr('Please enter a valid positive income amount');
      return;
    }

    setSaving(true);
    const error = await addCycleIncome({
      userId,
      source: source.trim(),
      amountMinor: parsed,
      currency: cur,
      monthKey,
      receivedAt: date as any,
      isReceived: true,
    });
    setSaving(false);

    if (error) {
      setErr(error);
    } else {
      setOpen(false);
      setAmountStr('');
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <SectionTitle action={!isClosed ? <Button kind="secondary" label="＋ Add income" onPress={() => setOpen(true)} /> : undefined}>
        {`Income for ${monthKey}`}
      </SectionTitle>

      <Card>
        <Text style={[typography.caption, { color: c.sub }]}>Income recorded</Text>
        <Text style={[typography.pageTitle, { color: c.primary, marginTop: 4 }]}>
          {displayMoney(totalIncome, incomeCurrency)}
        </Text>
      </Card>

      {open ? (
        <Card>
          <Text style={[typography.cardTitle, { color: c.text, marginBottom: 8 }]}>Add income</Text>
          <Field label="Income source" value={source} onChangeText={setSource} placeholder="e.g. Salary, Client A, Freelance" />
          <Field label={`Amount - ${cur}`} value={amountStr} onChangeText={setAmountStr} keyboardType="numeric" placeholder="0.00" />
          <Field label="Received date - YYYY-MM-DD" value={date} onChangeText={setDate} placeholder="2026-11-01" />

          {err ? <Text style={{ color: c.danger, fontSize: 13, marginVertical: 4 }}>{err}</Text> : null}

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Button kind="primary" label={saving ? 'Saving...' : 'Save Income'} onPress={handleAddIncome} disabled={saving} />
            <Button kind="secondary" label="Cancel" onPress={() => setOpen(false)} />
          </View>
        </Card>
      ) : null}

      {incomes.length === 0 ? (
        <EmptyState title="No income recorded" hint="Add your salary or expected inflows for this month to compute Safe-To-Spend." />
      ) : (
        incomes.map((inc) => (
          <Card key={inc.id}>
            <View style={{ flexDirection: compact ? 'column' : 'row', justifyContent: 'space-between', alignItems: compact ? 'stretch' : 'center', gap: 8 }}>
              <View style={{ flex: compact ? undefined : 1 }}>
                <Text style={[typography.cardTitle, { color: c.text }]}>{inc.source}</Text>
                <Text style={[typography.caption, { color: c.sub }]}>Received on {inc.receivedAt}</Text>
              </View>
              <View style={{ alignItems: compact ? 'flex-start' : 'flex-end' }}>
                <Text style={[typography.cardTitle, { color: c.primary }]}>
                  {formatMoney(inc.amountMinor, inc.currency)}
                </Text>
                {!isClosed ? (
                  <ConfirmButton label="Delete" confirmLabel="Tap again to delete" onConfirm={() => deleteCycleIncome(inc.id)} />
                ) : null}
              </View>
            </View>
            <ReceiptAttachments recordType="cycle_income" recordId={inc.id} />
          </Card>
        ))
      )}
    </View>
  );
}

// Payment history

function HistorySection({ monthKey, userId, isClosed }: { monthKey: string; userId: string; isClosed: boolean }) {
  const { data, undoCyclePayment } = useApp();
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const compact = width < 420;

  const payments = (data.cyclePayments ?? []).filter((p) => p.userId === userId && p.monthKey === monthKey);
  const billMap = useMemo(() => new Map((data.cycleBills ?? []).map((b) => [b.id, b])), [data.cycleBills]);

  return (
    <View style={{ gap: 12 }}>
      <SectionTitle>{`Payment history · ${monthKey}`}</SectionTitle>

      {payments.length === 0 ? (
        <EmptyState title="No payments made yet" hint="When you mark bills as paid or partially paid, audit logs will appear here." />
      ) : (
        payments.map((p) => {
          const b = billMap.get(p.billId);
          return (
            <Card key={p.id}>
              <View style={{ flexDirection: compact ? 'column' : 'row', justifyContent: 'space-between', alignItems: compact ? 'stretch' : 'center', gap: 8 }}>
                <View style={{ flex: compact ? undefined : 1 }}>
                  <Text style={[typography.cardTitle, { color: c.text }]}>{b?.name ?? 'Unknown Bill'}</Text>
                  <Text style={[typography.caption, { color: c.sub }]}>Paid at {new Date(p.paidAt).toLocaleString()}</Text>
                </View>
                <View style={{ alignItems: compact ? 'flex-start' : 'flex-end', gap: 4 }}>
                  <Text style={[typography.cardTitle, { color: c.primary }]}>
                    {formatMoney(p.amountMinor, p.currency)}
                  </Text>
                  {!isClosed ? (
                    <ConfirmButton
                      label="Undo Paid"
                      confirmLabel="Tap again to undo"
                      onConfirm={() => undoCyclePayment(p.id)}
                    />
                  ) : null}
                </View>
              </View>
              <ReceiptAttachments recordType="cycle_payment" recordId={p.id} />
            </Card>
          );
        })
      )}
    </View>
  );
}

// Month overview

function MonthOverviewSection({ monthKey, summary }: { monthKey: string; summary: ReturnType<typeof computeMonthSummary> }) {
  const { width } = useWindowDimensions();
  const compact = width < 420;
  const { data, closeCycleMonth, reopenCycleMonth } = useApp();
  const { c } = useTheme();
  const [lockReason, setLockReason] = useState('');
  const cur = data.settings.currency;
  const monthCurrencies = [
    ...(data.cycleBills ?? []).filter((bill) => bill.userId === 'default_user').map((bill) => bill.currency),
    ...(data.cycleIncomes ?? []).filter((income) => income.userId === 'default_user' && income.monthKey === monthKey).map((income) => income.currency),
  ];
  const summaryCurrency = getUniformCurrency(monthCurrencies) ?? (monthCurrencies.length === 0 ? cur : null);
  const displayMoney = (amount: number) => summaryCurrency ? formatMoney(amount, summaryCurrency) : 'Mixed currencies';
  const rowStyle = {
    flexDirection: compact ? ('column' as const) : ('row' as const),
    justifyContent: 'space-between' as const,
    gap: compact ? 2 : 0,
  };

  return (
    <View style={{ gap: 12 }}>
      <SectionTitle>{`Month overview · ${monthKey}`}</SectionTitle>

      <Card style={{ backgroundColor: c.card, borderColor: summary.safeToSpendMinor >= 0 ? c.primary : c.danger, borderWidth: 2 }}>
        {summaryCurrency === null ? (
          <Text style={[typography.caption, { color: c.danger, marginBottom: 6 }]}>
            Mixed currencies cannot be added into one month total. Review bills and income separately.
          </Text>
        ) : null}
        <Text style={[typography.secondary, { color: c.sub, fontWeight: '600' }]}>
          {summary.safeToSpendMinor >= 0
            ? `Safe to spend${summaryCurrency ? ` · ${summaryCurrency}` : ''}`
            : `Shortfall after unpaid bills${summaryCurrency ? ` · ${summaryCurrency}` : ''}`}
        </Text>
        <Text style={[typography.pageTitle, {
          color: summary.safeToSpendMinor >= 0 ? c.primary : c.danger,
          fontSize: 34,
          lineHeight: 44,
          letterSpacing: -0.5,
          marginTop: 4,
        }]}>
          {summary.safeToSpendMinor < 0 && summaryCurrency
            ? formatMoney(Math.abs(summary.safeToSpendMinor), summaryCurrency)
            : displayMoney(summary.safeToSpendMinor)}
        </Text>
        <Text style={[typography.caption, { color: c.sub, marginTop: 4 }]}>
          {summary.safeToSpendMinor >= 0
            ? "After reserving this month's unpaid bills."
            : 'Recorded income is lower than the full monthly liability.'}
        </Text>
      </Card>

      <Card>
        <View style={{ gap: 8 }}>
          <View style={rowStyle}>
            <Text style={[typography.secondary, { color: c.text }]}>Income</Text>
            <Text style={[typography.secondary, { color: c.text, fontWeight: '700' }]}>{displayMoney(summary.totalIncomeMinor)}</Text>
          </View>
          <View style={rowStyle}>
            <Text style={[typography.secondary, { color: c.text }]}>New bills</Text>
            <Text style={[typography.secondary, { color: c.text, fontWeight: '700' }]}>{displayMoney(summary.totalExpectedBillsMinor)}</Text>
          </View>
          <View style={rowStyle}>
            <Text style={[typography.secondary, { color: c.text }]}>Carry-in</Text>
            <Text style={[typography.secondary, { color: summary.totalCarryInMinor > 0 ? c.danger : c.text, fontWeight: '700' }]}>
              {displayMoney(summary.totalCarryInMinor)}
            </Text>
          </View>
          <View style={{ height: 1, backgroundColor: c.border, marginVertical: 4 }} />
          <View style={rowStyle}>
            <Text style={[typography.secondary, { color: c.text, fontWeight: '700' }]}>Monthly liability</Text>
            <Text style={[typography.secondary, { color: c.text, fontWeight: '800' }]}>{displayMoney(summary.totalDueBillsMinor)}</Text>
          </View>
          <View style={rowStyle}>
            <Text style={[typography.secondary, { color: c.primary, fontWeight: '700' }]}>Paid this month</Text>
            <Text style={[typography.secondary, { color: c.primary, fontWeight: '700' }]}>{displayMoney(summary.totalPaidBillsMinor)}</Text>
          </View>
          <View style={{ ...rowStyle, paddingLeft: 12 }}>
            <Text style={[typography.caption, { color: c.sub }]}>Paid by you</Text>
            <Text style={[typography.caption, { color: c.text, fontWeight: '600' }]}>{displayMoney(summary.totalPaidSelfMinor)}</Text>
          </View>
          <View style={{ ...rowStyle, paddingLeft: 12 }}>
            <Text style={[typography.caption, { color: c.sub }]}>Paid by others / credit</Text>
            <Text style={[typography.caption, { color: c.text, fontWeight: '600' }]}>{displayMoney(summary.totalPaidExternalMinor)}</Text>
          </View>
          <View style={rowStyle}>
            <Text style={[typography.secondary, { color: c.text }]}>Cash after your payments</Text>
            <Text style={[typography.secondary, { color: c.text, fontWeight: '700' }]}>{displayMoney(summary.availableCashMinor)}</Text>
          </View>
          <View style={rowStyle}>
            <Text style={[typography.secondary, { color: summary.totalRemainingBillsMinor > 0 ? c.danger : c.primary, fontWeight: '700' }]}>
              Unpaid bills
            </Text>
            <Text style={[typography.secondary, { color: summary.totalRemainingBillsMinor > 0 ? c.danger : c.primary, fontWeight: '800' }]}>
              {displayMoney(summary.totalRemainingBillsMinor)}
            </Text>
          </View>
          <View style={{ height: 1, backgroundColor: c.border, marginVertical: 4 }} />
          <View style={rowStyle}>
            <Text style={[typography.secondary, { color: summary.safeToSpendMinor >= 0 ? c.primary : c.danger, fontWeight: '800' }]}>
              {summary.safeToSpendMinor >= 0 ? 'Safe to spend' : 'Shortfall'}
            </Text>
            <Text style={[typography.secondary, { color: summary.safeToSpendMinor >= 0 ? c.primary : c.danger, fontWeight: '800' }]}>
              {summary.safeToSpendMinor < 0 && summaryCurrency
                ? formatMoney(Math.abs(summary.safeToSpendMinor), summaryCurrency)
                : displayMoney(summary.safeToSpendMinor)}
            </Text>
          </View>
        </View>
      </Card>

      <Card>
        <Text style={[typography.cardTitle, { color: c.text, marginBottom: 4 }]}>Month status</Text>
        <Text style={[typography.secondary, { color: c.sub, marginBottom: 10 }]}>
          {summary.isClosed
            ? 'Locked. Bills, payments, income, and overrides are read-only.'
            : 'Lock a completed month to prevent accidental edits or double payments.'}
        </Text>
        <Text style={[typography.caption, { color: c.sub, marginBottom: 8 }]}>
          Only someone using this device can lock or reopen a month.
        </Text>
        <Field
          label={summary.isClosed ? 'Reason for reopening - optional' : 'Lock note - optional'}
          value={lockReason}
          onChangeText={setLockReason}
          placeholder={summary.isClosed ? 'Why does this month need editing?' : 'What was completed or reviewed?'}
          multiline
          maxLength={240}
        />
        {summary.isClosed ? (
          <ConfirmButton
            label="Reopen month"
            confirmLabel="Tap again to reopen"
            onConfirm={() => {
              void reopenCycleMonth(monthKey, lockReason);
              setLockReason('');
            }}
          />
        ) : (
          <ConfirmButton
            label="Close month - lock"
            confirmLabel="Tap again to lock"
            onConfirm={() => {
              void closeCycleMonth(monthKey, undefined, lockReason);
              setLockReason('');
            }}
          />
        )}
        {(() => {
          const events = (data.cycleMonthLockEvents ?? [])
            .filter((event) => event.userId === 'default_user' && event.monthKey === monthKey)
            .slice()
            .reverse();
          if (events.length === 0) return null;
          return (
            <View style={{ borderTopWidth: 1, borderTopColor: c.border, marginTop: 16, paddingTop: 12, gap: 8 }}>
              <Text style={[typography.cardTitle, { color: c.text }]}>Lock history</Text>
              {events.map((event) => (
                <View key={event.id} style={{ gap: 2 }}>
                  <Text style={{ color: c.text, fontWeight: '600' }}>
                    {event.action === 'closed' ? 'Locked' : 'Reopened'} on this device
                  </Text>
                  <Text style={[typography.caption, { color: c.sub }]}>
                    {event.createdAt.replace('T', ' ').slice(0, 16)}
                    {event.reason ? ` · ${event.reason}` : ''}
                  </Text>
                </View>
              ))}
            </View>
          );
        })()}
      </Card>
    </View>
  );
}
