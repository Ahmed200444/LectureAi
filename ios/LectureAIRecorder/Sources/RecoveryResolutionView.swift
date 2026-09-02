import SwiftUI

struct RecoveryResolutionView: View {
    @EnvironmentObject private var recorder: RecorderStore
    @State private var showingDiscardConfirmation = false

    var body: some View {
        ZStack {
            Color(.systemGroupedBackground)
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Label("Preserved recording needs attention", systemImage: "exclamationmark.shield.fill")
                        .font(.title2.bold())

                    Text("LectureAI found audio from an interrupted recording that it cannot safely place in the normal lecture library yet. The raw file and its recovery checkpoint are being preserved.")
                        .foregroundStyle(.secondary)

                    VStack(alignment: .leading, spacing: 10) {
                        Label("Nothing is deleted automatically", systemImage: "externaldrive.badge.checkmark")
                            .font(.headline)
                        Text("You can export the preserved raw audio first, retry local recovery, or explicitly discard this one recovery item. New recordings stay locked until you choose how to resolve it so the checkpoint cannot be overwritten.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(16)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                    if let url = recorder.unresolvedRecoveryURL {
                        ShareLink(item: url) {
                            Label("Export preserved audio", systemImage: "square.and.arrow.up")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                    } else {
                        Label("The recovery file path is unavailable. Retry recovery or discard the checkpoint explicitly.", systemImage: "questionmark.folder")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Button {
                        recorder.retryUnresolvedRecovery()
                    } label: {
                        Label("Retry recovery", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)

                    Button(role: .destructive) {
                        showingDiscardConfirmation = true
                    } label: {
                        Label("Discard preserved recovery", systemImage: "trash")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)

                    Text("Discard permanently removes only this preserved recovery audio and its checkpoint. Export it first if you may want to inspect or recover it elsewhere.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(24)
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
            }
        }
        .confirmationDialog(
            "Permanently discard preserved audio?",
            isPresented: $showingDiscardConfirmation,
            titleVisibility: .visible
        ) {
            Button("Discard preserved audio", role: .destructive) {
                recorder.discardUnresolvedRecovery()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This cannot be undone. Export the preserved file first if you may need it later.")
        }
    }
}
