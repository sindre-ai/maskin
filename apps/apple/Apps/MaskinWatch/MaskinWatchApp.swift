import MaskinCore
import SwiftUI

@main
struct MaskinWatchApp: App {
	@State private var environment = GlanceConfig.makeEnvironment(clientSource: "watchos")

	var body: some Scene {
		WindowGroup { GlanceRoot(environment: environment) }
	}
}
