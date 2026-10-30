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
		@State private var watchPublisher: WatchSnapshotPublisher?
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
		Perf.event("app.init")
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
			system: SystemPushSystem(), devices: APIDeviceRegistrar(
				baseURL: environment.baseURL, clientSource: environment.clientSource,
				credentials: environment.auth.credentialsProvider),
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
				#if os(iOS)
					// The wrist's offline copy of Needs you, the briefing and the flows.
					watchPublisher?.stop()
					let publisher = WatchSnapshotPublisher(environment: environment, bridge: watchBridge)
					publisher.start(runtime: runtime)
					watchPublisher = publisher
				#endif
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
				// Hand the sign-in to the paired watch, and again whenever it changes; point the
				// "Agents working" activity at the signed-in workspace.
				.onChange(of: environment.auth.session, initial: true) { _, session in
					watchBridge.publish(session)
					Task { await AgentsActivityRuntime.shared?.sessionChanged(workspaceId: session?.workspaceId) }
					Task { await CycleActivityController.shared?.workspaceChanged(session?.workspaceId) }
				}
			#endif
		}
		#if os(iOS)
			// Stage Manager and Split View may shrink the window, but never below 320 × 480.
			.windowResizability(.contentMinSize)
			.onChange(of: scenePhase) { _, phase in
				if phase == .background { BackgroundRefresh.schedule() }
				// Back in front: the agents card has no push path on this server, so refetch now.
				if phase == .active { Task { await AgentsActivityRuntime.shared?.refresh() } }
			}
		#endif
		.commands { ShellCommands() }
	}

	#if os(iOS)
		/// "Agents working" Live Activity: ActivityKit host, the workspace-wide feed of running
		/// sessions, and token registration (against the device id `PushRegistrar` gets from
		/// `POST /api/devices`). The open thread adds its turns through `AgentsActivityCoordinator.shared`.
		private static func setUpLiveActivity(environment: AppEnvironment, registrar: PushRegistrar) {
			let host = AgentsActivityHost()
			let coordinator = AgentsActivityCoordinator(
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
			AgentsActivityCoordinator.shared = coordinator
			host.attach(coordinator)
			AgentsActivityRuntime.shared = AgentsActivityRuntime(environment: environment, coordinator: coordinator)
			CycleActivityController.shared = CycleActivityController(host: CycleActivityHost())
			MeetingActivityController.shared = MeetingActivityController(host: MeetingActivityHost())
			environment.auth.onSessionEnded { ending in
				let creds = APILiveActivityTokens.Credentials(
					apiKey: ending.apiKey, workspaceId: ending.workspaceId)
				Task {
					await AgentsActivityRuntime.shared?.sessionChanged(workspaceId: nil)
					await CycleActivityController.shared?.workspaceChanged(nil)
					await coordinator.signedOut(credentials: creds)
				}
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
