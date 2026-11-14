import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// An agent's ask to connect a provider (the web's `IntegrationConnectCard`). It is the same
/// connect Settings → Integrations offers: OAuth providers connect in the system sign-in sheet,
/// key providers on a form, and the rest say they are set up from a computer. Status is read live rather than stored on the
/// message, so the card turns to "Connected" by itself and a scrolled-back chat never shows a
/// stale Connect button.
struct IntegrationConnectCard: View {
	let request: IntegrationConnectRequest

	@Environment(\.scenePhase) private var scenePhase
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var ownStore: IntegrationsStore?
	@State private var keyForm: ConnectWithKeyStore?
	/// A store shared with the caller (an intro's tool rows load one list for all of them).
	var sharedStore: IntegrationsStore?

	init(request: IntegrationConnectRequest, store: IntegrationsStore? = nil) {
		self.request = request
		self.sharedStore = store
	}

	private var store: IntegrationsStore? { sharedStore ?? ownStore }

	var body: some View {
		Group {
			// The message's text already says what to connect, so an unknown or still-loading
			// provider draws nothing and the chat reads fine without the card.
			if let store, let provider = store.provider(for: request.provider) {
				VStack(alignment: .leading, spacing: MaskinSpace.s6) {
					if isConnected(store) {
						RequestCardSettled(symbol: "checkmark.circle.fill", text: "\(provider.displayName) is connected.")
					} else {
						Text("Connect \(provider.displayName)")
							.maskinText(.headline).foregroundStyle(MaskinColor.ink)
						if let error = store.actionError { Text(error).maskinText(.caption).foregroundStyle(MaskinColor.ink3) }
						if let notice = store.connectNotice, notice.kind != .success {
							Text(notice.text).maskinText(.caption).foregroundStyle(MaskinColor.ink3)
						}
						if !store.canManage {
							Text("Only owners and admins can connect an integration.")
								.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
						} else {
							RequestCardButton(
								title: store.connectPhase.provider == provider.id ? "Connecting…" : "Connect \(provider.displayName)",
								primary: true, disabled: store.isConnectInFlight || !store.canStartConnect(provider.id)
							) { connect(provider, store) }
						}
					}
				}
				.requestCardFrame()
			}
		}
		.task { await prepare() }
		.sheet(item: $keyForm) { form in
			NavigationStack {
				ConnectWithKeyView(store: form) { if let store { Task { await store.load() } } }
			}
		}
		// Back in the app: pick up anything that changed while it was away.
		.onChange(of: scenePhase) { _, phase in
			if phase == .active, let store { Task { await store.load() } }
		}
	}

	private func isConnected(_ store: IntegrationsStore) -> Bool {
		store.connected.contains { $0.provider == request.provider && $0.state == .connected }
	}

	private func prepare() async {
		guard store == nil, let runtime else { return }
		let made = SettingsServices(environment: runtime.environment).integrationsStore()
		ownStore = made
		await made.load()
	}

	/// OAuth providers connect in the sheet, key providers on a form, the rest explain themselves.
	private func connect(_ provider: IntegrationProvider, _ store: IntegrationsStore) {
		if store.supportsNativeConnect(provider.id) {
			Task { await store.connect(providerID: provider.id) }
		} else if store.connectsWithKey(provider.id), let runtime {
			keyForm = SettingsServices(environment: runtime.environment)
				.connectWithKeyStore(providerID: provider.id, providerName: provider.displayName)
		} else {
			store.explainComputerOnly(provider.id)
		}
	}
}
