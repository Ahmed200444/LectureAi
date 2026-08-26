import { getPreferredMimeType } from "./utils.js";

export class LectureRecorder {
  constructor({ onStateChange = () => {}, onLevel = () => {} } = {}) {
    this.onStateChange = onStateChange;
    this.onLevel = onLevel;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.startedAt = null;
    this.audioContext = null;
    this.animationFrame = null;
  }

  async requestMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not expose microphone recording APIs.");
    }

    this.stopStream();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.startLevelMeter();
    this.onStateChange("ready");
    return this.stream;
  }

  start() {
    if (!this.stream) throw new Error("Microphone access is required first.");
    if (!globalThis.MediaRecorder) throw new Error("MediaRecorder is not supported by this browser.");

    this.chunks = [];
    const mimeType = getPreferredMimeType();
    this.recorder = mimeType
      ? new MediaRecorder(this.stream, { mimeType })
      : new MediaRecorder(this.stream);

    this.recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) this.chunks.push(event.data);
    });

    this.recorder.start(1000);
    this.startedAt = Date.now();
    this.onStateChange("recording");
  }

  async stop() {
    if (!this.recorder || this.recorder.state === "inactive") return null;

    const recorder = this.recorder;
    const result = await new Promise((resolve) => {
      recorder.addEventListener(
        "stop",
        () => {
          const type = recorder.mimeType || this.chunks[0]?.type || "audio/webm";
          resolve(new Blob(this.chunks, { type }));
        },
        { once: true },
      );
      recorder.stop();
    });

    this.onStateChange("stopped");
    return result;
  }

  stopStream() {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;

    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.onLevel(0);
  }

  startLevelMeter() {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass || !this.stream) return;

    this.audioContext = new AudioContextClass();
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 256;
    const source = this.audioContext.createMediaStreamSource(this.stream);
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteFrequencyData(data);
      const average = data.reduce((sum, value) => sum + value, 0) / data.length;
      this.onLevel(Math.min(100, Math.round((average / 128) * 100)));
      this.animationFrame = requestAnimationFrame(tick);
    };

    tick();
  }
}
