import CoreSpotlight
import MaskinCore
import MaskinFeatures
import SwiftUI

@main
struct MaskinApp: App {
	#if os(iOS)
		@UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
	#else
		@NSApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
	#endif
	@State private var environment: AppEnvironment
	@State private var push: PushRegistrar
	@Environment(\.scenePhase) private var scenePhase
	#if os(iOS)
		@State private var watchBridge = WatchSessionBridge()
	#endif

	/// Debug builds sign in from `MASKIN_DEMO_SESSION` (see scripts/design-review.sh), in memory,
	/// so a simulator without a Keychain can be screenshotted against the demo server.
	@MainActor private static func makeEnvironment(source: String) -> AppEnvironment {
		#if DEBUG
			if let raw = ProcessInfo.processInfo.environment["MASKIN_DEMO_SESSION"],
				let session = try? JSONDecoder().decode(StoredSession.self, from: Data(raw.utf8))
			{
				let environment = AppEnvironment(
					baseURL: apiBaseURL, clientSource: source, secretStore: InMemorySecretStore())
				try? environment.auth.adopt(session)
				return environment
			}
		#endif
		let environment = AppEnvironment(
			baseURL: apiBaseURL, clientSource: source, secretStore: KeychainSecretStore())
		environment.auth.restore()
		return environment
	}

	init() {
		#if os(macOS)
			let source = "macos"
			let platform = DevicePlatform.macos
		#else
			let source = "ios"
			let platform = DevicePlatform.ios
		#endif
		let environment = Self.makeEnvironment(source: source)
		MaskinIntentsContext.configure(baseURL: Self.apiBaseURL, clientSource: source)
		IntentsHost.attach(environment: environment)
		// Agent names, thread links and Spotlight entries belong to the account that is leaving.
		environment.auth.onSessionEnded { _ in Task { await MaskinIntentsContext.wipe() } }
		_environment = State(initialValue: environment)
		let registrar = PushRegistrar(
			system: SystemPushSystem(), devices: APIDeviceRegistrar(client: environment.client),
			environment: .detect(), platform: platform,
			appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
		)
		#if os(iOS)
			Self.setUpLiveActivity(environment: environment, registrar: registrar)
			BackgroundRefresh.register(environment: environment)
		#endif
		_push = State(initialValue: registrar)
	}

	var body: some Scene {
		WindowGroup {
			RootView(environment: environment, push: push) { runtime in
				pushDelegate.attach(registrar: push, router: runtime.router)
				// Siri / Shortcuts / Spotlight open threads through the same deep-link router.
				IntentDeepLinkRelay.attach(openAgent: { runtime.openAgent($0) }) { runtime.router.open($0) }
			}
			#if os(iOS)
				.frame(minWidth: WindowMetrics.minimumWidth, minHeight: WindowMetrics.minimumHeight)
			#endif
			// "Open on iPhone" from the watch: the card the wearer was looking at.
			.onContinueUserActivity(HandoffActivity.type) { activity in
				if let url = HandoffActivity.link(from: activity.userInfo) { IntentDeepLinkRelay.open(url) }
			}
			.onContinueUserActivity(CSSearchableItemActionType) { activity in
				guard
					let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String
				else { return }
				Task { await IntentDeepLinkRelay.openSpotlight(identifier: id) }
			}
			#if os(iOS)
				// Hand the sign-in to the paired watch, and again whenever it changes.
				.onChange(of: environment.auth.session, initial: true) { _, session in
					watchBridge.publish(session)
				}
			#endif
		}
		#if os(iOS)
			// Stage Manager and Split View may shrink the window, but never below 320 × 480.
			.windowResizability(.contentMinSize)
			.onChange(of: scenePhase) { _, phase in
				if phase == .background { BackgroundRefresh.schedule() }
			}
		#endif
		.commands { ShellCommands() }
	}

	#if os(iOS)
		/// Agent-turn Live Activity: ActivityKit host, token registration against the backend (once
		/// the push registrar knows the server's device id), and the foreground fallback.
		private static func setUpLiveActivity(environment: AppEnvironment, registrar: PushRegistrar) {
			let host = TurnActivityHost()
			let coordinator = TurnActivityCoordinator(
				host: host,
				tokens: APILiveActivityTokens(
					baseURL: apiBaseURL, clientSource: "ios",
					credentials: {
						await MainActor.run {
							environment.auth.session.map {
								.init(apiKey: $0.apiKey, workspaceId: $0.workspaceId)
							}
						}
					}))
			TurnActivityCoordinator.shared = coordinator
			host.attach(coordinator)
			environment.auth.onSessionEnded { ending in
				let creds = APILiveActivityTokens.Credentials(
					apiKey: ending.apiKey, workspaceId: ending.workspaceId)
				Task { await coordinator.signedOut(credentials: creds) }
			}
			registrar.onDeviceChanged = { id in Task { await coordinator.deviceChanged(id) } }
		}
	#endif

	/// `MASKIN_API_BASE_URL` build setting, surfaced through Info.plist (see project.yml).
	private static var apiBaseURL: URL {
		let raw = Bundle.main.object(forInfoDictionaryKey: "MaskinAPIBaseURL") as? String
		return raw.flatMap(URL.init(string:)) ?? URL(string: "https://maskin.io")!
	}
}
