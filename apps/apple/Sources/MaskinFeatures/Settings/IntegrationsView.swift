import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

struct IntegrationsView: View {
	@Environment(\.openURL) private var openURL
	@Environment(\.scenePhase) private var scenePhase
	@State private var store: IntegrationsStore
	@State private var pendingDisconnect: ConnectedIntegration?
	let webSetupURL: URL?

	init(store: IntegrationsStore, webSetupURL: URL?) {
		_store = State(initialValue: store)
		self.webSetupURL = webSetupURL
	}

	var body: some View {
		List {
			if !store.connected.isEmpty {
				Section("Connected") {
					ForEach(store.connected) { integration in
						IntegrationRow(
							name: store.displayName(for: integration), status: status(integration)
						)
						.contextMenu { menu(integration) }
						.swipeActions(edge: .trailing) {
							if store.canManage {
								Button("Disconnect", role: .destructive) { pendingDisconnect = integration }
							}
						}
					}
				}
			}
			if !store.available.isEmpty {
				Section("Available") {
					ForEach(store.available) { provider in
						IntegrationRow(name: provider.displayName, status: .available)
					}
				}
			}
			if let error = store.actionError {
				Section { FormError(error) }
			}
			Section {
				Button {
					if let webSetupURL { openURL(webSetupURL) }
				} label: {
					SettingsRow(symbol: "safari", title: "Connect or reconnect on the web")
				}
				.disabled(webSetupURL == nil || !store.canManage)
			} footer: {
				Text(
					"Connecting an integration signs you in with the provider in your browser. When you come back, this list refreshes."
				)
			}
		}
		.overlay {
			switch store.phase {
			case .loading: ProgressView()
			case .failed(let message):
				ContentUnavailableView(
					"Couldn't load integrations", systemImage: "wifi.exclamationmark",
					description: Text(message))
			default: EmptyView()
			}
		}
		.navigationTitle("Integrations")
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
		#endif
		.task { await store.load() }
		.refreshable { await store.load() }
		// Returning from the browser: pick up whatever the web flow just connected.
		.onChange(of: scenePhase) { _, phase in
			if phase == .active { Task { await store.load() } }
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

	@ViewBuilder
	private func menu(_ integration: ConnectedIntegration) -> some View {
		if store.canManage {
			Button("Disconnect", systemImage: "link.badge.minus", role: .destructive) {
				pendingDisconnect = integration
			}
		}
	}

	private func status(_ integration: ConnectedIntegration) -> IntegrationRow.Status {
		switch integration.state {
		case .connected: .connected(account: store.accountLabel(for: integration))
		case .needsReconnect(let n): .needsReconnect(missingScopes: n)
		case .incomplete: .incomplete
		case .disconnected: .disconnected
		}
	}
}
