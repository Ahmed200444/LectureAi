'use client';

import { Check, Mic, Square, Volume1, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { assertLiveMicrophoneStream, validatePlayableAudio } from '../lib/audio-validation';
import { deviceLabel, isStandaloneApp, preferredRecordingMimeType } from '../lib/device';

export function MicTest({ onVerified, onReset }: { onVerified?: () => void; onReset?: () => void }) {
  const [testing, setTesting] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [sampleUrl, setSampleUrl] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState(`Record a 12-second sample from the ${deviceLabel()} position you will use during class${isStandaloneApp() ? ' in the installed LectureAI app' : ''}.`);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = useRef<number | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const peakRef = useRef(0);
  const meterReliableRef = useRef(true);

  function cleanUp() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    contextRef.current?.close().catch(() => undefined);
    streamRef.current = null;
    contextRef.current = null;
  }

  async function startTest() {
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('This browser does not support microphone recording.');
      setMessage('Listening… speak from approximately the professor’s distance.');
      setSeconds(0);
      setLevel(0);
      setConfirmed(false);
      onReset?.();
      peakRef.current = 0;
      meterReliableRef.current = true;
      chunksRef.current = [];
      if (sampleUrl) { URL.revokeObjectURL(sampleUrl); setSampleUrl(''); }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 }, video: false });
      assertLiveMicrophoneStream(stream);
      streamRef.current = stream;
      const mimeType = preferredRecordingMimeType();
      let recorder: MediaRecorder;
      try {
        recorder = mimeType ? new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 128_000 }) : new MediaRecorder(stream);
      } catch {
        recorder = new MediaRecorder(stream);
      }
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => { void finishSample(recorder); };
      recorder.start(500);
      setTesting(true);
      const started = Date.now();
      timerRef.current = setInterval(() => setSeconds(Math.min(12, (Date.now() - started) / 1000)), 200);
      timeoutRef.current = setTimeout(() => stopTest(), 12_000);
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) { meterReliableRef.current = false; return; }
      const context = new AudioContextClass();
      contextRef.current = context;
      await context.resume().catch(() => undefined);
      if (context.state !== 'running') {
        // The recording can still be valid in iOS standalone mode even if the visual
        // WebAudio meter is temporarily suspended.
        meterReliableRef.current = false;
        return;
      }
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const update = () => {
        analyser.getByteTimeDomainData(data);
        const rms = Math.sqrt(data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / data.length);
        const nextLevel = Math.min(1, rms * 5);
        peakRef.current = Math.max(peakRef.current, nextLevel);
        setLevel(nextLevel);
        frameRef.current = requestAnimationFrame(update);
      };
      update();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Microphone permission was not granted.');
      setTesting(false);
      cleanUp();
    }
  }

  async function finishSample(recorder: MediaRecorder) {
    try {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
      await validatePlayableAudio(blob, 7000);
      const url = URL.createObjectURL(blob);
      setSampleUrl(url);
      const peak = peakRef.current;
      if (!meterReliableRef.current) setMessage('Sample saved. The iPhone visual meter was unavailable, so play the sample and confirm that you can clearly hear the speech.');
      else if (peak < 0.03) setMessage('The meter detected a quiet sample. Play it back; if speech is hard to hear, check microphone position and repeat the test.');
      else if (peak > 0.93) setMessage('Sample saved, but clipping was detected. Play it back, then move the device farther away if speech sounds distorted.');
      else setMessage('Sample saved. Play it back and confirm that you can clearly hear the speech before class.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The microphone sample could not be reloaded.');
    } finally {
      setTesting(false);
      cleanUp();
    }
  }

  function stopTest() {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }

  useEffect(() => () => {
    cleanUp();
    if (sampleUrl) URL.revokeObjectURL(sampleUrl);
  }, []);

  const LevelIcon = level > .65 ? Volume2 : level > .08 ? Volume1 : VolumeX;

  return (
    <section className="mic-test" aria-label="Microphone test">
      <div className="mic-test-head">
        <span className="soft-icon"><Mic size={18} /></span>
        <div><strong>Test microphone</strong><p>{confirmed ? 'Microphone working — you confirmed the recorded sample is audible.' : message}</p></div>
      </div>
      {testing && <div className="meter-row"><LevelIcon size={17} /><div className="level-track"><i style={{ width: `${Math.max(2, level * 100)}%` }} /></div><span>{Math.ceil(seconds)} / 12s</span></div>}
      <div className="button-row compact">
        {!testing ? <button className="secondary-button" type="button" onClick={startTest}><Mic size={16} /> Start sample</button> : <button className="secondary-button danger-text" type="button" onClick={stopTest}><Square size={15} /> Stop sample</button>}
        {sampleUrl && <audio src={sampleUrl} controls aria-label="Microphone test playback" className="sample-player" />}
        {sampleUrl && !confirmed && <button className="primary-button" type="button" onClick={() => { setConfirmed(true); onVerified?.(); }}><Check size={15} /> I can hear the sample</button>}
      </div>
    </section>
  );
}
