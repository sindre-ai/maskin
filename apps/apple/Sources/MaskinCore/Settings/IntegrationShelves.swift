import Foundation

/// What the Integrations page shows for a search and a pill: the needs-attention strip, Your
/// integrations, Popular, New and All integrations, or one filtered list. Mirrors
/// `apps/web/src/lib/integration-shelves.ts` and the page that reads it; change both together.
public struct IntegrationShelves: Equatable, Sendable {
	/// Connected tools shown before the Show all button.
	public static let yoursVisible = 5
	public static let popularLimit = 8
	public static let newLimit = 6

	/// The Slack scopes that read channel history; their absence has its own line.
	static let slackHistoryScopes: Set<String> = ["channels:history", "groups:history", "mpim:history"]

	/// One line of the needs-attention strip and the button that fixes it.
	public struct AttentionItem: Equatable, Identifiable, Sendable {
		public enum Fix: Equatable, Sendable {
			/// Sign in again to grant new permissions.
			case reconnect(providerID: String)
			/// A half-finished setup (Resend's webhook signing secret).
			case finishSetup(providerID: String)
		}

		public var id: String
		public var name: String
		public var line: String
		public var fix: Fix

		public var actionLabel: String {
			switch fix {
			case .reconnect: "Reconnect"
			case .finishSetup: "Finish setup"
			}
		}
	}

	/// The tools of one category, A to Z.
	public struct Group: Equatable, Identifiable, Sendable {
		public var category: IntegrationCategory
		public var providers: [IntegrationProvider]
		public var id: String { category.id }
	}

	/// Broken tools, whatever the search and pill say, so a filter never hides one.
	public var attention: [AttentionItem] = []
	/// Connected accounts that match, broken ones first.
	public var yours: [ConnectedIntegration] = []
	/// Tool servers that match. They show under All and Custom only.
	public var servers: [ConnectedIntegration] = []
	public var popular: [IntegrationProvider] = []
	public var fresh: [IntegrationProvider] = []
	public var groups: [Group] = []
	/// With a search or a pill other than All, every tool not yet connected that matches.
	public var results: [IntegrationProvider] = []
	public var isFiltered = false
	/// "Results for “x”" for a search, the pill's name for a pill.
	public var resultsTitle = ""
	/// "No integration matches that search" or "...that filter" when a filter finds nothing at all.
	public var emptyText: String?
	/// Nothing is connected and nothing is filtered: Your integrations shows the invitation.
	public var nothingConnected = false

	/// Your integrations without the Show all button: the first five accounts, then the servers
	/// once the list is expanded.
	public func visibleYours(expanded: Bool) -> [ConnectedIntegration] {
		expanded || yours.count <= Self.yoursVisible ? yours : Array(yours.prefix(Self.yoursVisible))
	}

	/// Tool servers sit under the accounts, so they wait until the list is expanded.
	public func visibleServers(expanded: Bool) -> [ConnectedIntegration] {
		expanded || yours.count <= Self.yoursVisible ? servers : []
	}

	public func showsToggle() -> Bool { yours.count > Self.yoursVisible }

	/// The number on the Show all button: accounts plus tool servers.
	public var yoursCount: Int { yours.count + servers.count }
}

extension IntegrationsStore {
	/// A connected account counts as connected for the shelves when its token works, including one
	/// that needs more permissions. A half-finished or revoked row does not.
	nonisolated static func isActive(_ integration: ConnectedIntegration) -> Bool {
		switch integration.state {
		case .connected, .needsReconnect: true
		case .incomplete, .disconnected: false
		}
	}

	nonisolated private static func isBroken(_ integration: ConnectedIntegration) -> Bool {
		if case .needsReconnect = integration.state { return true }
		return false
	}

