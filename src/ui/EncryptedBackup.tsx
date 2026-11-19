import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { DEFAULT_KDF_TIMEOUT_MS, MIN_PASSPHRASE_CHARS, passphraseLength } from '../crypto/backup';
import type { AppData } from '../domain/types';
import { exportTextFile, pickTextFile } from '../services/files';
import { systemRandom } from '../services/random';
import { createEncryptedBackup, unlockEncryptedBackup, isEncryptedBackupText } from '../storage/backup';
import { parseData } from '../storage/repository';
import { Banner, Button, Card, Field, ProgressBar } from './components';
import { useTheme } from './theme';

const pwProps = { autoCapitalize: 'none', autoCorrect: false, spellCheck: false, autoComplete: 'off', importantForAutofill: 'no', maxLength: 200 } as const;

export type PassphraseStrength = 'too_short' | 'fair' | 'good' | 'strong';

export interface PassphraseHint {
  strength: PassphraseStrength;
  text: string;
}

export function VerifyBackup() {
  const [text, setText] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function choose() {
    const picked = await pickTextFile();
    if (picked !== null) {
      setText(picked);
      setPassphrase('');
      setResult(null);
    }
  }

  async function verify() {
    if (!text || busy) return;
    setBusy(true);
    try {
      const unlocked = isEncryptedBackupText(text)
        ? await unlockEncryptedBackup(text, passphrase)
        : parseData(text);
      if (!unlocked.ok) {
        setResult({ ok: false, message: 'message' in unlocked ? unlocked.message : unlocked.error });
        return;
      }
      const backupData = unlocked.data;
      setResult({
        ok: true,
        message: `Verified without changing current data - schema ${backupData.schemaVersion}, ${backupData.tasks.length} tasks, ${backupData.expenses.length} expenses, ${backupData.dailyExpenseEntries.length} daily entries, ${backupData.receiptAttachments.length} receipts.`,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <Button kind="secondary" label="Verify a backup - no restore" onPress={() => void choose()} />
      {text && isEncryptedBackupText(text) ? (
        <Field label="Backup passphrase" value={passphrase} onChangeText={setPassphrase} secureTextEntry />
      ) : null}
      {text ? <Button label={busy ? 'Verifying...' : 'Verify selected backup'} disabled={busy} onPress={() => void verify()} /> : null}
      {result ? <Banner tone={result.ok ? 'info' : 'danger'} text={result.message} /> : null}
    </View>
  );
}

/**
 * Strength hint from length and character variety. It's advice only: any passphrase of
 * MIN_PASSPHRASE_CHARS or more is accepted, whatever the hint says.
 */
export function getPassphraseStrength(pass: string): PassphraseHint {
  const len = passphraseLength(pass);
  if (len < MIN_PASSPHRASE_CHARS) {
    return {
      strength: 'too_short',
      text: `Minimum ${MIN_PASSPHRASE_CHARS} characters required - ${len} of ${MIN_PASSPHRASE_CHARS}.`,
    };
  }

  // Count distinct words / segments (space, hyphen, underscore separated)
  const words = pass.trim().split(/[\s\-_]+/).filter(Boolean);
  const hasLetters = /\p{L}/u.test(pass);
  const hasDigits = /\p{N}/u.test(pass);
  const hasSymbols = /[^\p{L}\p{N}\s]/u.test(pass);
  const varietyCount = (hasLetters ? 1 : 0) + (hasDigits ? 1 : 0) + (hasSymbols ? 1 : 0);

  if (len >= 24 || (words.length >= 4 && len >= 16)) {
    return {
      strength: 'strong',
      text: 'Strong passphrase: excellent length and entropy.',
    };
  }

  if (len >= 16 || (words.length >= 3 && varietyCount >= 2)) {
    return {
      strength: 'good',
      text: 'Good passphrase: several random words or varied characters work well.',
    };
  }

  return {
    strength: 'fair',
    text: 'Acceptable length: adding more random words or symbols makes it even harder to guess.',
  };
}

/**
 * Checks the length, that both entries match, and that the user confirmed the passphrase can't be recovered.
 */
export function validatePassphraseForCreation(
  pass: string,
  pass2: string,
  ack: boolean
): { ok: true } | { ok: false; error: string } {
  if (passphraseLength(pass) < MIN_PASSPHRASE_CHARS) {
    return { ok: false, error: `Use at least ${MIN_PASSPHRASE_CHARS} characters - a few random words work well.` };
  }
  if (pass !== pass2) {
    return { ok: false, error: 'The two passphrases do not match.' };
  }
  if (!ack) {
    return { ok: false, error: 'Please confirm that you understand the passphrase cannot be recovered.' };
  }
  return { ok: true };
}

/** Passphrase-protected export. The passphrase lives only in this component's state and is cleared afterwards. */
export function CreateEncryptedBackup({ data, today, onDone }: { data: AppData; today: string; onDone: (m: { tone: 'info' | 'danger'; text: string }) => void }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'encrypting' | 'saving'>('idle');
  const [cancelling, setCancelling] = useState(false);
  const busyRef = useRef(false); // blocks a double-tap while the key is being derived
  const cancelRequestedRef = useRef(false);

  const reset = () => {
    setPass('');
    setPass2('');
    setShowPass(false);
    setAck(false);
    setError(null);
    setProgress(0);
    setOpen(false);
  };

  function cancelOrClose() {
    if (phase === 'encrypting') {
      cancelRequestedRef.current = true;
      setCancelling(true);
    } else reset();
  }

  async function submit() {
    if (busyRef.current) return;
    const v = validatePassphraseForCreation(pass, pass2, ack);
    if (!v.ok) return setError(v.error);
    cancelRequestedRef.current = false;
    setCancelling(false);
    busyRef.current = true;
    setBusy(true);
    setPhase('encrypting');
    setError(null);
    setProgress(0);
    try {
      const file = await createEncryptedBackup(data, pass, {
        random: systemRandom,
        onProgress: setProgress,
        shouldCancel: () => cancelRequestedRef.current,
        timeoutMs: DEFAULT_KDF_TIMEOUT_MS,
      });
      if (cancelRequestedRef.current) throw new Error('Backup creation cancelled; no file was shared.');
      setPhase('saving');
      await exportTextFile(`personal-assistant-encrypted-backup-${today}.json`, file, 'application/json', { moveBeforeShare: true });
      reset();
      onDone({ tone: 'info', text: 'Encrypted backup created. Keep the passphrase safe: without it the file cannot be opened and Personal Assistant cannot recover it.' });
    } catch (e) {
      // Never fall back to plaintext; report the failure without exposing secrets.
      setError(e instanceof Error ? e.message : 'Encrypted backup could not be completed.');
    } finally {
      busyRef.current = false;
      setBusy(false);
      setPhase('idle');
      setCancelling(false);
      cancelRequestedRef.current = false;
      setPass('');
      setPass2('');
    }
  }

  const hint = getPassphraseStrength(pass);

  if (!open) return <Button label="Create encrypted backup" onPress={() => setOpen(true)} />;
  return (
    <Card style={{ marginBottom: 0 }}>
      <Text accessibilityRole="header" style={{ color: c.text, fontWeight: '800', fontSize: 16, marginBottom: 6 }}>Encrypted backup</Text>
      <Text style={{ color: c.sub, fontSize: 14, marginBottom: 8 }}>
        Your data is encrypted on this device with your passphrase (AES-256-GCM, key from scrypt) before it is saved to a file. The passphrase is never stored or sent anywhere.
      </Text>
      <Text style={{ color: c.sub, fontSize: 13, marginBottom: 10, lineHeight: 18 }}>
        • Making the key usually takes 5 to 30 seconds on a phone, and up to a minute in a development build.
        {'\n'}• Attempt note: Checking each passphrase runs full key derivation. A wrong passphrase takes just as long as the right one.
        {'\n'}• No recovery: If forgotten, this backup cannot be recovered or reset by anyone.
      </Text>
      <Field
        label={`Passphrase - minimum ${MIN_PASSPHRASE_CHARS} characters`}
        value={pass}
        onChangeText={setPass}
        {...pwProps}
        secureTextEntry={!showPass}
      />
      {pass.length > 0 ? (
        <Text
          style={{
            color: hint.strength === 'too_short' ? c.sub : hint.strength === 'strong' ? c.primary : c.text,
            fontSize: 13,
            marginTop: -8,
            marginBottom: 10,
          }}
        >
          {hint.text}
        </Text>
      ) : null}
      <Field
        label="Repeat passphrase"
        value={pass2}
        onChangeText={setPass2}
        {...pwProps}
        secureTextEntry={!showPass}
      />
      {pass2.length > 0 && pass !== pass2 ? (
        <Text style={{ color: c.danger, fontSize: 13, marginTop: -8, marginBottom: 10 }}>
          The two passphrases do not match.
        </Text>
      ) : null}
      <View style={{ marginBottom: 12 }}>
        <Button
          kind="secondary"
          label={showPass ? 'Hide passphrases' : 'Show passphrases'}
          onPress={() => setShowPass((v) => !v)}
        />
      </View>
      <Banner tone="warn" text="If you forget this passphrase the backup is permanently unreadable. Personal Assistant has no recovery service and cannot reset it. Anyone who guesses a weak passphrase can open the file, so use a long one." />
      <View style={{ height: 8 }} />
      <Button kind="secondary" label={ack ? '✓ I understand it cannot be recovered' : 'I understand it cannot be recovered'} onPress={() => setAck((v) => !v)} />
      {error ? <Text accessibilityRole="alert" style={{ color: c.danger, marginTop: 8 }}>{error}</Text> : null}
      {busy ? (
        <View style={{ marginTop: 10 }}>
          <Text style={{ color: c.sub, fontSize: 14, marginBottom: 6 }}>
            {phase === 'encrypting'
              ? `Encrypting… key derivation stops after ${Math.round(DEFAULT_KDF_TIMEOUT_MS / 1000)} seconds. Keep Personal Assistant in the foreground; switching apps may pause or interrupt the operation. If no success message appears, try again.`
              : 'Saving the completed backup before opening the share sheet…'}
          </Text>
          <ProgressBar pct={Math.round(progress * 100)} label="Encryption progress" />
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        <Button label={busy ? 'Working…' : 'Create backup file'} disabled={busy} onPress={submit} style={{ flex: 1 }} />
        <Button kind="secondary" label={cancelling ? 'Cancelling…' : 'Cancel'} disabled={cancelling || (busy && phase !== 'encrypting')} onPress={cancelOrClose} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}

/** Asks for the passphrase of an encrypted backup. Decrypting never touches stored data; the caller reviews first. */
export function UnlockBackup({ text, onUnlocked, onCancel }: { text: string; onUnlocked: (d: AppData) => void; onCancel: () => void }) {
  const { c } = useTheme();
  const [pass, setPass] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const busyRef = useRef(false);
  const cancelRequestedRef = useRef(false);

  function cancelOrClose() {
    if (busy) {
      cancelRequestedRef.current = true;
      setCancelling(true);
    } else {
      setPass('');
      setShowPass(false);
      onCancel();
    }
  }

  async function unlock() {
    if (busyRef.current) return;
    cancelRequestedRef.current = false;
    setCancelling(false);
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      const r = await unlockEncryptedBackup(text, pass, {
        onProgress: setProgress,
        shouldCancel: () => cancelRequestedRef.current,
        timeoutMs: DEFAULT_KDF_TIMEOUT_MS,
      });
      if (cancelRequestedRef.current) {
        setError('Unlock cancelled.');
        return;
      }
      if (r.ok) {
        setPass('');
        setShowPass(false);
        onUnlocked(r.data);
      } else {
        setError(r.message);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      setCancelling(false);
      cancelRequestedRef.current = false;
    }
  }

  return (
    <Card>
      <Text accessibilityRole="header" style={{ color: c.text, fontWeight: '800', marginBottom: 4 }}>Encrypted backup found</Text>
      <Text style={{ color: c.sub, fontSize: 14, marginBottom: 8 }}>Enter its passphrase to unlock it. Nothing on this device changes until you review the contents and confirm.</Text>
      <Text style={{ color: c.sub, fontSize: 13, marginBottom: 10, lineHeight: 18 }}>
        • Making the key usually takes 5 to 30 seconds on a phone, and up to a minute in a development build.
        {'\n'}• Attempt note: Every attempt requires full derivation. A wrong passphrase takes just as long to fail as a correct one. Check for typos before unlocking.
        {'\n'}• No recovery: Personal Assistant has no backdoor, reset link, or recovery service.
      </Text>
      <Field
        label="Backup passphrase"
        value={pass}
        onChangeText={setPass}
        {...pwProps}
        secureTextEntry={!showPass}
      />
      <View style={{ marginBottom: 12 }}>
        <Button
          kind="secondary"
          label={showPass ? 'Hide passphrase' : 'Show passphrase'}
          onPress={() => setShowPass((v) => !v)}
        />
      </View>
      {error ? <Text accessibilityRole="alert" style={{ color: c.danger, marginBottom: 8 }}>{error}</Text> : null}
      {busy ? (
        <View style={{ marginBottom: 10 }}>
          <Text style={{ color: c.sub, fontSize: 14, marginBottom: 6 }}>
            Unlocking… key derivation stops after {Math.round(DEFAULT_KDF_TIMEOUT_MS / 1000)} seconds. Keep Personal Assistant in the foreground; switching apps may pause or interrupt the operation. If no success message appears, try again.
          </Text>
          <ProgressBar pct={Math.round(progress * 100)} label="Unlock progress" />
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label={busy ? 'Unlocking…' : 'Unlock'} disabled={busy || !pass} onPress={unlock} style={{ flex: 1 }} />
        <Button kind="secondary" label={cancelling ? 'Cancelling…' : 'Cancel'} disabled={cancelling} onPress={cancelOrClose} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}
