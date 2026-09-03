import React, { useEffect, useState } from 'react';
import {
  Alert,
  AppState,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import * as KeepAwake from 'expo-keep-awake';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import {
  createLecture,
  defaultSettings,
  loadLibrary,
  loadSettings,
  markAudioVerified,
  preserveAudioFile,
  removeLecture,
  replaceTranscript,
  saveSettings,
  updateTranscriptSegment,
  upsertLecture,
} from './src/storage';
import { applyStudyPack, derivedContentIsFresh } from './src/study';

const KEEP_AWAKE_TAG = 'lectureai-recording';
const LOW_STORAGE_BYTES = 500 * 1024 * 1024;
const RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: 48_000,
  numberOfChannels: 1,
  bitRate: 192_000,
  isMeteringEnabled: true,
  // Keep the live recorder output in persistent document storage instead of the
  // temporary cache. The finished file is still copied to LectureAI/Recordings so
  // the library owns a stable original independent of the recorder's current URI.
  directory: 'document',
};

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatDuration(milliseconds = 0) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatBytes(bytes = 0) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / (1024 ** index);
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatTime(seconds = 0) {
  return formatDuration(seconds * 1000);
}

function recordingLevel(metering) {
  if (typeof metering !== 'number' || !Number.isFinite(metering)) return 0;
  return Math.max(0, Math.min(1, (metering + 60) / 60));
}

function normalizeImportedTranscript(payload, lectureId) {
  const rows = Array.isArray(payload) ? payload : payload?.segments;
  if (!Array.isArray(rows)) throw new Error('Transcript JSON must contain a segments array.');
  return rows.map((row, index) => {
    const start = Number(row.start ?? row.startTime ?? 0);
    const end = Number(row.end ?? row.endTime ?? start);
    const text = String(row.editedText ?? row.originalText ?? row.text ?? '').trim();
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      throw new Error(`Transcript segment ${index + 1} has invalid text or timestamps.`);
    }
    return {
      id: String(row.id || `${lectureId}-segment-${index + 1}`),
      startTime: start,
      endTime: end,
      originalText: text,
      editedText: text,
      manuallyReviewed: Boolean(row.manuallyReviewed),
      uncertain: /^\s*\[(?:uncertain|inaudible)\]/i.test(text),
      speaker: String(row.speaker || 'Speaker'),
    };
  }).sort((a, b) => a.startTime - b.startTime);
}

async function shareAudio(lecture) {
  if (!lecture?.audioUri) return;
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error('The system share sheet is not available on this device.');
  await Sharing.shareAsync(lecture.audioUri, {
    dialogTitle: `Share ${lecture.title}`,
    mimeType: 'audio/mp4',
    UTI: 'public.mpeg-4-audio',
  });
}

