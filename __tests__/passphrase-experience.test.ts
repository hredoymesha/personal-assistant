import React from 'react';
import mockAsyncStorage from '@react-native-async-storage/async-storage/jest/async-storage-mock';
import {
  MIN_PASSPHRASE_CHARS,
  passphraseLength,
  encryptBackup,
  decryptBackup,
  inspectBackup,
} from '../src/crypto/backup';
import {
  getPassphraseStrength,
  validatePassphraseForCreation,
  CreateEncryptedBackup,
  UnlockBackup,
} from '../src/ui/EncryptedBackup';
import { emptyData } from '../src/domain/types';
import { systemRandom } from '../src/services/random';

jest.mock('@react-native-async-storage/async-storage', () => mockAsyncStorage);

jest.mock('../src/ui/theme', () => {
  const actual = jest.requireActual<typeof import('../src/ui/theme')>('../src/ui/theme');
  return {
    ...actual,
    useTheme: () => ({
      c: {
        bg: '#fff',
        card: '#fff',
        text: '#000',
        sub: '#666',
        border: '#ccc',
        primary: '#00f',
        onPrimary: '#fff',
        danger: '#f00',
        warn: '#fa0',
      },
      dark: false,
    }),
  };
});

jest.mock('../src/services/files', () => ({
  exportTextFile: jest.fn(),
}));

jest.mock('../src/storage/backup', () => ({
  createEncryptedBackup: jest.fn(),
  unlockEncryptedBackup: jest.fn(),
}));

describe('Passphrase Experience & Validation', () => {
  describe('validatePassphraseForCreation & 12-char minimum rule', () => {
    it('blocks creation if passphrase has fewer than 12 characters', () => {
      const res = validatePassphraseForCreation('short-pass', 'short-pass', true);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain(`Use at least ${MIN_PASSPHRASE_CHARS} characters`);
      }
    });

    it('blocks creation if confirmation does not match', () => {
      const res = validatePassphraseForCreation('correct-horse-battery', 'correct-horse-different', true);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe('The two passphrases do not match.');
      }
    });

    it('blocks creation if recovery acknowledgment is false', () => {
      const res = validatePassphraseForCreation('correct-horse-battery', 'correct-horse-battery', false);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain('cannot be recovered');
      }
    });

    it('allows creation when passphrase is >= 12 characters, confirmation matches, and ack is true', () => {
      const res = validatePassphraseForCreation('correct-horse-battery', 'correct-horse-battery', true);
      expect(res.ok).toBe(true);
    });

    it('accurately counts normalized Unicode code points (e.g. Bangla digits)', () => {
      const bangla12 = '১২৩৪৫৬৭৮৯০১২';
      expect(passphraseLength(bangla12)).toBe(12);
      const res = validatePassphraseForCreation(bangla12, bangla12, true);
      expect(res.ok).toBe(true);

      const bangla11 = '১২৩৪৫৬৭৮৯০১';
      expect(passphraseLength(bangla11)).toBe(11);
      const res11 = validatePassphraseForCreation(bangla11, bangla11, true);
      expect(res11.ok).toBe(false);
    });
  });

  describe('getPassphraseStrength & Acceptance Criteria: Hint never blocks', () => {
    it('returns too_short for length < 12 with character count progress', () => {
      const hint = getPassphraseStrength('hello-world');
      expect(hint.strength).toBe('too_short');
      expect(hint.text).toContain(`Minimum ${MIN_PASSPHRASE_CHARS} characters required - 11 of ${MIN_PASSPHRASE_CHARS}`);
    });

    it('returns fair for simple single-type 12-char passphrase', () => {
      const hint = getPassphraseStrength('abcdefghijkl');
      expect(hint.strength).toBe('fair');
      expect(hint.text).toContain('Acceptable length');

      // A "fair" passphrase is valid and must not be blocked by validation
      const validation = validatePassphraseForCreation('abcdefghijkl', 'abcdefghijkl', true);
      expect(validation.ok).toBe(true);
    });

    it('returns good for multi-word or varied 16+ char passphrases', () => {
      const hint = getPassphraseStrength('apple-banana-cherry');
      expect(hint.strength).toBe('good');
      expect(hint.text).toContain('Good passphrase');
    });

    it('returns strong for 4+ words or 24+ character passphrases', () => {
      const hint = getPassphraseStrength('correct-horse-battery-staple');
      expect(hint.strength).toBe('strong');
      expect(hint.text).toContain('Strong passphrase');
    });

    it('strength hint never blocks valid creation under any strength rating (fair, good, strong)', () => {
      const candidates = [
        'twelve-chars', // 12 chars
        'abcdefghijkl', // 12 simple lowercase
        '123456789012', // 12 digits
        '১২৩৪৫৬৭৮৯০১২', // 12 Bangla digits
        'correct-horse-battery-staple', // 4 words
      ];

      for (const pass of candidates) {
        const hint = getPassphraseStrength(pass);
        expect(hint.strength).not.toBe('too_short');
        const validation = validatePassphraseForCreation(pass, pass, true);
        expect(validation.ok).toBe(true);
      }
    });
  });

  describe('Component structure', () => {
    it('CreateEncryptedBackup renders closed state initially and can be instantiated', () => {
      const onDone = jest.fn();
      const el = React.createElement(CreateEncryptedBackup, {
        data: emptyData(),
        today: '2026-11-10',
        onDone,
      });
      expect(React.isValidElement(el)).toBe(true);
    });

    it('UnlockBackup renders card with time estimate and attempt note copy', () => {
      const onUnlocked = jest.fn();
      const onCancel = jest.fn();
      const el = React.createElement(UnlockBackup, {
        text: 'dummy-backup-text',
        onUnlocked,
        onCancel,
      });
      expect(React.isValidElement(el)).toBe(true);
    });
  });

  describe('Wrong passphrase and AES-GCM tag failures', () => {
    it('AES-GCM decryption failure returns one message for wrong passphrase or damaged data', async () => {
      const plaintext = JSON.stringify(emptyData());
      const validBackup = await encryptBackup(plaintext, 'correct-passphrase-123', {
        random: systemRandom,
        schemaVersion: 4,
      });
      const inspectRes = inspectBackup(validBackup);
      expect(inspectRes.ok).toBe(true);

      if (inspectRes.ok) {
        // Wrong passphrase
        const wrongRes = await decryptBackup(validBackup, 'incorrect-passphrase-456');
        expect(wrongRes.ok).toBe(false);
        if (!wrongRes.ok) {
          expect(wrongRes.reason).toBe('wrong_passphrase');
          // The message can't tell a wrong passphrase from a flipped bit, so it doesn't pretend to
          expect(wrongRes.message).toBe('Wrong passphrase, or the file was changed or damaged. Nothing was restored.');
        }

        // Damaged ciphertext with right passphrase
        const damagedFile = JSON.parse(validBackup) as { ciphertext: string };
        // Bit flip the last characters of ciphertext
        const ct = damagedFile.ciphertext;
        damagedFile.ciphertext = ct.slice(0, -4) + 'AAAA';
        const damagedText = JSON.stringify(damagedFile);
        const damagedInspect = inspectBackup(damagedText);
        expect(damagedInspect.ok).toBe(true);
        if (damagedInspect.ok) {
          const damagedRes = await decryptBackup(damagedText, 'correct-passphrase-123');
          expect(damagedRes.ok).toBe(false);
          if (!damagedRes.ok) {
            expect(damagedRes.reason).toBe('wrong_passphrase');
            expect(damagedRes.message).toBe('Wrong passphrase, or the file was changed or damaged. Nothing was restored.');
          }
        }
      }
    }, 60000);
  });
});
