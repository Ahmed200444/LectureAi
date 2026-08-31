import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @EnvironmentObject private var recorder: RecorderStore
    @EnvironmentObject private var lectureStore: NativeLectureStore
    @State private var showingImporter = false

    private var sessionActive: Bool {
        recorder.state == .recording || recorder.state == .paused || recorder.state == .interrupted
    }

    private var transcriptionActive: Bool {
        lectureStore.activeRecordingID != nil
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
            .navigationTitle("LectureAI")
            .background(Color(.systemGroupedBackground))
            .fileImporter(
                isPresented: $showingImporter,
                allowedContentTypes: [.audio],
                allowsMultipleSelection: false
            ) { result in
                switch result {
                case .success(let urls):
                    guard let url = urls.first else { return }
                    Task { await recorder.importRecording(from: url) }
                case .failure(let error):
                    recorder.statusMessage = "Could not open the selected recording: \(error.localizedDescription)"
                }
            }
        }
    }

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("One native LectureAI app", systemImage: "waveform.and.mic")
                .font(.headline)
            Text("Record, import, transcribe, translate, review notes, and play lectures without sending the original audio to a cloud speech service.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            HStack(spacing: 14) {
                Label("48 kHz AAC", systemImage: "waveform")
                Label("Mono", systemImage: "speaker.wave.2")
                Label("No time quota", systemImage: "infinity")
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            Button {
                showingImporter = true
            } label: {
                Label("Import recording", systemImage: "square.and.arrow.down")
            }
            .buttonStyle(.bordered)
            .disabled(sessionActive || transcriptionActive)
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

            if transcriptionActive && !sessionActive {
                Label("Finish the active local transcription before starting or importing another recording. This keeps recording and the Core ML speech model from competing for device resources.", systemImage: "cpu")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if sessionActive {
                Label("LectureAI keeps the audio session active in the background. Locking the screen or switching apps does not intentionally stop the recorder; normal iOS microphone interruptions are handled separately.", systemImage: "lock.iphone")
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
            .disabled(transcriptionActive)

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
            if recorder.canContinueRecording {
                Button {
                    recorder.continueRecording()
                } label: {
                    Label("Try to continue recording", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            } else {
                Text("The current encoder cannot safely resume the same file. Save what was captured, then start a new recording.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

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
            Text("Latest lecture")
                .font(.headline)
            Text(recording.title)
                .font(.title3.weight(.semibold))
            Text("\(formatDuration(recording.duration)) · \(formatBytes(recording.size))")
                .font(.caption)
                .foregroundStyle(.secondary)

            NavigationLink {
                LectureDetailView(recording: recording)
            } label: {
                Label("Open lecture", systemImage: "doc.text.magnifyingglass")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)

            HStack {
                Button {
                    recorder.isPlaying ? recorder.stopPlayback() : recorder.play(recording)
                } label: {
                    Label(recorder.isPlaying ? "Stop" : "Listen", systemImage: recorder.isPlaying ? "stop.fill" : "play.fill")
                }
                .buttonStyle(.bordered)

                ShareLink(item: recording.audioURL) {
                    Label("Share original", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.bordered)
            }
        }
        .cardStyle()
    }

    private var libraryCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Lecture library")
                .font(.headline)

            if recorder.recordings.isEmpty {
                Text("No native recordings saved yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(recorder.recordings) { item in
                    VStack(alignment: .leading, spacing: 8) {
                        NavigationLink {
                            LectureDetailView(recording: item)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item.title)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.primary)
                                    Text("\(item.createdAt.formatted(date: .abbreviated, time: .shortened)) · \(formatDuration(item.duration))")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    let transcript = lectureStore.transcript(for: item.id)
                                    if transcript.state == .done {
                                        Text("Transcribed · \(transcript.detectedLanguage ?? "language unknown")")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            }
                        }

                        HStack {
                            Button("Listen") { recorder.play(item) }
                                .buttonStyle(.borderless)
                            Spacer()
                            ShareLink(item: item.audioURL) {
                                Text("Share")
                            }
                            .buttonStyle(.borderless)
                            Spacer()
                            Button("Delete", role: .destructive) {
                                lectureStore.deleteTranscript(for: item.id)
                                recorder.delete(item)
                            }
                            .buttonStyle(.borderless)
                            .disabled(lectureStore.activeRecordingID == item.id)
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
