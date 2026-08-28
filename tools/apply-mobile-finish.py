from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if new in text:
        return
    if old not in text:
        raise RuntimeError(f'Expected patch target not found in {path}: {old[:90]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


# App: no artificial import cap, preserve transferred iPhone/iPad media, and expose model preparation.
replace_once('src/App.tsx',
"import { Diagnostics } from '../components/Diagnostics';\n",
"import { Diagnostics } from '../components/Diagnostics';\nimport { PhoneModelManager } from '../components/PhoneModelManager';\n")
replace_once('src/App.tsx',
"""      if (!file.size) throw new Error('The selected recording is empty.');
      if (file.size > 8 * 1024 * 1024 * 1024) throw new Error('The recording exceeds the 8 GB local safety limit.');
      const verified = await validatePlayableAudio(file);
""",
"""      if (!file.size) throw new Error('The selected recording is empty.');
      const estimate = await navigator.storage?.estimate().catch(() => undefined);
      const free = estimate?.quota ? Math.max(0, estimate.quota - (estimate.usage || 0)) : undefined;
      if (typeof free === 'number' && free > 0 && file.size > free) {
        throw new Error(`This device currently reports only ${formatBytes(free)} of browser storage free, which is not enough to preserve this ${formatBytes(file.size)} recording.`);
      }
      const extension = file.name.split('.').pop()?.toLowerCase() || '';
      const inferredType = file.type || ({ m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', webm: 'audio/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac' } as Record<string, string>)[extension] || 'application/octet-stream';
      const importedFile = file.type ? file : new File([file], file.name, { type: inferredType, lastModified: file.lastModified });
      const verified = await validatePlayableAudio(importedFile);
""")
replace_once('src/App.tsx',
"""        id, courseId: '', title, date: now, duration: verified.duration || 0, size: file.size, mimeType: file.type,
        status: 'transcription-queued', statusMessage: 'Imported original audio · transcription queued', processingProgress: 0,
""",
"""        id, courseId: '', title, date: now, duration: verified.duration || 0, size: importedFile.size, mimeType: inferredType,
        status: 'transcription-queued', statusMessage: verified.browserDecoded ? 'Imported original audio · browser playback verified · transcription queued' : 'Imported original audio preserved · browser preview unavailable, Windows helper/FFmpeg will validate and transcribe it', processingProgress: 0,
""")
replace_once('src/App.tsx',
"      await saveImportedAudio(id, file);\n",
"      await navigator.storage?.persist?.().catch(() => false);\n      await saveImportedAudio(id, importedFile);\n")
replace_once('src/App.tsx',
"      notify(`Recording imported on ${deviceLabel()}. Maximum Accuracy will start automatically when the Windows helper is ready.`, 'success');\n",
"      notify(verified.browserDecoded ? `Recording imported and playback-verified on ${deviceLabel()}.` : 'Recording imported intact. The Windows helper will perform the authoritative media decode.', 'success');\n")
replace_once('src/App.tsx',
"        {view === 'settings' && <SettingsView courses={courses} lectures={lectures} storage={storage} installAvailable={Boolean(installPrompt)} onInstall={installApp} onBackup={async () => exportBackupJson(await createBackup())} />}\n",
"        {view === 'settings' && <SettingsView courses={courses} lectures={lectures} storage={storage} installAvailable={Boolean(installPrompt)} phoneModelInstalled={settings.phoneModelInstalled} onPhoneModelReady={() => void handleSettingsChange({ ...settings, phoneModelInstalled: true, preferredMode: 'phone' })} onInstall={installApp} onBackup={async () => exportBackupJson(await createBackup())} />}\n")
replace_once('src/App.tsx',
"function SettingsView({ courses, lectures, storage, installAvailable, onInstall, onBackup }: { courses: Course[]; lectures: Lecture[]; storage: { quota?: number; usage?: number }; installAvailable: boolean; onInstall: () => void; onBackup: () => void }) {\n",
"function SettingsView({ courses, lectures, storage, installAvailable, phoneModelInstalled, onPhoneModelReady, onInstall, onBackup }: { courses: Course[]; lectures: Lecture[]; storage: { quota?: number; usage?: number }; installAvailable: boolean; phoneModelInstalled: boolean; onPhoneModelReady: () => void; onInstall: () => void; onBackup: () => void }) {\n")
replace_once('src/App.tsx',
"{formatBytes(totalSize)} known audio.</p>",
"{formatBytes(totalSize)} known audio. LectureAI has no artificial recording-duration or monthly-minute quota.</p>")
replace_once('src/App.tsx',
"</div></section><Diagnostics /></div></>;\n",
"</div></section><PhoneModelManager installed={phoneModelInstalled} onInstalled={onPhoneModelReady} /><Diagnostics /></div></>;\n")

# Recorder preflight: WebAudio can be suspended in an installed iOS PWA, so null means unverifiable, not silent.
replace_once('lib/audio-validation.ts',
"export async function waitForAudibleInput(stream: MediaStream, timeoutMs = 4000, threshold = 0.0015) {\n",
"export async function waitForAudibleInput(stream: MediaStream, timeoutMs = 4000, threshold = 0.0015): Promise<boolean | null> {\n")
replace_once('lib/audio-validation.ts', "  if (!AudioContextClass) return false;\n", "  if (!AudioContextClass) return null;\n")
replace_once('lib/audio-validation.ts', "    if (context.state !== 'running') return false;\n", "    if (context.state !== 'running') return null;\n")
replace_once('hooks/use-recorder.ts',
"""      const audible = await waitForAudibleInput(stream, 5000);
      if (!audible) {
""",
"""      const audible = await waitForAudibleInput(stream, 5000);
      if (audible === false) {
""")
replace_once('hooks/use-recorder.ts',
"""    assertLiveMicrophoneStream(stream);
    await audioContextRef.current?.resume().catch(() => undefined);
""",
"""    assertLiveMicrophoneStream(stream);
    const audible = await waitForAudibleInput(stream, 4000);
    if (audible === false) throw new Error('The microphone is available, but no live sound was detected after continuing. Speak near the device and try again.');
    await audioContextRef.current?.resume().catch(() => undefined);
""")

# Mic test: the user must hear a real MediaRecorder sample before Start is enabled.
replace_once('components/MicTest.tsx',
"export function MicTest() {\n",
"export function MicTest({ onVerified, onReset }: { onVerified?: () => void; onReset?: () => void }) {\n")
replace_once('components/MicTest.tsx',
"      setConfirmed(false);\n      peakRef.current = 0;\n",
"      setConfirmed(false);\n      onReset?.();\n      peakRef.current = 0;\n")
replace_once('components/MicTest.tsx',
"{sampleUrl && !confirmed && <button className=\"primary-button\" type=\"button\" onClick={() => setConfirmed(true)}><Check size={15} /> I can hear the sample</button>}\n",
"{sampleUrl && !confirmed && <button className=\"primary-button\" type=\"button\" onClick={() => { setConfirmed(true); onVerified?.(); }}><Check size={15} /> I can hear the sample</button>}\n")

# Recording flow: no time quota, storage warnings, verified save, playback confirmation, and recovery-safe UI.
replace_once('components/RecordingFlow.tsx',
"""  const [visibilityWarning, setVisibilityWarning] = useState(false);
  const [setupError, setSetupError] = useState('');
""",
"""  const [visibilityWarning, setVisibilityWarning] = useState(false);
  const [storageWarning, setStorageWarning] = useState('');
  const [setupError, setSetupError] = useState('');
  const [micVerified, setMicVerified] = useState(false);
  const [savedAudioUrl, setSavedAudioUrl] = useState('');
""")
replace_once('components/RecordingFlow.tsx',
"  useEffect(() => { navigator.storage?.estimate().then(setStorage).catch(() => undefined); }, []);\n  useEffect(() => {\n",
"""  useEffect(() => { navigator.storage?.estimate().then(setStorage).catch(() => undefined); }, []);
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
          setStorageWarning(`Only ${formatBytes(free)} of estimated browser storage remains. LectureAI will not impose a time limit, but the device needs free space to keep saving checkpoints.`);
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
""")
replace_once('components/RecordingFlow.tsx',
"""    try {
      setSetupError('');
      // Verify a live microphone before creating a real lecture in the library.
      await recorder.start(newLecture.id);
""",
"""    try {
      setSetupError('');
      await navigator.storage?.persist?.().catch(() => false);
      // recorder.start performs an automated signal check when WebAudio is available;
      // MicTest has already required playback confirmation of a real recorded sample.
      await recorder.start(newLecture.id);
""")
replace_once('components/RecordingFlow.tsx',
"      const updated: Lecture = { ...lecture, duration: result.duration, size: result.blob.size, mimeType: result.mimeType, status: 'transcription-queued', statusMessage: 'Recording safely saved · transcription queued', processingProgress: 0, updatedAt: new Date().toISOString() };\n",
"      const updated: Lecture = { ...lecture, duration: result.duration, size: result.blob.size, mimeType: result.mimeType, status: 'transcription-queued', statusMessage: `Audio playback verified · ${recorder.chunkCount} checkpoint${recorder.chunkCount === 1 ? '' : 's'} saved · ready to transcribe`, processingProgress: 0, updatedAt: new Date().toISOString() };\n")
replace_once('components/RecordingFlow.tsx', "      else onOpenLecture(updated);\n", "      else setStage('saved');\n")
replace_once('components/RecordingFlow.tsx',
"""  function prepareNewRecording() {
    setLecture(null);
""",
"""  function prepareNewRecording() {
    setLecture(null);
    setMicVerified(false);
    setSavedAudioUrl('');
""")
replace_once('components/RecordingFlow.tsx',
"          {visibilityWarning && <div className=\"inline-warning\"><AlertTriangle size={17} /> iOS may suspend browser recording in the background. Return to LectureAI and keep the screen awake.</div>}\n",
"          {visibilityWarning && <div className=\"inline-warning\"><AlertTriangle size={17} /> iOS/iPadOS may suspend browser recording in the background. Return to LectureAI and keep the screen awake.</div>}\n          {storageWarning && <div className=\"inline-warning\"><AlertTriangle size={17} /> {storageWarning}</div>}\n")
replace_once('components/RecordingFlow.tsx',
"""        <span className="success-icon"><Check size={30} /></span><p className="eyebrow">Original audio preserved</p><h2 id="saved-title">Lecture saved successfully</h2><p>{lecture.statusMessage}</p>
        <dl className="save-details"><div><dt>Duration</dt><dd>{formatTime(lecture.duration, true)}</dd></div><div><dt>Size</dt><dd>{formatBytes(lecture.size)}</dd></div><div><dt>Marks</dt><dd>{lecture.bookmarks.length}</dd></div></dl>
        <div className="post-actions">
          <button className="primary-button" onClick={() => onOpenLecture(lecture)}><HardDrive size={18} /> Maximum accuracy</button>
          <button className="secondary-button" onClick={() => onOpenLecture(lecture)}><Mic size={18} /> Transcribe on phone</button>
          <button className="secondary-button" onClick={exportAudio}><Download size={18} /> Export original audio</button>
          <button className="secondary-button" onClick={prepareNewRecording}><FilePlus2 size={18} /> Start a new recording</button>
        </div>
""",
"""        <span className="success-icon"><Check size={30} /></span><p className="eyebrow">Original audio preserved</p><h2 id="saved-title">{lecture.status === 'interrupted' ? 'Recording needs recovery' : 'Recording verified & saved'}</h2><p>{lecture.statusMessage}</p>
        {lecture.status === 'interrupted' ? <div className="inline-warning"><AlertTriangle size={17} /> Saved checkpoints were kept. Open the lecture to recover them before transcription.</div> : <div className="inline-note"><ShieldCheck size={16} /> LectureAI reloaded the assembled audio successfully before marking this recording as saved.</div>}
        {savedAudioUrl && <audio className="sample-player" src={savedAudioUrl} controls aria-label="Verify saved lecture audio" />}
        <dl className="save-details"><div><dt>Duration</dt><dd>{formatTime(lecture.duration, true)}</dd></div><div><dt>Size</dt><dd>{formatBytes(lecture.size)}</dd></div><div><dt>Marks</dt><dd>{lecture.bookmarks.length}</dd></div></dl>
        <div className="post-actions">
          {lecture.status === 'interrupted' ? <button className="primary-button" onClick={() => onOpenLecture(lecture)}><HardDrive size={18} /> Open recovery</button> : <>
            <button className="primary-button" onClick={() => onOpenLecture(lecture)}><HardDrive size={18} /> Maximum accuracy</button>
            <button className="secondary-button" onClick={() => onOpenLecture(lecture)}><Mic size={18} /> Transcribe on phone</button>
            <button className="secondary-button" onClick={exportAudio}><Download size={18} /> Share / export original audio</button>
          </>}
          <button className="secondary-button" onClick={prepareNewRecording}><FilePlus2 size={18} /> Start a new recording</button>
        </div>
""")
replace_once('components/RecordingFlow.tsx', "      <MicTest />\n", "      <MicTest onVerified={() => setMicVerified(true)} onReset={() => setMicVerified(false)} />\n")
replace_once('components/RecordingFlow.tsx',
"      <div className=\"inline-note\"><Bookmark size={16} /> Keep the phone on the desk with its microphone unobstructed. Rows 1–3 are the primary accuracy target.</div>\n      <button className=\"primary-button wide\" onClick={begin}><span className=\"record-dot\" /> Start a new recording</button>\n",
"      <div className=\"inline-note\"><Bookmark size={16} /> Keep the iPhone/iPad microphone unobstructed and LectureAI visible. Recording has no LectureAI time quota; available storage, battery, and iOS/iPadOS background rules are the practical limits.</div>\n      {!micVerified && <small>Record the microphone sample and confirm you can hear it before starting. This prevents a silent lecture from being accepted by mistake.</small>}\n      <button className=\"primary-button wide\" onClick={begin} disabled={!micVerified}><span className=\"record-dot\" /> Start a new recording</button>\n")

# Static acceptance guards catch accidental removal of the mobile reliability guarantees.
replace_once('tests/run.ts',
"import assert from 'node:assert/strict';\n",
"import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\n")
mobile_tests = r'''

test('keeps mobile recording unlimited by policy while guarding against silent audio', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const flow = readFileSync(new URL('../components/RecordingFlow.tsx', import.meta.url), 'utf8');
  const recorder = readFileSync(new URL('../hooks/use-recorder.ts', import.meta.url), 'utf8');
  const exporter = readFileSync(new URL('../lib/export.ts', import.meta.url), 'utf8');
  const manifest = readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /8 GB local safety limit/);
  assert.match(app, /no artificial recording-duration or monthly-minute quota/);
  assert.match(recorder, /waitForAudibleInput/);
  assert.match(recorder, /recorder\.start\(5_000\)/);
  assert.match(flow, /disabled=\{!micVerified\}/);
  assert.match(flow, /Audio playback verified/);
  assert.match(flow, /Verify saved lecture audio/);
  assert.match(exporter, /nav\.share/);
  assert.match(manifest, /"display": "standalone"/);
});

test('keeps multilingual phone transcription fallbacks and predownload support', () => {
  const worker = readFileSync(new URL('../lib/phone-transcriber.worker.ts', import.meta.url), 'utf8');
  const phone = readFileSync(new URL('../lib/phone-transcription.ts', import.meta.url), 'utf8');
  assert.match(worker, /whisper-small/);
  assert.match(worker, /whisper-base/);
  assert.match(worker, /whisper-tiny/);
  assert.match(worker, /mode === 'prepare'/);
  assert.match(phone, /preparePhoneTranscriptionModel/);
});
'''
run = Path('tests/run.ts')
text = run.read_text(encoding='utf-8')
if "keeps mobile recording unlimited by policy" not in text:
    marker = "\nlet failed = 0;\n"
    if marker not in text:
        raise RuntimeError('Could not find test runner insertion point')
    run.write_text(text.replace(marker, mobile_tests + marker, 1), encoding='utf-8')

acceptance = Path('benchmarks/mobile-acceptance.md')
if not acceptance.exists():
    acceptance.write_text('''# Mobile acceptance matrix

Do not claim a microphone or accuracy pass until the physical device test is completed. Automated CI verifies code paths; real iPhone/iPad hardware verifies microphone routing, PWA behavior, and OS share destinations.

## Recording / PWA
- iPhone Safari: mic sample playback confirmed; long recording checkpoints; finish/reload/playback verified.
- iPhone installed PWA: same checks; keep app visible; verify update banner/reload.
- iPad Safari: same checks.
- iPad installed PWA: same checks.
- Pause/continue: confirm live audio returns and the same lecture is extended.
- Low storage: warning appears without an artificial LectureAI time limit.
- Backgrounding: warning appears; do not promise uninterrupted iOS background recording.

## Sharing / transfer
- Share original .m4a/.mp4/.webm via iOS/iPadOS share sheet to AirDrop, Files, Gmail, WhatsApp when those destinations accept the file.
- Share transcript .txt through the same system share sheet.
- Transfer iPhone/iPad recording to Windows, import it, preserve the original, and run Maximum Accuracy.
- Verify Windows helper/FFmpeg can handle a transferred file even when the browser preview decoder cannot.

## Transcription quality
Evaluate English, Egyptian Arabic (Masri), MSA, English technical terms inside Arabic, and code-switching. Include rows 1–3, rows 4–5, and realistic classroom noise. Measure WER/CER/manual review separately for phone/iPad and Windows. Never publish an accuracy percentage without measurements.

## Long sessions
LectureAI has no application-imposed recording duration or monthly-minute quota. Practical limits are free device/browser storage, battery, iOS/iPadOS suspension behavior, and available RAM for on-device model inference. Original audio remains the source of truth.
''', encoding='utf-8')
