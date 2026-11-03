import MaskinCore
import SwiftUI
import UserNotifications
import WatchKit

@main
struct MaskinWatchApp: App {
	@State private var environment = GlanceConfig.makeEnvironment(clientSource: "watchos")
	@State private var bridge = WatchSessionBridge()
	private let marker = UserDefaultsHandoffMarker()
	private let widgets = makeWidgetReloader()
	@State private var watchStore: MaskinWatchStore
	@Environment(\.scenePhase) private var scenePhase

	/// Identifier of the background refresh; carried as the task's `userInfo` so
	/// `.backgroundTask(.appRefresh)` matches it.
	private static let refreshID = "io.maskin.watch.refresh"
	/// Ask watchOS for a refresh about this often. It is a request, not a guarantee.
	private static let refreshInterval: TimeInterval = 30 * 60

	init() {
		WatchNotifications.install()
		let reloader = makeWidgetReloader()
		_watchStore = State(
			initialValue: MaskinWatchStore(
				storage: FileWatchSnapshotStorage(), onChange: { _ in reloader.reload() }))
	}

	var body: some Scene {
		WindowGroup {
			GlanceRoot(environment: environment) { forYou in WatchHome(environment: environment, store: forYou?.store, watch: watchStore) }
				.task { listenForPhone() }
				// Complications fetch with this session, so any change (handoff, sign-in on the watch,
				// sign-out) should refresh them rather than wait for the next scheduled reload.
				.onChange(of: environment.auth.session?.apiKey) { widgets.reload() }
				.onChange(of: scenePhase) { _, phase in
					if phase == .background { Self.scheduleRefresh() }
				}
		}
		// Background refresh: complications reload (their timeline provider fetches with the stored
		// session), then the next refresh is requested.
		.backgroundTask(.appRefresh(Self.refreshID)) {
			widgets.reload()
			await Self.scheduleRefresh()
		}
		// Long look for a decision alert: the message and its question, then the buttons.
		WKNotificationScene(controller: DecisionNotificationController.self, category: PushDecisionPayload.category)
	}

	private static func scheduleRefresh() {
		WKApplication.shared().scheduleBackgroundRefresh(
			withPreferredDate: Date(timeIntervalSinceNow: refreshInterval),
			userInfo: refreshID as NSString
		) { _ in }
	}

	/// Mirror the iPhone's sign-in. The watch still works alone: signing in on it stays possible,
	/// and a phone sign-out only ends a session the phone gave it (see `WatchHandoffPolicy`).
	private func listenForPhone() {
		let auth = environment.auth
		let marker = marker
		let watchStore = watchStore
		// The phone's last feed/flows/briefing, so the wrist has something to show with no network.
		bridge.onSnapshot { snapshot in
			Task { @MainActor in watchStore.receive(fromPhone: snapshot) }
		}
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
