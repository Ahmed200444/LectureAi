'use client';

import { Check, Cpu, Download, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { preparePhoneTranscriptionModel } from '../lib/phone-transcription';
import { phoneTranscriptionSupported } from '../lib/transcription';
import { detectDeviceKind } from '../lib/device';

export function PhoneModelManager({ installed, onInstalled }: { installed?: boolean; onInstalled: () => void }) {
  const ready = Boolean(installed);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState(ready ? 'A multilingual Whisper model was prepared on this device.' : 'Prepare the phone/iPad model before class so transcription does not need to download it afterward.');
  const [model, setModel] = useState('');
  const supported = phoneTranscriptionSupported();
  const mobile = ['iphone', 'ipad', 'android-phone', 'android-tablet'].includes(detectDeviceKind());

  async function prepare() {
    setBusy(true);
    setProgress(1);
    try {
      await navigator.storage?.persist?.().catch(() => false);
      const result = await preparePhoneTranscriptionModel(({ progress: value, message: next }) => {
        setProgress(value);
        setMessage(next);
      });
      setModel(result.model);
      setMessage(`${result.model} is cached and ready. The original recording remains separate and unchanged.`);
      onInstalled();
    } catch (error) {
      setProgress(0);
      setMessage(error instanceof Error ? error.message : 'The on-device model could not be prepared.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="settings-card wide-card">
    <span className="soft-icon">{ready || progress === 100 ? <Check size={20} /> : supported ? <Cpu size={20} /> : <TriangleAlert size={20} />}</span>
    <h2>iPhone / iPad transcription model</h2>
    <p>{message}</p>
    {busy && <div className="processing-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><i style={{ width: `${progress}%` }} /></div>}
    {model && <div className="settings-status"><Check size={15} /> Active model: {model}</div>}
    <button className="secondary-button" onClick={() => void prepare()} disabled={busy || !supported}>
      <Download size={16} /> {busy ? 'Preparing model…' : ready ? 'Verify / refresh model cache' : 'Download model before class'}
    </button>
    {!supported && <small>This browser cannot run the local speech worker. Recording still works; use Windows Maximum Accuracy for transcription.</small>}
    {supported && mobile && <small>There is no LectureAI minute quota. Very long on-device transcription can still hit iOS/iPadOS memory limits; the saved audio remains available for Windows Maximum Accuracy.</small>}
  </section>;
}
