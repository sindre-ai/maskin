import MaskinCore
import SwiftUI

@main
struct MaskinTVApp: App {
	@State private var environment = GlanceConfig.makeEnvironment(clientSource: "tvos")

	var body: some Scene {
		WindowGroup { GlanceRoot(environment: environment) }
	}
}