	/// The page for the typed `query` and the chosen `pill`.
	public func shelves(query: String, pill: IntegrationPill, now: Date = Date()) -> IntegrationShelves {
		let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
		let tools = providers.filter { $0.id != Self.toolServerProvider }
			.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
		let activeAccounts = accounts.filter(Self.isActive)
		let connectedIDs = Set(activeAccounts.map(\.provider))

		var shelves = IntegrationShelves()
		shelves.isFiltered = !needle.isEmpty || pill != .all
		shelves.attention = attentionItems()

		let matching = tools.filter {
			pill.matches(providerID: $0.id) && (needle.isEmpty || $0.displayName.localizedCaseInsensitiveContains(needle))
		}
		let matchingAccounts = activeAccounts.filter {
			pill.matches(providerID: $0.provider)
				&& (needle.isEmpty || displayName(for: $0).localizedCaseInsensitiveContains(needle))
		}
		shelves.yours = matchingAccounts.filter(Self.isBroken) + matchingAccounts.filter { !Self.isBroken($0) }

		let showsServers = pill == .all || pill == .category(.custom)
		if showsServers {
			shelves.servers = toolServers.filter {
				needle.isEmpty || displayName(for: $0).localizedCaseInsensitiveContains(needle)
			}
		}

		let availableMatching = matching.filter { !connectedIDs.contains($0.id) }
		if shelves.isFiltered {
			shelves.results = availableMatching
			shelves.resultsTitle = needle.isEmpty ? pill.label : "Results for “\(needle)”"
			if shelves.yours.isEmpty, shelves.servers.isEmpty, availableMatching.isEmpty {
				shelves.emptyText =
					needle.isEmpty ? "No integration matches that filter" : "No integration matches that search"
			}
		} else {
			let unconnected = tools.filter { !connectedIDs.contains($0.id) }
			shelves.popular = shelf(
				IntegrationCatalog.popularProviderIDs(), from: unconnected, limit: IntegrationShelves.popularLimit)
			shelves.fresh = shelf(
				IntegrationCatalog.newProviderIDs(now: now), from: unconnected, limit: IntegrationShelves.newLimit)
			shelves.groups = IntegrationCategory.allCases.compactMap { category in
				let inCategory = availableMatching.filter { IntegrationCategory.category(for: $0.id) == category }
				return inCategory.isEmpty ? nil : IntegrationShelves.Group(category: category, providers: inCategory)
			}
			shelves.nothingConnected = activeAccounts.isEmpty && toolServers.isEmpty
		}
		return shelves
	}

	/// The tools of a shelf, in the shelf's order, for tools the workspace has not connected.
	private func shelf(_ ids: [String], from unconnected: [IntegrationProvider], limit: Int) -> [IntegrationProvider] {
		let byID = Dictionary(unconnected.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
		return Array(ids.compactMap { byID[$0] }.prefix(limit))
	}

	/// One line per tool the workspace has to fix: a token that needs more permissions, or a Resend
	/// setup left half done.
	private func attentionItems() -> [IntegrationShelves.AttentionItem] {
		var items: [IntegrationShelves.AttentionItem] = []
		for integration in accounts {
			let name = displayName(for: integration)
			switch integration.state {
			case .needsReconnect(let missing):
				let slackHistory =
					integration.provider == "slack"
					&& integration.missingScopeNames.contains { IntegrationShelves.slackHistoryScopes.contains($0) }
				let line =
					slackHistory
					? "Slack needs to be reconnected. Agents can't read channel history until you do."
					: "\(name): update needed. Reconnect to grant \(missing) new permission\(missing == 1 ? "" : "s")."
				items.append(
					.init(id: integration.id, name: name, line: line, fix: .reconnect(providerID: integration.provider)))
			case .incomplete where integration.provider == Self.resendProvider:
				items.append(
					.init(
						id: integration.id, name: name,
						line: "Resend setup isn't finished. It's waiting for the webhook signing secret.",
						fix: .finishSetup(providerID: integration.provider)))
			default:
				break
			}
		}
		return items
	}

	nonisolated public static let resendProvider = "resend"
}
