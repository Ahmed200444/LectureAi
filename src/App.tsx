import { AlertTriangle, Archive, BookOpen, Check, ChevronRight, Clock3, CloudOff, Cpu, FileAudio, GraduationCap, HardDrive, Home, Library, LockKeyhole, Mic, Plus, Search, Settings, ShieldCheck, Sparkles, Star, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LectureDetail } from '../components/LectureDetail';
import { RecordingFlow } from '../components/RecordingFlow';
import { Diagnostics } from '../components/Diagnostics';
import { PhoneModelManager } from '../components/PhoneModelManager';
import { clearAllDataForDevelopmentTest, createBackup, getAudio, initializeDatabase, loadLibrary, saveCourse, saveImportedAudio, saveLecture, saveSettings } from '../lib/db';
import { exportBackupJson } from '../lib/export';
import { formatBytes, formatDuration, formatTime, friendlyDate } from '../lib/format';
import { transcribeOnPhone } from '../lib/phone-transcription';
import { completeTranscription, isPhoneOrTablet, phoneTranscriptionSupported, transcribeWithWindowsHelper, windowsHelperAvailable } from '../lib/transcription';
import type { AppSettings, Course, Lecture, ViewName } from '../lib/types';
import { validatePlayableAudio } from '../lib/audio-validation';
import { detectDeviceKind, deviceLabel } from '../lib/device';

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

const defaultSettings: AppSettings = { key: 'app', consentAcknowledged: false, followTranscript: true, preferredMode: 'computer', phoneModelInstalled: false };

