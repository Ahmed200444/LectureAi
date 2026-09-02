import CoreTransferable
import SwiftUI
import Translation
import UniformTypeIdentifiers

private enum TranscriptViewMode: String, CaseIterable, Identifiable {
    case original = "Original"
    case english = "English"
    case arabic = "Arabic"

    var id: String { rawValue }
}

private struct LectureTextExport: Transferable {
    let fileName: String
    let text: String

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .plainText) { item in
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent(item.fileName)
                .appendingPathExtension("txt")
            try item.text.write(to: url, atomically: true, encoding: .utf8)
            return SentTransferredFile(url)
        }
    }
}

struct LectureDetailView: View {
    let recording: SavedRecording

    @EnvironmentObject private var recorder: RecorderStore
    @EnvironmentObject private var lectureStore: NativeLectureStore
    @State private var mode: TranscriptViewMode = .original
    @State private var editingTranscript = false
    @State private var editingNotes = false
    @State private var notesDraft = ""

    private var transcript: NativeLectureTranscript {
        lectureStore.transcript(for: recording.id)
    }

    private var recordingSessionActive: Bool {
        recorder.state == .recording || recorder.state == .paused || recorder.state == .interrupted
    }

    private var safeExportBaseName: String {
        let invalid = CharacterSet(charactersIn: "/\\:*?\"<>|")
        let cleaned = recording.title
            .components(separatedBy: invalid)
            .joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "Lecture" : cleaned
    }

    private var transcriptExport: LectureTextExport {
        let body = transcript.segments.map { segment in
            "[\(NativeNotesGenerator.timestamp(segment.startTime))] \(segment.text)"
        }.joined(separator: "\n\n")
        let header = "\(recording.title)\nLectureAI transcript\n\n"
        return LectureTextExport(fileName: "\(safeExportBaseName)-transcript", text: header + body)
    }

    private var notesExport: LectureTextExport {
        let header = "\(recording.title)\nLectureAI notes\n\n"
        let currentNotes = editingNotes ? notesDraft : transcript.notes
        return LectureTextExport(fileName: "\(safeExportBaseName)-notes", text: header + currentNotes)
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
        .onAppear {
            if notesDraft.isEmpty {
                notesDraft = transcript.notes
            }
        }
        .onChange(of: transcript.notes) { _, value in
            if !editingNotes {
                notesDraft = value
            }
        }
        .onDisappear {
            if editingNotes {
                lectureStore.updateNotes(recordingID: recording.id, notes: notesDraft)
            }
        }
    }

    private var audioCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Original recording")
                .font(.headline)
            Text("\(NativeNotesGenerator.timestamp(recording.duration)) · \(formatBytesForDetail(recording.size))")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("The original audio is never modified by transcription, transcript edits, notes edits, or translation.")
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
                    Label("Export recording", systemImage: "square.and.arrow.up")
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

