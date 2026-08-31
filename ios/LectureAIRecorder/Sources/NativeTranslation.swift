import Foundation
import NaturalLanguage

struct NativeTranslationBatch: Hashable, Sendable {
    let text: String
    let sourceLanguageCode: String?
}

enum NativeTranslationChunker {
    static let defaultMaxCharacters = 2_800

    static func batches(
        from segments: [NativeTranscriptSegment],
        maxCharacters: Int = defaultMaxCharacters
    ) -> [NativeTranslationBatch] {
        guard maxCharacters > 0 else { return [] }

        var result: [NativeTranslationBatch] = []
        var currentText = ""
        var currentLanguage: String?

        func flushCurrent() {
            let cleaned = currentText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !cleaned.isEmpty {
                result.append(
                    NativeTranslationBatch(
                        text: cleaned,
                        sourceLanguageCode: currentLanguage
                    )
                )
            }
            currentText = ""
            currentLanguage = nil
        }

        func appendPiece(_ piece: String, languageCode: String?) {
            let cleaned = piece.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cleaned.isEmpty else { return }

            let sameLanguage = currentText.isEmpty || currentLanguage == languageCode
            let fits = currentText.isEmpty || currentText.count + 1 + cleaned.count <= maxCharacters

            if !sameLanguage || !fits {
                flushCurrent()
            }

            if currentText.isEmpty {
                currentText = cleaned
                currentLanguage = languageCode
            } else {
                currentText += " " + cleaned
            }
        }

        for segment in segments {
            let text = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }

            let languageCode = dominantLanguageCode(for: text)
            if text.count <= maxCharacters {
                appendPiece(text, languageCode: languageCode)
                continue
            }

            for piece in splitOversizedText(text, maxCharacters: maxCharacters) {
                appendPiece(piece, languageCode: dominantLanguageCode(for: piece) ?? languageCode)
            }
        }

        flushCurrent()
        return result
    }

    private static func dominantLanguageCode(for text: String) -> String? {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        return recognizer.dominantLanguage?.rawValue.lowercased()
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