export default function LectureAI() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [settings, setAppSettings] = useState<AppSettings>(defaultSettings);
  const [view, setView] = useState<ViewName>('home');
  const [selectedId, setSelectedId] = useState('');
  const [ready, setReady] = useState(false);
  const [recordingOpen, setRecordingOpen] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [courseModal, setCourseModal] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [storage, setStorage] = useState<{ quota?: number; usage?: number }>({});
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'warning' } | null>(null);
  const processingLectures = useRef(new Set<string>());
  const recordingImportRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const library = await loadLibrary();
    setCourses(library.courses);
    setLectures(library.lectures);
    setAppSettings(library.settings);
    navigator.storage?.estimate().then(setStorage).catch(() => undefined);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('reset-test-data') === '1') {
          await clearAllDataForDevelopmentTest();
          localStorage.clear();
          window.history.replaceState({}, '', window.location.pathname);
        }
        await initializeDatabase();
        await refresh();
      } catch (error) {
        setToast({ message: error instanceof Error ? error.message : 'Could not open local storage.', tone: 'warning' });
      } finally {
        setReady(true);
      }
    })();
    const beforeInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt); };
    window.addEventListener('beforeinstallprompt', beforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', beforeInstall);
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timeout);
  }, [toast]);

  const selectedLecture = lectures.find((lecture) => lecture.id === selectedId);
  const selectedCourse = courses.find((course) => course.id === selectedLecture?.courseId);

  function notify(message: string, tone: 'success' | 'warning' = 'success') { setToast({ message, tone }); }

  function beginRecording() {
    if (!settings.consentAcknowledged) setConsentOpen(true);
    else setRecordingOpen(true);
  }

  async function acknowledgeConsent() {
    if (!consentChecked) return;
    const next = { ...settings, consentAcknowledged: true };
    await saveSettings(next);
    setAppSettings(next);
    setConsentOpen(false);
    setRecordingOpen(true);
  }

  const handleLectureChange = useCallback(async (lecture: Lecture) => {
    await saveLecture(lecture);
    setLectures((current) => [lecture, ...current.filter((item) => item.id !== lecture.id)].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
  }, []);

  const handleSettingsChange = useCallback(async (next: AppSettings) => {
    setAppSettings(next);
    await saveSettings(next);
  }, []);

  useEffect(() => {
    const queued = lectures.find((lecture) => lecture.status === 'transcription-queued' && !processingLectures.current.has(lecture.id));
    if (!queued) return;
    processingLectures.current.add(queued.id);
    const course = courses.find((item) => item.id === queued.courseId);
    let working = queued;

    const update = async (patch: Partial<Lecture>) => {
      working = { ...working, ...patch, updatedAt: new Date().toISOString() };
      await handleLectureChange(working);
    };
    const progress = async ({ progress: value, message }: { progress: number; message: string }) => {
      await update({ status: 'transcribing', processingProgress: value, statusMessage: message });
    };

    void (async () => {
      try {
        const audio = await getAudio(queued.id);
        if (!audio) throw new Error('The saved original audio could not be found on this device.');
        await update({ status: 'preparing', processingProgress: 3, statusMessage: 'Original audio preserved · starting automatic transcription' });

        if (detectDeviceKind() === 'windows' && await windowsHelperAvailable()) {
          const payload = await transcribeWithWindowsHelper(working, course, audio.blob, (event) => { void progress(event); });
          await update(completeTranscription(working, payload, 'windows', 'Configured faster-whisper multilingual model'));
          return;
        }

        if (settings.phoneModelInstalled && phoneTranscriptionSupported()) {
          const payload = await transcribeOnPhone(working.id, audio.blob, (event) => { void progress(event); }, () => undefined);
          await update(completeTranscription(working, payload, 'phone', 'Whisper multilingual model'));
          return;
        }

        await update({
          status: 'needs-transcription',
          processingProgress: undefined,
          statusMessage: isPhoneOrTablet()
            ? 'Original audio preserved · choose Transcribe on This Device or export it to Windows'
            : 'Original audio preserved · start the Windows transcription helper or use the on-device model',
        });
      } catch (error) {
        await update({ status: 'needs-transcription', processingProgress: undefined, statusMessage: `Original audio preserved · ${error instanceof Error ? error.message : 'automatic transcription could not finish'}` });
      } finally {
        processingLectures.current.delete(queued.id);
      }
    })();
  }, [courses, handleLectureChange, lectures, settings.phoneModelInstalled]);

  function openLecture(lecture: Lecture) {
    setSelectedId(lecture.id);
    setView('lecture');
    setRecordingOpen(false);
  }

  function navigate(next: ViewName) {
    setView(next);
    if (next !== 'lecture') setSelectedId('');
  }

  async function updateFollow(value: boolean) {
    const next = { ...settings, followTranscript: value };
    setAppSettings(next);
    await saveSettings(next);
  }

  async function installApp() {
    if (installPrompt) {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      setInstallPrompt(null);
    } else {
      const device = detectDeviceKind();
      notify(device === 'iphone' || device === 'ipad'
        ? `On ${deviceLabel()}, open Safari’s Share menu and choose “Add to Home Screen”.`
        : 'Use your browser’s Install app / Create shortcut option if available.', 'warning');
    }
  }

  async function importRecording(file: File) {
    try {
      if (!file.size) throw new Error('The selected recording is empty.');
      const estimate = await navigator.storage?.estimate().catch(() => undefined);
      const free = estimate?.quota ? Math.max(0, estimate.quota - (estimate.usage || 0)) : undefined;
      if (typeof free === 'number' && free > 0 && file.size > free) {
        throw new Error(`This device currently reports only ${formatBytes(free)} of browser storage free, which is not enough to preserve this ${formatBytes(file.size)} recording.`);
      }
      const extension = file.name.split('.').pop()?.toLowerCase() || '';
      const inferredType = file.type || ({ m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', webm: 'audio/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac' } as Record<string, string>)[extension] || 'application/octet-stream';
      const importedFile = file.type ? file : new File([file], file.name, { type: inferredType, lastModified: file.lastModified });
      const verified = await validatePlayableAudio(importedFile);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const title = file.name.replace(/\.[^.]+$/, '').trim() || `Imported lecture ${new Date().toLocaleDateString()}`;
      const lecture: Lecture = {
        id, courseId: '', title, date: now, duration: verified.duration || 0, size: importedFile.size, mimeType: inferredType,
        status: 'transcription-queued', statusMessage: verified.browserDecoded ? 'Imported original audio · browser playback verified · transcription queued' : 'Imported original audio preserved · browser preview unavailable, Windows helper/FFmpeg will validate and transcribe it', processingProgress: 0,
        segments: [], englishTranslation: [], arabicTranslation: [], bookmarks: [], attachments: [], notesOriginal: '', notesCurrent: '', noteVersions: [], createdAt: now, updatedAt: now,
      };
      await navigator.storage?.persist?.().catch(() => false);
      await saveImportedAudio(id, importedFile);
      await saveLecture(lecture);
      await refresh();
      openLecture(lecture);
      notify(verified.browserDecoded ? `Recording imported and playback-verified on ${deviceLabel()}.` : 'Recording imported intact. The Windows helper will perform the authoritative media decode.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not import the recording.', 'warning');
    }
  }

  if (!ready) return <main className="loading-screen"><span className="brand-mark">L</span><p>Opening your private lecture library…</p></main>;

  if (view === 'lecture' && selectedLecture) {
    return <>
      <LectureDetail lecture={selectedLecture} course={selectedCourse} settings={settings} onSettingsChange={handleSettingsChange} followTranscript={settings.followTranscript} onFollowChange={updateFollow} onBack={() => navigate('lectures')} onChange={handleLectureChange} onDeleted={async () => { await refresh(); navigate('lectures'); }} onToast={notify} />
      {toast && <Toast {...toast} />}
    </>;
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate('home')}><span className="brand-mark">L</span><span>LectureAI</span></button>
        <nav aria-label="Primary navigation">
          <NavButton icon={<Home />} label="Home" active={view === 'home'} onClick={() => navigate('home')} />
          <NavButton icon={<Library />} label="Lectures" active={view === 'lectures'} onClick={() => navigate('lectures')} />
          <NavButton icon={<GraduationCap />} label="Courses" active={view === 'courses'} onClick={() => navigate('courses')} />
          <NavButton icon={<Search />} label="Search" active={view === 'search'} onClick={() => navigate('search')} />
          <NavButton icon={<Settings />} label="Settings" active={view === 'settings'} onClick={() => navigate('settings')} />
        </nav>
        <div className="privacy-card"><ShieldCheck size={17} /><div><strong>Local & private</strong><small>Recordings and notes stay on this device by default.</small></div></div>
      </aside>

      <section className="workspace">
        {view === 'home' && <HomeView lectures={lectures} courses={courses} storage={storage} onRecord={beginRecording} onImport={() => recordingImportRef.current?.click()} onOpen={openLecture} onNavigate={navigate} />}
        {view === 'lectures' && <LecturesView lectures={lectures} courses={courses} onOpen={openLecture} onRecord={beginRecording} onImport={() => recordingImportRef.current?.click()} />}
        {view === 'courses' && <CoursesView courses={courses} lectures={lectures} onAdd={() => setCourseModal(true)} onOpenLecture={openLecture} />}
        {view === 'search' && <SearchView courses={courses} lectures={lectures} onOpen={openLecture} />}
        {view === 'settings' && <SettingsView courses={courses} lectures={lectures} storage={storage} installAvailable={Boolean(installPrompt)} phoneModelInstalled={Boolean(settings.phoneModelInstalled)} onPhoneModelReady={() => void handleSettingsChange({ ...settings, phoneModelInstalled: true, preferredMode: 'phone' })} onInstall={installApp} onBackup={async () => exportBackupJson(await createBackup())} />}
      </section>

      <input ref={recordingImportRef} type="file" accept="audio/*,.m4a,.mp4,.webm,.wav,.mp3,.ogg,.flac,.aac" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importRecording(file); event.target.value = ''; }} />
      {recordingOpen && <RecordingFlow courses={courses} onClose={() => setRecordingOpen(false)} onSaved={handleLectureChange} onOpenLecture={openLecture} />}
      {consentOpen && <div className="modal-backdrop"><section className="modal-card consent-card" role="dialog" aria-modal="true" aria-labelledby="consent-title"><span className="soft-icon large"><LockKeyhole size={23} /></span><p className="eyebrow">Before your first recording</p><h2 id="consent-title">Record responsibly</h2><p>Make sure you have permission to record this lecture and follow your university&apos;s policies and applicable privacy rules.</p><label className="consent-check"><input type="checkbox" checked={consentChecked} onChange={(event) => setConsentChecked(event.target.checked)} /><span>I understand and have permission to record.</span></label><div className="button-row"><button className="primary-button" disabled={!consentChecked} onClick={acknowledgeConsent}>Acknowledge & continue</button><button className="secondary-button" onClick={() => setConsentOpen(false)}>Cancel</button></div></section></div>}
      {courseModal && <CourseModal onClose={() => setCourseModal(false)} onSave={async (course) => { await saveCourse(course); await refresh(); setCourseModal(false); notify('Course and glossary saved locally.'); }} />}
      {toast && <Toast {...toast} />}
    </main>
  );
}

function NavButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function HomeView({ lectures, courses, storage, onRecord, onImport, onOpen, onNavigate }: { lectures: Lecture[]; courses: Course[]; storage: { quota?: number; usage?: number }; onRecord: () => void; onImport: () => void; onOpen: (lecture: Lecture) => void; onNavigate: (view: ViewName) => void }) {
  const recent = lectures.slice(0, 3);
  const recoverable = lectures.filter((lecture) => lecture.status === 'interrupted');
  const processing = lectures.filter((lecture) => ['transcription-queued', 'preparing', 'transcribing', 'checking', 'generating-notes'].includes(lecture.status));
  const date = new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  const storagePercent = storage.quota ? Math.min(100, ((storage.usage || 0) / storage.quota) * 100) : 0;
  return <>
    <header className="topbar"><div><p className="eyebrow">{date}</p><h1>{lectures.length ? 'Your lecture workspace' : 'LectureAI'}</h1></div><button className="icon-button" onClick={() => onNavigate('settings')} aria-label="Settings"><Settings size={19} /></button></header>
    {recoverable.length > 0 && <button className="recovery-banner" onClick={() => onOpen(recoverable[0])}><AlertTriangle size={18} /><span><strong>{recoverable.length} recording{recoverable.length > 1 ? 's' : ''} can be recovered</strong><small>Saved checkpoints are waiting safely in your library.</small></span><ChevronRight size={18} /></button>}
    <section className="record-hero"><div><span className="status-pill"><i /> Ready · local checkpoints</span><h2>Capture every important idea.</h2><p>Reliable lecture recording with source-linked English and Egyptian Arabic transcription. No artificial minute limit.</p></div><div className="hero-action-stack"><button className="record-button" onClick={onRecord}><span className="record-dot" />{lectures.length ? 'Start a new recording' : 'Record your first lecture'}</button>{detectDeviceKind() === 'windows' && <button className="secondary-button" onClick={onImport}><Upload size={17} /> Import recording from phone/iPad</button>}</div></section>
    <section className="home-facts" aria-label="LectureAI guarantees"><div><ShieldCheck /><span><strong>Original audio preserved</strong><small>Never overwritten by processing</small></span></div><div><CloudOff /><span><strong>Offline-first library</strong><small>No cloud account required</small></span></div><div><Clock3 /><span><strong>No minute quotas</strong><small>Limited only by your device</small></span></div></section>
    <div className="section-heading"><div><p className="eyebrow">Continue studying</p><h2>Recent lectures</h2></div><button className="text-button" onClick={() => onNavigate('lectures')}>View all <ChevronRight size={15} /></button></div>
    <div className="recent-grid">{recent.map((lecture) => <LectureCard key={lecture.id} lecture={lecture} course={courses.find((course) => course.id === lecture.courseId)} onOpen={() => onOpen(lecture)} />)}{!recent.length && <EmptyInline onRecord={onRecord} />}</div>
    {!courses.length && <><div className="section-heading"><div><p className="eyebrow">Organize your library</p><h2>Courses</h2></div><button className="text-button" onClick={() => onNavigate('courses')}>Open courses <ChevronRight size={15} /></button></div><section className="empty-inline"><GraduationCap size={27} /><div><strong>No courses yet</strong><p>Create a course when you are ready to organize your lectures.</p></div><button className="secondary-button" onClick={() => onNavigate('courses')}>Add a course</button></section></>}
    <div className="dashboard-grid"><section className="dashboard-card"><div className="card-heading"><span className="soft-icon"><HardDrive size={18} /></span><div><p className="eyebrow">Device storage</p><h3>Local browser usage</h3></div></div><div className="storage-bar"><i style={{ width: `${storagePercent}%` }} /></div><p>{storage.quota ? `${formatBytes(storage.usage || 0)} used of ${formatBytes(storage.quota)}` : 'Storage estimate is not available in this browser.'}</p><small>This value comes from your browser&apos;s storage estimate.</small></section><section className="dashboard-card"><div className="card-heading"><span className="soft-icon"><Cpu size={18} /></span><div><p className="eyebrow">Processing queue</p><h3>{processing.length ? `${processing.length} active` : 'Nothing waiting'}</h3></div></div><p>{processing.length ? processing[0].statusMessage : 'New recordings will appear here while transcription and notes are prepared.'}</p><button className="text-button" onClick={() => onNavigate('lectures')}>Open queue <ChevronRight size={15} /></button></section></div>
  </>;
}

