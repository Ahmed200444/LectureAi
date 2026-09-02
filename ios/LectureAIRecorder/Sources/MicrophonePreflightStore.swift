import AVFoundation
import Foundation

@MainActor
final class MicrophonePreflightStore: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published private(set) var isTesting = false
    @Published private(set) var isPlaying = false
    @Published private(set) var sampleReady = false
    @Published private(set) var samplePlaybackCompleted = false
    @Published private(set) var verified = false
    @Published private(set) var statusMessage = "Test the microphone before starting a lecture"

    private var testRecorder: AVAudioRecorder?
    private var player: AVAudioPlayer?
    private var sampleURL: URL?
    private var activeTestID: UUID?

    override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        if let sampleURL { try? FileManager.default.removeItem(at: sampleURL) }
    }

    func runTest() async {
        guard !isTesting else { return }
        isTesting = true
        let testID = UUID()
        activeTestID = testID
        defer {
            if activeTestID == testID {
                activeTestID = nil
            }
            isTesting = false
        }

        resetSample(keepStatus: true)
        verified = false
        statusMessage = "Preparing microphone test…"

        do {
            let allowed = await requestMicrophonePermission()
            try ensureActiveTest(testID)
            guard allowed else {
                statusMessage = "Microphone permission is required for the preflight test"
                return
            }

            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default)
            try session.setPreferredSampleRate(48_000)
            try session.setPreferredIOBufferDuration(0.02)
            try session.setActive(true)
            if let builtIn = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
                try session.setPreferredInput(builtIn)
            }
            try ensureActiveTest(testID)

            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("LectureAI-mic-test-\(UUID().uuidString)")
                .appendingPathExtension("m4a")
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 48_000.0,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 192_000,
                AVEncoderAudioQualityKey: AVAudioQuality.max.rawValue,
            ]

            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.isMeteringEnabled = true
            guard recorder.prepareToRecord(), recorder.record() else {
                throw MicrophonePreflightError.couldNotStart
            }

            testRecorder = recorder
            sampleURL = url
            statusMessage = "Recording a short encoded microphone sample… speak normally"

            for _ in 0..<20 {
                try Task.checkCancellation()
                try await Task.sleep(nanoseconds: 100_000_000)
                try ensureActiveTest(testID)
            }

            recorder.stop()
            testRecorder = nil
            try ensureActiveTest(testID)

            let proof = try validateEncodedSample(at: url)
            guard proof.duration >= 1.5 else {
                throw MicrophonePreflightError.sampleTooShort
            }
            guard proof.size >= 2_000 else {
                throw MicrophonePreflightError.encodedFileTooSmall
            }
            guard proof.peakAmplitude >= 0.0001 else {
                throw MicrophonePreflightError.digitalSilence
            }
            try ensureActiveTest(testID)

            sampleReady = true
            samplePlaybackCompleted = false
            statusMessage = "Encoded audio verified · listen to the sample, then confirm you can hear it clearly"
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
        } catch is CancellationError {
            testRecorder?.stop()
            testRecorder = nil
            resetSample(keepStatus: false)
            statusMessage = "Microphone test cancelled"
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch MicrophonePreflightError.routeChangedDuringTest {
            testRecorder?.stop()
            testRecorder = nil
            resetSample(keepStatus: true)
            verified = false
            statusMessage = "Audio route changed during the microphone test · run the test again before recording"
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            testRecorder?.stop()
            testRecorder = nil
            resetSample(keepStatus: false)
            statusMessage = error.localizedDescription
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    func playSample() {
        guard sampleReady, let sampleURL else { return }
        samplePlaybackCompleted = false
        do {
            player?.stop()
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio)
            try session.setActive(true)
            let player = try AVAudioPlayer(contentsOf: sampleURL)
            player.delegate = self
            guard player.prepareToPlay(), player.play() else {
                throw MicrophonePreflightError.couldNotPlay
            }
            self.player = player
            isPlaying = true
            statusMessage = "Playing the exact encoded microphone sample"
        } catch {
            resetSample(keepStatus: true)
            verified = false
            statusMessage = "Could not play the microphone sample: \(error.localizedDescription) · run the test again"
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    func confirmAudibleSample() {
        guard sampleReady, samplePlaybackCompleted else { return }
        player?.stop()
        player = nil
        isPlaying = false
        verified = true
        statusMessage = "Microphone verified with real encoded, audible audio"
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func consumeVerification() {
        verified = false
        resetSample(keepStatus: false)
        statusMessage = "Test the microphone before the next lecture"
    }

    func resetForRouteChange() {
        verified = false
        if isTesting {
            activeTestID = nil
            testRecorder?.stop()
            testRecorder = nil
        }
        resetSample(keepStatus: true)
        statusMessage = isTesting
            ? "Audio route changed during the microphone test · run the test again before recording"
            : "Audio route changed · test the microphone again before recording"
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.isPlaying = false
            self.player = nil
            if flag {
                self.samplePlaybackCompleted = true
                self.statusMessage = "Sample finished · confirm only if you clearly heard your voice"
            } else {
                self.verified = false
                self.resetSample(keepStatus: true)
                self.statusMessage = "Sample playback ended unexpectedly · run the microphone test again"
            }
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    @objc nonisolated private func handleRouteChange(_ notification: Notification) {
        let reasonValue = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        let reason = reasonValue.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))

        // LectureAI deliberately changes the shared session category between `.record`
        // and `.playback` so the user can listen to the exact encoded preflight sample.
        // iOS may emit a route-change notification for that category transition even
        // though the physical microphone route did not change. Keep the verified sample
        // in that case, but invalidate/cancel an active test for real route changes.
        if reason == .categoryChange {
            return
        }

        Task { @MainActor in
            self.resetForRouteChange()
        }
    }

    private func ensureActiveTest(_ testID: UUID) throws {
        guard activeTestID == testID else {
            throw MicrophonePreflightError.routeChangedDuringTest
        }
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

    private func validateEncodedSample(at url: URL) throws -> (duration: TimeInterval, size: Int64, peakAmplitude: Float) {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        let durationPlayer = try AVAudioPlayer(contentsOf: url)
        let duration = durationPlayer.duration

        let file = try AVAudioFile(forReading: url)
        let format = file.processingFormat
        let maximumFrames = AVAudioFramePosition(max(1, format.sampleRate * 3))
        let framesToRead = AVAudioFrameCount(min(file.length, maximumFrames))
        guard framesToRead > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: framesToRead) else {
            throw MicrophonePreflightError.couldNotDecode
        }
        try file.read(into: buffer, frameCount: framesToRead)
        guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else {
            throw MicrophonePreflightError.couldNotDecode
        }

        var peak: Float = 0
        let frameLength = Int(buffer.frameLength)
        let channelCount = Int(format.channelCount)
        for channelIndex in 0..<channelCount {
            let samples = channels[channelIndex]
            for index in 0..<frameLength {
                peak = max(peak, abs(samples[index]))
            }
        }
        return (duration, size, peak)
    }

    private func resetSample(keepStatus: Bool) {
        player?.stop()
        player = nil
        isPlaying = false
        sampleReady = false
        samplePlaybackCompleted = false
        if let sampleURL {
            try? FileManager.default.removeItem(at: sampleURL)
        }
        sampleURL = nil
        if !keepStatus {
            statusMessage = "Test the microphone before starting a lecture"
        }
    }
}

private enum MicrophonePreflightError: LocalizedError {
    case couldNotStart
    case sampleTooShort
    case encodedFileTooSmall
    case digitalSilence
    case couldNotDecode
    case couldNotPlay
    case routeChangedDuringTest

    var errorDescription: String? {
        switch self {
        case .couldNotStart:
            return "The microphone test could not start."
        case .sampleTooShort:
            return "The encoded microphone sample was too short. Run the test again."
        case .encodedFileTooSmall:
            return "The microphone created an invalid encoded sample. Run the test again."
        case .digitalSilence:
            return "The encoded microphone sample is silent. Check the microphone or audio route, then test again."
        case .couldNotDecode:
            return "LectureAI could not decode the encoded microphone sample. Run the test again."
        case .couldNotPlay:
            return "LectureAI could not play the encoded microphone sample. Run the test again."
        case .routeChangedDuringTest:
            return "The audio route changed during the microphone test. Run the test again."
        }
    }
}
