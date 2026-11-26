import { useMemo, useState } from 'react';
import { Platform, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { notify } from './notify';
import * as XLSX from 'xlsx';
import { getDateRangePreset } from '../domain/dates';
import { dailyExpenseEntriesToCsv, filterDailyExpenseEntries, parseExpenseSheetDate, previewDailyExpenseCsv } from '../domain/expenseSheet';
import { formatMoney, parseMoney, toDecimalString, USER_CURRENCIES, type SupportedCurrency } from '../domain/money';
import type { DailyExpenseEntry, DailyExpenseFieldType } from '../domain/types';
import { useApp } from '../state/AppProvider';
import { exportDailyExpensePdf, exportDailyExpenseXlsx } from '../services/expenseSheetFiles';
import { ReceiptAttachments } from './ReceiptAttachments';
import { exportTextFile, pickBinaryFile } from '../services/files';
import { CalendarPicker } from './CalendarPicker';
import { Button, Card, Chips, EmptyState, Field, SectionTitle } from './components';
import { radiusSm, space, type as typography, useTheme } from './theme';

type PreviewRow = ReturnType<typeof previewDailyExpenseCsv>[number];

const QUICK_PLACES = ['Food', 'Rickshaw', 'Transport', 'Groceries', 'Snacks', 'Medicine', 'Shopping', 'Other'] as const;
const FIELD_TYPES: DailyExpenseFieldType[] = ['text', 'number', 'choice'];
type RangePreset = 'all' | 'this_month' | 'last_7_days' | 'last_30_days';

export default function DailyExpenseSheet() {
  const app = useApp();
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const compact = width < 420;
  const [sheetId, setSheetId] = useState('');
  const [date, setDate] = useState(app.today);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [place, setPlace] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<SupportedCurrency>(app.data.settings.currency as SupportedCurrency);
  const [note, setNote] = useState('');
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);

  // Filters
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [showFromPicker, setShowFromPicker] = useState(false);
  const [showToPicker, setShowToPicker] = useState(false);
  const [query, setQuery] = useState('');
  const [rangePreset, setRangePreset] = useState<RangePreset>('all');

  // Import / Export
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [busy, setBusy] = useState(false);

  // Sheet & Column Management
  const [newSheetName, setNewSheetName] = useState('');
  const [showNewSheet, setShowNewSheet] = useState(false);
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldType, setNewFieldType] = useState<DailyExpenseFieldType>('text');
  const [newFieldOptions, setNewFieldOptions] = useState('');

  const sheet = app.data.dailyExpenseSheets.find((item) => item.id === sheetId) ?? app.data.dailyExpenseSheets[0];
  const fields = useMemo(() => app.data.dailyExpenseFields.filter((field) => sheet?.fieldIds.includes(field.id)), [app.data.dailyExpenseFields, sheet]);

  const entries = useMemo(() => filterDailyExpenseEntries(app.data.dailyExpenseEntries, {
    sheetId: sheet?.id,
    from: from || undefined,
    to: to || undefined,
    query: query || undefined,
  }), [app.data.dailyExpenseEntries, from, query, sheet?.id, to]);

  const totalByCurrency = useMemo(() => {
    const totals = new Map<string, number>();
    for (const entry of entries) totals.set(entry.currency, (totals.get(entry.currency) ?? 0) + entry.amountMinor);
    return [...totals.entries()];
  }, [entries]);

  const groupedEntries = useMemo(() => {
    const groups = new Map<string, DailyExpenseEntry[]>();
    for (const entry of entries) groups.set(entry.date, [...(groups.get(entry.date) ?? []), entry]);
    return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [entries]);

  if (!sheet) {
    return (
      <Card>
        <SectionTitle>Create a daily expense sheet</SectionTitle>
        <Text style={[typography.secondary, { color: c.sub, marginBottom: space.md }]}>
          Start a separate sheet for daily entries. Existing Money Cycle records remain unchanged.
        </Text>
        <Field label="Sheet name" value={newSheetName} onChangeText={setNewSheetName} placeholder="Daily travel expenses" />
        <Button label="Create sheet" onPress={async () => {
          const error = await app.addDailyExpenseSheet({ name: newSheetName.trim() || 'Daily Expenses', currency: app.data.settings.currency, fieldIds: [] });
          if (error) notify('Could not create sheet', error);
          else setNewSheetName('');
        }} />
      </Card>
    );
  }

  async function saveEntry() {
    const parsedDate = parseExpenseSheetDate(date);
    const amountMinor = parseMoney(amount, currency);
    if (!parsedDate) return notify('Invalid date', 'Use YYYY-MM-DD, DD/MM/YYYY, Bengali digits, or pick from the calendar.');
    if (amountMinor === null || amountMinor <= 0) return notify('Invalid amount', 'Enter a positive amount without too many decimal places.');
    const payload = {
      sheetId: sheet.id,
      date: parsedDate,
      amountMinor,
      currency,
      category: place.trim() || 'Other',
      note: note.trim(),
      customValues,
    };
    const error = editingId ? await app.updateDailyExpenseEntry(editingId, payload) : await app.addDailyExpenseEntry(payload);
    if (error) return notify('Could not save entry', error);
    setEditingId(null);
    setPlace('');
    setAmount('');
    setNote('');
    setCustomValues({});
    setShowDatePicker(false);
  }

  function editEntry(entry: DailyExpenseEntry) {
    setEditingId(entry.id);
    setDate(entry.date);
    setPlace(entry.category);
    setAmount(toDecimalString(entry.amountMinor, entry.currency));
    setCurrency(entry.currency as SupportedCurrency);
    setNote(entry.note ?? '');
    setCustomValues(entry.customValues ?? {});
    setShowDatePicker(false);
  }

  function applyRangePreset(preset: RangePreset) {
    setRangePreset(preset);
    setShowFromPicker(false);
    setShowToPicker(false);
    if (preset === 'all') {
      setFrom('');
      setTo('');
    } else {
      const { from: pFrom, to: pTo } = getDateRangePreset(preset, app.today);
      setFrom(pFrom);
      setTo(pTo);
    }
  }

  async function exportCsv() {
    try {
      await exportTextFile(`personal-assistant-daily-expenses-${sheet.id}.csv`, `\uFEFF${dailyExpenseEntriesToCsv(entries, fields)}`, 'text/csv', { moveBeforeShare: true });
      notify('CSV export ready', 'The CSV file was created and opened for download or sharing.');
    } catch (error) {
      notify('Export failed', error instanceof Error ? error.message : 'Could not export the CSV file.');
    }
  }

  function sheetReceipts() {
    const entryIds = new Set(entries.map((entry) => entry.id));
    return app.data.receiptAttachments.filter((receipt) => receipt.recordType === 'daily_expense' && entryIds.has(receipt.recordId));
  }

  // One file per button: two exports in a row stacked two share sheets on Android, and
  // browsers block the second automatic download.
  async function exportFile(kind: 'excel' | 'pdf') {
    setBusy(true);
    const name = `personal-assistant-daily-expenses-${sheet.id}.${kind === 'excel' ? 'xlsx' : 'pdf'}`;
    try {
      if (kind === 'excel') await exportDailyExpenseXlsx(name, sheet, entries, fields, sheetReceipts());
      else await exportDailyExpensePdf(name, sheet, entries, fields, sheetReceipts());
      notify(kind === 'excel' ? 'Excel file ready' : 'PDF ready', Platform.OS === 'web' ? 'It is in your downloads.' : 'Choose where to save or share it.');
    } catch (error) {
      notify('Export failed', error instanceof Error ? error.message : 'Could not export the sheet.');
    } finally {
      setBusy(false);
    }
  }

  async function importFile() {
    setBusy(true);
    try {
      const picked = await pickBinaryFile();
      if (!picked) return;
      const isCsv = picked.name.toLowerCase().endsWith('.csv');
      let text: string;
      if (isCsv) {
        text = new TextDecoder().decode(picked.bytes);
      } else {
        const workbook = XLSX.read(picked.bytes, { type: 'array' });
        const worksheetName = workbook.SheetNames[0];
        if (!worksheetName || !workbook.Sheets[worksheetName]) {
          throw new Error('The XLSX file has no readable worksheet.');
        }
        text = XLSX.utils.sheet_to_csv(workbook.Sheets[worksheetName]);
      }
      setPreview(previewDailyExpenseCsv(text, sheet.currency, entries, fields));
    } catch (error) {
      notify('Import failed', error instanceof Error ? error.message : 'Could not read the file.');
    } finally {
      setBusy(false);
    }
  }

  async function importPreview() {
    if (!preview) return;
    const rows = preview.filter((row) => row.entry && (!row.duplicate || includeDuplicates));
    for (const row of rows) {
      if (!row.entry) continue;
      const error = await app.addDailyExpenseEntry({ ...row.entry, sheetId: sheet.id });
      if (error) return notify('Import stopped', error);
    }
    notify('Import complete', `${rows.length} added, ${preview.length - rows.length} skipped.`);
    setPreview(null);
  }

  async function addField() {
    const name = newFieldName.trim();
    if (!name) return;
    const options = newFieldType === 'choice'
      ? newFieldOptions.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    if (newFieldType === 'choice' && options.length === 0) {
      return notify('Options required', 'Enter at least one option separated by commas for choice fields.');
    }
    const error = await app.addDailyExpenseField({ name, type: newFieldType, options, required: false });
    if (error) return notify('Could not add field', error);
    setNewFieldName('');
    setNewFieldOptions('');
  }

  return (
    <View style={{ gap: space.md }}>
      <Card>
        <SectionTitle action={<Button size="compact" label="New sheet" onPress={() => setShowNewSheet((value) => !value)} />}>Daily Expense Sheet</SectionTitle>
        <Text style={[typography.secondary, { color: c.sub }]}>Sheet: {sheet.name}</Text>
        {showNewSheet ? (
          <View style={{ marginTop: space.sm }}>
            <Field label="New sheet name" value={newSheetName} onChangeText={setNewSheetName} placeholder="November travel" />
            <Button size="compact" label="Create" onPress={async () => {
              const error = await app.addDailyExpenseSheet({ name: newSheetName.trim() || 'Daily Expenses', currency: app.data.settings.currency, fieldIds: [] });
              if (error) notify('Could not create sheet', error);
              else { setNewSheetName(''); setShowNewSheet(false); }
            }} />
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: space.sm }}>
          {app.data.dailyExpenseSheets.map((item) => (
            <Button key={item.id} size="compact" kind={item.id === sheet.id ? 'primary' : 'secondary'} label={item.name} onPress={() => setSheetId(item.id)} />
          ))}
        </View>
      </Card>

      <Card>
        <SectionTitle>{editingId ? 'Edit entry' : 'Add entry'}</SectionTitle>

        <View style={{ gap: space.xs }}>
          <Field label="Date - YYYY-MM-DD or Bengali digits" value={date} onChangeText={setDate} placeholder="2026-11-15" />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: space.xs }}>
            <Button
              size="compact"
              kind="secondary"
              label={showDatePicker ? 'Hide calendar ▲' : '📅 Calendar ▼'}
              onPress={() => setShowDatePicker((v) => !v)}
            />
            <Button size="compact" kind="secondary" label="Today" onPress={() => { setDate(app.today); setShowDatePicker(false); }} />
          </View>
          {showDatePicker ? (
            <CalendarPicker
              value={date}
              today={app.today}
              onChange={(picked) => { setDate(picked); setShowDatePicker(false); }}
              onClose={() => setShowDatePicker(false)}
            />
          ) : null}
        </View>

        <View style={{ gap: space.xs }}>
          <Field label="Place / category" value={place} onChangeText={setPlace} placeholder="Lunch, Rickshaw, Groceries" />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: space.xs }}>
            {QUICK_PLACES.map((qp) => (
              <Pressable
                key={qp}
                accessibilityRole="button"
                accessibilityLabel={`Select category ${qp}`}
                onPress={() => setPlace(qp)}
                style={({ pressed }) => [
                  {
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    borderRadius: radiusSm,
                    borderWidth: 1,
                    borderColor: place === qp ? c.primary : c.border,
                    backgroundColor: place === qp ? c.chip : pressed ? c.chip : 'transparent',
                  },
                ]}
              >
                <Text style={[typography.caption, { color: place === qp ? c.primary : c.text, fontWeight: place === qp ? '700' : '400' }]}>
                  {qp}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <Field label={`Amount - ${currency}`} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="456.5" />
        <Chips label="Currency" options={USER_CURRENCIES} value={currency} onChange={setCurrency} />

        <Field label="Note / memo - optional" value={note} onChangeText={setNote} placeholder="e.g. Canteen lunch - shared with Fahim" />

        {fields.map((field) => {
          const val = customValues[field.id] ?? '';
          if (field.type === 'choice' && field.options.length > 0) {
            return (
              <View key={field.id} style={{ gap: space.xs, marginBottom: space.xs }}>
                <Text style={[typography.secondary, { fontWeight: '600', color: c.text }]}>{field.name}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {field.options.map((opt) => {
                    const isSelected = val === opt;
                    return (
                      <Pressable
                        key={opt}
                        accessibilityRole="button"
                        accessibilityLabel={`Select ${opt}`}
                        onPress={() => setCustomValues((cur) => ({ ...cur, [field.id]: opt }))}
                        style={[
                          {
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            borderRadius: radiusSm,
                            borderWidth: 1,
                            borderColor: isSelected ? c.primary : c.border,
                            backgroundColor: isSelected ? c.primary : c.chip,
                          },
                        ]}
                      >
                        <Text style={[typography.caption, { color: isSelected ? c.onPrimary : c.text, fontWeight: isSelected ? '700' : '500' }]}>
                          {opt}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            );
          }
          return (
            <Field
              key={field.id}
              label={field.name}
              value={val}
              keyboardType={field.type === 'number' ? 'numeric' : 'default'}
              onChangeText={(v) => setCustomValues((cur) => ({ ...cur, [field.id]: v }))}
            />
          );
        })}

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: space.xs }}>
          <Button label={editingId ? 'Update entry' : 'Add entry'} onPress={() => void saveEntry()} />
          {editingId ? <Button kind="secondary" label="Cancel" onPress={() => { setEditingId(null); setNote(''); setPlace(''); setAmount(''); }} /> : null}
        </View>
      </Card>

      <Card>
        <SectionTitle>Custom columns</SectionTitle>
        <Text style={[typography.secondary, { color: c.sub, marginBottom: space.sm }]}>
          Add custom columns such as payment method or transport type to this sheet.
        </Text>
        <Field label="Column name" value={newFieldName} onChangeText={setNewFieldName} placeholder="e.g. Payment Method, Vehicle" />
        <Chips label="Column type" options={FIELD_TYPES} value={newFieldType} onChange={setNewFieldType} />
        {newFieldType === 'choice' ? (
          <Field
            label="Options - comma separated"
            value={newFieldOptions}
            onChangeText={setNewFieldOptions}
            placeholder="Cash, bKash, Card, Nagad"
          />
        ) : null}
        <Button size="compact" label="Add column" onPress={() => void addField()} />

        {fields.length > 0 ? (
          <View style={{ marginTop: space.md, gap: space.xs }}>
            <Text style={[typography.secondary, { fontWeight: '600', color: c.text }]}>Active columns for this sheet:</Text>
            {fields.map((f) => (
              <View key={f.id} style={{ flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', justifyContent: 'space-between', gap: 6, paddingVertical: 4 }}>
                <Text style={[typography.secondary, { color: c.text, flexShrink: 1 }]}>
                  • {f.name} <Text style={{ color: c.sub }}>- {f.type}{f.options.length ? ` - ${f.options.join(', ')}` : ''}</Text>
                </Text>
                <Button
                  size="compact"
                  kind="danger"
                  label="Remove"
                  onPress={() => void app.deleteDailyExpenseField(f.id)}
                  style={compact ? { width: '100%' } : undefined}
                />
              </View>
            ))}
          </View>
        ) : null}
      </Card>

      <Card>
        <SectionTitle>Filter and export</SectionTitle>

        <View style={{ gap: space.xs, marginBottom: space.sm }}>
          <Text style={[typography.secondary, { fontWeight: '600', color: c.text }]}>Date range presets:</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {(['all', 'this_month', 'last_7_days', 'last_30_days'] as const).map((pr) => {
              const labels: Record<RangePreset, string> = {
                all: 'All dates',
                this_month: 'This month',
                last_7_days: 'Last 7 days',
                last_30_days: 'Last 30 days',
              };
              const isSelected = rangePreset === pr;
              return (
                <Pressable
                  key={pr}
                  accessibilityRole="button"
                  accessibilityLabel={`Filter ${labels[pr]}`}
                  onPress={() => applyRangePreset(pr)}
                  style={[
                    {
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: radiusSm,
                      borderWidth: 1,
                      borderColor: isSelected ? c.primary : c.border,
                      backgroundColor: isSelected ? c.primary : c.chip,
                    },
                  ]}
                >
                  <Text style={[typography.caption, { color: isSelected ? c.onPrimary : c.text, fontWeight: isSelected ? '700' : '500' }]}>
                    {labels[pr]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Field label="From" value={from} onChangeText={setFrom} placeholder="YYYY-MM-DD" />
            <Button
              size="compact"
              kind="secondary"
              label={showFromPicker ? 'Hide ▲' : '📅 Calendar'}
              onPress={() => { setShowToPicker(false); setShowFromPicker((v) => !v); }}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="To" value={to} onChangeText={setTo} placeholder="YYYY-MM-DD" />
            <Button
              size="compact"
              kind="secondary"
              label={showToPicker ? 'Hide ▲' : '📅 Calendar'}
              onPress={() => { setShowFromPicker(false); setShowToPicker((v) => !v); }}
            />
          </View>
        </View>
        {/* Full width below the row: inside a half-width column the month grid is too narrow on phones. */}
        {showFromPicker ? (
          <CalendarPicker
            value={from}
            today={app.today}
            onChange={(p) => { setFrom(p); setShowFromPicker(false); setRangePreset('all'); }}
            onClose={() => setShowFromPicker(false)}
          />
        ) : null}
        {showToPicker ? (
          <CalendarPicker
            value={to}
            today={app.today}
            onChange={(p) => { setTo(p); setShowToPicker(false); setRangePreset('all'); }}
            onClose={() => setShowToPicker(false)}
          />
        ) : null}

        <View style={{ marginTop: space.md }}>
          <Field
            label="Search by place, note or custom value"
            value={query}
            onChangeText={setQuery}
            placeholder="Filter by keyword…"
          />
        </View>

        <Text style={[typography.cardTitle, { color: c.text, marginVertical: space.sm }]}>
          Totals: {totalByCurrency.map(([key, value]) => formatMoney(value, key)).join(' / ') || '—'}
          <Text style={[typography.secondary, { color: c.sub, fontWeight: '400' }]}> - {entries.length} entries</Text>
        </Text>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Button size="compact" label="Export CSV" style={{ flexGrow: 1, minWidth: 120 }} onPress={() => void exportCsv()} />
          <Button size="compact" label={busy ? 'Working…' : 'Export Excel'} style={{ flexGrow: 1, minWidth: 120 }} onPress={() => void exportFile('excel')} disabled={busy} />
          <Button size="compact" label={busy ? 'Working…' : 'Export PDF'} style={{ flexGrow: 1, minWidth: 120 }} onPress={() => void exportFile('pdf')} disabled={busy} />
          <Button size="compact" kind="secondary" label={busy ? 'Working…' : 'Import CSV or Excel'} style={{ flexGrow: 1, minWidth: 160 }} onPress={() => void importFile()} disabled={busy} />
        </View>

        {preview ? (
          <View style={{ marginTop: space.md, gap: 8 }}>
            <Text style={[typography.secondary, { color: c.text }]}>
              Preview: {preview.filter((row) => row.entry).length} valid, {preview.filter((row) => row.error).length} invalid, {preview.filter((row) => row.duplicate).length} duplicate.
            </Text>
            <Button size="compact" kind="secondary" label={includeDuplicates ? 'Duplicates included' : 'Skip duplicates'} onPress={() => setIncludeDuplicates((value) => !value)} />
            <Button label="Import preview" onPress={() => void importPreview()} />
          </View>
        ) : null}
      </Card>

      {groupedEntries.length === 0 ? (
        <EmptyState title="No daily entries found" hint="Try adjusting your date range or search query, or add an entry above." />
      ) : (
        groupedEntries.map(([groupDate, group]) => {
          const totals = new Map<string, number>();
          for (const entry of group) totals.set(entry.currency, (totals.get(entry.currency) ?? 0) + entry.amountMinor);
          return (
            <View key={groupDate} style={{ gap: 8 }}>
              <SectionTitle>{groupDate}</SectionTitle>
              {group.map((entry) => (
                <Card key={entry.id}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={[typography.cardTitle, { color: c.text }]}>{entry.category}</Text>
                      <Text style={[typography.secondary, { color: c.sub }]}>{formatMoney(entry.amountMinor, entry.currency)}</Text>
                      {entry.note ? (
                        <Text style={[typography.caption, { color: c.sub, fontStyle: 'italic', marginTop: 2 }]}>
                          Note: {entry.note}
                        </Text>
                      ) : null}
                      {fields.map((field) =>
                        entry.customValues[field.id] ? (
                          <Text key={field.id} style={[typography.caption, { color: c.sub }]}>
                            {field.name}: {entry.customValues[field.id]}
                          </Text>
                        ) : null
                      )}
                    </View>
                    <View style={{ gap: 4 }}>
                      <Button size="compact" label="Edit" onPress={() => editEntry(entry)} />
                      <Button size="compact" kind="danger" label="Delete" onPress={() => void app.deleteDailyExpenseEntry(entry.id)} />
                    </View>
                  </View>
                  <ReceiptAttachments recordType="daily_expense" recordId={entry.id} />
                </Card>
              ))}
              <Text style={[typography.cardTitle, { color: c.primary, textAlign: 'right' }]}>
                Total for {groupDate}: {[...totals.entries()].map(([key, value]) => formatMoney(value, key)).join(' / ')}
              </Text>
            </View>
          );
        })
      )}
    </View>
  );
}
