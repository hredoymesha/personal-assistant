import React, { useMemo, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Linking from 'expo-linking';
import { buildDebtReminderText, normalizeWhatsAppNumber, whatsappLink } from '../domain/debts';
import { formatMoney } from '../domain/money';
import type { Debt, SyncedContact } from '../domain/types';
import { Button, Card, Field, SectionTitle } from './components';
import { radius, space, type as typography, useTheme } from './theme';

export interface DebtReminderModalProps {
  debt: Debt;
  contacts: SyncedContact[];
  onClose: () => void;
}

export function DebtReminderModal({ debt, contacts, onClose }: DebtReminderModalProps) {
  const { c } = useTheme();
  const openMinor = Math.max(0, debt.amountMinor - debt.paidMinor);
  const formattedAmount = formatMoney(openMinor, debt.currency);

  // Match local contacts by exact case-insensitive full name
  const matchingContacts = useMemo(() => {
    const targetName = debt.person.trim().toLowerCase();
    if (!targetName) return [];
    return contacts.filter((c) => c.fullName.trim().toLowerCase() === targetName);
  }, [debt.person, contacts]);

  // Don't auto-select when several contacts share the name or the contact has several numbers.
  const initialPhone = useMemo(() => {
    if (matchingContacts.length === 1 && matchingContacts[0].phones.length === 1) {
      return matchingContacts[0].phones[0];
    }
    return '';
  }, [matchingContacts]);

  const [phone, setPhone] = useState(initialPhone);
  const [lang, setLang] = useState<'bn' | 'en'>('bn');
  const [editedText, setEditedText] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);

  // Current draft text
  const defaultText = useMemo(() => {
    return buildDebtReminderText({
      person: debt.person,
      direction: debt.direction,
      amountMinor: openMinor,
      currency: debt.currency,
      lang,
    });
  }, [debt.person, debt.direction, openMinor, debt.currency, lang]);

  const currentMessage = editedText ?? defaultText;
  const normalizedPhone = normalizeWhatsAppNumber(phone);
  const isPhoneValid = normalizedPhone.length >= 7;

  async function handleOpenWhatsApp() {
    setFeedback(null);
    if (!isPhoneValid) {
      setFeedback({ tone: 'danger', text: 'Please enter a valid phone number before opening WhatsApp.' });
      return;
    }
    const link = whatsappLink(normalizedPhone, currentMessage);
    try {
      const supported = await Linking.canOpenURL(link);
      if (!supported && Platform.OS !== 'web') {
        setFeedback({
          tone: 'danger',
          text: 'WhatsApp does not appear to be installed on this device. You can copy the message below instead.',
        });
        return;
      }
      await Linking.openURL(link);
      setFeedback({
        tone: 'info',
        text: 'WhatsApp was opened. Please review and send the message yourself in the chat.',
      });
    } catch (err) {
      setFeedback({
        tone: 'danger',
        text: err instanceof Error ? `Could not open WhatsApp: ${err.message}` : 'Could not open WhatsApp. Please copy the message below.',
      });
    }
  }

  async function handleCopy() {
    setFeedback(null);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(currentMessage);
        setFeedback({ tone: 'info', text: 'Message copied to clipboard.' });
        return;
      }
      // React Native clipboard fallback
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const rn = require('react-native');
      if (rn.Clipboard?.setString) {
        rn.Clipboard.setString(currentMessage);
        setFeedback({ tone: 'info', text: 'Message copied to clipboard.' });
        return;
      }
      setFeedback({ tone: 'info', text: 'Selected message text is ready above.' });
    } catch {
      setFeedback({ tone: 'danger', text: 'Could not access clipboard automatically. Please copy the text above.' });
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, { backgroundColor: 'rgba(0, 0, 0, 0.6)' }]}>
        <View style={[styles.container, { backgroundColor: c.card, borderColor: c.border }]}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            <View style={styles.headerRow}>
              <SectionTitle>Debt reminder</SectionTitle>
              <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={styles.closeBtn}>
                <Text style={{ color: c.sub, fontSize: 18, fontWeight: '700' }}>✕</Text>
              </Pressable>
            </View>

            <Card style={{ backgroundColor: c.bg, borderColor: c.border, marginBottom: space.md }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={[typography.body, { color: c.text, fontWeight: '700' }]}>{debt.person}</Text>
                <View style={[styles.badge, { backgroundColor: debt.direction === 'owed_to_me' ? '#DCFCE7' : '#FEF3C7' }]}>
                  <Text style={{ color: debt.direction === 'owed_to_me' ? '#166534' : '#92400E', fontSize: 12, fontWeight: '600' }}>
                    {debt.direction === 'owed_to_me' ? 'Owed to you' : 'You owe'}
                  </Text>
                </View>
              </View>
              <Text style={[typography.secondary, { color: c.sub, marginTop: 4 }]}>
                Outstanding balance: <Text style={{ color: c.text, fontWeight: '700' }}>{formattedAmount}</Text>
              </Text>
            </Card>

            <Field
              label="Recipient phone number"
              placeholder="e.g. 01712-345678 or +8801..."
              value={phone}
              onChangeText={(text) => {
                setPhone(text);
                setFeedback(null);
              }}
              keyboardType="phone-pad"
              error={phone.trim() && !isPhoneValid ? 'Please enter at least 7 digits in standard format.' : null}
            />

            {matchingContacts.length > 0 && (!initialPhone || matchingContacts[0].phones.length > 1) ? (
              <View style={{ marginBottom: space.md }}>
                <Text style={[typography.secondary, { color: c.sub, marginBottom: 4 }]}>Matching contacts found:</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {matchingContacts.flatMap((mc) =>
                    mc.phones.map((p, idx) => (
                      <Pressable
                        key={`${mc.id}-${idx}`}
                        onPress={() => setPhone(p)}
                        style={[styles.chip, { backgroundColor: phone === p ? c.primary : c.chip }]}>
                        <Text style={{ color: phone === p ? c.onPrimary : c.text, fontSize: 12 }}>
                          {mc.fullName}: {p}
                        </Text>
                      </Pressable>
                    )),
                  )}
                </View>
              </View>
            ) : null}

            <View style={{ marginBottom: space.md }}>
              <Text style={[typography.secondary, { color: c.sub, marginBottom: 6 }]}>Message Language:</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Pressable
                  onPress={() => {
                    setLang('bn');
                    setEditedText(null);
                  }}
                  style={[styles.chip, { backgroundColor: lang === 'bn' ? c.primary : c.chip }]}>
                  <Text style={{ color: lang === 'bn' ? c.onPrimary : c.text, fontWeight: '600' }}>বাংলা</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setLang('en');
                    setEditedText(null);
                  }}
                  style={[styles.chip, { backgroundColor: lang === 'en' ? c.primary : c.chip }]}>
                  <Text style={{ color: lang === 'en' ? c.onPrimary : c.text, fontWeight: '600' }}>English</Text>
                </Pressable>
              </View>
            </View>

            <Field
              label="Reminder message - editable"
              value={currentMessage}
              onChangeText={(text) => setEditedText(text)}
              multiline
              numberOfLines={4}
            />

            <View style={{ marginBottom: space.md }}>
              <Text style={[typography.secondary, { color: c.sub, marginBottom: 4, fontWeight: '600' }]}>
                Live Preview (WhatsApp chat draft):
              </Text>
              <View style={[styles.previewBox, { backgroundColor: c.bg, borderColor: c.border }]}>
                <Text style={{ color: c.sub, fontSize: 12, marginBottom: 4 }}>
                  To: <Text style={{ color: c.text, fontWeight: '600' }}>{isPhoneValid ? `+${normalizedPhone}` : 'No phone number'}</Text>
                </Text>
                <Text style={[typography.body, { color: c.text }]}>{currentMessage}</Text>
              </View>
            </View>

            {feedback ? (
              <View style={[styles.feedback, { backgroundColor: feedback.tone === 'danger' ? '#FEF2F2' : '#F0FDF4', borderColor: feedback.tone === 'danger' ? c.danger : c.success }]}>
                <Text style={{ color: feedback.tone === 'danger' ? c.danger : c.success, fontSize: 13 }}>
                  {feedback.text}
                </Text>
              </View>
            ) : null}

            <Text style={{ color: c.sub, fontSize: 12, marginBottom: space.lg, lineHeight: 16 }}>
              Opening WhatsApp prepares this draft in your chat. Personal Assistant does not send messages automatically and does not mark debts as paid.
            </Text>

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Button
                label="Open in WhatsApp"
                onPress={handleOpenWhatsApp}
                disabled={!isPhoneValid || openMinor <= 0}
                style={{ flex: 1 }}
              />
              <Button
                label="Copy message"
                kind="secondary"
                onPress={handleCopy}
                disabled={!currentMessage.trim()}
                style={{ flex: 1 }}
              />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: space.md,
  },
  container: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '90%',
    borderRadius: radius,
    borderWidth: 1,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  scroll: {
    padding: space.lg,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: space.sm,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  previewBox: {
    borderWidth: 1,
    borderRadius: 8,
    padding: space.md,
  },
  feedback: {
    borderWidth: 1,
    borderRadius: 8,
    padding: space.sm,
    marginBottom: space.md,
  },
});
