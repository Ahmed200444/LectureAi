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
}
