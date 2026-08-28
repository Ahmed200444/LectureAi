import type { TranscriptionProgress } from './transcription.ts';
import { audioFileExtension, normalizeAudioMimeType } from './device.ts';

const PHONE_MODEL = 'whisper-base' as const;

type BrowserWhisperInstance = Awaited<ReturnType<typeof createWhisper>>;
let sharedWhisperPromise: Promise<BrowserWhisperInstance> | null = null;

async function createWhisper() {
  const { BrowserWhisper } = await import('browser-whisper');
  return new BrowserWhisper({ model: PHONE_MODEL });
}

function getWhisper() {
  sharedWhisperPromise ??= createWhisper();
  return sharedWhisperPromise;
}

function asAudioFile(lectureId: string, audio: Blob) {
  const originalName = audio instanceof File ? audio.name : '';
  const mimeType = normalizeAudioMimeType(audio.type, originalName);
  const extension = audioFileExtension(mimeType, originalName);
  const filename = originalName || `lecture-${lectureId}.${extension}`;
  return audio instanceof File && audio.type === mimeType
    ? audio
    : new File([audio], filename, { type: mimeType, lastModified: Date.now() });
}

function progressForStage(stage: string, progress: number) {
  const normalized = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  if (stage === 'loading') return Math.round(8 + normalized * 45);
  if (stage === 'decoding') return Math.round(53 + normalized * 12);
  if (stage === 'transcribing') return Math.round(65 + normalized * 27);
  return Math.round(8 + normalized * 84);
}

function messageForStage(stage: string, progress: number) {
  const percent = Math.round(Math.max(0, Math.min(1, progress || 0)) * 100);
  if (stage === 'loading') return `Loading the private multilingual phone model… ${percent}%`;
  if (stage === 'decoding') return `Decoding the saved lecture in small audio chunks… ${percent}%`;
  if (stage === 'transcribing') return `Transcribing English, Egyptian Arabic, MSA, and technical terms locally… ${percent}%`;
  return 'Preparing private on-device transcription…';
}

export async function transcribeOnPhone(
  lectureId: string,
  audio: Blob,
  onProgress: (update: TranscriptionProgress) => void,
  onModelReady: () => void,
) {
  if (typeof window === 'undefined' || typeof File === 'undefined') throw new Error('Phone transcription is only available in a browser.');
  if (!window.crossOriginIsolated) {
    throw new Error('Private phone transcription is not initialized correctly on this site. Reload the latest LectureAI version and try again.');
  }

  onProgress({ progress: 5, message: 'Preparing the saved recording for private on-device transcription…' });
  const file = asAudioFile(lectureId, audio);
  const whisper = await getWhisper();
  let modelReadyReported = false;
  let lastProgress = 5;

  const stream = whisper.transcribe(file, {
    onProgress: ({ stage, progress }: { stage: string; progress: number }) => {
      if (stage !== 'loading' && !modelReadyReported) {
        modelReadyReported = true;
        onModelReady();
      }
      const mapped = Math.max(lastProgress, progressForStage(stage, progress));
      lastProgress = mapped;
      onProgress({ progress: mapped, message: messageForStage(stage, progress) });
    },
  });

  const chunks = await stream.collect();
  if (!modelReadyReported) onModelReady();
  const segments = chunks
    .filter((chunk: { text?: string }) => Boolean(chunk.text?.trim()))
    .map((chunk: { text: string; start: number; end: number }, index: number) => ({
      id: `${lectureId}-phone-${index + 1}`,
      start: Math.max(0, Number(chunk.start) || 0),
      end: Math.max(Number(chunk.start) || 0, Number(chunk.end) || Number(chunk.start) || 0),
      text: chunk.text.trim(),
      // browser-whisper currently exposes segment text/timestamps but not a
      // calibrated confidence score. Zero keeps these segments reviewable
      // instead of inventing certainty.
      confidence: 0,
      speaker: 'Professor',
    }));

  onProgress({ progress: 92, message: 'On-device transcript complete · preparing editable notes…' });
  return { engine: 'browser-whisper', model: PHONE_MODEL, segments };
}
