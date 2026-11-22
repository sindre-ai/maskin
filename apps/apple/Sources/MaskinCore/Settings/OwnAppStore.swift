import Foundation
import Observation

/// A workspace's own sign-in app for one tool, as the server reports it. The app id is not
/// secret; the secret is never sent back, so there is no field for it.
public struct OwnAppStatus: Sendable, Equatable {
	public var configured: Bool
	public var clientId: String?
	/// The address the vendor's app must list as its callback.
	public var callbackURL: String

	public init(configured: Bool, clientId: String? = nil, callbackURL: String) {
		self.configured = configured
		self.clientId = clientId
		self.callbackURL = callbackURL
	}
}

public protocol OwnAppAPI: Sendable {
	/// `GET /api/integrations/{provider}/app`.
	func status(provider: String) async throws -> OwnAppStatus
	/// `PUT /api/integrations/{provider}/app`: saves the app, or replaces it. The secret goes out
	/// once and comes back nowhere.
	func save(provider: String, clientId: String, clientSecret: String, idempotencyKey: String)
		async throws -> OwnAppStatus
	/// `DELETE /api/integrations/{provider}/app`. The server refuses it while the tool is connected.
	func remove(provider: String, idempotencyKey: String) async throws
}

/// The form for a tool's own sign-in app asked for: Connect with no app saved (`connected` false),
/// or Change app on a tool that is connected.
public struct OwnAppPrompt: Identifiable, Sendable, Equatable {
	public var providerID: String
	public var providerName: String
	public var connected: Bool
	public var id: String { providerID }

	public init(providerID: String, providerName: String, connected: Bool) {
		self.providerID = providerID
		self.providerName = providerName
		self.connected = connected
	}
}

/// The paste form for a tool whose vendor lets only the customer's own admin create the sign-in
/// app. Same wording as the web form (`OwnAppDialog`). The secret lives in this store only until
/// it is sent: it is cleared as soon as the save succeeds and is never read back.
@MainActor
@Observable
public final class OwnAppStore: Identifiable {
	public var clientId = ""
	public var clientSecret = ""
	public private(set) var status: OwnAppStatus?
	public private(set) var isLoading = false
	public private(set) var isSaving = false
	public private(set) var isRemoving = false
	public private(set) var error: String?
	/// The app was saved. A first save on a tool that is not connected carries on to sign-in.
	public private(set) var didSave = false
	public private(set) var didRemove = false

	public let prompt: OwnAppPrompt
	nonisolated public var id: String { prompt.providerID }
	@ObservationIgnored private let api: any OwnAppAPI

	public init(prompt: OwnAppPrompt, api: any OwnAppAPI) {
		self.prompt = prompt
		self.api = api
	}

	public var providerName: String { prompt.providerName }
	public var replacing: Bool { status?.configured == true }
	public var trimmedClientId: String { clientId.trimmingCharacters(in: .whitespacesAndNewlines) }
	public var isBusy: Bool { isSaving || isRemoving }
	public var canSave: Bool {
		!trimmedClientId.isEmpty && !clientSecret.isEmpty && !isBusy && !didSave && !didRemove
	}
	/// A saved app can be removed. The server refuses it while the tool is connected.
	public var canRemove: Bool { replacing && !isBusy && !didSave && !didRemove }

	public var title: String {
		replacing ? "Change the \(providerName) app" : "Connect \(providerName)"
	}

	public var explanation: String {
		"\(providerName) lets only your own admin create the app that signs in. Create it in your \(providerName) account, then paste its id and secret here. The secret is stored encrypted and is never shown again."
			+ (replacing && prompt.connected ? " If you change to a different app, reconnect afterwards." : "")
	}

	public var secretPlaceholder: String {
		replacing ? "Paste the secret again to replace it" : "Consumer secret"
	}
	public var idPlaceholder: String { status?.clientId ?? "Consumer key" }
	public var saveTitle: String { prompt.connected || replacing ? "Save" : "Save and connect" }

	/// Whether saving carries on to the sign-in: only for a tool that is not connected yet.
	public var connectsAfterSave: Bool { !prompt.connected }

	public func load() async {
		guard !isLoading, status == nil else { return }
		isLoading = true
		defer { isLoading = false }
		do {
			status = try await api.status(provider: prompt.providerID)
			error = nil
		} catch {
			// The form still works without the callback address; say why it is missing.
			self.error = (error as? SettingsError)?.message ?? "Couldn't load the app."
		}
	}

	public func save() async {
		guard canSave else { return }
		isSaving = true
		error = nil
		defer { isSaving = false }
		do {
			status = try await api.save(
				provider: prompt.providerID, clientId: trimmedClientId, clientSecret: clientSecret,
				idempotencyKey: UUID().uuidString)
			clientSecret = ""
			didSave = true
		} catch {
			self.error = (error as? SettingsError)?.message ?? "Couldn't save the \(providerName) app."
		}
	}

	public func remove() async {
		guard canRemove else { return }
		isRemoving = true
		error = nil
		defer { isRemoving = false }
		do {
			try await api.remove(provider: prompt.providerID, idempotencyKey: UUID().uuidString)
			clientSecret = ""
			didRemove = true
		} catch {
			self.error = (error as? SettingsError)?.message ?? "Couldn't remove the \(providerName) app."
		}
	}
}
