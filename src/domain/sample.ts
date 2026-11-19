import { addDays } from './dates';
import type { AppData, DailyExpenseEntry, DailyExpenseField, DailyExpenseSheet, MessExpense, MessGroup, MessMeal, MessMember, SyncedContact, Wallet, WalletEntry, WalletTransfer } from './types';
import { emptyData } from './types';

/** Clearly-labelled demo data (every record has sample: true). Not the user's real data. */
export function sampleData(today: string, currency = 'BDT'): AppData {
  const d = emptyData();
  d.settings.currency = currency;
  const currentMonthKey = today.slice(0, 7);
  const [year, month] = currentMonthKey.split('-').map(Number);
  const previousMonthKey = month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, '0')}`;
  const base = { notes: '', dueTime: null, recurrence: 'none' as const, deletedAt: null, originalText: null, sample: true, createdAt: today };
  d.tasks = [
    { ...base, id: 'sample_t1', title: 'Sample: Pay electricity bill', dueDate: today, priority: 'high', category: 'Home', done: false },
    { ...base, id: 'sample_t2', title: 'Sample: Call family', dueDate: addDays(today, 2), priority: 'medium', category: 'Personal', done: false },
    { ...base, id: 'sample_t3', title: 'Sample: Weekly review', dueDate: addDays(today, 5), priority: 'low', category: 'Personal', done: false, recurrence: 'weekly' },
    { ...base, id: 'sample_t4', title: 'Sample: Submit project update', dueDate: addDays(today, -1), priority: 'high', category: 'Work', done: false },
    { ...base, id: 'sample_t5', title: 'Sample: Buy medicine', dueDate: addDays(today, 1), priority: 'medium', category: 'Health', done: true },
    { ...base, id: 'sample_t6', title: 'Sample: Plan weekend meal', dueDate: addDays(today, 3), priority: 'low', category: 'Home', done: false },
  ];
  d.expenses = [
    { id: 'sample_e1', amountMinor: 25000, currency, category: 'Food', note: 'Sample: groceries', date: today, walletId: null, originalText: null, sample: true },
    { id: 'sample_e2', amountMinor: 8000, currency, category: 'Transport', note: 'Sample: rickshaw', date: addDays(today, -1), walletId: null, originalText: null, sample: true },
    { id: 'sample_e3', amountMinor: 12000, currency, category: 'Bills', note: 'Sample: mobile recharge', date: addDays(today, -2), walletId: null, originalText: null, sample: true },
    { id: 'sample_e4', amountMinor: 18000, currency, category: 'Food', note: 'Sample: lunch with team', date: addDays(today, -3), walletId: null, originalText: null, sample: true },
    { id: 'sample_e5', amountMinor: 45000, currency, category: 'Shopping', note: 'Sample: household items', date: addDays(today, -4), walletId: null, originalText: null, sample: true },
    { id: 'sample_e6', amountMinor: 6000, currency, category: 'Transport', note: 'Sample: bus fare', date: addDays(today, -5), walletId: null, originalText: null, sample: true },
  ];
  d.goals = [
    { id: 'sample_g1', name: 'Sample: Emergency fund', targetMinor: 10000000, savedMinor: 2500000, currency, sample: true },
    { id: 'sample_g2', name: 'Sample: New phone', targetMinor: 4500000, savedMinor: 2700000, currency, sample: true },
    { id: 'sample_g3', name: 'Sample: Course fee', targetMinor: 1800000, savedMinor: 600000, currency, sample: true },
  ];
  d.debts = [
    { id: 'sample_d1', person: 'Sample: Friend', direction: 'owed_to_me', amountMinor: 500000, paidMinor: 100000, currency, dueDate: null, createdAt: `${today}T00:00:00.000Z`, sample: true },
    { id: 'sample_d2', person: 'Sample: Karim', direction: 'i_owe', amountMinor: 82000, paidMinor: 0, currency, dueDate: null, createdAt: `${today}T00:00:00.000Z`, sample: true },
    { id: 'sample_d3', person: 'Sample: Nadia', direction: 'owed_to_me', amountMinor: 150000, paidMinor: 75000, currency, dueDate: addDays(today, 7), createdAt: `${today}T01:00:00.000Z`, sample: true },
    { id: 'sample_d4', person: 'Sample: Office advance', direction: 'i_owe', amountMinor: 120000, paidMinor: 30000, currency, dueDate: addDays(today, 10), createdAt: `${today}T02:00:00.000Z`, sample: true },
  ];
  d.cycleGroups = [
    { id: 'sample_cgrp1', userId: 'default_user', name: 'Sample: Utilities', sortOrder: 0, sample: true, createdAt: today },
    { id: 'sample_cgrp2', userId: 'default_user', name: 'Sample: Home', sortOrder: 1, sample: true, createdAt: today },
    { id: 'sample_cgrp3', userId: 'default_user', name: 'Sample: Services', sortOrder: 2, sample: true, createdAt: today },
  ];
  d.cycleBills = [
    {
      id: 'sample_cbill1',
      userId: 'default_user',
      name: 'Sample: Electricity Bill',
      groupId: 'sample_cgrp1',
      expectedAmountMinor: 150000, // ৳1,500
      currency,
      dueDay: 10,
      payee: 'Sample: Power Grid',
      isVariable: false,
      isPaused: false,
      autopay: false,
      completedInstallments: 0,
      paidBy: 'self',
      sample: true,
      createdAt: today,
    },
    {
      id: 'sample_cbill2',
      userId: 'default_user',
      name: 'Sample: Internet Fiber',
      groupId: 'sample_cgrp1',
      expectedAmountMinor: 82000, // ৳820
      currency,
      dueDay: 15,
      payee: 'Sample: Fiber ISP',
      isVariable: false,
      isPaused: false,
      autopay: false,
      completedInstallments: 0,
      paidBy: 'person',
      payerName: 'Sample: Karim',
      linkedDebtId: 'sample_d2',
      repayStatus: 'unpaid',
      sample: true,
      createdAt: today,
    },
    {
      id: 'sample_cbill3',
      userId: 'default_user',
      name: 'Sample: Apartment rent',
      groupId: 'sample_cgrp2',
      expectedAmountMinor: 1200000,
      currency,
      dueDay: 3,
      payee: 'Sample: Landlord',
      isVariable: false,
      isPaused: false,
      autopay: false,
      completedInstallments: 0,
      paidBy: 'self',
      sample: true,
      createdAt: today,
    },
    {
      id: 'sample_cbill4',
      userId: 'default_user',
      name: 'Sample: Streaming service',
      groupId: 'sample_cgrp3',
      expectedAmountMinor: 65000,
      currency,
      dueDay: 22,
      payee: 'Sample: Streaming',
      isVariable: false,
      isPaused: false,
      autopay: true,
      completedInstallments: 0,
      paidBy: 'self',
      sample: true,
      createdAt: today,
    },
  ];
  d.cyclePayments = [
    {
      id: 'sample_cpay1',
      userId: 'default_user',
      billId: 'sample_cbill1',
      monthKey: currentMonthKey,
      amountMinor: 50000, // ৳500 paid of ৳1,500 -> partial balance ৳1,000
      currency,
      paidAt: `${today}T10:00:00.000Z`,
      sample: true,
      createdAt: `${today}T10:00:00.000Z`,
    },
    {
      id: 'sample_cpay2',
      userId: 'default_user',
      billId: 'sample_cbill3',
      monthKey: currentMonthKey,
      amountMinor: 1200000,
      currency,
      paidAt: `${today}T11:00:00.000Z`,
      sample: true,
      createdAt: `${today}T11:00:00.000Z`,
    },
  ];
  d.cycleIncomes = [
    {
      id: 'sample_cinc1',
      userId: 'default_user',
      source: 'Sample: Monthly Salary',
      amountMinor: 500000, // ৳5,000
      currency,
      monthKey: currentMonthKey,
      receivedAt: today as any,
      isReceived: true,
      sample: true,
      createdAt: `${today}T08:00:00.000Z`,
    },
    {
      id: 'sample_cinc2',
      userId: 'default_user',
      source: 'Sample: Freelance work',
      amountMinor: 180000,
      currency,
      monthKey: currentMonthKey,
      receivedAt: addDays(today, -4) as any,
      isReceived: true,
      sample: true,
      createdAt: `${today}T09:00:00.000Z`,
    },
  ];
  d.cycleBillOverrides = [{
    id: 'sample_coverride1',
    billId: 'sample_cbill1',
    userId: 'default_user',
    monthKey: currentMonthKey,
    expectedAmountMinor: 160000,
    groupId: 'sample_cgrp1',
    group: 'Sample: Utilities',
    sample: true,
    createdAt: `${today}T07:00:00.000Z`,
  }];
  d.cycleMonths = [{
    id: 'sample_cmonth1',
    userId: 'default_user',
    monthKey: previousMonthKey,
    isClosed: true,
    closedAt: `${today}T06:00:00.000Z`,
    notes: 'Sample: Previous month is locked to demonstrate read-only history.',
    sample: true,
  }];
  d.cycleMonthLockEvents = [{
    id: 'sample_clock1',
    userId: 'default_user',
    monthKey: previousMonthKey,
    action: 'closed',
    actor: 'local_owner',
    reason: 'Sample: Month reviewed and locked',
    createdAt: `${today}T06:00:00.000Z`,
    sample: true,
  }];

  const cashWallet: Wallet = {
    id: 'sample_wallet_cash',
    name: 'Sample: Cash Wallet',
    currency,
    openingBalanceMinor: 100000,
    createdAt: `${today}T05:00:00.000Z`,
    sample: true,
  };
  const bankWallet: Wallet = {
    id: 'sample_wallet_bank',
    name: 'Sample: Bank Account',
    currency,
    openingBalanceMinor: 750000,
    createdAt: `${today}T05:00:00.000Z`,
    sample: true,
  };
  const cardWallet: Wallet = {
    id: 'sample_wallet_card',
    name: 'Sample: Card',
    currency,
    openingBalanceMinor: 300000,
    createdAt: `${today}T05:00:00.000Z`,
    sample: true,
  };
  const mobileWallet: Wallet = {
    id: 'sample_wallet_mobile',
    name: 'Sample: Mobile Wallet',
    currency,
    openingBalanceMinor: 180000,
    createdAt: `${today}T05:30:00.000Z`,
    sample: true,
  };
  d.wallets = [cashWallet, bankWallet, cardWallet, mobileWallet];
  const walletEntries: WalletEntry[] = [
    { id: 'sample_wentry1', walletId: cashWallet.id, direction: 'in', amountMinor: 50000, date: today, note: 'Sample: cash added', sample: true },
    { id: 'sample_wentry2', walletId: cashWallet.id, direction: 'out', amountMinor: 12000, date: addDays(today, -1), note: 'Sample: lunch expense', sample: true },
    { id: 'sample_wentry3', walletId: bankWallet.id, direction: 'in', amountMinor: 500000, date: today, note: 'Sample: salary received', sample: true },
    { id: 'sample_wentry4', walletId: cardWallet.id, direction: 'out', amountMinor: 25000, date: addDays(today, -2), note: 'Sample: online purchase', sample: true },
    { id: 'sample_wentry5', walletId: bankWallet.id, direction: 'out', amountMinor: 90000, date: addDays(today, -3), note: 'Sample: utility payment', sample: true },
    { id: 'sample_wentry6', walletId: mobileWallet.id, direction: 'in', amountMinor: 250000, date: addDays(today, -2), note: 'Sample: mobile wallet top up', sample: true },
    { id: 'sample_wentry7', walletId: mobileWallet.id, direction: 'out', amountMinor: 45000, date: addDays(today, -1), note: 'Sample: mobile wallet payment', sample: true },
  ];
  d.walletEntries = walletEntries;
  d.walletTransfers = [{
    id: 'sample_wtransfer1',
    fromWalletId: bankWallet.id,
    toWalletId: cashWallet.id,
    amountMinor: 30000,
    date: today,
    note: 'Sample: weekly cash withdrawal',
    sample: true,
  } satisfies WalletTransfer, {
    id: 'sample_wtransfer2',
    fromWalletId: bankWallet.id,
    toWalletId: cardWallet.id,
    amountMinor: 100000,
    date: addDays(today, -2),
    note: 'Sample: card top up',
    sample: true,
  } satisfies WalletTransfer, {
    id: 'sample_wtransfer3',
    fromWalletId: bankWallet.id,
    toWalletId: mobileWallet.id,
    amountMinor: 75000,
    date: addDays(today, -1),
    note: 'Sample: mobile wallet top up',
    sample: true,
  } satisfies WalletTransfer];

  const messGroup: MessGroup = {
    id: 'sample_mess_group',
    name: 'Sample: Shared Flat',
    currency,
    createdAt: `${today}T04:00:00.000Z`,
    sample: true,
  };
  const messMembers: MessMember[] = [
    { id: 'sample_member_self', groupId: messGroup.id, name: 'Sample: You', contactId: 'sample_contact1', isSelf: true, sample: true },
    { id: 'sample_member_rahim', groupId: messGroup.id, name: 'Sample: Rahim', contactId: 'sample_contact2', isSelf: false, sample: true },
    { id: 'sample_member_nadia', groupId: messGroup.id, name: 'Sample: Nadia', contactId: null, isSelf: false, sample: true },
  ];
  d.messGroups = [messGroup];
  d.messMembers = messMembers;
  const messMeals: MessMeal[] = [
    { id: 'sample_meal1', groupId: messGroup.id, memberId: messMembers[0].id, date: today, halfMealUnits: 2, sample: true },
    { id: 'sample_meal2', groupId: messGroup.id, memberId: messMembers[1].id, date: today, halfMealUnits: 1, sample: true },
    { id: 'sample_meal3', groupId: messGroup.id, memberId: messMembers[2].id, date: today, halfMealUnits: 2, sample: true },
    { id: 'sample_meal4', groupId: messGroup.id, memberId: messMembers[0].id, date: addDays(today, -1), halfMealUnits: 1, sample: true },
    { id: 'sample_meal5', groupId: messGroup.id, memberId: messMembers[1].id, date: addDays(today, -1), halfMealUnits: 2, sample: true },
    { id: 'sample_meal6', groupId: messGroup.id, memberId: messMembers[2].id, date: addDays(today, -1), halfMealUnits: 2, sample: true },
  ];
  d.messMeals = messMeals;
  const messExpense: MessExpense = {
    id: 'sample_mess_expense1',
    groupId: messGroup.id,
    amountMinor: 12000,
    date: today,
    category: 'Food',
    note: 'Sample: weekly groceries',
    payerMemberId: messMembers[0].id,
    walletId: cashWallet.id,
    allocationMode: 'custom',
    mealRangeStart: null,
    mealRangeEnd: null,
    allocations: [
      { memberId: messMembers[0].id, amountMinor: 5000 },
      { memberId: messMembers[1].id, amountMinor: 3500 },
      { memberId: messMembers[2].id, amountMinor: 3500 },
    ],
    sample: true,
  };
  d.messExpenses = [messExpense];
  d.messExpenses.push({
    id: 'sample_mess_expense2',
    groupId: messGroup.id,
    amountMinor: 8500,
    date: addDays(today, -2),
    category: 'Utilities',
    note: 'Sample: shared cleaning supplies',
    payerMemberId: messMembers[1].id,
    walletId: null,
    allocationMode: 'equal',
    mealRangeStart: null,
    mealRangeEnd: null,
    allocations: [
      { memberId: messMembers[0].id, amountMinor: 2833 },
      { memberId: messMembers[1].id, amountMinor: 2834 },
      { memberId: messMembers[2].id, amountMinor: 2833 },
    ],
    sample: true,
  });
  const dailyFields: DailyExpenseField[] = [
    { id: 'sample_daily_field_transport', name: 'Transport type', type: 'text', options: [], required: false, sample: true },
    { id: 'sample_daily_field_paid_by', name: 'Paid by', type: 'choice', options: ['Cash', 'Bank', 'Card'], required: false, sample: true },
  ];
  const dailySheet: DailyExpenseSheet = {
    id: 'sample_daily_sheet',
    name: 'Sample: Daily Travel & Meals',
    currency,
    fieldIds: dailyFields.map((field) => field.id),
    createdAt: `${today}T02:00:00.000Z`,
    sample: true,
  };
  const dailyEntries: DailyExpenseEntry[] = [
    {
      id: 'sample_daily_entry1',
      sheetId: dailySheet.id,
      date: today,
      amountMinor: 20000,
      currency,
      category: 'Home to Sankar',
      note: 'Sample: morning trip',
      customValues: { [dailyFields[0].id]: 'Rickshaw', [dailyFields[1].id]: 'Cash' },
      sample: true,
    },
    {
      id: 'sample_daily_entry2',
      sheetId: dailySheet.id,
      date: today,
      amountMinor: 25000,
      currency,
      category: 'Lunch',
      note: 'Sample: lunch',
      customValues: { [dailyFields[0].id]: 'Walk', [dailyFields[1].id]: 'Card' },
      sample: true,
    },
    {
      id: 'sample_daily_entry3',
      sheetId: dailySheet.id,
      date: addDays(today, -1),
      amountMinor: 8000,
      currency,
      category: 'Internal rickshaw',
      note: 'Sample: previous day trip',
      customValues: { [dailyFields[0].id]: 'Rickshaw', [dailyFields[1].id]: 'Cash' },
      sample: true,
    },
    {
      id: 'sample_daily_entry4',
      sheetId: dailySheet.id,
      date: addDays(today, -2),
      amountMinor: 32000,
      currency,
      category: 'Groceries',
      note: 'Sample: fruit and snacks',
      customValues: { [dailyFields[0].id]: 'Walk', [dailyFields[1].id]: 'Cash' },
      sample: true,
    },
    {
      id: 'sample_daily_entry5',
      sheetId: dailySheet.id,
      date: addDays(today, -3),
      amountMinor: 15000,
      currency,
      category: 'Medicine',
      note: 'Sample: pharmacy',
      customValues: { [dailyFields[0].id]: 'CNG', [dailyFields[1].id]: 'Bank' },
      sample: true,
    },
    {
      id: 'sample_daily_entry6',
      sheetId: dailySheet.id,
      date: addDays(today, -4),
      amountMinor: 18000,
      currency,
      category: 'Coffee',
      note: 'Sample: afternoon coffee',
      customValues: { [dailyFields[0].id]: 'Walk', [dailyFields[1].id]: 'Cash' },
      sample: true,
    },
    {
      id: 'sample_daily_entry7',
      sheetId: dailySheet.id,
      date: addDays(today, -5),
      amountMinor: 42000,
      currency,
      category: 'Household',
      note: 'Sample: cleaning supplies',
      customValues: { [dailyFields[0].id]: 'CNG', [dailyFields[1].id]: 'Bank' },
      sample: true,
    },
    {
      id: 'sample_daily_entry8',
      sheetId: dailySheet.id,
      date: addDays(today, -6),
      amountMinor: 22000,
      currency,
      category: 'Breakfast',
      note: 'Sample: breakfast on the way to work',
      customValues: { [dailyFields[0].id]: 'Rickshaw', [dailyFields[1].id]: 'Cash' },
      sample: true,
    },
  ];
  d.dailyExpenseFields = dailyFields;
  d.dailyExpenseSheets = [dailySheet];
  d.dailyExpenseEntries = dailyEntries;
  const contacts: SyncedContact[] = [
    { id: 'sample_contact1', fullName: 'Sample: You', phones: ['+8801700000001'], emails: ['you@example.test'], photoUri: null, syncedAt: `${today}T03:00:00.000Z`, sample: true },
    { id: 'sample_contact2', fullName: 'Sample: Rahim', phones: ['+8801700000002'], emails: ['rahim@example.test'], photoUri: null, syncedAt: `${today}T03:00:00.000Z`, sample: true },
    { id: 'sample_contact3', fullName: 'Sample: Nadia', phones: ['+8801700000003'], emails: ['nadia@example.test'], photoUri: null, syncedAt: `${today}T03:00:00.000Z`, sample: true },
    { id: 'sample_contact4', fullName: 'Sample: Karim', phones: ['+8801700000004'], emails: ['karim@example.test'], photoUri: null, syncedAt: `${today}T03:00:00.000Z`, sample: true },
  ];
  d.syncedContacts = contacts;
  return d;
}
