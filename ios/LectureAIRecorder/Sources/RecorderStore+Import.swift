import AVFoundation
import Foundation

extension RecorderStore {
    @MainActor
    func importRecording(from sourceURL: URL) async {
        guard state != .recording && state != .paused && state != .interrupted else {
            statusMessage = "Finish the current recording before importing another lecture"
            return
        }

        let supported = Set(["m4a", "mp3", "wav", "aac", "caf", "flac"])
        let ext = sourceURL.pathExtension.lowercased()
        guard supported.contains(ext) else {
            statusMessage = "Unsupported audio format. Import M4A, MP3, WAV, AAC, CAF, or FLAC."
            return
        }

        let accessed = sourceURL.startAccessingSecurityScopedResource()
        defer {
            if accessed { sourceURL.stopAccessingSecurityScopedResource() }
        }

        do {
            let baseName = sourceURL.deletingPathExtension().lastPathComponent
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let safeBase = (baseName.isEmpty ? "Imported Lecture" : baseName)
                .replacingOccurrences(of: "/", with: "-")
                .replacingOccurrences(of: ":", with: "-")
            let destination = Self.recordingsDirectory.appendingPathComponent(
                "\(safeBase)_import_\(UUID().uuidString.prefix(8)).\(ext)"
            )

            try FileManager.default.copyItem(at: sourceURL, to: destination)

            let audioFile = try AVAudioFile(forReading: destination)
            let sampleRate = audioFile.processingFormat.sampleRate
            let duration = sampleRate > 0 ? Double(audioFile.length) / sampleRate : 0
            let attributes = try FileManager.default.attributesOfItem(atPath: destination.path)
            let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0

            let item = SavedRecording(
                id: UUID(),
                title: safeBase,
                fileName: destination.lastPathComponent,
                createdAt: Date(),
                duration: duration,
                size: size,
                marks: []
            )

            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let metadataURL = destination.deletingPathExtension().appendingPathExtension("lectureai.json")
            try encoder.encode(item).write(to: metadataURL, options: .atomic)

            recordings = ([item] + recordings.filter { $0.id != item.id })
                .sorted { $0.createdAt > $1.createdAt }
            lastSavedRecording = item
            state = .saved
            statusMessage = "Recording imported locally · original file copied safely into LectureAI"

            let fileSystem = try? FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory())
            freeStorageBytes = (fileSystem?[.systemFreeSize] as? NSNumber)?.int64Value ?? freeStorageBytes
        } catch {
            statusMessage = "Could not import recording: \(error.localizedDescription)"
        }
    }
}
