import Foundation
import Testing

@testable import MaskinCore

/// 25 Nov 2026, midnight UTC: the New shelf holds what shipped in the 30 days before it.
private let nov25 = Date(timeIntervalSince1970: 1_795_564_800)
/// 30 Dec 2026: every tool in the catalog is older than 30 days by then.
private let dec30 = Date(timeIntervalSince1970: 1_798_588_800)

@Suite("Integration catalog")
struct IntegrationCatalogTests {
	@Test("the pill row is All, Google, Microsoft, then the ten categories")
	func pillRow() {
		#expect(
			IntegrationPill.row.map(\.label) == [
				"All", "Google", "Microsoft", "Email & calendar", "Files", "Docs & data", "Chat & social", "Code",
				"Design", "Sales & payments", "Accounting", "Analytics", "Custom",
			])
		#expect(Set(IntegrationPill.row.map(\.id)).count == 13)
	}

	@Test("a vendor pill matches the tools of that company across categories")
	func vendorPills() {
		let google = IntegrationPill.vendor(.google)
		#expect(google.matches(providerID: "gmail"))
		#expect(google.matches(providerID: "google-drive"))
		#expect(google.matches(providerID: "google-search-console"))
		#expect(!google.matches(providerID: "slack"))
		#expect(IntegrationPill.vendor(.microsoft).matches(providerID: "power-bi"))
		#expect(IntegrationPill.category(.analytics).matches(providerID: "power-bi"))
		#expect(IntegrationPill.all.matches(providerID: "anything"))
	}

	@Test("popular is the featured list in its own order")
	func popular() {
		#expect(
			IntegrationCatalog.popularProviderIDs() == [
				"gmail", "google-calendar", "slack", "github", "google-drive", "notion", "linear", "hubspot",
			])
	}

	@Test("new is what shipped in the last 30 days, newest first")
	func newProviders() {
		let ids = IntegrationCatalog.newProviderIDs(now: nov25)
		#expect(ids.first == "brevo")
		#expect(ids.contains("zoom"))
		#expect(!ids.contains("slack"))
		#expect(IntegrationCatalog.newProviderIDs(now: dec30).isEmpty)
		// Nothing is new before it shipped.
		#expect(IntegrationCatalog.newProviderIDs(now: Date(timeIntervalSince1970: 0)).isEmpty)
	}

	@Test("day 30 is still new and day 31 is not")
	func newWindowEdge() {
		// Shipped on 1 Nov 2026: 1 Dec is 30 days later, 2 Dec is 31.
		let dec1 = Date(timeIntervalSince1970: 1_796_083_200)
		let dec2 = Date(timeIntervalSince1970: 1_796_169_600)
		#expect(IntegrationCatalog.isNew(addedOn: "2026-11-01", now: dec1))
		#expect(!IntegrationCatalog.isNew(addedOn: "2026-11-01", now: dec2))
		#expect(!IntegrationCatalog.isNew(addedOn: nil, now: dec1))
		#expect(!IntegrationCatalog.isNew(addedOn: "not a date", now: dec1))
	}

	@Test("a written line is kept for the tools that have one")
	func descriptions() {
		#expect(IntegrationCatalog.description(for: "slack") == "Channels and triggers")
		#expect(IntegrationCatalog.description(for: "box") == nil)
	}

	@Test("a tool the catalog does not know sits under Docs & data")
	func unknownTool() {
		#expect(IntegrationCategory.category(for: "brand-new") == .docsAndData)
		#expect(IntegrationCategory.category(for: IntegrationsStore.toolServerProvider) == .custom)
	}
}

@Suite("Integration shelves")
struct IntegrationShelvesTests {
	@MainActor private func loadedStore(
		providers: [IntegrationProvider], connected: [ConnectedIntegration], role: MemberRole = .admin
	) async -> IntegrationsStore {
		let fake = FakeSettings()
		fake.providerList = providers
		fake.connectedList = connected
		let store = IntegrationsStore(api: fake, currentRole: role)
		await store.load()
		return store
	}

	private func provider(_ id: String, _ name: String, _ auth: IntegrationProvider.AuthKind = .oauth)
		-> IntegrationProvider
	{
		IntegrationProvider(id: id, displayName: name, authKind: auth)
	}

