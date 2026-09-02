import Foundation
import WhisperKit

enum NativeTranscriptState: String, Codable, Sendable {
    case idle
    case preparing
    case transcribing
    case done
    case failed
}

struct NativeLectureTranscript: Codable, Hashable, Sendable {
    let recordingID: UUID
    var updatedAt: Date
    var state: NativeTranscriptState
    var statusMessage: String
    var progress: Double
    var modelName: String?
    var detectedLanguage: String?
    var segments: [NativeTranscriptSegment]
    var englishText: String?
    var arabicText: String?
    var notes: String
    var lastError: String?

    var originalText: String {
        segments.map(\.text).filter { !$0.isEmpty }.joined(separator: " ")
    }

    static func empty(for recordingID: UUID) -> NativeLectureTranscript {
        NativeLectureTranscript(
            recordingID: recordingID,
            updatedAt: Date(),
            state: .idle,
            statusMessage: "Ready to transcribe locally on this device",
            progress: 0,
            modelName: nil,
            detectedLanguage: nil,
            segments: [],
            englishText: nil,
            arabicText: nil,
            notes: "",
            lastError: nil
        )
    }
}

struct NativeTranscriptionOutput: Sendable {
    let modelName: String
    let detectedLanguage: String
    let segments: [NativeTranscriptSegment]
}

