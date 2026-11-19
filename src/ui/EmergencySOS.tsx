import * as Location from 'expo-location';
import * as Linking from 'expo-linking';
import { Alert, Platform, Share, Text, View } from 'react-native';
import { Button, Card, ExpandableSection } from './components';
import { type as typography, useTheme } from './theme';

const EMERGENCY_NUMBER = '999';

function showMessage(title: string, message: string): void {
  Alert.alert(title, message);
}

async function callEmergencyServices(): Promise<void> {
  try {
    await Linking.openURL(`tel:${EMERGENCY_NUMBER}`);
  } catch {
    showMessage('Call unavailable', `This device could not open the phone app for ${EMERGENCY_NUMBER}.`);
  }
}

async function shareCurrentLocation(): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      showMessage('Location sharing', 'Location sharing is available in the phone app, not in the web preview.');
      return;
    }

    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.status !== Location.PermissionStatus.GRANTED) {
      showMessage('Location permission needed', 'Personal Assistant cannot read or share your location without your permission.');
      return;
    }

    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    const { latitude, longitude } = position.coords;
    const mapUrl = `https://maps.google.com/?q=${latitude},${longitude}`;
    await Share.share({
      title: 'My current location',
      message: `My current location: ${mapUrl}`,
    });
  } catch {
    showMessage('Location unavailable', 'Personal Assistant could not read or share the current location. No location was saved.');
  }
}

export function EmergencySOSButton() {
  const { c } = useTheme();
  return (
    <Button
      kind="danger"
      size="compact"
      label="Call 999"
      accessibilityLabel="Call 999"
      onPress={() => Alert.alert('Emergency SOS', 'Choose an action. Personal Assistant cannot confirm that emergency services received your location.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Call 999', onPress: () => { void callEmergencyServices(); } },
        { text: 'Share location', onPress: () => { void shareCurrentLocation(); } },
      ])}
      style={{ borderColor: c.danger, minWidth: 88 }}
    />
  );
}

export function EmergencySOSPanel() {
  return (
    <ExpandableSection title="Emergency SOS">
      <EmergencySOSContent />
    </ExpandableSection>
  );
}

function EmergencySOSContent() {
  const { c } = useTheme();
  return (
    <Card style={{ borderColor: c.danger, gap: 12 }}>
      <Text style={[typography.secondary, { color: c.sub }]}>
        Personal Assistant does not send your location to emergency services or save it. You choose whether to call or share your current location.
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button kind="danger" label={`Call ${EMERGENCY_NUMBER}`} onPress={() => { void callEmergencyServices(); }} />
        <Button kind="secondary" label="Share current location" onPress={() => { void shareCurrentLocation(); }} />
      </View>
    </Card>
  );
}
