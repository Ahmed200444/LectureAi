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
  return <div className="pwa-update-banner" role="status">
    <span>LectureAI update ready. Reload to use the newest recorder and transcription fixes.</span>
    <button onClick={() => window.location.reload()}><RefreshCw size={15} /> Reload</button>
  </div>;
}
