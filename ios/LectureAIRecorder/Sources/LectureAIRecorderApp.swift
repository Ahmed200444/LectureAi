import SwiftUI

@main
struct LectureAIRecorderApp: App {
    @StateObject private var recorder = RecorderStore()
    @StateObject private var lectureStore = NativeLectureStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(recorder)
                .environmentObject(lectureStore)
        }
    }
}
