import XCTest
@testable import LectureAIRecorder

final class NativeLectureTests: XCTestCase {
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
        let segments = (0..<80).map { index in
            NativeTranscriptSegment(
                startTime: Double(index * 30),
                endTime: Double(index * 30 + 20),
                text: "Lecture segment \(index) concept"
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
}
