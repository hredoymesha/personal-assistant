import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MIN_TOUCH, radius, radiusSm, space, type as typography, useTheme } from './theme';
import { useApp } from '../state/AppProvider';

/** Centers content to a readable width on desktop browsers; full-width on phones. */
export function Screen({
  children,
  title,
  right,
  footer,
}: {
  children: React.ReactNode;
  title: string;
  right?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const { c } = useTheme();
  const { saveError, loadError } = useApp();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const compact = width < 420;
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <KeyboardAvoidingView
        style={s.keyboard}
        behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}>
        <ScrollView
          contentContainerStyle={[s.scroll, { paddingBottom: insets.bottom + 112 }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}>
          <View style={[s.col, compact && s.compactCol]}>
            <View style={s.header}>
              <Text accessibilityRole="header" style={[s.h1, s.h1Shrink, { color: c.text }]}>
                {title}
              </Text>
              {right}
            </View>
            {loadError ? (
              <Banner
                tone="danger"
                text={`Saved data could not be read - ${loadError}. A copy was kept aside; new changes start fresh.`}
              />
            ) : null}
            {saveError ? <Banner tone="danger" text={saveError} /> : null}
            {children}
          </View>
        </ScrollView>
        {footer}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const { c, isDark } = useTheme();
  const { width } = useWindowDimensions();
  const compact = width < 420;
  return (
    <View
      style={[
        s.card,
        compact && s.compactCard,
        {
          backgroundColor: c.card,
          borderColor: c.border,
          shadowColor: isDark ? '#000000' : '#0F172A',
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: isDark ? 0.25 : 0.04,
          shadowRadius: 3,
          elevation: 1,
        },
        style,
      ]}>
      {children}
    </View>
  );
}

export function SectionTitle({ children, action }: { children: string; action?: React.ReactNode }) {
  const { c } = useTheme();
  return (
    <View style={s.sectionRow}>
      <Text accessibilityRole="header" style={[s.h2, s.h2Shrink, { color: c.text }]}>
        {children}
      </Text>
      {action}
    </View>
  );
}

export function ExpandableSection({
  title,
  children,
  initiallyOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  initiallyOpen?: boolean;
}) {
  const { c } = useTheme();
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={{ marginBottom: space.lg }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${open ? 'Hide' : 'Open'} ${title}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        hitSlop={4}
        style={({ pressed }) => [s.sectionRow, { opacity: pressed ? 0.8 : 1 }]}>
        <Text accessibilityRole="header" style={[s.h2, s.h2Shrink, { color: c.text, flex: 1 }]}>
          {title}
        </Text>
        <Text style={[typography.cardTitle, { color: c.primary }]}>{open ? 'Hide' : 'Open'}</Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

export function StatTile({
  label,
  value,
  detail,
  tone = 'default',
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: 'default' | 'primary' | 'success' | 'danger';
}) {
  const { c } = useTheme();
  const valueColor = tone === 'primary' ? c.primary : tone === 'success' ? c.success : tone === 'danger' ? c.danger : c.text;
  return (
    <View style={[s.statTile, { backgroundColor: c.bg, borderColor: c.border }]}>
      <Text style={[typography.caption, { color: c.sub }]}>{label}</Text>
      <Text style={[typography.cardTitle, { color: valueColor, fontSize: 20, lineHeight: 28 }]}>{value}</Text>
      {detail ? <Text style={[typography.caption, { color: c.sub }]}>{detail}</Text> : null}
    </View>
  );
}

export function Button({
  label,
  onPress,
  kind = 'primary',
  disabled,
  style,
  size = 'default',
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  style?: ViewStyle;
  size?: 'default' | 'compact';
  accessibilityLabel?: string;
}) {
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const compact = width < 420;
  const bg = kind === 'primary' ? c.primary : 'transparent';
  const fg = kind === 'primary' ? c.onPrimary : kind === 'danger' ? c.danger : c.primary;
  const border = kind === 'primary' ? bg : kind === 'danger' ? c.danger : c.border;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        s.btn,
        size === 'compact' && s.compactActionBtn,
        compact && s.compactBtn,
        {
          backgroundColor: bg,
          borderColor: border,
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        },
        style,
      ]}>
      <Text style={[typography.button, size === 'compact' && s.compactActionText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

export function Field({ label, error, ...p }: TextInputProps & { label: string; error?: string | null }) {
  const { c } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ marginBottom: space.md }}>
      <Text style={[typography.secondary, { color: c.sub, marginBottom: 8, fontWeight: '500' }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={c.sub}
        onFocus={(e) => {
          setFocused(true);
          p.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          p.onBlur?.(e);
        }}
        style={[
          s.input,
          {
            color: c.text,
            backgroundColor: c.bg,
            borderColor: error ? c.danger : focused ? c.primary : c.border,
          },
          p.multiline && { minHeight: 88, textAlignVertical: 'top' },
        ]}
        {...p}
      />
      {error ? (
        <Text accessibilityLiveRegion="polite" style={{ color: c.danger, fontSize: 13, lineHeight: 19, marginTop: 6 }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function Chips<T extends string>({
  options,
  value,
  onChange,
  label,
  labels,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  labels?: Partial<Record<T, string>>;
}) {
  const { c } = useTheme();
  return (
    <View style={{ marginBottom: space.lg }}>
      <Text style={[typography.secondary, { color: c.sub, marginBottom: 8, fontWeight: '500' }]}>{label}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {options.map((o) => {
          const sel = o === value;
          return (
            <Pressable
              key={o}
              accessibilityRole="button"
              accessibilityState={{ selected: sel }}
              onPress={() => onChange(o)}
              hitSlop={2}
              style={({ pressed }) => [
                s.chip,
                {
                  backgroundColor: sel ? c.primary : c.chip,
                  borderColor: sel ? c.primary : c.border,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}>
              <Text
                style={[
                  typography.body,
                  { color: sel ? c.onPrimary : c.text, fontWeight: sel ? '600' : '500', fontSize: 13 },
                ]}>
                {labels?.[o] ?? o}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint: string; action?: React.ReactNode }) {
  const { c } = useTheme();
  return (
    <View style={{ alignItems: 'center', padding: space.xxl }}>
      <Text style={[typography.body, { color: c.text, fontWeight: '600', textAlign: 'center' }]}>{title}</Text>
      <Text style={[typography.body, { color: c.sub, marginTop: 10, textAlign: 'center' }]}>{hint}</Text>
      {action ? <View style={{ marginTop: space.md }}>{action}</View> : null}
    </View>
  );
}

export function Banner({ text, tone = 'info' }: { text: string; tone?: 'info' | 'danger' | 'warn' }) {
  const { c, isDark } = useTheme();
  const col = tone === 'danger' ? c.danger : tone === 'warn' ? c.warn : c.primary;
  const bg =
    tone === 'danger'
      ? isDark
        ? '#3B1518'
        : '#FEF2F2'
      : tone === 'warn'
        ? isDark
          ? '#3D2808'
          : '#FFFBEB'
        : isDark
          ? '#1E243D'
          : '#EEF2FF';
  return (
    <View accessibilityRole="alert" style={[s.banner, { borderColor: col, backgroundColor: bg }]}>
      <Text style={[typography.secondary, { color: col, fontWeight: '500' }]}>{text}</Text>
    </View>
  );
}

export function Loading() {
  const { c } = useTheme();
  return (
    <View style={{ padding: space.xl, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={c.primary} size="large" accessibilityLabel="Loading" />
    </View>
  );
}

export function ProgressBar({ pct, label }: { pct: number; label: string }) {
  const { c } = useTheme();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      style={{ height: 8, borderRadius: 4, backgroundColor: c.chip, overflow: 'hidden' }}>
      <View style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: '100%', backgroundColor: c.success }} />
    </View>
  );
}

const s = StyleSheet.create({
  keyboard: { flex: 1 },
  scroll: { flexGrow: 1, alignItems: 'center' },
  col: { width: '100%', maxWidth: 680, paddingHorizontal: space.lg, paddingTop: space.xl, paddingBottom: space.xl },
  compactCol: { paddingHorizontal: 16, paddingTop: space.lg },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: space.sm, marginBottom: space.xl },
  h1: typography.pageTitle,
  h1Shrink: { flexShrink: 1 },
  h2: typography.sectionTitle,
  h2Shrink: { flexShrink: 1 },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    minHeight: MIN_TOUCH,
    gap: space.sm,
    marginTop: space.xl,
    marginBottom: space.md,
  },
  statTile: {
    flexGrow: 1,
    flexBasis: 132,
    minWidth: 132,
    gap: 3,
    padding: space.md,
    borderWidth: 1,
    borderRadius: radiusSm,
  },
  card: { borderWidth: 1, borderRadius: radius, padding: space.xl, marginBottom: space.lg },
  compactCard: { padding: 16 },
  btn: {
    minHeight: 40,
    minWidth: 40,
    paddingHorizontal: space.xl,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactBtn: { paddingHorizontal: 16 },
  compactActionBtn: { minHeight: 40, paddingHorizontal: 12 },
  compactActionText: { fontSize: 14, lineHeight: 20 },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
    fontFamily: typography.body.fontFamily,
    fontSize: 16,
    lineHeight: 24,
  },
  chip: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  banner: { borderWidth: 1, borderRadius: 10, padding: space.lg, marginBottom: space.lg },
  toast: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    bottom: 84,
    borderRadius: 10,
    padding: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: 640,
    alignSelf: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 6,
  },
  toastBtn: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
});

/** Two-step destructive action: first press arms it (label changes), second press performs it; disarms after 5s. */
export function ConfirmButton({
  label,
  confirmLabel = 'Tap again to delete',
  onConfirm,
  size = 'default',
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void;
  size?: 'default' | 'compact';
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      kind="danger"
      label={armed ? confirmLabel : label}
      onPress={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
      size={size}
      style={{ minWidth: 96 }}
    />
  );
}

/** Rendered once in the root layout (not per screen) so the live region is announced only once. */
export function ToastHost() {
  const { c } = useTheme();
  const { toast, dismissToast } = useApp();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  if (!toast) return null;
  // Sit just above the tab bar, which grows by the bottom inset on phones with on-screen navigation.
  const tabBar = (width < 420 ? 66 : 62) + insets.bottom;
  return (
    <View style={[s.toast, { backgroundColor: c.text, bottom: tabBar + space.sm }]} accessibilityLiveRegion="polite">
      <Text style={{ color: c.bg, flex: 1, fontSize: 15, lineHeight: 20 }}>{toast.message}</Text>
      {toast.undo ? (
        <Pressable accessibilityRole="button" onPress={toast.undo} style={s.toastBtn}>
          <Text style={{ color: c.bg, fontWeight: '700', textDecorationLine: 'underline', fontSize: 14 }}>Undo</Text>
        </Pressable>
      ) : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" onPress={dismissToast} style={s.toastBtn}>
        <Text style={{ color: c.bg, fontSize: 16 }}>✕</Text>
      </Pressable>
    </View>
  );
}
