'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteAudioChunks, finalizeAudio, saveAudioChunk } from '../lib/db';
import { assertLiveMicrophoneStream, validatePlayableAudio, verifyMicrophoneCapture } from '../lib/audio-validation';
import { applyLectureAudioPreferences, lectureAudioConstraints, preferredRecordingMimeType } from '../lib/device';
import { setRecordingSessionActive } from '../lib/recording-session';

type WakeLockSentinelLike = { release: () => Promise<void> };

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

export function useRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isInterrupted, setIsInterrupted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const [chunkCount, setChunkCount] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const activeStartedRef = useRef(0);
  const elapsedRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const healthIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const pendingWritesRef = useRef<Set<Promise<unknown>>>(new Set());
  const checkpointFailureRef = useRef('');
  const chunkIndexRef = useRef(0);
  const lectureIdRef = useRef('');
  const mimeTypeRef = useRef('');
  const quietSinceRef = useRef<number | null>(null);
  const lastChunkAtRef = useRef(0);
  const interruptedRef = useRef(false);
  const finishingRef = useRef(false);
  const startingRef = useRef(false);
  const recorderStoppedRef = useRef<Promise<void> | null>(null);

  const startDurationTimer = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      setDuration(elapsedRef.current + (Date.now() - activeStartedRef.current) / 1000);
    }, 500);
  }, []);

  const requestWakeLock = useCallback(async () => {
    try {
      const lock = await (navigator as unknown as { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } }).wakeLock?.request('screen');
      wakeLockRef.current = lock || null;
    } catch { /* Wake Lock is best effort. */ }
  }, []);

  const stopMeters = useCallback(() => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (healthIntervalRef.current) clearInterval(healthIntervalRef.current);
    frameRef.current = null;
    intervalRef.current = null;
    healthIntervalRef.current = null;
    audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
    quietSinceRef.current = null;
    lastChunkAtRef.current = 0;
    setLevel(0);
  }, []);

  const startMeters = useCallback((stream: MediaStream) => {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    audioContextRef.current = context;
    void context.resume().catch(() => undefined);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const update = () => {
      if (context.state !== 'running') {
        setLevel(0);
        quietSinceRef.current = null;
        frameRef.current = requestAnimationFrame(update);
        return;
      }
      analyser.getByteTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / samples.length);
      const normalized = Math.min(1, rms * 5);
      setLevel(normalized);
      if (recorderRef.current?.state === 'recording') {
        if (rms < 0.0015) {
          quietSinceRef.current ??= Date.now();
          if (Date.now() - quietSinceRef.current > 10_000) {
            // Quiet/far-away speech is never a stop condition. It only warns the user.
            setError('Audio is very quiet. Recording is still running — keep the microphone unobstructed and LectureAI visible.');
          }
        } else {
          quietSinceRef.current = null;
          setError((current) => current.startsWith('Audio is very quiet') ? '' : current);
        }
      }
      frameRef.current = requestAnimationFrame(update);
    };
    update();
  }, []);

  const start = useCallback(async (lectureId: string) => {
    if (startingRef.current || recorderRef.current) {
      throw new Error('A recording session is already starting or active.');
    }
    startingRef.current = true;
    setError('');
    setIsInterrupted(false);
    interruptedRef.current = false;
    finishingRef.current = false;
    recorderStoppedRef.current = null;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      startingRef.current = false;
      throw new Error('This browser does not support reliable microphone recording.');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: lectureAudioConstraints(),
      video: false,
    });

    try {
      const track = assertLiveMicrophoneStream(stream);
      await applyLectureAudioPreferences(track);

      // Prove that this exact newly granted stream can produce real encoded,
      // non-silent microphone audio before the lecture MediaRecorder begins.
      // This is intentionally independent of Safari's transient track.muted flag.
      await verifyMicrophoneCapture(stream, 1800);

      streamRef.current = stream;
      lectureIdRef.current = lectureId;
      chunkIndexRef.current = 0;
      pendingWritesRef.current = new Set();
      checkpointFailureRef.current = '';
      lastChunkAtRef.current = Date.now();

      const requestedMimeType = preferredRecordingMimeType();
      let recorder: MediaRecorder;
      try {
        recorder = requestedMimeType
          ? new MediaRecorder(stream, { mimeType: requestedMimeType, audioBitsPerSecond: 192_000 })
          : new MediaRecorder(stream, { audioBitsPerSecond: 192_000 });
      } catch {
        recorder = new MediaRecorder(stream);
      }

      recorderRef.current = recorder;
      mimeTypeRef.current = recorder.mimeType || requestedMimeType;

      const enterInterruptedState = (message: string) => {
        if (finishingRef.current || interruptedRef.current) return;
        interruptedRef.current = true;
        setIsInterrupted(true);
        if (recorder.state === 'recording') {
          elapsedRef.current += Math.max(0, (Date.now() - activeStartedRef.current) / 1000);
          try { recorder.requestData(); } catch { /* The recorder may already be shutting down. */ }
        }
        setDuration(elapsedRef.current);
        if (intervalRef.current) clearInterval(intervalRef.current);
        if (healthIntervalRef.current) clearInterval(healthIntervalRef.current);
        intervalRef.current = null;
        healthIntervalRef.current = null;
        wakeLockRef.current?.release().catch(() => undefined);
        wakeLockRef.current = null;
        quietSinceRef.current = null;
        setLevel(0);
        setIsRecording(false);
        setIsPaused(true);
        setError(message);
      };

      track.addEventListener('ended', () => {
        enterInterruptedState('The microphone audio track ended unexpectedly. Your saved checkpoints are preserved — finish and save this lecture now.');
      });

      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        const now = Date.now();
        const gap = lastChunkAtRef.current ? now - lastChunkAtRef.current : 0;
        lastChunkAtRef.current = now;
        setError((current) => current.startsWith('Recording checkpoint is delayed') ? '' : current);
        if (gap > 12_000 && recorder.state === 'recording') {
          setError('iOS/iPadOS delayed a recording checkpoint. Recording is still active; keep LectureAI visible and the screen awake.');
        }

        const index = chunkIndexRef.current++;
        setChunkCount(index + 1);
        const write = Promise.resolve(saveAudioChunk({
          id: `${lectureId}-${String(index).padStart(8, '0')}`,
          lectureId,
          index,
          blob: event.data,
          mimeType: recorder.mimeType || mimeTypeRef.current,
          createdAt: new Date().toISOString(),
        }));
        pendingWritesRef.current.add(write);
        void write.catch(() => {
          checkpointFailureRef.current = 'A recording checkpoint could not be saved. Check available device storage.';
          setError(checkpointFailureRef.current);
        }).finally(() => {
          pendingWritesRef.current.delete(write);
        });
      };

      let resolveStopped!: () => void;
      recorderStoppedRef.current = new Promise<void>((resolve) => { resolveStopped = resolve; });
      recorder.addEventListener('stop', () => {
        resolveStopped();
        if (!finishingRef.current) {
          enterInterruptedState('The recorder stopped unexpectedly. Your saved checkpoints are preserved — finish and save this lecture now.');
        }
      }, { once: true });
      recorder.onerror = () => enterInterruptedState('The recorder reported an error. Your saved checkpoints are preserved — finish and save this lecture now.');

      elapsedRef.current = 0;
      activeStartedRef.current = Date.now();
      setDuration(0);
      setChunkCount(0);
      recorder.start(5_000);
      startingRef.current = false;
      setRecordingSessionActive(true);
      setIsRecording(true);
      setIsPaused(false);
      startDurationTimer();
      startMeters(stream);

      // While LectureAI stays visible, independently verify that iOS has not silently
      // killed the mic/recorder and that 5-second checkpoint delivery is still moving.
      // Distance, silence, and low audio level are deliberately NOT failure signals.
      if (healthIntervalRef.current) clearInterval(healthIntervalRef.current);
      healthIntervalRef.current = setInterval(() => {
        if (finishingRef.current || interruptedRef.current) return;
        const currentRecorder = recorderRef.current;
        const currentTrack = streamRef.current?.getAudioTracks()[0];

        if (!currentRecorder || currentRecorder.state === 'inactive') {
          enterInterruptedState('The recorder became inactive unexpectedly. Your saved checkpoints are preserved — finish and save this lecture now.');
          return;
        }
        if (!currentTrack || currentTrack.readyState !== 'live' || !currentTrack.enabled) {
          enterInterruptedState('The microphone session is no longer live. Your saved checkpoints are preserved — finish and save this lecture now.');
          return;
        }
        if (currentRecorder.state === 'recording') {
          if (document.visibilityState === 'visible' && !wakeLockRef.current) void requestWakeLock();
          void audioContextRef.current?.resume().catch(() => undefined);

          const checkpointAge = Date.now() - lastChunkAtRef.current;
          if (checkpointAge > 12_000) {
            try { currentRecorder.requestData(); } catch { /* Existing event/error recovery remains authoritative. */ }
            if (!checkpointFailureRef.current) {
              setError('Recording checkpoint is delayed — LectureAI requested an immediate recovery checkpoint. Recording remains active.');
            }
          }
        }
      }, 4_000);

      await requestWakeLock();
      return recorder.mimeType;
    } catch (startError) {
      startingRef.current = false;
      recorderRef.current = null;
      recorderStoppedRef.current = null;
      setRecordingSessionActive(false);
      if (healthIntervalRef.current) clearInterval(healthIntervalRef.current);
      healthIntervalRef.current = null;
      stream.getTracks().forEach((track) => track.stop());
      throw startError;
    }
  }, [requestWakeLock, startDurationTimer, startMeters]);

  const pause = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) throw new Error('No recording is active.');
    if (interruptedRef.current || recorder.state === 'inactive') {
      setIsRecording(false);
      setIsPaused(true);
      setIsInterrupted(true);
      return { duration: elapsedRef.current };
    }
    if (recorder.state !== 'recording') throw new Error('No recording is active.');
    const paused = new Promise<void>((resolve) => recorder.addEventListener('pause', () => resolve(), { once: true }));
    recorder.requestData();
    recorder.pause();
    await paused;
    await Promise.allSettled(Array.from(pendingWritesRef.current));
    elapsedRef.current += (Date.now() - activeStartedRef.current) / 1000;
    setDuration(elapsedRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
    quietSinceRef.current = null;
    setLevel(0);
    setIsRecording(false);
    setIsPaused(true);
    if (checkpointFailureRef.current) setError(checkpointFailureRef.current);
    return { duration: elapsedRef.current };
  }, []);

  const resume = useCallback(async () => {
    if (interruptedRef.current) {
      throw new Error('The iPhone/iPad microphone session ended. Finish and save the preserved recording, then start a new recording if you need to continue.');
    }
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'paused') throw new Error('The current recording is not stopped.');
    const stream = streamRef.current;
    if (!stream) throw new Error('The microphone stream is no longer available. Start a new recording.');
    // Keep the granted microphone track live across MediaRecorder.pause()/resume().
    // Toggling track.enabled can disturb iOS/iPadOS audio routing, and requiring
    // immediate speech would falsely reject a quiet classroom. The encoded start
    // probe is authoritative; the live meter continues to warn on prolonged silence.
    assertLiveMicrophoneStream(stream);
    await audioContextRef.current?.resume().catch(() => undefined);
    const resumed = new Promise<void>((resolve) => recorder.addEventListener('resume', () => resolve(), { once: true }));
    recorder.resume();
    await resumed;
    activeStartedRef.current = Date.now();
    lastChunkAtRef.current = Date.now();
    setIsPaused(false);
    setIsRecording(true);
    if (!checkpointFailureRef.current) setError('');
    startDurationTimer();
    await requestWakeLock();
  }, [requestWakeLock, startDurationTimer]);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) throw new Error('No recording is available to save.');
    if (finishingRef.current) throw new Error('LectureAI is already finishing this recording.');
    const recoveredFromInterruption = interruptedRef.current;
    const wasRecording = recorder.state === 'recording' && !recoveredFromInterruption;
    if (wasRecording) elapsedRef.current += (Date.now() - activeStartedRef.current) / 1000;

    finishingRef.current = true;
    if (recorder.state !== 'inactive') {
      if (recorder.state === 'recording') {
        try { recorder.requestData(); } catch { /* Stop still proceeds. */ }
      }
      recorder.stop();
    }

    // A successful save requires the real MediaRecorder stop event, because the final
    // dataavailable event is delivered before stop. A timeout is recoverable, never
    // permission to assemble a potentially incomplete lecture and call it successful.
    const stopConfirmed = recorderStoppedRef.current
      ? await Promise.race([
        recorderStoppedRef.current.then(() => true),
        wait(5_000).then(() => false),
      ])
      : false;
    if (!stopConfirmed) {
      recorderRef.current = null;
      recorderStoppedRef.current = null;
      finishingRef.current = false;
      setRecordingSessionActive(false);
      setIsRecording(false);
      setIsPaused(false);
      stopMeters();
      throw new Error('The browser did not confirm the recorder’s final stop event. LectureAI kept all completed checkpoints for recovery instead of marking a possibly incomplete recording as saved.');
    }

    await Promise.allSettled(Array.from(pendingWritesRef.current));

    if (checkpointFailureRef.current) {
      const message = checkpointFailureRef.current;
      recorderRef.current = null;
      recorderStoppedRef.current = null;
      finishingRef.current = false;
      setRecordingSessionActive(false);
      setIsRecording(false);
      setIsPaused(false);
      stopMeters();
      throw new Error(`${message} LectureAI did not mark this lecture as safely saved; any successful checkpoints were kept for recovery.`);
    }

    const blob = await finalizeAudio(lectureIdRef.current, mimeTypeRef.current || recorder.mimeType);
    try {
      const verified = await validatePlayableAudio(blob);
      if (verified.duration) elapsedRef.current = verified.duration;
      await deleteAudioChunks(lectureIdRef.current);
    } catch (validationError) {
      recorderRef.current = null;
      recorderStoppedRef.current = null;
      finishingRef.current = false;
      setRecordingSessionActive(false);
      setIsRecording(false);
      setIsPaused(false);
      stopMeters();
      throw new Error(`${validationError instanceof Error ? validationError.message : 'Saved audio validation failed.'} Recording checkpoints were kept for recovery.`);
    }

    recorderRef.current = null;
    recorderStoppedRef.current = null;
    interruptedRef.current = false;
    finishingRef.current = false;
    setRecordingSessionActive(false);
    setIsInterrupted(false);
    setIsRecording(false);
    setIsPaused(false);
    setDuration(elapsedRef.current);
    stopMeters();
    return { blob, duration: elapsedRef.current, mimeType: blob.type, chunkCount: chunkIndexRef.current, recoveredFromInterruption };
  }, [stopMeters]);

  useEffect(() => {
    const handleVisibility = () => {
      const recorder = recorderRef.current;
      if (document.visibilityState === 'hidden' && recorder?.state === 'recording') {
        // Best-effort flush before iOS gets a chance to suspend the page.
        try { recorder.requestData(); } catch { /* Existing 5-second checkpoints remain. */ }
        return;
      }
      if (document.visibilityState === 'visible') {
        void audioContextRef.current?.resume().catch(() => undefined);
        if (recorder?.state === 'recording' && !interruptedRef.current && !wakeLockRef.current) void requestWakeLock();
      }
    };
    const flushBeforePageHide = () => {
      const recorder = recorderRef.current;
      if (recorder?.state === 'recording') {
        try { recorder.requestData(); } catch { /* Existing checkpoints remain recoverable. */ }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', flushBeforePageHide);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', flushBeforePageHide);
    };
  }, [requestWakeLock]);

  useEffect(() => () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      finishingRef.current = true;
      if (recorderRef.current.state === 'recording') {
        try { recorderRef.current.requestData(); } catch { /* Best effort during teardown. */ }
      }
      recorderRef.current.stop();
    }
    startingRef.current = false;
    setRecordingSessionActive(false);
    stopMeters();
  }, [stopMeters]);

  return { isRecording, isPaused, isInterrupted, duration, level, error, chunkCount, start, pause, resume, stop };
}