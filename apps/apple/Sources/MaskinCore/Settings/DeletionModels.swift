import Foundation

/// Why an account can't be deleted yet, naming the workspace so the person knows where to act.
public struct AccountDeletionBlocker: Sendable, Equatable, Decodable, Identifiable {
	public enum Code: Sendable, Equatable {
		case transferOwnership, cancelPlan
		/// A reason a newer server added: shown with generic guidance, never hidden.
		case other(String)
	}

	public var code: Code
	public var workspaceId: String
	public var workspaceName: String
	public var id: String { "\(workspaceId):\(code)" }

	public init(code: Code, workspaceId: String, workspaceName: String) {
		self.code = code
		self.workspaceId = workspaceId
		self.workspaceName = workspaceName
	}

	private enum CodingKeys: String, CodingKey {
		case code, workspaceId = "workspace_id", workspaceName = "workspace_name"
	}

	public init(from decoder: any Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		let raw = try c.decode(String.self, forKey: .code)
		switch raw {
		case "transfer_ownership": code = .transferOwnership
		case "cancel_plan": code = .cancelPlan
		default: code = .other(raw)
		}
		workspaceId = try c.decode(String.self, forKey: .workspaceId)
		workspaceName = try c.decode(String.self, forKey: .workspaceName)
	}

	/// Plain guidance, written for someone who has never seen the web billing screens.
	public var guidance: String {
		switch code {
		case .transferOwnership:
			"You pay for “\(workspaceName)” and other people use it. Make one of them the owner first (Members, on the web), or remove them."
		case .cancelPlan:
			"Cancel the plan for “\(workspaceName)” first (Billing, in your profile), so billing doesn't outlive your account."
		case .other:
			"“\(workspaceName)” needs your attention before your account can be deleted."
		}
	}
}

/// A workspace the person would leave, and what happens to it.
public struct LeavingWorkspace: Sendable, Equatable, Decodable, Identifiable {
	public var workspaceId: String
	public var workspaceName: String
	public var otherMembers: Int
	/// Nobody else is in it: it goes with the account when the request asks for that.
	public var willDelete: Bool
	public var id: String { workspaceId }

	public init(workspaceId: String, workspaceName: String, otherMembers: Int, willDelete: Bool) {
		self.workspaceId = workspaceId
		self.workspaceName = workspaceName
		self.otherMembers = otherMembers
		self.willDelete = willDelete
	}

	private enum CodingKeys: String, CodingKey {
		case workspaceId = "workspace_id", workspaceName = "workspace_name"
		case otherMembers = "other_members", willDelete = "will_delete"
	}
}

/// `GET /api/account/deletion-preview`.
public struct AccountDeletionPreview: Sendable, Equatable, Decodable {
	public var canDelete: Bool
	public var blockers: [AccountDeletionBlocker]
	public var leaving: [LeavingWorkspace]

	public init(canDelete: Bool, blockers: [AccountDeletionBlocker], leaving: [LeavingWorkspace]) {
		self.canDelete = canDelete
		self.blockers = blockers
		self.leaving = leaving
	}

	private enum CodingKeys: String, CodingKey {
		case canDelete = "can_delete", blockers, leaving
	}

	/// Workspaces only this person is in: the ones the toggle would delete.
	public var soleWorkspaces: [LeavingWorkspace] { leaving.filter(\.willDelete) }
	/// Workspaces that carry on without them.
	public var sharedWorkspaces: [LeavingWorkspace] { leaving.filter { !$0.willDelete } }
}

public struct WorkspaceDeletionBlocker: Sendable, Equatable, Decodable, Identifiable {
	public enum Code: Sendable, Equatable {
		case notBillingOwner, cancelPlan
		case other(String)
	}

	public var code: Code
	/// The server's own sentence; shown as is.
	public var message: String
	public var id: String { "\(code):\(message)" }

	public init(code: Code, message: String) {
		self.code = code
		self.message = message
	}

	private enum CodingKeys: String, CodingKey { case code, message }

	public init(from decoder: any Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		let raw = try c.decode(String.self, forKey: .code)
		switch raw {
		case "not_billing_owner": code = .notBillingOwner
		case "cancel_plan": code = .cancelPlan
		default: code = .other(raw)
		}
		message = try c.decode(String.self, forKey: .message)
	}
}

/// `GET /api/workspaces/{id}/deletion-preview`.
public struct WorkspaceDeletionPreview: Sendable, Equatable, Decodable {
	public var workspaceId: String
	public var workspaceName: String
	public var canDelete: Bool
	public var blockers: [WorkspaceDeletionBlocker]
	/// Other people who lose access.
	public var otherMembers: Int

	public init(
		workspaceId: String, workspaceName: String, canDelete: Bool,
		blockers: [WorkspaceDeletionBlocker], otherMembers: Int
	) {
		self.workspaceId = workspaceId
		self.workspaceName = workspaceName
		self.canDelete = canDelete
		self.blockers = blockers
		self.otherMembers = otherMembers
	}

	private enum CodingKeys: String, CodingKey {
		case workspaceId = "workspace_id", workspaceName = "workspace_name"
		case canDelete = "can_delete", blockers, otherMembers = "other_members"
	}
}

/// Network seam for both deletions. A protocol so the stores test without a server.
public protocol DeletionAPI: Sendable {
	/// `GET /api/account/deletion-preview`.
	/// With `deleteSoleWorkspaces` the server judges blockers as the delete itself will.
	func accountPreview(deleteSoleWorkspaces: Bool) async throws -> AccountDeletionPreview
	/// `POST /api/account/delete`. A wrong password throws `DeletionError.wrongPassword`.
	func deleteAccount(password: String, deleteSoleWorkspaces: Bool, idempotencyKey: String)
		async throws
	/// `GET /api/workspaces/{id}/deletion-preview`.
	func workspacePreview(workspaceId: String) async throws -> WorkspaceDeletionPreview
	/// `POST /api/workspaces/{id}/delete`.
	func deleteWorkspace(workspaceId: String, confirmName: String, idempotencyKey: String)
		async throws
}

public struct DeletionError: Error, Equatable, Sendable {
	public var message: String
	public var isWrongPassword: Bool
	public init(_ message: String, isWrongPassword: Bool = false) {
		self.message = message
		self.isWrongPassword = isWrongPassword
	}
	public static let wrongPassword = DeletionError(
		"That password isn't right. Try again.", isWrongPassword: true)
}
