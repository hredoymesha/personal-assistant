import { router } from 'expo-router';
import { useMemo } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { isOverdueTask, monthTotals, goalProgress, recentExpenses, tasksDueOn, upcomingTasks, netDebt } from '../domain/summaries';
import { formatMoney, sumMinor } from '../domain/money';
import { computeMonthSummary } from '../domain/cycle';
import { walletBalance } from '../domain/wallets';
import { useApp } from '../state/AppProvider';
import { Banner, Button, Card, EmptyState, Loading, ProgressBar, Screen, SectionTitle, StatTile } from '../ui/components';
import { CommandEntry } from '../ui/CommandEntry';
import { EmergencySOSButton, EmergencySOSPanel } from '../ui/EmergencySOS';
import { type as typography, useTheme } from '../ui/theme';

function MetricBar({ label, value, max, color, valueLabel }: {
  label: string;
  value: number;
  max: number;
  color: string;
  valueLabel: string;
}) {
  const width = `${Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0))}%` as `${number}%`;
  const { c } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Text style={[typography.secondary, { color: c.text }]}>{label}</Text>
        <Text style={[typography.secondary, { color: c.sub }]}>{valueLabel}</Text>
      </View>
      <View style={{ height: 10, borderRadius: 5, overflow: 'hidden', backgroundColor: c.border }}>
        <View style={{ width, height: '100%', backgroundColor: color }} />
      </View>
    </View>
  );
}

function FeatureLink({ title, detail, action, onPress }: { title: string; detail: string; action: string; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Card style={{ flex: 1, minWidth: 210, gap: 8 }}>
      <Text style={[typography.cardTitle, { color: c.text }]}>{title}</Text>
      <Text style={[typography.secondary, { color: c.sub }]}>{detail}</Text>
      <Button kind="secondary" label={action} onPress={onPress} />
    </Card>
  );
}