export default function App() {
  const recorder = useAudioRecorder(RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(recorder, 200);
  const player = useAudioPlayer(null, { updateInterval: 250 });
  const playerStatus = useAudioPlayerStatus(player);

  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState('record');
  const [lectures, setLectures] = useState([]);
  const [settings, setSettingsState] = useState(defaultSettings);
  const [selectedId, setSelectedId] = useState('');
  const [detailTab, setDetailTab] = useState('audio');
  const [title, setTitle] = useState(`Lecture ${new Date().toLocaleDateString()}`);
  const [paused, setPaused] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const [marks, setMarks] = useState([]);
  const [status, setStatus] = useState('Ready to record');
  const [warning, setWarning] = useState('');
  const [inputName, setInputName] = useState('');
  const [lastSavedId, setLastSavedId] = useState('');

  const selectedLecture = lectures.find((lecture) => lecture.id === selectedId) || null;
  const lastSaved = lectures.find((lecture) => lecture.id === lastSavedId) || null;
  const freeDisk = Paths.availableDiskSpace;
  const level = recordingLevel(recorderState.metering);

  async function refresh() {
    setLectures(await loadLibrary());
  }

  useEffect(() => {
    let mounted = true;
    void Promise.all([loadLibrary(), loadSettings()]).then(([library, loadedSettings]) => {
      if (!mounted) return;
      setLectures(library);
      setSettingsState(loadedSettings);
      setReady(true);
    }).catch((error) => {
      if (!mounted) return;
      setWarning(error instanceof Error ? error.message : 'Could not open the local LectureAI library.');
      setReady(true);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && recordingActive) {
        setWarning('LectureAI left the foreground while recording. Expo Go cannot guarantee locked-screen/background recording on iPhone; return to LectureAI and verify the saved audio afterward.');
      }
    });
    return () => subscription.remove();
  }, [recordingActive]);

  useEffect(() => {
    if (recorderState.mediaServicesDidReset && recordingActive) {
      setWarning('iOS audio services were reset during this lecture. Finish and verify the recording before relying on it.');
    }
  }, [recorderState.mediaServicesDidReset, recordingActive]);

  useEffect(() => () => {
    KeepAwake.deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
  }, []);

  async function persistSettings(patch) {
    const next = await saveSettings({ ...settings, ...patch });
    setSettingsState(next);
  }

  async function startRecording() {
    if (recordingActive) return;
    try {
      setWarning('');
      if (Paths.availableDiskSpace < LOW_STORAGE_BYTES) {
        Alert.alert('Low storage', `Only about ${formatBytes(Paths.availableDiskSpace)} is available. Free some storage before relying on LectureAI for a long lecture.`);
      }
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Microphone permission needed', 'Allow microphone access for Expo Go in iPhone Settings, then try again.');
        return;
      }

      setStatus('Preparing native iPhone audio…');
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
        interruptionMode: 'doNotMix',
      });
      await recorder.prepareToRecordAsync(RECORDING_OPTIONS);
      const input = await recorder.getCurrentInput().catch(() => null);
      setInputName(input?.name || input?.type || 'Built-in microphone');
      recorder.record();
      if (settings.keepScreenAwake) await KeepAwake.activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
      setMarks([]);
      setPaused(false);
      setRecordingActive(true);
      setLastSavedId('');
      setStatus('Recording on-device · live file is in document storage · keep LectureAI open');
    } catch (error) {
      setStatus('Recording did not start');
      setWarning(error instanceof Error ? error.message : 'Could not start recording.');
    }
  }

  function pauseRecording() {
    if (!recordingActive || paused) return;
    try {
      recorder.pause();
      setPaused(true);
      setStatus('Paused · same recording session preserved');
    } catch {
      setWarning('LectureAI could not pause cleanly. Finish and verify the recording if anything looks wrong.');
    }
  }

  function resumeRecording() {
    if (!recordingActive || !paused) return;
    try {
      recorder.record();
      setPaused(false);
      setStatus('Recording continued');
    } catch {
      setWarning('LectureAI could not resume the same recording. Finish and verify what was captured.');
    }
  }

  function markMoment() {
    if (!recordingActive) return;
    const timeMs = Math.max(0, recorderState.durationMillis || Math.round(recorder.currentTime * 1000));
    setMarks((current) => [...current, { id: newId(), timeMs, label: `Important moment ${current.length + 1}` }]);
  }

  async function finishRecording() {
    if (!recordingActive) return;
    const durationMs = Math.max(0, recorderState.durationMillis || Math.round(recorder.currentTime * 1000));
    try {
      setStatus('Finishing and preserving original audio…');
      await recorder.stop();
      await KeepAwake.deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
      setRecordingActive(false);
      setPaused(false);

      const uri = recorder.uri || recorderState.url;
      if (!uri) throw new Error('The native recorder stopped but did not return an audio file path.');
      const id = newId();
      const preserved = await preserveAudioFile(uri, id, title, 'm4a');
      const lecture = createLecture({ id, title, audio: preserved, durationMs, marks, source: 'recorded' });
      await upsertLecture(lecture);
      await refresh();
      setLastSavedId(id);
      setStatus('Original audio preserved in LectureAI document storage · listen before trusting it');
      player.replace({ uri: preserved.uri });
      if (settings.autoOpenShareSheet) void shareAudio(lecture).catch(() => undefined);
    } catch (error) {
      await KeepAwake.deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
      setRecordingActive(false);
      setPaused(false);
      setStatus('Recording needs attention');
      setWarning(error instanceof Error ? error.message : 'LectureAI could not finish this recording safely.');
    }
  }

  async function verifyLastSaved() {
    if (!lastSaved) return;
    const updated = markAudioVerified(lastSaved);
    await upsertLecture(updated);
    await refresh();
    setStatus('Original audio playback confirmed');
  }

  function openLecture(lecture, nextTab = 'audio') {
    setSelectedId(lecture.id);
    setDetailTab(nextTab);
    if (lecture.audioUri) player.replace({ uri: lecture.audioUri });
  }

  async function importAudio() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['audio/*', 'audio/mp4', 'audio/mpeg', 'audio/wav'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset?.uri) throw new Error('The selected recording could not be opened.');
      if ((asset.size || 0) > Paths.availableDiskSpace) throw new Error('There is not enough free device storage to preserve this recording.');
      const id = newId();
      const importedTitle = String(asset.name || 'Imported lecture').replace(/\.[^.]+$/, '');
      const ext = String(asset.name || '').split('.').pop() || 'm4a';
      const preserved = await preserveAudioFile(asset.uri, id, importedTitle, ext);
      const lecture = createLecture({ id, title: importedTitle, audio: preserved, durationMs: 0, marks: [], source: 'imported' });
      await upsertLecture(lecture);
      await refresh();
      openLecture(lecture, 'audio');
    } catch (error) {
      Alert.alert('Import failed', error instanceof Error ? error.message : 'Could not import this recording.');
    }
  }

  async function importTranscript(lecture) {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/json'], copyToCacheDirectory: true, multiple: false });
      if (result.canceled) return;
      const file = new File(result.assets[0]);
      const payload = JSON.parse(await file.text());
      const segments = normalizeImportedTranscript(payload, lecture.id);
      const updated = replaceTranscript(lecture, segments, 'import');
      await upsertLecture(updated);
      await refresh();
      setDetailTab('transcript');
    } catch (error) {
      Alert.alert('Transcript import failed', error instanceof Error ? error.message : 'Could not read this transcript.');
    }
  }

  async function saveTranscriptEdit(lecture, segmentId, text) {
    const updated = updateTranscriptSegment(lecture, segmentId, text);
    await upsertLecture(updated);
    await refresh();
  }

  async function generateStudy(lecture) {
    const updated = applyStudyPack(lecture);
    await upsertLecture(updated);
    await refresh();
    setDetailTab('study');
  }

  async function deleteLecture(lecture) {
    Alert.alert('Delete lecture?', 'This removes the original audio and its LectureAI data from this Expo project. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void removeLecture(lecture).then(async () => {
            if (selectedId === lecture.id) setSelectedId('');
            if (lastSavedId === lecture.id) setLastSavedId('');
            await refresh();
          });
        },
      },
    ]);
  }

  if (!ready) {
    return <SafeAreaView style={styles.safeArea}><View style={styles.loading}><Text style={styles.brand}>LectureAI</Text><Text style={styles.muted}>Opening your local lecture library…</Text></View></SafeAreaView>;
  }

  if (selectedLecture) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <LectureDetail
          lecture={selectedLecture}
          detailTab={detailTab}
          setDetailTab={setDetailTab}
          player={player}
          playerStatus={playerStatus}
          onBack={() => { player.pause(); setSelectedId(''); }}
          onVerify={async () => { await upsertLecture(markAudioVerified(selectedLecture)); await refresh(); }}
          onShare={() => void shareAudio(selectedLecture).catch((error) => Alert.alert('Share failed', error.message))}
          onImportTranscript={() => void importTranscript(selectedLecture)}
          onSaveTranscriptEdit={(id, value) => void saveTranscriptEdit(selectedLecture, id, value)}
          onGenerateStudy={() => void generateStudy(selectedLecture)}
          onDelete={() => deleteLecture(selectedLecture)}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.app}>
        <Header />
        <View style={styles.body}>
          {tab === 'record' && (
            <RecordScreen
              title={title}
              setTitle={setTitle}
              recorderState={recorderState}
              recordingActive={recordingActive}
              paused={paused}
              status={status}
              warning={warning}
              level={level}
              marks={marks}
              inputName={inputName}
              freeDisk={freeDisk}
              lastSaved={lastSaved}
              player={player}
              playerStatus={playerStatus}
              onStart={startRecording}
              onPause={pauseRecording}
              onResume={resumeRecording}
              onMark={markMoment}
              onFinish={finishRecording}
              onVerify={verifyLastSaved}
              onOpen={() => lastSaved && openLecture(lastSaved)}
              onShare={() => lastSaved && void shareAudio(lastSaved).catch((error) => Alert.alert('Share failed', error.message))}
            />
          )}
          {tab === 'lectures' && <Library lectures={lectures} onOpen={openLecture} onImport={importAudio} />}
          {tab === 'study' && <StudyHome lectures={lectures} onOpen={(lecture) => openLecture(lecture, 'study')} />}
          {tab === 'settings' && <SettingsScreen settings={settings} onChange={persistSettings} freeDisk={freeDisk} />}
        </View>
        <TabBar tab={tab} setTab={setTab} />
      </View>
    </SafeAreaView>
  );
}

