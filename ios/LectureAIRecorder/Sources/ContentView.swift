import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var recorder: RecorderStore
    @Environment(\.openURL) private var openURL

    private var sessionActive: Bool {
        recorder.state == .recording || recorder.state == .paused || recorder.state == .interrupted
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    headerCard
                    recorderCard
                    if let saved = recorder.lastSavedRecording {
                        savedCard(saved)
                    }
                    libraryCard
                }
                .padding()
            }
            .navigationTitle("LectureAI Recorder")
            .background(Color(.systemGroupedBackground))
        }
    }

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Native iPhone/iPad lecture capture", systemImage: "waveform")
                .font(.headline)
            Text("Uses Apple’s native microphone APIs instead of Safari. The original recording stays on this device unless you explicitly share it.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            HStack(spacing: 14) {
                Label("48 kHz AAC", systemImage: "waveform")
                Label("Mono", systemImage: "speaker.wave.2")
                Label("No time quota", systemImage: "infinity")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .cardStyle()
    }

    private var recorderCard: some View {
        VStack(spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(stateTitle)
                        .font(.headline)
                    Text(recorder.statusMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Circle()
                    .fill(recorder.state == .recording ? Color.red : Color.secondary.opacity(0.25))
                    .frame(width: 14, height: 14)
            }

            TextField("Lecture title", text: $recorder.title)
                .textFieldStyle(.roundedBorder)
                .disabled(sessionActive)

            Text(formatDuration(recorder.duration))
                .font(.system(size: 44, weight: .semibold, design: .rounded))
                .monospacedDigit()

            ProgressView(value: recorder.level)
                .progressViewStyle(.linear)
                .scaleEffect(x: 1, y: 2, anchor: .center)
                .accessibilityLabel("Microphone level")
                .accessibilityValue("\(Int(recorder.level * 100)) percent")

            Text(levelMessage)
                .font(.caption)
                .foregroundStyle(recorder.level < 0.02 && recorder.state == .recording ? .orange : .secondary)

            HStack {
                Label("\(recorder.marks.count) marks", systemImage: "star")
                Spacer()
                Label(formatBytes(recorder.freeStorageBytes) + " free", systemImage: "internaldrive")
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            controlButtons

            if sessionActive {
                Label("LectureAI keeps the screen awake during this recording session. Quiet or distant audio never stops the recorder.", systemImage: "sun.max")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .cardStyle()
    }

    @ViewBuilder
    private var controlButtons: some View {
        switch recorder.state {
        case .idle, .saved, .failed:
            Button {
                Task { await recorder.startRecording() }
            } label: {
                Label("Start native recording", systemImage: "record.circle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

        case .recording:
            HStack {
                Button {
                    recorder.pauseRecording()
                } label: {
                    Label("Pause", systemImage: "pause.fill")
                }
                .buttonStyle(.bordered)

                Button {
                    recorder.markMoment()
                } label: {
                    Label("Mark", systemImage: "star.fill")
                }
                .buttonStyle(.bordered)
            }

            Button(role: .destructive) {
                recorder.finishAndSave()
            } label: {
                Label("Finish & save", systemImage: "stop.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)

        case .paused:
            Button {
                recorder.continueRecording()
            } label: {
                Label("Continue recording", systemImage: "play.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)

            Button(role: .destructive) {
                recorder.finishAndSave()
            } label: {
                Label("Finish & save", systemImage: "stop.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)

        case .interrupted:
            Button {
                recorder.continueRecording()
            } label: {
                Label("Try to continue recording", systemImage: "arrow.clockwise")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)

            Button(role: .destructive) {
                recorder.finishAndSave()
            } label: {
                Label("Save captured audio", systemImage: "square.and.arrow.down")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
    }

    private func savedCard(_ recording: SavedRecording) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Latest recording")
                .font(.headline)
            Text(recording.title)
                .font(.title3.weight(.semibold))
            Text("\(formatDuration(recording.duration)) · \(formatBytes(recording.size))")
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack {
                Button {
                    recorder.isPlaying ? recorder.stopPlayback() : recorder.play(recording)
                } label: {
                    Label(recorder.isPlaying ? "Stop" : "Listen", systemImage: recorder.isPlaying ? "stop.fill" : "play.fill")
                }
                .buttonStyle(.bordered)

                ShareLink(item: recording.audioURL) {
                    Label("Send to LectureAI", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.borderedProminent)
            }

            Button {
                if let url = URL(string: "https://lecture-ai-blush.vercel.app/") {
                    openURL(url)
                }
            } label: {
                Label("Open LectureAI library", systemImage: "safari")
            }
            .buttonStyle(.plain)

            Text("To move this native recording into the current LectureAI web library, use Send to LectureAI → Save to Files, then open LectureAI and choose Import Recording. The web app already accepts .m4a files and queues them for transcription.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .cardStyle()
    }

    private var libraryCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Native recordings")
                .font(.headline)

            if recorder.recordings.isEmpty {
                Text("No native recordings saved yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(recorder.recordings) { item in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(item.title)
                                    .font(.subheadline.weight(.semibold))
                                Text("\(item.createdAt.formatted(date: .abbreviated, time: .shortened)) · \(formatDuration(item.duration))")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            ShareLink(item: item.audioURL) {
                                Image(systemName: "square.and.arrow.up")
                            }
                        }

                        HStack {
                            Button("Listen") { recorder.play(item) }
                                .buttonStyle(.borderless)
                            Spacer()
                            Button("Delete", role: .destructive) { recorder.delete(item) }
                                .buttonStyle(.borderless)
                        }
                        .font(.caption)
                    }
                    if item.id != recorder.recordings.last?.id { Divider() }
                }
            }
        }
        .cardStyle()
    }

    private var stateTitle: String {
        switch recorder.state {
        case .idle: return "Ready"
        case .recording: return "Recording"
        case .paused: return "Paused"
        case .interrupted: return "Microphone interrupted"
        case .saved: return "Saved"
        case .failed(let message): return message
        }
    }

    private var levelMessage: String {
        if recorder.state == .paused { return "Paused — the same microphone session is kept ready" }
        if recorder.state == .interrupted { return "iOS interrupted the audio session — captured audio is preserved" }
        if recorder.state != .recording { return "The live meter appears while recording" }
        if recorder.level < 0.02 { return "Audio is quiet, but recording continues. Move the device closer when practical." }
        if recorder.level > 0.95 { return "Very loud input — avoid tapping or covering the microphones" }
        return "Audio is reaching the native recorder"
    }
}

private extension View {
    func cardStyle() -> some View {
        self
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

private func formatDuration(_ seconds: TimeInterval) -> String {
    let total = max(0, Int(seconds.rounded(.down)))
    let hours = total / 3600
    let minutes = (total % 3600) / 60
    let secs = total % 60
    return hours > 0
        ? String(format: "%d:%02d:%02d", hours, minutes, secs)
        : String(format: "%02d:%02d", minutes, secs)
}

private func formatBytes(_ bytes: Int64) -> String {
    let formatter = ByteCountFormatter()
    formatter.allowedUnits = [.useMB, .useGB]
    formatter.countStyle = .file
    return formatter.string(fromByteCount: max(0, bytes))
}
