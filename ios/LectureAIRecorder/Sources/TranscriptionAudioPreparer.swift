import AVFoundation
import Foundation

struct PreparedTranscriptionAudio: Sendable {
    let url: URL
    let isTemporary: Bool
}

enum TranscriptionAudioPreparer {
    private static let sampleRate = 16_000.0
    private static let outputChannels: AVAudioChannelCount = 1
    private static let minimumReserveBytes: Int64 = 100 * 1024 * 1024

    static func prepare(sourceURL: URL) throws -> PreparedTranscriptionAudio {
        let sourceFile = try AVAudioFile(forReading: sourceURL)
        let sourceFormat = sourceFile.processingFormat

        if sourceURL.pathExtension.lowercased() == "wav",
           abs(sourceFormat.sampleRate - sampleRate) < 1,
           sourceFormat.channelCount == outputChannels {
            return PreparedTranscriptionAudio(url: sourceURL, isTemporary: false)
        }

        let duration = sourceFormat.sampleRate > 0
            ? Double(sourceFile.length) / sourceFormat.sampleRate
            : 0
        try ensureTemporaryStorage(forDuration: duration)

        let directory = temporaryDirectory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let outputURL = directory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("wav")
        try? FileManager.default.removeItem(at: outputURL)

        do {
            try convertToWhisperSafeWAV(sourceFile: sourceFile, outputURL: outputURL)
            return PreparedTranscriptionAudio(url: outputURL, isTemporary: true)
        } catch {
            try? FileManager.default.removeItem(at: outputURL)
            throw error
        }
    }

    static func cleanup(_ prepared: PreparedTranscriptionAudio) {
        guard prepared.isTemporary else { return }
        try? FileManager.default.removeItem(at: prepared.url)
    }

    static func removeAbandonedTemporaryFiles() {
        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: temporaryDirectory,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        let cutoff = Date().addingTimeInterval(-24 * 60 * 60)
        for url in urls {
            let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            if modified < cutoff {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    private static func convertToWhisperSafeWAV(sourceFile: AVAudioFile, outputURL: URL) throws {
        let inputFormat = sourceFile.processingFormat
        guard let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: sampleRate,
            channels: outputChannels,
            interleaved: true
        ) else {
            throw AudioPreparationError.couldNotCreateOutputFormat
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            throw AudioPreparationError.couldNotCreateConverter
        }

        let outputFile = try AVAudioFile(
            forWriting: outputURL,
            settings: outputFormat.settings,
            commonFormat: .pcmFormatInt16,
            interleaved: true
        )

        let outputFrameCapacity: AVAudioFrameCount = 32_768
        var reachedEnd = false
        var readError: Error?

        while !reachedEnd {
            try Task.checkCancellation()

            guard let outputBuffer = AVAudioPCMBuffer(
                pcmFormat: outputFormat,
                frameCapacity: outputFrameCapacity
            ) else {
                throw AudioPreparationError.couldNotAllocateBuffer
            }

            var converterError: NSError?
            let status = converter.convert(to: outputBuffer, error: &converterError) { requestedPackets, inputStatus in
                if sourceFile.framePosition >= sourceFile.length {
                    reachedEnd = true
                    inputStatus.pointee = .endOfStream
                    return nil
                }

                let requestedFrames = max(1, AVAudioFrameCount(requestedPackets))
                guard let inputBuffer = AVAudioPCMBuffer(
                    pcmFormat: inputFormat,
                    frameCapacity: requestedFrames
                ) else {
                    inputStatus.pointee = .noDataNow
                    return nil
                }

                do {
                    try sourceFile.read(into: inputBuffer, frameCount: requestedFrames)
                } catch {
                    readError = error
                    reachedEnd = true
                    inputStatus.pointee = .endOfStream
                    return nil
                }

                if inputBuffer.frameLength == 0 {
                    reachedEnd = true
                    inputStatus.pointee = .endOfStream
                    return nil
                }

                inputStatus.pointee = .haveData
                return inputBuffer
            }

            if let readError { throw readError }
            if let converterError { throw converterError }
            if outputBuffer.frameLength > 0 {
                try outputFile.write(from: outputBuffer)
            }

            switch status {
            case .haveData, .inputRanDry:
                continue
            case .endOfStream:
                reachedEnd = true
            case .error:
                throw AudioPreparationError.conversionFailed
            @unknown default:
                throw AudioPreparationError.conversionFailed
            }
        }
    }

    private static func ensureTemporaryStorage(forDuration duration: TimeInterval) throws {
        // 16 kHz × 16-bit × mono ~= 32 KB/s plus a small WAV/container margin.
        let estimatedBytes = Int64(max(0, duration) * 32_000) + 8 * 1024 * 1024
        let attributes = try FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory())
        let freeBytes = (attributes[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
        guard freeBytes == 0 || freeBytes > estimatedBytes + minimumReserveBytes else {
            throw AudioPreparationError.insufficientStorage
        }
    }

    private static var temporaryDirectory: URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("LectureAI Transcription Audio", isDirectory: true)
    }
}

private enum AudioPreparationError: LocalizedError {
    case couldNotCreateOutputFormat
    case couldNotCreateConverter
    case couldNotAllocateBuffer
    case conversionFailed
    case insufficientStorage

    var errorDescription: String? {
        switch self {
        case .couldNotCreateOutputFormat:
            return "LectureAI could not create the safe 16 kHz transcription format."
        case .couldNotCreateConverter:
            return "This recording format could not be prepared for local transcription."
        case .couldNotAllocateBuffer:
            return "The device could not allocate a small audio conversion buffer."
        case .conversionFailed:
            return "The temporary transcription-audio conversion failed. The original recording is unchanged."
        case .insufficientStorage:
            return "There is not enough free storage to prepare this lecture for transcription while keeping a safety reserve."
        }
    }
}
