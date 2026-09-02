import SwiftUI

@main
struct LectureAIRecorderApp: App {
    @StateObject private var recorder = RecorderStore()
    @StateObject private var lectureStore = NativeLectureStore()

    var body: some Scene {
        WindowGroup {
            ZStack {
                ContentView()
                    .environmentObject(recorder)
                    .environmentObject(lectureStore)

                if recorder.hasUnresolvedRecovery {
                    RecoveryResolutionView()
                        .environmentObject(recorder)
                        .transition(.opacity)
                        .zIndex(10)
                }
            }
        }
    }
}
