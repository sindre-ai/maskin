import Foundation
import Observation

/// A tool server (remote MCP) a person is adding to the workspace. Builds the body of
/// `POST /api/custom-mcp-servers`. No agent can use it until it is granted.
public struct ToolServerDraft: Equatable, Sendable {
	public var name = ""
	public var url = ""
	/// Optional bearer key. Sent once as an `Authorization` header and masked by the server after.
	public var key = ""

	public init(name: String = "", url: String = "", key: String = "") {
		self.name = name
		self.url = url
		self.key = key
	}

	public var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
	public var trimmedURL: String { url.trimmingCharacters(in: .whitespacesAndNewlines) }

	/// An http(s) URL with a host, at most the server's 2048 characters.
	public var urlIsValid: Bool {
		guard trimmedURL.count <= 2048, let parts = URLComponents(string: trimmedURL),
			let scheme = parts.scheme?.lowercased(), scheme == "https" || scheme == "http",
			let host = parts.host, !host.isEmpty
		else { return false }
		return true
	}

	public var hasKey: Bool { !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

	/// A key is only ever sent over https; plain http would put it on the wire in the clear.
	public var keyNeedsHTTPS: Bool {
		hasKey && URLComponents(string: trimmedURL)?.scheme?.lowercased() != "https"
	}

	/// The sentence shown beside the form when the key and the URL do not go together.
	public var keyProblem: String? {
		keyNeedsHTTPS ? "A key can only be sent to an https address." : nil
	}

	public var isValid: Bool {
		!trimmedName.isEmpty && trimmedName.count <= 60 && urlIsValid && !keyNeedsHTTPS
	}

	func requestBody() throws -> Data {
		struct Server: Encodable {
			var type = "http"
			var url: String
			var headers: [String: String]?
		}
		struct Body: Encodable {
			var name: String
			var server: Server
		}
		let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
		return try JSONEncoder().encode(
			Body(
				name: trimmedName,
				server: Server(url: trimmedURL, headers: key.isEmpty ? nil : ["Authorization": "Bearer \(key)"])))
	}
}

public protocol ToolServersAPI: Sendable {
	func add(_ draft: ToolServerDraft, idempotencyKey: String) async throws
}

/// Settings › Integrations › Add tool server.
@MainActor
@Observable
public final class AddToolServerStore {
	public var draft = ToolServerDraft()
	public private(set) var isSaving = false
	public private(set) var error: String?
	public private(set) var didAdd = false

	@ObservationIgnored private let api: any ToolServersAPI

	public init(api: any ToolServersAPI) { self.api = api }

	public var canSave: Bool { draft.isValid && !isSaving && !didAdd }

	public func save() async {
		guard canSave else { return }
		isSaving = true
		error = nil
		defer { isSaving = false }
		do {
			try await api.add(draft, idempotencyKey: UUID().uuidString)
			didAdd = true
		} catch {
			self.error = (error as? SettingsError)?.message ?? "Couldn't add the tool server."
		}
	}
}

public struct APIToolServersSource: ToolServersAPI {
	private let http: SettingsHTTP
	public init(http: SettingsHTTP) { self.http = http }

	public func add(_ draft: ToolServerDraft, idempotencyKey: String) async throws {
		let (data, status) = try await http.send(
			"POST", "api/custom-mcp-servers", body: try draft.requestBody(), key: idempotencyKey)
		guard status == 201 else {
			if status == 409 { throw SettingsError("A tool server with that name already exists.") }
			throw SettingsHTTP.error(status: status, data: data, fallback: "Couldn't add the tool server.")
		}
	}
}
