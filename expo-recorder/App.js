import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AppState,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import * as KeepAwake from 'expo-keep-awake';
import * as Sharing from 'expo-sharing';

const KEEP_AWAKE_TAG = 'lecture-recorder';

function formatDuration(milliseconds = 0) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export default function App() {
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    directory: 'document',
  });
  const recorderState = useAudioRecorderState(recorder, 250);
  const [savedUri, setSavedUri] = useState(null);
  const [status, setStatus] = useState('Ready to record');
  const [leftForegroundWhileRecording, setLeftForegroundWhileRecording] = useState(false);

  const duration = useMemo(
    () => formatDuration(recorderState.durationMillis),
    [recorderState.durationMillis]
  );

  useEffect(() => {
    let mounted = true;

    (async () => {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!mounted) return;

      if (!permission.granted) {
        setStatus('Microphone permission is required');
        return;
      }

      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });
    })().catch(() => {
      if (mounted) setStatus('Could not prepare the microphone');
    });

    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && recorderState.isRecording) {
        setLeftForegroundWhileRecording(true);
      }
    });

    return () => {
      mounted = false;
      subscription.remove();
      KeepAwake.deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [recorderState.isRecording]);

  const startRecording = async () => {
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Microphone permission needed', 'Allow microphone access in iPhone Settings, then try again.');
        return;
      }

      setSavedUri(null);
      setLeftForegroundWhileRecording(false);
      setStatus('Preparing…');

      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });

      await recorder.prepareToRecordAsync({
        ...RecordingPresets.HIGH_QUALITY,
        directory: 'document',
      });
      recorder.record();
      await KeepAwake.activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      setStatus('Recording safely on-device');
    } catch (error) {
      setStatus('Could not start recording');
      Alert.alert('Recording did not start', 'Close other apps using the microphone and try again.');
    }
  };

  const shareRecording = async (uri = savedUri) => {
    if (!uri) return;

    const available = await Sharing.isAvailableAsync();
    if (!available) {
      Alert.alert('Share unavailable', 'The recording is saved inside Expo Go, but the iOS share sheet is unavailable right now.');
      return;
    }

    await Sharing.shareAsync(uri, {
      dialogTitle: 'Save your lecture recording',
      mimeType: 'audio/mp4',
      UTI: 'public.mpeg-4-audio',
    });
  };

  const stopRecording = async () => {
    try {
      setStatus('Finishing recording…');
      await recorder.stop();
      await KeepAwake.deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});

      const uri = recorder.uri;
      if (!uri) {
        setStatus('Recording finished, but the file path was not returned');
        Alert.alert('Could not find the saved file', 'Do not start another long lecture yet. Try a short test recording first.');
        return;
      }

      setSavedUri(uri);
      setStatus('Recording saved — choose Save to Files next');

      // Open the iOS share sheet immediately so the recording can be moved
      // out of Expo Go and into Files after every lecture.
      setTimeout(() => {
        shareRecording(uri).catch(() => {
          setStatus('Recording saved — tap Save / Share below');
        });
      }, 250);
    } catch (error) {
      await KeepAwake.deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
      setStatus('Could not finish the recording cleanly');
      Alert.alert('Finish failed', 'Keep Expo Go open and try stopping once more.');
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.brandRow}>
          <View style={styles.logoMark} />
          <Text style={styles.brand}>Lecture Recorder</Text>
          <View style={styles.freePill}><Text style={styles.freePillText}>FREE</Text></View>
        </View>

        <Text style={styles.title}>Record the lecture. Keep the original.</Text>
        <Text style={styles.subtitle}>
          Native iPhone recording through Expo Go — no SideStore, no cable, no paid developer account.
        </Text>

        <View style={styles.recorderCard}>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, recorderState.isRecording && styles.statusDotLive]} />
            <Text style={styles.statusText}>{status}</Text>
          </View>

          <Text style={styles.timer}>{duration}</Text>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={recorderState.isRecording ? 'Finish and save recording' : 'Start recording'}
            onPress={recorderState.isRecording ? stopRecording : startRecording}
            style={({ pressed }) => [
              styles.recordButton,
              recorderState.isRecording && styles.stopButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <View style={recorderState.isRecording ? styles.stopIcon : styles.recordIcon} />
            <Text style={styles.recordButtonText}>
              {recorderState.isRecording ? 'Finish & save' : 'Start recording'}
            </Text>
          </Pressable>

          {savedUri ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save or share recording"
              onPress={() => shareRecording()}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
            >
              <Text style={styles.secondaryButtonText}>Save / Share recording</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>For a full lecture</Text>
          <Text style={styles.infoText}>• Keep this screen open. The app keeps your display awake while recording.</Text>
          <Text style={styles.infoText}>• When you finish, choose “Save to Files” in the iPhone share sheet.</Text>
          <Text style={styles.infoText}>• Import that .m4a into LectureAI for transcription and notes.</Text>
        </View>

        {leftForegroundWhileRecording ? (
          <View style={styles.warningCard}>
            <Text style={styles.warningTitle}>Recording was backgrounded</Text>
            <Text style={styles.warningText}>
              Expo Go cannot guarantee long background or locked-screen recording on iPhone. Check the saved file before relying on it.
            </Text>
          </View>
        ) : null}

        <Text style={styles.footnote}>
          High-quality AAC/M4A • stored on-device first • no subscription
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#F7F7F2' },
  container: { padding: 22, paddingBottom: 44 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 28 },
  logoMark: { width: 16, height: 16, borderRadius: 5, backgroundColor: '#214F3D' },
  brand: { fontSize: 17, fontWeight: '800', color: '#173129', flex: 1 },
  freePill: { borderRadius: 999, backgroundColor: '#E7F1EC', paddingHorizontal: 10, paddingVertical: 5 },
  freePillText: { fontSize: 11, fontWeight: '900', color: '#214F3D', letterSpacing: 0.7 },
  title: { fontSize: 34, lineHeight: 38, fontWeight: '900', color: '#173129', letterSpacing: -1.1 },
  subtitle: { marginTop: 12, fontSize: 16, lineHeight: 24, color: '#587066' },
  recorderCard: {
    marginTop: 26,
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 20,
    borderWidth: 1,
    borderColor: '#DFE8E3',
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  statusDot: { width: 9, height: 9, borderRadius: 9, backgroundColor: '#9AA9A2' },
  statusDotLive: { backgroundColor: '#D84747' },
  statusText: { flex: 1, color: '#587066', fontSize: 14, fontWeight: '700' },
  timer: {
    marginVertical: 28,
    textAlign: 'center',
    fontSize: 54,
    fontWeight: '800',
    color: '#173129',
    fontVariant: ['tabular-nums'],
    letterSpacing: -1.5,
  },
  recordButton: {
    minHeight: 58,
    borderRadius: 18,
    backgroundColor: '#214F3D',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 11,
    paddingHorizontal: 18,
  },
  stopButton: { backgroundColor: '#963D3D' },
  recordIcon: { width: 17, height: 17, borderRadius: 17, backgroundColor: '#FFFFFF' },
  stopIcon: { width: 16, height: 16, borderRadius: 4, backgroundColor: '#FFFFFF' },
  recordButtonText: { color: '#FFFFFF', fontWeight: '900', fontSize: 16 },
  secondaryButton: {
    minHeight: 50,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#C9D9D1',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  secondaryButtonText: { color: '#214F3D', fontSize: 15, fontWeight: '800' },
  buttonPressed: { opacity: 0.78 },
  infoCard: { marginTop: 18, borderRadius: 20, backgroundColor: '#EDF3EF', padding: 18 },
  infoTitle: { color: '#173129', fontWeight: '900', fontSize: 17, marginBottom: 8 },
  infoText: { color: '#35584B', fontSize: 14, lineHeight: 21, marginTop: 4 },
  warningCard: { marginTop: 14, borderRadius: 20, backgroundColor: '#FFF1DD', padding: 18 },
  warningTitle: { color: '#6C4A13', fontWeight: '900', fontSize: 16 },
  warningText: { marginTop: 6, color: '#765B31', fontSize: 14, lineHeight: 21 },
  footnote: { marginTop: 22, textAlign: 'center', color: '#72867D', fontSize: 12 },
});
