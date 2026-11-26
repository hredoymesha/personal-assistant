import { useState } from 'react';
import { Text, View } from 'react-native';
import { notify } from './notify';
import { base64Encode } from '../crypto/bytes';
import type { ReceiptRecordType } from '../domain/types';
import { pickReceiptFile } from '../services/files';
import { useApp } from '../state/AppProvider';
import { Button, Card } from './components';
import { type as typography, useTheme } from './theme';

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export function ReceiptAttachments({ recordType, recordId }: { recordType: ReceiptRecordType; recordId: string }) {
  const { c } = useTheme();
  const { data, addReceipt, deleteReceipt } = useApp();
  const [busy, setBusy] = useState(false);
  const receipts = data.receiptAttachments.filter((receipt) => receipt.recordType === recordType && receipt.recordId === recordId);

  async function attach() {
    if (busy) return;
    setBusy(true);
    try {
      const picked = await pickReceiptFile();
      if (!picked) return;
      if (picked.bytes.byteLength > MAX_RECEIPT_BYTES) throw new Error('Receipt files must be 10 MB or smaller.');
      const error = await addReceipt({
        recordType,
        recordId,
        fileName: picked.name,
        mimeType: picked.mimeType,
        sizeBytes: picked.bytes.byteLength,
        dataBase64: base64Encode(picked.bytes),
      });
      if (error) notify('Receipt not attached', error);
    } catch (error) {
      notify('Receipt not attached', error instanceof Error ? error.message : 'Could not read the selected file.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Text style={[typography.cardTitle, { color: c.text, marginBottom: 8 }]}>Receipts</Text>
      {receipts.map((receipt) => (
        <View key={receipt.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
          <Text numberOfLines={1} style={{ color: c.sub, flex: 1 }}>{receipt.fileName} - {Math.ceil(receipt.sizeBytes / 1024)} KB</Text>
          <Button label="Remove" kind="danger" size="compact" onPress={() => void deleteReceipt(receipt.id)} />
        </View>
      ))}
      <Button
        label={busy ? 'Reading receipt...' : 'Attach receipt'}
        size="compact"
        disabled={busy}
        onPress={() => void attach()}
        style={{ width: '100%' }}
      />
      <Text style={[typography.caption, { color: c.sub, width: '100%', flexShrink: 1, marginTop: 8 }]}>
        Local only. Images and PDF files up to 10 MB each.
      </Text>
    </Card>
  );
}
