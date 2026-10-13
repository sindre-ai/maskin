import Foundation
import Observation

/// Unsent text per conversation, kept for the life of the process so switching threads (or the
/// split view rebuilding its detail column) never throws away what someone was typing. Never
/// written to disk and never sent anywhere; cleared on sign-out.
///
/// `ChatComposerModel.bind(conversationID:)` writes here on every keystroke; the Team list reads
/// `draft(for:)` to show "Draft: {text}" in a row. Reads inside a SwiftUI `body` are observed, so
/// a row updates as the draft changes.
@MainActor
public enum ChatDraftStore {
	@Observable
	final class Storage {
		var drafts: [String: String] = [:]
	}

	static let storage = Storage()

	/// The saved draft, or nil when there is nothing unsent. Whitespace-only text never counts.
	public static func draft(for conversationID: String) -> String? { storage.drafts[conversationID] }

	public static func text(for conversationID: String) -> String { draft(for: conversationID) ?? "" }

	public static func set(_ text: String, for conversationID: String) {
		if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			storage.drafts[conversationID] = nil
		} else {
			storage.drafts[conversationID] = text
		}
	}

	public static func clearAll() { storage.drafts = [:] }
}
