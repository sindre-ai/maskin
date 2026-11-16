import Foundation
import Observation

public protocol IntegrationKeyAPI: Sendable {
	/// `POST /api/integrations/{provider}/connect` with the pasted key (the api_key providers).
	func connect(provider: String, key: String, idempotencyKey: String) async throws
}

/// Connecting a provider that takes a pasted key (PostHog), on a form in the app.
@MainActor
@Observable
public final class ConnectWithKeyStore: Identifiable {
	public var key = ""
	public private(set) var isSaving = false
	public private(set) var error: String?
	public private(set) var didConnect = false

	public let providerName: String
	@ObservationIgnored private let providerID: String
	nonisolated public var id: String { providerID }
	@ObservationIgnored private let api: any IntegrationKeyAPI

	public init(providerID: String, providerName: String, api: any IntegrationKeyAPI) {
		self.providerID = providerID
		self.providerName = providerName
		self.api = api
	}

	public var trimmedKey: String { key.trimmingCharacters(in: .whitespacesAndNewlines) }
	public var canSave: Bool { !trimmedKey.isEmpty && !isSaving && !didConnect }

	public func save() async {
		guard canSave else { return }
		isSaving = true
		error = nil
		defer { isSaving = false }
		do {
			try await api.connect(provider: providerID, key: trimmedKey, idempotencyKey: UUID().uuidString)
			key = ""
			didConnect = true
		} catch {
			self.error = (error as? SettingsError)?.message ?? "Couldn't connect \(providerName)."
		}
	}
}

public struct APIIntegrationKeySource: IntegrationKeyAPI {
	private let http: SettingsHTTP
	public init(http: SettingsHTTP) { self.http = http }

	public func connect(provider: String, key: String, idempotencyKey: String) async throws {
		struct Body: Encodable { var api_key: String }
		let (data, status) = try await http.send(
			"POST", "api/integrations/\(provider)/connect",
			body: try JSONEncoder().encode(Body(api_key: key)), key: idempotencyKey)
		guard status == 200 else {
			throw SettingsHTTP.error(status: status, data: data, fallback: "Couldn't connect that key. Check it and try again.")
		}
	}
}
