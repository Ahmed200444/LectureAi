'use client';

import { AlertTriangle, Bookmark, Check, ChevronLeft, CircleStop, Download, FilePlus2, HardDrive, Mic, Pause, Play, ShieldCheck, Star } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getAudio, saveLecture } from '../lib/db';
import { downloadBlob } from '../lib/export';
import { formatBytes, formatTime } from '../lib/format';
import type { Course, Lecture } from '../lib/types';
import { useRecorder } from '../hooks/use-recorder';
import { deviceLabel, detectDeviceKind, recordingFileExtension } from '../lib/device';
import { MicTest } from './MicTest';

interface RecordingFlowProps {
  courses: Course[];
  onClose: () => void;
  onSaved: (lecture: Lecture) => void;
  onOpenLecture: (lecture: Lecture) => void;
}

type RecordingOperation = 'idle' | 'starting' | 'pausing' | 'resuming' | 'finishing';

export function RecordingFlow({ courses, onClose, onSaved, onOpenLecture }: RecordingFlowProps) {
  const [stage, setStage] = useState<'setup' | 'recording' | 'saved'>('setup');
  const [operation, setOperation] = useState<RecordingOperation>('idle');
  const [courseId, setCourseId] = useState(courses[0]?.id || '');
  const [title, setTitle] = useState(`Lecture ${new Date().toLocaleDateString('en', { month: 'short', day: 'numeric' })}`);
  const [lecture, setLecture] = useState<Lecture | null>(null);
  const [storage, setStorage] = useState<{ quota?: number; usage?: number }>({});
  const [visibilityWarning, setVisibilityWarning] = useState(false);
  const [storageWarning, setStorageWarning] = useState('');
  const [setupError, setSetupError] = useState('');
  const [controlError, setControlError] = useState('');
  const [micVerified, setMicVerified] = useState(false);
  const [savedAudioUrl, setSavedAudioUrl] = useState('');
  const recorder = useRecorder();
  const course = useMemo(() => courses.find((item) => item.id === courseId), [courseId, courses]);
  const controlsBusy = operation !== 'idle';

  useEffect(() => { navigator.storage?.estimate().then(setStorage).catch(() => undefined); }, []);
  useEffect(() => {
    if (stage !== 'saved' || !lecture || lecture.status === 'interrupted') { setSavedAudioUrl(''); return; }
    let cancelled = false;
    let url = '';
    void getAudio(lecture.id).then((audio) => {
      if (!audio || cancelled) return;
      url = URL.createObjectURL(audio.blob);
      setSavedAudioUrl(url);
    }).catch(() => undefined);
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [stage, lecture]);
  useEffect(() => {
    if (stage !== 'recording') return;
    let cancelled = false;
    const checkStorage = async () => {
      try {
        const estimate = await navigator.storage?.estimate();
        if (!estimate || cancelled) return;
        setStorage(estimate);
        const free = Math.max(0, (estimate.quota || 0) - (estimate.usage || 0));
        if (estimate.quota && free < 100 * 1024 * 1024) {
          setStorageWarning(`Only ${formatBytes(free)} of estimated browser storage remains. LectureAI has no recording-time quota, but free storage is required to keep saving checkpoints.`);
        } else {
          setStorageWarning('');
        }
      } catch { /* Storage estimates are best effort. */ }
    };
    void checkStorage();
    const timer = window.setInterval(() => void checkStorage(), 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [stage]);
  useEffect(() => {
    const handleVisibility = () => setVisibilityWarning(document.hidden && recorder.isRecording);
    const handleUnload = (event: BeforeUnloadEvent) => { if (recorder.isRecording || recorder.isPaused) { event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('beforeunload', handleUnload);
    return () => { document.removeEventListener('visibilitychange', handleVisibility); window.removeEventListener('beforeunload', handleUnload); };
  }, [recorder.isPaused, recorder.isRecording]);

  async function begin() {
    if (operation !== 'idle') return;
    setOperation('starting');
    const now = new Date().toISOString();
    const newLecture: Lecture = {
      id: crypto.randomUUID(), courseId, title: title.trim() || 'Untitled lecture', date: now, duration: 0, size: 0,
      status: 'recording', statusMessage: 'Recording in progress · audio is checkpointed every 5 seconds', segments: [], englishTranslation: [], arabicTranslation: [],
      bookmarks: [], attachments: [], notesOriginal: '', notesCurrent: '', noteVersions: [], createdAt: now, updatedAt: now,
    };
    try {
      setSetupError('');
      setControlError('');
      await navigator.storage?.persist?.().catch(() => false);
      await recorder.start(newLecture.id);
      await saveLecture(newLecture);
      setLecture(newLecture);
      onSaved(newLecture);
      setStage('recording');
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'Could not start recording.');
    } finally {
      setOperation('idle');
    }
  }

  async function markMoment() {
    if (!lecture || controlsBusy) return;
    const updated: Lecture = { ...lecture, bookmarks: [...lecture.bookmarks, { id: crypto.randomUUID(), time: recorder.duration, label: `Important moment — ${formatTime(recorder.duration)}` }] };
    setLecture(updated);
    await saveLecture(updated);
    onSaved(updated);
  }

  async function pauseCurrent() {
    if (!lecture || recorder.isInterrupted || recorder.isPaused || operation !== 'idle') return;
    setOperation('pausing');
    try {
      setControlError('');
      const result = await recorder.pause();
      const updated: Lecture = {
        ...lecture,
        duration: result.duration,
        status: 'recording',
        statusMessage: 'Recording paused · microphone session kept live and checkpoints preserved · ready to continue',
        updatedAt: new Date().toISOString(),
      };
      setLecture(updated);
      await saveLecture(updated);
      onSaved(updated);
    } catch (error) {
      setControlError(error instanceof Error ? error.message : 'Could not pause the recording safely. Recording state was left unchanged.');
    } finally {
      setOperation('idle');
    }
  }

  async function resumeCurrent() {
    if (!lecture || recorder.isInterrupted || !recorder.isPaused || operation !== 'idle') return;
    setOperation('resuming');
    try {
      setControlError('');
      await recorder.resume();
      const updated: Lecture = {
        ...lecture,
        status: 'recording',
        statusMessage: 'Recording continued · same microphone session and checkpoint sequence are active',
        updatedAt: new Date().toISOString(),
      };
      setLecture(updated);
      await saveLecture(updated);
      onSaved(updated);
    } catch (error) {
      setControlError(error instanceof Error ? error.message : 'Could not continue the recording. Saved checkpoints remain protected.');
    } finally {
      setOperation('idle');
    }
  }

  function prepareNewRecording() {
    if (controlsBusy) return;
    setLecture(null);
    setMicVerified(false);
    setSavedAudioUrl('');
    setControlError('');
    setTitle(`Lecture ${new Date().toLocaleDateString('en', { month: 'short', day: 'numeric' })}`);
    setVisibilityWarning(false);
    setStage('setup');
  }

  async function finishCurrent(startAnother = false) {
    if (!lecture || operation !== 'idle') return;
    setOperation('finishing');
    try {
      setControlError('');
      const result = await recorder.stop();
      const recovered = result.recoveredFromInterruption;
      const updated: Lecture = {
        ...lecture,
        duration: result.duration,
        size: result.blob.size,
        mimeType: result.mimeType,
        status: 'transcription-queued',
        statusMessage: recovered
          ? `Microphone session ended, but ${result.chunkCount} captured checkpoint${result.chunkCount === 1 ? '' : 's'} were assembled and playback-verified · ready to transcribe`
          : `Audio playback verified · ${result.chunkCount} captured checkpoint${result.chunkCount === 1 ? '' : 's'} assembled · ready to transcribe`,
        processingProgress: 0,
        updatedAt: new Date().toISOString(),
      };
      setLecture(updated);
      await saveLecture(updated);
      onSaved(updated);
      if (startAnother) prepareNewRecording();
      else setStage('saved');
    } catch (error) {
      const updated: Lecture = { ...lecture, status: 'interrupted', statusMessage: error instanceof Error ? error.message : 'Recording stopped unexpectedly. Recover saved chunks from the library.' };
      setLecture(updated);
      await saveLecture(updated);
      onSaved(updated);
      setStage('saved');
    } finally {
      setOperation('idle');
    }
  }

  async function exportAudio() {
    if (!lecture || controlsBusy) return;
    const audio = await getAudio(lecture.id);
    if (audio) downloadBlob(audio.blob, `${lecture.title}.${recordingFileExtension(audio.mimeType || audio.blob.type)}`);
  }

  if (stage === 'recording' && lecture) {
    const temporarilyPaused = recorder.isPaused && !recorder.isInterrupted;
    return (
      <div className="recording-screen" role="dialog" aria-modal="true" aria-label="Recording lecture">
        <header>
          <span className={recorder.isInterrupted || temporarilyPaused ? 'recording-paused' : 'recording-live'}>{!recorder.isInterrupted && !temporarilyPaused && <i />} {recorder.isInterrupted ? 'Microphone interrupted' : temporarilyPaused ? 'Paused' : operation === 'finishing' ? 'Finishing' : 'Recording'}</span>
          <span>{recorder.isInterrupted ? 'Captured checkpoints are ready to finalize' : temporarilyPaused ? 'Microphone session kept live · tap Continue recording when ready' : ['iphone', 'ipad'].includes(detectDeviceKind()) ? `Keep LectureAI visible on your ${deviceLabel()}` : `Recording on ${deviceLabel()}`}</span>
        </header>
        <main>
          <p className="eyebrow">{course?.code || 'LECTURE'} · {course?.name || 'NO COURSE'}</p>
          <h1>{lecture.title}</h1>
          <div className="recording-clock">{formatTime(recorder.duration, true)}</div>
          <div className="big-meter" aria-label={`Audio level ${Math.round(recorder.level * 100)} percent`}><i style={{ width: `${recorder.isInterrupted || temporarilyPaused ? 0 : Math.max(1, recorder.level * 100)}%` }} /></div>
          <p className={`level-label ${!recorder.isInterrupted && !temporarilyPaused && recorder.level < .04 ? 'warn' : ''}`}>{recorder.isInterrupted ? 'Microphone session ended — the audio already checkpointed is preserved.' : temporarilyPaused ? 'Recording paused — the same microphone session is being kept ready to continue.' : recorder.level < .04 ? 'Audio is quiet — recording is still running' : recorder.level > .94 ? 'Clipping risk — move the device farther away' : 'Audio level looks good'}</p>
          <div className="checkpoint-status"><ShieldCheck size={16} /> {recorder.chunkCount} encoded checkpoint chunk{recorder.chunkCount === 1 ? '' : 's'} captured</div>
          {visibilityWarning && <div className="inline-warning"><AlertTriangle size={17} /> iOS/iPadOS may suspend browser recording in the background. Return to LectureAI and keep the screen awake.</div>}
          {storageWarning && <div className="inline-warning"><AlertTriangle size={17} /> {storageWarning}</div>}
          {recorder.error && <div className="inline-warning"><AlertTriangle size={17} /> {recorder.error}</div>}
          {controlError && <div className="inline-warning"><AlertTriangle size={17} /> {controlError}</div>}
          {recorder.isInterrupted ? <div className="recording-actions paused-actions">
            <button disabled={controlsBusy} className="finish-button" onClick={() => finishCurrent(false)}><CircleStop size={20} /> {operation === 'finishing' ? 'Finishing…' : 'Finish & save recovered recording'}</button>
            <small>LectureAI will assemble the checkpoints already stored on this device and verify that the resulting audio can be played before deleting those checkpoints.</small>
          </div> : temporarilyPaused ? <div className="recording-actions paused-actions">
            <button disabled={controlsBusy} className="mark-button" onClick={resumeCurrent}><Play size={20} /> {operation === 'resuming' ? 'Continuing…' : 'Continue recording'}</button>
            <button disabled={controlsBusy} className="stop-button" onClick={() => finishCurrent(false)}><CircleStop size={22} /> {operation === 'finishing' ? 'Finishing…' : 'Finish & save'}</button>
            <small>Continue resumes the same microphone session and same lecture. Finish & save permanently ends this recording.</small>
          </div> : <div className="recording-actions">
            <button disabled={controlsBusy} className="mark-button" onClick={markMoment}><Star size={20} /> Mark moment</button>
            <button disabled={controlsBusy} className="mark-button" onClick={pauseCurrent}><Pause size={20} /> {operation === 'pausing' ? 'Pausing…' : 'Pause recording'}</button>
            <button disabled={controlsBusy} className="stop-button" onClick={() => finishCurrent(false)}><CircleStop size={22} /> {operation === 'finishing' ? 'Finishing…' : 'Finish & save'}</button>
          </div>}
        </main>
      </div>
    );
  }

  if (stage === 'saved' && lecture) {
    return (
      <div className="modal-backdrop"><section className="modal-card post-save" role="dialog" aria-modal="true" aria-labelledby="saved-title">
        <span className="success-icon"><Check size={30} /></span><p className="eyebrow">Original audio preserved</p><h2 id="saved-title">{lecture.status === 'interrupted' ? 'Recording needs recovery' : 'Recording verified & saved'}</h2><p>{lecture.statusMessage}</p>
        {lecture.status === 'interrupted' ? <div className="inline-warning"><AlertTriangle size={17} /> Saved checkpoints were kept. Open the lecture to recover them before transcription.</div> : <div className="inline-note"><ShieldCheck size={16} /> LectureAI reloaded the assembled audio successfully before marking this recording as saved.</div>}
        {savedAudioUrl && <audio className="sample-player" src={savedAudioUrl} controls aria-label="Verify saved lecture audio" />}
        <dl className="save-details"><div><dt>Duration</dt><dd>{formatTime(lecture.duration, true)}</dd></div><div><dt>Size</dt><dd>{formatBytes(lecture.size)}</dd></div><div><dt>Marks</dt><dd>{lecture.bookmarks.length}</dd></div></dl>
        <div className="post-actions">
          {lecture.status === 'interrupted' ? <button className="primary-button" onClick={() => onOpenLecture(lecture)}><HardDrive size={18} /> Open recovery</button> : <>
            <button className="primary-button" onClick={() => onOpenLecture(lecture)}><HardDrive size={18} /> Open transcript options</button>
            <button className="secondary-button" onClick={() => onOpenLecture(lecture)}><Mic size={18} /> Transcribe on this device</button>
            <button className="secondary-button" onClick={exportAudio}><Download size={18} /> Share / export original audio</button>
          </>}
          <button className="secondary-button" onClick={prepareNewRecording}><FilePlus2 size={18} /> Start a new recording</button>
        </div>
        <button className="text-button" onClick={onClose}>Back to library</button>
      </section></div>
    );
  }

  return (
    <div className="modal-backdrop"><section className="modal-card recording-setup" role="dialog" aria-modal="true" aria-labelledby="record-title">
      <button className="back-button" disabled={controlsBusy} onClick={onClose} aria-label="Close recording setup"><ChevronLeft size={20} /></button>
      <p className="eyebrow">New recording</p><h2 id="record-title">Prepare your lecture</h2><p className="modal-intro">Original audio is saved in frequent local checkpoints. There is no artificial recording limit.</p>
      <label className="field-label">Lecture title<input disabled={controlsBusy} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="field-label">Course<select disabled={controlsBusy} value={courseId} onChange={(event) => setCourseId(event.target.value)}><option value="">No course</option>{courses.map((item) => <option key={item.id} value={item.id}>{item.code} — {item.name}</option>)}</select></label>
      <MicTest onVerified={() => setMicVerified(true)} onReset={() => setMicVerified(false)} />
      {setupError && <div className="inline-warning"><AlertTriangle size={17} /> {setupError}</div>}
      <div className="storage-line"><HardDrive size={16} /><span>{storage.quota ? `${formatBytes(Math.max(0, (storage.quota || 0) - (storage.usage || 0)))} estimated free browser storage` : 'Storage will be checked during recording'}</span></div>
      <div className="inline-note"><Bookmark size={16} /> LectureAI does not impose a recording-duration quota. Keep the microphone unobstructed and the iPhone/iPad screen on with LectureAI visible; iOS can still terminate a browser microphone session if the page is suspended or microphone access is interrupted.</div>
      {!micVerified && <small>Record the microphone sample and confirm you can hear it before starting. This prevents a silent lecture from being accepted by mistake.</small>}
      <button className="primary-button wide" onClick={begin} disabled={!micVerified || controlsBusy}><span className="record-dot" /> {operation === 'starting' ? 'Verifying & starting…' : 'Start a new recording'}</button>
    </section></div>
  );
}