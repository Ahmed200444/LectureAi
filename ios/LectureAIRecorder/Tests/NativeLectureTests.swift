import AVFoundation
import WhisperKit
import XCTest
@testable import LectureAIRecorder

final class NativeLectureTests: XCTestCase {
    func testRecommendedWhisperModelIsMultilingual() {
        let model = WhisperKit.recommendedModels().default.lowercased()
        XCTAssertFalse(model.contains(".en"), "LectureAI must never default to an English-only Whisper model: \(model)")
    }

    func testWhisperControlTokensAreRemovedFromInlineTranscriptText() {
        let raw = "<|startoftranscript|><|en|><|transcribe|><|0.00|> [ Inaudible Remark ] <|25.00|><|endoftext|>"
        let cleaned = WhisperTextSanitizer.cleanInline(raw)

        XCTAssertEqual(cleaned, "[ Inaudible Remark ]")
        XCTAssertFalse(WhisperTextSanitizer.containsControlTokens(cleaned))
        XCTAssertFalse(cleaned.contains("<|"))
    }

    func testWhisperControlTokensAreRemovedWithoutDestroyingMultilineText() {
        let raw = "<|startoftranscript|><|ar|><|transcribe|>السطر الأول\n\n<|12.00|>السطر الثاني<|endoftext|>"
        let cleaned = WhisperTextSanitizer.cleanMultiline(raw)

        XCTAssertTrue(cleaned.contains("السطر الأول"))
        XCTAssertTrue(cleaned.contains("السطر الثاني"))
        XCTAssertTrue(cleaned.contains("\n\n"))
        XCTAssertFalse(cleaned.contains("<|"))
    }

    func testTranslationBatchesNeverContainWhisperControlTokens() {
        let segments = [
            NativeTranscriptSegment(
                startTime: 0,
                endTime: 5,
                text: "<|startoftranscript|><|en|><|transcribe|><|0.00|> The derivative measures change. <|5.00|>"
            ),
            NativeTranscriptSegment(
                startTime: 5,
                endTime: 10,
                text: "<|ar|><|5.00|> المشتقة تقيس معدل التغير <|10.00|><|endoftext|>"
            )
        ]

        let batches = NativeTranslationChunker.batches(from: segments, maxCharacters: 500)

        XCTAssertFalse(batches.isEmpty)
        XCTAssertTrue(batches.allSatisfy { !$0.text.contains("<|") && !$0.text.contains("|>") })
        XCTAssertTrue(batches.map(\.text).joined(separator: " ").contains("derivative"))
        XCTAssertTrue(batches.map(\.text).joined(separator: " ").contains("المشتقة"))
    }

    func testNotesNeverReceiveWhisperControlTokensAfterSanitization() {
        let raw = "<|startoftranscript|><|en|><|transcribe|><|0.00|> Important: remember the chain rule. <|8.00|><|endoftext|>"
        let segments = [
            NativeTranscriptSegment(
                startTime: 0,
                endTime: 8,
                text: WhisperTextSanitizer.cleanInline(raw)
            )
        ]

        let notes = NativeNotesGenerator.generate(segments: segments, marks: [])

        XCTAssertTrue(notes.contains("chain rule"))
        XCTAssertFalse(notes.contains("<|"))
        XCTAssertFalse(notes.contains("startoftranscript"))
    }

    func testNotesStayGroundedInTranscriptAndMarks() {
        let segments = [
            NativeTranscriptSegment(startTime: 0, endTime: 4, text: "A derivative measures the rate of change."),
            NativeTranscriptSegment(startTime: 4, endTime: 9, text: "Important: remember the chain rule for the exam."),
            NativeTranscriptSegment(startTime: 9, endTime: 14, text: "For example, differentiate the outside function first.")
        ]
        let marks = [RecordingMark(id: UUID(), time: 5)]

        let notes = NativeNotesGenerator.generate(segments: segments, marks: marks)

        XCTAssertTrue(notes.contains("derivative"))
        XCTAssertTrue(notes.contains("chain rule"))
        XCTAssertTrue(notes.contains("Marked moment [00:05]"))
        XCTAssertTrue(notes.contains("not a claim that the professor said they will be on an exam"))
    }

