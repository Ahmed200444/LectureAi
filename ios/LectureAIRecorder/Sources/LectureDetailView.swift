import SwiftUI
import Translation

private enum TranscriptViewMode: String, CaseIterable, Identifiable {
    case original = "Original"
    case english = "English"
    case arabic = "Arabic"

    var id: String { rawValue }
}

struct LectureDetailView: View {
    let recording: SavedRecording

    @EnvironmentObject private var recorder: RecorderStore
    @EnvironmentObject private var lectureStore: NativeLectureStore
    @State private var mode: TranscriptViewMode = .original

    private var transcript: NativeLectureTranscript {
        lectureStore.transcript(for: recording.id)
    }

    private var recordingSessionActive: Bool {
        recorder.state == .recording || recorder.state == .paused || recorder.state == .interrupted
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                audioCard
                transcriptionCard
                if transcript.state == .done {
                    transcriptCard
                    notesCard
                }
            }
            .padding()
        }
        .navigationTitle(recording.title)
        .navigationBarTitleDisplayMode(.inline)
        .background(Color(.systemGroupedBackground))
    }

    private var audioCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Original recording")
                .font(.headline)
            Text("\(NativeNotesGenerator.timestamp(recording.duration)) · \(formatBytesForDetail(recording.size))")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("The original audio is never modified by transcription or translation.")
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack {
                Button {
                    recorder.isPlaying ? recorder.stopPlayback() : recorder.play(recording)
                } label: {
                    Label(recorder.isPlaying ? "Stop" : "Listen", systemImage: recorder.isPlaying ? "stop.fill" : "play.fill")
                }
                .buttonStyle(.bordered)

                ShareLink(item: recording.audioURL) {
                    Label("Share audio", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.bordered)
            }
        }
        .nativeCard()
    }

    private var transcriptionCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("On-device transcription")
                        .font(.headline)
                    Text(transcript.statusMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if lectureStore.activeRecordingID == recording.id {
                    ProgressView()
                        .accessibilityLabel("Transcription in progress")
                }
            }

            if let model = transcript.modelName {
                Label("Model: \(model)", systemImage: "cpu")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let language = transcript.detectedLanguage {
                Label("Detected language: \(language)", systemImage: "character.bubble")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let error = transcript.lastError, transcript.state == .failed {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            Button {
                Task { await lectureStore.transcribe(recording) }
            } label: {
                Label(transcript.state == .done ? "Transcribe again" : transcript.state == .failed ? "Retry transcription" : "Transcribe locally", systemImage: "waveform.badge.magnifyingglass")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(lectureStore.activeRecordingID != nil || recordingSessionActive)

            if recordingSessionActive {
                Text("Finish the current microphone recording before starting Core ML transcription. Recording is kept isolated from the heavier speech-model workload.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Text("WhisperKit v1.1.0 runs after the recording is saved. LectureAI does not use live streaming transcription, Safari, or a cloud speech API on iPhone/iPad.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .nativeCard()
    }

    private var transcriptCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Transcript")
                .font(.headline)

            Picker("Transcript view", selection: $mode) {
                ForEach(TranscriptViewMode.allCases) { item in
                    Text(item.rawValue).tag(item)
                }
            }
            .pickerStyle(.segmented)

            switch mode {
            case .original:
                originalTranscript
            case .english:
                translatedTranscript(languageCode: "en", existing: transcript.englishText)
            case .arabic:
                translatedTranscript(languageCode: "ar", existing: transcript.arabicText)
            }
        }
        .nativeCard()
    }

    private var originalTranscript: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(transcript.segments) { segment in
                VStack(alignment: .leading, spacing: 4) {
                    Button {
                        recorder.play(recording, from: segment.startTime)
                    } label: {
                        Label(NativeNotesGenerator.timestamp(segment.startTime), systemImage: "play.circle")
                            .font(.caption.monospacedDigit())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Play recording from \(NativeNotesGenerator.timestamp(segment.startTime))")

                    Text(segment.text)
                        .font(.body)
                        .textSelection(.enabled)
                }
                if segment.id != transcript.segments.last?.id {
                    Divider()
                }
            }
        }
    }

    @ViewBuilder
    private func translatedTranscript(languageCode: String, existing: String?) -> some View {
        if let existing, !existing.isEmpty {
            Text(existing)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        } else if transcript.originalText.isEmpty {
            Text("No transcript is available to translate.")
                .foregroundStyle(.secondary)
        } else if #available(iOS 18.0, *) {
            OnDeviceTranslationView(
                sourceSegments: transcript.segments,
                targetLanguageCode: languageCode
            ) { translated in
                lectureStore.saveTranslation(
                    recordingID: recording.id,
                    languageCode: languageCode,
                    text: translated
                )
            }
        } else {
            Text("English/Arabic on-device translation requires iOS 18 or later. The original transcript remains available on iOS 17.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var notesCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Lecture notes")
                .font(.headline)
            Text(transcript.notes)
                .font(.body)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
        .nativeCard()
    }
}

@available(iOS 18.0, *)
private struct OnDeviceTranslationView: View {
    let sourceSegments: [NativeTranscriptSegment]
    let targetLanguageCode: String
    let onTranslated: (String) -> Void

    @State private var status = "Preparing Apple on-device translation…"
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProgressView()
            Text(status)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .translationTask(
            source: nil,
            target: Locale.Language(identifier: targetLanguageCode)
        ) { session in
            do {
                let batches = NativeTranslationChunker.batches(from: sourceSegments)
                guard !batches.isEmpty else {
                    status = "No transcript is available to translate"
                    return
                }

                // The session intentionally keeps source=nil. Apple can identify the
                // source from each actual request and request a language download when
                // needed. Calling prepareTranslation() with a nil source would fail
                // before any text is available for language identification.
                var translatedChunks: [String] = []
                translatedChunks.reserveCapacity(batches.count)

                for (index, batch) in batches.enumerated() {
                    try Task.checkCancellation()
                    status = batches.count == 1
                        ? "Translating locally on this device…"
                        : "Translating part \(index + 1) of \(batches.count) locally…"

                    if batch.sourceLanguageCode == targetLanguageCode.lowercased() {
                        translatedChunks.append(batch.text)
                        continue
                    }

                    let response = try await session.translate(batch.text)
                    let cleaned = response.targetText.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !cleaned.isEmpty { translatedChunks.append(cleaned) }
                }

                let translated = translatedChunks.joined(separator: "\n\n")
                guard !translated.isEmpty else {
                    status = "Translation completed without usable text"
                    return
                }
                onTranslated(translated)
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.localizedDescription
                status = "Translation is not available yet"
            }
        }
    }
}

private extension View {
    func nativeCard() -> some View {
        self
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

private func formatBytesForDetail(_ bytes: Int64) -> String {
    let formatter = ByteCountFormatter()
    formatter.allowedUnits = [.useMB, .useGB]
    formatter.countStyle = .file
    return formatter.string(fromByteCount: max(0, bytes))
}