function needsTranscriptReview(segment: Lecture['segments'][number]) {
  const confidence = typeof segment.confidence === 'number' && Number.isFinite(segment.confidence) ? segment.confidence : undefined;
  return !segment.manuallyReviewed && ((confidence !== undefined && confidence < .85) || /\[(uncertain|inaudible)\]/i.test(segment.editedText || segment.originalText));
}

function LectureCard({ lecture, course, onOpen }: { lecture: Lecture; course?: Course; onOpen: () => void }) {
  const uncertain = lecture.segments.filter(needsTranscriptReview).length;
  return <button className="lecture-card compact-card" onClick={onOpen}><div className="lecture-title-row"><div className="course-icon" style={{ background: `${course?.color || '#315f4b'}18`, color: course?.color || '#315f4b' }}>{course?.icon || 'L'}</div><div><span className="course-label">{course?.code || 'LECTURE'} · {course?.name || 'Unassigned'}</span><h3>{lecture.title}</h3><p>{friendlyDate(lecture.date)} · {course?.professor || 'Professor not set'}</p></div><span className={`complete-pill ${lecture.status}`}>{lecture.status === 'done' ? 'Ready' : lecture.status}</span></div><div className="lecture-card-footer"><span><Clock3 size={14} /> {formatDuration(lecture.duration)}</span><span><FileAudio size={14} /> {lecture.size ? formatBytes(lecture.size) : 'No audio size'}</span><span><Star size={14} /> {lecture.bookmarks.length}</span>{uncertain > 0 && <span className="needs-review"><AlertTriangle size={14} /> {uncertain} to review</span>}<ChevronRight size={17} /></div></button>;
}