	private let catalog = [
		IntegrationProvider(id: "github", displayName: "GitHub", authKind: .oauth),
		IntegrationProvider(id: "gmail", displayName: "Gmail", authKind: .oauth),
		IntegrationProvider(id: "google-calendar", displayName: "Google Calendar", authKind: .oauth),
		IntegrationProvider(id: "slack", displayName: "Slack", authKind: .oauth),
		IntegrationProvider(id: "posthog", displayName: "PostHog", authKind: .apiKey),
		IntegrationProvider(id: "resend", displayName: "Resend", authKind: .manual),
	]

	@MainActor @Test("the default page has Popular, New and the groups, and nothing connected")
	func defaultPage() async {
		let store = await loadedStore(providers: catalog, connected: [])
		let page = store.shelves(query: "", pill: .all, now: nov25)
		#expect(!page.isFiltered)
		#expect(page.nothingConnected)
		#expect(page.attention.isEmpty)
		#expect(page.popular.map(\.id) == ["gmail", "google-calendar", "slack", "github"])
		#expect(page.groups.map(\.category) == [.emailAndCalendar, .chatAndSocial, .code, .analytics])
		// A tool on Popular also sits in its group, on purpose.
		#expect(page.groups.first { $0.category == .chatAndSocial }?.providers.map(\.id) == ["slack"])
		// A to Z inside a group.
		#expect(
			page.groups.first { $0.category == .emailAndCalendar }?.providers.map(\.id)
				== ["gmail", "google-calendar", "resend"])
	}

	@MainActor @Test("connected tools leave Popular and the groups, and show under Your integrations")
	func connectedLeaveTheShelves() async {
		let store = await loadedStore(
			providers: catalog,
			connected: [ConnectedIntegration(id: "c1", provider: "slack", state: .connected)])
		let page = store.shelves(query: "", pill: .all, now: nov25)
		#expect(!page.nothingConnected)
		#expect(page.yours.map(\.id) == ["c1"])
		#expect(!page.popular.map(\.id).contains("slack"))
		#expect(page.groups.flatMap(\.providers).map(\.id).contains("slack") == false)
	}

	@MainActor @Test("the New shelf is empty once nothing is inside 30 days")
	func newShelf() async {
		let store = await loadedStore(
			providers: catalog + [provider("brevo", "Brevo"), provider("coda", "Coda")], connected: [])
		#expect(store.shelves(query: "", pill: .all, now: nov25).fresh.map(\.id) == ["brevo", "coda"])
		#expect(store.shelves(query: "", pill: .all, now: dec30).fresh.isEmpty)
	}

	@MainActor @Test("Your integrations puts broken tools first and folds after five")
	func yoursOrderAndFold() async {
		let ids = ["a1", "a2", "a3", "a4", "a5", "a6"]
		var connected = ids.map { ConnectedIntegration(id: $0, provider: $0, state: .connected) }
		connected.append(
			ConnectedIntegration(id: "broken", provider: "zzz", state: .needsReconnect(missingScopes: 1)))
		let store = await loadedStore(
			providers: ids.map { provider($0, "Tool \($0)") } + [provider("zzz", "Zed")], connected: connected)
		let page = store.shelves(query: "", pill: .all, now: nov25)
		#expect(page.yours.first?.id == "broken")
		#expect(page.yours.count == 7)
		#expect(page.showsToggle())
		#expect(page.visibleYours(expanded: false).count == 5)
		#expect(page.visibleYours(expanded: true).count == 7)
		#expect(page.yoursCount == 7)
	}

	@MainActor @Test("tool servers wait for Show all when the list is long")
	func serversWaitWhenFolded() async {
		let ids = ["a1", "a2", "a3", "a4", "a5", "a6"]
		var connected = ids.map { ConnectedIntegration(id: $0, provider: $0, state: .connected) }
		connected.append(
			ConnectedIntegration(
				id: "srv", provider: IntegrationsStore.toolServerProvider, state: .connected, displayName: "crm"))
		let store = await loadedStore(providers: ids.map { provider($0, "Tool \($0)") }, connected: connected)
		let page = store.shelves(query: "", pill: .all, now: nov25)
		#expect(page.visibleServers(expanded: false).isEmpty)
		#expect(page.visibleServers(expanded: true).map(\.id) == ["srv"])
		#expect(page.yoursCount == 7)
	}

	@MainActor @Test("needs attention names each broken tool and ignores the search and the pill")
	func attention() async {
		let store = await loadedStore(
			providers: catalog,
			connected: [
				ConnectedIntegration(
					id: "s", provider: "slack", state: .needsReconnect(missingScopes: 2),
					missingScopeNames: ["channels:history", "chat:write"]),
				ConnectedIntegration(id: "g", provider: "gmail", state: .needsReconnect(missingScopes: 1)),
				ConnectedIntegration(id: "r", provider: "resend", state: .incomplete),
			])
		let page = store.shelves(query: "zzz", pill: .category(.code), now: nov25)
		#expect(page.isFiltered)
		#expect(page.attention.map(\.id) == ["g", "r", "s"])
		let lines = Dictionary(uniqueKeysWithValues: page.attention.map { ($0.id, $0.line) })
		#expect(lines["s"] == "Slack needs to be reconnected. Agents can't read channel history until you do.")
		#expect(lines["g"] == "Gmail: update needed. Reconnect to grant 1 new permission.")
		#expect(lines["r"] == "Resend setup isn't finished. It's waiting for the webhook signing secret.")
		#expect(page.attention.map(\.actionLabel) == ["Reconnect", "Finish setup", "Reconnect"])
		#expect(page.attention.first { $0.id == "r" }?.fix == .finishSetup(providerID: "resend"))
	}

	@MainActor @Test("a Slack token missing other scopes gets the generic line")
	func slackWithoutHistory() async {
		let store = await loadedStore(
			providers: catalog,
			connected: [
				ConnectedIntegration(
					id: "s", provider: "slack", state: .needsReconnect(missingScopes: 2),
					missingScopeNames: ["chat:write", "users:read"])
			])
		let line = store.shelves(query: "", pill: .all, now: nov25).attention.first?.line
		#expect(line == "Slack: update needed. Reconnect to grant 2 new permissions.")
	}

	@MainActor @Test("a half-finished or revoked tool is not connected: it is offered again")
	func inactiveRows() async {
		let store = await loadedStore(
			providers: catalog,
			connected: [
				ConnectedIntegration(id: "r", provider: "resend", state: .incomplete),
				ConnectedIntegration(id: "p", provider: "posthog", state: .disconnected),
			])
		let page = store.shelves(query: "", pill: .all, now: nov25)
		#expect(page.yours.isEmpty)
		#expect(page.nothingConnected)
		let offered = page.groups.flatMap(\.providers).map(\.id)
		#expect(offered.contains("resend"))
		#expect(offered.contains("posthog"))
	}

	@MainActor @Test("a search replaces the shelves with Results for the search")
	func searchResults() async {
		let store = await loadedStore(providers: catalog, connected: [])
		let page = store.shelves(query: "  goo ", pill: .all, now: nov25)
		#expect(page.isFiltered)
		#expect(page.resultsTitle == "Results for “goo”")
		#expect(page.results.map(\.id) == ["google-calendar"])
		#expect(page.popular.isEmpty && page.fresh.isEmpty && page.groups.isEmpty)
		#expect(page.emptyText == nil)
	}

	@MainActor @Test("a pill titles the list with its own name")
	func pillResults() async {
		let store = await loadedStore(providers: catalog, connected: [])
		let page = store.shelves(query: "", pill: .category(.code), now: nov25)
		#expect(page.resultsTitle == "Code")
		#expect(page.results.map(\.id) == ["github"])
	}

	@MainActor @Test("a filter that finds nothing says so, for a search or for a pill")
	func emptyFilter() async {
		let store = await loadedStore(providers: catalog, connected: [])
		#expect(
			store.shelves(query: "zzz", pill: .all, now: nov25).emptyText == "No integration matches that search")
		#expect(
			store.shelves(query: "", pill: .category(.design), now: nov25).emptyText
				== "No integration matches that filter")
	}

	@MainActor @Test("connected tools that match the filter still show under Your integrations")
	func filteredYours() async {
		let store = await loadedStore(
			providers: catalog,
			connected: [ConnectedIntegration(id: "c1", provider: "slack", state: .connected)])
		let hit = store.shelves(query: "sla", pill: .all, now: nov25)
		#expect(hit.yours.map(\.id) == ["c1"])
		#expect(hit.results.isEmpty)
		#expect(hit.emptyText == nil)
		#expect(store.shelves(query: "", pill: .category(.code), now: nov25).yours.isEmpty)
	}
}
