import MaskinCore
import SwiftUI

@main
struct MaskinWatchApp: App {
	@State private var environment = GlanceConfig.makeEnvironment(clientSource: "watchos")
	@State private var bridge = WatchSessionBridge()
	private let marker = UserDefaultsHandoffMarker()
	private let widgets = makeWidgetReloader()

	init() { WatchNotifications.install() }

	var body: some Scene {
		WindowGroup {
			GlanceRoot(environment: environment) { forYou in WatchHome(environment: environment, store: forYou?.store) }
				.task { listenForPhone() }
				// Complications fetch with this session, so any change (handoff, sign-in on the watch,
				// sign-out) should refresh them rather than wait for the next scheduled reload.
				.onChange(of: environment.auth.session?.apiKey) { widgets.reload() }
		}
	}

	/// Mirror the iPhone's sign-in. The watch still works alone: signing in on it stays possible,
	/// and a phone sign-out only ends a session the phone gave it (see `WatchHandoffPolicy`).
	private func listenForPhone() {
		let auth = environment.auth
		let marker = marker
		bridge.onHandoff { handoff in
			Task { @MainActor in
				switch WatchHandoffPolicy.decide(
					incoming: handoff, current: auth.session, adoptedKey: marker.adoptedKey)
				{
				case .adopt(let session):
					if (try? auth.adopt(session)) != nil { marker.setAdoptedKey(session.apiKey) }
				case .signOut:
					auth.signOut()
					marker.setAdoptedKey(nil)
				case .ignore:
					break
				}
			}
		}
	}
}