actor NativeTranscriptionEngine {
    func transcribe(audioURL: URL) async throws -> NativeTranscriptionOutput {
        try Task.checkCancellation()

        let prepared = try TranscriptionAudioPreparer.prepare(sourceURL: audioURL)
        defer { TranscriptionAudioPreparer.cleanup(prepared) }

        // Keep model selection device-safe and reproducible. WhisperKit's bundled
        // support table chooses a multilingual model appropriate for the current chip.
        let selectedModel = WhisperKit.recommendedModels().default
        let config = WhisperKitConfig(
            model: selectedModel,
            verbose: false,
            prewarm: true,
            load: false,
            download: true,
            useBackgroundDownloadSession: true
        )
        let pipe = try await WhisperKit(config)

        do {
            try Task.checkCancellation()

            // Accuracy/completeness priorities for saved university lectures:
            // - detect the spoken language automatically with the multilingual model;
            // - strip Whisper control tokens before they can reach UI/notes/translation;
            // - suppress blank output;
            // - avoid VAD chunking so quiet/distant speech is not silently omitted.
            // The incremental audio-loading mode below still bounds memory for long files.
            let decodeOptions = DecodingOptions(
                task: .transcribe,
                language: nil,
                usePrefillPrompt: true,
                detectLanguage: true,
                skipSpecialTokens: true,
                wordTimestamps: false,
                suppressBlank: true,
                suppressTokens: [],
                concurrentWorkerCount: 1,
                chunkingStrategy: .none
            )

            let audioOptions = AudioInputOptions(
                channelMode: .sumChannels(nil),
                audioLoadingMode: .incremental
            )

            let results = try await pipe.transcribe(
                audioPath: prepared.url.path,
                audioInputOptions: audioOptions,
                decodeOptions: decodeOptions
            )

            try Task.checkCancellation()

            let whisperSegments = results.flatMap { result in
                result.segments
            }

            var segments: [NativeTranscriptSegment] = []
            segments.reserveCapacity(whisperSegments.count)
            for segment in whisperSegments {
                let cleaned = WhisperTextSanitizer.cleanInline(segment.text)
                guard !cleaned.isEmpty else { continue }
                segments.append(
                    NativeTranscriptSegment(
                        startTime: Double(segment.start),
                        endTime: Double(segment.end),
                        text: cleaned
                    )
                )
            }
            segments.sort { lhs, rhs in
                if lhs.startTime == rhs.startTime {
                    return lhs.endTime < rhs.endTime
                }
                return lhs.startTime < rhs.startTime
            }

            let fallbackText = WhisperTextSanitizer.cleanInline(
                results.map(\.text).joined(separator: " ")
            )

            let finalSegments: [NativeTranscriptSegment]
            if segments.isEmpty, !fallbackText.isEmpty {
                finalSegments = [NativeTranscriptSegment(startTime: 0, endTime: 0, text: fallbackText)]
            } else {
                finalSegments = segments
            }

            guard !finalSegments.isEmpty else {
                throw NativeTranscriptionError.emptyTranscript
            }

            let languages = results
                .map { $0.language.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
                .filter { !$0.isEmpty && $0 != "unknown" }
            let uniqueLanguages = Array(Set(languages)).sorted()
            let language: String
            if uniqueLanguages.count == 1 {
                language = uniqueLanguages[0]
            } else if uniqueLanguages.count > 1 {
                language = "mixed: " + uniqueLanguages.joined(separator: ", ")
            } else {
                language = "unknown"
            }
            let model = pipe.modelFolder?.lastPathComponent ?? selectedModel

            await pipe.unloadModels()
            return NativeTranscriptionOutput(
                modelName: model,
                detectedLanguage: language,
                segments: finalSegments
            )
        } catch {
            await pipe.unloadModels()
            throw error
        }
    }
}

@MainActor
final class NativeLectureStore: ObservableObject {
    @Published private(set) var transcripts: [UUID: NativeLectureTranscript] = [:]
    @Published private(set) var activeRecordingID: UUID?

    private let engine = NativeTranscriptionEngine()

    init() {
        TranscriptionAudioPreparer.removeAbandonedTemporaryFiles()
        loadPersistedTranscripts()
    }

    func transcript(for recordingID: UUID) -> NativeLectureTranscript {
        transcripts[recordingID] ?? .empty(for: recordingID)
    }

    func transcribe(_ recording: SavedRecording) async {
        guard activeRecordingID == nil else {
            if activeRecordingID != recording.id {
                var record = transcript(for: recording.id)
                record.statusMessage = "Another lecture is currently using the local speech model"
                transcripts[recording.id] = record
            }
            return
        }

        guard FileManager.default.fileExists(atPath: recording.audioURL.path) else {
            fail(recordingID: recording.id, message: "The original audio file is missing.")
            return
        }

        let previousRecord = transcript(for: recording.id)
        let previousCompleted: NativeLectureTranscript? =
            previousRecord.state == .done && !previousRecord.segments.isEmpty ? previousRecord : nil

        activeRecordingID = recording.id
        defer { activeRecordingID = nil }

        var record = previousRecord
        record.updatedAt = Date()
        record.state = .preparing
        record.statusMessage = "Preparing a safe 16 kHz transcription copy and the multilingual Whisper model…"
        record.progress = 0.12
        record.lastError = nil
        transcripts[recording.id] = record
        if previousCompleted == nil {
            persist(record)
        }

        do {
            record.state = .transcribing
            record.statusMessage = "Transcribing saved audio locally with automatic language detection…"
            record.progress = 0.42
            transcripts[recording.id] = record
            if previousCompleted == nil {
                persist(record)
            }

            let output = try await engine.transcribe(audioURL: recording.audioURL)

            record.updatedAt = Date()
            record.state = .done
            record.statusMessage = "Native on-device transcription complete"
            record.progress = 1
            record.modelName = output.modelName
            record.detectedLanguage = output.detectedLanguage
            record.segments = output.segments

            let outputText = output.segments.map(\.text).joined(separator: " ")
            let normalizedLanguage = output.detectedLanguage.lowercased()
            if normalizedLanguage.hasPrefix("en") {
                record.englishText = outputText
            } else {
                record.englishText = nil
            }
            if normalizedLanguage.hasPrefix("ar") {
                record.arabicText = outputText
            } else {
                record.arabicText = nil
            }

            record.notes = NativeNotesGenerator.generate(segments: output.segments, marks: recording.marks)
            record.lastError = nil
            transcripts[recording.id] = record
            persist(record)
        } catch is CancellationError {
            if var previousCompleted {
                previousCompleted.updatedAt = Date()
                previousCompleted.statusMessage = "Retranscription cancelled · previous transcript kept"
                previousCompleted.lastError = nil
                transcripts[recording.id] = previousCompleted
                persist(previousCompleted)
            } else {
                record.updatedAt = Date()
                record.state = .idle
                record.statusMessage = "Transcription cancelled · original audio remains saved"
                record.progress = 0
                transcripts[recording.id] = record
                persist(record)
            }
        } catch {
            if var previousCompleted {
                previousCompleted.updatedAt = Date()
                previousCompleted.statusMessage = "Retranscription failed · previous transcript kept"
                previousCompleted.lastError = error.localizedDescription
                transcripts[recording.id] = previousCompleted
                persist(previousCompleted)
            } else {
                fail(recordingID: recording.id, message: error.localizedDescription)
            }
        }
    }

    func saveTranslation(recordingID: UUID, languageCode: String, text: String) {
        var record = transcript(for: recordingID)
        let cleaned = WhisperTextSanitizer.cleanMultiline(text)
        guard !cleaned.isEmpty else { return }
        if languageCode == "en" {
            record.englishText = cleaned
        } else if languageCode == "ar" {
            record.arabicText = cleaned
        }
        record.updatedAt = Date()
        transcripts[recordingID] = record
        persist(record)
    }

    func updateTranscriptSegment(recordingID: UUID, segmentID: UUID, text: String) {
        var record = transcript(for: recordingID)
        guard record.state == .done,
              let index = record.segments.firstIndex(where: { $0.id == segmentID }) else { return }

        let oldSegment = record.segments[index]
        let replacement = NativeTranscriptSegment(
            id: oldSegment.id,
            startTime: oldSegment.startTime,
            endTime: oldSegment.endTime,
            text: text
        )
        guard replacement.text != oldSegment.text else { return }

        record.segments[index] = replacement
        record.updatedAt = Date()
        record.statusMessage = "Transcript edit saved locally"

        let joinedText = record.segments.map(\.text).filter { !$0.isEmpty }.joined(separator: " ")
        let normalizedLanguage = record.detectedLanguage?.lowercased() ?? ""
        record.englishText = normalizedLanguage.hasPrefix("en") ? joinedText : nil
        record.arabicText = normalizedLanguage.hasPrefix("ar") ? joinedText : nil

        transcripts[recordingID] = record
        persist(record)
    }

    func updateNotes(recordingID: UUID, notes: String) {
        var record = transcript(for: recordingID)
        guard record.state == .done else { return }
        guard notes != record.notes else { return }
        record.notes = notes
        record.updatedAt = Date()
        record.statusMessage = "Notes edit saved locally"
        transcripts[recordingID] = record
        persist(record)
    }

    func deleteTranscript(for recordingID: UUID) {
        transcripts.removeValue(forKey: recordingID)
        try? FileManager.default.removeItem(at: transcriptURL(for: recordingID))
    }

    private func fail(recordingID: UUID, message: String) {
        var record = transcript(for: recordingID)
        record.updatedAt = Date()
        record.state = .failed
        record.statusMessage = "Transcription failed · the original recording is safe and can be retried"
        record.progress = 0
        record.lastError = message
        transcripts[recordingID] = record
        persist(record)
    }

    private func persist(_ transcript: NativeLectureTranscript) {
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(transcript)
            try data.write(to: transcriptURL(for: transcript.recordingID), options: .atomic)
        } catch {
            // The original recording is never modified by transcript persistence.
        }
    }

    private func loadPersistedTranscripts() {
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: RecorderStore.recordingsDirectory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        for url in urls where url.lastPathComponent.hasSuffix(".lectureai-transcript.json") {
            guard let data = try? Data(contentsOf: url),
                  var transcript = try? decoder.decode(NativeLectureTranscript.self, from: data) else { continue }

            var migrated = false
            if transcript.state == .preparing || transcript.state == .transcribing {
                transcript.state = .idle
                transcript.progress = 0
                transcript.statusMessage = "Interrupted transcription recovered · original audio is ready to retry"
                migrated = true
            }

            let cleanedSegments = transcript.segments.compactMap { segment -> NativeTranscriptSegment? in
                let cleaned = WhisperTextSanitizer.cleanInline(segment.text)
                guard !cleaned.isEmpty else { return nil }
                if cleaned != segment.text { migrated = true }
                return NativeTranscriptSegment(
                    id: segment.id,
                    startTime: segment.startTime,
                    endTime: segment.endTime,
                    text: cleaned
                )
            }
            if cleanedSegments.count != transcript.segments.count { migrated = true }
            transcript.segments = cleanedSegments

            if let englishText = transcript.englishText {
                let cleaned = WhisperTextSanitizer.cleanMultiline(englishText)
                if cleaned != englishText { migrated = true }
                transcript.englishText = cleaned.isEmpty ? nil : cleaned
            }
            if let arabicText = transcript.arabicText {
                let cleaned = WhisperTextSanitizer.cleanMultiline(arabicText)
                if cleaned != arabicText { migrated = true }
                transcript.arabicText = cleaned.isEmpty ? nil : cleaned
            }
            let cleanedNotes = WhisperTextSanitizer.cleanMultiline(transcript.notes)
            if cleanedNotes != transcript.notes {
                transcript.notes = cleanedNotes
                migrated = true
            }

            transcripts[transcript.recordingID] = transcript
            if migrated { persist(transcript) }
        }
    }

    private func transcriptURL(for recordingID: UUID) -> URL {
        RecorderStore.recordingsDirectory
            .appendingPathComponent(recordingID.uuidString)
            .appendingPathExtension("lectureai-transcript.json")
    }
}

private enum NativeTranscriptionError: LocalizedError {
    case emptyTranscript

    var errorDescription: String? {
        switch self {
        case .emptyTranscript:
            return "The speech model completed but did not return usable speech. Check the recording and retry."
        }
    }
}
