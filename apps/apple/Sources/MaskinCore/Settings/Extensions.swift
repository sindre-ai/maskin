import Foundation
import Observation

/// A custom extension: a webhook and/or MCP server the workspace added (`GET /api/extensions`).
public struct WorkspaceExtension: Identifiable, Sendable, Equatable {
	public enum Status: String, Sendable, Equatable { case active, disabled, draft }

	public var id: String
	public var name: String
	public var status: Status
	public var webhookURL: String?
	public var hasWebhook: Bool
	public var hasSigningSecret: Bool
	public var lastDeliveryAt: Date?
	public var committedDeliveries: Int
	public var lastError: String?
	public var hasMcp: Bool

	public init(
		id: String, name: String, status: Status, webhookURL: String? = nil, hasWebhook: Bool? = nil,
		hasSigningSecret: Bool = false,
		lastDeliveryAt: Date? = nil, committedDeliveries: Int = 0, lastError: String? = nil, hasMcp: Bool = false
	) {
		self.id = id
		self.name = name
		self.status = status
		self.webhookURL = webhookURL
		self.hasWebhook = hasWebhook ?? (webhookURL != nil)
		self.hasSigningSecret = hasSigningSecret
		self.lastDeliveryAt = lastDeliveryAt
		self.committedDeliveries = committedDeliveries
		self.lastError = lastError
		self.hasMcp = hasMcp
	}

	public var statusLabel: String {
		switch status {
		case .active: "On"
		case .disabled: "Off"
		case .draft: "Draft"
		}
	}

	/// "Adds an inbound webhook" etc., from what the extension actually has; nil when it has neither.
	public var summary: String? {
		switch (hasWebhook, hasMcp) {
		case (true, true): "Webhook and tool server"
		case (true, false): "Webhook"
		case (false, true): "Tool server"
		default: nil
		}
	}
}

public protocol ExtensionsAPI: Sendable {
	func list() async throws -> [WorkspaceExtension]
	func setEnabled(id: String, enabled: Bool, idempotencyKey: String) async throws -> WorkspaceExtension
}

/// Settings › Item types › Extensions: the workspace's extensions and an on/off switch for each.
/// Only owners switch; everyone else reads.
@MainActor
@Observable
public final class ExtensionsStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	public private(set) var extensions: [WorkspaceExtension] = []
	public private(set) var phase: Phase = .idle
	public private(set) var actionError: String?
	public private(set) var busyIDs: Set<String> = []
	public let canManage: Bool

	@ObservationIgnored private let api: any ExtensionsAPI

	public init(api: any ExtensionsAPI, canManage: Bool) {
		self.api = api
		self.canManage = canManage
	}

	public func extensionRow(id: String) -> WorkspaceExtension? { extensions.first { $0.id == id } }

	public func load() async {
		if extensions.isEmpty { phase = .loading }
		do {
			extensions = try await api.list().sorted {
				$0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
			}
			phase = .loaded
		} catch {
			let message = (error as? SettingsError)?.message ?? "Couldn't load extensions."
			if extensions.isEmpty { phase = .failed(message) } else { actionError = message }
		}
	}

	public func setEnabled(_ enabled: Bool, for ext: WorkspaceExtension) async {
		guard canManage, !busyIDs.contains(ext.id), ext.status != .draft else { return }
		busyIDs.insert(ext.id)
		actionError = nil
		defer { busyIDs.remove(ext.id) }
		do {
			let updated = try await api.setEnabled(
				id: ext.id, enabled: enabled, idempotencyKey: UUID().uuidString)
			if let i = extensions.firstIndex(where: { $0.id == ext.id }) { extensions[i] = updated }
		} catch {
			actionError = (error as? SettingsError)?.message ?? "Couldn't change the extension."
		}
	}
}

public struct APIExtensionsSource: ExtensionsAPI {
	private let http: SettingsHTTP
	public init(http: SettingsHTTP) { self.http = http }

	struct Wire: Decodable {
		var id: String
		var name: String
		var status: String
		var webhookUrl: String?
		var webhookConfig: [String: JSONIgnored]?
		var mcpConfig: [String: JSONIgnored]?
		var hasSigningSecret: Bool
		var lastDeliveryAt: String?
		var committedDeliveries: Int
		var mcpLastError: String?
	}

	/// Decodes and discards any JSON value; only the presence of a config matters.
	struct JSONIgnored: Decodable { init(from decoder: Decoder) throws {} }

	static func model(_ w: Wire) -> WorkspaceExtension {
		WorkspaceExtension(
			id: w.id, name: w.name, status: .init(rawValue: w.status) ?? .draft,
			webhookURL: w.webhookUrl, hasWebhook: w.webhookUrl != nil || w.webhookConfig != nil,
			hasSigningSecret: w.hasSigningSecret, lastDeliveryAt: SettingsDates.parse(w.lastDeliveryAt),
			committedDeliveries: w.committedDeliveries, lastError: w.mcpLastError,
			hasMcp: w.mcpConfig != nil)
	}

	public func list() async throws -> [WorkspaceExtension] {
		let (data, status) = try await http.send("GET", "api/extensions")
		guard status == 200 else {
			throw SettingsHTTP.error(status: status, data: data, fallback: "Couldn't load extensions.")
		}
		return try SettingsHTTP.decode([Wire].self, data).map(Self.model)
	}

	public func setEnabled(id: String, enabled: Bool, idempotencyKey: String) async throws
		-> WorkspaceExtension
	{
		let body = try JSONEncoder().encode(["status": enabled ? "active" : "disabled"])
		let (data, status) = try await http.send(
			"PATCH", "api/extensions/\(id)", body: body, key: idempotencyKey)
		guard status == 200 else {
			throw SettingsHTTP.error(
				status: status, data: data, fallback: "Couldn't change the extension.")
		}
		return Self.model(try SettingsHTTP.decode(Wire.self, data))
	}
}
