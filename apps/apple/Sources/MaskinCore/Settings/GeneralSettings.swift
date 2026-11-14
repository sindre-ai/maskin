import Foundation
import Observation

/// Network seam for the General switches: the person's default workspace and the workspace's
/// Privacy & data. A protocol so the store tests without a server.
public protocol GeneralSettingsAPI: Sendable {
	/// `PATCH /api/actors/{id}` with only `default_workspace_id`; nil clears it.
	func setDefaultWorkspace(actorId: String, workspaceId: String?, idempotencyKey: String) async throws
	/// `PATCH /api/workspaces/{id}` with only `settings.privacy`.
	func setPrivacy(workspaceId: String, shareUsage: Bool, anonymize: Bool, idempotencyKey: String)
		async throws
}

/// The three switches of the web's Settings > General: make this my default workspace, share
/// product usage and anonymize. Each flips at once and goes back if the server refuses.
@MainActor
@Observable
public final class GeneralSettingsStore {
	public private(set) var isDefault: Bool
	public private(set) var shareUsage: Bool
	public private(set) var anonymize: Bool
	public private(set) var isSaving = false
	public private(set) var error: String?
	/// Viewers can't change workspace data; the default workspace is the person's own preference.
	public let canWritePrivacy: Bool

	@ObservationIgnored private let api: any GeneralSettingsAPI
	@ObservationIgnored private let actorId: String
	@ObservationIgnored private let workspaceId: String
	@ObservationIgnored private let refreshWorkspaces: @MainActor () async -> Void

	public init(
		api: any GeneralSettingsAPI, actorId: String, workspace: WorkspaceSummary, canWritePrivacy: Bool,
		refreshWorkspaces: @escaping @MainActor () async -> Void
	) {
		self.api = api
		self.actorId = actorId
		self.workspaceId = workspace.id
		self.canWritePrivacy = canWritePrivacy
		self.refreshWorkspaces = refreshWorkspaces
		isDefault = workspace.isDefault
		shareUsage = workspace.shareUsage
		anonymize = workspace.anonymize
	}

	public func setDefault(_ on: Bool) async {
		guard !isSaving, on != isDefault else { return }
		let previous = isDefault
		isDefault = on
		isSaving = true
		error = nil
		defer { isSaving = false }
		do {
			try await api.setDefaultWorkspace(
				actorId: actorId, workspaceId: on ? workspaceId : nil, idempotencyKey: UUID().uuidString)
			// Picking this one replaces the old default, so the list is read again.
			await refreshWorkspaces()
		} catch {
			isDefault = previous
			self.error = "Failed to update your default workspace"
		}
	}

	public func setShareUsage(_ on: Bool) async {
		await savePrivacy(shareUsage: on, anonymize: anonymize)
	}

	public func setAnonymize(_ on: Bool) async {
		await savePrivacy(shareUsage: shareUsage, anonymize: on)
	}

	private func savePrivacy(shareUsage: Bool, anonymize: Bool) async {
		guard canWritePrivacy, !isSaving, (shareUsage, anonymize) != (self.shareUsage, self.anonymize)
		else { return }
		let previous = (self.shareUsage, self.anonymize)
		self.shareUsage = shareUsage
		self.anonymize = anonymize
		isSaving = true
		error = nil
		defer { isSaving = false }
		do {
			try await api.setPrivacy(
				workspaceId: workspaceId, shareUsage: shareUsage, anonymize: anonymize,
				idempotencyKey: UUID().uuidString)
			await refreshWorkspaces()
		} catch {
			(self.shareUsage, self.anonymize) = previous
			self.error = "Failed to update privacy settings"
		}
	}

	public func dismissError() { error = nil }
}

/// Production source over `SettingsHTTP`: the generated body can't send `default_workspace_id: null`,
/// which is how the default is cleared.
public struct APIGeneralSettingsSource: GeneralSettingsAPI {
	private let http: SettingsHTTP
	public init(http: SettingsHTTP) { self.http = http }

	public func setDefaultWorkspace(actorId: String, workspaceId: String?, idempotencyKey: String)
		async throws
	{
		let json: [String: Any] = ["default_workspace_id": workspaceId.map { $0 as Any } ?? NSNull()]
		let body = try JSONSerialization.data(withJSONObject: json)
		let (data, status) = try await http.send(
			"PATCH", "api/actors/\(actorId)", body: body, key: idempotencyKey)
		guard (200..<300).contains(status) else {
			throw SettingsHTTP.error(
				status: status, data: data, fallback: "Couldn't update your default workspace.")
		}
	}

	public func setPrivacy(workspaceId: String, shareUsage: Bool, anonymize: Bool, idempotencyKey: String)
		async throws
	{
		let body = try JSONSerialization.data(withJSONObject: [
			"settings": ["privacy": ["share_usage": shareUsage, "anonymize_workspace": anonymize]]
		])
		let (data, status) = try await http.send(
			"PATCH", "api/workspaces/\(workspaceId)", body: body, key: idempotencyKey)
		guard (200..<300).contains(status) else {
			throw SettingsHTTP.error(
				status: status, data: data, fallback: "Couldn't update privacy settings.")
		}
	}
}
