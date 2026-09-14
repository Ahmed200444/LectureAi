import React, { useEffect, useRef, useState } from 'react';
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
import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import {
  createLecture,
  deleteEnhancedAudioCopy,
  defaultSettings,
  installEnhancedAudioFile,
  inspectProtectedOriginal,
  loadLibrary,
  loadSettings,
  markAudioPlaybackPoint,
  markAudioVerified,
  prepareTranscriptionAudio,
  preserveAudioFile,
  removeReplacedEnhancedAudio,
  removeLecture,
  replaceTranscript,
  saveLibrary,
  saveSettings,
  updateTranscriptSegment,
  upsertLecture,
} from './src/storage';
import { applyStudyPack, derivedContentIsFresh } from './src/study';
import {
  cancelComputerJob,
  computerHealth,
  computerJobStatus,
  downloadEnhancedFromComputer,
  generateEnhancedOnComputer,
  pairWithComputer,
  releaseComputerEnhancement,
  transcribeOnComputer,
} from './src/computer';
import { currentEnhancedAudio } from './src/audio-derivatives';
import { exportEnglishTranscript, exportSourceTranscript, exportTranscript } from './src/exports';
import { lectureDisplayTitle, renameLectureTitle, untitledLectureTitle } from './src/lecture-metadata';
import { parseLaptopPairingQr } from './src/qr-pairing';
import PairingScanner from './src/PairingScanner';
import { foregroundRecorderDecision } from './src/background-recording';
import {
  clearActiveRecordingJournal,
  recoverInterruptedRecording,
  saveActiveRecordingJournal,
} from './src/recording-journal';

const KEEP_AWAKE_TAG = 'lectureai-recording';
const LOW_STORAGE_BYTES = 500 * 1024 * 1024;
const RUNNING_IN_EXPO_GO = Constants.executionEnvironment === 'storeClient' || Constants.appOwnership === 'expo';
const RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  directory: 'document',
  sampleRate: 48_000,
  numberOfChannels: 1,
  bitRate: 192_000,
  isMeteringEnabled: true,
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

