import AVFoundation
import AudioToolbox
import SwiftUI
import UIKit

struct RecordingMark: Identifiable, Codable, Hashable {
    let id: UUID
    let time: TimeInterval
}

struct SavedRecording: Identifiable, Codable, Hashable {
    let id: UUID
    let title: String
    let fileName: String
    let createdAt: Date
    let duration: TimeInterval
    let size: Int64
    let marks: [RecordingMark]

    var audioURL: URL {
        RecorderStore.recordingsDirectory.appendingPathComponent(fileName)
    }
}

private struct InProgressRecordingCheckpoint: Codable {
    let id: UUID
    let title: String
    let fileName: String
    let createdAt: Date
    let marks: [RecordingMark]
    let lastKnownDuration: TimeInterval
    let updatedAt: Date
}

enum RecorderState: Equatable {
    case idle
    case recording
    case paused
    case interrupted
    case saved
    case failed(String)
}

final class RecorderStore: NSObject, ObservableObject, AVAudioRecorderDelegate, AVAudioPlayerDelegate {
    @Published var state: RecorderState = .idle
    @Published var title = "Lecture \(Date().formatted(date: .abbreviated, time: .omitted))"
    @Published var duration: TimeInterval = 0
    @Published var level: Double = 0
    @Published var statusMessage = "Ready for native iPhone/iPad recording"
    @Published var freeStorageBytes: Int64 = 0
    @Published var marks: [RecordingMark] = []
    @Published var recordings: [SavedRecording] = []
    @Published var lastSavedRecording: SavedRecording?
    @Published var isPlaying = false
    @Published var keepScreenAwake = true

    private var recorder: AVAudioRecorder?
    private var player: AVAudioPlayer?
    private var meterTimer: Timer?
    private var currentURL: URL?
    private var currentID = UUID()
    private var currentCreatedAt = Date()
    private var finishing = false
    private var meterTicks = 0
    private var lastObservedFileSize: Int64 = 0
    private var stagnantFileChecks = 0
    private var silentMeterChecks = 0

