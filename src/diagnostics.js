import { recordingSupport } from "./utils.js";

export function detectDevice(userAgent = navigator.userAgent) {
  const ua = String(userAgent || "");
  const isIPad = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const isIPhone = /iPhone/i.test(ua);
  const isWindows = /Windows/i.test(ua);
  const isMac = /Macintosh|Mac OS X/i.test(ua) && !isIPad;

  if (isIPhone) return "iPhone";
  if (isIPad) return "iPad";
  if (isWindows) return "Windows laptop/PC";
  if (isMac) return "Mac";
  return "Other device";
}

export async function collectDiagnostics() {
  const support = recordingSupport();
  let permission = "unknown";
  let inputs = [];

  try {
    if (navigator.permissions?.query) {
      const status = await navigator.permissions.query({ name: "microphone" });
      permission = status.state;
    }
  } catch {
    permission = "browser-managed";
  }

  try {
    if (navigator.mediaDevices?.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      inputs = devices
        .filter((device) => device.kind === "audioinput")
        .map((device, index) => device.label || `Microphone ${index + 1}`);
    }
  } catch {
    inputs = [];
  }

  return {
    device: detectDevice(),
    secureContext: globalThis.isSecureContext,
    mediaDevices: support.mediaDevices,
    mediaRecorder: support.mediaRecorder,
    microphonePermission: permission,
    microphones: inputs,
    online: navigator.onLine,
  };
}
