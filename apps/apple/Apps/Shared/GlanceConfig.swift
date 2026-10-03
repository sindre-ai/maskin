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
		let environment = AppEnvironment(
			baseURL: apiBaseURL, clientSource: clientSource, secretStore: KeychainSecretStore())
		environment.auth.restore()
		return environment
	}
}
