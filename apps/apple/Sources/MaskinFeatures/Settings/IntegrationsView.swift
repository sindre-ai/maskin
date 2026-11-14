import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Integrations (2B): every account a flow can use with its state: connected, needs sign-in, or
/// not connected. OAuth providers connect in a system sign-in sheet, key providers on a form, and
/// the few that need a computer say so. Nothing here opens the web app. Disconnecting is here.
struct IntegrationsView: View {
	@Environment(\.scenePhase) private var scenePhase
	@State private var store: IntegrationsStore
	@State private var actionTarget: ConnectedIntegration?
	@State private var pendingDisconnect: ConnectedIntegration?
	@State private var showAddToolServer = false
	@State private var showClaude = false
	/// The key provider whose form is open (PostHog).
	@State private var keyProviderID: String?
	@State private var accessTarget: ConnectedIntegration?
	@State private var tab: Tab = .connected
	@State private var query = ""
	/// Nil is the All chip.
	@State private var category: IntegrationCategory?
	/// Agents for the Agent access page, read from the member list when the page opens.
	@State private var accessAgents: [IntegrationAccessStore.AgentRef] = []
	enum Tab: Hashable { case connected, discover }

	/// Builds the pages Integrations pushes (v3): Add tool server and Import from Claude. Nil in
	/// previews, which drops those rows.
	let services: SettingsServices?

	init(store: IntegrationsStore, services: SettingsServices? = nil) {
		_store = State(initialValue: store)
		self.services = services
	}

	var body: some View {
		dialogs(destinations(page))
	}

	private var page: some View {
		WorkspacePage(title: "Integrations") {
			Picker("Integrations", selection: $tab) {
				Text("Connected \(store.connectedCount)").tag(Tab.connected)
				Text("Discover \(store.discoverCount)").tag(Tab.discover)
			}
			.pickerStyle(.segmented)
			categoryChips
			if tab == .connected { connectedContent } else { discoverContent }
			if let error = store.actionError { FormError(error) }
			if let notice = store.connectNotice {
				if notice.kind == .failure {
					FormError(notice.text)
				} else {
					PageFootnote(text: notice.text)
						.accessibilityAddTraits(.updatesFrequently)
				}
			}
			PageFootnote(
				text: store.canManage
					? "Connecting signs you in with the provider. When you come back, this list refreshes."
					: "Only owners and admins can connect or disconnect an integration.")
		}
		.searchable(text: $query, prompt: "Search integrations and tools")
	}

