import Foundation

/// A link whose address names a workspace other than the one being read. Nothing is fetched for it
/// (the workspace is in the address, and its records are not ours to read), so the card says only
/// what the address says: what kind of thing it points at, and which workspace.
public struct LinkedOtherWorkspace: Equatable, Sendable {
	public var target: LinkedTarget
	/// The workspace the address names.
	public var workspaceID: String
	/// "Object" or "File": all an address says about the kind. An object's type is not known
	/// without reading it.
	public var kindLabel: String
	/// Where a tap goes: the `maskin://` link a push notification carries, so the app's own link
	/// handler switches workspace (or says the reader is not in it).
	public var url: URL

	public init(target: LinkedTarget, workspaceID: String) {
		self.target = target
		self.workspaceID = workspaceID
		switch target.kind {
		case .object:
			kindLabel = "Object"
			url = DeepLink.object(workspaceId: workspaceID, id: target.uuid).url
		case .file:
			kindLabel = "File"
			url = DeepLink.file(workspaceId: workspaceID, id: target.uuid).url
		}
	}

	/// "Object in Acme Studio" when the reader belongs to that workspace (`workspaceName` is its name
	/// from the workspace switcher list), else "Object in another workspace".
	public func title(workspaceName: String?) -> String {
		let name = workspaceName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		return "\(kindLabel) in \(name.isEmpty ? "another workspace" : name)"
	}
}

/// A GitHub pull request or issue address. Its chip is drawn from the address alone: the repository
/// and the number, never a title or a state (those need GitHub's own answer).
public struct GitHubLink: Equatable, Sendable {
	public enum Kind: Equatable, Sendable { case pullRequest, issue }

	public var kind: Kind
	public var owner: String
	public var repo: String
	public var number: Int

	/// "maskin #2653".
	public var title: String { "\(repo) #\(number)" }

	public var kindLabel: String { kind == .pullRequest ? "Pull request" : "Issue" }

	/// The SF Symbol for the kind: a pull request, or a circle with a dot in it.
	public var symbol: String { kind == .pullRequest ? "arrow.triangle.pull" : "smallcircle.filled.circle" }

	/// `https://github.com/<owner>/<repo>/pull/<n>` or `…/issues/<n>`, with or without a tail such as
	/// `/files`. Anything else on GitHub (a commit, a branch, a user) is not a chip.
	public init?(url: URL) {
		guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
			c.scheme?.lowercased() == "https", c.user == nil, c.password == nil, c.port == nil,
			let host = c.host?.lowercased(), host == "github.com" || host == "www.github.com"
		else { return nil }
		let parts = c.path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
		guard parts.count >= 4, Self.isName(parts[0]), Self.isName(parts[1]),
			(1...9).contains(parts[3].utf8.count), parts[3].utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }),
			let number = Int(parts[3]), number > 0
		else { return nil }
		switch parts[2] {
		case "pull": kind = .pullRequest
		case "issues": kind = .issue
		default: return nil
		}
		owner = parts[0]
		repo = parts[1]
		self.number = number
	}

	/// An owner or repository name: letters, digits, dot, dash and underscore.
	private static func isName(_ s: String) -> Bool {
		guard (1...100).contains(s.utf8.count) else { return false }
		return s.utf8.allSatisfy {
			($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A)
				|| $0 == 0x2D || $0 == 0x5F || $0 == 0x2E
		}
	}
}
