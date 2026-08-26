import test from "node:test";
import assert from "node:assert/strict";
import { formatDuration, getPreferredMimeType, normalizeFilename, recordingSupport } from "../src/utils.js";

test("formatDuration formats seconds as mm:ss", () => {
  assert.equal(formatDuration(0), "00:00");
  assert.equal(formatDuration(65), "01:05");
  assert.equal(formatDuration(-5), "00:00");
});

test("normalizeFilename creates safe export names", () => {
  assert.equal(normalizeFilename(" Data Structures: Trees! "), "data-structures-trees");
  assert.equal(normalizeFilename(""), "lecture");
});

test("getPreferredMimeType chooses first supported recording type", () => {
  const fakeRecorder = {
    isTypeSupported(type) {
      return type === "audio/webm";
    },
  };
  assert.equal(getPreferredMimeType(fakeRecorder), "audio/webm");
});

test("recordingSupport reports missing APIs", () => {
  assert.deepEqual(recordingSupport({ navigator: {} }), {
    mediaDevices: false,
    mediaRecorder: false,
  });
});
