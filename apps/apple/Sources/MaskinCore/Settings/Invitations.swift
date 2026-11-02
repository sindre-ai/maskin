import Foundation
import Observation

/// A pending, unexpired invitation to the workspace (`GET /api/invites`).
public struct PendingInvitation: Identifiable, Sendable, Equatable {
	public var id: String
	public var email: String
	/// `member` or `viewer`, as the server stores it.
	public var role: String
	public var expiresAt: Date?
	public var invitedByName: String?

	public init(id: String, email: String, role: String, expiresAt: Date?, invitedByName: String? = nil) {
		self.id = id
		self.email = email
		self.role = role
		self.expiresAt = expiresAt
		self.invitedByName = invitedByName
	}

	/// "Expires in 6 days", or "Expired" once past; nil when the server sent no date.
	public func expiryText(now: Date = Date()) -> String? {
		guard let expiresAt else { return nil }
		let seconds = expiresAt.timeIntervalSince(now)
		if seconds <= 0 { return "Expired" }
		let days = Int((seconds / 86_400).rounded(.up))
		return days <= 1 ? "Expires today" : "Expires in \(days) days"
	}
}

public protocol InvitationsAPI: Sendable {
	func pending(workspaceId: String) async throws -> [PendingInvitation]
	func invite(workspaceId: String, email: String, idempotencyKey: String) async throws
	func resend(id: String, idempotencyKey: String) async throws
	func revoke(id: String, idempotencyKey: String) async throws
}

/// Pending invitations in Members: list, invite by email, send again, cancel. Managers only.
@MainActor
@Observable
public final class InvitationsStore {
	public private(set) var pending: [PendingInvitation] = []
	public private(set) var isInviting = false
	public private(set) var busyIDs: Set<String> = []
	public private(set) var actionError: String?
	public private(set) var notice: String?
	public let canManage: Bool

	@ObservationIgnored private let api: any InvitationsAPI
	@ObservationIgnored private let workspaceId: String

	public init(api: any InvitationsAPI, workspaceId: String, canManage: Bool) {
		self.api = api
		self.workspaceId = workspaceId
		self.canManage = canManage
	}

	/// An email address the server will accept: one "@", something either side, a dot in the domain.
	nonisolated public static func isValidEmail(_ raw: String) -> Bool {
		let email = raw.trimmingCharacters(in: .whitespacesAndNewlines)
		guard email.count <= 320, !email.contains(" ") else { return false }
		let parts = email.split(separator: "@", omittingEmptySubsequences: false)
		guard parts.count == 2, !parts[0].isEmpty, let domain = Optional(parts[1]) else { return false }
		let labels = domain.split(separator: ".", omittingEmptySubsequences: false)
		return labels.count >= 2 && labels.allSatisfy { !$0.isEmpty }
	}

	public func load() async {
		guard canManage else { return }
		// Pending invitations are secondary to the member list: a failure keeps the old list.
		if let list = try? await api.pending(workspaceId: workspaceId) {
			pending = list.sorted {
				($0.expiresAt ?? .distantPast) > ($1.expiresAt ?? .distantPast)
			}
		}
	}

	@discardableResult
	public func invite(email raw: String) async -> Bool {
		let email = raw.trimmingCharacters(in: .whitespacesAndNewlines)
		guard canManage, Self.isValidEmail(email), !isInviting else { return false }
		isInviting = true
		actionError = nil
		defer { isInviting = false }
		do {
			try await api.invite(workspaceId: workspaceId, email: email, idempotencyKey: UUID().uuidString)
			notice = "Invitation sent to \(email)."
			await load()
			return true
		} catch {
			actionError = (error as? SettingsError)?.message ?? "Couldn't send the invitation."
			return false
		}
	}

	public func resend(_ invitation: PendingInvitation) async {
		guard canManage, !busyIDs.contains(invitation.id) else { return }
		busyIDs.insert(invitation.id)
		actionError = nil
		defer { busyIDs.remove(invitation.id) }
		do {
			try await api.resend(id: invitation.id, idempotencyKey: UUID().uuidString)
			notice = "Invitation sent again to \(invitation.email)."
			await load()
		} catch {
			actionError = (error as? SettingsError)?.message ?? "Couldn't send the invitation again."
		}
	}

	public func cancel(_ invitation: PendingInvitation) async {
		guard canManage, !busyIDs.contains(invitation.id) else { return }
		busyIDs.insert(invitation.id)
		actionError = nil
		defer { busyIDs.remove(invitation.id) }
		do {
			try await api.revoke(id: invitation.id, idempotencyKey: UUID().uuidString)
			pending.removeAll { $0.id == invitation.id }
			notice = "Invitation to \(invitation.email) cancelled."
		} catch {
			actionError = (error as? SettingsError)?.message ?? "Couldn't cancel the invitation."
		}
	}

	public func dismissMessages() {
		actionError = nil
		notice = nil
	}
}

public struct APIInvitationsSource: InvitationsAPI {
	private let http: SettingsHTTP
	public init(http: SettingsHTTP) { self.http = http }

	private struct Item: Decodable {
		var id: String
		var email: String
		var role: String
		var expiresAt: String?
		var invitedByName: String?
	}

	public func pending(workspaceId: String) async throws -> [PendingInvitation] {
		let (data, status) = try await http.send(
			"GET", "api/invites", query: [URLQueryItem(name: "workspaceId", value: workspaceId)])
		guard status == 200 else {
			throw SettingsHTTP.error(status: status, data: data, fallback: "Couldn't load invitations.")
		}
		return try SettingsHTTP.decode([Item].self, data).map {
			PendingInvitation(
				id: $0.id, email: $0.email, role: $0.role, expiresAt: SettingsDates.parse($0.expiresAt),
				invitedByName: $0.invitedByName)
		}
	}

	public func invite(workspaceId: String, email: String, idempotencyKey: String) async throws {
		let body = try JSONEncoder().encode(["workspaceId": workspaceId, "email": email, "role": "member"])
		let (data, status) = try await http.send("POST", "api/invites", body: body, key: idempotencyKey)
		guard status == 200 || status == 201 else {
			throw SettingsHTTP.error(status: status, data: data, fallback: "Couldn't send the invitation.")
		}
	}

	public func resend(id: String, idempotencyKey: String) async throws {
		let (data, status) = try await http.send("POST", "api/invites/\(id)/resend", key: idempotencyKey)
		guard status == 200 else {
			throw SettingsHTTP.error(status: status, data: data, fallback: "Couldn't send the invitation again.")
		}
	}

	public func revoke(id: String, idempotencyKey: String) async throws {
		let (data, status) = try await http.send("DELETE", "api/invites/\(id)", key: idempotencyKey)
		guard status == 200 else {
			throw SettingsHTTP.error(status: status, data: data, fallback: "Couldn't cancel the invitation.")
		}
	}
}

enum SettingsDates {
	static func parse(_ s: String?) -> Date? {
		guard let s else { return nil }
		let f = ISO8601DateFormatter()
		f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		if let d = f.date(from: s) { return d }
		f.formatOptions = [.withInternetDateTime]
		return f.date(from: s)
	}
}
