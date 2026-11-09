import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Integrations (2B): every account a flow can use with its state: connected, needs sign-in, or
/// not connected. Slack, GitHub and LinkedIn connect in a system sign-in sheet; the rest finish in
/// the browser. Disconnecting is here.
struct IntegrationsView: View {
	@Environment(\.openURL) private var openURL
	@Environment(\.scenePhase) private var scenePhase
	@State private var store: IntegrationsStore
	@State private var actionTarget: ConnectedIntegration?
	@State private var pendingDisconnect: ConnectedIntegration?
	@State private var showAddToolServer = false
	@State private var showClaude = false
	@State private var accessTarget: ConnectedIntegration?
	/// Agents for the Agent access page, read from the member list when the page opens.
	@State private var accessAgents: [IntegrationAccessStore.AgentRef] = []
	let webSetupURL: URL?
	/// Builds the pages Integrations pushes (v3): Add tool server and Import from Claude. Nil in
	/// previews, which drops those rows.
	let services: SettingsServices?

	init(store: IntegrationsStore, webSetupURL: URL?, services: SettingsServices? = nil) {
		_store = State(initialValue: store)
		self.webSetupURL = webSetupURL
		self.services = services
	}

	var body: some View {
		dialogs(destinations(page))
	}

	private var page: some View {
		WorkspacePage(title: "Integrations") {
			if rows.isEmpty {
				switch store.phase {
				case .failed(let message): PageStatus(text: message)
				case .loaded: PageStatus(text: "No integrations available.")
				default: PageStatus(text: "Loading integrations")
				}
			} else {
				PageCard(rows: rows)
			}
			if !toolServerRows.isEmpty {
				PageGroupLabel(text: "Tool servers")
				PageCard(rows: toolServerRows)
			}
			if services != nil {
				PageGroupLabel(text: "Claude")
				PageCard(rows: [
					PageRowModel(
						id: "claude", title: "Import from Claude",
						subtitle: "Use a Claude subscription as the model source", showsChevron: true,
						action: { showClaude = true })
				])
			}
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
		.navigationDestination(isPresented: $showClaude) {
			if let services { ClaudeAccountView(store: services.claudeAccountStore(), importURL: services.webURL("keys")) }
		}
	}

	private func dialogs(_ view: some View) -> some View {
		view
		// Returning from the browser: pick up whatever the web flow just connected.
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
			} else if store.canManage, store.supportsNativeConnect(integration.provider),
				integration.state != .connected
			{
				Button("Reconnect") { startConnect(integration.provider) }
			} else if needsWeb(integration) {
				Button("Reconnect in browser") { openSetup() }
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

	private var rows: [PageRowModel] {
		let connected = store.accounts.map { integration in
			PageRowModel(
				id: integration.id, title: store.displayName(for: integration),
				subtitle: WorkspacePageState.integrationSubtitle(
					integration.state, account: store.accountLabel(for: integration)),
				accessory: .state(
					isConnecting(integration.provider)
						? WorkspacePageState.integrationConnecting
						: WorkspacePageState.integration(integration.state)),
				action: store.canManage && !store.isConnectInFlight ? { actionTarget = integration } : nil)
		}
		let available = store.available.map { provider in
			PageRowModel(
				id: "available-\(provider.id)", title: provider.displayName,
				subtitle: WorkspacePageState.integrationAvailableSubtitle,
				accessory: .state(
					isConnecting(provider.id)
						? WorkspacePageState.integrationConnecting : WorkspacePageState.integrationAvailable),
				action: availableAction(provider))
		}
		return connected + available
	}

	/// Tool servers a person added, plus the way to add one (owners and admins; the server only
	/// accepts people, which the add page reports if an agent key is signed in).
	private var toolServerRows: [PageRowModel] {
		var rows = store.toolServers.map { server in
			PageRowModel(
				id: server.id, title: store.displayName(for: server),
				subtitle: server.state == .connected ? nil : WorkspacePageState.integrationSubtitle(server.state, account: nil),
				accessory: .state(WorkspacePageState.integration(server.state)),
				action: store.canManage && !store.isConnectInFlight ? { actionTarget = server } : nil)
		}
		if store.canManage, services != nil {
			rows.append(
				PageRowModel(
					id: "add-tool-server", title: "Add tool server", showsChevron: true,
					action: { showAddToolServer = true }))
		}
		return rows
	}

	private func isConnecting(_ providerID: String) -> Bool { store.connectPhase.provider == providerID }

	private func startConnect(_ providerID: String) {
		Task { await store.connect(providerID: providerID) }
	}

	/// Native providers connect in the sheet (and ignore taps while one is running); the rest keep
	/// the browser hand-off.
	private func availableAction(_ provider: IntegrationProvider) -> (() -> Void)? {
		guard store.canManage else { return nil }
		if store.supportsNativeConnect(provider.id) {
			return store.isConnectInFlight ? nil : { startConnect(provider.id) }
		}
		return webSetupURL != nil ? { openSetup() } : nil
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

	private func openSetup() { if let webSetupURL { openURL(webSetupURL) } }

	/// Rows whose fix is a trip to the browser: an expired or under-scoped connection.
	private func needsWeb(_ integration: ConnectedIntegration) -> Bool {
		guard store.canManage, webSetupURL != nil else { return false }
		switch integration.state {
		case .needsReconnect, .incomplete, .disconnected: return true
		case .connected: return false
		}
	}
}
