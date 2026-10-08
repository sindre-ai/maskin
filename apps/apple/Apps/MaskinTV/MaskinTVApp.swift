import MaskinCore
import SwiftUI

@main
struct MaskinTVApp: App {
	@State private var environment = GlanceConfig.makeEnvironment(clientSource: "tvos")

	var body: some Scene {
		WindowGroup {
			GlanceRoot(environment: environment) { forYou in
				TVRoot(environment: environment, forYou: forYou)
			}
			// Dark only: the room display uses the Patina dark tokens.
			.preferredColorScheme(.dark)
		}
	}
}
