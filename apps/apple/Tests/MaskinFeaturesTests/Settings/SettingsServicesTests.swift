import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

@MainActor
@Suite("SettingsServices")
struct SettingsServicesTests {
	@Test("the API source follows a workspace switch instead of capturing the first id")
	func sourceTracksWorkspace() {
		let environment = AppEnvironment.preview()
		let services = SettingsServices(environment: environment)
		#expect(services.source?.workspaceID == "ws-1")
		environment.auth.selectWorkspace("ws-2")
		#expect(services.source?.workspaceID == "ws-2")
		#expect(services.workspaceId == "ws-2")
	}

	@Test("web URLs have no doubled slash for a trailing-slash base")
	func webURLNoDoubleSlash() {
		let base = URL(string: "https://app.maskin.io/")!
		let web = SettingsServices.webBaseURL(override: nil, apiBaseURL: base)
		let url = web.appendingPathComponent("ws-1").appendingPathComponent("settings")
			.appendingPathComponent("billing")
		#expect(!url.absoluteString.dropFirst(8).contains("//"))
		#expect(url.absoluteString == "https://app.maskin.io/ws-1/settings/billing")
	}

	@Test("a web base override wins; a junk override is ignored")
	func webBaseOverride() {
		let api = URL(string: "http://localhost:3000")!
		#expect(
			SettingsServices.webBaseURL(override: "http://localhost:5173", apiBaseURL: api).absoluteString
				== "http://localhost:5173")
		#expect(SettingsServices.webBaseURL(override: "javascript:alert(1)", apiBaseURL: api) == api)
		#expect(SettingsServices.webBaseURL(override: nil, apiBaseURL: api) == api)
	}

	@Test("webURL builds the settings path for the live workspace")
	func webURLPath() {
		let environment = AppEnvironment.preview()
		let services = SettingsServices(environment: environment)
		#expect(services.webURL("billing")?.path == "/ws-1/settings/billing")
		environment.auth.selectWorkspace("ws-2")
		#expect(services.webURL("billing")?.path == "/ws-2/settings/billing")
	}

	@Test("a masked key is announced as hidden, never as bullets")
	func keyAccessibility() {
		#expect(SecretKeyCard.accessibilityText("ank••••••••ab12", isRevealed: false) == "API key hidden")
		#expect(SecretKeyCard.accessibilityText("ank_real", isRevealed: true) == "ank_real")
	}
}
