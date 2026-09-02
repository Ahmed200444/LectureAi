import Foundation

struct NativeTranscriptSegment: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let startTime: Double
    let endTime: Double
    let text: String

    init(id: UUID = UUID(), startTime: Double, endTime: Double, text: String) {
        self.id = id
        self.startTime = startTime
        self.endTime = endTime
        self.text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum NativeNotesGenerator {
    private static let stopWords: Set<String> = [
        "about", "after", "again", "because", "before", "being", "could", "every", "first", "from", "going", "have", "into", "just", "more", "most", "that", "their", "there", "these", "they", "this", "through", "using", "very", "what", "when", "where", "which", "with", "would",
        "احنا", "إحنا", "اللي", "يعني", "عشان", "كده", "ده", "دي", "طيب", "تمام", "مثلاً", "هنا", "على", "إلى", "في", "من", "هو", "هي"
    ]

    static func generate(segments: [NativeTranscriptSegment], marks: [RecordingMark]) -> String {
        let useful = segments.filter { !$0.text.isEmpty }
        guard !useful.isEmpty else {
            return "Transcribe the lecture to generate source-grounded notes."
        }

        let summary = useful.prefix(3).map(\.text).joined(separator: " ")
        let keywords = extractKeywords(from: useful)
        let definitions = useful.filter {
            containsAny($0.text, terms: [" means ", " defined as ", " refers to ", " يعني ", " هو ", " هي "])
        }.prefix(5)
        let examples = useful.filter {
            containsAny($0.text, terms: ["example", "for instance", "مثال", "مثلاً"])
        }.prefix(5)
        let important = useful.filter {
            containsAny($0.text, terms: ["important", "remember", "exam", "key", "مهم", "خدوا بالكم"])
        }.prefix(5)
        let technical = useful.filter {
            containsAny($0.text, terms: ["equation", "formula", "algorithm", "function", "derivative", "integral", "معادلة", "خوارزمية"])
                || $0.text.rangeOfCharacter(from: CharacterSet(charactersIn: "=+−*/^")) != nil
        }.prefix(5)
        let detailed = representativeSegments(useful, limit: 24)

        var sections: [String] = []
        sections.append("LECTURE SUMMARY\n\(summary)")
        sections.append("DETAILED LECTURE NOTES\n" + detailed.map(noteLine).joined(separator: "\n"))
        sections.append("KEY CONCEPTS\n" + (keywords.isEmpty ? "No strong recurring concepts were detected." : keywords.map { "• \($0)" }.joined(separator: "\n")))
        sections.append("DEFINITIONS\n" + listOrEmpty(definitions.map(noteLine), empty: "No explicit definitions were detected."))
        sections.append("EXAMPLES\n" + listOrEmpty(examples.map(noteLine), empty: "No explicit examples were detected."))
        sections.append("FORMULAS / TECHNICAL INFORMATION\n" + listOrEmpty(technical.map(noteLine), empty: "No explicit formulas or technical expressions were detected."))

        let markLines = marks.map { "• Marked moment [\(timestamp($0.time))]" }
        let importantLines = important.map(noteLine)
        sections.append("IMPORTANT PROFESSOR NOTES\n" + listOrEmpty(markLines + importantLines, empty: "No marked or explicit emphasis was detected."))

        let review = keywords.prefix(5).map { "• Review \($0) and explain it using the lecture recording." }
        sections.append("POSSIBLE EXAM REVIEW TOPICS\nLectureAI suggests reviewing these topics; this is not a claim that the professor said they will be on an exam.\n" + listOrEmpty(review, empty: "Review the main lecture ideas."))

        let questions = keywords.prefix(5).map { "• How would you explain \($0) in your own words?" }
        sections.append("STUDY QUESTIONS\n" + listOrEmpty(questions, empty: "• What was the central idea of this lecture?"))

        return sections.joined(separator: "\n\n")
    }

    private static func representativeSegments(_ segments: [NativeTranscriptSegment], limit: Int) -> [NativeTranscriptSegment] {
        guard limit > 0, !segments.isEmpty else { return [] }
        guard segments.count > limit else { return segments }
        guard limit > 1 else { return [segments[0]] }

        var indices = Set<Int>()
        for slot in 0..<limit {
            let fraction = Double(slot) / Double(limit - 1)
            let index = Int((fraction * Double(segments.count - 1)).rounded())
            indices.insert(min(segments.count - 1, max(0, index)))
        }
        return indices.sorted().map { segments[$0] }
    }

    private static func noteLine(_ segment: NativeTranscriptSegment) -> String {
        "• \(segment.text) [\(timestamp(segment.startTime))]"
    }

    private static func extractKeywords(from segments: [NativeTranscriptSegment]) -> [String] {
        var counts: [String: Int] = [:]
        // ICU Unicode properties keep key-concept extraction useful for scripts beyond
        // Latin and Arabic (Greek, Cyrillic, accented European text, Indic scripts, etc.).
        let expression = try? NSRegularExpression(pattern: "[\\p{L}][\\p{L}\\p{M}\\p{N}-]{2,}")

        for segment in segments {
            let text = segment.text as NSString
            let range = NSRange(location: 0, length: text.length)
            expression?.enumerateMatches(in: segment.text, range: range) { match, _, _ in
                guard let match else { return }
                let word = text.substring(with: match.range).lowercased()
                guard !stopWords.contains(word) else { return }
                counts[word, default: 0] += 1
            }
        }

        return counts
            .sorted { lhs, rhs in
                lhs.value == rhs.value ? lhs.key < rhs.key : lhs.value > rhs.value
            }
            .prefix(7)
            .map(\.key)
    }

    private static func containsAny(_ text: String, terms: [String]) -> Bool {
        let value = " \(text.lowercased()) "
        return terms.contains { value.contains($0.lowercased()) }
    }

    private static func listOrEmpty<S: Sequence>(_ lines: S, empty: String) -> String where S.Element == String {
        let values = Array(lines)
        return values.isEmpty ? empty : values.joined(separator: "\n")
    }

    static func timestamp(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded(.down)))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, secs)
            : String(format: "%02d:%02d", minutes, secs)
    }
}