function stripWhisperControlTokens(value) {
  return String(value ?? '')
    .replace(/<\|(?:startoftranscript|endoftext|transcribe|translate|notimestamps|[a-z]{2}|\d+(?:\.\d+)?)\|>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function windowsJobSnapshot(job, previous = null, transcriptVersion = 0) {
  return {
    id: String(job?.id || job?.job_id || previous?.id || ''),
    status: String(job?.status || previous?.status || 'queued'),
    progress: Math.max(0, Math.min(100, Number(job?.progress ?? previous?.progress ?? 0))),
    message: String(job?.message || previous?.message || 'Windows transcription job saved.'),
    completedAudioSeconds: Number(job?.completed_audio_seconds ?? previous?.completedAudioSeconds ?? 0),
    totalAudioSeconds: Number(job?.total_audio_seconds ?? previous?.totalAudioSeconds ?? 0),
    lastProgressAt: Number(job?.last_progress_at ?? previous?.lastProgressAt ?? 0) || null,
    updatedAt: new Date().toISOString(),
    baseTranscriptVersion: Number(previous?.baseTranscriptVersion ?? transcriptVersion ?? 0),
    resumeAvailable: Boolean(job?.resume_available),
    stage: String(job?.stage || previous?.stage || ''),
    elapsedSeconds: Number(job?.elapsed_seconds ?? previous?.elapsedSeconds ?? 0),
    etaSeconds: typeof job?.eta_seconds === 'number' && Number.isFinite(job.eta_seconds)
      ? job.eta_seconds
      : job && Object.prototype.hasOwnProperty.call(job, 'eta_seconds') ? null : (previous?.etaSeconds ?? null),
    model: String(job?.model || previous?.model || ''),
    device: String(job?.device || previous?.device || ''),
    computeType: String(job?.compute_type || previous?.computeType || ''),
    audioInputSource: String(job?.audio_input_source || previous?.audioInputSource || 'original') === 'enhanced' ? 'enhanced' : 'original',
  };
}

function normalizeTranscriptPayload(payload, lectureId) {
  const root = payload?.lecture && typeof payload.lecture === 'object' ? payload.lecture : payload;
  const rows = Array.isArray(root) ? root : root?.segments || root?.currentEditableTranscript;
  if (!Array.isArray(rows)) throw new Error('Transcript data must contain a segments array.');
  const ids = new Set();
  return rows.map((row, index) => {
    const start = Number(row.start ?? row.startTime ?? 0);
    const end = Number(row.end ?? row.endTime ?? start);
    const text = stripWhisperControlTokens(row.editedText ?? row.originalText ?? row.text);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      throw new Error(`Transcript segment ${index + 1} has invalid text or timestamps.`);
    }
    const id = String(row.id || `${lectureId}-segment-${index + 1}`);
    if (ids.has(id)) throw new Error(`Transcript segment ${index + 1} has a duplicate ID.`);
    ids.add(id);
    return {
      id,
      startTime: start,
      endTime: end,
      originalText: text,
      editedText: text,
      manuallyReviewed: Boolean(row.manuallyReviewed),
      uncertain: Boolean(row.uncertain) || /^\s*\[(?:uncertain|inaudible)\]/i.test(text),
      speaker: String(row.speaker || 'Speaker'),
      words: Array.isArray(row.words) ? row.words : undefined,
    };
  }).sort((a, b) => a.startTime - b.startTime);
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

async function shareAudio(lecture) {
  if (!lecture?.audioUri) return;
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error('The system share sheet is not available on this device.');
  await Sharing.shareAsync(lecture.audioUri, {
    dialogTitle: `Share ${lecture.title}`,
    mimeType: audioMime(lecture.audioFilename),
  });
}

export default function App({ onOpenExports = () => {} }) {
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
  const [title, setTitle] = useState(() => untitledLectureTitle());
  const [paused, setPaused] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const [marks, setMarks] = useState([]);
  const [status, setStatus] = useState('Ready to record');
  const [warning, setWarning] = useState('');
  const [inputName, setInputName] = useState('');
  const [lastSavedId, setLastSavedId] = useState('');
  const [computerProgress, setComputerProgress] = useState(null);
  const [enhancementProgress, setEnhancementProgress] = useState(null);
  const [cleanupMode, setCleanupMode] = useState('balanced');
  const [playbackSource, setPlaybackSource] = useState('original');
  const [nativeRecordingConfirmed, setNativeRecordingConfirmed] = useState(false);
  const [sessionDurationMs, setSessionDurationMs] = useState(0);
  const [foregroundRecorderChecking, setForegroundRecorderChecking] = useState(false);
  const recordingStartedAt = useRef(null);
  const journalSnapshot = useRef({});
  const finalizingRef = useRef(false);
  const startingRef = useRef(false);
  const pauseTransitionRef = useRef(false);
  const pausedRef = useRef(false);
  const recordingActiveRef = useRef(false);
  const unexpectedStopTimerRef = useRef(null);
  const hadRecorderSignalRef = useRef(false);
  const unexpectedHandledRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const foregroundReconcileRef = useRef(false);
  const appBackgroundedAtRef = useRef(null);
  const importedDurationUpdatedRef = useRef(new Set());
  const computerAbortRef = useRef(null);

  const selectedLecture = lectures.find((lecture) => lecture.id === selectedId) || null;
  const lastSaved = lectures.find((lecture) => lecture.id === lastSavedId) || null;
  const freeDisk = Paths.availableDiskSpace;
  const level = recordingLevel(recorderState.metering);

  pausedRef.current = paused;
  recordingActiveRef.current = recordingActive;

  useEffect(() => {
    if (!recordingActive && !paused) return;
    setSessionDurationMs((current) => Math.max(current, Number(recorderState.durationMillis || 0)));
    if (appStateRef.current === 'active' && !foregroundReconcileRef.current && recorderState.isRecording) setNativeRecordingConfirmed(true);
  }, [recordingActive, paused, recorderState.durationMillis, recorderState.isRecording]);

  journalSnapshot.current = {
    title,
    startedAt: recordingStartedAt.current,
    sourceUri: recorder.uri || recorderState.url || null,
    durationMs: Math.max(sessionDurationMs || 0, recorderState.durationMillis || 0, journalSnapshot.current.durationMs || 0),
    marks,
    state: paused ? 'paused' : 'recording',
  };

  async function refresh() {
    const library = await loadLibrary();
    setLectures(library);
    return library;
  }

  async function persistSettings(patch) {
    const next = await saveSettings({ ...settings, ...patch });
    setSettingsState(next);
    return next;
  }

  async function persistRecordingJournal(stateOverride) {
    let statusSnapshot = null;
    try {
      if (typeof recorder.getStatus === 'function') statusSnapshot = await recorder.getStatus();
    } catch {
      // State hook and recorder URI remain fallbacks.
    }
    const snapshot = journalSnapshot.current;
    saveActiveRecordingJournal({
      ...snapshot,
      sourceUri: recorder.uri || statusSnapshot?.url || snapshot.sourceUri || null,
      durationMs: Math.max(Number(statusSnapshot?.durationMillis || 0), Number(snapshot.durationMs || 0)),
      state: stateOverride || snapshot.state,
    });
  }

  async function deactivateKeepAwake() {
    try {
      if (typeof KeepAwake.deactivateKeepAwake === 'function') {
        await Promise.resolve(KeepAwake.deactivateKeepAwake(KEEP_AWAKE_TAG));
      }
    } catch {
      // Best effort only.
    }
  }

  async function activateKeepAwake() {
    if (!settings.keepScreenAwake) return;
    try {
      if (typeof KeepAwake.activateKeepAwakeAsync === 'function') await KeepAwake.activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      else if (typeof KeepAwake.activateKeepAwake === 'function') await Promise.resolve(KeepAwake.activateKeepAwake(KEEP_AWAKE_TAG));
    } catch {
      // Recording must continue even when Expo Go does not expose keep-awake.
    }
  }

  async function preserveRecorderOutput({ unexpected = false } = {}) {
    const durationMs = Math.max(0, sessionDurationMs, recorderState.durationMillis || 0, Math.round((recorder.currentTime || 0) * 1000), journalSnapshot.current.durationMs || 0);
    const uri = recorder.uri || recorderState.url || journalSnapshot.current.sourceUri;
    const savedTitle = lectureDisplayTitle(title, recordingStartedAt.current || new Date());
    saveActiveRecordingJournal({
      title: savedTitle,
      startedAt: recordingStartedAt.current,
      sourceUri: uri || null,
      durationMs,
      marks,
      state: unexpected ? 'unexpected-stop-awaiting-preservation' : 'stopped-awaiting-preservation',
    });
    if (!uri) throw new Error('The recorder stopped but did not expose an audio file path. The recovery journal was kept so LectureAI can retry if Expo later exposes the file.');

    const id = newId();
    const preserved = await preserveAudioFile(uri, id, savedTitle, 'm4a');
    let lecture = createLecture({ id, title: savedTitle, audio: preserved, durationMs, marks, source: unexpected ? 'unexpected-recorder-stop' : 'recorded' });
    if (unexpected) {
      lecture = {
        ...lecture,
        recoveryNotice: 'The recorder stopped unexpectedly, which can happen after an audio-route or Bluetooth/headphone change. LectureAI preserved the file it could access. Verify the beginning, middle, and end before trusting it.',
      };
    }
    await upsertLecture(lecture);
    clearActiveRecordingJournal();
    recordingStartedAt.current = null;
    await refresh();
    setLastSavedId(id);
    setTitle(untitledLectureTitle());
    player.replace({ uri: preserved.uri });
    setStatus(unexpected ? 'Unexpected stop preserved · verify the original carefully' : 'Original audio preserved in LectureAI document storage · verify playback');
    if (!unexpected && settings.autoOpenShareSheet) void shareAudio(lecture).catch(() => undefined);
    return lecture;
  }

  async function preserveUnexpectedRecorderStop(reason) {
    if (unexpectedHandledRef.current || finalizingRef.current || !recordingActiveRef.current || pausedRef.current) return;
    unexpectedHandledRef.current = true;
    setNativeRecordingConfirmed(false);
    try {
      await persistRecordingJournal('unexpected-stop');
      await deactivateKeepAwake();
      setRecordingActive(false);
      setPaused(false);
      await preserveRecorderOutput({ unexpected: true });
      setWarning(`${reason} LectureAI preserved the available original; verify the beginning, middle, and end before relying on it.`);
    } catch (error) {
      setRecordingActive(false);
      setPaused(false);
      setStatus('Unexpected recording stop needs attention');
      setWarning(error instanceof Error ? error.message : 'The recorder stopped unexpectedly and LectureAI could not preserve the file automatically. The recovery journal was retained.');
    }
  }

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const loadedSettings = await loadSettings();
      const recovery = await recoverInterruptedRecording();
      let library = await loadLibrary();
      if (!mounted) return;
      setSettingsState(loadedSettings);
      let helperConnected = false;
      if (loadedSettings.computerAddress && loadedSettings.computerToken && (!loadedSettings.computerTokenExpiresAt || Date.now() / 1000 < Number(loadedSettings.computerTokenExpiresAt))) {
        try {
          await computerHealth(loadedSettings.computerAddress, loadedSettings.computerToken);
          helperConnected = true;
          if (mounted) setSettingsState(await saveSettings({ ...loadedSettings, computerLastConnectedAt: new Date().toISOString() }));
        } catch { /* Offline does not erase a secure pairing; Settings offers Retry. */ }
      }
      if (helperConnected) {
        let changed = false;
        const reconciled = [];
        for (const lecture of library) {
          const savedJob = lecture.windowsTranscriptionJob;
          if (!savedJob?.id || savedJob.status === 'applied') { reconciled.push(lecture); continue; }
          try {
            const job = await computerJobStatus({ address: loadedSettings.computerAddress, token: loadedSettings.computerToken, jobId: savedJob.id });
            reconciled.push({ ...lecture, windowsTranscriptionJob: windowsJobSnapshot(job, savedJob, lecture.transcriptVersion), transcriptStatus: job.status === 'complete' ? 'ready-to-apply' : job.status });
            changed = true;
          } catch {
            reconciled.push(lecture);
          }
        }
        if (changed) {
          library = await saveLibrary(reconciled);
        }
      }
      setLectures(library);
      if (recovery.recovered) {
        setWarning('LectureAI recovered an audio file from an interrupted recording session. Open it from Lectures and verify the beginning, middle, and end before relying on it.');
      } else if (recovery.message) {
        setWarning(recovery.message);
      }
      setReady(true);
    })().catch((error) => {
      if (!mounted) return;
      setWarning(error instanceof Error ? error.message : 'Could not open the local LectureAI library.');
      setReady(true);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const subscription = AppState.addEventListener('change', (nextState) => {
      const previousState = appStateRef.current;
      appStateRef.current = nextState;

      if (nextState !== 'active') {
        if (recordingActiveRef.current) {
          appBackgroundedAtRef.current ||= Date.now();
          setNativeRecordingConfirmed(false);
          if (unexpectedStopTimerRef.current) {
            clearTimeout(unexpectedStopTimerRef.current);
            unexpectedStopTimerRef.current = null;
          }
          void persistRecordingJournal(pausedRef.current ? 'paused-backgrounded' : 'background-recording-expected');
          setStatus(pausedRef.current ? 'Paused while LectureAI is in the background' : 'Recording continues in background-capable native builds');
          if (RUNNING_IN_EXPO_GO) {
            setWarning('Stock Expo Go cannot guarantee background recording because this project cannot change the Expo Go native binary. Return to LectureAI to verify the real recorder state.');
          }
        }
        return;
      }

      if (previousState === 'active' || !recordingActiveRef.current || cancelled) return;
      foregroundReconcileRef.current = true;
      setForegroundRecorderChecking(true);
      setNativeRecordingConfirmed(false);
      setStatus('Checking the native recorder after returning to LectureAI…');

      void (async () => {
        let nativeStatus = null;
        let statusReadFailed = true;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          try {
            nativeStatus = typeof recorder.getStatus === 'function' ? await recorder.getStatus() : null;
            statusReadFailed = false;
            if (nativeStatus) break;
          } catch {
            statusReadFailed = true;
          }
          await wait(120);
        }
        if (cancelled || !recordingActiveRef.current) return;

        if (nativeStatus) {
          const duration = Math.max(0, Number(nativeStatus.durationMillis || 0));
          setSessionDurationMs((current) => Math.max(current, duration));
          journalSnapshot.current = {
            ...journalSnapshot.current,
            sourceUri: recorder.uri || nativeStatus.url || journalSnapshot.current.sourceUri || null,
            durationMs: Math.max(duration, journalSnapshot.current.durationMs || 0),
          };
        }

        const decision = foregroundRecorderDecision({
          sessionActive: recordingActiveRef.current,
          paused: pausedRef.current,
          statusAvailable: Boolean(nativeStatus),
          isRecording: Boolean(nativeStatus?.isRecording),
        });

        if (decision === 'paused') {
          setStatus('Paused · same recording session preserved');
          await persistRecordingJournal('paused-after-foreground');
        } else if (decision === 'recording') {
          hadRecorderSignalRef.current = true;
          setNativeRecordingConfirmed(true);
          setRecordingActive(true);
          setPaused(false);
          setStatus('Recording · native recorder confirmed after app switch');
          await persistRecordingJournal('recording-after-foreground');
        } else if (decision === 'stopped') {
          await preserveUnexpectedRecorderStop('iOS interrupted or stopped the microphone while LectureAI was away.');
        } else if (decision === 'unconfirmed' && statusReadFailed) {
          setStatus('Native recorder state could not be confirmed');
          setWarning('LectureAI could not read the native recorder state after returning. It has not discarded or overwritten the recording. Keep the app open and use Finish & save to preserve any file iOS exposes.');
        }
      })().finally(() => {
        foregroundReconcileRef.current = false;
        setForegroundRecorderChecking(false);
        appBackgroundedAtRef.current = null;
      });
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [recordingActive]);

  useEffect(() => {
    if (recorderState.mediaServicesDidReset && recordingActive) {
      void persistRecordingJournal('media-services-reset');
      setNativeRecordingConfirmed(false);
      setWarning('iOS audio services were reset during this lecture. LectureAI will preserve any stopped file it can access; verify the result carefully.');
    }
  }, [recorderState.mediaServicesDidReset, recordingActive]);

  useEffect(() => {
    function clearPendingUnexpectedStop() {
      if (unexpectedStopTimerRef.current) {
        clearTimeout(unexpectedStopTimerRef.current);
        unexpectedStopTimerRef.current = null;
      }
    }

    if (!recordingActive) {
      hadRecorderSignalRef.current = false;
      unexpectedHandledRef.current = false;
      clearPendingUnexpectedStop();
      return clearPendingUnexpectedStop;
    }

    if (recorderState.isRecording) {
      hadRecorderSignalRef.current = true;
      clearPendingUnexpectedStop();
      return clearPendingUnexpectedStop;
    }

    if (
      paused
      || appStateRef.current !== 'active'
      || foregroundReconcileRef.current
      || pauseTransitionRef.current
      || !hadRecorderSignalRef.current
      || finalizingRef.current
      || unexpectedHandledRef.current
    ) {
      clearPendingUnexpectedStop();
      return clearPendingUnexpectedStop;
    }

    if (!unexpectedStopTimerRef.current) {
      unexpectedStopTimerRef.current = setTimeout(() => {
        unexpectedStopTimerRef.current = null;

        void (async () => {
          if (
            !recordingActiveRef.current
            || pausedRef.current
            || appStateRef.current !== 'active'
            || foregroundReconcileRef.current
            || pauseTransitionRef.current
            || finalizingRef.current
            || unexpectedHandledRef.current
          ) return;

          try {
            const nativeStatus =
              typeof recorder.getStatus === 'function'
                ? await recorder.getStatus()
                : null;

            if (nativeStatus?.isRecording) {
              hadRecorderSignalRef.current = true;
              return;
            }
          } catch {
            // Continue with fail-safe preservation only after the grace period.
          }

          if (
            !recordingActiveRef.current
            || pausedRef.current
            || appStateRef.current !== 'active'
            || foregroundReconcileRef.current
            || pauseTransitionRef.current
            || finalizingRef.current
            || unexpectedHandledRef.current
          ) return;

          await preserveUnexpectedRecorderStop('Recording stopped unexpectedly, possibly because another app took exclusive microphone control.');
        })();
      }, 800);
    }

    return clearPendingUnexpectedStop;
  }, [recordingActive, paused, recorderState.isRecording]);

  useEffect(() => {
    if (!recordingActive) return undefined;
    void persistRecordingJournal();
    const journalTimer = setInterval(() => { void persistRecordingJournal(); }, 5_000);
    const storageTimer = setInterval(() => {
      if (Paths.availableDiskSpace < 200 * 1024 * 1024) {
        setWarning(`Device storage is critically low (${formatBytes(Paths.availableDiskSpace)} free). Keep LectureAI open and finish/save the lecture as soon as practical.`);
      }
    }, 60_000);
    return () => { clearInterval(journalTimer); clearInterval(storageTimer); };
  }, [recordingActive]);

  useEffect(() => () => { void deactivateKeepAwake(); }, []);

  useEffect(() => {
    if (!selectedLecture || selectedLecture.audioSource !== 'imported' || selectedLecture.durationMs > 0) return;
    const duration = Number(playerStatus.duration || 0);
    if (duration <= 0.2 || importedDurationUpdatedRef.current.has(selectedLecture.id)) return;
    importedDurationUpdatedRef.current.add(selectedLecture.id);
    void upsertLecture({ ...selectedLecture, durationMs: Math.round(duration * 1000) }).then(refresh).catch(() => {
      importedDurationUpdatedRef.current.delete(selectedLecture.id);
    });
  }, [selectedLecture?.id, playerStatus.duration]);

  async function startRecording() {
    if (recordingActive || startingRef.current || finalizingRef.current) return;
    startingRef.current = true;
    let nativeStartRequested = false;
    try {
      setWarning('');
      if (Paths.availableDiskSpace < LOW_STORAGE_BYTES) {
        Alert.alert('Not enough free storage', `Only about ${formatBytes(Paths.availableDiskSpace)} is available. Free at least 500 MB before starting an important lecture.`);
        return;
      }
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Microphone permission needed', 'Allow microphone access for Expo Go in iPhone/iPad Settings, then try again.');
        return;
      }

      setStatus('Preparing native audio…');
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true, allowsBackgroundRecording: true, interruptionMode: 'doNotMix' });
      await recorder.prepareToRecordAsync();
      let input = null;
      try {
        if (typeof recorder.getCurrentInput === 'function') input = await recorder.getCurrentInput();
      } catch {
        // Input-name detection is optional and must never block recording.
      }
      setInputName(input?.name || input?.type || 'Built-in microphone');
      recordingStartedAt.current = new Date().toISOString();
      setSessionDurationMs(0);
      setNativeRecordingConfirmed(false);
      hadRecorderSignalRef.current = false;
      unexpectedHandledRef.current = false;
      if (unexpectedStopTimerRef.current) {
        clearTimeout(unexpectedStopTimerRef.current);
        unexpectedStopTimerRef.current = null;
      }
      nativeStartRequested = true;
      recorder.record();
      saveActiveRecordingJournal({ title, startedAt: recordingStartedAt.current, sourceUri: recorder.uri || recorderState.url || null, durationMs: 0, marks: [], state: 'starting' });
      let confirmedActive = false;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await wait(100);
        try {
          const recorderStatus = typeof recorder.getStatus === 'function' ? await recorder.getStatus() : null;
          if (recorderStatus?.isRecording) {
            confirmedActive = true;
            setSessionDurationMs(Math.max(0, Number(recorderStatus.durationMillis || 0)));
            break;
          }
        } catch { /* Retry briefly while the native recorder settles. */ }
      }
      if (!confirmedActive) throw new Error('The microphone recorder did not confirm that it became active. LectureAI did not show this session as recording.');
      await activateKeepAwake();
      setMarks([]);
      setPaused(false);
      setRecordingActive(true);
      setNativeRecordingConfirmed(true);
      setLastSavedId('');
      setStatus(RUNNING_IN_EXPO_GO ? 'Recording on-device · Expo Go background is best effort' : 'Recording · native background mode enabled');
    } catch (error) {
      recordingStartedAt.current = null;
      if (!nativeStartRequested) clearActiveRecordingJournal();
      else {
        try { await recorder.stop(); } catch { /* The retained journal is the safe fallback. */ }
      }
      setPaused(false);
      setRecordingActive(false);
      setNativeRecordingConfirmed(false);
      setStatus('Recording did not start');
      setWarning(`Recorder start failed: ${error instanceof Error ? error.message : 'Could not start recording.'}`);
    } finally {
      startingRef.current = false;
    }
  }

  async function pauseRecording() {
    if (!recordingActive || paused || finalizingRef.current) return;

    pauseTransitionRef.current = true;
    setWarning('');

    try {
      recorder.pause();
      setPaused(true);
      setNativeRecordingConfirmed(false);
      await persistRecordingJournal('paused');
      setStatus('Paused - same recording session preserved');
    } catch (error) {
      setWarning(
        error instanceof Error
          ? `LectureAI could not pause cleanly: ${error.message}`
          : 'LectureAI could not pause cleanly. Finish and verify the recording if anything looks wrong.'
      );
    } finally {
      setTimeout(() => {
        pauseTransitionRef.current = false;
      }, 250);
    }
  }

  async function resumeRecording() {
    if (!recordingActive || !paused || finalizingRef.current) return;

    // If Continue is tapped immediately after Pause, wait briefly for the
    // native pause transition instead of silently ignoring the tap.
    for (let attempt = 0; attempt < 12 && pauseTransitionRef.current; attempt += 1) {
      await wait(50);
    }

    if (
      !recordingActiveRef.current
      || !pausedRef.current
      || finalizingRef.current
    ) return;

    pauseTransitionRef.current = true;
    setWarning('');
    setStatus('Continuing recording...');

    try {
      recorder.record();

      let confirmedActive = false;

      for (let attempt = 0; attempt < 20; attempt += 1) {
        await wait(100);

        try {
          const nativeStatus =
            typeof recorder.getStatus === 'function'
              ? await recorder.getStatus()
              : null;

          if (nativeStatus?.isRecording) {
            confirmedActive = true;
            break;
          }
        } catch {
          // Give the native recorder a short opportunity to settle.
        }
      }

      if (!confirmedActive) {
        throw new Error(
          'The native recorder did not confirm that the paused session resumed.'
        );
      }

      hadRecorderSignalRef.current = true;
      setPaused(false);
      setNativeRecordingConfirmed(true);
      await persistRecordingJournal('recording');
      setStatus('Recording continued - same lecture');
    } catch (error) {
      setPaused(true);
      setStatus('Paused - recording was not resumed');
      setWarning(
        `${error instanceof Error ? error.message : 'LectureAI could not resume the recording.'} ` +
        'The lecture was not intentionally finished. Try Continue again, or use Finish & save to preserve what was recorded.'
      );
    } finally {
      // Allow the 200 ms React Native recorder-state hook to catch up before
      // unexpected-stop detection becomes active again.
      setTimeout(() => {
        pauseTransitionRef.current = false;
      }, 600);
    }
  }

  function markMoment() {
    if (!recordingActive) return;
    const timeMs = Math.max(0, sessionDurationMs || 0, recorderState.durationMillis || 0, Math.round((recorder.currentTime || 0) * 1000));
    setMarks((current) => [...current, { id: newId(), timeMs, label: `Important moment ${current.length + 1}` }]);
  }

  async function finishRecording() {
    if (!recordingActive || finalizingRef.current) return;
    finalizingRef.current = true;
    try {
      setStatus('Finishing and preserving original audio…');
      await persistRecordingJournal('finishing');
      await recorder.stop();
      await deactivateKeepAwake();
      setRecordingActive(false);
      setPaused(false);
      setNativeRecordingConfirmed(false);
      await preserveRecorderOutput({ unexpected: false });
    } catch (error) {
      await deactivateKeepAwake();
      setRecordingActive(false);
      setPaused(false);
      setStatus('Recording needs attention');
      setWarning(error instanceof Error ? error.message : 'LectureAI could not finish this recording safely.');
    } finally {
      finalizingRef.current = false;
    }
  }

  async function runPlaybackCheck(lecture, point) {
    try {
      if (!lecture?.audioUri) throw new Error('This lecture has no preserved audio file.');
      if (playbackSource !== 'original') {
        loadPlaybackSource(lecture, 'original');
        await wait(100);
      }
      const duration = Math.max(Number(playerStatus.duration || 0), Number(lecture.durationMs || 0) / 1000);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('LectureAI could not determine the recording duration for playback verification. Play the original normally and try again.');
      const target = point === 'beginning' ? 0 : point === 'middle' ? Math.max(0, duration * 0.5) : Math.max(0, duration - Math.min(5, duration * 0.08));
      await Promise.resolve(player.seekTo(target));
      const before = Number(player.currentTime ?? target);
      player.play();
      setStatus(`Playing ${point} verification sample…`);
      let progressed = false;
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await wait(125);
        const current = Number(player.currentTime ?? 0);
        if (Number.isFinite(current) && current > before + 0.25) { progressed = true; break; }
      }
      player.pause();
      if (!progressed) throw new Error(`The ${point} playback sample did not advance. Check the audio route, volume, and original file; this verification point was not accepted.`);
      const updated = markAudioPlaybackPoint(lecture, point);
      await upsertLecture(updated);
      await refresh();
      setStatus(`${point[0].toUpperCase()}${point.slice(1)} playback sample completed`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The playback sample could not be verified.';
      setWarning(message);
      setStatus('Playback verification incomplete');
      Alert.alert('Playback verification incomplete', message);
    }
  }

  async function verifyLecture(lecture) {
    try {
      await upsertLecture(markAudioVerified(lecture));
      await refresh();
      setStatus('Original audio playback confirmed at beginning, middle, and end');
    } catch (error) {
      Alert.alert('Playback verification incomplete', error instanceof Error ? error.message : 'Complete the three playback checks first.');
    }
  }

  function loadPlaybackSource(lecture, source = 'original') {
    const enhanced = currentEnhancedAudio(lecture);
    const useEnhanced = source === 'enhanced' && enhanced?.uri;
    const uri = useEnhanced ? enhanced.uri : lecture.audioUri;
    if (!uri) throw new Error('The selected audio file is unavailable.');
    player.pause();
    player.replace({ uri });
    setPlaybackSource(useEnhanced ? 'enhanced' : 'original');
    return useEnhanced ? 'enhanced' : 'original';
  }

  function playLectureAudio(lecture, source) {
    try {
      loadPlaybackSource(lecture, source);
      player.play();
    } catch (error) {
      Alert.alert('Audio unavailable', error instanceof Error ? error.message : 'The selected audio could not be opened.');
    }
  }

  function seekOriginalAudio(lecture, seconds, shouldPlay = true) {
    try {
      if (playbackSource !== 'original') loadPlaybackSource(lecture, 'original');
      player.seekTo(Math.max(0, Number(seconds || 0)));
      if (shouldPlay) player.play();
    } catch (error) {
      Alert.alert('Original audio unavailable', error instanceof Error ? error.message : 'The protected original could not be opened.');
    }
  }

  function openLecture(lecture, nextTab = 'audio') {
    setSelectedId(lecture.id);
    setDetailTab(nextTab);
    setPlaybackSource('original');
    if (lecture.audioUri) player.replace({ uri: lecture.audioUri });
  }

  async function renameLecture(lecture, requestedTitle) {
    try {
      const updated = renameLectureTitle(lecture, requestedTitle);
      await upsertLecture(updated);
      await refresh();
      setStatus('Lecture Name saved · original audio and transcript unchanged');
      return true;
    } catch (error) {
      Alert.alert('Lecture Name was not saved', error instanceof Error ? error.message : 'The existing name and original audio were not changed.');
      return false;
    }
  }

  async function importAudio() {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ['audio/*', 'audio/mp4', 'audio/mpeg', 'audio/wav'], copyToCacheDirectory: true, multiple: false });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset?.uri) throw new Error('The selected recording could not be opened.');
      if ((asset.size || 0) + 50 * 1024 * 1024 > Paths.availableDiskSpace) throw new Error('There is not enough free device storage to preserve a separate original copy of this recording.');
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
      const asset = result.assets?.[0];
      if (!asset?.uri) throw new Error('The selected transcript file could not be opened.');
      const file = new File(asset.uri);
      const payload = JSON.parse(await file.text());
      const segments = normalizeTranscriptPayload(payload, lecture.id);
      const updated = replaceTranscript(lecture, segments, 'import', { clearSourceMetadata: true });
      await upsertLecture(updated);
      await refresh();
      setDetailTab('transcript');
    } catch (error) {
      Alert.alert('Transcript import failed', error instanceof Error ? error.message : 'Could not read this transcript.');
    }
  }

  async function saveTranscriptEdit(lecture, segmentId, text) {
    try {
      const updated = updateTranscriptSegment(lecture, segmentId, stripWhisperControlTokens(text));
      await upsertLecture(updated);
      await refresh();
    } catch (error) {
      Alert.alert('Transcript edit was not saved', error instanceof Error ? error.message : 'LectureAI could not durably save this edit.');
    }
  }

  async function generateStudy(lecture) {
    const updated = applyStudyPack(lecture);
    await upsertLecture(updated);
    await refresh();
    setDetailTab('study');
  }

  async function pairComputer(address, code) {
    const paired = await pairWithComputer(address, code);
    const health = await computerHealth(paired.baseUrl, paired.token);
    await persistSettings({ computerAddress: paired.baseUrl, computerToken: paired.token, computerTokenExpiresAt: paired.expiresAt, computerLastConnectedAt: new Date().toISOString() });
    return health;
  }

  async function testComputer() {
    if (!settings.computerAddress || !settings.computerToken) throw new Error('Pair this device with your Windows helper first.');
    const health = await computerHealth(settings.computerAddress, settings.computerToken);
    await persistSettings({ computerLastConnectedAt: new Date().toISOString() });
    return health;
  }

  async function forgetComputer() {
    await persistSettings({ computerAddress: '', computerToken: '', computerTokenExpiresAt: null, computerLastConnectedAt: null });
  }

  async function generateEnhancedAudio(lecture) {
    if (!settings.computerAddress || !settings.computerToken) {
      Alert.alert('Laptop AI is offline', 'Pair the private Windows helper in Settings before generating an enhanced copy. The protected original remains available.');
      return;
    }
    let temporary = null;
    let jobId = '';
    try {
      inspectProtectedOriginal(lecture);
      setEnhancementProgress({ lectureId: lecture.id, progress: 1, message: 'Checking protected original integrity…' });
      const job = await generateEnhancedOnComputer({
        address: settings.computerAddress,
        token: settings.computerToken,
        lecture,
        cleanupMode,
        onProgress: ({ progress, message }) => setEnhancementProgress({ lectureId: lecture.id, progress, message }),
      });
      jobId = String(job.job_id || job.id || '');
      const enhancedSize = Number(job.result?.enhanced_size || 0);
      if (enhancedSize > 0 && enhancedSize + 50 * 1024 * 1024 > Paths.availableDiskSpace) {
        throw new Error(`The enhanced WAV needs about ${formatBytes(enhancedSize)}, but the device does not have enough safe free space. Delete other files or use Transcribe Original.`);
      }
      temporary = new File(Paths.cache, `lectureai-enhanced-${lecture.id}-${Date.now().toString(36)}.wav`);
      setEnhancementProgress({ lectureId: lecture.id, progress: 96, message: 'Downloading the verified enhanced copy into private LectureAI storage…' });
      const downloaded = await downloadEnhancedFromComputer({
        address: settings.computerAddress,
        token: settings.computerToken,
        jobId,
        destination: temporary,
      });
      const installed = await installEnhancedAudioFile(lecture, downloaded.uri, cleanupMode, job.result || {});
      const saved = await upsertLecture(installed.lecture);
      try { removeReplacedEnhancedAudio(installed.previousEnhancedUri, saved.enhancedAudio?.uri); } catch { /* New verified copy remains authoritative; old derived cleanup can be retried later. */ }
      await refresh();
      setEnhancementProgress(null);
      Alert.alert('Enhanced copy ready', `${cleanupMode[0].toUpperCase()}${cleanupMode.slice(1)} cleanup was saved as a separate private WAV. The original recording and its timeline are unchanged.`);
    } catch (error) {
      setEnhancementProgress(null);
      Alert.alert('Enhanced copy not created', `${error instanceof Error ? error.message : 'Enhancement failed.'}\n\nThe protected original recording was not modified or deleted.`);
    } finally {
      try { if (temporary?.exists) temporary.delete(); } catch { /* Cache cleanup only. */ }
      if (jobId) {
        try { await releaseComputerEnhancement({ address: settings.computerAddress, token: settings.computerToken, jobId }); } catch { /* Windows retention cleanup remains a fallback. */ }
      }
    }
  }

  function confirmDeleteEnhancedAudio(lecture) {
    Alert.alert('Delete enhanced copy?', 'Only the derived enhanced-for-transcription file will be deleted. The protected original, transcript, notes, and timestamps remain unchanged.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete Enhanced Copy',
        style: 'destructive',
        onPress: () => void (async () => {
          try {
            if (playbackSource === 'enhanced') loadPlaybackSource(lecture, 'original');
            const updated = deleteEnhancedAudioCopy(lecture);
            await upsertLecture(updated);
            await refresh();
          } catch (error) {
            Alert.alert('Enhanced copy not deleted', `${error instanceof Error ? error.message : 'Deletion failed.'}\n\nThe protected original remains unchanged.`);
          }
        })(),
      },
    ]);
  }

  async function runComputerTranscription(lecture, replacementConfirmed = false, retryCurrent = false, requestedSource = 'original') {
    if (!settings.computerAddress || !settings.computerToken) {
      Alert.alert('Laptop AI is offline', 'Your recording is safe. Start LectureAI Laptop AI on Windows, then scan its QR code from Settings and Retry.');
      return;
    }
    if (settings.computerTokenExpiresAt && Date.now() / 1000 >= Number(settings.computerTokenExpiresAt)) {
      Alert.alert('Pairing expired', 'The local pairing token expired. Pair again from Settings before transcription.');
      return;
    }
    const savedJob = lecture.windowsTranscriptionJob;
    const existingJob = savedJob?.id && savedJob.status !== 'applied' ? savedJob : null;
    const effectiveSource = existingJob?.audioInputSource === 'enhanced' ? 'enhanced' : requestedSource === 'enhanced' ? 'enhanced' : 'original';
    if (!existingJob && lecture.transcript?.length && !replacementConfirmed) {
      Alert.alert('Retranscribe this lecture?', `The existing transcript will remain visible while Windows transcribes the ${effectiveSource} audio. When the new result is applied, manual corrections are archived and the protected original is never changed.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Continue', onPress: () => void runComputerTranscription(lecture, true, false, effectiveSource) },
      ]);
      return;
    }
    const controller = new AbortController();
    computerAbortRef.current = controller;
    try {
      setComputerProgress({ lectureId: lecture.id, progress: 1, message: 'Checking paired Windows computer…' });
      await computerHealth(settings.computerAddress, settings.computerToken);
      let working = lecture;
      const audioInput = existingJob ? null : prepareTranscriptionAudio(working, effectiveSource);
      let lastPersistedAt = 0;
      let lastPersistedSignature = '';
      const persistJob = async (job) => {
        const previous = working.windowsTranscriptionJob;
        const snapshot = windowsJobSnapshot({ ...job, audio_input_source: effectiveSource }, previous, working.transcriptVersion);
        working = { ...working, windowsTranscriptionJob: snapshot, transcriptStatus: snapshot.status, updatedAt: new Date().toISOString() };
        const signature = `${snapshot.id}:${snapshot.status}:${snapshot.completedAudioSeconds}`;
        const terminal = ['complete', 'failed', 'interrupted', 'stalled', 'cancelled'].includes(snapshot.status);
        if (!previous?.id || terminal || signature !== lastPersistedSignature || Date.now() - lastPersistedAt >= 5_000) {
          await upsertLecture(working);
          lastPersistedAt = Date.now();
          lastPersistedSignature = signature;
        }
      };
      const result = await transcribeOnComputer({
        address: settings.computerAddress,
        token: settings.computerToken,
        lecture: working,
        audioInput,
        glossary: [],
        // When the protected original is the upload, Windows creates disposable
        // per-section cleanup copies and can fall back Strong → Balanced → Off.
        // A retained enhanced upload is already derived, so no second cleanup is applied.
        enhancement: effectiveSource === 'original' ? cleanupMode : 'off',
        existingJobId: existingJob?.id || '',
        resume: Boolean(existingJob && !retryCurrent && ['failed', 'interrupted', 'stalled', 'cancelled'].includes(existingJob.status)),
        retryCurrent: Boolean(existingJob && retryCurrent),
        onProgress: (update) => setComputerProgress({ lectureId: lecture.id, ...update }),
        onJobUpdate: persistJob,
        signal: controller.signal,
      });
      if (result.pending) {
        await persistJob(result.job || { id: result.job_id, status: 'transcribing', message: result.message });
        await refresh();
        Alert.alert('Windows job is safe', `${result.message}\n\nYou may close LectureAI or Expo Go. Reopen this lecture later and tap Check / Resume Windows transcription.`);
        setComputerProgress(null);
        return;
      }
      const segments = normalizeTranscriptPayload(result, lecture.id);
      if (!segments.length) throw new Error('The computer returned an empty transcript. The original audio is unchanged.');
      let updated = replaceTranscript(working, segments, `windows:${result.model || 'configured'}`);
      updated = {
        ...updated,
        transcriptStatus: 'ready',
        windowsTranscriptionJob: { ...working.windowsTranscriptionJob, id: result.job_id || working.windowsTranscriptionJob?.id, status: 'applied', progress: 100, message: 'Source transcript applied', updatedAt: new Date().toISOString() },
        transcriptionMetadata: {
          engine: result.engine || 'faster-whisper',
          model: result.model || 'configured',
          detectedLanguage: result.detected_language || null,
          languageProbability: result.language_probability ?? null,
          duration: result.duration ?? null,
          languageScope: result.language_scope || null,
          detectedLanguages: result.detected_languages || [],
          device: result.device || null,
          computeType: result.compute_type || null,
          processingSeconds: result.processing_seconds ?? null,
          realTimeFactor: result.real_time_factor ?? null,
          enhancement: result.cleanup_mode || (effectiveSource === 'enhanced' ? currentEnhancedAudio(lecture)?.cleanupMode || 'enhanced' : cleanupMode),
          audioInputSource: effectiveSource,
          timestampReference: 'original',
        },
      };
      await upsertLecture(updated);
      await refresh();
      setDetailTab('transcript');
      setComputerProgress({ lectureId: lecture.id, progress: 96, message: 'SOURCE TRANSCRIPT READY · saved locally · preparing source-grounded study pack…' });
      await wait(0);
      try {
        updated = applyStudyPack(updated);
        await upsertLecture(updated);
        await refresh();
        setComputerProgress({ lectureId: lecture.id, progress: 100, message: 'SOURCE TRANSCRIPT READY · source-grounded study pack ready.' });
      } catch (studyError) {
        setComputerProgress({ lectureId: lecture.id, progress: 100, message: 'SOURCE TRANSCRIPT READY · study pack can be retried.' });
        Alert.alert('Transcript ready', `${studyError instanceof Error ? studyError.message : 'The study pack did not finish.'}\n\nThe source transcript and original audio are safe.`);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        setComputerProgress(null);
        await refresh();
        Alert.alert('Windows transcription cancelled', 'Windows stopped scheduling new sections. The original audio and every completed transcript section remain safe. Resume or Retry current section when ready.');
        return;
      }
      const message = error instanceof Error ? error.message : 'Computer transcription failed.';
      setComputerProgress({ lectureId: lecture.id, progress: 0, message });
      const latest = (await loadLibrary()).find((item) => item.id === lecture.id) || lecture;
      await upsertLecture({ ...latest, transcriptStatus: latest.windowsTranscriptionJob?.id ? 'interrupted' : latest.transcriptStatus, statusMessage: latest.windowsTranscriptionJob?.id ? 'Windows connection interrupted · job identity and completed sections remain saved' : latest.statusMessage });
      await refresh();
      Alert.alert('Transcription connection closed', `${message}\n\nYour original recording is still preserved. If a Windows job ID was created, the computer continues independently and completed sections remain checkpointed.`);
    } finally {
      if (computerAbortRef.current === controller) computerAbortRef.current = null;
    }
  }

  async function cancelComputerTranscription(lecture) {
    const jobId = lecture.windowsTranscriptionJob?.id;
    if (!jobId) return;
    try {
      const job = await cancelComputerJob({ address: settings.computerAddress, token: settings.computerToken, jobId });
      const snapshot = windowsJobSnapshot(job, lecture.windowsTranscriptionJob, lecture.transcriptVersion);
      await upsertLecture({ ...lecture, windowsTranscriptionJob: snapshot, transcriptStatus: snapshot.status === 'complete' ? 'ready-to-apply' : snapshot.status, updatedAt: new Date().toISOString() });
      if (snapshot.status === 'complete') {
        setComputerProgress({ lectureId: lecture.id, progress: 100, message: 'Windows finished before cancellation. Tap Check Windows transcription to apply the saved source transcript.' });
        await refresh();
        return;
      }
      computerAbortRef.current?.abort();
      setComputerProgress({ lectureId: lecture.id, progress: snapshot.progress, message: snapshot.message });
      await refresh();
    } catch (error) {
      Alert.alert('Cancel did not finish', `${error instanceof Error ? error.message : 'Windows did not confirm cancellation.'}\n\nThe original audio and completed transcript sections remain safe.`);
    }
  }

  async function deleteLecture(lecture) {
    Alert.alert('Delete lecture?', 'This removes the original audio and its LectureAI data from this Expo project. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: () => {
          void removeLecture(lecture).then(async () => {
            if (selectedId === lecture.id) setSelectedId('');
            if (lastSavedId === lecture.id) setLastSavedId('');
            await refresh();
          }).catch((error) => Alert.alert('Delete did not finish', error instanceof Error ? error.message : 'LectureAI kept the lecture data because the original could not be removed.'));
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
          computerProgress={computerProgress?.lectureId === selectedLecture.id ? computerProgress : null}
          enhancementProgress={enhancementProgress?.lectureId === selectedLecture.id ? enhancementProgress : null}
          computerPaired={Boolean(settings.computerAddress && settings.computerToken)}
          cleanupMode={cleanupMode}
          playbackSource={playbackSource}
          onCleanupModeChange={setCleanupMode}
          onRename={(value) => renameLecture(selectedLecture, value)}
          onBack={() => { player.pause(); setSelectedId(''); }}
          onPlayAudio={(source) => playLectureAudio(selectedLecture, source)}
          onSeekOriginal={(seconds) => seekOriginalAudio(selectedLecture, seconds)}
          onGenerateEnhanced={() => void generateEnhancedAudio(selectedLecture)}
          onDeleteEnhanced={() => confirmDeleteEnhancedAudio(selectedLecture)}
          onVerify={() => void verifyLecture(selectedLecture)}
          onPlaybackCheck={(point) => void runPlaybackCheck(selectedLecture, point)}
          onShare={() => void shareAudio(selectedLecture).catch((error) => Alert.alert('Share failed', error.message))}
          onShareTranscript={(kind) => {
            const action = kind === 'english' ? exportEnglishTranscript : kind === 'source' ? exportSourceTranscript : exportTranscript;
            void action(selectedLecture).catch((error) => Alert.alert('Transcript sharing did not finish', `${error instanceof Error ? error.message : 'The share sheet could not be opened.'}\n\nYour transcript and original audio are unchanged.`));
          }}
          onImportTranscript={() => void importTranscript(selectedLecture)}
          onComputerTranscribe={(source = 'original') => void runComputerTranscription(selectedLecture, false, false, source)}
          onRetryCurrent={() => void runComputerTranscription(selectedLecture, true, true)}
          onCancelTranscription={() => void cancelComputerTranscription(selectedLecture)}
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
              nativeRecordingConfirmed={nativeRecordingConfirmed}
              foregroundRecorderChecking={foregroundRecorderChecking}
              sessionDurationMs={sessionDurationMs}
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
              onVerify={() => lastSaved && void verifyLecture(lastSaved)}
              onPlaybackCheck={(point) => lastSaved && void runPlaybackCheck(lastSaved, point)}
              onOpen={() => lastSaved && openLecture(lastSaved)}
              onShare={() => lastSaved && void shareAudio(lastSaved).catch((error) => Alert.alert('Share failed', error.message))}
            />
          )}
          {tab === 'lectures' && <Library lectures={lectures} onOpen={openLecture} onImport={importAudio} />}
          {tab === 'study' && <StudyHome lectures={lectures} onOpen={(lecture) => openLecture(lecture, 'study')} />}
          {tab === 'settings' && (
            <SettingsScreen
              settings={settings}
              onChange={persistSettings}
              freeDisk={freeDisk}
              onPair={pairComputer}
              onTest={testComputer}
              onForget={forgetComputer}
              onPairQr={async (rawQr) => {
                const parsed = parseLaptopPairingQr(rawQr);
                return pairComputer(parsed.address, parsed.code);
              }}
              onOpenExports={onOpenExports}
            />
          )}
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

function PlaybackGate({ lecture, onPlaybackCheck, onVerify }) {
  const checks = { beginning: false, middle: false, end: false, ...(lecture.audioPlaybackChecks || {}) };
  const complete = checks.beginning && checks.middle && checks.end;
  return (
    <View style={styles.infoCard}>
      <Text style={styles.infoTitle}>Playback verification</Text>
      <Text style={styles.infoText}>LectureAI plays a short sample at three positions before it allows the final “audio is clear” confirmation.</Text>
      <View style={styles.buttonRow}>
        <SecondaryButton label={checks.beginning ? '✓ Beginning played' : 'Play beginning'} onPress={() => onPlaybackCheck('beginning')} />
        <SecondaryButton label={checks.middle ? '✓ Middle played' : 'Play middle'} onPress={() => onPlaybackCheck('middle')} />
        <SecondaryButton label={checks.end ? '✓ End played' : 'Play end'} onPress={() => onPlaybackCheck('end')} />
      </View>
      {lecture.audioVerification === 'user-playback-confirmed'
        ? <View style={styles.successBox}><Text style={styles.successText}>✓ You confirmed the beginning, middle, and end are clear.</Text></View>
        : <PrimaryButton label="I listened to all three — audio is clear" onPress={onVerify} disabled={!complete} />}
    </View>
  );
}

function RecordScreen({ title, setTitle, recorderState, nativeRecordingConfirmed, foregroundRecorderChecking, sessionDurationMs, recordingActive, paused, status, warning, level, marks, inputName, freeDisk, lastSaved, player, playerStatus, onStart, onPause, onResume, onMark, onFinish, onVerify, onPlaybackCheck, onOpen, onShare }) {
  // The UI is deliberately conservative: an outdated state hook can never keep the
  // red recording indication or old timer visible after the native recorder stops.
  const liveRecorder = recordingActive && !paused && !foregroundRecorderChecking && (recorderState.isRecording || nativeRecordingConfirmed);
  const visibleSession = paused || liveRecorder || (recordingActive && foregroundRecorderChecking);
  const stateLabel = foregroundRecorderChecking ? 'CHECKING RECORDER' : liveRecorder ? '● RECORDING' : paused ? 'PAUSED' : 'NOT RECORDING';
  const displayedDuration = visibleSession ? Math.max(sessionDurationMs || 0, recorderState.durationMillis || 0) : 0;
  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Text style={styles.eyebrow}>NATIVE AUDIO THROUGH EXPO GO</Text>
      <Text style={styles.hero}>Record the lecture. Keep the original.</Text>
      <Text style={styles.lead}>SDK 57 records into document storage, then LectureAI preserves a protected copy before transcription, notes, or study processing can touch anything.</Text>
      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Lecture Name (optional)</Text>
        <TextInput style={styles.titleInput} value={title} onChangeText={setTitle} maxLength={180} placeholder="Untitled Lecture" accessibilityLabel="Lecture Name" />
        <Text style={styles.meta}>You can name it before or during recording, or rename it later. This never changes the audio file.</Text>
        <View style={styles.statusRow} accessibilityLiveRegion="polite"><View style={[styles.statusDot, liveRecorder && styles.statusDotLive]} /><Text style={styles.statusText}>{stateLabel} · {status}</Text></View>
        {inputName ? <Text style={styles.meta}>Input: {inputName}</Text> : null}
        <Text style={styles.timer}>{formatDuration(displayedDuration)}</Text>
        <View style={styles.meter}><View style={[styles.meterFill, { width: `${liveRecorder ? Math.max(1, level * 100) : 0}%` }]} /></View>
        <Text style={styles.meterLabel}>{paused ? 'Paused' : level < 0.08 && recordingActive ? 'Audio is quiet — recording continues' : level > 0.94 ? 'Very loud — clipping may be possible' : recordingActive ? 'Audio level active' : 'Microphone meter appears while recording'}</Text>
        {!recordingActive ? <PrimaryButton label="Start recording" onPress={onStart} /> : <><View style={styles.buttonRow}><SecondaryButton label={`Mark (${marks.length})`} onPress={onMark} />{paused ? <SecondaryButton label="Continue" onPress={onResume} /> : <SecondaryButton label="Pause" onPress={onPause} />}</View><DangerButton label="Finish & save" onPress={onFinish} /></>}
      </View>
      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>Recording safety</Text>
        <Text style={styles.infoText}>• Native Expo audio with 48 kHz / mono / 192 kbps preferences and SDK 57 document recording.</Text>
        <Text style={styles.infoText}>• Active-session recovery journal updates while recording, and unexpected recorder stops are detected and preserved when a file is available.</Text>
        <Text style={styles.infoText}>• Standalone/development/production LectureAI native builds enable iOS background audio recording. Switching to ordinary non-microphone apps should not pause or recreate this recording.</Text>
        <Text style={styles.infoText}>• Stock Expo Go remains best-effort because this project cannot add native background capabilities to the Expo Go binary.</Text>
        <Text style={styles.infoText}>• Calls, voice notes/calls, and camera video may take exclusive microphone control; LectureAI checks the native recorder on return and preserves any exposed original safely.</Text>
        <Text style={styles.infoText}>• Free device storage: {formatBytes(freeDisk)}.</Text>
      </View>
      {warning ? <View style={styles.warningCard}><Text style={styles.warningTitle}>Check this</Text><Text style={styles.warningText}>{warning}</Text></View> : null}
      {lastSaved ? (
        <View style={styles.savedCard}>
          <Text style={styles.eyebrow}>ORIGINAL AUDIO PRESERVED</Text>
          <Text style={styles.cardTitle}>{lastSaved.title}</Text>
          <Text style={styles.meta}>{formatDuration(lastSaved.durationMs)} · {formatBytes(lastSaved.size)} · {lastSaved.marks.length} marks</Text>
          <View style={styles.buttonRow}><SecondaryButton label={playerStatus.playing ? 'Pause audio' : 'Play audio'} onPress={() => playerStatus.playing ? player.pause() : player.play()} /><SecondaryButton label="Share / Save to Files" onPress={onShare} /></View>
          <PlaybackGate lecture={lastSaved} onPlaybackCheck={onPlaybackCheck} onVerify={onVerify} />
          <SecondaryButton label="Open lecture workspace" onPress={onOpen} />
        </View>
      ) : null}
    </ScrollView>
  );
}

function Library({ lectures, onOpen, onImport }) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleLectures = normalizedQuery
    ? lectures.filter((lecture) => `${lecture.title || ''} ${lecture.course || ''}`.toLocaleLowerCase().includes(normalizedQuery))
    : lectures;
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.sectionHead}><View><Text style={styles.eyebrow}>LOCAL LIBRARY</Text><Text style={styles.sectionTitle}>Lectures</Text></View><SecondaryButton label="Import audio" onPress={onImport} compact /></View>
      {lectures.length ? <TextInput style={styles.textField} value={query} onChangeText={setQuery} placeholder="Find by Lecture Name" accessibilityLabel="Find lectures by name" /> : null}
      {!lectures.length ? <Empty title="No lectures yet" body="Record a lecture or import an existing audio file. LectureAI keeps a separate original in document storage." /> : !visibleLectures.length ? <Empty title="No matching lectures" body="Try another Lecture Name or course." /> : visibleLectures.map((lecture) => (
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
  const available = lectures.filter((lecture) => lecture.transcriptStatus === 'ready');
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Text style={styles.eyebrow}>SOURCE-GROUNDED STUDY</Text><Text style={styles.sectionTitle}>Study</Text>
      <Text style={styles.lead}>Study material uses trustworthy transcript sections and keeps timestamps back to source audio. Transcript edits invalidate older derived content.</Text>
      {!available.length ? <Empty title="Transcribe or import a transcript first" body="Once a lecture has timestamped text, LectureAI can build whole-lecture notes, concepts, definitions, examples and study questions." /> : available.map((lecture) => (
        <Pressable key={lecture.id} style={styles.listCard} onPress={() => onOpen(lecture)}>
          <View style={styles.listCardTop}><Text style={styles.listTitle}>{lecture.title}</Text><Text style={styles.chevron}>›</Text></View>
          <Text style={styles.meta}>{lecture.transcript.length} timestamped segments</Text>
          <Badge text={derivedContentIsFresh(lecture) ? 'Study pack current' : 'Study pack needs update'} good={derivedContentIsFresh(lecture)} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

function SettingsScreen({ settings, onChange, freeDisk, onPair, onPairQr, onTest, onForget, onOpenExports }) {
  const [address, setAddress] = useState(settings.computerAddress || '');
  const [code, setCode] = useState('');
  const [computerMessage, setComputerMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => { setAddress(settings.computerAddress || ''); }, [settings.computerAddress]);

  async function pair() {
    try {
      setBusy(true); setComputerMessage('Pairing…');
      const health = await onPair(address, code);
      setCode('');
      setComputerMessage(`Paired · ${health.configured_model || 'Whisper'} ready on this Windows computer.`);
    } catch (error) { setComputerMessage(error instanceof Error ? error.message : 'Pairing failed.'); } finally { setBusy(false); }
  }

  async function test() {
    try {
      setBusy(true);
      const health = await onTest();
      setComputerMessage(`Connected · ${health.configured_model || 'configured Whisper'} · ${health.warm_status || 'helper running'}.`);
    } catch (error) { setComputerMessage(error instanceof Error ? error.message : 'Could not reach the paired computer.'); } finally { setBusy(false); }
  }

  async function scan(rawQr) {
    try {
      setBusy(true); setComputerMessage('Validating QR and pairing with your private laptop…');
      const health = await onPairQr(rawQr);
      setScannerOpen(false);
      setComputerMessage(`Connected · ${health.computer_name || 'Windows computer'} · ${health.configured_model || 'Whisper'} · ${health.warm_status || 'helper running'}.`);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'This QR code could not be paired.';
      setComputerMessage(`QR read successfully, but it is not a usable LectureAI pairing code: ${detail}`);
      return false;
    } finally { setBusy(false); }
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Text style={styles.eyebrow}>LECTUREAI</Text><Text style={styles.sectionTitle}>Settings</Text>
      <PrimaryButton label="Export lecture files" onPress={onOpenExports} />
      <SettingRow title="Keep screen awake while recording" description="Recommended for Expo Go because background/locked-screen recording is not guaranteed." value={settings.keepScreenAwake} onToggle={() => onChange({ keepScreenAwake: !settings.keepScreenAwake })} />
      <SettingRow title="Open share sheet after save" description="Optional. The original is already preserved locally before sharing." value={settings.autoOpenShareSheet} onToggle={() => onChange({ autoOpenShareSheet: !settings.autoOpenShareSheet })} />
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Windows transcription</Text>
        <Text style={styles.infoText}>On Windows, double-click <Text style={styles.inlineCode}>Start LectureAI Laptop AI.bat</Text>, then scan its QR code. Use only trusted private/home Wi-Fi; this authenticated local HTTP transfer is not end-to-end encrypted.</Text>
        <PrimaryButton label={busy ? 'Please wait…' : 'Scan laptop QR'} onPress={() => setScannerOpen(true)} disabled={busy} />
        {settings.computerToken ? <View style={styles.buttonRow}><SecondaryButton label="Retry connection" onPress={test} disabled={busy} /><SecondaryButton label="Pair another" onPress={() => setScannerOpen(true)} disabled={busy} /><SecondaryButton label="Forget computer" onPress={() => void onForget().then(() => setComputerMessage('Pairing removed from this device.'))} disabled={busy} /></View> : null}
        {computerMessage ? <Text style={styles.connectionMessage}>{computerMessage}</Text> : null}
        {settings.computerLastConnectedAt ? <Text style={styles.meta}>Last connected: {new Date(settings.computerLastConnectedAt).toLocaleString()}</Text> : null}
        <Pressable onPress={() => setAdvanced((value) => !value)}><Text style={styles.linkText}>{advanced ? 'Hide advanced manual pairing' : 'Advanced: enter address and code manually'}</Text></Pressable>
        {advanced ? <><TextInput style={styles.textField} autoCapitalize="none" autoCorrect={false} value={address} onChangeText={setAddress} placeholder="http://192.168.1.20:8765" /><TextInput style={styles.textField} autoCapitalize="characters" autoCorrect={false} value={code} onChangeText={setCode} placeholder="Pairing code" /><PrimaryButton label={busy ? 'Please wait…' : 'Pair manually'} onPress={pair} disabled={busy} /></> : null}
        <Text style={styles.meta}>If the phone cannot reach the PC, make sure Expo Go has Local Network permission, both devices are on the same private Wi-Fi, and Windows Firewall allows Python on Private networks only.</Text>
      </View>
      <PairingScanner visible={scannerOpen} message={computerMessage} onClose={() => setScannerOpen(false)} onScanned={scan} />
      <View style={styles.infoCard}><Text style={styles.infoTitle}>Device storage</Text><Text style={styles.infoText}>{formatBytes(freeDisk)} available. LectureAI imposes no minute quota; storage, battery, and OS behavior remain real limits.</Text></View>
      <View style={styles.infoCard}><Text style={styles.infoTitle}>On-device transcription</Text><Text style={styles.infoText}>This Expo Go build does not pretend the browser Whisper worker is a native React Native engine. Free transcription is available through your paired Windows faster-whisper helper; timestamped JSON import remains a fallback.</Text></View>
      <View style={styles.infoCard}><Text style={styles.infoTitle}>Privacy & recovery</Text><Text style={styles.infoText}>Original recordings and metadata stay local by default. A secondary metadata backup plus orphan-file scan can rediscover preserved audio, and the active-session journal may recover an interrupted Expo recorder file when iOS leaves one available.</Text></View>
    </ScrollView>
  );
}

function LectureDetail({ lecture, detailTab, setDetailTab, player, playerStatus, computerProgress, enhancementProgress, computerPaired, cleanupMode, playbackSource, onCleanupModeChange, onRename, onBack, onPlayAudio, onSeekOriginal, onGenerateEnhanced, onDeleteEnhanced, onVerify, onPlaybackCheck, onShare, onShareTranscript, onImportTranscript, onComputerTranscribe, onRetryCurrent, onCancelTranscription, onSaveTranscriptEdit, onGenerateStudy, onDelete }) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(lecture.title);
  const [titleBusy, setTitleBusy] = useState(false);
  useEffect(() => {
    setTitleDraft(lecture.title);
    setEditingTitle(false);
  }, [lecture.id, lecture.title]);
  async function saveTitle() {
    setTitleBusy(true);
    try {
      if (await onRename(titleDraft)) setEditingTitle(false);
    } finally {
      setTitleBusy(false);
    }
  }
  const fresh = derivedContentIsFresh(lecture);
  const savedJob = lecture.windowsTranscriptionJob;
  const enhanced = currentEnhancedAudio(lecture);
  const shownProgress = computerProgress || (savedJob?.id && savedJob.status !== 'applied' ? { progress: savedJob.progress, message: savedJob.message } : null);
  // A retained Windows job can always be checked again. Disable only while this
  // screen currently owns an active request; after it yields, Check stays usable.
  const transcriptionBusy = Boolean(computerProgress && computerProgress.progress > 0 && computerProgress.progress < 100);
  const enhancementBusy = Boolean(enhancementProgress && enhancementProgress.progress >= 0 && enhancementProgress.progress < 100);
  const windowsJobRunning = Boolean(savedJob?.id && ['queued', 'loading-model', 'transcribing'].includes(savedJob.status));
  const jobActionLabel = savedJob?.id
    ? ['failed', 'interrupted', 'stalled', 'cancelled'].includes(savedJob.status) ? 'Resume Windows transcription' : 'Check Windows transcription'
    : 'Transcribe on paired computer';
  return (
    <View style={styles.app}>
      <View style={styles.detailHeader}>
        <Pressable onPress={onBack}><Text style={styles.back}>‹ Lectures</Text></Pressable>
        {editingTitle ? <View style={styles.renameCard}><Text style={styles.fieldLabel}>Lecture Name</Text><TextInput style={styles.titleInput} value={titleDraft} onChangeText={setTitleDraft} maxLength={180} autoFocus accessibilityLabel="Edit Lecture Name" /><View style={styles.buttonRow}><SecondaryButton label="Cancel" onPress={() => { setTitleDraft(lecture.title); setEditingTitle(false); }} disabled={titleBusy} /><PrimaryButton label={titleBusy ? 'Saving…' : 'Save Lecture Name'} onPress={saveTitle} disabled={titleBusy} /></View><Text style={styles.meta}>Metadata only — the protected original path, hash, transcript, timestamps, enhanced copy, and Windows job stay unchanged.</Text></View> : <><Text style={styles.detailTitle}>{lecture.title}</Text><SecondaryButton label="Edit Lecture Name" onPress={() => setEditingTitle(true)} compact /></>}
        <Text style={styles.meta}>{formatDuration(lecture.durationMs)} · {formatBytes(lecture.size)}</Text>
      </View>
      <View style={styles.detailTabs}>{['audio','transcript','notes','study'].map((id) => <Pressable key={id} onPress={() => setDetailTab(id)} style={[styles.detailTab, detailTab === id && styles.detailTabActive]}><Text style={[styles.detailTabText, detailTab === id && styles.detailTabTextActive]}>{id === 'audio' ? 'Audio' : id === 'transcript' ? 'Transcript' : id === 'notes' ? 'Notes' : 'Study'}</Text></Pressable>)}</View>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {shownProgress ? <View style={styles.progressCard}><Text style={styles.progressText}>{shownProgress.message}</Text>{shownProgress.progress > 0 ? <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.min(100, shownProgress.progress)}%` }]} /></View> : null}{savedJob?.totalAudioSeconds > 0 ? <Text style={styles.meta}>{formatTime(savedJob.completedAudioSeconds)} / {formatTime(savedJob.totalAudioSeconds)} transcribed · job saved on Windows</Text> : null}{windowsJobRunning ? <SecondaryButton label="Cancel safely" onPress={onCancelTranscription} /> : null}{savedJob?.id && ['failed', 'interrupted', 'stalled', 'cancelled'].includes(savedJob.status) ? <SecondaryButton label="Retry current section" onPress={onRetryCurrent} disabled={transcriptionBusy} /> : null}</View> : null}
        {detailTab === 'audio' && (
          <>
            {lecture.recoveryNotice ? <View style={styles.warningCard}><Text style={styles.warningTitle}>Recovered / interrupted original audio</Text><Text style={styles.warningText}>{lecture.recoveryNotice}</Text></View> : null}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>ORIGINAL RECORDING</Text>
              <Text style={styles.protectedLabel}>Protected — never modified</Text>
              <Text style={styles.meta}>{lecture.audioFilename} · {lecture.audioMd5 ? `MD5 ${lecture.audioMd5.slice(0, 10)}…` : 'file hash unavailable'}</Text>
              {playbackSource === 'original' ? <Text style={styles.playTime}>{formatTime(playerStatus.currentTime)} / {formatTime(playerStatus.duration || lecture.durationMs / 1000)}</Text> : null}
              <View style={styles.buttonRow}><SecondaryButton label={playerStatus.playing && playbackSource === 'original' ? 'Pause Original' : 'Play Original'} onPress={() => playerStatus.playing && playbackSource === 'original' ? player.pause() : onPlayAudio('original')} /><SecondaryButton label="Back 10s" onPress={() => onSeekOriginal(Math.max(0, playbackSource === 'original' ? playerStatus.currentTime - 10 : 0))} /><SecondaryButton label="+10s" onPress={() => onSeekOriginal(Math.min(lecture.durationMs / 1000 || 1e9, playbackSource === 'original' ? playerStatus.currentTime + 10 : 10))} /></View>
              <SecondaryButton label="Share / Save to Files" onPress={onShare} />
            </View>
            <PlaybackGate lecture={lecture} onPlaybackCheck={onPlaybackCheck} onVerify={onVerify} />
            <View style={styles.card}>
              <Text style={styles.cardTitle}>ENHANCED FOR TRANSCRIPTION</Text>
              <Text style={styles.derivedLabel}>Derived copy — safe to regenerate or delete</Text>
              <Text style={styles.meta}>{enhanced ? `${enhanced.cleanupMode[0].toUpperCase()}${enhanced.cleanupMode.slice(1)} · ${formatBytes(enhanced.size)} · generated ${new Date(enhanced.generatedAt).toLocaleString()}` : 'Enhanced audio: Not generated'}</Text>
              <Text style={styles.infoText}>Balanced is recommended: speech-aware stationary-noise reduction with conservative quiet-word protection. Strong suppresses more background noise but can affect difficult or overlapping speech. Off makes only the separate transcription-format copy. No mode trims the timeline; transcript timestamps always seek in the protected original recording.</Text>
              <View style={styles.buttonRow}>{['off', 'balanced', 'strong'].map((mode) => <Pressable key={mode} onPress={() => onCleanupModeChange(mode)} style={[styles.secondaryButton, cleanupMode === mode && styles.primaryButton]} disabled={enhancementBusy}><Text style={cleanupMode === mode ? styles.primaryButtonText : styles.secondaryButtonText}>{mode[0].toUpperCase() + mode.slice(1)}</Text></Pressable>)}</View>
              {cleanupMode === 'strong' ? <Text style={styles.warningText}>Strong cleanup can affect difficult or overlapping speech. It never edits the protected original and automatically falls back to Balanced or Off when transcription quality signals regress.</Text> : null}
              {enhancementProgress ? <View style={styles.progressCard}><Text style={styles.progressText}>{enhancementProgress.message}</Text><View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.min(100, enhancementProgress.progress)}%` }]} /></View></View> : null}
              <PrimaryButton label={enhancementBusy ? 'Generating enhanced copy…' : enhanced ? 'Regenerate Enhanced' : 'Generate Enhanced'} onPress={onGenerateEnhanced} disabled={enhancementBusy || !computerPaired} />
              {enhanced ? <View style={styles.buttonRow}><SecondaryButton label={playerStatus.playing && playbackSource === 'enhanced' ? 'Pause Enhanced' : 'Play Enhanced'} onPress={() => playerStatus.playing && playbackSource === 'enhanced' ? player.pause() : onPlayAudio('enhanced')} /><SecondaryButton label="Delete Enhanced Copy" onPress={onDeleteEnhanced} /></View> : null}
              {!computerPaired ? <Text style={styles.meta}>Pair Laptop AI in Settings to generate a private enhanced copy.</Text> : null}
            </View>
            {lecture.marks.length ? <View style={styles.infoCard}><Text style={styles.infoTitle}>Marked moments</Text>{lecture.marks.map((mark) => <Pressable key={mark.id} onPress={() => onSeekOriginal(mark.timeMs / 1000)}><Text style={styles.sourceLink}>{formatDuration(mark.timeMs)} · {mark.label}</Text></Pressable>)}</View> : null}
            <DangerButton label="Delete lecture & original audio" onPress={onDelete} />
          </>
        )}
        {detailTab === 'transcript' && (
          <>
            <View style={styles.infoCard}><Text style={styles.infoTitle}>Transcription audio source</Text><Text style={styles.infoText}>Transcribe Original keeps the protected file untouched and uses the selected {cleanupMode} mode only on disposable Windows sections, with bounded quality fallback. Transcribe Enhanced uses the retained derived copy. Either choice keeps every timestamp aligned to the original recording.</Text><PrimaryButton label={`Transcribe Original (${cleanupMode} cleanup)`} onPress={() => onComputerTranscribe('original')} disabled={transcriptionBusy} />{enhanced ? <SecondaryButton label={`Transcribe Enhanced (${enhanced.cleanupMode})`} onPress={() => onComputerTranscribe('enhanced')} disabled={transcriptionBusy} /> : <Text style={styles.meta}>Enhanced audio: Not generated. Create it from the Audio tab whenever you want.</Text>}</View>
            <View style={styles.infoCard}><Text style={styles.infoTitle}>Editable source transcript</Text><Text style={styles.infoText}>The original mixed-language speech remains authoritative. English/Arabic views are separate and never replace it.</Text>{lecture.sourceLanguage ? <Text style={styles.infoText}>Detected source language: {lecture.sourceLanguage}{lecture.sourceLanguageProbability != null ? ` · detection probability ${Number(lecture.sourceLanguageProbability).toFixed(3)} (not transcription accuracy)` : ' · detected independently by audio window'}</Text> : null}{lecture.transcriptionAccuracyNote ? <Text style={styles.infoText}>{lecture.transcriptionAccuracyNote}</Text> : null}</View>
            {!lecture.transcript.length ? <Empty title="No transcript yet" body={computerPaired ? 'Choose Original or Enhanced above for local faster-whisper transcription, or import timestamped transcript JSON.' : 'Pair your Windows computer in Settings for free local faster-whisper transcription, or import timestamped transcript JSON.'} action={<SecondaryButton label="Import transcript JSON" onPress={onImportTranscript} />} /> : lecture.transcript.map((segment) => (
              <View key={segment.id} style={[styles.transcriptRow, segment.uncertain && styles.uncertainRow]}>
                <Pressable onPress={() => onSeekOriginal(segment.startTime)}><Text style={styles.timestamp}>{formatTime(segment.startTime)} – {formatTime(segment.endTime)}</Text></Pressable>
                <TextInput multiline style={styles.transcriptInput} defaultValue={segment.editedText} onEndEditing={(event) => onSaveTranscriptEdit(segment.id, event.nativeEvent.text)} />
                <Text style={styles.meta}>{segment.uncertain ? 'Needs verification against audio' : segment.manuallyReviewed ? 'Reviewed' : 'Machine/imported text'} · {segment.speaker || 'Speaker'}</Text>
              </View>
            ))}
            {lecture.transcript.length ? <View style={styles.infoCard}><Text style={styles.infoTitle}>Share / Export Transcript</Text><Text style={styles.infoText}>Send or save transcript files through the normal iPhone/iPad share sheet. Sharing or cancelling never changes the transcript or protected original audio.</Text><PrimaryButton label="Share current transcript" onPress={() => onShareTranscript('current')} />{lecture.englishTranscript?.length ? <SecondaryButton label="Share English transcript" onPress={() => onShareTranscript('english')} /> : null}{lecture.sourceTranscript?.length ? <SecondaryButton label="Share original-language transcript" onPress={() => onShareTranscript('source')} /> : null}</View> : null}
            {lecture.transcript.length ? <View style={styles.buttonRow}>{savedJob?.id && savedJob.status !== 'applied' ? <SecondaryButton label={jobActionLabel} onPress={() => onComputerTranscribe(savedJob.audioInputSource || 'original')} disabled={transcriptionBusy} /> : null}<SecondaryButton label="Replace JSON transcript" onPress={onImportTranscript} /></View> : null}
            {lecture.sourceTranscript?.length ? <View style={styles.infoCard}><Text style={styles.infoTitle}>Original-language transcript · read-only</Text><Text style={styles.infoText}>This is the preserved source-language recognition pass. It is separate from the editable English transcript.</Text>{lecture.sourceTranscript.map((segment) => <View key={`source-${segment.id}`} style={[styles.transcriptRow, segment.uncertain && styles.uncertainRow]}><Pressable accessibilityRole="button" accessibilityLabel={`Play source transcript at ${formatTime(segment.startTime)}`} onPress={() => onSeekOriginal(segment.startTime)}><Text style={styles.timestamp}>{formatTime(segment.startTime)} – {formatTime(segment.endTime)}</Text></Pressable><Text style={styles.studyText}>{segment.editedText || segment.originalText}</Text><Text style={styles.meta}>{segment.uncertain ? 'Needs verification against audio' : 'Machine transcript'} · {segment.speaker || 'Speaker'}</Text></View>)}</View> : null}
          </>
        )}
        {detailTab === 'notes' && <StudyPackView lecture={lecture} mode="notes" fresh={fresh} onGenerate={onGenerateStudy} onSeekOriginal={onSeekOriginal} />}
        {detailTab === 'study' && <StudyPackView lecture={lecture} mode="study" fresh={fresh} onGenerate={onGenerateStudy} onSeekOriginal={onSeekOriginal} />}
      </ScrollView>
    </View>
  );
}

function StudyPackView({ lecture, mode, fresh, onGenerate, onSeekOriginal }) {
  const pack = lecture.studyPack;
  if (!lecture.transcript.length) return <Empty title="A transcript is required" body="Study material should never be invented without source text. Import or generate a timestamped transcript first." />;
  if (!pack || !fresh) return <Empty title={pack ? 'Transcript changed' : 'Study pack not generated yet'} body={pack ? 'Your transcript is newer than the current notes. Update derived content so corrections propagate instead of leaving stale notes.' : 'Generate a source-grounded pack from trustworthy transcript sections across the whole lecture.'} action={<PrimaryButton label={pack ? 'Update derived content' : 'Generate study pack'} onPress={onGenerate} />} />;
  const sourceList = (sectionTitle, items) => items?.length ? <View style={styles.studySection}><Text style={styles.studyHeading}>{sectionTitle}</Text>{items.map((item, index) => <View key={`${sectionTitle}-${index}`} style={styles.studyItem}><Text style={styles.studyText}>{item.text}</Text>{item.source ? <Pressable onPress={() => onSeekOriginal(item.source.startTime)}><Text style={styles.sourceLink}>▶ {formatTime(item.source.startTime)} original source audio</Text></Pressable> : null}</View>)}</View> : null;
  return (
    <>
      {pack.warning ? <View style={styles.warningCard}><Text style={styles.warningText}>{pack.warning}</Text></View> : null}
      {mode === 'notes' ? <>{sourceList('Lecture summary', pack.summary)}{sourceList('Detailed lecture notes', pack.detailedNotes)}<View style={styles.studySection}><Text style={styles.studyHeading}>Key concepts</Text><View style={styles.badgeRow}>{pack.keyConcepts.map((concept) => <Badge key={concept} text={concept} good />)}</View></View>{sourceList('Definitions', pack.definitions)}{sourceList('Examples', pack.examples)}{sourceList('Formulas / technical information', pack.technicalInformation)}{sourceList('Lecture emphasis', pack.professorEmphasis)}</> : <><View style={styles.studySection}><Text style={styles.studyHeading}>Possible exam review topics</Text>{pack.possibleExamTopics.map((item, index) => <View key={index} style={styles.studyItem}><Text style={styles.studyText}>{item.topic}</Text><Text style={styles.meta}>{item.note}</Text></View>)}</View><View style={styles.studySection}><Text style={styles.studyHeading}>Study questions</Text>{pack.studyQuestions.map((item, index) => <View key={index} style={styles.studyItem}><Text style={styles.questionType}>{item.type.toUpperCase()}</Text><Text style={styles.studyText}>{item.question}</Text></View>)}</View></>}
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

function PrimaryButton({ label, onPress, disabled = false }) {
  return <Pressable accessible accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} style={({ pressed }) => [styles.primaryButton, disabled && styles.disabled, pressed && !disabled && styles.pressed]} onPress={onPress}><Text style={styles.primaryButtonText}>{label}</Text></Pressable>;
}

function SecondaryButton({ label, onPress, compact = false, disabled = false }) {
  return <Pressable accessible accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} style={({ pressed }) => [styles.secondaryButton, compact && styles.compactButton, disabled && styles.disabled, pressed && !disabled && styles.pressed]} onPress={onPress}><Text style={styles.secondaryButtonText}>{label}</Text></Pressable>;
}

function DangerButton({ label, onPress }) {
  return <Pressable accessible accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.dangerButton, pressed && styles.pressed]} onPress={onPress}><Text style={styles.dangerButtonText}>{label}</Text></Pressable>;
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
  scroll: { width: '100%', maxWidth: 900, alignSelf: 'center', padding: 20, paddingBottom: 42 },
  eyebrow: { color: '#527064', fontWeight: '900', fontSize: 10, letterSpacing: 1.1, marginBottom: 7 },
  hero: { color: '#173129', fontWeight: '900', fontSize: 32, lineHeight: 36, letterSpacing: -.8 },
  sectionTitle: { color: '#173129', fontWeight: '900', fontSize: 30, letterSpacing: -.6 },
  lead: { color: '#587066', fontSize: 15, lineHeight: 22, marginTop: 9 },
  card: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#DFE8E3', borderRadius: 22, padding: 18, marginTop: 20 },
  cardTitle: { color: '#173129', fontWeight: '900', fontSize: 19 },
  fieldLabel: { color: '#527064', fontWeight: '900', fontSize: 11, letterSpacing: .4 },
  protectedLabel: { color: '#1F6B4F', fontSize: 13, fontWeight: '800', marginTop: 4 },
  derivedLabel: { color: '#546B62', fontSize: 13, fontWeight: '700', marginTop: 4 },
  titleInput: { borderBottomWidth: 1, borderBottomColor: '#DDE5E0', paddingVertical: 10, color: '#173129', fontSize: 18, fontWeight: '800' },
  textField: { borderWidth: 1, borderColor: '#D4DFD9', backgroundColor: '#FAFCFB', borderRadius: 13, paddingHorizontal: 12, paddingVertical: 11, marginTop: 10, color: '#173129', fontSize: 14 },
  inlineCode: { fontFamily: 'monospace', fontWeight: '800' },
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
  secondaryButton: { minHeight: 48, borderRadius: 15, borderWidth: 1, borderColor: '#C8D8D0', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 9, marginTop: 10, flex: 1 },
  compactButton: { flex: 0, minHeight: 42, marginTop: 0 },
  secondaryButtonText: { color: '#214F3D', fontWeight: '800', fontSize: 12, textAlign: 'center' },
  dangerButton: { minHeight: 50, borderRadius: 15, backgroundColor: '#8F3D3D', alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  dangerButtonText: { color: '#FFF', fontWeight: '900', fontSize: 14 },
  disabled: { opacity: .45 },
  pressed: { opacity: .72 },
  buttonRow: { flexDirection: 'row', gap: 7 },
  infoCard: { backgroundColor: '#EDF3EF', borderRadius: 18, padding: 16, marginTop: 14 },
  infoTitle: { color: '#173129', fontWeight: '900', fontSize: 15, marginBottom: 5 },
  infoText: { color: '#456257', fontSize: 13, lineHeight: 20, marginTop: 3 },
  warningCard: { backgroundColor: '#FFF0DB', borderRadius: 18, padding: 16, marginTop: 14 },
  warningTitle: { color: '#6E4A16', fontWeight: '900', fontSize: 14 },
  warningText: { color: '#795D32', fontSize: 13, lineHeight: 19, marginTop: 4 },
  recoveryText: { color: '#8A5D1F', fontSize: 12, fontWeight: '800', marginTop: 7 },
  savedCard: { backgroundColor: '#FFF', borderRadius: 20, borderWidth: 1, borderColor: '#CFE1D8', padding: 17, marginTop: 16 },
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
  connectionMessage: { color: '#315F4B', fontSize: 12, fontWeight: '800', marginTop: 10, lineHeight: 18 },
  linkText: { color: '#226FA8', fontSize: 13, fontWeight: '800', marginTop: 12 },
  tabBar: { minHeight: 66, flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#D9E2DD', backgroundColor: '#FBFCFA', paddingHorizontal: 8, paddingBottom: 4 },
  tabButton: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: 13, marginVertical: 5 },
  tabButtonActive: { backgroundColor: '#E9F0EC' },
  tabIcon: { color: '#7A8B83', fontSize: 16 },
  tabText: { color: '#7A8B83', fontWeight: '700', fontSize: 10 },
  tabTextActive: { color: '#214F3D' },
  detailHeader: { padding: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#D9E2DD' },
  back: { color: '#315F4B', fontWeight: '800', fontSize: 13, marginBottom: 10 },
  detailTitle: { color: '#173129', fontWeight: '900', fontSize: 24 },
  renameCard: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#D8E4DE', borderRadius: 16, padding: 13 },
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
  progressCard: { backgroundColor: '#EAF1ED', borderRadius: 14, padding: 12, marginBottom: 12 },
  progressText: { color: '#315F4B', fontWeight: '800', fontSize: 12 },
  progressTrack: { height: 6, borderRadius: 8, backgroundColor: '#D1DDD7', overflow: 'hidden', marginTop: 8 },
  progressFill: { height: '100%', backgroundColor: '#315F4B' },
});
