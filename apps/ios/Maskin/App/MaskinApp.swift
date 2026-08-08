import SwiftUI

@main
struct MaskinApp: App {
	@State private var auth = AuthManager.shared
	@State private var appModel = AppModel()

	var body: some Scene {
		WindowGroup {
			RootView()
				.environment(auth)
				.environment(appModel)
				.tint(MaskinColor.accent)
		}
	}
}

struct RootView: View {
	@Environment(AuthManager.self) private var auth

	var body: some View {
		Group {
			if auth.isAuthenticated {
				TabShellView()
			} else {
				AuthView()
			}
		}
	}
}
