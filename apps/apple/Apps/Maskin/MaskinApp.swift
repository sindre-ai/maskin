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

	init() {
		#if os(macOS)
			let source = "macos"
			let platform = DevicePlatform.macos
		#else
			let source = "ios"
			let platform = DevicePlatform.ios
		#endif
		let environment = AppEnvironment(
			baseURL: Self.apiBaseURL, clientSource: source, secretStore: KeychainSecretStore())
		environment.auth.restore()
		_environment = State(initialValue: environment)
		let registrar = PushRegistrar(
			system: SystemPushSystem(), devices: APIDeviceRegistrar(client: environment.client),
			environment: .detect(), platform: platform,
			appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
		)
		#if os(iOS)
			Self.setUpLiveActivity(environment: environment, registrar: registrar)
		#endif
		_push = State(initialValue: registrar)
	}

	var body: some Scene {
		WindowGroup {
			RootView(environment: environment, push: push) { runtime in
				pushDelegate.attach(registrar: push, router: runtime.router)
			}
		}
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
			registrar.onDeviceChanged = { id in Task { await coordinator.deviceChanged(id) } }
		}
	#endif

	/// `MASKIN_API_BASE_URL` build setting, surfaced through Info.plist (see project.yml).
	private static var apiBaseURL: URL {
		let raw = Bundle.main.object(forInfoDictionaryKey: "MaskinAPIBaseURL") as? String
		return raw.flatMap(URL.init(string:)) ?? URL(string: "https://maskin.io")!
	}
}
