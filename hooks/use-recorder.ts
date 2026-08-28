'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteAudioChunks, finalizeAudio, saveAudioChunk } from '../lib/db';
import { assertLiveMicrophoneStream, validatePlayableAudio, waitForAudibleInput, waitForMicrophoneUnmuted } from '../lib/audio-validation';
import { isIOSDevice, mediaRecorderOptions, microphoneCaptureConstraints, preferredRecordingMimeType } from '../lib/device';

type WakeLockSentinelLike = { release: () => Promise<void> };

export function useRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [duration, setDuration] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const [chunkCount, setChunkCount] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const activeStartedRef = useRef(0);
  const elapsedRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const pendingWritesRef = useRef<Promise<unknown>[]>([]);
  const chunkIndexRef = useRef(0);
  const lectureIdRef = useRef('');
  const mimeTypeRef = useRef('');
  const quietSinceRef = useRef<number | null>(null);
  const muteWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (muteWarningTimerRef.current) clearTimeout(muteWarningTimerRef.current);
    frameRef.current = null;
    intervalRef.current = null;
    muteWarningTimerRef.current = null;
    audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
    quietSinceRef.current = null;
    setLevel(0);
  }, []);

  const startMeters = useCallback((stream: MediaStream) => {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    audioContextRef.current = context;
    void context.resume().catch(() => undefined);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const ios = isIOSDevice();
    const update = () => {
      analyser.getByteTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / samples.length);
      const normalized = Math.min(1, rms * (ios ? 12 : 5));
      setLevel(normalized);
      if (recorderRef.current?.state === 'recording') {
        const silenceThreshold = ios ? 0.00045 : 0.001;
        if (rms < silenceThreshold) {
          quietSinceRef.current ??= Date.now();
          if (Date.now() - quietSinceRef.current > 15_000) {
            setError('Audio meter is not detecting speech. Recording is still active; check the microphone opening, Bluetooth input, and phone position.');
          }
        } else {
          quietSinceRef.current = null;
          setError((current) => current.startsWith('Audio meter is not detecting speech') ? '' : current);
        }
      }
      frameRef.current = requestAnimationFrame(update);
    };
    update();
  }, []);

  const start = useCallback(async (lectureId: string) => {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('This browser does not support reliable microphone recording.');
    }
    const stream = await navigator.mediaDevices.getUserMedia(microphoneCaptureConstraints());
    try {
      const track = assertLiveMicrophoneStream(stream);
      if (track.muted && !await waitForMicrophoneUnmuted(track, 3000)) {
        throw new Error('The microphone stayed unavailable after permission was granted. Check the iPhone microphone indicator or audio input route, then retry.');
      }

      const warnIfStillMuted = () => {
        if (muteWarningTimerRef.current) clearTimeout(muteWarningTimerRef.current);
        muteWarningTimerRef.current = setTimeout(() => {
          if (track.muted && recorderRef.current?.state === 'recording') {
            setError('The microphone input is temporarily unavailable. Recording checkpoints remain preserved; return to LectureAI and check the iPhone microphone/audio route.');
          }
        }, 1500);
      };
      track.addEventListener('mute', warnIfStillMuted);
      track.addEventListener('unmute', () => {
        if (muteWarningTimerRef.current) clearTimeout(muteWarningTimerRef.current);
        muteWarningTimerRef.current = null;
        setError((current) => current.startsWith('The microphone input is temporarily unavailable') ? '' : current);
      });
      track.addEventListener('ended', () => setError('The microphone audio track ended unexpectedly. Finish the lecture to preserve saved checkpoints.'));

      // Safari's live Web Audio meter can occasionally report zero while the
      // native recorder is usable, so lack of meter activity is advisory on iOS.
      await waitForAudibleInput(stream, 4000, 0.0015, !isIOSDevice());

      streamRef.current = stream;
      lectureIdRef.current = lectureId;
      chunkIndexRef.current = 0;
      pendingWritesRef.current = [];
      const mimeType = preferredRecordingMimeType();
      const options = mediaRecorderOptions(mimeType);
      const recorder = options ? new MediaRecorder(stream, options) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      mimeTypeRef.current = recorder.mimeType || mimeType;
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        const index = chunkIndexRef.current++;
        setChunkCount(index + 1);
        const chunkMimeType = event.data.type || recorder.mimeType || mimeTypeRef.current;
        const write = saveAudioChunk({ id: `${lectureId}-${String(index).padStart(8, '0')}`, lectureId, index, blob: event.data, mimeType: chunkMimeType, createdAt: new Date().toISOString() });
        pendingWritesRef.current.push(write);
        write.catch(() => setError('A recording checkpoint could not be saved. Check available storage.'));
      };
      recorder.onerror = () => setError('The recorder reported an error. Saved checkpoints remain recoverable.');
      elapsedRef.current = 0;
      activeStartedRef.current = Date.now();
      setDuration(0);
      setChunkCount(0);
      recorder.start(5_000);
      setIsRecording(true);
      setIsPaused(false);
      startDurationTimer();
      startMeters(stream);
      await requestWakeLock();
      return recorder.mimeType;
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }, [requestWakeLock, startDurationTimer, startMeters]);

  const pause = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') throw new Error('No recording is active.');
    const paused = new Promise<void>((resolve) => recorder.addEventListener('pause', () => resolve(), { once: true }));
    recorder.requestData();
    recorder.pause();
    await paused;
    await Promise.allSettled(pendingWritesRef.current);
    elapsedRef.current += (Date.now() - activeStartedRef.current) / 1000;
    setDuration(elapsedRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    // Safari's MediaRecorder pause already stops encoded output. Keeping the
    // iOS track enabled avoids tearing down and rebuilding the microphone route.
    if (!isIOSDevice()) streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = false; });
    wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
    quietSinceRef.current = null;
    setLevel(0);
    setIsRecording(false);
    setIsPaused(true);
    return { duration: elapsedRef.current };
  }, []);

  const resume = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'paused') throw new Error('The current recording is not stopped.');
    const stream = streamRef.current;
    if (!stream) throw new Error('The microphone stream is no longer available. Start a new recording.');
    if (!isIOSDevice()) stream.getAudioTracks().forEach((track) => { track.enabled = true; });
    const track = assertLiveMicrophoneStream(stream);
    if (track.muted && !await waitForMicrophoneUnmuted(track, 2500)) throw new Error('The microphone did not become available again. Save this lecture and start a new recording.');
    await audioContextRef.current?.resume().catch(() => undefined);
    const resumed = new Promise<void>((resolve) => recorder.addEventListener('resume', () => resolve(), { once: true }));
    recorder.resume();
    await resumed;
    activeStartedRef.current = Date.now();
    setIsPaused(false);
    setIsRecording(true);
    setError('');
    startDurationTimer();
    await requestWakeLock();
  }, [requestWakeLock, startDurationTimer]);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') throw new Error('No recording is active.');
    const wasRecording = recorder.state === 'recording';
    if (wasRecording) elapsedRef.current += (Date.now() - activeStartedRef.current) / 1000;
    const stopped = new Promise<void>((resolve) => recorder.addEventListener('stop', () => resolve(), { once: true }));
    if (wasRecording) recorder.requestData();
    recorder.stop();
    await stopped;
    await Promise.allSettled(pendingWritesRef.current);
    const finalDuration = elapsedRef.current;
    const blob = await finalizeAudio(lectureIdRef.current, mimeTypeRef.current || recorder.mimeType);
    try {
      const verified = await validatePlayableAudio(blob);
      if (verified.duration && finalDuration <= 0) elapsedRef.current = verified.duration;
      await deleteAudioChunks(lectureIdRef.current);
    } catch (validationError) {
      recorderRef.current = null;
      setIsRecording(false);
      setIsPaused(false);
      stopMeters();
      throw new Error(`${validationError instanceof Error ? validationError.message : 'Saved audio validation failed.'} Recording checkpoints were kept for recovery.`);
    }
    recorderRef.current = null;
    setIsRecording(false);
    setIsPaused(false);
    setDuration(elapsedRef.current);
    stopMeters();
    return { blob, duration: elapsedRef.current, mimeType: blob.type };
  }, [stopMeters]);

  useEffect(() => () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      if (recorderRef.current.state === 'recording') recorderRef.current.requestData();
      recorderRef.current.stop();
    }
    stopMeters();
  }, [stopMeters]);

  return { isRecording, isPaused, duration, level, error, chunkCount, start, pause, resume, stop };
}