function LecturesView({ lectures, courses, onOpen, onRecord, onImport }: { lectures: Lecture[]; courses: Course[]; onOpen: (lecture: Lecture) => void; onRecord: () => void; onImport: () => void }) {
  const [filter, setFilter] = useState('all');
  const visible = lectures.filter((lecture) => filter === 'all' || lecture.courseId === filter || (filter === 'review' && lecture.segments.some(needsTranscriptReview)));
  return <><PageHeader eyebrow="Library" title="All lectures" action={<div className="button-row compact"><button className="primary-button" onClick={onRecord}><Mic size={17} /> Record lecture</button>{detectDeviceKind() === 'windows' && <button className="secondary-button" onClick={onImport}><Upload size={17} /> Import recording</button>}</div>} /><div className="filter-row"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button><button className={filter === 'review' ? 'active' : ''} onClick={() => setFilter('review')}>Needs review</button>{courses.map((course) => <button key={course.id} className={filter === course.id ? 'active' : ''} onClick={() => setFilter(course.id)}>{course.code}</button>)}</div><div className="lecture-list">{visible.map((lecture) => <LectureCard key={lecture.id} lecture={lecture} course={courses.find((course) => course.id === lecture.courseId)} onOpen={() => onOpen(lecture)} />)}{!visible.length && <EmptyInline onRecord={onRecord} />}</div></>;
}

function CoursesView({ courses, lectures, onAdd, onOpenLecture }: { courses: Course[]; lectures: Lecture[]; onAdd: () => void; onOpenLecture: (lecture: Lecture) => void }) {
  return <><PageHeader eyebrow="Organization" title="Courses & glossaries" action={<button className="primary-button" onClick={onAdd}><Plus size={17} /> Add course</button>} />{courses.length ? <div className="course-grid">{courses.map((course) => { const courseLectures = lectures.filter((lecture) => lecture.courseId === course.id); return <article className="course-card" key={course.id}><div className="course-card-head"><div className="course-icon large" style={{ background: `${course.color}18`, color: course.color }}>{course.icon}</div><span>{course.semester}</span></div><p className="course-label">{course.code}</p><h2>{course.name}</h2><p>{course.professor}</p><div className="glossary-preview">{course.glossary.slice(0, 5).map((term) => <span key={term}>{term}</span>)}{course.glossary.length > 5 && <span>+{course.glossary.length - 5}</span>}</div><div className="course-card-footer"><span>{courseLectures.length} lecture{courseLectures.length === 1 ? '' : 's'}</span>{courseLectures[0] && <button onClick={() => onOpenLecture(courseLectures[0])}>Latest <ChevronRight size={14} /></button>}</div></article>; })}</div> : <section className="empty-page"><GraduationCap size={35} /><h2>No courses yet</h2><p>Create a course only when you want to organize your own lectures and glossary terms.</p><button className="primary-button" onClick={onAdd}><Plus size={17} /> Add your first course</button></section>}</>;
}

