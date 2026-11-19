import { useState } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { isValidDateStr } from '../domain/dates';
import { USER_CURRENCIES, formatMoney, parseMoney } from '../domain/money';
import type { WalletEntryDirection } from '../domain/types';
import { walletBalance, walletIsReferenced, walletsInCurrency } from '../domain/wallets';
import { useApp } from '../state/AppProvider';
import { Button, Card, Chips, ConfirmButton, EmptyState, Field, SectionTitle, StatTile } from './components';
import { ReceiptAttachments } from './ReceiptAttachments';
import { space, type as typography, useTheme } from './theme';

export default function Wallets() {
  const app = useApp();
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const compact = width < 420;
  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(app.data.settings.currency);
  const [opening, setOpening] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [entryOpen, setEntryOpen] = useState(false);
  const [entryWalletId, setEntryWalletId] = useState('');
  const [entryDirection, setEntryDirection] = useState<WalletEntryDirection>('in');
  const [entryAmount, setEntryAmount] = useState('');
  const [entryDate, setEntryDate] = useState(app.today);
  const [entryNote, setEntryNote] = useState('');
  const [entryError, setEntryError] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [fromWalletId, setFromWalletId] = useState('');
  const [toWalletId, setToWalletId] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferDate, setTransferDate] = useState(app.today);
  const [transferNote, setTransferNote] = useState('');
  const [transferError, setTransferError] = useState<string | null>(null);
  const [rename, setRename] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  async function createWallet() {
    const openingBalanceMinor = parseMoney(opening || '0', currency);
    if (!name.trim()) return setCreateError('Enter a wallet name.');
    if (openingBalanceMinor === null) return setCreateError(`Enter a valid opening balance in ${currency}.`);
    const error = await app.addWallet({ name: name.trim(), currency, openingBalanceMinor });
    if (error) return setCreateError(error);
    setName(''); setOpening(''); setCreateError(null); setNewOpen(false);
  }

  async function saveEntry() {
    const wallet = app.data.wallets.find((item) => item.id === entryWalletId);
    if (!wallet) return setEntryError('Choose a wallet.');
    const amountMinor = parseMoney(entryAmount, wallet.currency);
    if (amountMinor === null || amountMinor === 0) return setEntryError(`Enter an amount greater than zero in ${wallet.currency}.`);
    if (!isValidDateStr(entryDate)) return setEntryError('Enter a real date in YYYY-MM-DD format.');
    const error = await app.addWalletEntry({ walletId: wallet.id, direction: entryDirection, amountMinor, date: entryDate, note: entryNote.trim() });
    if (error) return setEntryError(error);
    setEntryAmount(''); setEntryNote(''); setEntryError(null); setEntryOpen(false);
  }

  async function saveTransfer() {
    const from = app.data.wallets.find((item) => item.id === fromWalletId);
    const to = transferTargets.find((item) => item.id === toWalletId) ?? transferTargets[0];
    if (!from || !to) return setTransferError('Choose both wallets.');
    if (from.id === to.id || from.currency !== to.currency) return setTransferError('Choose two different wallets with the same currency.');
    const amountMinor = parseMoney(transferAmount, from.currency);
    if (amountMinor === null || amountMinor === 0) return setTransferError(`Enter an amount greater than zero in ${from.currency}.`);
    if (!isValidDateStr(transferDate)) return setTransferError('Enter a real date in YYYY-MM-DD format.');
    const error = await app.addWalletTransfer({ fromWalletId: from.id, toWalletId: to.id, amountMinor, date: transferDate, note: transferNote.trim() });
    if (error) return setTransferError(error);
    setTransferAmount(''); setTransferNote(''); setTransferError(null); setTransferOpen(false);
  }

  const selectedEntryWallet = app.data.wallets.find((wallet) => wallet.id === entryWalletId) ?? app.data.wallets[0];
  const transferFrom = app.data.wallets.find((wallet) => wallet.id === fromWalletId) ?? app.data.wallets[0];
  const transferTargets = transferFrom ? walletsInCurrency(app.data.wallets, transferFrom.currency).filter((wallet) => wallet.id !== transferFrom.id) : [];
  type WalletMovement = { id: string; walletId: string; date: string; text: string; amount: number; deleteKind?: 'entry' | 'transfer'; deleteId?: string };
  const movements: WalletMovement[] = [
    ...app.data.walletEntries.map((entry) => ({
      id: entry.id, walletId: entry.walletId, date: entry.date,
      text: `${entry.direction === 'in' ? 'Added' : 'Manual withdrawal'}${entry.note ? ` · ${entry.note}` : ''}`,
      amount: entry.direction === 'in' ? entry.amountMinor : -entry.amountMinor,
      deleteKind: 'entry' as const, deleteId: entry.id,
    })),
    ...app.data.walletTransfers.flatMap((transfer) => [
      { id: `${transfer.id}-out`, walletId: transfer.fromWalletId, date: transfer.date, text: `Transfer to ${app.data.wallets.find((w) => w.id === transfer.toWalletId)?.name ?? 'wallet'}${transfer.note ? ` · ${transfer.note}` : ''}`, amount: -transfer.amountMinor, deleteKind: 'transfer' as const, deleteId: transfer.id },
      { id: `${transfer.id}-in`, walletId: transfer.toWalletId, date: transfer.date, text: `Transfer from ${app.data.wallets.find((w) => w.id === transfer.fromWalletId)?.name ?? 'wallet'}${transfer.note ? ` · ${transfer.note}` : ''}`, amount: transfer.amountMinor },
    ]),
    ...app.data.expenses.filter((expense) => expense.walletId).map((expense) => ({
      id: expense.id, walletId: expense.walletId!, date: expense.date, text: `Expense · ${expense.category}${expense.note ? ` · ${expense.note}` : ''}`, amount: -expense.amountMinor,
    })),
    ...app.data.messExpenses.filter((expense) => expense.walletId).map((expense) => ({
      id: expense.id, walletId: expense.walletId!, date: expense.date, text: `Mess · ${expense.category}${expense.note ? ` · ${expense.note}` : ''}`, amount: -expense.amountMinor,
    })),
  ];
  const totalsByCurrency = [...new Set(app.data.wallets.map((wallet) => wallet.currency))].map((walletCurrency) => ({
    currency: walletCurrency,
    total: app.data.wallets
      .filter((wallet) => wallet.currency === walletCurrency)
      .reduce((sum, wallet) => sum + walletBalance(app.data, wallet.id), 0),
  }));

  return (
    <>
      <SectionTitle>Wallets</SectionTitle>
      <Text style={[typography.secondary, { color: c.sub, marginBottom: space.md }]}>Track cash, bank, card and mobile wallets separately. Transfers stay within one currency and balances can go below zero.</Text>
      <Card style={{ gap: 12, padding: compact ? 16 : 20 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={[typography.cardTitle, { color: c.text }]}>Your wallet overview</Text>
            <Text style={[typography.caption, { color: c.sub, marginTop: 3 }]}>Balances are calculated from opening amounts and saved movements.</Text>
          </View>
          <Text style={[typography.caption, { color: c.primary, fontWeight: '700' }]}>{movements.length} movements</Text>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <StatTile label="Wallets" value={`${app.data.wallets.length}`} detail="Tracked accounts" tone="primary" />
          {totalsByCurrency.map((item) => (
            <StatTile key={item.currency} label={`${item.currency} total`} value={formatMoney(item.total, item.currency)} detail="Across wallets" />
          ))}
        </View>
      </Card>
      {app.data.wallets.length === 0 ? <EmptyState title="No wallets yet" hint="Create wallets for cash, a bank account, or a mobile wallet." /> : app.data.wallets.map((wallet) => {
        const linked = movements.filter((movement) => movement.walletId === wallet.id).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
        const isReferenced = walletIsReferenced(app.data, wallet.id);
        return (
          <Card key={wallet.id} style={{ gap: 10 }}>
            <View style={{ flexDirection: compact ? 'column' : 'row', justifyContent: 'space-between', alignItems: compact ? 'flex-start' : 'center', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={[typography.cardTitle, { color: c.text }]}>{wallet.name}</Text>
                <Text style={[typography.caption, { color: c.sub, marginTop: 3 }]}>{wallet.currency} - opening {formatMoney(wallet.openingBalanceMinor, wallet.currency)}</Text>
              </View>
              <View style={{ alignItems: compact ? 'flex-start' : 'flex-end' }}>
                <Text style={[typography.caption, { color: c.sub }]}>Current balance</Text>
                <Text style={[typography.pageTitle, { color: c.primary, fontSize: 22, lineHeight: 28 }]}>{formatMoney(walletBalance(app.data, wallet.id), wallet.currency)}</Text>
              </View>
            </View>
            <Field label="Rename wallet" value={rename[wallet.id] ?? wallet.name} onChangeText={(value) => setRename({ ...rename, [wallet.id]: value })} maxLength={80} />
            <View style={{ flexDirection: compact ? 'column' : 'row', gap: 8 }}>
              <Button label="Save name" style={{ flex: 1 }} onPress={async () => {
                const error = await app.renameWallet(wallet.id, (rename[wallet.id] ?? wallet.name).trim());
                setActionError(error);
              }} />
              {!isReferenced ? <ConfirmButton label="Delete wallet" onConfirm={async () => setActionError(await app.deleteWallet(wallet.id))} /> : null}
            </View>
            <ReceiptAttachments recordType="wallet" recordId={wallet.id} />
            {linked.length ? (
              <View style={{ marginTop: 4 }}>
                <Text style={[typography.secondary, { color: c.sub, fontWeight: '600', marginBottom: 6 }]}>Recent wallet activity</Text>
                {linked.map((movement) => (
                  <View key={movement.id} style={{ paddingVertical: 5 }}>
                    <View style={{ flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', gap: 8 }}>
                      <View style={{ flex: compact ? undefined : 1, minWidth: 0 }}>
                        <Text style={[typography.secondary, { color: c.text }]}>{movement.text}</Text>
                        <Text style={[typography.caption, { color: c.sub }]}>{movement.date}</Text>
                      </View>
                      <Text style={[typography.secondary, { color: movement.amount < 0 ? c.danger : c.success, fontWeight: '700' }]}>{formatMoney(movement.amount, wallet.currency)}</Text>
                      {movement.deleteKind === 'entry' && movement.deleteId ? <ConfirmButton label="Delete" onConfirm={() => app.deleteWalletEntry(movement.deleteId!)} /> : null}
                      {movement.deleteKind === 'transfer' && movement.deleteId ? <ConfirmButton label="Delete transfer" onConfirm={() => app.deleteWalletTransfer(movement.deleteId!)} /> : null}
                    </View>
                    {movement.deleteKind === 'entry' && movement.deleteId ? <ReceiptAttachments recordType="wallet_entry" recordId={movement.deleteId} /> : null}
                    {movement.deleteKind === 'transfer' && movement.deleteId ? <ReceiptAttachments recordType="wallet_transfer" recordId={movement.deleteId} /> : null}
                  </View>
                ))}
              </View>
            ) : null}
          </Card>
        );
      })}
      {actionError ? <Text accessibilityRole="alert" style={{ color: c.danger, marginBottom: 8 }}>{actionError}</Text> : null}
      {!newOpen ? <Button label="＋ Add wallet" onPress={() => { setCurrency(app.data.settings.currency); setNewOpen(true); }} /> : (
        <Card>
          <SectionTitle>New wallet</SectionTitle>
          <Field label="Wallet name" value={name} onChangeText={setName} maxLength={80} />
          <Chips label="Currency - fixed" options={USER_CURRENCIES} value={currency} onChange={setCurrency} />
          <Field label={`Opening balance - ${currency}`} value={opening} onChangeText={setOpening} keyboardType="decimal-pad" />
          {createError ? <Text accessibilityRole="alert" style={{ color: c.danger, marginBottom: 8 }}>{createError}</Text> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label="Create wallet" style={{ flex: 1 }} onPress={() => { void createWallet(); }} />
            <Button kind="secondary" label="Cancel" onPress={() => setNewOpen(false)} />
          </View>
        </Card>
      )}
      {app.data.wallets.length ? (
        <>
          <SectionTitle>Manual wallet entry</SectionTitle>
          {!entryOpen ? <Button label="＋ Add funds or withdrawal" onPress={() => { setEntryWalletId(app.data.wallets[0].id); setEntryDate(app.today); setEntryOpen(true); }} /> : (
            <Card>
              <Chips label="Wallet" options={app.data.wallets.map((wallet) => wallet.id)} labels={Object.fromEntries(app.data.wallets.map((wallet) => [wallet.id, `${wallet.name} - ${wallet.currency}`]))} value={selectedEntryWallet.id} onChange={setEntryWalletId} />
              <Chips label="Direction" options={['in', 'out'] as const} labels={{ in: 'Add funds', out: 'Withdrawal' }} value={entryDirection} onChange={setEntryDirection} />
              <Field label={`Amount - ${selectedEntryWallet.currency}`} value={entryAmount} onChangeText={setEntryAmount} keyboardType="decimal-pad" />
              <Field label="Date - YYYY-MM-DD" value={entryDate} onChangeText={setEntryDate} maxLength={10} />
              <Field label="Note - optional" value={entryNote} onChangeText={setEntryNote} maxLength={500} />
              {entryError ? <Text accessibilityRole="alert" style={{ color: c.danger, marginBottom: 8 }}>{entryError}</Text> : null}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button label="Save entry" style={{ flex: 1 }} onPress={() => { void saveEntry(); }} />
                <Button kind="secondary" label="Cancel" onPress={() => setEntryOpen(false)} />
              </View>
            </Card>
          )}
          <SectionTitle>Transfer between wallets</SectionTitle>
          {!transferOpen ? <Button label="＋ Transfer" onPress={() => { setFromWalletId(app.data.wallets[0].id); setToWalletId(''); setTransferDate(app.today); setTransferOpen(true); }} /> : (
            <Card>
              <Chips label="From" options={app.data.wallets.map((wallet) => wallet.id)} labels={Object.fromEntries(app.data.wallets.map((wallet) => [wallet.id, `${wallet.name} - ${wallet.currency}`]))} value={transferFrom.id} onChange={(id) => { setFromWalletId(id); const source = app.data.wallets.find((wallet) => wallet.id === id); if (source && source.id === toWalletId) setToWalletId(''); }} />
              {transferTargets.length ? <Chips label="To - same currency only" options={transferTargets.map((wallet) => wallet.id)} labels={Object.fromEntries(transferTargets.map((wallet) => [wallet.id, wallet.name]))} value={transferTargets.some((wallet) => wallet.id === toWalletId) ? toWalletId : transferTargets[0].id} onChange={setToWalletId} /> : <Text style={[typography.secondary, { color: c.sub, marginBottom: 8 }]}>Create another {transferFrom.currency} wallet before transferring.</Text>}
              <Field label={`Amount - ${transferFrom.currency}`} value={transferAmount} onChangeText={setTransferAmount} keyboardType="decimal-pad" />
              <Field label="Date - YYYY-MM-DD" value={transferDate} onChangeText={setTransferDate} maxLength={10} />
              <Field label="Note - optional" value={transferNote} onChangeText={setTransferNote} maxLength={500} />
              {transferError ? <Text accessibilityRole="alert" style={{ color: c.danger, marginBottom: 8 }}>{transferError}</Text> : null}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button label="Save transfer" disabled={!transferTargets.length} style={{ flex: 1 }} onPress={() => { void saveTransfer(); }} />
                <Button kind="secondary" label="Cancel" onPress={() => setTransferOpen(false)} />
              </View>
            </Card>
          )}
        </>
      ) : null}
    </>
  );
}
