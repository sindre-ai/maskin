import Foundation
import Observation

/// Connected and available integrations for the selected workspace.
///
/// Connecting is NOT done natively: `POST …/connect` binds the OAuth state to the requesting
/// browser with a SameSite cookie, and the provider callback is rejected unless that same browser
/// presents it. A native HTTP client's cookie jar is not the web-authentication session's, so the
/// flow can only complete in a browser that started it. The screen therefore opens the web
/// settings page and this store is reloaded when the app returns.
///
/// Provider ids never reach a label: `displayName(for:)` resolves a slug to the provider's name
/// (or the plain word "Integration"), and `accountLabel(for:)` shows an account only when the
/// provider exposes an email.
@MainActor
@Observable
public final class IntegrationsStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	public private(set) var providers: [IntegrationProvider] = []
	public private(set) var connected: [ConnectedIntegration] = []
	public private(set) var phase: Phase = .idle
	public private(set) var actionError: String?
	public private(set) var busyIDs: Set<String> = []
	public let currentRole: MemberRole

	@ObservationIgnored private let api: any IntegrationsAPI
	@ObservationIgnored private var generation = 0

	public init(api: any IntegrationsAPI, currentRole: MemberRole) {
		self.api = api
		self.currentRole = currentRole
	}

	public var canManage: Bool { currentRole.canManage }

	/// Providers with no integration yet, in display order.
	public var available: [IntegrationProvider] {
		let used = Set(connected.map(\.provider))
		return providers.filter { !used.contains($0.id) }
			.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
	}

	public func provider(for slug: String) -> IntegrationProvider? { providers.first { $0.id == slug } }

	public func displayName(for integration: ConnectedIntegration) -> String {
		provider(for: integration.provider)?.displayName ?? "Integration"
	}

	public func accountLabel(for integration: ConnectedIntegration) -> String? {
		guard provider(for: integration.provider)?.showsEmail == true else { return nil }
		return integration.externalId
	}

	public func load() async {
		if connected.isEmpty && providers.isEmpty { phase = .loading }
		generation += 1
		let mine = generation
		do {
			async let p = api.providers()
			async let c = api.connected()
			let (loadedProviders, loadedConnected) = try await (p, c)
			guard mine == generation else { return }
			providers = loadedProviders
			connected = loadedConnected.sorted {
				displayName(for: $0).localizedCaseInsensitiveCompare(displayName(for: $1)) == .orderedAscending
			}
			phase = .loaded
		} catch {
			guard mine == generation else { return }
			let message = (error as? SettingsError)?.message ?? "Couldn't load integrations."
			if phase == .loaded { actionError = message } else { phase = .failed(message) }
		}
	}

	/// Optimistic; restored if the server refuses.
	@discardableResult
	public func disconnect(_ integration: ConnectedIntegration) async -> Bool {
		guard canManage, !busyIDs.contains(integration.id) else { return false }
		let previous = connected
		connected.removeAll { $0.id == integration.id }
		busyIDs.insert(integration.id)
		actionError = nil
		defer { busyIDs.remove(integration.id) }
		do {
			try await api.disconnect(id: integration.id, idempotencyKey: UUID().uuidString)
			return true
		} catch {
			connected = previous
			actionError =
				(error as? SettingsError)?.message
				?? "Couldn't disconnect \(displayName(for: integration))."
			return false
		}
	}

	public func dismissError() { actionError = nil }
}
