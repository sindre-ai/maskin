import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Integrations (2B): one long page, the same as the web's. Pills and search under the title, a
/// needs-attention strip, Your integrations, then Popular, New and All integrations; a search or a
/// pill turns the shelves into one list. OAuth providers connect in a system sign-in sheet, key
/// providers on a form, and the few that need a computer say so. Nothing here opens the web app.
/// Disconnecting is here, and asks first.
struct IntegrationsView: View {
	@Environment(\.scenePhase) private var scenePhase
	@State private var store: IntegrationsStore
	@State private var actionTarget: ConnectedIntegration?
	@State private var pendingDisconnect: ConnectedIntegration?
	@State private var showAddToolServer = false
	@State private var showClaude = false
	/// The key provider whose form is open (PostHog).
	@State private var keyProviderID: String?
	@State private var showDriveWatches = false
	@State private var accessTarget: ConnectedIntegration?
	@State private var query = ""
	@State private var pill: IntegrationPill = .all
	/// Your integrations shows five at first; Show all expands it.
	@State private var showAllYours = false
	/// Agents for the Agent access page, read from the member list when the page opens.
	@State private var accessAgents: [IntegrationAccessStore.AgentRef] = []

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
			pillRow
			pageContent
			if let error = store.actionError { FormError(error) }
			if let notice = store.connectNotice {
				if notice.kind == .failure {
					FormError(notice.text)
				} else {
					PageFootnote(text: notice.text)
						.accessibilityAddTraits(.updatesFrequently)
				}
			}
			PageFootnote(text: SettingsRowRules.integrationsFootnote(canManage: store.canManage))
		}
		.searchable(text: $query, prompt: "Search integrations and tools")
	}

	/// All, Google, Microsoft, then one pill per category, in the order the web shows them.
	private var pillRow: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s4) {
				ForEach(IntegrationPill.row) { choice in
					AgentFilterChip(label: choice.label, selected: pill == choice, outlined: true) {
						pill = choice
					}
				}
			}
		}
	}

	@ViewBuilder private var pageContent: some View {
		switch store.phase {
		case .idle, .loading:
			PageStatus(text: "Loading integrations")
				.accessibilityAddTraits(.updatesFrequently)
		case .failed:
			loadError
		case .loaded:
			loaded(store.shelves(query: query, pill: pill))
		}
	}

	private var loadError: some View {
		VStack(spacing: MaskinSpace.s7) {
			PageStatus(text: "Couldn't load integrations")
			PageFootnote(text: "Check your connection and try again. Your connected tools are not affected.")
			Button("Try again") { Task { await store.load() } }
				.buttonStyle(.secondaryAction)
		}
	}

	@ViewBuilder private func loaded(_ shelves: IntegrationShelves) -> some View {
		attentionCard(shelves.attention)
		if let empty = shelves.emptyText { emptyFilter(empty) }
		yoursSection(shelves)
		if shelves.isFiltered {
			if !shelves.results.isEmpty {
				providerSection(
					shelves.resultsTitle, count: shelves.results.count, providers: shelves.results,
					showsCategory: true)
			}
		} else {
			if !shelves.popular.isEmpty {
				providerSection("Popular", count: nil, providers: shelves.popular, showsCategory: true)
			}
			if !shelves.fresh.isEmpty {
				providerSection("New", count: nil, providers: shelves.fresh, showsCategory: true)
			}
			allIntegrations(shelves.groups)
		}
	}

	/// One card above the shelves: a line per broken tool and the button that fixes it. It ignores
	/// the search and the pills, so a filter never hides a broken tool.
	@ViewBuilder private func attentionCard(_ items: [IntegrationShelves.AttentionItem]) -> some View {
		if !items.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s7) {
				PageGroupLabel(text: "Needs attention")
				VStack(spacing: 0) {
					ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
						if index > 0 {
							Rectangle().fill(MaskinSurface.separator).frame(height: 1)
						}
						attentionRow(item)
					}
				}
				.background(
					MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
			}
		}
	}

	private func attentionRow(_ item: IntegrationShelves.AttentionItem) -> some View {
		HStack(spacing: MaskinSpace.s7) {
			Text(item.line)
				.font(MaskinTypeface.sans(MaskinFontSize.t14))
				.foregroundStyle(MaskinColor.ink)
				.fixedSize(horizontal: false, vertical: true)
				.frame(maxWidth: .infinity, alignment: .leading)
			if store.canManage {
				Button(item.actionLabel) { fix(item) }
					.buttonStyle(.secondaryAction)
					.disabled(store.isConnectInFlight)
					.accessibilityLabel("\(item.actionLabel) \(item.name)")
			}
		}
		.padding(.horizontal, MaskinSpace.s9)
		.padding(.vertical, MaskinSpace.s8)
		.frame(minHeight: MaskinSpace.touchMin)
	}

	private func fix(_ item: IntegrationShelves.AttentionItem) {
		switch item.fix {
		case .reconnect(let providerID): startConnectFlow(providerID)
		case .finishSetup(let providerID): store.explainComputerOnly(providerID)
		}
	}

	/// A search or pill that finds nothing: why, and the ways out.
	private func emptyFilter(_ text: String) -> some View {
		VStack(spacing: MaskinSpace.s7) {
			PageStatus(text: text)
			PageFootnote(text: "Can't find the tool? Add it with a link to its server.")
			HStack(spacing: MaskinSpace.s7) {
				Button(isSearching ? "Clear search" : "Clear filter") { clearFilters() }
					.buttonStyle(.secondaryAction)
				if services != nil, store.canManage {
					Button("Add your own") {
						clearFilters()
						showAddToolServer = true
					}
					.buttonStyle(.secondaryAction)
				}
			}
		}
	}

	private func clearFilters() {
		query = ""
		pill = .all
	}

	/// Connected tools, broken ones first, five at first; tool servers, folder watches and the add
	/// card sit under them.
	@ViewBuilder private func yoursSection(_ shelves: IntegrationShelves) -> some View {
		let accounts = accountRows(shelves.visibleYours(expanded: showAllYours))
		let servers = serverRows(shelves.visibleServers(expanded: showAllYours))
		let hasContent =
			!accounts.isEmpty || !servers.isEmpty || shelves.nothingConnected || showsDriveWatches || showsAddCard
		if hasContent {
			VStack(alignment: .leading, spacing: MaskinSpace.s7) {
				PageGroupLabel(text: "Your integrations")
				if shelves.nothingConnected { nothingConnectedCard }
				if !accounts.isEmpty { PageCard(rows: accounts) }
				if !servers.isEmpty { PageCard(rows: servers) }
				if shelves.showsToggle() { showAllButton(shelves) }
				driveWatchesCard
				if showsAddCard { addServerCard }
			}
		}
	}

	private var nothingConnectedCard: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			Text("Nothing connected yet")
				.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: MaskinFontWeight.semibold))
				.foregroundStyle(MaskinColor.ink)
			Text("Connect a tool below so your agents can read and act in it. Email and calendar are a good first pair.")
				.font(MaskinTypeface.sans(MaskinFontSize.t13))
				.foregroundStyle(MaskinColor.ink4)
				.fixedSize(horizontal: false, vertical: true)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(MaskinSpace.s9)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		.accessibilityElement(children: .combine)
	}

	private func showAllButton(_ shelves: IntegrationShelves) -> some View {
		Button {
			showAllYours.toggle()
		} label: {
			Label(
				showAllYours ? "Show fewer" : "Show all \(shelves.yoursCount)",
				systemImage: showAllYours ? "chevron.up" : "chevron.down")
		}
		.buttonStyle(.secondaryAction)
	}

	/// A titled list of tools the workspace has not connected.
	private func providerSection(
		_ title: String, count: Int?, providers: [IntegrationProvider], showsCategory: Bool
	) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			PageGroupLabel(text: count.map { "\(title) · \($0)" } ?? title)
			PageCard(rows: providers.map { availableRow($0, showsCategory: showsCategory) })
		}
	}

	/// Every tool not yet connected, in the ten category groups, A to Z inside a group. A tool also
	/// on Popular or New shows here on purpose.
	@ViewBuilder private func allIntegrations(_ groups: [IntegrationShelves.Group]) -> some View {
		if !groups.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s9) {
				PageGroupLabel(text: "All integrations")
				ForEach(groups) { group in
					VStack(alignment: .leading, spacing: MaskinSpace.s5) {
						PageGroupLabel(text: "\(group.category.label) · \(group.providers.count)")
						PageCard(rows: group.providers.map { availableRow($0, showsCategory: false) })
					}
				}
			}
		}
	}

	/// Folder watches of the connected Google Drive. Open to everyone, like the web page: only Stop
	/// watch needs write access.
	@ViewBuilder private var driveWatchesCard: some View {
		if showsDriveWatches {
			PageCard(rows: [
				PageRowModel(
					id: "drive-watches", title: DriveWatchesCopy.label,
					subtitle: "Folders agents watch in Google Drive", showsChevron: true,
					action: { showDriveWatches = true })
			])
		}
	}

	private var showsDriveWatches: Bool {
		SettingsRowRules.showsDriveWatches(
			hasServices: services != nil, hasConnectedDrive: store.hasConnectedDrive, isSearching: isSearching,
			pill: pill)
	}

	private var showsAddCard: Bool {
		SettingsRowRules.showsAddCard(isSearching: isSearching, pill: pill) && !addRows.isEmpty
	}

	private var isSearching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

	/// "Add your own MCP server" and the Claude import, hidden while searching.
	private var addRows: [PageRowModel] {
		SettingsRowRules.addRows(canManage: store.canManage, hasServices: services != nil).map { (row) -> PageRowModel in
			switch row {
			case .toolServer:
				PageRowModel(
					id: "add-tool-server", title: "Add your own MCP server",
					subtitle: "Paste a server URL and choose what your agents can use.",
					showsChevron: true, action: { showAddToolServer = true })
			case .importFromClaude:
				PageRowModel(
					id: "claude", title: "Import from Claude",
					subtitle: "Use a Claude subscription as the model source", showsChevron: true,
					action: { showClaude = true })
			}
		}
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
		.navigationDestination(isPresented: $showDriveWatches) {
			if let services { DriveWatchesView(store: services.driveWatchesStore()) }
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
			ForEach(
				SettingsRowRules.integrationActions(
					isToolServer: integration.provider == IntegrationsStore.toolServerProvider,
					canManage: store.canManage, canStartConnect: store.canStartConnect(integration.provider),
					state: integration.state, hasServices: services != nil,
					hasOwnApp: store.needsOwnApp(integration.provider)),
				id: \.self
			) { action in
				switch action {
				case .reconnect: Button("Reconnect") { startConnectFlow(integration.provider) }
				case .agentAccess: Button("Agent access") { openAccess(integration) }
				case .changeApp: Button("Change app") { store.changeApp(providerID: integration.provider) }
				case .disconnect: Button("Disconnect", role: .destructive) { pendingDisconnect = integration }
				case .remove: Button("Remove", role: .destructive) { pendingDisconnect = integration }
				}
			}
		}
		.ownAppSheet(store: store) { prompt in
			services.flatMap { $0.ownAppStore(prompt: prompt) }
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
			Button("Keep", role: .cancel) {}
		} message: { _ in
			Text("Agents lose access.")
		}
	}

	private func accountRows(_ accounts: [ConnectedIntegration]) -> [PageRowModel] {
		accounts.map { integration in
			PageRowModel(
				id: integration.id, title: store.displayName(for: integration),
				subtitle: SettingsRowRules.connectedSubtitle(
					state: integration.state, note: integration.note, account: store.accountLabel(for: integration)),
				accessory: .state(
					isConnecting(integration.provider)
						? WorkspacePageState.integrationConnecting
						: WorkspacePageState.integration(integration.state)),
				action: SettingsRowRules.connectedRowIsTappable(
					canManage: store.canManage, connectInFlight: store.isConnectInFlight)
					? { actionTarget = integration } : nil)
		}
	}

	/// A tool the workspace has not connected: its category under Popular, New and the filtered
	/// list, nothing inside a category group (the heading already says it).
	private func availableRow(_ provider: IntegrationProvider, showsCategory: Bool) -> PageRowModel {
		PageRowModel(
			id: "available-\(provider.id)", title: provider.displayName,
			subtitle: showsCategory ? IntegrationCategory.category(for: provider.id).label : nil,
			accessory: .state(
				isConnecting(provider.id)
					? WorkspacePageState.integrationConnecting : WorkspacePageState.integrationAvailable),
			action: availableAction(provider))
	}

	/// Tool servers a person added. Adding one is the "Add your own MCP server" card; the server
	/// only accepts people, which the add page reports if an agent key is signed in.
	private func serverRows(_ servers: [ConnectedIntegration]) -> [PageRowModel] {
		servers.map { server in
			PageRowModel(
				id: server.id, title: store.displayName(for: server),
				subtitle: SettingsRowRules.toolServerSubtitle(state: server.state),
				accessory: .state(WorkspacePageState.integration(server.state)),
				action: SettingsRowRules.connectedRowIsTappable(
					canManage: store.canManage, connectInFlight: store.isConnectInFlight)
					? { actionTarget = server } : nil)
		}
	}

	private func isConnecting(_ providerID: String) -> Bool { store.connectPhase.provider == providerID }

	private func startConnect(_ providerID: String) {
		Task { await store.connect(providerID: providerID) }
	}

	/// OAuth providers connect in the sheet (and ignore taps while one is running), key providers
	/// open their form, and the rest explain they are set up from a computer.
	private func availableAction(_ provider: IntegrationProvider) -> (() -> Void)? {
		guard
			SettingsRowRules.availableRowIsTappable(
				canManage: store.canManage, canStartConnect: store.canStartConnect(provider.id),
				connectInFlight: store.isConnectInFlight)
		else { return nil }
		return { startConnectFlow(provider.id) }
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
