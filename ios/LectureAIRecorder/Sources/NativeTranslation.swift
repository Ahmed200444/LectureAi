import Foundation
import NaturalLanguage

struct NativeTranslationBatch: Hashable, Sendable {
    let text: String
    let sourceLanguageCode: String?
}

enum NativeTranslationChunker {
    static let defaultMaxCharacters = 2_800
    private static let minimumLanguageConfidence = 0.60

    static func batches(
        from segments: [NativeTranscriptSegment],
        maxCharacters: Int = defaultMaxCharacters
    ) -> [NativeTranslationBatch] {
        guard maxCharacters > 0 else { return [] }

        var result: [NativeTranslationBatch] = []
        var currentText = ""
        var currentLanguage: String?

        func flushCurrent() {
            let cleaned = WhisperTextSanitizer.cleanInline(currentText)
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
            let cleaned = WhisperTextSanitizer.cleanInline(piece)
            guard !cleaned.isEmpty else { return }

            // Keep unknown-language text isolated. Apple's Translation framework allows
            // auto-detection when source=nil, but every string in that session must still
            // be the same source language. One unknown batch per session avoids mixing.
            guard let languageCode else {
                flushCurrent()
                result.append(NativeTranslationBatch(text: cleaned, sourceLanguageCode: nil))
                return
            }

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
            let text = WhisperTextSanitizer.cleanInline(segment.text)
            guard !text.isEmpty else { continue }

            let languageCode = confidentLanguageCode(for: text)
            if text.count <= maxCharacters {
                appendPiece(text, languageCode: languageCode)
                continue
            }

            for piece in splitOversizedText(text, maxCharacters: maxCharacters) {
                appendPiece(piece, languageCode: confidentLanguageCode(for: piece) ?? languageCode)
            }
        }

        flushCurrent()
        return result
    }

    private static func confidentLanguageCode(for text: String) -> String? {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        guard let best = recognizer.languageHypotheses(withMaximum: 1).max(by: { $0.value < $1.value }),
              best.value >= minimumLanguageConfidence else {
            return nil
        }
        return best.key.rawValue.lowercased()
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
