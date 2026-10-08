import MaskinCore
import SwiftUI

@main
struct MaskinTVApp: App {
	@State private var environment = GlanceConfig.makeEnvironment(clientSource: "tvos")

	var body: some Scene {
		WindowGroup {
			GlanceRoot(environment: environment) { store in
				TVRoot(environment: environment, store: store)
			}
			// Dark only: the room display uses the Patina dark tokens.
			.preferredColorScheme(.dark)
		}
	}
}
