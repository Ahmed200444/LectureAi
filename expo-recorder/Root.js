import React, { useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { setAudioModeAsync } from 'expo-audio';
import * as Sharing from 'expo-sharing';
import App from './App';
import { loadLibrary } from './src/storage';
import {
  exportEnglishTranscript,
  exportLectureData,
  exportNotes,
  exportSourceTranscript,
  exportStudyGuide,
  exportTranscript,
} from './src/exports';

function formatDuration(milliseconds = 0) {
  const total = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function audioMime(filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'ogg') return 'audio/ogg';
  if (ext === 'flac') return 'audio/flac';
  if (ext === 'webm') return 'audio/webm';
  if (ext === 'aac') return 'audio/aac';
  return 'audio/mp4';
}

async function exportAudio(lecture) {
  if (!lecture?.audioUri) throw new Error('This lecture does not have an original audio file.');
  if (!await Sharing.isAvailableAsync()) throw new Error('The system share sheet is not available on this device.');
  await Sharing.shareAsync(lecture.audioUri, {
    dialogTitle: `Export original audio — ${lecture.title}`,
    mimeType: audioMime(lecture.audioFilename),
  });
}

export default function Root() {
  const { width } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [lectures, setLectures] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState('');
  const selected = lectures.find((lecture) => lecture.id === selectedId) || null;
  const tablet = width >= 700;

  useEffect(() => {
    // The config plugin in app.json adds the native iOS/Android background-recording
    // capability to standalone/development builds. This runtime flag activates that
    // capability for the audio session. Stock Expo Go cannot gain native capabilities
    // that are not compiled into the Expo Go binary, so important background tests are
    // still performed on a LectureAI native build rather than assumed from Expo Go.
    void setAudioModeAsync({
      playsInSilentMode: true,
      allowsRecording: true,
      allowsBackgroundRecording: true,
      interruptionMode: 'doNotMix',
    }).catch(() => {
      // App.js applies the normal recording mode again at start. Failing this optional
      // startup preflight must not prevent foreground recording in Expo Go.
    });
  }, []);

  async function refreshExports() {
    const library = await loadLibrary();
    setLectures(library);
    if (selectedId && !library.some((lecture) => lecture.id === selectedId)) setSelectedId('');
    return library;
  }

  useEffect(() => {
    if (open) void refreshExports();
  }, [open]);

  async function run(label, action) {
    if (!selected || busy) return;
    try {
      setBusy(label);
      await action(selected);
    } catch (error) {
      Alert.alert('Export did not finish', error instanceof Error ? error.message : 'LectureAI could not create this export.');
    } finally {
      setBusy('');
    }
  }

  return (
    <View style={styles.root}>
      <App onOpenExports={() => setOpen(true)} />
      <Modal visible={open} animationType="slide" presentationStyle={tablet ? 'pageSheet' : 'fullScreen'} onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.modalSafe}>
          <View style={styles.modalHeader}>
            <View style={{ flex: 1 }}><Text style={styles.eyebrow}>IPHONE + IPAD EXPORTS</Text><Text style={styles.title}>Export lecture</Text></View>
            <Pressable onPress={() => setOpen(false)} style={styles.closeButton}><Text style={styles.closeText}>Done</Text></Pressable>
          </View>
          <ScrollView contentContainerStyle={[styles.modalContent, tablet && styles.modalContentTablet]}>
            <Text style={styles.lead}>Choose a lecture, then export the protected original audio, English transcript, original-language transcript, corrected timestamped transcript, current notes, study guide, or structured LectureAI data through the iOS/iPadOS share sheet.</Text>
            <Text style={styles.sectionTitle}>Choose lecture</Text>
            {!lectures.length ? (
              <View style={styles.empty}><Text style={styles.emptyTitle}>No lectures yet</Text><Text style={styles.muted}>Record or import a lecture first.</Text></View>
            ) : lectures.map((lecture) => (
              <Pressable key={lecture.id} onPress={() => setSelectedId(lecture.id)} style={[styles.lectureRow, selectedId === lecture.id && styles.lectureRowSelected]}>
                <View style={{ flex: 1 }}><Text style={styles.lectureTitle}>{lecture.title}</Text><Text style={styles.meta}>{formatDuration(lecture.durationMs)} · {lecture.transcript?.length || 0} transcript segments</Text></View>
                <Text style={styles.check}>{selectedId === lecture.id ? '✓' : '›'}</Text>
              </Pressable>
            ))}
            {selected ? (
              <View style={styles.exportCard}>
                <Text style={styles.cardTitle}>{selected.title}</Text>
                <Text style={styles.meta}>Exports never rewrite the protected original audio.</Text>
                <ExportButton label="Original audio" description="Share / Save to Files in its preserved audio format." disabled={Boolean(busy)} busy={busy === 'audio'} onPress={() => run('audio', exportAudio)} />
                <ExportButton label="English transcript (.txt)" description="English faster-whisper transcript/translation with timestamps when Windows transcription produced it." disabled={Boolean(busy) || !selected.englishTranscript?.length} busy={busy === 'english'} onPress={() => run('english', exportEnglishTranscript)} />
                <ExportButton label="Original-language transcript (.txt)" description={`Transcript as spoken${selected.sourceLanguage ? ` · detected source: ${selected.sourceLanguage}` : ''}.`} disabled={Boolean(busy) || !selected.sourceTranscript?.length} busy={busy === 'source'} onPress={() => run('source', exportSourceTranscript)} />
                <ExportButton label="Current editable transcript (.txt)" description="Timestamped text currently used by LectureAI notes/study." disabled={Boolean(busy) || !selected.transcript?.length} busy={busy === 'transcript'} onPress={() => run('transcript', exportTranscript)} />
                <ExportButton label="Notes (.md)" description="Current source-grounded summary and detailed notes with source timestamps." disabled={Boolean(busy) || !selected.studyPack || selected.staleDerivedContent} busy={busy === 'notes'} onPress={() => run('notes', exportNotes)} />
                <ExportButton label="Study guide (.md)" description="Key concepts, review topics and study questions." disabled={Boolean(busy) || !selected.studyPack || selected.staleDerivedContent} busy={busy === 'study'} onPress={() => run('study', exportStudyGuide)} />
                <ExportButton label="Lecture data (.json)" description="Metadata, marks, English/source transcripts and current study data; original audio remains separate." disabled={Boolean(busy)} busy={busy === 'data'} onPress={() => run('data', exportLectureData)} />
                {selected.staleDerivedContent ? <View style={styles.warning}><Text style={styles.warningText}>Transcript changed. Regenerate derived content before exporting Notes or Study.</Text></View> : null}
              </View>
            ) : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

function ExportButton({ label, description, onPress, disabled, busy }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.exportButton, disabled && styles.disabled, pressed && !disabled && styles.pressed]}>
      <View style={{ flex: 1 }}><Text style={styles.exportButtonTitle}>{busy ? 'Preparing…' : label}</Text><Text style={styles.exportButtonDescription}>{description}</Text></View>
      <Text style={styles.exportArrow}>⇧</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pressed: { opacity: 0.72 },
  modalSafe: { flex: 1, backgroundColor: '#F7F7F2' },
  modalHeader: { paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#D9E2DD', flexDirection: 'row', alignItems: 'center', gap: 12 },
  modalContent: { width: '100%', padding: 20, paddingBottom: 48 },
  modalContentTablet: { maxWidth: 760, alignSelf: 'center', paddingTop: 28 },
  eyebrow: { color: '#527064', fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  title: { color: '#173129', fontSize: 28, fontWeight: '900', marginTop: 3 },
  closeButton: { minHeight: 40, minWidth: 58, paddingHorizontal: 12, borderRadius: 13, backgroundColor: '#E5EEE9', alignItems: 'center', justifyContent: 'center' },
  closeText: { color: '#214F3D', fontWeight: '900', fontSize: 13 },
  lead: { color: '#587066', fontSize: 14, lineHeight: 21 },
  sectionTitle: { color: '#173129', fontSize: 16, fontWeight: '900', marginTop: 22, marginBottom: 4 },
  empty: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#DFE8E3', borderRadius: 18, padding: 18, marginTop: 9 },
  emptyTitle: { color: '#173129', fontSize: 16, fontWeight: '900' },
  muted: { color: '#718078', fontSize: 12, marginTop: 5 },
  lectureRow: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#DFE8E3', borderRadius: 16, padding: 14, marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
  lectureRowSelected: { borderColor: '#315F4B', backgroundColor: '#F1F6F3' },
  lectureTitle: { color: '#173129', fontWeight: '900', fontSize: 15 },
  meta: { color: '#718078', fontSize: 11, lineHeight: 17, marginTop: 4 },
  check: { color: '#315F4B', fontSize: 20, fontWeight: '900' },
  exportCard: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#D8E4DE', borderRadius: 20, padding: 16, marginTop: 18 },
  cardTitle: { color: '#173129', fontSize: 19, fontWeight: '900' },
  exportButton: { borderWidth: 1, borderColor: '#D7E2DC', borderRadius: 15, padding: 13, marginTop: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
  exportButtonTitle: { color: '#214F3D', fontSize: 13, fontWeight: '900' },
  exportButtonDescription: { color: '#718078', fontSize: 11, lineHeight: 16, marginTop: 3 },
  exportArrow: { color: '#315F4B', fontSize: 19, fontWeight: '900' },
  disabled: { opacity: 0.42 },
  warning: { backgroundColor: '#FFF0DB', borderRadius: 14, padding: 12, marginTop: 12 },
  warningText: { color: '#795D32', fontSize: 12, lineHeight: 18 },
});