    func testArabicKeywordsAreAccepted() {
        let segments = [
            NativeTranscriptSegment(startTime: 0, endTime: 5, text: "هذا مثال مهم لفهم الخوارزمية"),
            NativeTranscriptSegment(startTime: 5, endTime: 10, text: "الخوارزمية تساعد في حل المشكلة")
        ]

        let notes = NativeNotesGenerator.generate(segments: segments, marks: [])

        XCTAssertTrue(notes.contains("الخوارزمية"))
        XCTAssertTrue(notes.contains("EXAMPLES"))
    }

    func testTranscriptOriginalTextPreservesSegmentOrder() {
        let id = UUID()
        let transcript = NativeLectureTranscript(
            recordingID: id,
            updatedAt: Date(),
            state: .done,
            statusMessage: "done",
            progress: 1,
            modelName: "test-model",
            detectedLanguage: "en",
            segments: [
                NativeTranscriptSegment(startTime: 0, endTime: 1, text: "Hello"),
                NativeTranscriptSegment(startTime: 1, endTime: 2, text: "world")
            ],
            englishText: nil,
            arabicText: nil,
            notes: "",
            lastError: nil
        )

        XCTAssertEqual(transcript.originalText, "Hello world")
    }

    func testTimestampFormattingSupportsLongLectures() {
        XCTAssertEqual(NativeNotesGenerator.timestamp(65), "01:05")
        XCTAssertEqual(NativeNotesGenerator.timestamp(3_661), "1:01:01")
    }

    func testLongLectureNotesCoverBeginningAndEnd() {
        var segments: [NativeTranscriptSegment] = []
        segments.reserveCapacity(80)

        for index in 0..<80 {
            let startTime = Double(index) * 30
            let endTime = startTime + 20
            let text = "Lecture segment \(index) concept"
            segments.append(
                NativeTranscriptSegment(
                    startTime: startTime,
                    endTime: endTime,
                    text: text
                )
            )
        }

        let notes = NativeNotesGenerator.generate(segments: segments, marks: [])

        XCTAssertTrue(notes.contains("Lecture segment 0 concept"))
        XCTAssertTrue(notes.contains("Lecture segment 79 concept"))
    }

    func testTranslationBatchingIsBoundedAndPreservesOrder() {
        let segments = [
            NativeTranscriptSegment(startTime: 0, endTime: 1, text: "alpha beta gamma delta"),
            NativeTranscriptSegment(startTime: 1, endTime: 2, text: "epsilon zeta eta theta"),
            NativeTranscriptSegment(startTime: 2, endTime: 3, text: "iota kappa lambda mu")
        ]

        let batches = NativeTranslationChunker.batches(from: segments, maxCharacters: 24)

        XCTAssertFalse(batches.isEmpty)
        XCTAssertTrue(batches.allSatisfy { $0.text.count <= 24 })
        XCTAssertEqual(batches.map(\.text).joined(separator: " "), segments.map(\.text).joined(separator: " "))
    }

    func testTranslationBatcherSplitsSingleOversizedSegment() {
        let text = Array(repeating: "word", count: 30).joined(separator: " ")
        let segments = [NativeTranscriptSegment(startTime: 0, endTime: 5, text: text)]

        let batches = NativeTranslationChunker.batches(from: segments, maxCharacters: 20)

        XCTAssertTrue(batches.count > 1)
        XCTAssertTrue(batches.allSatisfy { $0.text.count <= 20 })
        XCTAssertEqual(batches.map(\.text).joined(separator: " "), text)
    }

    func testTranslationBatcherSeparatesEnglishAndArabic() {
        let segments = [
            NativeTranscriptSegment(startTime: 0, endTime: 3, text: "The derivative measures change over time."),
            NativeTranscriptSegment(startTime: 3, endTime: 6, text: "المشتقة تقيس معدل التغير مع الزمن"),
            NativeTranscriptSegment(startTime: 6, endTime: 9, text: "Now we return to the English explanation.")
        ]

        let batches = NativeTranslationChunker.batches(from: segments, maxCharacters: 500)

        XCTAssertEqual(batches.count, 3)
        XCTAssertEqual(batches[0].sourceLanguageCode, "en")
        XCTAssertEqual(batches[1].sourceLanguageCode, "ar")
        XCTAssertEqual(batches[2].sourceLanguageCode, "en")
    }

