import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export interface ErrorBoundaryProps {
  error: Error;
  retry: () => Promise<void> | void;
}

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <SafeAreaView style={styles.errorContainer}>
      <View style={styles.errorCard}>
        <Text style={styles.errorIcon}>⚠</Text>
        <Text accessibilityRole="header" style={styles.errorTitle}>
          Something went wrong
        </Text>
        <Text style={styles.errorSubtitle}>
          An unexpected error occurred. Your stored data is safe on this device.
        </Text>
        <View style={styles.errorDetailBox}>
          <Text style={styles.errorDetailText} numberOfLines={3}>
            {error?.message || 'Unknown error'}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try again"
          onPress={() => {
            void retry();
          }}
          style={({ pressed }) => [
            styles.retryButton,
            { opacity: pressed ? 0.85 : 1 },
          ]}
        >
          <Text style={styles.retryButtonText}>Try again</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  errorContainer: {
    flex: 1,
    backgroundColor: '#0F172A',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  errorCard: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: '#1E293B',
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
  },
  errorIcon: {
    fontSize: 36,
    color: '#F87171',
    marginBottom: 12,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#F8FAFC',
    marginBottom: 8,
    textAlign: 'center',
  },
  errorSubtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: '#94A3B8',
    textAlign: 'center',
    marginBottom: 16,
  },
  errorDetailBox: {
    width: '100%',
    backgroundColor: '#0F172A',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 20,
  },
  errorDetailText: {
    fontSize: 13,
    lineHeight: 18,
    color: '#F87171',
  },
  retryButton: {
    minHeight: 48,
    minWidth: 140,
    backgroundColor: '#818CF8',
    borderRadius: 10,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0F172A',
  },
});
