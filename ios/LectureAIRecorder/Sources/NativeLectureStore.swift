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

        let config = WhisperKitConfig(
            verbose: false,
            prewarm: true,
            load: false,
            download: true,
            useBackgroundDownloadSession: true
        )
        let pipe = try await WhisperKit(config)

        do {
            try Task.checkCancellation()

            // iOS 26 safety: v1.1.0 contains the upstream bounds-check fix for the
            // negative suppression-token sentinel. Keep the suppression list explicitly
            // empty as an additional defense and to avoid mutating logits for this app.
            let decodeOptions = DecodingOptions(
                task: .transcribe,
                language: nil,
                usePrefillPrompt: true,
                detectLanguage: true,
                wordTimestamps: false,
                suppressBlank: false,
                suppressTokens: [],
                concurrentWorkerCount: 1,
                chunkingStrategy: .vad
            )

            // v1.1.0 incremental loading keeps long lecture audio bounded instead of
            // decoding a multi-hour recording into one in-memory Float array.
            let audioOptions = AudioInputOptions(
                channelMode: .sumChannels(nil),
                audioLoadingMode: .incremental
            )

            let results = try await pipe.transcribe(
                audioPath: audioURL.path,
                audioInputOptions: audioOptions,
                decodeOptions: decodeOptions
            )

            try Task.checkCancellation()

            let segments = results
                .flatMap(\.segments)
                .filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                .map { segment in
                    NativeTranscriptSegment(
                        startTime: Double(segment.start),
                        endTime: Double(segment.end),
                        text: segment.text
                    )
                }
                .sorted { lhs, rhs in
                    lhs.startTime == rhs.startTime ? lhs.endTime < rhs.endTime : lhs.startTime < rhs.startTime
                }

            let fallbackText = results
                .map(\.text)
                .joined(separator: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)

            let finalSegments: [NativeTranscriptSegment]
            if segments.isEmpty, !fallbackText.isEmpty {
                finalSegments = [NativeTranscriptSegment(startTime: 0, endTime: 0, text: fallbackText)]
            } else {
                finalSegments = segments
            }

            guard !finalSegments.isEmpty else {
                throw NativeTranscriptionError.emptyTranscript
            }

            let language = results
                .map(\.language)
                .first(where: { !$0.isEmpty }) ?? "unknown"
            let model = pipe.modelFolder?.lastPathComponent ?? pipe.modelVariant.description

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

        activeRecordingID = recording.id
        var record = transcript(for: recording.id)
        record.updatedAt = Date()
        record.state = .preparing
        record.statusMessage = "Preparing the device-recommended multilingual Whisper model…"
        record.progress = 0.12
        record.lastError = nil
        transcripts[recording.id] = record
        persist(record)

        do {
            record.state = .transcribing
            record.statusMessage = "Transcribing saved audio locally with automatic language detection…"
            record.progress = 0.42
            transcripts[recording.id] = record
            persist(record)

            let output = try await engine.transcribe(audioURL: recording.audioURL)

            record.updatedAt = Date()
            record.state = .done
            record.statusMessage = "Native on-device transcription complete"
            record.progress = 1
            record.modelName = output.modelName
            record.detectedLanguage = output.detectedLanguage
            record.segments = output.segments
            record.englishText = output.detectedLanguage.lowercased().hasPrefix("en") ? output.segments.map(\.text).joined(separator: " ") : nil
            record.arabicText = output.detectedLanguage.lowercased().hasPrefix("ar") ? output.segments.map(\.text).joined(separator: " ") : nil
            record.notes = NativeNotesGenerator.generate(segments: output.segments, marks: recording.marks)
            record.lastError = nil
            transcripts[recording.id] = record
            persist(record)
        } catch is CancellationError {
            record.updatedAt = Date()
            record.state = .idle
            record.statusMessage = "Transcription cancelled · original audio remains saved"
            record.progress = 0
            transcripts[recording.id] = record
            persist(record)
        } catch {
            fail(recordingID: recording.id, message: error.localizedDescription)
        }

        activeRecordingID = nil
    }

    func saveTranslation(recordingID: UUID, languageCode: String, text: String) {
        var record = transcript(for: recordingID)
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
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
            if transcript.state == .preparing || transcript.state == .transcribing {
                transcript.state = .idle
                transcript.progress = 0
                transcript.statusMessage = "Interrupted transcription recovered · original audio is ready to retry"
            }
            transcripts[transcript.recordingID] = transcript
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
