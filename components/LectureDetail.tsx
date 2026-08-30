'use client';

import { AlertTriangle, ArrowLeft, Check, ChevronDown, Download, FileAudio, FileJson, FileText, Gauge, Languages, Pause, Pencil, Play, RotateCcw, SearchCheck, SkipBack, SkipForward, Sparkles, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { addAttachment, deleteAudioChunks, deleteLectureData, finalizeAudio, getAudio, getAudioChunks } from '../lib/db';
import { downloadBlob, exportDocx, exportMarkdown, exportTranscriptText, printPdf } from '../lib/export';
import { detectDirection, formatBytes, formatDuration, formatTime, friendlyDate } from '../lib/format';
import { transcribeOnPhone } from '../lib/phone-transcription';
import { normalizeTranscript } from '../lib/transcript';
import { completeTranscription, phoneTranscriptionSupported, transcribeWithWindowsHelper, windowsHelperAvailable } from '../lib/transcription';
import type { AppSettings, Course, Lecture, TranscriptSegment } from '../lib/types';
import { detectDeviceKind, deviceLabel, recordingFileExtension } from '../lib/device';
import { validatePlayableAudio } from '../lib/audio-validation';
import { NotesEditor } from './NotesEditor';

type LectureTab = 'original' | 'corrected' | 'english' | 'arabic' | 'notes' | 'review' | 'attachments';

interface LectureDetailProps {
  lecture: Lecture;
  course?: Course;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => Promise<void>;
  followTranscript: boolean;
  onFollowChange: (value: boolean) => void;
  onBack: () => void;
  onChange: (lecture: Lecture) => Promise<void>;
  onDeleted: () => void;
  onToast: (message: string, tone?: 'success' | 'warning') => void;
}

const tabs: Array<{ id: LectureTab; label: string }> = [
  { id: 'original', label: 'Original transcript' }, { id: 'corrected', label: 'Corrected' }, { id: 'english', label: 'English' }, { id: 'arabic', label: 'العربية' }, { id: 'notes', label: 'Lecture notes' }, { id: 'review', label: 'Review' }, { id: 'attachments', label: 'Attachments' },
];

function measuredConfidence(segment: TranscriptSegment) {
  return typeof segment.confidence === 'number' && Number.isFinite(segment.confidence) ? segment.confidence : undefined;
}

function needsReview(segment: TranscriptSegment) {
  if (segment.manuallyReviewed) return false;
  const confidence = measuredConfidence(segment);
  return (confidence !== undefined && confidence < .85) || /\[(uncertain|inaudible)\]/i.test(segment.editedText || segment.originalText);
}

export function LectureDetail({ lecture, course, settings, onSettingsChange, followTranscript, onFollowChange, onBack, onChange, onDeleted, onToast }: LectureDetailProps) {
  const [tab, setTab] = useState<LectureTab>('original');
  const [audioUrl, setAudioUrl] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showExport, setShowExport] = useState(false);
  const [processing, setProcessing] = useState('');
  const [helperReady, setHelperReady] = useState<boolean | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const attachmentRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let url = '';
    getAudio(lecture.id).then((audio) => {
      if (audio) { url = URL.createObjectURL(audio.blob); setAudioUrl(url); }
      else setAudioUrl('');
    }).catch(() => setAudioUrl(''));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [lecture.id, lecture.size]);

  useEffect(() => {
    if (detectDeviceKind() !== 'windows') { setHelperReady(null); return; }
    let cancelled = false;
    const check = async () => {
      const ready = await windowsHelperAvailable();
      if (!cancelled) setHelperReady(ready);
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, 3500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const currentSegments = useMemo(() => tab === 'english' ? lecture.englishTranslation : tab === 'arabic' ? lecture.arabicTranslation : lecture.segments, [lecture, tab]);
  const activeSegment = useMemo(() => currentSegments.find((segment) => currentTime >= segment.startTime && currentTime < segment.endTime) || null, [currentSegments, currentTime]);
  const uncertain = useMemo(() => lecture.segments.filter(needsReview), [lecture.segments]);

  useEffect(() => {
    if (followTranscript && activeRef.current && isPlaying) activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeSegment?.id, followTranscript, isPlaying]);

  function seek(time: number, autoplay = false) {
    setCurrentTime(time);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      if (autoplay) audioRef.current.play().catch(() => undefined);
    } else onToast('No original audio is attached to this lecture.', 'warning');
  }

  function nudge(delta: number) { seek(Math.max(0, Math.min(lecture.duration || 0, currentTime + delta))); }

  async function updateSegment(segmentId: string, patch: Partial<TranscriptSegment>) {
    const segments = lecture.segments.map((segment) => segment.id === segmentId ? { ...segment, ...patch } : segment);
    await onChange({ ...lecture, segments, statusMessage: 'Transcript edit saved locally', updatedAt: new Date().toISOString() });
  }

  async function importTranscript(file: File) {
    setProcessing('Checking transcript segments…');
    try {
      const segments = normalizeTranscript(JSON.parse(await file.text()), lecture.id);
      const duration = Math.max(lecture.duration, segments.at(-1)?.endTime || 0);
      const checking = { ...lecture, segments, duration, status: 'generating-notes' as const, statusMessage: 'Transcript imported · generating editable notes', processingProgress: 94 };
      await onChange(checking);
      setProcessing('Generating editable notes…');
      const completed = completeTranscription(lecture, { segments }, 'import', 'Imported timestamped JSON');
      await onChange(completed);
      setTab('original');
      onToast('Transcript imported and editable lecture notes generated automatically.', 'success');
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not import transcript.', 'warning');
    } finally { setProcessing(''); }
  }

  async function runComputerTranscription() {
    const audio = await getAudio(lecture.id);
    if (!audio) return onToast('Record or attach original audio before transcription.', 'warning');
    const device = detectDeviceKind();
    if (device !== 'windows') {
      downloadBlob(audio.blob, `${lecture.title}.${recordingFileExtension(audio.mimeType || audio.blob.type)}`);
      onToast(`Original recording exported from ${deviceLabel()}. Transfer it to your Windows laptop, open LectureAI there, choose Import recording, then Transcribe on Computer.`, 'success');
      return;
    }
    let working = lecture;
    const update = async (patch: Partial<Lecture>) => {
      working = { ...working, ...patch, updatedAt: new Date().toISOString() };
      await onChange(working);
    };
    setTab('original');
    setProcessing('Connecting to the private Windows transcription service…');
    await update({ status: 'preparing', processingProgress: 3, statusMessage: 'Original audio preserved · connecting to the Windows transcription helper' });
    try {
      if (!await windowsHelperAvailable()) throw new Error(`Windows transcription helper not detected. Run ${window.location.hostname.endsWith('chatgpt.site') ? 'start-helper-for-hosted-site.bat' : 'start-lectureai.bat'} on this Windows computer, then retry.`);
      const payload = await transcribeWithWindowsHelper(working, course, audio.blob, ({ progress, message }) => {
        setProcessing(message);
        void update({ status: 'transcribing', processingProgress: progress, statusMessage: message });
      });
      await update(completeTranscription(working, payload, 'windows', 'Configured faster-whisper multilingual model'));
      setTab('original');
      onToast('Computer transcription and notes are ready.', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Computer transcription could not finish.';
      await update({ status: 'needs-transcription', processingProgress: undefined, statusMessage: `Original audio preserved · ${message}` });
      onToast(message, 'warning');
    } finally { setProcessing(''); }
  }

  async function runPhoneTranscription() {
    const audio = await getAudio(lecture.id);
    if (!audio) return onToast('Record or attach original audio before transcription.', 'warning');
    if (!phoneTranscriptionSupported()) return onToast('This browser cannot run the on-device speech model. Transfer the recording to Windows and use Transcribe on Computer.', 'warning');
    let working = lecture;
    const update = async (patch: Partial<Lecture>) => {
      working = { ...working, ...patch, updatedAt: new Date().toISOString() };
      await onChange(working);
    };
    setTab('original');
    try {
      await update({ status: 'preparing', processingProgress: 3, statusMessage: 'Preparing private on-device transcription' });
      const payload = await transcribeOnPhone(working.id, audio.blob, ({ progress, message }) => {
        setProcessing(message);
        void update({ status: 'transcribing', processingProgress: progress, statusMessage: message });
      }, () => {
        if (!settings.phoneModelInstalled) void onSettingsChange({ ...settings, phoneModelInstalled: true, preferredMode: 'phone' });
      });
      const completed = completeTranscription(working, payload, 'phone', 'Whisper multilingual');
      await update(completed);
      setTab(completed.englishTranslation.length ? 'english' : 'original');
      onToast(completed.englishTranslation.length ? 'Transcript ready · English view opened first. Original multilingual transcript is preserved.' : 'On-device transcript and editable notes are ready.', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'On-device transcription could not finish.';
      await update({ status: 'needs-transcription', processingProgress: undefined, statusMessage: `Original audio preserved · ${message}` });
      onToast(`${message} The original recording is still safe; you can retry on this device or transfer it to Windows and use Transcribe on Computer.`, 'warning');
    } finally { setProcessing(''); }
  }

  async function recoverRecording() {
    try {
      const chunks = await getAudioChunks(lecture.id);
      if (!chunks.length) throw new Error('No checkpoint chunks were found.');
      const blob = await finalizeAudio(lecture.id, chunks[0].mimeType);
      const verified = await validatePlayableAudio(blob);
      await deleteAudioChunks(lecture.id);
      await onChange({ ...lecture, duration: verified.duration || lecture.duration, size: blob.size, mimeType: blob.type, status: 'transcription-queued', statusMessage: `${chunks.length} recording checkpoints recovered and playback-validated · transcription queued`, processingProgress: 0 });
      onToast(`Recovered ${chunks.length} audio checkpoints.`, 'success');
    } catch (error) { onToast(error instanceof Error ? error.message : 'Recovery failed.', 'warning'); }
  }

  async function exportOriginalAudio() {
    const audio = await getAudio(lecture.id);
    if (!audio) return onToast('No original audio is stored for this lecture.', 'warning');
    downloadBlob(audio.blob, `${lecture.title}.${recordingFileExtension(audio.mimeType || audio.blob.type)}`);
  }

  async function addFiles(files: FileList | null) {
    if (!files) return;
    const attachments = [...lecture.attachments];
    for (const file of Array.from(files).slice(0, 10)) {
      if (file.size > 100 * 1024 * 1024) { onToast(`${file.name} exceeds the 100 MB local attachment limit.`, 'warning'); continue; }
      const id = crypto.randomUUID();
      await addAttachment({ id, lectureId: lecture.id, blob: file, name: file.name, type: file.type, size: file.size });
      attachments.push({ id, name: file.name, type: file.type, size: file.size });
    }
    await onChange({ ...lecture, attachments });
    onToast('Attachment saved locally. Add its terminology to the course glossary before transcription.', 'success');
  }

  async function removeLecture() {
    if (!confirm(`Delete “${lecture.title}”, its original recording, transcript, notes, bookmarks, checkpoints, and attachments from this device? This cannot be undone.`)) return;
    audioRef.current?.pause();
    await deleteLectureData(lecture.id);
    onDeleted();
  }

  const hasCourse = course || { id: '', name: 'Unassigned course', code: 'LECTURE', professor: '', semester: '', description: '', glossary: [], color: '#315f4b', icon: 'L', createdAt: '' };

  return (
    <main className="lecture-page">
      <header className="lecture-page-header">
        <button className="back-link" onClick={onBack}><ArrowLeft size={18} /> Library</button>
        <div className="lecture-heading-row">
          <div className="course-icon large" style={{ background: `${hasCourse.color}18`, color: hasCourse.color }}>{hasCourse.icon}</div>
          <div><span className="course-label">{hasCourse.code} · {hasCourse.name}</span><h1>{lecture.title}</h1><p>{friendlyDate(lecture.date)} · {hasCourse.professor || 'Professor not set'} · {formatDuration(lecture.duration)}</p></div>
          <div className="lecture-actions">
            {lecture.segments.length > 0 && <button className="secondary-button" onClick={() => setTab('corrected')}><Pencil size={17} /> Edit transcript</button>}
            <button className="secondary-button" onClick={runComputerTranscription} disabled={['preparing', 'transcribing', 'generating-notes'].includes(lecture.status)}><Sparkles size={17} /> {detectDeviceKind() === 'windows' ? 'Transcribe on computer' : 'Send to computer'}</button>
            <div className="menu-wrap"><button className="secondary-button" onClick={() => setShowExport(!showExport)}><Download size={17} /> Export <ChevronDown size={14} /></button>{showExport && <div className="export-menu"><button onClick={() => exportDocx(hasCourse, lecture)}>Word document (.docx)</button><button onClick={() => printPdf(hasCourse, lecture)}>Print / Save as PDF</button><button onClick={() => exportMarkdown(hasCourse, lecture, 'combined')}>Combined Markdown</button><button onClick={() => exportMarkdown(hasCourse, lecture, 'notes')}>Notes Markdown</button><button onClick={() => exportTranscriptText(hasCourse, lecture)}>Transcript text</button><button onClick={exportOriginalAudio}>Original audio</button></div>}</div>
            <button className="secondary-button danger-text" onClick={removeLecture}><Trash2 size={17} /> Delete lecture</button>
          </div>
        </div>
        <div className={`processing-strip status-${lecture.status}`}><span>{processing || lecture.statusMessage || lecture.status}</span>{typeof lecture.processingProgress === 'number' && lecture.processingProgress < 100 && <div className="processing-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={lecture.processingProgress}><i style={{ width: `${lecture.processingProgress}%` }} /></div>}{lecture.status === 'interrupted' && <button onClick={recoverRecording}><RotateCcw size={14} /> Recover recording</button>}</div>
        {detectDeviceKind() === 'windows' && <div className={`helper-status ${helperReady ? 'ready' : helperReady === false ? 'offline' : 'checking'}`}><span>Computer Transcription Engine</span><strong>{helperReady ? 'Ready' : helperReady === false ? `Not connected — run ${window.location.hostname.endsWith('chatgpt.site') ? 'start-helper-for-hosted-site.bat' : 'start-lectureai.bat'}` : 'Checking…'}</strong>{helperReady === false && <button className="text-button" onClick={() => { setHelperReady(null); void windowsHelperAvailable().then(setHelperReady); }}>Check again</button>}</div>}
        <div className="lecture-tabs" role="tablist">{tabs.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}{item.id === 'review' && uncertain.length > 0 && <b>{uncertain.length}</b>}</button>)}</div>
      </header>

      <section className="lecture-content">
        {(tab === 'english' || tab === 'arabic') && lecture.segments.length > 0 && currentSegments.length === 0
          ? <section className="empty-state translation-empty"><Languages size={34} /><h2>{tab === 'english' ? 'English translation not generated yet' : 'الترجمة العربية غير مُنشأة بعد'}</h2><p>{tab === 'english' ? 'Your original English/Egyptian Arabic/MSA transcript is preserved. This build does not silently invent a translation without a verified local translation model.' : 'النص الأصلي بالإنجليزية والمصرية والعربية الفصحى محفوظ. هذا الإصدار لا ينشئ ترجمة غير موثوقة تلقائيًا.'}</p><button className="secondary-button" onClick={() => setTab('original')}>View original transcript</button></section>
          : (tab === 'original' || tab === 'corrected' || tab === 'english' || tab === 'arabic') && <TranscriptView segments={currentSegments} editable={tab === 'corrected'} activeId={activeSegment?.id} activeRef={activeRef} onSeek={seek} onEdit={updateSegment} lecture={lecture} onComputer={runComputerTranscription} onPhone={runPhoneTranscription} onImport={() => importRef.current?.click()} />}
        {tab === 'notes' && <NotesEditor lecture={lecture} onSave={onChange} onSeek={seek} />}
        {tab === 'review' && <ReviewPanel segments={uncertain} onSeek={seek} onEdit={updateSegment} />}
        {tab === 'attachments' && <section className="attachments-panel">
          <div className="accuracy-grid"><article><Gauge size={22} /><h3>Transcribe on Computer</h3><p>{detectDeviceKind() === 'windows' ? 'The saved recording is sent only to the loopback Windows helper and transcribed locally with the model configured for this computer.' : 'Export this original recording, transfer it to your Windows laptop, then import it into LectureAI there. A phone/iPad cannot connect to the laptop’s 127.0.0.1 helper directly.'}</p><button className="primary-button" onClick={runComputerTranscription}>{detectDeviceKind() === 'windows' ? 'Connect & transcribe' : 'Export for Windows'}</button></article><article><Languages size={22} /><h3>Transcribe on This Device</h3><p>Downloads a multilingual on-device model once, then keeps recordings on this device. It is smaller and may be less accurate than the computer model.</p><button className="secondary-button" onClick={runPhoneTranscription}>{settings.phoneModelInstalled ? 'Transcribe on this device' : 'Download model & transcribe'}</button></article></div>
          <section className="file-drop"><Upload size={25} /><h3>Advanced transcript import</h3><p>Use timestamped JSON only as a backup or developer workflow. LectureAI does not impose an artificial transcript file-size or segment-count quota.</p><button className="secondary-button" onClick={() => importRef.current?.click()}><FileJson size={17} /> Import transcript JSON</button></section>
          <section className="file-drop"><FileText size={25} /><h3>Slides and course context</h3><p>PDFs, slide exports, and vocabulary files remain local. Add extracted terminology to the course glossary so it guides recognition without overriding audio.</p><button className="secondary-button" onClick={() => attachmentRef.current?.click()}><Upload size={17} /> Add files</button>{lecture.attachments.length > 0 && <ul className="attachment-list">{lecture.attachments.map((attachment) => <li key={attachment.id}><FileText size={16} /><span>{attachment.name}</span><small>{formatBytes(attachment.size)}</small></li>)}</ul>}</section>
          <div className="danger-zone"><div><h3>Delete recording & lecture</h3><p>Deletes the original recording, lecture, transcript, notes, bookmarks, checkpoints, and attachments from this device.</p></div><button className="danger-button" onClick={removeLecture}><Trash2 size={16} /> Delete recording & lecture</button></div>
        </section>}
      </section>

      <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) importTranscript(file); event.target.value = ''; }} />
      <input ref={attachmentRef} type="file" accept="application/pdf,.pdf,.txt,.md,.docx" multiple hidden onChange={(event) => { addFiles(event.target.files); event.target.value = ''; }} />

      <div className="audio-player" aria-label="Lecture audio player">
        <audio ref={audioRef} src={audioUrl || undefined} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onEnded={() => setIsPlaying(false)} />
        <button onClick={() => nudge(-10)} aria-label="Back 10 seconds"><SkipBack size={16} />10</button><button onClick={() => nudge(-5)} aria-label="Back 5 seconds" className="small-nudge">−5</button>
        <button className="main-play" disabled={!audioUrl} onClick={() => { if (!audioRef.current) return; if (isPlaying) audioRef.current.pause(); else audioRef.current.play().catch(() => undefined); }} aria-label={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button>
        <button onClick={() => nudge(5)} aria-label="Forward 5 seconds" className="small-nudge">+5</button><button onClick={() => nudge(10)} aria-label="Forward 10 seconds"><SkipForward size={16} />10</button>
        <time>{formatTime(currentTime, lecture.duration >= 3600)}</time><input className="seek-range" type="range" min="0" max={Math.max(lecture.duration, 1)} step=".1" value={Math.min(currentTime, lecture.duration || 0)} onChange={(event) => seek(Number(event.target.value))} aria-label="Audio position" /><time>{formatTime(lecture.duration, lecture.duration >= 3600)}</time>
        <select aria-label="Playback speed" value={playbackRate} onChange={(event) => { const rate = Number(event.target.value); setPlaybackRate(rate); if (audioRef.current) audioRef.current.playbackRate = rate; }}>{[.75, 1, 1.25, 1.5, 2].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}</select>
        <label className="follow-toggle"><input type="checkbox" checked={followTranscript} onChange={(event) => onFollowChange(event.target.checked)} /> Follow transcript</label>
      </div>
    </main>
  );
}

