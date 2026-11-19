import { emptyData, SCHEMA_VERSION } from '../src/domain/types';
import { validateReceiptAttachment, validateAppData } from '../src/domain/validation';
import { migrate } from '../src/storage/migrations';

describe('receipt attachments', () => {
  const receipt = {
    id: 'receipt-1',
    recordType: 'expense' as const,
    recordId: 'expense-1',
    fileName: 'lunch.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    dataBase64: 'AQID',
    createdAt: '2026-11-14T00:00:00.000Z',
  };

  it('accepts a valid receipt and rejects files over 10 MB', () => {
    expect(validateReceiptAttachment(receipt).ok).toBe(true);
    expect(validateReceiptAttachment({ ...receipt, sizeBytes: 10 * 1024 * 1024 + 1 }).ok).toBe(false);
  });

  it('keeps receipt data in the validated app document', () => {
    const result = validateAppData({ ...emptyData(), receiptAttachments: [receipt] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.receiptAttachments).toHaveLength(1);
  });

  it('adds an empty receipt collection when migrating schema 9 data', () => {
    const result = migrate({ ...emptyData(), schemaVersion: 9, receiptAttachments: undefined });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.schemaVersion).toBe(SCHEMA_VERSION);
      expect(result.data.receiptAttachments).toEqual([]);
    }
  });
});
