import Foundation

/// One `Idempotency-Key` per user intent, held until the intent definitely succeeds.
///
/// A response lost on the wire leaves the caller not knowing whether the server applied the
/// write; tapping again with a *fresh* key would apply it twice (two triggers, two runs). Asking
/// for the same intent again returns the same key, so the server collapses the retry. The key is
/// dropped on success, and a different intent (an edited draft) is a different key.
struct IntentKeys {
	private var keys: [String: String] = [:]

	/// The key for `intent`, minted on first use and reused until `succeeded`.
	mutating func key(for intent: String) -> String {
		if let existing = keys[intent] { return existing }
		let key = UUID().uuidString
		keys[intent] = key
		return key
	}

	mutating func succeeded(_ intent: String) { keys[intent] = nil }
}