    static let recordingsDirectory: URL = {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let directory = documents.appendingPathComponent("LectureAI Native Recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }()

    private static let checkpointURL = recordingsDirectory.appendingPathComponent(".lectureai-in-progress.json")

    override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(handleInterruption(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(handleRouteChange(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(handleMediaServicesReset(_:)), name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(handleWillTerminate(_:)), name: UIApplication.willTerminateNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(handleDidEnterBackground(_:)), name: UIApplication.didEnterBackgroundNotification, object: nil)
        recoverInterruptedRecordingIfNeeded()
        refreshStorage()
        refreshLibrary()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        meterTimer?.invalidate()
    }

    func startRecording() async {
        guard state != .recording && state != .paused && state != .interrupted else { return }
        let allowed = await requestMicrophonePermission()
        guard allowed else {
            await MainActor.run {
                self.state = .failed("Microphone permission is required to record a lecture.")
                self.statusMessage = "Microphone permission denied"
            }
            return
        }

        do {
            try configureAudioSession()
            let url = makeRecordingURL()
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 48_000.0,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 192_000,
                AVEncoderAudioQualityKey: AVAudioQuality.max.rawValue,
            ]

            let newRecorder = try AVAudioRecorder(url: url, settings: settings)
            newRecorder.delegate = self
            newRecorder.isMeteringEnabled = true
            guard newRecorder.prepareToRecord(), newRecorder.record() else {
                throw RecorderError.couldNotStart
            }

            await MainActor.run {
                self.recorder = newRecorder
                self.currentURL = url
                self.currentID = UUID()
                self.currentCreatedAt = Date()
                self.duration = 0
                self.level = 0
                self.marks = []
                self.finishing = false
                self.meterTicks = 0
                self.lastObservedFileSize = 0
                self.stagnantFileChecks = 0
                self.silentMeterChecks = 0
                self.state = .recording
                self.statusMessage = "Recording with Apple native audio · background recording enabled"
                self.persistInProgressCheckpoint()
                self.applyIdleTimerPolicy()
                self.startMeterTimer()
                self.refreshStorage()
            }
        } catch {
            await MainActor.run {
                self.state = .failed(error.localizedDescription)
                self.statusMessage = "Could not start native recording"
                self.applyIdleTimerPolicy()
            }
        }
    }

    func pauseRecording() {
        guard state == .recording, let recorder else { return }
        recorder.pause()
        duration = recorder.currentTime
        level = 0
        state = .paused
        statusMessage = "Paused · same microphone session and same audio file are preserved"
        persistInProgressCheckpoint()
        applyIdleTimerPolicy()
    }

    func continueRecording() {
        guard state == .paused || state == .interrupted, let recorder else { return }
        do {
            try configureAudioSession()
            guard recorder.record() else { throw RecorderError.couldNotResume }
            state = .recording
            statusMessage = "Recording continued in the same lecture file"
            persistInProgressCheckpoint()
            applyIdleTimerPolicy()
        } catch {
            state = .interrupted
            statusMessage = "Could not resume the microphone yet · the recording already captured remains preserved"
            persistInProgressCheckpoint()
        }
    }

    func markMoment() {
        guard state == .recording || state == .paused else { return }
        let time = recorder?.currentTime ?? duration
        marks.append(RecordingMark(id: UUID(), time: time))
        persistInProgressCheckpoint()
    }

    func finishAndSave() {
        guard let recorder, let url = currentURL else { return }
        finishing = true
        recorder.stop()
        duration = recorder.currentTime
        level = 0
        meterTimer?.invalidate()
        meterTimer = nil

        let item = SavedRecording(
            id: currentID,
            title: cleanTitle,
            fileName: url.lastPathComponent,
            createdAt: currentCreatedAt,
            duration: duration,
            size: fileSize(at: url),
            marks: marks
        )
        saveMetadata(item)
        clearInProgressCheckpoint()
        lastSavedRecording = item
        state = .saved
        statusMessage = "Native recording saved locally · ready for LectureAI transcription"
        recorder.delegate = nil
        self.recorder = nil
        currentURL = nil
        deactivateAudioSession()
        applyIdleTimerPolicy()
        refreshLibrary()
        refreshStorage()
    }

    func discardCurrentRecording() {
        finishing = true
        recorder?.stop()
        if let currentURL { try? FileManager.default.removeItem(at: currentURL) }
        clearInProgressCheckpoint()
        resetSessionState()
        statusMessage = "Recording discarded"
    }

    func play(_ recording: SavedRecording) {
        guard state != .recording && state != .paused && state != .interrupted else { return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio)
            try session.setActive(true)
            let newPlayer = try AVAudioPlayer(contentsOf: recording.audioURL)
            newPlayer.delegate = self
            newPlayer.prepareToPlay()
            newPlayer.play()
            player = newPlayer
            isPlaying = true
            statusMessage = "Playing saved original audio"
        } catch {
            statusMessage = "Could not play the saved recording: \(error.localizedDescription)"
        }
    }

    func stopPlayback() {
        player?.stop()
        player = nil
        isPlaying = false
        statusMessage = "Playback stopped"
        deactivateAudioSession()
    }

    func delete(_ recording: SavedRecording) {
        if player?.url == recording.audioURL { stopPlayback() }
        try? FileManager.default.removeItem(at: recording.audioURL)
        try? FileManager.default.removeItem(at: metadataURL(for: recording.audioURL))
        if lastSavedRecording?.id == recording.id { lastSavedRecording = nil }
        refreshLibrary()
        refreshStorage()
    }

    func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        guard !finishing else { return }
        DispatchQueue.main.async {
            self.duration = recorder.currentTime
            self.level = 0
            self.meterTimer?.invalidate()
            self.meterTimer = nil
            self.state = .interrupted
            self.persistInProgressCheckpoint()
            self.statusMessage = flag
                ? "Recording stopped unexpectedly · captured audio remains recoverable"
                : "The audio encoder stopped unexpectedly · captured audio remains recoverable"
            self.applyIdleTimerPolicy()
        }
    }

    func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        DispatchQueue.main.async {
            self.duration = recorder.currentTime
            self.state = .interrupted
            self.persistInProgressCheckpoint()
            self.statusMessage = "Encoding interruption · captured audio remains preserved\(error.map { ": \($0.localizedDescription)" } ?? "")"
            self.applyIdleTimerPolicy()
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async {
            self.isPlaying = false
            self.player = nil
            self.statusMessage = flag ? "Playback finished" : "Playback ended"
            self.deactivateAudioSession()
        }
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }

        DispatchQueue.main.async {
            switch type {
            case .began:
                if self.state == .recording {
                    self.recorder?.pause()
                    self.duration = self.recorder?.currentTime ?? self.duration
                    self.level = 0
                    self.state = .interrupted
                    self.persistInProgressCheckpoint()
                    self.statusMessage = "iOS interrupted the microphone · captured audio remains preserved"
                }
            case .ended:
                let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions)
                if self.state == .interrupted && options.contains(.shouldResume) {
                    self.continueRecording()
                } else if self.state == .interrupted {
                    self.statusMessage = "Microphone interruption ended · tap Continue recording when ready"
                }
            @unknown default:
                break
            }
            self.applyIdleTimerPolicy()
        }
    }

    @objc private func handleRouteChange(_ notification: Notification) {
        DispatchQueue.main.async {
            guard self.state == .recording || self.state == .paused || self.state == .interrupted else { return }
            let input = AVAudioSession.sharedInstance().currentRoute.inputs.first?.portName ?? "built-in microphone"
            self.statusMessage = "Audio route checked · input: \(input)"
        }
    }

    @objc private func handleMediaServicesReset(_ notification: Notification) {
        DispatchQueue.main.async {
            guard self.state == .recording || self.state == .paused || self.state == .interrupted else { return }
            self.recorder?.pause()
            self.duration = self.recorder?.currentTime ?? self.duration
            self.level = 0
            self.state = .interrupted
            self.persistInProgressCheckpoint()
            self.statusMessage = "iOS audio services restarted · captured audio remains preserved; tap Continue recording"
            self.applyIdleTimerPolicy()
        }
    }

    @objc private func handleDidEnterBackground(_ notification: Notification) {
        guard state == .recording || state == .paused || state == .interrupted else { return }
        persistInProgressCheckpoint()
        // Do not deactivate the audio session here. An active AVAudioRecorder plus the
        // app's `audio` background mode allows recording to continue while locked or
        // while another app is in the foreground, subject to normal iOS interruptions.
    }

    @objc private func handleWillTerminate(_ notification: Notification) {
        guard state == .recording || state == .paused || state == .interrupted else { return }
        duration = recorder?.currentTime ?? duration
        persistInProgressCheckpoint()
    }

    private func requestMicrophonePermission() async -> Bool {
        if #available(iOS 17.0, *) {
            return await AVAudioApplication.requestRecordPermission()
        }

        return await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { allowed in
                continuation.resume(returning: allowed)
            }
        }
    }

    private func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .videoRecording)
        try session.setPreferredSampleRate(48_000)
        try session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true)
        try preferBuiltInLectureMicrophone(session)
    }

    private func preferBuiltInLectureMicrophone(_ session: AVAudioSession) throws {
        guard let builtIn = session.availableInputs?.first(where: { $0.portType == .builtInMic }) else { return }
        try session.setPreferredInput(builtIn)

        guard let sources = builtIn.dataSources, !sources.isEmpty else { return }
        let source = sources.first(where: { $0.orientation == .front }) ?? sources.first!
        if source.supportedPolarPatterns?.contains(.cardioid) == true {
            try? source.setPreferredPolarPattern(.cardioid)
        }
        try? builtIn.setPreferredDataSource(source)
    }

    private func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func startMeterTimer() {
        meterTimer?.invalidate()
        meterTimer = Timer.scheduledTimer(withTimeInterval: 0.10, repeats: true) { [weak self] _ in
            guard let self, let recorder = self.recorder else { return }
            if self.state == .recording {
                recorder.updateMeters()
                let db = recorder.averagePower(forChannel: 0)
                let amplitude = pow(10.0, Double(db) / 20.0)
                self.level = min(1, max(0, amplitude * 8))
                self.duration = recorder.currentTime
                self.meterTicks += 1

                if db <= -120 {
                    self.silentMeterChecks += 1
                } else {
                    self.silentMeterChecks = 0
                }

                // Keep the visual meter smooth, but perform filesystem/checkpoint work
                // only every 5 seconds instead of ten times per second.
                if self.meterTicks % 50 == 0 {
                    self.performRecordingHealthCheck()
                    self.persistInProgressCheckpoint()
                    self.refreshStorage()
                }
            } else {
                self.level = 0
            }
        }
    }

    private func performRecordingHealthCheck() {
        guard let currentURL else { return }
        let currentSize = fileSize(at: currentURL)
        if duration > 5, currentSize <= lastObservedFileSize {
            stagnantFileChecks += 1
        } else {
            stagnantFileChecks = 0
        }
        lastObservedFileSize = currentSize

        // Warn only. Never stop a lecture because the room is quiet or the speaker is distant.
        if stagnantFileChecks >= 2 {
            statusMessage = "Recording is active, but the encoded audio file is not growing normally · keep the app open and check the microphone"
        } else if silentMeterChecks >= 100 {
            statusMessage = "Recording is active, but the microphone signal has been digitally silent for about 10 seconds · check the microphone/route"
        }
    }

    private var cleanTitle: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Lecture" : trimmed
    }

    private func makeRecordingURL() -> URL {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        let safe = cleanTitle
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
        return Self.recordingsDirectory.appendingPathComponent("\(safe)_\(formatter.string(from: Date())).m4a")
    }

    private func metadataURL(for audioURL: URL) -> URL {
        audioURL.deletingPathExtension().appendingPathExtension("lectureai.json")
    }

    private func saveMetadata(_ recording: SavedRecording) {
        do {
            let data = try JSONEncoder.lectureAI.encode(recording)
            try data.write(to: metadataURL(for: recording.audioURL), options: .atomic)
        } catch {
            statusMessage = "Audio saved, but its local metadata could not be written"
        }
    }

    private func persistInProgressCheckpoint() {
        guard let currentURL else { return }
        let checkpoint = InProgressRecordingCheckpoint(
            id: currentID,
            title: cleanTitle,
            fileName: currentURL.lastPathComponent,
            createdAt: currentCreatedAt,
            marks: marks,
            lastKnownDuration: recorder?.currentTime ?? duration,
            updatedAt: Date()
        )
        do {
            let data = try JSONEncoder.lectureAI.encode(checkpoint)
            try data.write(to: Self.checkpointURL, options: .atomic)
        } catch {
            // The audio recorder continues even if a sidecar checkpoint cannot be written.
        }
    }

    private func clearInProgressCheckpoint() {
        try? FileManager.default.removeItem(at: Self.checkpointURL)
    }

    private func recoverInterruptedRecordingIfNeeded() {
        guard let data = try? Data(contentsOf: Self.checkpointURL),
              let checkpoint = try? JSONDecoder.lectureAI.decode(InProgressRecordingCheckpoint.self, from: data) else {
            return
        }

        let audioURL = Self.recordingsDirectory.appendingPathComponent(checkpoint.fileName)
        guard FileManager.default.fileExists(atPath: audioURL.path) else {
            clearInProgressCheckpoint()
            return
        }

        let size = fileSize(at: audioURL)
        guard size > 0 else {
            try? FileManager.default.removeItem(at: audioURL)
            clearInProgressCheckpoint()
            return
        }

        let playableDuration: TimeInterval
        if let recoveredPlayer = try? AVAudioPlayer(contentsOf: audioURL) {
            playableDuration = recoveredPlayer.duration
        } else {
            playableDuration = checkpoint.lastKnownDuration
        }

        let recovered = SavedRecording(
            id: checkpoint.id,
            title: checkpoint.title + " (Recovered)",
            fileName: checkpoint.fileName,
            createdAt: checkpoint.createdAt,
            duration: max(playableDuration, checkpoint.lastKnownDuration),
            size: size,
            marks: checkpoint.marks
        )
        saveMetadata(recovered)
        lastSavedRecording = recovered
        clearInProgressCheckpoint()
        statusMessage = "Recovered a lecture that was interrupted before Finish was tapped"
    }

    private func refreshLibrary() {
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: Self.recordingsDirectory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []

        recordings = urls
            .filter { $0.pathExtension == "json" && $0.lastPathComponent.hasSuffix(".lectureai.json") }
            .compactMap { url in
                guard let data = try? Data(contentsOf: url),
                      let item = try? JSONDecoder.lectureAI.decode(SavedRecording.self, from: data),
                      FileManager.default.fileExists(atPath: item.audioURL.path) else { return nil }
                return item
            }
            .sorted { $0.createdAt > $1.createdAt }
    }

    private func refreshStorage() {
        let attributes = try? FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory())
        freeStorageBytes = (attributes?[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
    }

    private func fileSize(at url: URL) -> Int64 {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes?[.size] as? NSNumber)?.int64Value ?? 0
    }

    private func applyIdleTimerPolicy() {
        let activeSession = state == .recording || state == .paused || state == .interrupted
        UIApplication.shared.isIdleTimerDisabled = keepScreenAwake && activeSession
    }

    private func resetSessionState() {
        meterTimer?.invalidate()
        meterTimer = nil
        recorder = nil
        currentURL = nil
        duration = 0
        level = 0
        marks = []
        meterTicks = 0
        lastObservedFileSize = 0
        stagnantFileChecks = 0
        silentMeterChecks = 0
        state = .idle
        deactivateAudioSession()
        applyIdleTimerPolicy()
        refreshStorage()
    }
}

private enum RecorderError: LocalizedError {
    case couldNotStart
    case couldNotResume

    var errorDescription: String? {
        switch self {
        case .couldNotStart: return "The native microphone recorder could not start."
        case .couldNotResume: return "The native microphone recorder could not continue."
        }
    }
}

private extension JSONEncoder {
    static var lectureAI: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}

private extension JSONDecoder {
    static var lectureAI: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}