function TranscriptView({ segments, editable, activeId, activeRef, onSeek, onEdit, lecture, onComputer, onPhone, onImport }: { segments: TranscriptSegment[]; editable: boolean; activeId?: string; activeRef: React.RefObject<HTMLDivElement | null>; onSeek: (time: number, autoplay?: boolean) => void; onEdit: (id: string, patch: Partial<TranscriptSegment>) => Promise<void>; lecture: Lecture; onComputer: () => void; onPhone: () => void; onImport: () => void }) {
  if (!segments.length) {
    const active = ['transcription-queued', 'preparing', 'transcribing', 'generating-notes'].includes(lecture.status);
    if (active) return <section className="empty-state transcription-empty"><Sparkles size={34} /><h2>{lecture.status === 'generating-notes' ? 'Generating editable notes…' : 'Transcribing lecture…'}</h2><p>{lecture.statusMessage || 'The original audio is preserved locally. Your transcript will appear here automatically.'}</p>{typeof lecture.processingProgress === 'number' && <div className="empty-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={lecture.processingProgress}><i style={{ width: `${lecture.processingProgress}%` }} /></div>}<small>Keep LectureAI open while transcription is running.</small></section>;
    return <section className="empty-state transcription-empty"><FileAudio size={34} /><h2>Choose how to transcribe</h2><p>The original audio is preserved locally. Use the on-device multilingual model on iPhone/iPad, or transfer/import it to Windows and use the local computer transcription engine.</p><div className="transcription-choice-row"><button className="primary-button" onClick={onPhone}><Languages size={17} /> Transcribe on This Device</button><button className="secondary-button" onClick={onComputer}><Gauge size={17} /> {detectDeviceKind() === 'windows' ? 'Transcribe on Computer' : 'Export for Windows'}</button></div><button className="text-button advanced-import" onClick={onImport}><FileJson size={15} /> Advanced: Import Transcript JSON</button></section>;
  }
  return <section className="transcript-document"><div className="transcript-guide"><SearchCheck size={18} /><span>Tap any timestamp or sentence to jump to the source audio. Low-confidence speech is marked for review.</span></div>{segments.map((segment) => {
    const active = segment.id === activeId;
    const uncertain = needsReview(segment);
    const confidence = measuredConfidence(segment);
    return <div key={segment.id} ref={active ? activeRef : undefined} className={`transcript-row ${active ? 'active' : ''} ${uncertain ? 'uncertain' : ''}`}>
      <button className="timestamp" onClick={() => onSeek(segment.startTime, true)}><span>{formatTime(segment.startTime)}</span><small>{formatTime(segment.endTime)}</small></button>
      <div className="segment-copy" onClick={!editable ? () => onSeek(segment.startTime, true) : undefined} role={!editable ? 'button' : undefined} tabIndex={!editable ? 0 : undefined} onKeyDown={!editable ? (event) => { if (event.key === 'Enter' || event.key === ' ') onSeek(segment.startTime, true); } : undefined}>
        <div className="speaker-line"><strong>{segment.speaker || 'Professor'}</strong><span>{segment.detectedLanguage === 'mixed' ? 'EN + مصري' : segment.detectedLanguage.toUpperCase()}</span>{uncertain && <span className="confidence-low"><AlertTriangle size={12} /> {confidence === undefined ? 'Verify against audio' : `${Math.round(confidence * 100)}% · verify`}</span>}{segment.manuallyReviewed && <span className="reviewed"><Check size={12} /> Reviewed</span>}</div>
        {editable ? <textarea dir={detectDirection(segment.editedText)} defaultValue={segment.editedText} onBlur={(event) => onEdit(segment.id, { editedText: event.target.value })} aria-label={`Edit transcript at ${formatTime(segment.startTime)}`} /> : <p dir="auto">{segment.originalText}</p>}
      </div>
    </div>;
  })}</section>;
}

function ReviewPanel({ segments, onSeek, onEdit }: { segments: TranscriptSegment[]; onSeek: (time: number, autoplay?: boolean) => void; onEdit: (id: string, patch: Partial<TranscriptSegment>) => Promise<void> }) {
  if (!segments.length) return <section className="empty-state"><Check size={34} /><h2>No uncertain sections</h2><p>Every automatically flagged transcript segment has been checked.</p></section>;
  return <section className="review-panel"><div className="panel-heading"><div><p className="eyebrow">Audio verification</p><h2>Review uncertain sections</h2></div><span>{segments.length} need attention</span></div>{segments.map((segment) => {
    const confidence = measuredConfidence(segment);
    return <article key={segment.id} className="review-card">
      {confidence === undefined
        ? <div className="confidence-ring"><AlertTriangle size={18} /><small>Verify</small></div>
        : <div className="confidence-ring" style={{ '--confidence': `${confidence * 100}%` } as React.CSSProperties}><strong>{Math.round(confidence * 100)}</strong><small>%</small></div>}
      <div className="review-copy"><button className="timestamp inline" onClick={() => onSeek(segment.startTime, true)}><Play size={13} /> {formatTime(segment.startTime)} – {formatTime(segment.endTime)}</button><textarea dir={detectDirection(segment.editedText)} defaultValue={segment.editedText} aria-label="Correct uncertain transcript" onBlur={(event) => onEdit(segment.id, { editedText: event.target.value })} /><div className="button-row compact"><button className="secondary-button" onClick={() => onSeek(segment.startTime, true)}><Play size={14} /> Play audio</button><button className="primary-button" onClick={() => onEdit(segment.id, { manuallyReviewed: true })}><Check size={14} /> Mark reviewed</button></div></div>
    </article>;
  })}</section>;
}
