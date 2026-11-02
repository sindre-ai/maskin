import Foundation
import MaskinAPI
import MaskinCore

/// Wiring shared by the watchOS and tvOS apps (compiled into both targets).
enum GlanceConfig {
	/// `MASKIN_API_BASE_URL` build setting, surfaced through Info.plist (see project.yml).
	static var apiBaseURL: URL {
		let raw = Bundle.main.object(forInfoDictionaryKey: "MaskinAPIBaseURL") as? String
		return raw.flatMap(URL.init(string:)) ?? URL(string: "https://maskin.io")!
	}

	/// The real environment for a glance app. `clientSource` is `watchos` or `tvos`.
	@MainActor
	static func makeEnvironment(clientSource: String) -> AppEnvironment {
		#if DEBUG
			// Design review: a session passed in the launch environment signs the app in without a
			// keyboard, against the demo server (apps/apple/scripts/demo-server). Unsigned simulator
			// builds have no Keychain, so this path keeps the session in memory. Never in Release.
			if let raw = ProcessInfo.processInfo.environment["MASKIN_DEMO_SESSION"],
				let session = try? JSONDecoder().decode(StoredSession.self, from: Data(raw.utf8))
			{
				let environment = AppEnvironment(
					baseURL: apiBaseURL, clientSource: clientSource, secretStore: InMemorySecretStore())
				try? environment.auth.adopt(session)
				return environment
			}
		#endif
		let environment = AppEnvironment(
			baseURL: apiBaseURL, clientSource: clientSource, secretStore: KeychainSecretStore())
		environment.auth.restore()
		return environment
	}
}
