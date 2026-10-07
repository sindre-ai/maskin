import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One inbox row: avatar, title, body, time, and inline answers for notifications that need one.
struct NotificationRow: View {
	let notification: AppNotification
	let actor: NotificationActor?
	let isBusy: Bool
	let onRespond: (JSONValue) -> Void
	/// Opens the thing the notification is about. The title/body block is a real `Button` (not a
	/// tap gesture) so VoiceOver, Switch Control and keyboards get the button trait and activation.
	var onOpen: (() -> Void)?

	@State private var reply = ""
	@Environment(\.dynamicTypeSize) private var typeSize

	private var senderName: String { actor?.name ?? "Unknown sender" }

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s7) {
			ActorAvatar(
				name: senderName, kind: (actor?.isAgent ?? true) ? .agent : .human,
				size: MaskinSpace.s14 + MaskinSpace.s2, seed: notification.sourceActorId
			)
			.accessibilityHidden(true)

			VStack(alignment: .leading, spacing: MaskinSpace.gapSnug) {
				openButton {
					VStack(alignment: .leading, spacing: MaskinSpace.gapSnug) {
						header
						if let content = notification.content, !content.isEmpty {
							Text(content)
								.maskinText(.subhead)
								.foregroundStyle(MaskinColor.ink3)
								.lineLimit(notification.canRespond ? 6 : 3)
						}
					}
				}
				if notification.canRespond {
					answers.padding(.top, MaskinSpace.gapTight)
				} else if let answer = answerSummary {
					Label(answer, systemImage: "checkmark.circle.fill")
						.maskinText(.caption)
						.foregroundStyle(MaskinColor.successStrong)
						.accessibilityLabel("You answered: \(answer)")
				}
			}
			.accessibilityElement(children: .contain)
		}
		.padding(.vertical, MaskinSpace.gapTight)
		.opacity(isBusy ? 0.6 : 1)
		.animation(MaskinMotion.quick, value: isBusy)
	}

	// MARK: Pieces

	@ViewBuilder private func openButton<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
		if let onOpen {
			Button(action: onOpen) {
				content().frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityHint("Opens the notification")
		} else {
			content()
		}
	}

	private var header: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s1) {
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.gapDefault) {
				if notification.isUnread {
					Circle().fill(MaskinGradient.badge).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
						.accessibilityHidden(true)
				}
				Text(notification.title)
					.maskinText(notification.isUnread ? .headline : .subhead)
					.foregroundStyle(notification.isUnread ? MaskinColor.ink : MaskinColor.ink2)
					.fixedSize(horizontal: false, vertical: true)
				Spacer(minLength: MaskinSpace.gapDefault)
				RelativeTime(notification.createdAt, style: .compact)
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink4)
			}
			HStack(spacing: MaskinSpace.gapTight) {
				Image(systemName: Self.symbol(for: notification.kind))
					.foregroundStyle(Self.tint(for: notification.kind))
					.accessibilityHidden(true)
				Text("\(senderName) · \(Self.label(for: notification.kind))")
					.foregroundStyle(MaskinColor.ink4)
			}
			.maskinText(.caption)
		}
		.accessibilityElement(children: .combine)
		.accessibilityValue(notification.isUnread ? "Unread" : "")
	}

	@ViewBuilder private var answers: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.gapDefault) {
			if let question = notification.question, !question.isEmpty, question != notification.title {
				Text(question).maskinText(.subhead).foregroundStyle(MaskinColor.ink2)
			}
			ForEach(notification.actions) { action in
				actionButton(action)
			}
			if notification.wantsText {
				HStack(spacing: MaskinSpace.gapDefault) {
					TextField(notification.placeholder ?? "Reply", text: $reply, axis: .vertical)
						.textFieldStyle(.roundedBorder)
						.lineLimit(1...4)
					Button("Send") {
						let text = reply.trimmingCharacters(in: .whitespacesAndNewlines)
						guard !text.isEmpty else { return }
						onRespond(.string(text))
						reply = ""
					}
					.disabled(isBusy || reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
				}
			}
		}
		// Full-width buttons are right on a phone but absurd on an iPad or Mac window.
		.frame(maxWidth: 400, alignment: .leading)
	}

	@ViewBuilder private func actionButton(_ action: AppNotification.Action) -> some View {
		let button = Button {
			onRespond(action.response)
		} label: {
			VStack(spacing: MaskinSpace.s1) {
				Text(action.label)
				if let detail = action.detail {
					Text(detail).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			}
		}
		.disabled(isBusy)
		if action.style == .primary {
			button.buttonStyle(.primaryAction)
		} else {
			button.buttonStyle(.secondaryAction)
		}
	}

	/// What the human answered, for resolved rows: only simple strings are echoed.
	private var answerSummary: String? {
		guard notification.status == .resolved, case .string(let s)? = notification.response else {
			return nil
		}
		// Prefer the button label whose value was sent.
		return notification.actions.first { $0.response == .string(s) }?.label ?? s
	}

	// MARK: Kind presentation

	static func symbol(for kind: AppNotification.Kind) -> String {
		switch kind {
		case .needsInput: "hand.raised.fill"
		case .recommendation: "lightbulb.fill"
		case .goodNews: "checkmark.seal.fill"
		case .alert: "exclamationmark.triangle.fill"
		case .other: "bell.fill"
		}
	}

	static func label(for kind: AppNotification.Kind) -> String {
		switch kind {
		case .needsInput: "Needs you"
		case .recommendation: "Recommendation"
		case .goodNews: "Good news"
		case .alert: "Alert"
		case .other: "Update"
		}
	}

	static func tint(for kind: AppNotification.Kind) -> Color {
		switch kind {
		case .needsInput: MaskinColor.sigInk
		case .recommendation: MaskinColor.warning
		case .goodNews: MaskinColor.success
		case .alert: MaskinColor.danger
		case .other: MaskinColor.ink4
		}
	}
}