            if lectureStore.activeRecordingID == recording.id {
                Text("Keep LectureAI open while Core ML is transcribing. If iOS suspends or terminates heavy inference, the original audio and any previous completed transcript remain safe and can be retried.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Text("WhisperKit v1.1.0 runs after the recording is saved. The first transcription may need internet access to download the Core ML model, but the lecture audio itself is not sent to a cloud speech service.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .nativeCard()
    }

    private var transcriptCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Transcript")
                    .font(.headline)
                Spacer()
                if mode == .original {
                    Button {
                        editingTranscript.toggle()
                    } label: {
                        Label(editingTranscript ? "Done editing" : "Edit transcript", systemImage: editingTranscript ? "checkmark" : "pencil")
                    }
                    .buttonStyle(.bordered)
                }
                ShareLink(item: transcriptExport, preview: SharePreview("\(recording.title) transcript")) {
                    Label("Export transcript", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.bordered)
                .disabled(editingTranscript)
            }

            if editingTranscript {
                Text("Edit any transcript part below. Leaving a field or tapping Done editing saves the correction locally. Export is re-enabled after edits are saved.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                Text("Tap any timestamp to play that exact part of the original recording.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Picker("Transcript view", selection: $mode) {
                ForEach(TranscriptViewMode.allCases) { item in
                    Text(item.rawValue).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .disabled(editingTranscript)

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
                VStack(alignment: .leading, spacing: 6) {
                    Button {
                        recorder.play(recording, from: segment.startTime)
                    } label: {
                        Label(NativeNotesGenerator.timestamp(segment.startTime), systemImage: "play.circle")
                            .font(.caption.monospacedDigit())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Play recording from \(NativeNotesGenerator.timestamp(segment.startTime))")

                    if editingTranscript {
                        NativeTranscriptSegmentEditor(segment: segment) { correctedText in
                            lectureStore.updateTranscriptSegment(
                                recordingID: recording.id,
                                segmentID: segment.id,
                                text: correctedText
                            )
                        }
                    } else {
                        Text(segment.text)
                            .font(.body)
                            .textSelection(.enabled)
                    }
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
            HStack {
                Text("Lecture notes")
                    .font(.headline)
                Spacer()
                Button {
                    if editingNotes {
                        lectureStore.updateNotes(recordingID: recording.id, notes: notesDraft)
                        editingNotes = false
                    } else {
                        notesDraft = transcript.notes
                        editingNotes = true
                    }
                } label: {
                    Label(editingNotes ? "Save notes" : "Edit notes", systemImage: editingNotes ? "checkmark" : "pencil")
                }
                .buttonStyle(.bordered)

                ShareLink(item: notesExport, preview: SharePreview("\(recording.title) notes")) {
                    Label("Export notes", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.bordered)
            }

            if editingNotes {
                TextEditor(text: $notesDraft)
                    .font(.body)
                    .frame(minHeight: 300)
                    .padding(8)
                    .background(Color(.tertiarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .accessibilityLabel("Editable lecture notes")

                Text("Notes stay local and are saved when you tap Save notes or leave this lecture.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                Text(transcript.notes)
                    .font(.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
        }
        .nativeCard()
    }
}

private struct NativeTranscriptSegmentEditor: View {
    let segment: NativeTranscriptSegment
    let onSave: (String) -> Void

    @State private var draft: String
    @FocusState private var focused: Bool

    init(segment: NativeTranscriptSegment, onSave: @escaping (String) -> Void) {
        self.segment = segment
        self.onSave = onSave
        _draft = State(initialValue: segment.text)
    }

    var body: some View {
        TextField("Transcript segment", text: $draft, axis: .vertical)
            .lineLimit(2...10)
            .textFieldStyle(.roundedBorder)
            .focused($focused)
            .onChange(of: focused) { _, isFocused in
                if !isFocused {
                    saveIfNeeded()
                }
            }
            .onDisappear {
                saveIfNeeded()
            }
            .accessibilityLabel("Edit transcript at \(NativeNotesGenerator.timestamp(segment.startTime))")
    }

    private func saveIfNeeded() {
        if draft != segment.text {
            onSave(draft)
        }
    }
}

@available(iOS 18.0, *)
private struct OnDeviceTranslationView: View {
    let sourceSegments: [NativeTranscriptSegment]
    let targetLanguageCode: String
    let onTranslated: (String) -> Void

    @State private var batches: [NativeTranslationBatch] = []
    @State private var translatedChunks: [String] = []
    @State private var currentIndex = 0
    @State private var configuration: TranslationSession.Configuration?
    @State private var started = false
    @State private var finished = false
    @State private var fallbackCount = 0
    @State private var status = "Preparing Apple on-device translation…"
    @State private var warningMessage: String?
    @State private var errorMessage: String?
    @State private var partialText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !finished && errorMessage == nil {
                ProgressView()
            }

            Text(status)
                .font(.caption)
                .foregroundStyle(.secondary)

            if let partialText, !partialText.isEmpty {
                Text(partialText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }

            if let warningMessage {
                Text(warningMessage)
                    .font(.caption)
                    .foregroundStyle(.orange)
                Button("Retry full translation") {
                    resetAndStart()
                }
                .buttonStyle(.bordered)
            } else if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
                Button("Retry translation") {
                    resetAndStart()
                }
                .buttonStyle(.bordered)
            }
        }
        .onAppear {
            startIfNeeded()
        }
        .translationTask(configuration) { session in
            await translateCurrentLanguageGroup(using: session)
        }
    }

    @MainActor
    private func startIfNeeded() {
        guard !started else { return }
        started = true
        batches = NativeTranslationChunker.batches(from: sourceSegments)
        guard !batches.isEmpty else {
            finished = true
            status = "No transcript is available to translate"
            return
        }
        translatedChunks = Array(repeating: "", count: batches.count)
        currentIndex = 0
        fallbackCount = 0
        finished = false
        warningMessage = nil
        errorMessage = nil
        partialText = nil
        configureNextSession()
    }

    @MainActor
    private func resetAndStart() {
        configuration = nil
        batches = []
        translatedChunks = []
        currentIndex = 0
        fallbackCount = 0
        started = false
        finished = false
        warningMessage = nil
        errorMessage = nil
        partialText = nil
        status = "Preparing Apple on-device translation…"
        startIfNeeded()
    }

    @MainActor
    private func configureNextSession() {
        let targetCode = targetLanguageCode.lowercased()

        while currentIndex < batches.count {
            let batch = batches[currentIndex]
            if batch.sourceLanguageCode?.lowercased() == targetCode {
                translatedChunks[currentIndex] = batch.text
                currentIndex += 1
                continue
            }

            let sourceLanguage = batch.sourceLanguageCode.map { Locale.Language(identifier: $0) }
            configuration = TranslationSession.Configuration(
                source: sourceLanguage,
                target: Locale.Language(identifier: targetLanguageCode)
            )
            let sourceLabel = batch.sourceLanguageCode?.uppercased() ?? "auto-detected language"
            status = "Translating \(sourceLabel) to \(targetLanguageCode.uppercased()) locally…"
            return
        }

        finishTranslation()
    }

    private func translateCurrentLanguageGroup(using session: TranslationSession) async {
        let snapshot = await MainActor.run { () -> (Int, String?)? in
            guard currentIndex < batches.count else { return nil }
            return (currentIndex, batches[currentIndex].sourceLanguageCode)
        }
        guard let (startIndex, sourceCode) = snapshot else { return }

        var index = startIndex
        do {
            while true {
                let batch = await MainActor.run { () -> NativeTranslationBatch? in
                    guard index < batches.count else { return nil }
                    let candidate = batches[index]
                    if index > startIndex {
                        if sourceCode == nil { return nil }
                        if candidate.sourceLanguageCode != sourceCode { return nil }
                    }
                    return candidate
                }
                guard let batch else { break }

                try Task.checkCancellation()
                let response = try await session.translate(batch.text)
                let cleaned = WhisperTextSanitizer.cleanMultiline(response.targetText)
                guard !cleaned.isEmpty else {
                    throw TranslationCoordinatorError.emptyResponse
                }

                await MainActor.run {
                    translatedChunks[index] = cleaned
                    currentIndex = index + 1
                    status = "Translated part \(currentIndex) of \(batches.count) locally…"
                }
                index += 1
            }

            await MainActor.run {
                scheduleNextSession()
            }
        } catch is CancellationError {
            return
        } catch {
            await MainActor.run {
                guard index < batches.count else {
                    configuration = nil
                    finished = true
                    status = "Translation stopped before the remaining text could be processed"
                    errorMessage = error.localizedDescription
                    return
                }

                // Do not let one unsupported/misdetected language fragment destroy the
                // useful translation of the rest of the lecture. Keep that exact source
                // text visibly in place, continue with the next language group, and do
                // not persist a partial translation so the user can retry later.
                translatedChunks[index] = batches[index].text
                fallbackCount += 1
                currentIndex = index + 1
                let sourceLabel = sourceCode?.uppercased() ?? "auto-detected language"
                status = "Could not translate part \(index + 1) from \(sourceLabel) · kept the original text and continuing…"
                scheduleNextSession()
            }
        }
    }

    @MainActor
    private func scheduleNextSession() {
        configuration = nil
        Task { @MainActor in
            await Task.yield()
            configureNextSession()
        }
    }

    @MainActor
    private func finishTranslation() {
        let translated = translatedChunks
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        finished = true
        guard !translated.isEmpty else {
            status = "Translation completed without usable text"
            errorMessage = "Apple on-device translation did not return usable text."
            return
        }

        partialText = translated
        if fallbackCount > 0 {
            status = "Translation finished with \(fallbackCount) part\(fallbackCount == 1 ? "" : "s") kept in the original language"
            warningMessage = "Apple Translation could not translate every fragment on this device. Supported parts were translated; unsupported or uncertain parts are shown in their original language. Nothing partial was saved, so you can retry the full translation."
            return
        }

        status = "Translation complete"
        partialText = nil
        onTranslated(translated)
    }
}

@available(iOS 18.0, *)
private enum TranslationCoordinatorError: LocalizedError {
    case emptyResponse

    var errorDescription: String? {
        switch self {
        case .emptyResponse:
            return "The on-device translator returned no usable text for this part of the lecture."
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