function SearchView({ courses, lectures, onOpen }: { courses: Course[]; lectures: Lecture[]; onOpen: (lecture: Lecture) => void }) {
  const [query, setQuery] = useState('');
  const normalized = query.trim().toLocaleLowerCase();
  const results = useMemo(() => normalized.length < 2 ? [] : lectures.flatMap((lecture) => {
    const course = courses.find((item) => item.id === lecture.courseId);
    const metadataMatch = [lecture.title, course?.name, course?.code, course?.professor, course?.glossary.join(' ')].join(' ').toLocaleLowerCase().includes(normalized);
    const segmentMatches = lecture.segments.filter((segment) => `${segment.originalText} ${segment.editedText}`.toLocaleLowerCase().includes(normalized)).slice(0, 5);
    const notesMatch = lecture.notesCurrent.replace(/<[^>]+>/g, ' ').toLocaleLowerCase().includes(normalized);
    if (!metadataMatch && !segmentMatches.length && !notesMatch) return [];
    return [{ lecture, course, metadataMatch, notesMatch, segments: segmentMatches }];
  }), [normalized, lectures, courses]);
  return <><PageHeader eyebrow="Find anything" title="Search your library" /><div className="search-box"><Search size={22} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search transcripts, notes, courses, definitions…" /></div>{normalized.length < 2 ? <section className="search-empty"><Search size={31} /><h2>Search everything stored locally</h2><p>Try “recursion”, “derivative”, a professor name, or an Arabic term.</p></section> : <div className="search-results"><p className="result-count">{results.length} lecture{results.length === 1 ? '' : 's'} found</p>{results.map(({ lecture, course, metadataMatch, notesMatch, segments }) => <article key={lecture.id} className="search-result"><button className="search-result-head" onClick={() => onOpen(lecture)}><span className="course-icon">{course?.icon || 'L'}</span><span><small>{course?.code} · {course?.name}</small><strong>{lecture.title}</strong></span><ChevronRight size={18} /></button>{segments.map((segment) => <button key={segment.id} className="search-hit" onClick={() => onOpen(lecture)}><time>{formatTime(segment.startTime)}</time><span dir="auto">{segment.editedText || segment.originalText}</span></button>)}{metadataMatch && !segments.length && <button className="search-hit" onClick={() => onOpen(lecture)}><BookOpen size={16} /><span>Course or lecture information matches “{query}”.</span></button>}{notesMatch && <button className="search-hit" onClick={() => onOpen(lecture)}><Sparkles size={16} /><span>Edited lecture notes contain “{query}”.</span></button>}</article>)}</div>}</>;
}