    func testAudioPreparerConvertsStereo48kToTemporary16kMono() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("LectureAI-AudioPreparer-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let sourceURL = directory.appendingPathComponent("stereo-48k.wav")
        guard let sourceFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 48_000,
            channels: 2,
            interleaved: false
        ) else {
            XCTFail("Could not create source audio format")
            return
        }

        let frameCount: AVAudioFrameCount = 48_000
        guard let buffer = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: frameCount),
              let channels = buffer.floatChannelData else {
            XCTFail("Could not allocate source audio buffer")
            return
        }
        buffer.frameLength = frameCount

        for frame in 0..<Int(frameCount) {
            let phase = 2 * Double.pi * 440 * Double(frame) / 48_000
            let sample = Float(sin(phase) * 0.2)
            channels[0][frame] = sample
            channels[1][frame] = sample * 0.8
        }

        do {
            let sourceFile = try AVAudioFile(
                forWriting: sourceURL,
                settings: sourceFormat.settings,
                commonFormat: .pcmFormatFloat32,
                interleaved: false
            )
            try sourceFile.write(from: buffer)
            if #available(iOS 18.0, *) {
                sourceFile.close()
            }
        }

        let finalizedSource = try AVAudioFile(forReading: sourceURL)
        let sourceDuration = Double(finalizedSource.length) / finalizedSource.processingFormat.sampleRate
        XCTAssertEqual(sourceDuration, 1.0, accuracy: 0.05)

        let prepared = try TranscriptionAudioPreparer.prepare(sourceURL: sourceURL)
        defer { TranscriptionAudioPreparer.cleanup(prepared) }

        XCTAssertTrue(prepared.isTemporary)
        XCTAssertNotEqual(prepared.url, sourceURL)
        XCTAssertTrue(FileManager.default.fileExists(atPath: prepared.url.path))

        let converted = try AVAudioFile(forReading: prepared.url)
        XCTAssertEqual(converted.processingFormat.sampleRate, 16_000, accuracy: 1)
        XCTAssertEqual(converted.processingFormat.channelCount, 1)

        let convertedDuration = Double(converted.length) / converted.processingFormat.sampleRate
        XCTAssertEqual(convertedDuration, 1.0, accuracy: 0.05)

        let framesToInspect = AVAudioFrameCount(min(converted.length, 16_000))
        guard framesToInspect > 0,
              let convertedBuffer = AVAudioPCMBuffer(
                pcmFormat: converted.processingFormat,
                frameCapacity: framesToInspect
              ) else {
            XCTFail("Could not allocate converted-audio verification buffer")
            return
        }
        try converted.read(into: convertedBuffer, frameCount: framesToInspect)
        guard convertedBuffer.frameLength > 0,
              let convertedChannels = convertedBuffer.floatChannelData else {
            XCTFail("Converted transcription audio could not be decoded for verification")
            return
        }

        let samples = convertedChannels[0]
        let inspectedFrames = Int(convertedBuffer.frameLength)
        var squareSum = 0.0
        var positiveZeroCrossings = 0
        var previousSample = samples[0]

        for frame in 0..<inspectedFrames {
            let sample = samples[frame]
            squareSum += Double(sample * sample)
            if frame > 0, previousSample <= 0, sample > 0 {
                positiveZeroCrossings += 1
            }
            previousSample = sample
        }

        let rms = sqrt(squareSum / Double(inspectedFrames))
        XCTAssertGreaterThan(rms, 0.02, "Converted transcription audio must retain a clearly non-silent signal")

        let inspectedDuration = Double(inspectedFrames) / converted.processingFormat.sampleRate
        let estimatedFrequency = Double(positiveZeroCrossings) / inspectedDuration
        XCTAssertEqual(estimatedFrequency, 440, accuracy: 10, "Sample-rate conversion must preserve the source audio pitch")
    }
}
