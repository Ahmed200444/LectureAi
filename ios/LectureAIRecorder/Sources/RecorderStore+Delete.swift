import Foundation

extension RecorderStore {
    @MainActor
    @discardableResult
    func deleteSafely(_ recording: SavedRecording) -> Bool {
        if isPlaying {
            stopPlayback()
        }

        let fileManager = FileManager.default
        let audioURL = recording.audioURL
        let metadataURL = audioURL.deletingPathExtension().appendingPathExtension("lectureai.json")

        do {
            if fileManager.fileExists(atPath: audioURL.path) {
                try fileManager.removeItem(at: audioURL)
            }
        } catch {
            statusMessage = "Could not delete the original recording. Nothing else was removed: \(error.localizedDescription)"
            return false
        }

        // Once the original audio is gone, best-effort cleanup of its small sidecar is safe.
        // A leftover sidecar is ignored by the library because its audio no longer exists.
        if fileManager.fileExists(atPath: metadataURL.path) {
            try? fileManager.removeItem(at: metadataURL)
        }

        recordings.removeAll { $0.id == recording.id }
        if lastSavedRecording?.id == recording.id {
            lastSavedRecording = nil
        }

        let fileSystem = try? fileManager.attributesOfFileSystem(forPath: NSHomeDirectory())
        freeStorageBytes = (fileSystem?[.systemFreeSize] as? NSNumber)?.int64Value ?? freeStorageBytes
        statusMessage = "Lecture deleted from this device"
        return true
    }
}
