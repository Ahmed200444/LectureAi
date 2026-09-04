import { registerRootComponent } from 'expo';
import { setAudioModeAsync } from 'expo-audio';
import Root from './Root';

// Request background recording at runtime. The standalone/native LectureAI build
// also enables the required native capability through the expo-audio config plugin.
// Stock Expo Go cannot guarantee that native capability, so failures here are
// intentionally non-fatal during Expo Go testing.
void setAudioModeAsync({
  playsInSilentMode: true,
  allowsRecording: true,
  allowsBackgroundRecording: true,
  interruptionMode: 'doNotMix',
}).catch(() => undefined);

registerRootComponent(Root);
