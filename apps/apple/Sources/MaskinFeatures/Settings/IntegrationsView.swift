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
	let webSetupURL: URL?

	init(store: IntegrationsStore, webSetupURL: URL?) {
		_store = State(initialValue: store)
		self.webSetupURL = webSetupURL
	}

	var body: some View {
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
		.task { await store.load() }
		.refreshable { await store.load() }
		// Returning from the browser: pick up whatever the web flow just connected.
		.onChange(of: scenePhase) { _, phase in
			if phase == .active { Task { await store.load() } }
		}
		.confirmationDialog(
			actionTarget.map { store.displayName(for: $0) } ?? "Integration",
			isPresented: Binding(get: { actionTarget != nil }, set: { if !$0 { actionTarget = nil } }),
			titleVisibility: .visible, presenting: actionTarget
		) { integration in
			if store.canManage, store.supportsNativeConnect(integration.provider),
				integration.state != .connected
			{
				Button("Reconnect") { startConnect(integration.provider) }
			} else if needsWeb(integration) {
				Button("Reconnect in browser") { openSetup() }
			}
			Button("Disconnect", role: .destructive) { pendingDisconnect = integration }
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
		let connected = store.connected.map { integration in
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
