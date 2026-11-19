import { buildDebtReminderText, normalizeWhatsAppNumber, whatsappLink } from '../src/domain/debts';
import { normalizeWhatsAppNumber as normalizeFromKhata, whatsappLink as linkFromKhata } from '../src/domain/khata';

describe('WhatsApp reminder link number format', () => {
  // WhatsApp Click-to-Chat documentation verified 2026-11-09:
  // Format: https://wa.me/<number> where <number> is in international format
  // omitting zeroes (leading 00), plus signs (+), brackets, or dashes.

  describe('normalizeWhatsAppNumber', () => {
    // Six cases:
    it('converts Bangladesh local number with hyphen 01712-345678 to 8801712345678', () => {
      expect(normalizeWhatsAppNumber('01712-345678')).toBe('8801712345678');
      expect(normalizeFromKhata('01712-345678')).toBe('8801712345678');
    });

    it('converts clean 11-digit Bangladesh local number 01812345678 to 8801812345678', () => {
      expect(normalizeWhatsAppNumber('01812345678')).toBe('8801812345678');
    });

    it('strips leading + and hyphens when country code +8801712-345678 is already present', () => {
      expect(normalizeWhatsAppNumber('+8801712-345678')).toBe('8801712345678');
    });

    it('strips leading 00 international prefix from 008801712345678', () => {
      expect(normalizeWhatsAppNumber('008801712345678')).toBe('8801712345678');
    });

    it('strips leading 00 and hyphens from other international numbers like 001-555-123-4567', () => {
      expect(normalizeWhatsAppNumber('001-555-123-4567')).toBe('15551234567');
    });

    it('leaves other international numbers like +44 7123 456789 unchanged except non-digits stripped', () => {
      expect(normalizeWhatsAppNumber('+44 7123 456789')).toBe('447123456789');
    });

    it('handles empty and whitespace-only strings', () => {
      expect(normalizeWhatsAppNumber('')).toBe('');
      expect(normalizeWhatsAppNumber('   ')).toBe('');
      expect(normalizeWhatsAppNumber('---')).toBe('');
    });
  });

  describe('whatsappLink', () => {
    it('builds wa.me link with normalized Bangladesh number', () => {
      expect(whatsappLink('01712-345678')).toBe('https://wa.me/8801712345678');
      expect(linkFromKhata('01712-345678')).toBe('https://wa.me/8801712345678');
    });

    it('appends encoded pre-filled text query parameter when provided', () => {
      const link = whatsappLink('01712-345678', 'Payment reminder: 500 BDT');
      expect(link).toBe('https://wa.me/8801712345678?text=Payment%20reminder%3A%20500%20BDT');
    });

    it('handles Bengali unicode text in pre-filled message correctly', () => {
      const link = whatsappLink('01712-345678', 'বাকি পরিশোধের তাগিদ');
      expect(link).toBe(`https://wa.me/8801712345678?text=${encodeURIComponent('বাকি পরিশোধের তাগিদ')}`);
    });

    it('returns empty string when phone has no valid digits', () => {
      expect(whatsappLink('')).toBe('');
      expect(whatsappLink('invalid-number')).toBe('');
    });
  });

  describe('buildDebtReminderText (Direction and Localization safety)', () => {
    it('creates neutral, polite payment request message when owed_to_me (Bengali)', () => {
      const text = buildDebtReminderText({
        person: 'Rahim',
        direction: 'owed_to_me',
        amountMinor: 50000,
        currency: 'BDT',
        lang: 'bn',
      });
      expect(text).toContain('Rahim');
      expect(text).toContain('বাকি রয়েছে');
      expect(text).toContain('শুভেচ্ছা');
      expect(text).not.toContain('আসসালামু আলাইকুম');
      expect(text).not.toContain('আমার পরিশোধ করা বাকি');
    });

    it('creates neutral, polite repayment acknowledgement message when i_owe (Bengali)', () => {
      const text = buildDebtReminderText({
        person: 'Karim',
        direction: 'i_owe',
        amountMinor: 25000,
        currency: 'BDT',
        lang: 'bn',
      });
      expect(text).toContain('Karim');
      expect(text).toContain('আমার পরিশোধ করা বাকি রয়েছে');
      expect(text).toContain('শুভেচ্ছা');
      expect(text).not.toContain('আসসালামু আলাইকুম');
      expect(text).not.toContain('ইনশাআল্লাহ');
      expect(text).not.toContain('আপনার কাছে');
    });

    it('creates neutral, polite English message for owed_to_me vs i_owe without inversion', () => {
      const owedText = buildDebtReminderText({
        person: 'Alice',
        direction: 'owed_to_me',
        amountMinor: 10000,
        currency: 'USD',
        lang: 'en',
      });
      expect(owedText).toContain('Alice');
      expect(owedText).toContain('owed to me');
      expect(owedText).toContain('Greetings');

      const iOweText = buildDebtReminderText({
        person: 'Bob',
        direction: 'i_owe',
        amountMinor: 15000,
        currency: 'USD',
        lang: 'en',
      });
      expect(iOweText).toContain('Bob');
      expect(iOweText).toContain('to pay you');
      expect(iOweText).toContain('Greetings');
    });
  });
});
