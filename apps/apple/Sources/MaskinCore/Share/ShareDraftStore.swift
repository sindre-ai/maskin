import Foundation

/// The title and note of a share the person started typing but did not send, so dismissing the
/// sheet (or the system ending the extension) never costs them their words. One slot: only the
/// latest draft matters, and it only comes back for the same content (`ShareContent.fingerprint`).
public final class ShareDraftStore: @unchecked Sendable {
	struct Draft: Codable, Equatable {
		var fingerprint: String
		var title: String
		var note: String
	}

	private let defaults: UserDefaults
	private let key = "maskin.share.draft"

	public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

	public func save(fingerprint: String, title: String, note: String) {
		let draft = Draft(fingerprint: fingerprint, title: title, note: note)
		defaults.set(try? JSONEncoder().encode(draft), forKey: key)
	}

	public func load(fingerprint: String) -> (title: String, note: String)? {
		guard let data = defaults.data(forKey: key), let draft = try? JSONDecoder().decode(Draft.self, from: data),
			draft.fingerprint == fingerprint
		else { return nil }
		return (draft.title, draft.note)
	}

	public func clear() { defaults.removeObject(forKey: key) }
}
