import Foundation
import OpenAPIRuntime

/// What `GET /api/invites/preview` says about an invite. Names, never ids, are what the screen shows.
public struct InvitePreview: Equatable, Sendable {
	public var workspaceId: String
	public var workspaceName: String
	public var inviterName: String
	public var inviteEmail: String
	public var role: String
	public var expiresAt: Date

	public init(
		workspaceId: String, workspaceName: String, inviterName: String, inviteEmail: String,
		role: String, expiresAt: Date
	) {
		self.workspaceId = workspaceId
		self.workspaceName = workspaceName
		self.inviterName = inviterName
		self.inviteEmail = inviteEmail
		self.role = role
		self.expiresAt = expiresAt
	}

	/// "member" -> "Member". An unknown role is shown as the server sent it, capitalised.
	public var roleLabel: String {
		let trimmed = role.trimmingCharacters(in: .whitespaces)
		return trimmed.isEmpty ? "Member" : trimmed.prefix(1).uppercased() + trimmed.dropFirst()
	}
}

public struct InviteAcceptance: Equatable, Sendable {
	public var workspaceId: String
	public init(workspaceId: String) { self.workspaceId = workspaceId }
}

/// Why an invite could not be previewed or accepted, with the sentence to show. Never carries a
/// credential, a token or a raw server body.
public enum InviteFailure: Error, Equatable, Sendable {
	/// 404: no invite matches.
	case notFound
	/// 410: expired, revoked or already used.
	case expired
	/// 429.
	case rateLimited
	/// 403 on accept: the workspace has no free seat.
	case seatCap
	/// 401 on accept: the stored key was refused.
	case sessionExpired
	/// No connection.
	case offline
	case server(status: Int)
	/// The server answered with something that could not be read.
	case unreadable

	public var message: String {
		switch self {
		case .notFound:
			"We couldn't find this invitation. The link may be incomplete. Ask the person who invited you to send it again."
		case .expired:
			"This invitation has expired or was already used. Ask the person who invited you to send a new one."
		case .rateLimited: "Too many tries just now. Wait a minute and try again."
		case .seatCap:
			"This workspace has no free seats right now. Ask an admin to make room, then try again."
		case .sessionExpired: "You've been signed out. Sign in again to accept this invitation."
		case .offline: "You're offline. Check your connection and try again."
		case .server, .unreadable: "Something went wrong on our side. Try again in a moment."
		}
	}

	/// A retry might succeed; otherwise the invite is a dead end.
	public var isRetryable: Bool {
		switch self {
		case .rateLimited, .offline, .server, .unreadable: true
		case .notFound, .expired, .seatCap, .sessionExpired: false
		}
	}

	/// The invite itself is unusable, so remembering its token would only re-open a dead screen.
	public var discardsInvite: Bool { self == .notFound || self == .expired }

	/// Maps an error thrown by the transport to `.offline` (no connection) or `.unreadable`.
	public static func transport(_ error: any Error) -> InviteFailure {
		if let failure = error as? InviteFailure { return failure }
		let underlying = (error as? ClientError)?.underlyingError ?? error
		return (underlying is URLError || error is URLError) ? .offline : .unreadable
	}

	public static func status(_ code: Int) -> InviteFailure {
		switch code {
		case 401: .sessionExpired
		case 403: .seatCap
		case 404: .notFound
		case 410: .expired
		case 429: .rateLimited
		default: .server(status: code)
		}
	}
}

/// The two network calls, as a protocol so the store tests without a server.
public protocol InviteRemote: Sendable {
	/// `GET /api/invites/preview`: public, sends no credentials.
	func preview(token: String) async throws -> InvitePreview
	/// `POST /api/invites/{token}/accept` as the existing actor (`apiKey`), empty body.
	func accept(token: String, apiKey: String) async throws -> InviteAcceptance
}