	/// All, then one chip per category, in the order the web shows them.
	private var categoryChips: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s4) {
				AgentFilterChip(label: "All", selected: category == nil, outlined: true) { category = nil }
				ForEach(IntegrationCategory.allCases) { chip in
					AgentFilterChip(label: chip.label, selected: category == chip, outlined: true) {
						category = chip
					}
				}
			}
		}
	}

	@ViewBuilder private var connectedContent: some View {
		let accounts = connectedRows
		let servers = toolServerRows
		if accounts.isEmpty && servers.isEmpty && !isSearching {
			switch store.phase {
			case .failed(let message): PageStatus(text: message)
			case .loaded: PageStatus(text: "Nothing connected yet.")
			default: PageStatus(text: "Loading integrations")
			}
		} else if accounts.isEmpty && servers.isEmpty {
			PageStatus(text: "No integration matches that search.")
		}
		if !accounts.isEmpty { PageCard(rows: accounts) }
		if !servers.isEmpty { PageCard(rows: servers) }
		if !isSearching, category == nil || category == .custom {
			addServerCard
		}
	}

	@ViewBuilder private var discoverContent: some View {
		let rows = discoverRows
		if rows.isEmpty {
			PageStatus(text: isSearching ? "No integration matches that search." : "Nothing to discover.")
		} else {
			PageCard(rows: rows)
		}
	}

	private var isSearching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

	/// "Add your own MCP server" and the Claude import, hidden while searching.
	private var addRows: [PageRowModel] {
		var rows: [PageRowModel] = []
		if store.canManage, services != nil {
			rows.append(
				PageRowModel(
					id: "add-tool-server", title: "Add your own MCP server",
					subtitle: "Paste a server URL and choose what your agents can use.",
					showsChevron: true, action: { showAddToolServer = true }))
		}
		if services != nil {
			rows.append(
				PageRowModel(
					id: "claude", title: "Import from Claude",
					subtitle: "Use a Claude subscription as the model source", showsChevron: true,
					action: { showClaude = true }))
		}
		return rows
	}

	@ViewBuilder private var addServerCard: some View {
		let rows = addRows
		if !rows.isEmpty { PageCard(rows: rows) }
	}

	private func destinations(_ view: some View) -> some View {
		view
		.task { await store.load() }
		.refreshable { await store.load() }
		.navigationDestination(isPresented: $showAddToolServer) {
			if let services { AddToolServerView(store: services.addToolServerStore()) { Task { await store.load() } } }
		}
		.navigationDestination(item: $accessTarget) { integration in
			if let services {
				IntegrationAccessView(
					store: services.integrationAccessStore(integrationId: integration.id, agents: accessAgents),
					title: store.displayName(for: integration),
					scopes: IntegrationScopesStore(http: services.http, integrationID: integration.id),
					onReconnect: store.canManage && store.supportsNativeConnect(integration.provider)
						? { startConnect(integration.provider) } : nil)
			}
		}
		.navigationDestination(item: $keyProviderID) { providerID in
			if let services {
				ConnectWithKeyView(
					store: services.connectWithKeyStore(
						providerID: providerID, providerName: store.connectName(providerID))
				) {
					store.dismissNotice()
					Task { await store.load() }
				}
			}
		}
		.navigationDestination(isPresented: $showClaude) {
			if let services { ClaudeAccountView(store: services.claudeAccountStore()) }
		}
	}

	private func dialogs(_ view: some View) -> some View {
		view
		// Back in the app: pick up anything that changed while it was away.
		.onChange(of: scenePhase) { _, phase in
			if phase == .active { Task { await store.load() } }
		}
		.confirmationDialog(
			actionTarget.map { store.displayName(for: $0) } ?? "Integration",
			isPresented: Binding(get: { actionTarget != nil }, set: { if !$0 { actionTarget = nil } }),
			titleVisibility: .visible, presenting: actionTarget
		) { integration in
			if integration.provider == IntegrationsStore.toolServerProvider {
				EmptyView()
			} else if store.canManage, store.canStartConnect(integration.provider),
				integration.state != .connected
			{
				Button("Reconnect") { startConnectFlow(integration.provider) }
			}
			if services != nil, integration.state == .connected {
				Button("Agent access") { openAccess(integration) }
			}
			Button(
				integration.provider == IntegrationsStore.toolServerProvider ? "Remove" : "Disconnect",
				role: .destructive
			) { pendingDisconnect = integration }
		}
		.confirmationDialog(
			"Choose a GitHub account",
			isPresented: Binding(
				get: { store.installationPicker != nil },
				set: { if !$0 { store.cancelInstallationChoice() } }),
			titleVisibility: .visible
		) {
			ForEach(store.installationPicker?.choices ?? []) { choice in
				Button(choice.name ?? "GitHub account") { Task { await store.chooseInstallation(choice) } }
			}
		} message: {
			Text("You can reach more than one. Pick the one Maskin should use.")
		}
		.confirmationDialog(
			pendingDisconnect.map { "Disconnect \(store.displayName(for: $0))?" } ?? "Disconnect?",
			isPresented: Binding(
				get: { pendingDisconnect != nil }, set: { if !$0 { pendingDisconnect = nil } }),
			titleVisibility: .visible, presenting: pendingDisconnect
		) { integration in
			Button("Disconnect", role: .destructive) { Task { await store.disconnect(integration) } }
		} message: { integration in
			Text("Agents lose access to \(store.displayName(for: integration)) until you connect it again.")
		}
	}

	private var connectedRows: [PageRowModel] {
		store.connectedAccounts(query: query, category: category).map { integration in
			PageRowModel(
				id: integration.id, title: store.displayName(for: integration),
				subtitle: integration.state == .connected
					? integration.note
						?? WorkspacePageState.integrationSubtitle(
							integration.state, account: store.accountLabel(for: integration))
					: WorkspacePageState.integrationSubtitle(
						integration.state, account: store.accountLabel(for: integration)),
				accessory: .state(
					isConnecting(integration.provider)
						? WorkspacePageState.integrationConnecting
						: WorkspacePageState.integration(integration.state)),
				action: store.canManage && !store.isConnectInFlight ? { actionTarget = integration } : nil)
		}
	}

	private var discoverRows: [PageRowModel] {
		store.availableProviders(query: query, category: category).map { provider in
			PageRowModel(
				id: "available-\(provider.id)", title: provider.displayName,
				subtitle: WorkspacePageState.integrationAvailableSubtitle,
				accessory: .state(
					isConnecting(provider.id)
						? WorkspacePageState.integrationConnecting : WorkspacePageState.integrationAvailable),
				action: availableAction(provider))
		}
	}

	/// Tool servers a person added. Adding one is the "Add your own MCP server" card; the server
	/// only accepts people, which the add page reports if an agent key is signed in.
	private var toolServerRows: [PageRowModel] {
		store.connectedToolServers(query: query, category: category).map { server in
			PageRowModel(
				id: server.id, title: store.displayName(for: server),
				subtitle: server.state == .connected ? nil : WorkspacePageState.integrationSubtitle(server.state, account: nil),
				accessory: .state(WorkspacePageState.integration(server.state)),
				action: store.canManage && !store.isConnectInFlight ? { actionTarget = server } : nil)
		}
	}

	private func isConnecting(_ providerID: String) -> Bool { store.connectPhase.provider == providerID }

	private func startConnect(_ providerID: String) {
		Task { await store.connect(providerID: providerID) }
	}

	/// OAuth providers connect in the sheet (and ignore taps while one is running), key providers
	/// open their form, and the rest explain they are set up from a computer.
	private func availableAction(_ provider: IntegrationProvider) -> (() -> Void)? {
		guard store.canManage, store.canStartConnect(provider.id) else { return nil }
		return store.isConnectInFlight ? nil : { startConnectFlow(provider.id) }
	}

	private func startConnectFlow(_ providerID: String) {
		if store.supportsNativeConnect(providerID) {
			startConnect(providerID)
		} else if store.connectsWithKey(providerID), services != nil {
			keyProviderID = providerID
		} else {
			store.explainComputerOnly(providerID)
		}
	}

	/// Reads the workspace's agents, then pushes the page. A failed read still opens it with no
	/// rows, which the page words as "No agents".
	private func openAccess(_ integration: ConnectedIntegration) {
		guard let services else { return }
		Task {
			let members: [WorkspaceMember] =
				(try? await services.source?.list(workspaceId: services.workspaceId ?? "")) ?? []
			accessAgents = members.filter(\.isAgent).map { .init(id: $0.actorId, name: $0.name) }
			accessTarget = integration
		}
	}

}
