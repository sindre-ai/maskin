import Foundation

/// Unsent text per conversation, kept for the life of the process so switching threads (or the
/// split view rebuilding its detail column) never throws away what someone was typing. Never
/// written to disk and never sent anywhere; cleared on sign-out.
@MainActor
public enum ChatDraftStore {
	private static var drafts: [String: String] = [:]

	public static func text(for conversationID: String) -> String { drafts[conversationID] ?? "" }

	public static func set(_ text: String, for conversationID: String) {
		if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			drafts[conversationID] = nil
		} else {
			drafts[conversationID] = text
		}
	}

	public static func clearAll() { drafts = [:] }
}
