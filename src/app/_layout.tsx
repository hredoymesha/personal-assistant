import { Tabs } from 'expo-router';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { Linking, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppProvider } from '../state/AppProvider';
import { ToastHost } from '../ui/components';
import { type as typography, useTheme } from '../ui/theme';
import { ErrorBoundary } from '../ui/ErrorBoundary';

export { ErrorBoundary };

function TabIcon({ glyph, color }: { glyph: string; color: import('react-native').ColorValue }) {
  return <Text style={[typography.button, { fontSize: 20, lineHeight: 24, color }]} accessible={false}>{glyph}</Text>;
}
const icon = (glyph: string) => function Icon({ color }: { color: import('react-native').ColorValue }) { return <TabIcon glyph={glyph} color={color} />; };

// Set only for hosted test builds so nobody mistakes the preview for a release.
const previewLabel = Platform.OS === 'web' ? (process.env.EXPO_PUBLIC_PREVIEW_LABEL ?? '').trim() : '';
const previewApkUrl = Platform.OS === 'web' ? (process.env.EXPO_PUBLIC_PREVIEW_APK_URL ?? '').trim() : '';

function PreviewStrip() {
  const { c } = useTheme();
  if (!previewLabel) return null;
  return (
    <View style={{ backgroundColor: c.chip, borderBottomColor: c.warn, borderBottomWidth: 1, paddingHorizontal: 16, paddingVertical: 6, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', columnGap: 12, rowGap: 6 }}>
      <Text style={[typography.caption, { color: c.text, textAlign: 'center' }]}>{previewLabel}</Text>
      {previewApkUrl ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Download the Android APK"
          onPress={() => { void Linking.openURL(previewApkUrl); }}
          style={{ backgroundColor: c.primary, borderRadius: 999, paddingHorizontal: 14, minHeight: 32, justifyContent: 'center' }}
        >
          <Text style={[typography.caption, { color: c.onPrimary, fontWeight: '700' }]}>Download APK</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Shell() {
  const { c, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const compact = width < 420;
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <PreviewStrip />
      <Tabs screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.primary,
        tabBarInactiveTintColor: c.sub,
        tabBarStyle: {
          backgroundColor: c.card,
          borderTopColor: c.border,
          borderTopWidth: 1,
          minHeight: (compact ? 66 : 62) + insets.bottom,
          height: compact ? 66 : undefined,
          paddingBottom: (compact ? 3 : 6) + insets.bottom,
          paddingTop: compact ? 3 : 6,
        },
        tabBarLabelStyle: { ...typography.button, fontSize: compact ? 10 : 12, lineHeight: compact ? 15 : 18 },
      }}>
        <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: icon('⌂') }} />
        <Tabs.Screen name="tasks" options={{ title: 'Tasks', tabBarIcon: icon('✓') }} />
        <Tabs.Screen name="money" options={{ title: 'Money', tabBarIcon: icon('৳') }} />
        <Tabs.Screen name="cycle" options={{ title: 'Cycle', tabBarIcon: icon('↻') }} />
        <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('⚙') }} />
      </Tabs>
      <ToastHost />
    </View>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    'Noto Serif Bengali': require('../../assets/fonts/NotoSerifBengali.ttf'),
  });

  if (!fontsLoaded && !fontError) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F8FAFC' }}>
        <Text style={[typography.pageTitle, { color: '#0F172A' }]}>Personal Assistant</Text>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <AppProvider>
        <Shell />
      </AppProvider>
    </SafeAreaProvider>
  );
}