function SettingsView({ courses, lectures, storage, installAvailable, phoneModelInstalled, onPhoneModelReady, onInstall, onBackup }: { courses: Course[]; lectures: Lecture[]; storage: { quota?: number; usage?: number }; installAvailable: boolean; phoneModelInstalled: boolean; onPhoneModelReady: () => void; onInstall: () => void; onBackup: () => void }) {
  const totalSize = lectures.reduce((sum, lecture) => sum + lecture.size, 0);
  return <><PageHeader eyebrow="Local-first controls" title="Settings & privacy" /><div className="settings-grid"><section className="settings-card"><span className="soft-icon"><ShieldCheck size={20} /></span><h2>Privacy</h2><p>LectureAI stores recordings, transcripts, notes, and course metadata in this browser by default. It does not send transcript content to analytics or paid AI services.</p><div className="settings-status"><Check size={15} /> No cloud account required</div></section><section className="settings-card"><span className="soft-icon"><HardDrive size={20} /></span><h2>Storage</h2><p>{lectures.length} lectures · {courses.length} courses · {formatBytes(totalSize)} known audio. LectureAI has no artificial recording-duration, transcript-length, segment-count, or monthly-minute quota.</p><div className="storage-bar"><i style={{ width: `${storage.quota ? ((storage.usage || 0) / storage.quota) * 100 : 0}%` }} /></div><small>{storage.quota ? `${formatBytes(storage.usage || 0)} browser usage of ${formatBytes(storage.quota)}` : 'Storage estimate is not exposed by this browser.'}</small></section><section className="settings-card"><span className="soft-icon"><Archive size={20} /></span><h2>Manual backup</h2><p>Export course metadata, glossaries, bookmarks, transcripts, and notes. Original audio is exported separately from each lecture.</p><button className="secondary-button" onClick={onBackup}><DownloadIcon /> Export local backup</button></section><section className="settings-card"><span className="soft-icon"><Upload size={20} /></span><h2>Install LectureAI</h2><p>Install the PWA for a focused, full-screen experience. On iPhone/iPad, keep the app visible during long recordings because iOS/iPadOS can suspend web apps in the background.</p><button className="secondary-button" onClick={onInstall}>{installAvailable ? 'Install app' : 'Install instructions'}</button></section><section className="settings-card wide-card"><span className="soft-icon"><Cpu size={20} /></span><h2>Computer transcription</h2><p>The included Windows helper detects CPU, NVIDIA GPU/VRAM, RAM, disk space, and recommends a Whisper model automatically. It listens only on 127.0.0.1 and never uploads audio.</p><code>start-lectureai.bat</code><div className="model-choices"><div><strong>Fast</strong><span>small · lower memory</span></div><div><strong>Balanced</strong><span>medium · stronger mixed speech</span></div><div className="recommended"><strong>Large</strong><span>large-v3 · higher local model capacity</span></div></div></section><PhoneModelManager installed={phoneModelInstalled} onInstalled={onPhoneModelReady} /><Diagnostics /></div></>;
}

function DownloadIcon() { return <Archive size={17} />; }

function CourseModal({ onClose, onSave }: { onClose: () => void; onSave: (course: Course) => void }) {
  const [name, setName] = useState(''); const [code, setCode] = useState(''); const [professor, setProfessor] = useState(''); const [semester, setSemester] = useState(''); const [glossary, setGlossary] = useState('');
  function submit(event: React.FormEvent) { event.preventDefault(); if (!name.trim()) return; onSave({ id: crypto.randomUUID(), name: name.trim(), code: code.trim() || 'COURSE', professor: professor.trim(), semester: semester.trim(), description: '', glossary: glossary.split(/[,\n]/).map((term) => term.trim()).filter(Boolean), color: '#315f4b', icon: name.trim().slice(0, 1).toUpperCase(), createdAt: new Date().toISOString() }); }
  return <div className="modal-backdrop"><form className="modal-card course-form" onSubmit={submit}><p className="eyebrow">Course context</p><h2>Add a course</h2><p className="modal-intro">Glossary terms guide recognition but never override what the audio supports.</p><div className="field-grid"><label className="field-label">Course name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Computer Science II" required /></label><label className="field-label">Course code<input value={code} onChange={(event) => setCode(event.target.value)} placeholder="CS 204" /></label></div><label className="field-label">Professor<input value={professor} onChange={(event) => setProfessor(event.target.value)} /></label><label className="field-label">Semester<input value={semester} onChange={(event) => setSemester(event.target.value)} /></label><label className="field-label">Glossary terms<textarea value={glossary} onChange={(event) => setGlossary(event.target.value)} placeholder="recursion, pointer, linked list, constructor…" /><small>Separate terms with commas or new lines. English technical terms can stay in English.</small></label><div className="button-row"><button className="primary-button" type="submit">Save course</button><button className="secondary-button" type="button" onClick={onClose}>Cancel</button></div></form></div>;
}

function PageHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: React.ReactNode }) { return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>{action}</header>; }
function EmptyInline({ onRecord }: { onRecord: () => void }) { return <section className="empty-inline"><Mic size={27} /><div><strong>No lectures yet</strong><p>Record your first lecture to see it here.</p></div><button className="secondary-button" onClick={onRecord}>Record Lecture</button></section>; }
function Toast({ message, tone }: { message: string; tone: 'success' | 'warning' }) { return <div className={`toast ${tone}`} role="status">{tone === 'success' ? <Check size={18} /> : <AlertTriangle size={18} />}<span>{message}</span></div>; }