function Header() {
  return (
    <View style={styles.header}>
      <View><Text style={styles.brand}>LectureAI</Text><Text style={styles.headerSub}>Local-first lecture recorder & study workspace</Text></View>
      <View style={styles.freePill}><Text style={styles.freePillText}>FREE · EXPO GO</Text></View>
    </View>
  );
}

function TabBar({ tab, setTab }) {
  return (
    <View style={styles.tabBar}>
      {[['record', '●', 'Record'], ['lectures', '▤', 'Lectures'], ['study', '✦', 'Study'], ['settings', '⚙', 'Settings']].map(([id, icon, label]) => (
        <Pressable key={id} style={[styles.tabButton, tab === id && styles.tabButtonActive]} onPress={() => setTab(id)}>
          <Text style={[styles.tabIcon, tab === id && styles.tabTextActive]}>{icon}</Text>
          <Text style={[styles.tabText, tab === id && styles.tabTextActive]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function RecordScreen({ title, setTitle, recorderState, recordingActive, paused, status, warning, level, marks, inputName, freeDisk, lastSaved, player, playerStatus, onStart, onPause, onResume, onMark, onFinish, onVerify, onOpen, onShare }) {
  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Text style={styles.eyebrow}>NATIVE AUDIO THROUGH EXPO GO</Text>
      <Text style={styles.hero}>Record the lecture. Keep the original.</Text>
      <Text style={styles.lead}>The live recording is written to persistent document storage, then the finished original is preserved in LectureAI's recording library. Transcripts, notes and study tools never replace it.</Text>

      <View style={styles.card}>
        <TextInput style={styles.titleInput} value={title} onChangeText={setTitle} editable={!recordingActive} placeholder="Lecture title" />
        <View style={styles.statusRow}><View style={[styles.statusDot, recordingActive && !paused && styles.statusDotLive]} /><Text style={styles.statusText}>{status}</Text></View>
        {inputName ? <Text style={styles.meta}>Input: {inputName}</Text> : null}
        <Text style={styles.timer}>{formatDuration(recorderState.durationMillis)}</Text>
        <View style={styles.meter}><View style={[styles.meterFill, { width: `${Math.max(1, level * 100)}%` }]} /></View>
        <Text style={styles.meterLabel}>{paused ? 'Paused' : level < 0.08 && recordingActive ? 'Audio is quiet — recording continues' : level > 0.94 ? 'Very loud — clipping may be possible' : recordingActive ? 'Audio level active' : 'Microphone meter appears while recording'}</Text>

        {!recordingActive ? (
          <PrimaryButton label="Start recording" onPress={onStart} />
        ) : (
          <>
            <View style={styles.buttonRow}>
              <SecondaryButton label={`Mark (${marks.length})`} onPress={onMark} />
              {paused ? <SecondaryButton label="Continue" onPress={onResume} /> : <SecondaryButton label="Pause" onPress={onPause} />}
            </View>
            <DangerButton label="Finish & save" onPress={onFinish} />
          </>
        )}
      </View>

      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>Recording safety</Text>
        <Text style={styles.infoText}>• High-quality native Expo audio with 48 kHz / mono / 192 kbps preferences.</Text>
        <Text style={styles.infoText}>• The active recording file is placed in document storage, not temporary cache, before the lecture ends.</Text>
        <Text style={styles.infoText}>• Keep Expo Go open during important lectures. Stock Expo Go cannot add LectureAI's own iOS background-audio capability.</Text>
        <Text style={styles.infoText}>• Free device storage: {formatBytes(freeDisk)}.</Text>
        <Text style={styles.infoText}>• A saved file is not called verified until you listen to it and confirm playback.</Text>
      </View>

      {warning ? <View style={styles.warningCard}><Text style={styles.warningTitle}>Check this</Text><Text style={styles.warningText}>{warning}</Text></View> : null}

      {lastSaved ? (
        <View style={styles.savedCard}>
          <Text style={styles.eyebrow}>ORIGINAL AUDIO PRESERVED</Text>
          <Text style={styles.cardTitle}>{lastSaved.title}</Text>
          <Text style={styles.meta}>{formatDuration(lastSaved.durationMs)} · {formatBytes(lastSaved.size)} · {lastSaved.marks.length} marks</Text>
          <View style={styles.buttonRow}>
            <SecondaryButton label={playerStatus.playing ? 'Pause audio' : 'Play audio'} onPress={() => playerStatus.playing ? player.pause() : player.play()} />
            <SecondaryButton label="Share / Save to Files" onPress={onShare} />
          </View>
          {lastSaved.audioVerification !== 'user-playback-confirmed' ? <PrimaryButton label="I listened — audio is clear" onPress={onVerify} /> : <View style={styles.successBox}><Text style={styles.successText}>✓ Playback confirmed by you</Text></View>}
          <SecondaryButton label="Open lecture workspace" onPress={onOpen} />
        </View>
      ) : null}
    </ScrollView>
  );
}

function Library({ lectures, onOpen, onImport }) {
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.sectionHead}><View><Text style={styles.eyebrow}>LOCAL LIBRARY</Text><Text style={styles.sectionTitle}>Lectures</Text></View><SecondaryButton label="Import audio" onPress={onImport} compact /></View>
      {!lectures.length ? <Empty title="No lectures yet" body="Record a lecture or import an existing audio file. The original stays in LectureAI document storage." /> : lectures.map((lecture) => (
        <Pressable key={lecture.id} style={styles.listCard} onPress={() => onOpen(lecture)}>
          <View style={styles.listCardTop}><Text style={styles.listTitle}>{lecture.title}</Text><Text style={styles.chevron}>›</Text></View>
          <Text style={styles.meta}>{new Date(lecture.createdAt).toLocaleString()} · {formatDuration(lecture.durationMs)} · {formatBytes(lecture.size)}</Text>
          {lecture.recoveryNotice ? <Text style={styles.recoveryText}>Recovered original audio · open and verify playback</Text> : null}
          <View style={styles.badgeRow}><Badge text={lecture.recoveryNotice ? 'Recovered audio — verify' : lecture.audioVerification === 'user-playback-confirmed' ? 'Audio verified' : 'Audio needs listen check'} good={!lecture.recoveryNotice && lecture.audioVerification === 'user-playback-confirmed'} /><Badge text={lecture.transcriptStatus === 'ready' ? 'Transcript ready' : 'No transcript'} good={lecture.transcriptStatus === 'ready'} /></View>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function StudyHome({ lectures, onOpen }) {
  const ready = lectures.filter((lecture) => lecture.transcriptStatus === 'ready');
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Text style={styles.eyebrow}>SOURCE-GROUNDED STUDY</Text><Text style={styles.sectionTitle}>Study</Text>
      <Text style={styles.lead}>Study material is generated from trustworthy transcript sections and keeps timestamps back to the lecture. Transcript edits mark derived content stale.</Text>
      {!ready.length ? <Empty title="Transcribe or import a transcript first" body="Once a lecture has timestamped text, LectureAI can build whole-lecture notes, concepts, definitions, examples and study questions." /> : ready.map((lecture) => (
        <Pressable key={lecture.id} style={styles.listCard} onPress={() => onOpen(lecture)}>
          <View style={styles.listCardTop}><Text style={styles.listTitle}>{lecture.title}</Text><Text style={styles.chevron}>›</Text></View>
          <Text style={styles.meta}>{lecture.transcript.length} timestamped segments</Text>
          <Badge text={derivedContentIsFresh(lecture) ? 'Study pack current' : 'Study pack needs update'} good={derivedContentIsFresh(lecture)} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

function SettingsScreen({ settings, onChange, freeDisk }) {
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Text style={styles.eyebrow}>LECTUREAI</Text><Text style={styles.sectionTitle}>Settings</Text>
      <SettingRow title="Keep screen awake while recording" description="Recommended for Expo Go because background/locked-screen recording is not guaranteed." value={settings.keepScreenAwake} onToggle={() => onChange({ keepScreenAwake: !settings.keepScreenAwake })} />
      <SettingRow title="Open share sheet after save" description="Optional. The original is already preserved locally before sharing." value={settings.autoOpenShareSheet} onToggle={() => onChange({ autoOpenShareSheet: !settings.autoOpenShareSheet })} />
      <View style={styles.infoCard}><Text style={styles.infoTitle}>Device storage</Text><Text style={styles.infoText}>{formatBytes(freeDisk)} available. LectureAI does not impose a recording-minute quota; real storage and device limits still apply.</Text></View>
      <View style={styles.infoCard}><Text style={styles.infoTitle}>Transcription status</Text><Text style={styles.infoText}>This Expo-Go build intentionally does not pretend the browser Whisper worker can run natively. Timestamped JSON import works now. A secure computer-pairing transcription path and a validated Expo-compatible on-device engine are separate milestones.</Text></View>
      <View style={styles.infoCard}><Text style={styles.infoTitle}>Privacy & recovery</Text><Text style={styles.infoText}>Original recordings live in the project's document directory. Lecture metadata is stored locally with a second document-directory metadata backup, and LectureAI scans for orphaned original audio on launch so a metadata failure does not silently hide a preserved recording. Nothing is automatically uploaded to a paid speech service.</Text></View>
    </ScrollView>
  );
}

function LectureDetail({ lecture, detailTab, setDetailTab, player, playerStatus, onBack, onVerify, onShare, onImportTranscript, onSaveTranscriptEdit, onGenerateStudy, onDelete }) {
  const fresh = derivedContentIsFresh(lecture);
  return (
    <View style={styles.app}>
      <View style={styles.detailHeader}>
        <Pressable onPress={onBack}><Text style={styles.back}>‹ Lectures</Text></Pressable>
        <Text style={styles.detailTitle}>{lecture.title}</Text>
        <Text style={styles.meta}>{formatDuration(lecture.durationMs)} · {formatBytes(lecture.size)}</Text>
      </View>
      <View style={styles.detailTabs}>{['audio','transcript','notes','study'].map((id) => <Pressable key={id} onPress={() => setDetailTab(id)} style={[styles.detailTab, detailTab === id && styles.detailTabActive]}><Text style={[styles.detailTabText, detailTab === id && styles.detailTabTextActive]}>{id === 'audio' ? 'Audio' : id === 'transcript' ? 'Transcript' : id === 'notes' ? 'Notes' : 'Study'}</Text></Pressable>)}</View>
      <ScrollView contentContainerStyle={styles.scroll}>
        {detailTab === 'audio' && (
          <>
            {lecture.recoveryNotice ? <View style={styles.warningCard}><Text style={styles.warningTitle}>Recovered original audio</Text><Text style={styles.warningText}>{lecture.recoveryNotice}</Text></View> : null}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Original recording</Text>
              <Text style={styles.meta}>{lecture.audioFilename} · {lecture.audioMd5 ? `MD5 ${lecture.audioMd5.slice(0, 10)}…` : 'file hash unavailable'}</Text>
              <Text style={styles.playTime}>{formatTime(playerStatus.currentTime)} / {formatTime(playerStatus.duration || lecture.durationMs / 1000)}</Text>
              <View style={styles.buttonRow}><SecondaryButton label={playerStatus.playing ? 'Pause' : 'Play'} onPress={() => playerStatus.playing ? player.pause() : player.play()} /><SecondaryButton label="Back 10s" onPress={() => player.seekTo(Math.max(0, playerStatus.currentTime - 10))} /><SecondaryButton label="+10s" onPress={() => player.seekTo(Math.min(playerStatus.duration || 1e9, playerStatus.currentTime + 10))} /></View>
              <SecondaryButton label="Share / Save to Files" onPress={onShare} />
              {lecture.audioVerification === 'user-playback-confirmed' ? <View style={styles.successBox}><Text style={styles.successText}>✓ You confirmed this recording plays clearly.</Text></View> : <PrimaryButton label="I listened — audio is clear" onPress={onVerify} />}
            </View>
            {lecture.marks.length ? <View style={styles.infoCard}><Text style={styles.infoTitle}>Marked moments</Text>{lecture.marks.map((mark) => <Pressable key={mark.id} onPress={() => player.seekTo(mark.timeMs / 1000)}><Text style={styles.sourceLink}>{formatDuration(mark.timeMs)} · {mark.label}</Text></Pressable>)}</View> : null}
            <DangerButton label="Delete lecture & original audio" onPress={onDelete} />
          </>
        )}
        {detailTab === 'transcript' && (
          <>
            <View style={styles.infoCard}><Text style={styles.infoTitle}>Timestamped transcript</Text><Text style={styles.infoText}>The original audio remains the source of truth. Imported or future AI transcript text can be corrected without changing the recording.</Text></View>
            {!lecture.transcript.length ? <Empty title="No transcript yet" body="Import timestamped transcript JSON for now. The secure wireless computer transcription path and validated Expo-native local transcription are being built without pretending they already work." action={<PrimaryButton label="Import transcript JSON" onPress={onImportTranscript} />} /> : lecture.transcript.map((segment) => (
              <View key={segment.id} style={[styles.transcriptRow, segment.uncertain && styles.uncertainRow]}>
                <Pressable onPress={() => { player.seekTo(segment.startTime); player.play(); }}><Text style={styles.timestamp}>{formatTime(segment.startTime)} – {formatTime(segment.endTime)}</Text></Pressable>
                <TextInput multiline style={styles.transcriptInput} defaultValue={segment.editedText} onEndEditing={(event) => onSaveTranscriptEdit(segment.id, event.nativeEvent.text)} />
                <Text style={styles.meta}>{segment.uncertain ? 'Needs verification against audio' : segment.manuallyReviewed ? 'Reviewed' : 'Machine/imported text'}</Text>
              </View>
            ))}
            {lecture.transcript.length ? <SecondaryButton label="Replace / import transcript JSON" onPress={onImportTranscript} /> : null}
          </>
        )}
        {detailTab === 'notes' && (
          <StudyPackView lecture={lecture} mode="notes" fresh={fresh} onGenerate={onGenerateStudy} player={player} />
        )}
        {detailTab === 'study' && (
          <StudyPackView lecture={lecture} mode="study" fresh={fresh} onGenerate={onGenerateStudy} player={player} />
        )}
      </ScrollView>
    </View>
  );
}

function StudyPackView({ lecture, mode, fresh, onGenerate, player }) {
  const pack = lecture.studyPack;
  if (!lecture.transcript.length) return <Empty title="A transcript is required" body="Study material should never be invented without source text. Import or generate a timestamped transcript first." />;
  if (!pack || !fresh) return <Empty title={pack ? 'Transcript changed' : 'Study pack not generated yet'} body={pack ? 'Your transcript is newer than the current notes. Update derived content so corrections propagate instead of leaving stale notes.' : 'Generate a source-grounded pack from trustworthy transcript sections across the whole lecture.'} action={<PrimaryButton label={pack ? 'Update derived content' : 'Generate study pack'} onPress={onGenerate} />} />;

  const sourceList = (sectionTitle, items) => items?.length ? <View style={styles.studySection}><Text style={styles.studyHeading}>{sectionTitle}</Text>{items.map((item, index) => <View key={`${sectionTitle}-${index}`} style={styles.studyItem}><Text style={styles.studyText}>{item.text}</Text>{item.source ? <Pressable onPress={() => { player.seekTo(item.source.startTime); player.play(); }}><Text style={styles.sourceLink}>▶ {formatTime(item.source.startTime)} source audio</Text></Pressable> : null}</View>)}</View> : null;

  return (
    <>
      {pack.warning ? <View style={styles.warningCard}><Text style={styles.warningText}>{pack.warning}</Text></View> : null}
      {mode === 'notes' ? (
        <>
          {sourceList('Lecture summary', pack.summary)}
          {sourceList('Detailed lecture notes', pack.detailedNotes)}
          <View style={styles.studySection}><Text style={styles.studyHeading}>Key concepts</Text><View style={styles.badgeRow}>{pack.keyConcepts.map((concept) => <Badge key={concept} text={concept} good />)}</View></View>
          {sourceList('Definitions', pack.definitions)}
          {sourceList('Examples', pack.examples)}
          {sourceList('Formulas / technical information', pack.technicalInformation)}
          {sourceList('Lecture emphasis', pack.professorEmphasis)}
        </>
      ) : (
        <>
          <View style={styles.studySection}><Text style={styles.studyHeading}>Possible exam review topics</Text>{pack.possibleExamTopics.map((item, index) => <View key={index} style={styles.studyItem}><Text style={styles.studyText}>{item.topic}</Text><Text style={styles.meta}>{item.note}</Text></View>)}</View>
          <View style={styles.studySection}><Text style={styles.studyHeading}>Study questions</Text>{pack.studyQuestions.map((item, index) => <View key={index} style={styles.studyItem}><Text style={styles.questionType}>{item.type.toUpperCase()}</Text><Text style={styles.studyText}>{item.question}</Text></View>)}</View>
        </>
      )}
      <SecondaryButton label="Regenerate from current transcript" onPress={onGenerate} />
    </>
  );
}

function SettingRow({ title, description, value, onToggle }) {
  return <Pressable style={styles.settingRow} onPress={onToggle}><View style={{ flex: 1 }}><Text style={styles.settingTitle}>{title}</Text><Text style={styles.meta}>{description}</Text></View><View style={[styles.switch, value && styles.switchOn]}><View style={[styles.switchKnob, value && styles.switchKnobOn]} /></View></Pressable>;
}

function Badge({ text, good = false }) {
  return <View style={[styles.badge, good && styles.badgeGood]}><Text style={[styles.badgeText, good && styles.badgeTextGood]}>{text}</Text></View>;
}

function Empty({ title, body, action = null }) {
  return <View style={styles.empty}><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.muted}>{body}</Text>{action ? <View style={{ marginTop: 14 }}>{action}</View> : null}</View>;
}

function PrimaryButton({ label, onPress }) {
  return <Pressable style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]} onPress={onPress}><Text style={styles.primaryButtonText}>{label}</Text></Pressable>;
}

function SecondaryButton({ label, onPress, compact = false }) {
  return <Pressable style={({ pressed }) => [styles.secondaryButton, compact && styles.compactButton, pressed && styles.pressed]} onPress={onPress}><Text style={styles.secondaryButtonText}>{label}</Text></Pressable>;
}

function DangerButton({ label, onPress }) {
  return <Pressable style={({ pressed }) => [styles.dangerButton, pressed && styles.pressed]} onPress={onPress}><Text style={styles.dangerButtonText}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#F7F7F2' },
  app: { flex: 1 },
  body: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#DDE5E0' },
  brand: { color: '#173129', fontWeight: '900', fontSize: 20 },
  headerSub: { color: '#72867D', fontSize: 11, marginTop: 2 },
  freePill: { backgroundColor: '#E4EFE9', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5 },
  freePillText: { color: '#214F3D', fontWeight: '900', fontSize: 9, letterSpacing: .6 },
  scroll: { padding: 20, paddingBottom: 42 },
  eyebrow: { color: '#527064', fontWeight: '900', fontSize: 10, letterSpacing: 1.1, marginBottom: 7 },
  hero: { color: '#173129', fontWeight: '900', fontSize: 32, lineHeight: 36, letterSpacing: -.8 },
  sectionTitle: { color: '#173129', fontWeight: '900', fontSize: 30, letterSpacing: -.6 },
  lead: { color: '#587066', fontSize: 15, lineHeight: 22, marginTop: 9 },
  card: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#DFE8E3', borderRadius: 22, padding: 18, marginTop: 20 },
  titleInput: { borderBottomWidth: 1, borderBottomColor: '#DDE5E0', paddingVertical: 10, color: '#173129', fontSize: 18, fontWeight: '800' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 },
  statusDot: { width: 9, height: 9, borderRadius: 9, backgroundColor: '#A9B6AF' },
  statusDotLive: { backgroundColor: '#D44949' },
  statusText: { flex: 1, color: '#476157', fontSize: 13, fontWeight: '700' },
  meta: { color: '#718078', fontSize: 12, lineHeight: 18, marginTop: 5 },
  timer: { textAlign: 'center', color: '#173129', fontWeight: '900', fontSize: 52, letterSpacing: -1.3, fontVariant: ['tabular-nums'], marginVertical: 24 },
  meter: { height: 8, backgroundColor: '#E7ECE9', borderRadius: 10, overflow: 'hidden' },
  meterFill: { height: '100%', backgroundColor: '#315F4B', borderRadius: 10 },
  meterLabel: { color: '#72867D', fontSize: 11, textAlign: 'center', marginTop: 7, marginBottom: 15 },
  primaryButton: { minHeight: 52, borderRadius: 16, backgroundColor: '#214F3D', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 15, marginTop: 11 },
  primaryButtonText: { color: '#FFF', fontWeight: '900', fontSize: 15 },
  secondaryButton: { minHeight: 48, borderRadius: 15, borderWidth: 1, borderColor: '#C8D8D0', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 13, marginTop: 10, flex: 1 },
  compactButton: { flex: 0, minHeight: 42, marginTop: 0 },
  secondaryButtonText: { color: '#214F3D', fontWeight: '800', fontSize: 13, textAlign: 'center' },
  dangerButton: { minHeight: 50, borderRadius: 15, backgroundColor: '#8F3D3D', alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  dangerButtonText: { color: '#FFF', fontWeight: '900', fontSize: 14 },
  pressed: { opacity: .72 },
  buttonRow: { flexDirection: 'row', gap: 9 },
  infoCard: { backgroundColor: '#EDF3EF', borderRadius: 18, padding: 16, marginTop: 14 },
  infoTitle: { color: '#173129', fontWeight: '900', fontSize: 15, marginBottom: 5 },
  infoText: { color: '#456257', fontSize: 13, lineHeight: 20, marginTop: 3 },
  warningCard: { backgroundColor: '#FFF0DB', borderRadius: 18, padding: 16, marginTop: 14 },
  warningTitle: { color: '#6E4A16', fontWeight: '900', fontSize: 14 },
  warningText: { color: '#795D32', fontSize: 13, lineHeight: 19, marginTop: 4 },
  recoveryText: { color: '#8A5D1F', fontSize: 12, fontWeight: '800', marginTop: 7 },
  savedCard: { backgroundColor: '#FFF', borderRadius: 20, borderWidth: 1, borderColor: '#CFE1D8', padding: 17, marginTop: 16 },
  cardTitle: { color: '#173129', fontWeight: '900', fontSize: 19 },
  successBox: { backgroundColor: '#E6F2EB', borderRadius: 13, padding: 12, marginTop: 11 },
  successText: { color: '#246046', fontSize: 13, fontWeight: '800' },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 },
  listCard: { backgroundColor: '#FFF', borderRadius: 18, borderWidth: 1, borderColor: '#DFE8E3', padding: 16, marginTop: 11 },
  listCardTop: { flexDirection: 'row', alignItems: 'center' },
  listTitle: { flex: 1, color: '#173129', fontWeight: '900', fontSize: 16 },
  chevron: { color: '#61766C', fontSize: 26 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  badge: { backgroundColor: '#F0F1EF', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5 },
  badgeGood: { backgroundColor: '#E2F0E8' },
  badgeText: { color: '#6E7873', fontSize: 10, fontWeight: '800' },
  badgeTextGood: { color: '#2D634D' },
  empty: { backgroundColor: '#FFF', borderRadius: 20, borderWidth: 1, borderColor: '#DFE8E3', padding: 20, marginTop: 16 },
  emptyTitle: { color: '#173129', fontWeight: '900', fontSize: 17, marginBottom: 6 },
  muted: { color: '#72867D', fontSize: 13, lineHeight: 20 },
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: '#FFF', borderWidth: 1, borderColor: '#DFE8E3', borderRadius: 18, padding: 16, marginTop: 11 },
  settingTitle: { color: '#173129', fontWeight: '900', fontSize: 14 },
  switch: { width: 44, height: 26, borderRadius: 20, padding: 3, backgroundColor: '#CBD4CF' },
  switchOn: { backgroundColor: '#315F4B' },
  switchKnob: { width: 20, height: 20, borderRadius: 20, backgroundColor: '#FFF' },
  switchKnobOn: { alignSelf: 'flex-end' },
  tabBar: { minHeight: 66, flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#D9E2DD', backgroundColor: '#FBFCFA', paddingHorizontal: 8, paddingBottom: 4 },
  tabButton: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: 13, marginVertical: 5 },
  tabButtonActive: { backgroundColor: '#E9F0EC' },
  tabIcon: { color: '#7A8B83', fontSize: 16 },
  tabText: { color: '#7A8B83', fontWeight: '700', fontSize: 10 },
  tabTextActive: { color: '#214F3D' },
  detailHeader: { padding: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#D9E2DD' },
  back: { color: '#315F4B', fontWeight: '800', fontSize: 13, marginBottom: 10 },
  detailTitle: { color: '#173129', fontWeight: '900', fontSize: 24 },
  detailTabs: { flexDirection: 'row', paddingHorizontal: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#D9E2DD' },
  detailTab: { flex: 1, alignItems: 'center', paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  detailTabActive: { borderBottomColor: '#315F4B' },
  detailTabText: { color: '#7A8B83', fontWeight: '800', fontSize: 11 },
  detailTabTextActive: { color: '#214F3D' },
  playTime: { color: '#173129', fontWeight: '900', fontVariant: ['tabular-nums'], fontSize: 24, marginTop: 20, marginBottom: 8 },
  sourceLink: { color: '#2E6A50', fontWeight: '800', fontSize: 12, paddingVertical: 6 },
  transcriptRow: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#DFE8E3', borderRadius: 17, padding: 14, marginTop: 10 },
  uncertainRow: { borderColor: '#DCA85B', backgroundColor: '#FFFAF1' },
  timestamp: { color: '#315F4B', fontSize: 11, fontWeight: '900', marginBottom: 8 },
  transcriptInput: { color: '#1C2B25', fontSize: 15, lineHeight: 21, minHeight: 44, textAlignVertical: 'top' },
  studySection: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#DFE8E3', borderRadius: 18, padding: 16, marginTop: 12 },
  studyHeading: { color: '#173129', fontWeight: '900', fontSize: 17, marginBottom: 5 },
  studyItem: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E2E8E4', paddingTop: 10, marginTop: 9 },
  studyText: { color: '#24372F', fontSize: 14, lineHeight: 20 },
  questionType: { color: '#527064', fontWeight: '900', fontSize: 9, letterSpacing: .8, marginBottom: 4 },
});
