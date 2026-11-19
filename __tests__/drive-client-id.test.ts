import { platformClientId } from '../src/services/driveConfig';

describe('platformClientId', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('uses the client that matches the platform', () => {
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = ' web-id.apps.googleusercontent.com ';
    process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID = 'android-id.apps.googleusercontent.com';
    expect(platformClientId('web')).toBe('web-id.apps.googleusercontent.com');
    expect(platformClientId('android')).toBe('android-id.apps.googleusercontent.com');
  });

  it('never falls back to the web client on a phone', () => {
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'web-id.apps.googleusercontent.com';
    delete process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID;
    delete process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
    expect(platformClientId('android')).toBe('');
    expect(platformClientId('ios')).toBe('');
    expect(platformClientId('windows')).toBe('');
  });
});
