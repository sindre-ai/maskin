import Foundation

/// How a glance screen (watch, TV) answers a decision, kept out of the view so it is testable.
public enum GlanceAnswer {
	/// What tapping an option does: send it, or ask first.
	public enum Step: Equatable, Sendable {
		case send(JSONValue)
		/// Destructive options (cannot be undone, or reach real people) ask "Are you sure?" first:
		/// one stray tap on a wrist or a remote must not send them. The view sends the action's
		/// response once the person confirms.
		case confirm(AppNotification.Action)
	}

	public static func step(for action: AppNotification.Action) -> Step {
		action.style == .destructive ? .confirm(action) : .send(action.response)
	}

	/// The text to send for a typed or dictated reply, or `nil` when there is nothing to send.
	public static func reply(from raw: String) -> JSONValue? {
		let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
		return text.isEmpty ? nil : .string(text)
	}

	/// Leave the screen only when the answer went through. A refusal reverts the row and leaves an
	/// error, which the screen must still be showing.
	public static func shouldDismiss(actionError: String?) -> Bool { actionError == nil }
}
