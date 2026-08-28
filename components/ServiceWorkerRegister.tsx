'use client';

import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

export function ServiceWorkerRegister() {
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    navigator.storage?.persist?.().catch(() => false);
    if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;

    const hadController = Boolean(navigator.serviceWorker.controller);
    let registration: ServiceWorkerRegistration | null = null;
    let timer: number | null = null;

    const onControllerChange = () => {
      if (hadController) setUpdateReady(true);
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    void navigator.serviceWorker.register('/sw.js').then((next) => {
      registration = next;
      if (next.waiting && hadController) setUpdateReady(true);
      const check = () => void next.update().catch(() => undefined);
      window.addEventListener('focus', check);
      timer = window.setInterval(check, 5 * 60_000);
      const cleanupFocus = () => window.removeEventListener('focus', check);
      (registration as ServiceWorkerRegistration & { __lectureAICleanup?: () => void }).__lectureAICleanup = cleanupFocus;
    }).catch(() => undefined);

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      if (timer) window.clearInterval(timer);
      (registration as (ServiceWorkerRegistration & { __lectureAICleanup?: () => void }) | null)?.__lectureAICleanup?.();
    };
  }, []);

  if (!updateReady) return null;
  return <div role="status" style={{ position: 'fixed', zIndex: 1200, left: 16, right: 16, bottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '12px 14px', border: '1px solid rgba(33,79,61,.18)', borderRadius: 14, background: '#fff', boxShadow: '0 10px 35px rgba(20,36,28,.16)', fontSize: 14 }}>
    <span>LectureAI update ready. Reload to use the newest recorder and transcription fixes.</span>
    <button onClick={() => window.location.reload()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 0, borderRadius: 10, padding: '9px 12px', background: '#214f3d', color: '#fff', fontWeight: 700, whiteSpace: 'nowrap' }}><RefreshCw size={15} /> Reload</button>
  </div>;
}
