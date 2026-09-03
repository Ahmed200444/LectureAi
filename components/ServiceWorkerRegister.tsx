'use client';

import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { isRecordingSessionActive, onRecordingSessionChange } from '../lib/recording-session';

export function ServiceWorkerRegister() {
  const [updateReady, setUpdateReady] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const [applying, setApplying] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const waitingWorkerRef = useRef<ServiceWorker | null>(null);

  useEffect(() => {
    navigator.storage?.persist?.().catch(() => false);
    setRecordingActive(isRecordingSessionActive());
    const removeRecordingListener = onRecordingSessionChange(setRecordingActive);
    if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return removeRecordingListener;

    let timer: number | null = null;
    let cleanupFocus: (() => void) | null = null;

    const watchInstallingWorker = (registration: ServiceWorkerRegistration) => {
      const worker = registration.installing;
      if (!worker) return;
      const onStateChange = () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          waitingWorkerRef.current = registration.waiting || worker;
          setUpdateReady(true);
        }
      };
      worker.addEventListener('statechange', onStateChange);
    };

    void navigator.serviceWorker.register('/sw.js').then((registration) => {
      registrationRef.current = registration;
      if (registration.waiting && navigator.serviceWorker.controller) {
        waitingWorkerRef.current = registration.waiting;
        setUpdateReady(true);
      }
      watchInstallingWorker(registration);
      registration.addEventListener('updatefound', () => watchInstallingWorker(registration));

      const check = () => void registration.update().catch(() => undefined);
      window.addEventListener('focus', check);
      cleanupFocus = () => window.removeEventListener('focus', check);
      timer = window.setInterval(check, 5 * 60_000);
    }).catch(() => undefined);

    return () => {
      removeRecordingListener();
      if (timer) window.clearInterval(timer);
      cleanupFocus?.();
    };
  }, []);

  function applyUpdate() {
    if (recordingActive || applying) return;
    const worker = waitingWorkerRef.current || registrationRef.current?.waiting;
    if (!worker) {
      setUpdateReady(false);
      return;
    }

    setApplying(true);
    let reloading = false;
    const reloadOnceActivated = () => {
      if (reloading || worker.state !== 'activated') return;
      reloading = true;
      window.location.reload();
    };
    worker.addEventListener('statechange', reloadOnceActivated);
    worker.postMessage({ type: 'SKIP_WAITING' });
    window.setTimeout(reloadOnceActivated, 4_000);
  }

  if (!updateReady) return null;
  return <div role="status" aria-live="polite" style={{ position: 'fixed', zIndex: 1200, left: 16, right: 16, bottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '12px 14px', border: '1px solid rgba(33,79,61,.18)', borderRadius: 14, background: '#fff', boxShadow: '0 10px 35px rgba(20,36,28,.16)', fontSize: 14 }}>
    <span>{recordingActive ? 'LectureAI update ready. It will wait until this recording is finished.' : 'LectureAI update ready. Apply it when you are not recording.'}</span>
    <button disabled={recordingActive || applying} onClick={applyUpdate} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 0, borderRadius: 10, padding: '9px 12px', background: '#214f3d', color: '#fff', fontWeight: 700, whiteSpace: 'nowrap', opacity: recordingActive || applying ? .55 : 1 }}><RefreshCw size={15} /> {recordingActive ? 'Wait for lecture' : applying ? 'Updating…' : 'Update now'}</button>
  </div>;
}
