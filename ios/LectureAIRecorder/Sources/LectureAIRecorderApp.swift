import SwiftUI

@main
struct LectureAIRecorderApp: App {
    @StateObject private var recorder = RecorderStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(recorder)
        }
    }
}
