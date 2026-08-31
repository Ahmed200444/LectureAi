import Foundation

enum NativeTranslationChunker {
    static let defaultMaxCharacters = 2_800

    static func chunks(
        from segments: [NativeTranscriptSegment],
        maxCharacters: Int = defaultMaxCharacters
    ) -> [String] {
        guard maxCharacters > 0 else { return [] }

        let texts = segments
            .map(\.text)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        var result: [String] = []
        var current = ""

        func flushCurrent() {
            let cleaned = current.trimmingCharacters(in: .whitespacesAndNewlines)
            if !cleaned.isEmpty { result.append(cleaned) }
            current = ""
        }

        func appendPiece(_ piece: String) {
            guard !piece.isEmpty else { return }
            if current.isEmpty {
                current = piece
            } else if current.count + 1 + piece.count <= maxCharacters {
                current += " " + piece
            } else {
                flushCurrent()
                current = piece
            }
        }

        for text in texts {
            if text.count <= maxCharacters {
                appendPiece(text)
                continue
            }

            for piece in splitOversizedText(text, maxCharacters: maxCharacters) {
                appendPiece(piece)
            }
        }

        flushCurrent()
        return result
    }

    private static func splitOversizedText(_ text: String, maxCharacters: Int) -> [String] {
        let words = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard !words.isEmpty else { return [] }

        var pieces: [String] = []
        var current = ""

        func flush() {
            if !current.isEmpty { pieces.append(current) }
            current = ""
        }

        for word in words {
            if word.count > maxCharacters {
                flush()
                var remainder = word[...]
                while !remainder.isEmpty {
                    let end = remainder.index(remainder.startIndex, offsetBy: min(maxCharacters, remainder.count))
                    pieces.append(String(remainder[..<end]))
                    remainder = remainder[end...]
                }
                continue
            }

            if current.isEmpty {
                current = word
            } else if current.count + 1 + word.count <= maxCharacters {
                current += " " + word
            } else {
                flush()
                current = word
            }
        }

        flush()
        return pieces
    }
}
