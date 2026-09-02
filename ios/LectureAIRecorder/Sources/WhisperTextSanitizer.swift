import Foundation

enum WhisperTextSanitizer {
    private static let controlTokenPattern = #"<\|[^<>|]*\|>"#
    private static let controlTokenRegex = try? NSRegularExpression(pattern: controlTokenPattern)
    private static let inlineWhitespaceRegex = try? NSRegularExpression(pattern: #"\s+"#)
    private static let horizontalWhitespaceRegex = try? NSRegularExpression(pattern: #"[\t\u{00A0} ]+"#)

    static func containsControlTokens(_ text: String) -> Bool {
        guard let controlTokenRegex else { return false }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return controlTokenRegex.firstMatch(in: text, range: range) != nil
    }

    static func cleanInline(_ text: String) -> String {
        let withoutTokens = removeControlTokens(from: text)
        guard let inlineWhitespaceRegex else {
            return withoutTokens.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let range = NSRange(withoutTokens.startIndex..<withoutTokens.endIndex, in: withoutTokens)
        let collapsed = inlineWhitespaceRegex.stringByReplacingMatches(
            in: withoutTokens,
            range: range,
            withTemplate: " "
        )
        return collapsed.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func cleanMultiline(_ text: String) -> String {
        let withoutTokens = removeControlTokens(from: text)
        let lines = withoutTokens
            .components(separatedBy: .newlines)
            .map { line -> String in
                guard let horizontalWhitespaceRegex else {
                    return line.trimmingCharacters(in: .whitespaces)
                }
                let range = NSRange(line.startIndex..<line.endIndex, in: line)
                return horizontalWhitespaceRegex
                    .stringByReplacingMatches(in: line, range: range, withTemplate: " ")
                    .trimmingCharacters(in: .whitespaces)
            }

        var output: [String] = []
        output.reserveCapacity(lines.count)
        var previousWasBlank = false
        for line in lines {
            let isBlank = line.isEmpty
            if isBlank && previousWasBlank { continue }
            output.append(line)
            previousWasBlank = isBlank
        }
        return output.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func removeControlTokens(from text: String) -> String {
        guard let controlTokenRegex else { return text }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return controlTokenRegex.stringByReplacingMatches(in: text, range: range, withTemplate: " ")
    }
}
