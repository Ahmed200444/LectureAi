import XCTest
@testable import LectureAIRecorder

final class LanguagePriorityTests: XCTestCase {
    func testEnglishIsHighestPriorityLockedLanguage() {
        XCTAssertEqual(
            NativeTranscriptionEngine.priorityLockedLanguage(for: Set(["en"])),
            "en"
        )
    }

    func testArabicIsSecondPriorityLockedLanguage() {
        XCTAssertEqual(
            NativeTranscriptionEngine.priorityLockedLanguage(for: Set(["ar"])),
            "ar"
        )
    }

    func testMixedEnglishArabicStaysMultilingual() {
        XCTAssertNil(
            NativeTranscriptionEngine.priorityLockedLanguage(for: Set(["en", "ar"]))
        )
    }

    func testOtherLanguagesStayMultilingual() {
        XCTAssertNil(
            NativeTranscriptionEngine.priorityLockedLanguage(for: Set(["fr"]))
        )
    }

    func testUnknownLanguageStaysMultilingual() {
        XCTAssertNil(
            NativeTranscriptionEngine.priorityLockedLanguage(for: Set<String>())
        )
    }
}
