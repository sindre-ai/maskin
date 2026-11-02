import Foundation
import Observation

/// Connected and available integrations for the selected workspace.
///
/// Slack, GitHub and LinkedIn connect natively: `connect(providerID:)` asks the API for an install
/// URL (sending `native_return_url = maskin://integrations/callback`), runs it in a system web
/// authentication sheet, and reads the outcome off the redirect (`IntegrationConnectOutcome`).
/// The server routes that sheet through its own launch endpoint so the OAuth state cookie lands in
/// the sheet's browser, which is why the install URL must not be opened any other way. Other
/// providers still finish in the web app (`supportsNativeConnect`).
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

	/// Where a native connect is. Anything but `.idle` blocks starting another (double-tap guard).
	public enum ConnectPhase: Equatable, Sendable {
		case idle
		/// Asking the API for the install URL.
		case starting(provider: String)
		/// The sign-in sheet is up.
		case inBrowser(provider: String)
		/// Back from the sheet, finishing (loading installations, binding one, refreshing).
		case finishing(provider: String)
		/// GitHub: waiting for the person to pick an installation.
		case choosingInstallation(provider: String)

		public var provider: String? {
			switch self {
			case .idle: nil
			case .starting(let p), .inBrowser(let p), .finishing(let p), .choosingInstallation(let p): p
			}
		}
	}

	/// What the picker offers after `selection_required`.
	public struct InstallationPicker: Equatable, Sendable {
		public var integrationId: String
		public var choices: [GitHubInstallationChoice]
	}

	public private(set) var connectPhase: ConnectPhase = .idle
	public private(set) var connectNotice: IntegrationConnectNotice?
	public private(set) var installationPicker: InstallationPicker?

	/// Names for the native providers if the provider list hasn't loaded; never a slug.
	private static let fallbackNames = ["slack": "Slack", "github": "GitHub", "linkedin-unipile": "LinkedIn"]

	/// Providers whose connect runs in the app's sheet.
	public static let nativeConnectProviders: Set<String> = ["slack", "github", "linkedin-unipile"]

	@ObservationIgnored private let api: any IntegrationsAPI
	@ObservationIgnored private let webAuth: (any WebAuthenticating)?
	@ObservationIgnored private var generation = 0

	public init(
		api: any IntegrationsAPI, currentRole: MemberRole, webAuth: (any WebAuthenticating)? = nil
	) {
		self.api = api
		self.currentRole = currentRole
		self.webAuth = webAuth
	}

	public var isConnectInFlight: Bool { connectPhase != .idle }

	public func supportsNativeConnect(_ providerID: String) -> Bool {
		webAuth != nil && Self.nativeConnectProviders.contains(providerID)
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
	public func dismissNotice() { connectNotice = nil }

	// MARK: Native connect

	private func connectName(_ providerID: String) -> String {
		provider(for: providerID)?.displayName ?? Self.fallbackNames[providerID] ?? "The integration"
	}

	/// Runs the whole connect. Ignored while another connect is in flight or for a non-manager.
	public func connect(providerID: String) async {
		guard canManage, supportsNativeConnect(providerID), let webAuth, connectPhase == .idle
		else { return }
		let name = connectName(providerID)
		connectNotice = nil
		actionError = nil
		connectPhase = .starting(provider: providerID)

		let start: IntegrationConnectStart
		do {
			start = try await api.startConnect(provider: providerID, idempotencyKey: UUID().uuidString)
		} catch {
			connectPhase = .idle
			connectNotice =
				(error as? SettingsError)?.isOffline == true
				? IntegrationConnectCopy.offline : IntegrationConnectCopy.couldNotStart(name)
			return
		}

		connectPhase = .inBrowser(provider: providerID)
		let callback: URL
		do {
			callback = try await webAuth.authenticate(
				url: start.installURL, callbackScheme: IntegrationConnectOutcome.callbackScheme)
		} catch WebAuthenticationError.cancelled {
			connectPhase = .idle
			connectNotice = IntegrationConnectCopy.cancelled(name)
			return
		} catch {
			connectPhase = .idle
			connectNotice = IntegrationConnectCopy.couldNotStart(name)
			return
		}

		connectPhase = .finishing(provider: providerID)
		switch IntegrationConnectOutcome.parse(callback) {
		case .connected(_, let billingRequired):
			connectNotice =
				billingRequired
				? IntegrationConnectCopy.connectedBillingRequired(name)
				: IntegrationConnectCopy.connected(name)
			connectPhase = .idle
		case .failed(let reason):
			connectNotice = IntegrationConnectCopy.failure(reason, name: name)
			connectPhase = .idle
		case .selectionRequired(let integrationId):
			do {
				let choices = try await api.pendingInstallations(integrationId: integrationId)
				if choices.isEmpty {
					connectNotice = IntegrationConnectCopy.failure(.installationUnauthorized, name: name)
					connectPhase = .idle
				} else {
					installationPicker = InstallationPicker(integrationId: integrationId, choices: choices)
					connectPhase = .choosingInstallation(provider: providerID)
				}
			} catch {
				connectNotice =
					(error as? SettingsError)?.isOffline == true
					? IntegrationConnectCopy.offline
					: IntegrationConnectCopy.failure(.enumerationFailed, name: name)
				connectPhase = .idle
			}
		}
		await load()
	}

	/// Binds the chosen GitHub installation to the workspace.
	public func chooseInstallation(_ choice: GitHubInstallationChoice) async {
		guard case .choosingInstallation(let providerID) = connectPhase, let picker = installationPicker
		else { return }
		let name = connectName(providerID)
		installationPicker = nil
		connectPhase = .finishing(provider: providerID)
		do {
			try await api.selectInstallation(
				integrationId: picker.integrationId, installationId: choice.id,
				idempotencyKey: UUID().uuidString)
			connectNotice = IntegrationConnectCopy.connected(name)
		} catch {
			connectNotice =
				(error as? SettingsError)?.isOffline == true
				? IntegrationConnectCopy.offline
				: IntegrationConnectCopy.failure(.postInstallFailed, name: name)
		}
		connectPhase = .idle
		await load()
	}

	/// The person dismissed the picker without choosing.
	public func cancelInstallationChoice() {
		guard case .choosingInstallation(let providerID) = connectPhase else { return }
		installationPicker = nil
		connectPhase = .idle
		connectNotice = IntegrationConnectCopy.cancelled(connectName(providerID))
		Task { await load() }
	}
}
