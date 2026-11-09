import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What one connection was granted, and what it still asks for (v3 GitHub page: Installations and
/// Scopes). Read from `GET /api/integrations`: `grantedScopes`, `missingScopes` and, for GitHub,
/// the account name in `config.owner_login`.
struct IntegrationScopes: Equatable, Sendable {
	var owner: String?
	var isActive: Bool
	var granted: [String]
	var missing: [String]

	var needsReconnect: Bool { !missing.isEmpty || !isActive }

	static func parse(_ json: Any?, integrationID: String) -> IntegrationScopes? {
		guard let row = (json as? [[String: Any]])?.first(where: { $0["id"] as? String == integrationID })
		else { return nil }
		let config = row["config"] as? [String: Any]
		let owner = (config?["owner_login"] as? String).flatMap { $0.isEmpty ? nil : $0 }
		return IntegrationScopes(
			owner: owner, isActive: row["status"] as? String == "active",
			granted: row["grantedScopes"] as? [String] ?? [], missing: row["missingScopes"] as? [String] ?? [])
	}
}

@MainActor
@Observable
final class IntegrationScopesStore {
	private(set) var scopes: IntegrationScopes?
	@ObservationIgnored private let http: SettingsHTTP
	@ObservationIgnored private let integrationID: String

	init(http: SettingsHTTP, integrationID: String) {
		self.http = http
		self.integrationID = integrationID
	}

	func load() async {
		guard let (data, status) = try? await http.send("GET", "api/integrations"), (200..<300).contains(status)
		else { return }
		let json = try? JSONSerialization.jsonObject(with: data)
		if let parsed = IntegrationScopes.parse(json, integrationID: integrationID) { scopes = parsed }
	}
}

/// The Installation and Scopes groups, with Reconnect when the connection is out of date.
struct IntegrationScopesBlock: View {
	let store: IntegrationScopesStore
	let providerName: String
	var onReconnect: (() -> Void)?

	var body: some View {
		if let scopes = store.scopes {
			PageGroupLabel(text: "Installation")
			PageCard(rows: [
				PageRowModel(
					id: "owner", title: scopes.owner ?? providerName,
					subtitle: scopes.missing.isEmpty ? nil : "Needs new permissions",
					accessory: .state(
						!scopes.isActive ? PageState("Reconnect", .notice)
							: scopes.missing.isEmpty ? PageState("Active", .active) : PageState("Update needed", .notice)))
			])
			if !scopes.granted.isEmpty || !scopes.missing.isEmpty {
				PageGroupLabel(text: "Scopes")
				PageCard(
					rows: scopes.granted.map {
						PageRowModel(id: "g-\($0)", title: $0, accessory: .state(PageState("Granted", .active)))
					}
						+ scopes.missing.map {
							PageRowModel(
								id: "m-\($0)", title: $0, subtitle: "Reconnect to approve.",
								accessory: .state(PageState("Requested", .notice)))
						})
			}
			if scopes.needsReconnect, let onReconnect {
				Button("Reconnect \(scopes.owner ?? providerName)", action: onReconnect).buttonStyle(.primaryAction)
			}
		}
	}
}
