'use client';

import { Check, Clipboard, RefreshCw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { microphonePermissionState } from '../lib/audio-validation';
import { detectDeviceKind, deviceLabel, preferredRecordingMimeType } from '../lib/device';
import { phoneTranscriptionSupported, windowsHelperHealth } from '../lib/transcription';

type DiagnosticState = {
  device: string;
  kind: string;
  secureContext: boolean;
  standalone: boolean;
  microphonePermission: string;
  mediaRecorder: boolean;
  mimeType: string;
  indexedDb: boolean;
  phoneTranscription: boolean;
  helper: string;
  helperModel?: string;
  helperVersion?: string;
};

export function Diagnostics() {
  const [state, setState] = useState<DiagnosticState | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    const helper = await windowsHelperHealth();
    const payload = helper.available ? helper.payload : undefined;
    setState({
      device: deviceLabel(),
      kind: detectDeviceKind(),
      secureContext: window.isSecureContext,
      standalone: window.matchMedia?.('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
      microphonePermission: await microphonePermissionState(),
      mediaRecorder: typeof MediaRecorder !== 'undefined',
      mimeType: preferredRecordingMimeType() || 'browser default / unavailable',
      indexedDb: typeof indexedDB !== 'undefined',
      phoneTranscription: phoneTranscriptionSupported(),
      helper: helper.available ? 'ready' : 'not connected',
      helperModel: payload?.configured_model ? String(payload.configured_model) : undefined,
      helperVersion: payload?.version ? String(payload.version) : undefined,
    });
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function copy() {
    if (!state) return;
    const safe = { ...state, userAgent: navigator.userAgent };
    await navigator.clipboard.writeText(JSON.stringify(safe, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return <section className="settings-card wide-card">
    <span className="soft-icon">{state?.helper === 'ready' ? <Check size={20} /> : <TriangleAlert size={20} />}</span>
    <h2>Diagnostics</h2>
    <p>Device and recording/transcription checks only. No lecture audio or transcript text is included.</p>
    {state ? <dl className="diagnostic-grid">
      <div><dt>Device</dt><dd>{state.device}</dd></div>
      <div><dt>Microphone permission</dt><dd>{state.microphonePermission}</dd></div>
      <div><dt>Recording API</dt><dd>{state.mediaRecorder ? 'available' : 'unavailable'}</dd></div>
      <div><dt>Selected audio format</dt><dd>{state.mimeType}</dd></div>
      <div><dt>Local storage</dt><dd>{state.indexedDb ? 'IndexedDB ready' : 'unavailable'}</dd></div>
      <div><dt>On-device transcription</dt><dd>{state.phoneTranscription ? 'supported' : 'unsupported'}</dd></div>
      <div><dt>Windows helper</dt><dd>{state.helper}{state.helperModel ? ` · ${state.helperModel}` : ''}{state.helperVersion ? ` · v${state.helperVersion}` : ''}</dd></div>
      <div><dt>App mode</dt><dd>{state.standalone ? 'installed PWA' : 'browser tab'} · {state.secureContext ? 'secure context' : 'not secure'}</dd></div>
    </dl> : <p>Checking this device…</p>}
    <div className="button-row compact"><button className="secondary-button" onClick={() => void refresh()}><RefreshCw size={15} /> Check again</button><button className="secondary-button" onClick={() => void copy()} disabled={!state}><Clipboard size={15} /> {copied ? 'Copied' : 'Copy diagnostics'}</button></div>
  </section>;
}
