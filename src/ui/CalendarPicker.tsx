import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { addDays, getMonthCalendarGrid, isValidDateStr, toDateStr, type DateStr } from '../domain/dates';
import { radiusSm, space, type as typography, useTheme } from './theme';

export interface CalendarPickerProps {
  value?: string;
  onChange: (date: DateStr) => void;
  onClose?: () => void;
  today?: DateStr;
  showQuickShortcuts?: boolean;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export function CalendarPicker({
  value,
  onChange,
  onClose,
  today: propToday,
  showQuickShortcuts = true,
}: CalendarPickerProps) {
  const { c } = useTheme();
  const currentToday = propToday ?? toDateStr(new Date());

  const initialDate = isValidDateStr(value) ? value : currentToday;
  const [initY, initM] = initialDate.split('-').map(Number);

  const [viewYear, setViewYear] = useState<number>(initY || new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState<number>(initM || new Date().getMonth() + 1);

  const grid = useMemo(() => getMonthCalendarGrid(viewYear, viewMonth), [viewYear, viewMonth]);

  function prevMonth() {
    if (viewMonth === 1) {
      setViewYear((y) => y - 1);
      setViewMonth(12);
    } else {
      setViewMonth((m) => m - 1);
    }
  }

  function nextMonth() {
    if (viewMonth === 12) {
      setViewYear((y) => y + 1);
      setViewMonth(1);
    } else {
      setViewMonth((m) => m + 1);
    }
  }

  function jumpToToday() {
    const [ty, tm] = currentToday.split('-').map(Number);
    setViewYear(ty);
    setViewMonth(tm);
    onChange(currentToday);
    onClose?.();
  }

  function selectDate(dateStr: DateStr) {
    onChange(dateStr);
    onClose?.();
  }

  return (
    <View style={[styles.container, { backgroundColor: c.card, borderColor: c.border }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous month"
          onPress={prevMonth}
          style={({ pressed }) => [
            styles.navButton,
            { backgroundColor: pressed ? c.chip : 'transparent', borderColor: c.border },
          ]}
        >
          <Text style={[typography.cardTitle, { color: c.text }]}>◀</Text>
        </Pressable>

        <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={[typography.cardTitle, { color: c.text, flex: 1, textAlign: 'center', marginHorizontal: space.xs }]}>
          {MONTH_NAMES[viewMonth - 1]} {viewYear}
        </Text>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next month"
          onPress={nextMonth}
          style={({ pressed }) => [
            styles.navButton,
            { backgroundColor: pressed ? c.chip : 'transparent', borderColor: c.border },
          ]}
        >
          <Text style={[typography.cardTitle, { color: c.text }]}>▶</Text>
        </Pressable>
      </View>

      <View style={styles.weekdaysRow}>
        {WEEKDAYS.map((wd) => (
          <Text key={wd} numberOfLines={1} style={[typography.caption, styles.weekdayText, { color: c.sub }]}>
            {wd}
          </Text>
        ))}
      </View>

      <View style={styles.grid}>
        {grid.map((cell) => {
          const isSelected = value === cell.dateStr;
          const isToday = currentToday === cell.dateStr;

          return (
            <Pressable
              key={cell.dateStr}
              accessibilityRole="button"
              accessibilityLabel={`${cell.dateStr}${isToday ? ' - Today' : ''}${isSelected ? ' - Selected' : ''}`}
              onPress={() => selectDate(cell.dateStr)}
              style={({ pressed }) => [
                styles.dayCell,
                isSelected
                  ? { backgroundColor: c.primary }
                  : isToday
                  ? { borderColor: c.primary, borderWidth: 1.5, backgroundColor: pressed ? c.chip : 'transparent' }
                  : { backgroundColor: pressed ? c.chip : 'transparent' },
              ]}
            >
              <Text
                style={[
                  typography.secondary,
                  styles.dayText,
                  isSelected
                    ? { color: c.onPrimary, fontWeight: '700' }
                    : !cell.isCurrentMonth
                    ? { color: c.border }
                    : { color: c.text },
                ]}
              >
                {cell.day}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {showQuickShortcuts ? (
        <View style={[styles.footer, { borderTopColor: c.border }]}>
          <View style={styles.presetsRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Select today"
              onPress={jumpToToday}
              style={[styles.presetButton, { backgroundColor: c.chip, borderColor: c.border }]}
            >
              <Text style={[typography.caption, { color: c.primary, fontWeight: '600' }]}>Today</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Select yesterday"
              onPress={() => selectDate(addDays(currentToday, -1))}
              style={[styles.presetButton, { backgroundColor: c.chip, borderColor: c.border }]}
            >
              <Text style={[typography.caption, { color: c.text, fontWeight: '600' }]}>Yesterday</Text>
            </Pressable>
          </View>
          {onClose ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close calendar"
              onPress={onClose}
              style={[styles.presetButton, { borderColor: c.border }]}
            >
              <Text style={[typography.caption, { color: c.sub }]}>Close</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: radiusSm,
    padding: space.sm,
    marginVertical: space.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.xs,
  },
  navButton: {
    width: 44,
    height: 44,
    borderRadius: radiusSm,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  weekdaysRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: space.xs,
  },
  weekdayText: {
    width: '14.28%',
    textAlign: 'center',
    fontWeight: '600',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
  },
  dayCell: {
    width: '14.28%',
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radiusSm,
    marginVertical: 1,
  },
  dayText: {
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 18,
  },
  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    paddingTop: space.xs,
    marginTop: space.xs,
  },
  presetsRow: {
    flexDirection: 'row',
    gap: space.xs,
  },
  presetButton: {
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderRadius: radiusSm,
    borderWidth: 1,
    minHeight: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
