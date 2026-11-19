import { useEffect, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { expensesToCsv, parseExpenseCsv, type CsvImportRow } from '../domain/csv';
import { USER_CURRENCIES } from '../domain/money';
import { partitionDuplicates } from '../domain/duplicates';
import { newId } from '../domain/ids';
import type { AppData } from '../domain/types';
import { exportTextFile, pickTextFile } from '../services/files';
import { systemRandom } from '../services/random';
import { runSelfTest, type SelfTestResult } from '../services/selfTest';
import { runKdfBenchmark, type FullBenchmarkSuiteResult } from '../services/kdfBenchmark';
import { secureVault } from '../services/vault';
import {
  executeRestoreWithRollback,
  executeUndoWithCapture,
  getPreRestoreSnapshot,
  clearPreRestoreSnapshot,
  purgeExpiredSnapshot,
  computeDataChanges,
  RestoreSnapshot,
} from '../services/restoreRollback';
import { useApp } from '../state/AppProvider';
import { inspectBackup, isEncryptedBackupText, makeBackupPlaintext } from '../storage/backup';
import { parseData } from '../storage/repository';
import { Banner, Button, Card, Chips, ExpandableSection, Field, ProgressBar, Screen, SectionTitle } from '../ui/components';
import { CreateEncryptedBackup, UnlockBackup, VerifyBackup } from '../ui/EncryptedBackup';
import { GoogleDriveBackupSection } from '../ui/GoogleDriveBackupModal';
import ContactsSync from '../ui/ContactsSync';
import { type as typography, useTheme } from '../ui/theme';
import { inspectWebStorage, requestWebStoragePersistence, type WebStorageStatus } from '../services/webStorage';
import { daysRemainingInTrash } from '../domain/trash';

export default function Settings() {
  const app = useApp();
  const { data, today } = app;
  const { c } = useTheme();
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [paste, setPaste] = useState('');
  const [pendingJson, setPendingJson] = useState<AppData | null>(null);
  const [pendingEnc, setPendingEnc] = useState<string | null>(null);
  const [fromEncrypted, setFromEncrypted] = useState(false);
  const [showPlain, setShowPlain] = useState(false);
  const [showPrivacyPolicy, setShowPrivacyPolicy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testProgress, setTestProgress] = useState(0);
  const [testResults, setTestResults] = useState<SelfTestResult[] | null>(null);
  const [benchmarking, setBenchmarking] = useState(false);
  const [benchProgress, setBenchProgress] = useState<{ stage: string; percent: number }>({ stage: '', percent: 0 });
  const [benchResult, setBenchResult] = useState<FullBenchmarkSuiteResult | null>(null);
  const cancelBenchmarkRef = useRef(false);
  const [pendingCsv, setPendingCsv] = useState<CsvImportRow[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState('');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [replacePhrase, setReplacePhrase] = useState('');
  const [includeDup, setIncludeDup] = useState(false);
  const [undoSnapshot, setUndoSnapshot] = useState<RestoreSnapshot | null>(null);
  const [webStorageStatus, setWebStorageStatus] = useState<WebStorageStatus | null>(null);
  const hasSample = [
    ...data.tasks,
    ...data.expenses,
    ...data.goals,
    ...data.debts,
    ...(data.cycleGroups ?? []),
    ...(data.cycleBills ?? []),
    ...(data.cycleIncomes ?? []),
    ...(data.cyclePayments ?? []),
    ...(data.cycleBillOverrides ?? []),
    ...(data.cycleMonthLockEvents ?? []),
    ...data.wallets,
    ...data.walletEntries,
    ...data.walletTransfers,
    ...data.syncedContacts,
    ...data.messGroups,
    ...data.messMembers,
    ...data.messMeals,
    ...data.messExpenses,
    ...data.dailyExpenseFields,
    ...data.dailyExpenseSheets,
    ...data.dailyExpenseEntries,
  ].some((x) => x.sample);

  useEffect(() => {
    void purgeExpiredSnapshot();
    void getPreRestoreSnapshot().then((snap) => setUndoSnapshot(snap));
  }, []);

  const refreshWebStorageStatus = async () => {
    setWebStorageStatus(await inspectWebStorage());
  };

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const timer = setTimeout(() => { void refreshWebStorageStatus(); }, 0);
    return () => clearTimeout(timer);
  }, []);

  const requestWebStorage = () => run(async () => {
    await requestWebStoragePersistence();
    await refreshWebStorageStatus();
    setMsg({ tone: 'info', text: 'Persistent browser storage request completed. Keep an encrypted backup as your portable copy.' });
  });

  const run = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { setMsg({ tone: 'danger', text: e instanceof Error ? e.message : 'Something went wrong' }); }
  };

  const exportJson = () => run(async () => {
    await exportTextFile(`personal-assistant-backup-${today}.json`, makeBackupPlaintext(data, true), 'application/json', { moveBeforeShare: true });
    setMsg({ tone: 'info', text: "Plain-text backup created. It isn't encrypted, so anyone with the file can read your records." });
  });
  const exportCsv = () => run(async () => {
    await exportTextFile(`personal-assistant-expenses-${today}.csv`, expensesToCsv(data.expenses), 'text/csv', { moveBeforeShare: true });
    setMsg({ tone: 'info', text: "Expenses CSV created. It isn't encrypted." });
  });

  function stage(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return setMsg({ tone: 'danger', text: 'Nothing to import.' });
    if (isEncryptedBackupText(trimmed)) {
      const info = inspectBackup(trimmed);
      if (!info.ok) return setMsg({ tone: 'danger', text: info.message });
      setPendingEnc(trimmed); setPendingJson(null); setPendingCsv(null); setMsg(null);
      return;
    }
    if (trimmed.startsWith('{')) {
      const r = parseData(trimmed);
      if (!r.ok) return setMsg({ tone: 'danger', text: `Cannot import: ${r.error}` });
      setPendingJson(r.data); setFromEncrypted(false); setPendingEnc(null); setPendingCsv(null); setConfirmReplace(false); setReplacePhrase(''); setMsg(null);
    } else {
      const rows = parseExpenseCsv(trimmed, data.settings.currency);
      if (!rows.length) return setMsg({ tone: 'danger', text: 'No rows found.' });
      setPendingCsv(rows); setPendingJson(null); setMsg(null);
    }
  }
  const exportUnreadable = () => run(async () => {
    const raw = await app.getUnreadableCopy();
    if (!raw) throw new Error('No unreadable copy is stored.');
    await exportTextFile(`personal-assistant-unreadable-data-${today}.txt`, raw, 'text/plain', { moveBeforeShare: true });
    setMsg({ tone: 'info', text: 'Saved the unreadable data as plain text so it can be inspected or repaired. It may contain your private records.' });
  });
  const chooseFile = () => run(async () => { const t = await pickTextFile(); if (t !== null) stage(t); });

  const validRows = pendingCsv?.filter((r) => r.expense) ?? [];
  const parts = partitionDuplicates(validRows.map((r) => ({ ...r.expense!, line: r.line })), data.expenses);
  const goodRows = (includeDup ? [...parts.fresh, ...parts.duplicates] : parts.fresh).map((r) => ({ line: r.line, expense: r }));
  const badRows = pendingCsv?.filter((r) => r.error) ?? [];

  return (
    <Screen title="Settings">
      <SectionTitle>Preferences</SectionTitle>
      <Card>
        <Chips label="Theme" options={['system', 'light', 'dark'] as const} value={data.settings.theme} onChange={(theme) => app.setSettings({ theme })} />
        <Chips label="Default currency - for new entries" options={USER_CURRENCIES} value={data.settings.currency} onChange={(currency) => app.setSettings({ currency })} />
        <Text style={[typography.secondary, { color: c.sub }]}>Changing currency does not convert existing amounts.</Text>
      </Card>

      {Platform.OS === 'web' ? (
        <ExpandableSection title="Browser storage">
          <Card>
            <Text style={[typography.body, { color: c.sub }]}>
              This browser keeps a local copy of your data. The browser may clear it when storage is under pressure, so keep an encrypted backup for moving or recovering your data.
            </Text>
            <Text style={[typography.body, { color: c.text, marginTop: 10 }]}>
              Persistent storage: {webStorageStatus === null ? 'checking…' : !webStorageStatus.supported ? 'unsupported' : webStorageStatus.persisted ? 'granted' : 'not granted'}
            </Text>
            {webStorageStatus?.supported && webStorageStatus.quotaBytes !== null ? (
              <Text style={[typography.secondary, { color: c.sub, marginTop: 4 }]}>
                Browser quota estimate: {Math.round(webStorageStatus.quotaBytes / 1024 / 1024)} MB
              </Text>
            ) : null}
            {webStorageStatus?.supported && !webStorageStatus.persisted ? (
              <Button kind="secondary" label="Request persistent browser storage" onPress={requestWebStorage} style={{ marginTop: 12 }} />
            ) : null}
          </Card>
        </ExpandableSection>
      ) : null}

      <ContactsSync />

      <ExpandableSection title="Backup & move your data">
        {msg ? <Banner tone={msg.tone} text={msg.text} /> : null}
        <Card>
          <Text style={[typography.body, { color: c.sub, marginBottom: 8 }]}>Phone and browser data are separate. To move your data, create an encrypted backup here and restore it on the other device. The backup can include wallets, mess records, and contacts that you chose to cache.</Text>
          <View style={{ gap: 8 }}>
            <CreateEncryptedBackup data={data} today={today} onDone={setMsg} />
            <VerifyBackup />
            <Button kind="secondary" label="Restore from file…" onPress={chooseFile} />
          </View>
          <View style={{ marginTop: 12 }}>
            <Field label="Paste backup text - encrypted backup, backup JSON, or expenses CSV" value={paste} onChangeText={setPaste} multiline />
            <Button kind="secondary" label="Review pasted text" onPress={() => stage(paste)} />
          </View>
          <View style={{ marginTop: 12 }}>
            {showPlain ? (
              <>
                <Banner tone="danger" text="Plain-text exports are not encrypted. Anyone with the file can read your records. Use the encrypted backup when possible." />
                <View style={{ gap: 8, marginTop: 8 }}>
                  <Button kind="secondary" label="Export plain-text backup - JSON" onPress={exportJson} />
                  <Button kind="secondary" label="Export expenses - plain-text CSV" onPress={exportCsv} />
                  <Button kind="secondary" label="Hide plain-text options" onPress={() => setShowPlain(false)} />
                </View>
              </>
            ) : <Button kind="secondary" label="Plain-text export options…" onPress={() => setShowPlain(true)} />}
          </View>
        </Card>
      </ExpandableSection>

      <ExpandableSection title="Google Drive Cloud Backup">
        <GoogleDriveBackupSection
          data={data}
          today={today}
          onRestoreRequested={(backupData) => {
            setPendingJson(backupData);
            setFromEncrypted(true);
            setConfirmReplace(false);
            setReplacePhrase('');
          }}
          onSetMessage={setMsg}
        />
      </ExpandableSection>

      {pendingEnc ? <UnlockBackup text={pendingEnc} onCancel={() => setPendingEnc(null)} onUnlocked={(d) => { setPendingJson(d); setFromEncrypted(true); setConfirmReplace(false); setReplacePhrase(''); setPendingEnc(null); setPaste(''); }} /> : null}

      {pendingJson ? (
        <Card>
          <Text style={{ color: c.text, fontWeight: '700', marginBottom: 4 }}>{fromEncrypted ? 'Review decrypted backup' : 'Review import'}</Text>
          <Text style={{ color: c.text }}>In the backup: {pendingJson.tasks.length} tasks, {pendingJson.expenses.length} expenses, {pendingJson.goals.length} goals, {pendingJson.debts.length} debts, {pendingJson.wallets.length} wallets, {pendingJson.messGroups.length} mess groups, {pendingJson.messExpenses.length} mess expenses, {pendingJson.syncedContacts.length} cached contacts{pendingJson.cycleBills?.length ? `, ${pendingJson.cycleBills.length} cycle bills` : ''}.</Text>
          <Text style={{ color: c.sub }}>Now on this device: {data.tasks.filter((t) => !t.deletedAt).length} tasks, {data.expenses.length} expenses, {data.goals.length} goals, {data.debts.length} debts, {data.wallets.length} wallets, {data.messGroups.length} mess groups, {data.messExpenses.length} mess expenses, {data.syncedContacts.length} cached contacts{(data.cycleBills ?? []).length ? `, ${(data.cycleBills ?? []).length} cycle bills` : ''}.</Text>
          {pendingJson.cycleBills?.length ? (
            <View style={{ backgroundColor: c.border, padding: 8, borderRadius: 6, marginVertical: 6 }}>
              <Text style={{ color: c.text, fontSize: 12 }}>
                ℹ️ Capabilities: Includes Monthly Money Cycle commitments - {pendingJson.cycleBills.length} bills. Restoring into older Personal Assistant versions that lack Cycle capabilities will not display Cycle records.
              </Text>
            </View>
          ) : null}
          <Text style={{ color: c.danger, marginVertical: 8 }}>This REPLACES all data currently on this device - you can undo right after.</Text>
          {!confirmReplace ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button label="Continue to replace data" style={{ flex: 1 }} onPress={() => setConfirmReplace(true)} />
              <Button kind="secondary" label="Cancel" style={{ flex: 1 }} onPress={() => { setPendingJson(null); setFromEncrypted(false); }} />
            </View>
          ) : (
            <>
              <Text style={{ color: c.danger, fontSize: 13, marginBottom: 6 }}>Type REPLACE to confirm that current data will be overwritten.</Text>
              <Field
                label="Type REPLACE to confirm"
                value={replacePhrase}
                onChangeText={setReplacePhrase}
                autoCapitalize="characters"
                autoCorrect={false}
              />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button
                  label="Replace my data"
                  disabled={replacePhrase.trim() !== 'REPLACE'}
                  style={{ flex: 1 }}
                  onPress={async () => {
                    const res = await executeRestoreWithRollback(pendingJson, data, (d) => app.replaceAll(d));
                    if (!res.ok) {
                      return setMsg({ tone: 'danger', text: `Import blocked: ${res.error}. Prior data preserved.` });
                    }
                    setPendingJson(null);
                    setFromEncrypted(false);
                    setPaste('');
                    setConfirmReplace(false);
                    setReplacePhrase('');
                    const snap = await getPreRestoreSnapshot();
                    setUndoSnapshot(snap);
                    setMsg({ tone: 'info', text: 'Data restored successfully.' });
                  }}
                />
                <Button kind="secondary" label="Cancel" style={{ flex: 1 }} onPress={() => { setConfirmReplace(false); setReplacePhrase(''); }} />
              </View>
            </>
          )}
        </Card>
      ) : null}

      {undoSnapshot ? (() => {
        const changeSummary = computeDataChanges(data, undoSnapshot.data);
        const isRedo = undoSnapshot.kind === 'pre-undo';
        return (
          <Card>
            <Text style={{ color: c.text, fontWeight: '700', marginBottom: 4 }}>
              {isRedo ? 'Redo / Return to latest data' : 'Undo recent restore'}
            </Text>
            <Text style={{ color: c.sub, fontSize: 13, marginBottom: 4 }}>
              {isRedo
                ? `A snapshot was saved before your last undo on ${new Date(undoSnapshot.timestamp).toLocaleTimeString()}. You can return to your latest data within 24 hours.`
                : `A local snapshot was saved before your last restore on ${new Date(undoSnapshot.timestamp).toLocaleTimeString()}. You can revert to your previous local data within 24 hours. This snapshot contains only data that was previously on this device.`}
            </Text>
            <Text style={{ color: c.primary, fontSize: 12, fontWeight: '600', marginBottom: 8 }}>
              Your current data will be saved first, so you can return to it.
            </Text>
            {changeSummary.hasChanges ? (
              <View style={{ backgroundColor: c.border, padding: 8, borderRadius: 6, marginBottom: 8 }}>
                <Text style={{ color: c.text, fontSize: 12, fontWeight: '600' }}>
                  ⚠️ Notice: {changeSummary.totalChanges} local changes ({changeSummary.details}) made since this snapshot will be replaced.
                </Text>
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button
                kind="secondary"
                label={isRedo ? 'Redo - return to my latest data' : 'Undo restore - revert to previous data'}
                style={{ flex: 1 }}
                onPress={async () => {
                  const res = await executeUndoWithCapture(undoSnapshot.id, data, (d) => app.replaceAll(d));
                  if (!res.ok) {
                    return setMsg({ tone: 'danger', text: res.error });
                  }
                  const snap = await getPreRestoreSnapshot();
                  setUndoSnapshot(snap);
                  setMsg({
                    tone: 'info',
                    text: isRedo
                      ? 'Latest data restored. Pre-undo state captured.'
                      : 'Previous device data restored successfully. Current data was saved so you can Redo anytime.',
                  });
                }}
              />
              <Button
                kind="secondary"
                label="Dismiss"
                onPress={async () => {
                  await clearPreRestoreSnapshot();
                  setUndoSnapshot(null);
                }}
              />
            </View>
          </Card>
        );
      })() : null}

      {pendingCsv ? (
        <Card>
          <Text style={{ color: c.text, fontWeight: '700', marginBottom: 4 }}>Review CSV import</Text>
          <Text style={{ color: c.text }}>{goodRows.length} rows will be added. {badRows.length} invalid rows skipped.</Text>
          {parts.duplicates.length ? (
            <>
              <Text style={{ color: c.warn, marginTop: 4 }}>{parts.duplicates.length} rows look identical to expenses you already have and are {includeDup ? 'INCLUDED' : 'skipped'}.</Text>
              <Button kind="secondary" label={includeDup ? 'Skip duplicates' : 'Include duplicates anyway'} onPress={() => setIncludeDup((v) => !v)} style={{ marginTop: 6 }} />
            </>
          ) : null}
          {badRows.slice(0, 5).map((r) => <Text key={r.line} style={{ color: c.danger, fontSize: 14 }}>Line {r.line}: {r.error}</Text>)}
          {goodRows.slice(0, 3).map((r) => <Text key={r.line} style={{ color: c.sub, fontSize: 14 }}>Line {r.line}: {r.expense!.date} · {r.expense!.amountMinor} minor {r.expense!.currency} · {r.expense!.category}</Text>)}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Button
              label={`Add ${goodRows.length} expenses`}
              disabled={!goodRows.length}
              style={{ flex: 1 }}
              onPress={async () => {
                const target = {
                  ...data,
                  expenses: [
                    ...data.expenses,
                    ...goodRows.map((r) => {
                      const { line: _l, ...e } = r.expense;
                      return { ...e, id: newId('exp'), sample: false, originalText: null };
                    }),
                  ],
                };
                const res = await executeRestoreWithRollback(target, data, (d) => app.replaceAll(d));
                if (!res.ok) {
                  return setMsg({ tone: 'danger', text: `Import blocked: ${res.error}. Prior data preserved.` });
                }
                setPendingCsv(null);
                setPaste('');
                setIncludeDup(false);
              }}
            />
            <Button kind="secondary" label="Cancel" style={{ flex: 1 }} onPress={() => setPendingCsv(null)} />
          </View>
        </Card>
      ) : null}

      {app.loadError ? (
        <Card>
          <Text style={{ color: c.danger, marginBottom: 8 }}>On the last start Personal Assistant could not read the saved data: {app.loadError}. A raw copy was kept. It is replaced if unreadable data is found again, so export it now if you need it.</Text>
          <Button kind="secondary" label="Export unreadable data copy" onPress={exportUnreadable} />
        </Card>
      ) : null}

      <SectionTitle>Sample data</SectionTitle>
      <Card>
        {hasSample ? <Button kind="secondary" label="Remove sample data" onPress={app.removeSample} /> : <Button kind="secondary" label="Load labelled sample data" onPress={app.loadSample} />}
      </Card>

      <SectionTitle>Security self-test</SectionTitle>
      <Card>
        <Text style={[typography.body, { color: c.sub, marginBottom: 8 }]}>This checks the encryption tools available on this device, including secure random numbers, AES encryption, the phone&apos;s secure key vault, and backup encryption time. It does not read or change your data.</Text>
        <Button kind="secondary" label={testing ? 'Running… - up to a minute' : 'Run self-test'} disabled={testing} onPress={async () => {
          setTesting(true); setTestResults(null); setTestProgress(0);
          try { setTestResults(await runSelfTest({ random: systemRandom, vault: secureVault, includeKdf: true, onProgress: setTestProgress })); }
          catch { setTestResults([{ name: 'Self-test', status: 'fail', detail: 'Could not run.' }]); }
          finally { setTesting(false); }
        }} />
        {testing ? <View style={{ marginTop: 8 }}><ProgressBar pct={Math.round(testProgress * 100)} label="Self-test progress" /></View> : null}
        {testResults ? testResults.map((r) => (
          <Text key={r.name} style={{ color: r.status === 'fail' ? c.danger : r.status === 'skip' ? c.sub : c.success, marginTop: 6, fontSize: 14 }}>
            {r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '–'} {r.name}{r.ms !== undefined ? ` - ${(r.ms / 1000).toFixed(1)} s` : ''}: {r.detail}
          </Text>
        )) : null}
      </Card>

      <SectionTitle>Encryption speed check</SectionTitle>
      <Card>
        <Text style={[typography.secondary, { color: c.sub, marginBottom: 10 }]}>
          This optional check measures how quickly this device can protect a synthetic 1 MB backup. It does not read, change, upload, or delete your data.
        </Text>
        {!benchmarking ? (
          <Button
            kind="secondary"
            label={benchResult ? 'Run the check again' : 'Check encryption speed'}
            onPress={async () => {
              setBenchmarking(true);
              setBenchResult(null);
              setBenchProgress({ stage: 'Starting benchmark...', percent: 0 });
              cancelBenchmarkRef.current = false;
              try {
                const res = await runKdfBenchmark({
                  onProgress: (p) => setBenchProgress({ stage: p.stage, percent: p.percent }),
                  shouldCancel: () => cancelBenchmarkRef.current,
                });
                setBenchResult(res);
              } catch (err) {
                setMsg({ tone: 'danger', text: err instanceof Error ? err.message : 'Benchmark failed' });
              } finally {
                setBenchmarking(false);
              }
            }}
          />
        ) : (
          <View style={{ gap: 8 }}>
            <ProgressBar pct={benchProgress.percent} label={benchProgress.stage} />
            <Text style={[typography.caption, { color: c.sub }]}>{benchProgress.stage}</Text>
            <Button
              kind="danger"
              label="Cancel benchmark"
              onPress={() => {
                cancelBenchmarkRef.current = true;
              }}
            />
          </View>
        )}
        {benchResult ? (
          <View style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 10 }}>
            <Text style={[typography.cardTitle, { color: c.text, marginBottom: 8 }]}>
              Encryption speed results
            </Text>
            {benchResult.rows.map((row) => (
              <View key={row.target.label} style={{ marginBottom: 8, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: c.border }}>
                <Text style={[typography.secondary, { color: c.text, fontWeight: '600' }]}>
                  {row.status === 'pass' ? '✓' : row.status === 'timeout' ? '⏱' : '✗'} {row.target.label} - {row.target.ramBytes / (1024 * 1024)} MiB RAM:
                </Text>
                {row.status === 'pass' ? (
                  <>
                    <Text style={[typography.caption, { color: c.sub }]}>
                      • Pure KDF: {((row.pureKdfMs ?? 0) / 1000).toFixed(2)} s
                    </Text>
                    <Text style={[typography.caption, { color: c.sub }]}>
                      • Encrypt 1 MB: {((row.encrypt1MbMs ?? 0) / 1000).toFixed(2)} s
                    </Text>
                    <Text style={[typography.caption, { color: c.sub }]}>
                      • Decrypt 1 MB: {((row.decrypt1MbMs ?? 0) / 1000).toFixed(2)} s
                    </Text>
                    <Text style={[typography.caption, { color: c.success }]}>
                      • Archive valid: {row.archiveValid ? 'Yes, within the safe limits' : 'No'}
                    </Text>
                  </>
                ) : (
                  <Text style={[typography.caption, { color: c.danger }]}>
                    Status: {row.status.toUpperCase()} - {row.error}
                  </Text>
                )}
              </View>
            ))}
            {benchResult.cancellation ? (
              <Text style={[typography.caption, { color: c.sub, marginTop: 4 }]}>
                Cancellation latency (N=16,384): {benchResult.cancellation.cancelLatencyMs} ms
              </Text>
            ) : null}
          </View>
        ) : null}
      </Card>

      <SectionTitle>Trash</SectionTitle>
      <Card>
        {data.trash.length === 0 ? (
          <Text style={[typography.body, { color: c.sub }]}>Deleted records are kept here for 30 days before they expire.</Text>
        ) : (
          <>
            <Text style={[typography.body, { color: c.sub, marginBottom: 10 }]}>
              Deleted records stay here for up to 30 days. Backups and exports do not include Trash.
            </Text>
            {data.trash.map((item) => (
              <View key={item.id} style={{ borderTopWidth: 1, borderTopColor: c.border, paddingVertical: 10, gap: 6 }}>
                <Text style={[typography.cardTitle, { color: c.text }]}>{item.title}</Text>
                <Text style={[typography.caption, { color: c.sub }]}>
                  {item.itemType} · {daysRemainingInTrash(item.deletedAt)} days remaining
                </Text>
                <View style={{ flexDirection: 'column', gap: 8 }}>
                  <Button
                    kind="secondary"
                    size="compact"
                    label="Restore"
                    onPress={() => { void app.restoreTrash(item.id).then((error) => error && setMsg({ tone: 'danger', text: error })); }}
                    style={{ flex: 1 }}
                  />
                  <Button
                    kind="danger"
                    size="compact"
                    label="Delete permanently"
                    onPress={() => { void app.deleteTrashItem(item.id); }}
                    style={{ flex: 1 }}
                  />
                </View>
              </View>
            ))}
            <View style={{ flexDirection: 'column', gap: 8, marginTop: 10 }}>
              <Button kind="secondary" label="Remove expired" onPress={() => { void app.purgeTrash(); }} style={{ flex: 1 }} />
              <Button kind="danger" label="Empty Trash" onPress={() => { void app.emptyTrash(); }} style={{ flex: 1 }} />
            </View>
          </>
        )}
      </Card>

      <SectionTitle>Delete data</SectionTitle>
      <Card>
        {confirmDelete ? (
          <>
            <Text style={{ color: c.danger, marginBottom: 8 }}>This permanently erases all Personal Assistant data on this device/browser. It cannot be undone. Export a backup first if unsure.</Text>
            <Text style={{ color: c.danger, fontSize: 13, marginBottom: 6 }}>Type DELETE to confirm.</Text>
            <Field
              label="Type DELETE to confirm"
              value={deletePhrase}
              onChangeText={setDeletePhrase}
              autoCapitalize="characters"
              autoCorrect={false}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button
                kind="danger"
                label="Yes, erase everything"
                disabled={deletePhrase.trim() !== 'DELETE'}
                style={{ flex: 1 }}
                onPress={async () => {
                  await app.deleteEverything();
                  setConfirmDelete(false);
                  setDeletePhrase('');
                  setMsg({ tone: 'info', text: 'All local data erased.' });
                }}
              />
              <Button kind="secondary" label="Cancel" style={{ flex: 1 }} onPress={() => { setConfirmDelete(false); setDeletePhrase(''); }} />
            </View>
          </>
        ) : <Button kind="danger" label="Delete all my data…" onPress={() => { setConfirmDelete(true); setDeletePhrase(''); }} />}
      </Card>

      <ExpandableSection title="Privacy & storage">
        <Card>
          <View style={{ gap: 12 }}>
            <View>
              <Text style={[typography.cardTitle, { color: c.text, marginBottom: 4 }]}>Where your data lives</Text>
              <Text style={[typography.body, { color: c.text }]}>Local-first - your data stays on this device by default. Personal Assistant has no accounts - servers or analytics. It uploads nothing to us unless you explicitly choose optional encrypted Google Drive backup. That backup goes only to your own Google Drive account, inside the &quot;Personal Assistant Backups/&quot; folder.</Text>
            </View>
            <View>
              <Text style={[typography.cardTitle, { color: c.text, marginBottom: 4 }]}>Phone storage</Text>
              <Text style={[typography.body, { color: c.text }]}>On the phone, data lives in the app&apos;s private storage, protected by your phone&apos;s lock and OS app sandbox. Personal Assistant does NOT add its own encryption to the local working database. Do not assume local storage is encrypted.</Text>
            </View>
            <View>
              <Text style={[typography.cardTitle, { color: c.text, marginBottom: 4 }]}>Browser storage</Text>
              <Text style={[typography.body, { color: c.text }]}>In a browser, data lives in that browser&apos;s localStorage for this site. It is not encrypted and is separate from your phone&apos;s data.</Text>
            </View>
            <View>
              <Text style={[typography.cardTitle, { color: c.text, marginBottom: 4 }]}>Backup protection</Text>
              <Text style={[typography.body, { color: c.text }]}>Encrypted backups, whether local export or Google Drive, are protected with AES-256-GCM encryption using a passphrase only you know. There is no recovery if the passphrase is forgotten. Optional plain-text exports are readable by anyone who has the file.</Text>
            </View>
            <Button kind="secondary" label={showPrivacyPolicy ? 'Hide privacy policy' : 'Open privacy policy'} onPress={() => setShowPrivacyPolicy((value) => !value)} />
            {showPrivacyPolicy ? (
              <Card>
                <Text style={[typography.cardTitle, { color: c.text, marginBottom: 8 }]}>Personal Assistant Privacy Policy</Text>
                <View style={{ gap: 10 }}>
                  <Text style={[typography.body, { color: c.text }]}>Personal Assistant stores tasks, expenses, savings, debts, wallets, mess records, Cycle records, receipt attachments and optional cached contacts locally on the device or in browser storage. The app does not add its own encryption to this working data.</Text>
                  <Text style={[typography.body, { color: c.text }]}>The app requires no account and uses no advertising or analytics SDK. No app server receives your records.</Text>
                  <Text style={[typography.body, { color: c.text }]}>Emergency SOS requests foreground location only after you choose Share current location. Personal Assistant does not background-track, store or upload location. Calling 999 does not guarantee emergency-service receipt.</Text>
                  <Text style={[typography.body, { color: c.text }]}>Phone contacts are read only after permission and a manual Refresh action. Cached contact fields remain local and may be included in backups.</Text>
                  <Text style={[typography.body, { color: c.text }]}>Encrypted backups use AES-256-GCM and a passphrase-derived key. Plain-text exports are readable and include a warning. Google Drive backup stays off until you connect your own Google account.</Text>
                  <Text style={[typography.body, { color: c.text }]}>You can delete records, restore supported records from Trash, or erase app data. Downloaded or shared backups remain outside the app and must be deleted separately.</Text>
                </View>
              </Card>
            ) : null}
          </View>
        </Card>
      </ExpandableSection>
    </Screen>
  );
}
