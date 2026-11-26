import { Platform, Text, TextInput, useColorScheme } from 'react-native';
import { useApp } from '../state/AppProvider';

export interface Palette {
  bg: string;
  card: string;
  text: string;
  sub: string;
  border: string;
  primary: string;
  onPrimary: string;
  danger: string;
  success: string;
  warn: string;
  chip: string;
}

// Text/background pairs chosen for >= 4.5:1 contrast (WCAG AA) in both themes.
export const light: Palette = {
  bg: '#F8FAFC',
  card: '#FFFFFF',
  text: '#0F172A',
  sub: '#475569',
  border: '#E2E8F0',
  primary: '#312E81',
  onPrimary: '#FFFFFF',
  danger: '#B91C1C',
  success: '#15803D',
  warn: '#B45309',
  chip: '#F1F5F9',
};

export const dark: Palette = {
  bg: '#0F172A',
  card: '#1E293B',
  text: '#F8FAFC',
  sub: '#94A3B8',
  border: '#334155',
  primary: '#818CF8',
  onPrimary: '#0F172A',
  danger: '#F87171',
  success: '#4ADE80',
  warn: '#FBBF24',
  chip: '#334155',
};

export const space = { xs: 4, sm: 8, md: 14, lg: 18, xl: 24, xxl: 32 };
export const radius = 12;
export const radiusSm = 8;
export const radiusLg = 16;
export const MIN_TOUCH = 48;

const fontFamily = Platform.select({
  ios: 'Noto Serif Bengali',
  android: 'Noto Serif Bengali',
  web: '"Noto Serif Bengali", Georgia, serif',
  default: 'Noto Serif Bengali',
});

if (Platform.OS === 'web' && typeof document !== 'undefined') {
  const styleId = '__aio_app_font';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      html, body, button, input, textarea, [role="button"], [role="tab"], [role="text"] {
        font-family: "Noto Serif Bengali", Georgia, serif !important;
      }
      * {
        font-family: "Noto Serif Bengali", Georgia, serif !important;
      }
    `;
    document.head.appendChild(style);
  }
  document.documentElement.style.fontFamily = '"Noto Serif Bengali", Georgia, serif';
  document.body.style.fontFamily = '"Noto Serif Bengali", Georgia, serif';
}

const textWithDefaults = Text as unknown as {
  defaultProps?: { style?: unknown };
};
textWithDefaults.defaultProps = textWithDefaults.defaultProps ?? {};
textWithDefaults.defaultProps.style = [
  textWithDefaults.defaultProps.style,
  { fontFamily },
];

const textInputWithDefaults = TextInput as unknown as {
  defaultProps?: { style?: unknown };
};
textInputWithDefaults.defaultProps = textInputWithDefaults.defaultProps ?? {};
textInputWithDefaults.defaultProps.style = [
  textInputWithDefaults.defaultProps.style,
  { fontFamily, fontSize: 16, lineHeight: 24 },
];

export const type = {
  pageTitle: { fontFamily, fontSize: 24, lineHeight: 32, fontWeight: '700' as const, letterSpacing: -0.3 },
  sectionTitle: { fontFamily, fontSize: 18, lineHeight: 26, fontWeight: '600' as const, letterSpacing: -0.2 },
  cardTitle: { fontFamily, fontSize: 16, lineHeight: 24, fontWeight: '600' as const },
  body: { fontFamily, fontSize: 15, lineHeight: 23, textAlign: 'left' as const },
  secondary: { fontFamily, fontSize: 14, lineHeight: 21, textAlign: 'left' as const },
  caption: { fontFamily, fontSize: 13, lineHeight: 18, textAlign: 'left' as const },
  button: { fontFamily, fontSize: 15, lineHeight: 22, fontWeight: '600' as const },
};

export function useTheme(): { c: Palette; isDark: boolean } {
  const system = useColorScheme();
  const { data } = useApp();
  const pref = data.settings.theme;
  const isDark = pref === 'system' ? system === 'dark' : pref === 'dark';
  return { c: isDark ? dark : light, isDark };
}