export default function Home() {
  const { status, data, today, loadSample } = useApp();
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const compact = width < 420;

  const due = useMemo(() => tasksDueOn(data.tasks, today), [data.tasks, today]);
  const upcoming = useMemo(() => upcomingTasks(data.tasks, today), [data.tasks, today]);
  const recent = useMemo(() => recentExpenses(data.expenses), [data.expenses]);
  const month = useMemo(() => Object.entries(monthTotals(data.expenses, today)), [data.expenses, today]);
  const isEmpty = useMemo(
    () => !data.tasks.length && !data.expenses.length && !data.goals.length && !data.debts.length,
    [data.tasks.length, data.expenses.length, data.goals.length, data.debts.length]
  );
  const hasSample = useMemo(
    () => [...data.tasks, ...data.expenses, ...data.goals, ...data.debts].some((x) => x.sample),
    [data.tasks, data.expenses, data.goals, data.debts]
  );
  const cycleSummaries = useMemo(() => {
    const bills = data.cycleBills ?? [];
    const payments = data.cyclePayments ?? [];
    const incomes = data.cycleIncomes ?? [];
    const currencies = [...new Set([...bills, ...payments, ...incomes].map((item) => item.currency))];
    return currencies.map((currency) => ({
      currency,
      summary: computeMonthSummary(
        today.slice(0, 7),
        'default_user',
        bills.filter((item) => item.currency === currency),
        payments.filter((item) => item.currency === currency),
        incomes.filter((item) => item.currency === currency),
        data.cycleMonths ?? [],
        null,
        today as any,
      ),
    }));
  }, [data.cycleBills, data.cyclePayments, data.cycleIncomes, data.cycleMonths, today]);
  const debtSummaries = useMemo(() => {
    const currencies = [...new Set(data.debts.map((debt) => debt.currency))];
    return currencies.map((currency) => ({ currency, ...netDebt(data, currency) }));
  }, [data]);
  const walletSummaries = useMemo(
    () => data.wallets.map((wallet) => ({ ...wallet, balanceMinor: walletBalance(data, wallet.id) })),
    [data],
  );
  const taskSummary = useMemo(() => ({
    open: data.tasks.filter((task) => !task.done && !task.deletedAt).length,
    done: data.tasks.filter((task) => task.done && !task.deletedAt).length,
    overdue: data.tasks.filter((task) => isOverdueTask(task, today)).length,
    dueToday: due.length,
  }), [data.tasks, due.length, today]);
  const incomeByCurrency = useMemo(() => {
    const totals = new Map<string, number[]>();
    for (const income of data.cycleIncomes ?? []) {
      if (income.monthKey !== today.slice(0, 7)) continue;
      totals.set(income.currency, [...(totals.get(income.currency) ?? []), income.amountMinor]);
    }
    return [...totals].map(([currency, amounts]) => ({ currency, totalMinor: sumMinor(amounts) }));
  }, [data.cycleIncomes, today]);
  const messThisMonth = useMemo(() => {
    const monthKey = today.slice(0, 7);
    const totals = new Map<string, number[]>();
    for (const expense of data.messExpenses ?? []) {
      if (!expense.date.startsWith(monthKey)) continue;
      const group = data.messGroups.find((item) => item.id === expense.groupId);
      if (!group) continue;
      totals.set(group.currency, [...(totals.get(group.currency) ?? []), expense.amountMinor]);
    }
    return [...totals].map(([currency, amounts]) => ({ currency, totalMinor: sumMinor(amounts) }));
  }, [data.messExpenses, data.messGroups, today]);

  if (status === 'loading') return <Screen title="Personal Assistant"><Loading /></Screen>;

  return (
    <Screen title="Personal Assistant" right={<EmergencySOSButton />}>
      <Banner text="Local-first: your data stays on this device by default. Personal Assistant has no accounts, servers or analytics. It uploads nothing to us unless you explicitly choose optional encrypted Google Drive backup, which goes only to your own Google Drive account." />
      {hasSample ? <Banner tone="info" text="You are viewing sample data. Remove it in Settings when you are finished." /> : null}

      <EmergencySOSPanel />

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label="＋ Task" onPress={() => router.push('/tasks')} style={{ flex: 1 }} />
        <Button label="＋ Expense" onPress={() => router.push('/money')} style={{ flex: 1 }} />
      </View>

      <CommandEntry />

      <SectionTitle>At a glance</SectionTitle>
      <Card style={{ gap: 14, padding: 16 }}>
        <Text style={[typography.cardTitle, { color: c.text }]}>Your month in one view</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <StatTile label="Open tasks" value={`${taskSummary.open}`} detail={`${taskSummary.done} completed`} tone="primary" />
          <StatTile label="Due today" value={`${taskSummary.dueToday}`} detail="Today" />
          <StatTile label="Overdue" value={`${taskSummary.overdue}`} detail="Needs attention" tone={taskSummary.overdue ? 'danger' : 'success'} />
          <StatTile label="Open debts" value={`${data.debts.filter((debt) => debt.paidMinor < debt.amountMinor).length}`} detail="Unsettled records" />
          <StatTile label="Savings goals" value={`${data.goals.length}`} detail="Active goals" tone="success" />
          <StatTile label="Wallets" value={`${data.wallets.length}`} detail="Tracked accounts" />
        </View>
        {incomeByCurrency.map(({ currency, totalMinor }) => (
          <Text key={currency} style={[typography.secondary, { color: c.text }]}>
            Income - {currency} - {formatMoney(totalMinor, currency)}
          </Text>
        ))}
        {messThisMonth.map(({ currency, totalMinor }) => (
          <Text key={`mess-${currency}`} style={[typography.secondary, { color: c.text }]}>
            Mess expenses - {currency} - {formatMoney(totalMinor, currency)}
          </Text>
        ))}
      </Card>

      <SectionTitle>Explore your data</SectionTitle>
      <View style={{ flexDirection: compact ? 'column' : 'row', flexWrap: 'wrap', gap: 12 }}>
        <FeatureLink
          title="Tasks"
          detail="Today, upcoming, recurring and completed work"
          action="Open Tasks"
          onPress={() => router.push('/tasks')}
        />
        <FeatureLink
          title="Money"
          detail="Expenses, savings, debts, wallets and mess"
          action="Open Money"
          onPress={() => router.push('/money')}
        />
        <FeatureLink
          title="Money Cycle"
          detail="Bills, income, history, month and Daily Sheet"
          action="Open Cycle"
          onPress={() => router.push('/cycle')}
        />
      </View>

      <SectionTitle>Task activity</SectionTitle>
      <Card>
        <Text style={[typography.secondary, { color: c.sub, marginBottom: 10 }]}>Saved tasks only. Deleted ones are not counted.</Text>
        <View style={{ gap: 10 }}>
          <MetricBar label="Open" value={taskSummary.open} max={Math.max(taskSummary.open, taskSummary.done, 1)} color={c.primary} valueLabel={`${taskSummary.open}`} />
          <MetricBar label="Completed" value={taskSummary.done} max={Math.max(taskSummary.open, taskSummary.done, 1)} color={c.success} valueLabel={`${taskSummary.done}`} />
          <MetricBar label="Overdue" value={taskSummary.overdue} max={Math.max(taskSummary.open, taskSummary.done, 1)} color={c.danger} valueLabel={`${taskSummary.overdue}`} />
        </View>
      </Card>

      {isEmpty ? (
        <EmptyState title="Nothing here yet" hint="Add your first task or expense, or load a small labelled sample to look around."
          action={<Button kind="secondary" label="Load sample data" onPress={loadSample} />} />
      ) : null}

      <SectionTitle>Today</SectionTitle>
      <Card>
        {due.length ? due.map((t) => (
          <Text key={t.id} style={[typography.body, { color: c.text, paddingVertical: 6 }]}>
            {isOverdueTask(t, today) ? '⚠ Overdue · ' : ''}{t.title}{t.dueTime ? ` · ${t.dueTime}` : ''}
          </Text>
        )) : <Text style={[typography.body, { color: c.sub }]}>No tasks due today.</Text>}
      </Card>

      <SectionTitle>Money Cycle overview</SectionTitle>
      {cycleSummaries.length ? cycleSummaries.map(({ currency, summary }) => (
        <Card key={currency} style={{ gap: 6 }}>
            <Text style={[typography.body, { color: c.text, fontWeight: '700' }]}>
              Due this month ({currency}): {formatMoney(summary.totalDueBillsMinor, currency)}
            </Text>
            <Text style={[typography.body, { color: c.text, marginTop: 6 }]}>
              Paid: {formatMoney(summary.totalPaidBillsMinor, currency)}
            </Text>
            <Text style={[typography.body, { color: c.text, marginTop: 6 }]}>
              Remaining: {formatMoney(summary.totalRemainingBillsMinor, currency)}
            </Text>
            <Text style={[typography.secondary, { color: c.sub, marginTop: 8 }]}>
              {summary.overdueBillsCount} overdue · {summary.activeBillsCount} active
            </Text>
        </Card>
      )) : <Card><Text style={[typography.body, { color: c.sub }]}>No Money Cycle items yet.</Text></Card>}

      <SectionTitle>Money flow</SectionTitle>
      <Card>
        <Text style={[typography.secondary, { color: c.sub, marginBottom: 10 }]}>Current month income and Cycle commitments</Text>
        {cycleSummaries.length ? cycleSummaries.map(({ currency, summary }) => {
          const income = incomeByCurrency.find((item) => item.currency === currency)?.totalMinor ?? 0;
          const max = Math.max(income, summary.totalDueBillsMinor, summary.totalPaidBillsMinor, summary.totalRemainingBillsMinor, 1);
          return (
            <View key={currency} style={{ gap: 10, marginBottom: 14 }}>
              <Text style={[typography.body, { color: c.text, fontWeight: '700' }]}>{currency}</Text>
              <MetricBar label="Income" value={income} max={max} color={c.primary} valueLabel={formatMoney(income, currency)} />
              <MetricBar label="Due" value={summary.totalDueBillsMinor} max={max} color={c.danger} valueLabel={formatMoney(summary.totalDueBillsMinor, currency)} />
              <MetricBar label="Paid" value={summary.totalPaidBillsMinor} max={max} color={c.success} valueLabel={formatMoney(summary.totalPaidBillsMinor, currency)} />
              <MetricBar label="Remaining" value={summary.totalRemainingBillsMinor} max={max} color={c.sub} valueLabel={formatMoney(summary.totalRemainingBillsMinor, currency)} />
            </View>
          );
        }) : <Text style={[typography.body, { color: c.sub }]}>Add income or Cycle bills to see money flow.</Text>}
      </Card>

      <SectionTitle>Open debts</SectionTitle>
      <Card>
        {debtSummaries.length ? debtSummaries.map(({ currency, owedToMe, iOwe }) => (
          <View key={currency} style={{ gap: 4, marginBottom: 8 }}>
            <Text style={[typography.body, { color: c.text, fontWeight: '700' }]}>{currency}</Text>
            <Text style={[typography.body, { color: c.text }]}>Owed to me - {formatMoney(owedToMe, currency)}</Text>
            <Text style={[typography.body, { color: c.text }]}>I owe - {formatMoney(iOwe, currency)}</Text>
          </View>
        )) : <Text style={[typography.body, { color: c.sub }]}>No open debts.</Text>}
      </Card>

      <SectionTitle>Wallet balances</SectionTitle>
      <Card>
        {walletSummaries.length ? walletSummaries.map((wallet) => (
          <Text key={wallet.id} style={[typography.body, { color: c.text, paddingVertical: 4 }]}>
            {wallet.name} - {formatMoney(wallet.balanceMinor, wallet.currency)}
          </Text>
        )) : <Text style={[typography.body, { color: c.sub }]}>No wallets yet.</Text>}
      </Card>

      <SectionTitle>Upcoming - 7 days</SectionTitle>
      <Card>
        {upcoming.length ? upcoming.map((t) => (
          <Text key={t.id} style={[typography.body, { color: c.text, paddingVertical: 6 }]}>{t.dueDate} - {t.title}</Text>
        )) : <Text style={[typography.body, { color: c.sub }]}>Nothing coming up.</Text>}
      </Card>

      <SectionTitle>Spending this month</SectionTitle>
      <Card>
        {month.length ? month.map(([cur, total]) => (
          <Text key={cur} style={[typography.body, { color: c.text, fontSize: 22, lineHeight: 30, fontWeight: '800' }]}>
            {cur}: {formatMoney(total, cur)}
          </Text>
        )) : <Text style={[typography.body, { color: c.sub }]}>No expenses this month.</Text>}
        {recent.map((e) => (
          <Text key={e.id} style={[typography.body, { color: c.sub, paddingTop: 6 }]}>{e.date} - {e.category} - {formatMoney(e.amountMinor, e.currency)}</Text>
        ))}
      </Card>

      <SectionTitle>Savings</SectionTitle>
      {data.goals.length ? data.goals.map((g) => (
        <Card key={g.id}>
          <Text style={[typography.cardTitle, { color: c.text, marginBottom: 6 }]}>{g.name}</Text>
          <ProgressBar pct={goalProgress(g)} label={`${g.name} ${goalProgress(g)} percent`} />
          <Text style={[typography.body, { color: c.sub, marginTop: 6 }]}>{formatMoney(g.savedMinor, g.currency)} of {formatMoney(g.targetMinor, g.currency)} · {goalProgress(g)}%</Text>
        </Card>
      )) : <Card><Text style={[typography.body, { color: c.sub }]}>No savings goals yet. Add one in Money.</Text></Card>}
    </Screen>
  );
}
