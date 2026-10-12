import MaskinCore
import SwiftUI

@main
struct MaskinTVApp: App {
	@State private var environment = GlanceConfig.makeEnvironment(clientSource: "tvos")

	init() {
		// Siri intents run in this process and read the same API origin as the app.
		let raw = Bundle.main.object(forInfoDictionaryKey: "MaskinAPIBaseURL") as? String
		MaskinIntentsContext.configure(
			baseURL: raw.flatMap(URL.init(string:)) ?? URL(string: "https://maskin.io")!, clientSource: "tvos")
	}

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
