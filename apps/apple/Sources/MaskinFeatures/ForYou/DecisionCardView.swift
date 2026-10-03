import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One For You card. Stateless about the network: everything it shows arrives as values, every
/// gesture leaves as a closure, so it renders in a snapshot test exactly as on screen.
///
/// States, matching the mockup: the open ask (summary, options with their consequences,
/// inline reply), the receipt after a choice ("You chose X · Undo"), queued while offline (amber),
/// waiting on an agent after a typed reply, and a rolled-back failure.
struct DecisionCardView: View {
	struct Actions {
		var choose: (DecisionOption) -> Void = { _ in }
		var reply: (String) -> Void = { _ in }
		var undo: () -> Void = {}
		var dismiss: () -> Void = {}
		var retry: () -> Void = {}
		var open: (() -> Void)?
		var toggleExpanded: (() -> Void)?
	}

	let entry: FeedEntry
	let sender: String?
	let expanded: Bool
	var now: Date = Date()
	var actions = Actions()

	@State private var draft = ""
	@FocusState private var replyFocused: Bool
	/// A destructive option waiting for its "Are you sure?" answer.
	@State private var pendingDestructive: DecisionOption?

	private var card: ForYouCard { entry.card }
	private var record: DecisionRecord? { entry.record }

	var body: some View {
		Group {
			if expanded || record != nil {
				fullCard
			} else {
				compactRow
			}
		}
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero + MaskinSpace.s3, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.hero + MaskinSpace.s3, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1)
		)
		.accessibilityElement(children: .contain)
	}

	// MARK: Compact (list mode)

	private var compactRow: some View {
		Button {
			actions.toggleExpanded?()
		} label: {
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s5) {
				VStack(alignment: .leading, spacing: MaskinSpace.s2) {
					Text(card.headline).maskinText(.headline).foregroundStyle(MaskinColor.ink)
						.lineLimit(2).multilineTextAlignment(.leading)
					HStack(spacing: MaskinSpace.s4) {
						if let status = card.status { StatusBadge(status, style: .word) }
						if let sender { Text(sender).maskinText(.caption).foregroundStyle(MaskinColor.ink4) }
						if let held = ForYouFormat.heldNote(since: card.latestActivityAt, now: now) {
							Text(held).maskinText(.caption).foregroundStyle(ForYouPalette.heldNote)
						}
					}
				}
				Spacer(minLength: MaskinSpace.s4)
				RelativeTime(card.latestActivityAt, style: .compact, compactDayLimit: 7)
					.maskinText(.microLabel).foregroundStyle(MaskinColor.ink5)
			}
			.padding(MaskinSpace.s9)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityHint("Shows the full decision")
	}

	// MARK: Full

	private var fullCard: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			metaRow
			headline
			bodyText
			if let sender { attribution(sender) }

			if let record, !isFailed(record) {
				receipt(record).transition(.opacity)
			} else {
				Group {
					if let failure = failureMessage { failureBanner(failure) }
					if let decision = card.decision {
						optionRows(decision)
					}
					replyBar
				}
				.transition(.opacity)
			}
		}
		// The options fade into the receipt in place, and the card eases to its new height.
		.animation(MaskinMotion.standard, value: record.map { "\($0.phase)" })
		.padding(MaskinSpace.s9)
	}

	@ViewBuilder private var headline: some View {
		let text = Text(card.headline)
			.maskinText(.title).foregroundStyle(MaskinColor.ink)
			.multilineTextAlignment(.leading)
			.frame(maxWidth: .infinity, alignment: .leading)
			.accessibilityAddTraits(.isHeader)
		if let toggle = actions.toggleExpanded {
			Button(action: toggle) { text }.buttonStyle(.plain)
		} else {
			text
		}
	}

	private var metaRow: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
			HStack(spacing: MaskinSpace.s3) {
				if let type = card.objectType { TypeBadge(type, style: .mono) }
				if let title = card.contextTitle {
					Button {
						actions.open?()
					} label: {
						Text(title).maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(1)
					}
					.buttonStyle(.plain)
					.disabled(actions.open == nil)
				}
			}
			Spacer(minLength: MaskinSpace.s3)
			if isWaiting {
				Text("WAITING")
					.maskinText(.microLabel)
					.foregroundStyle(ForYouPalette.waitingForeground)
					.padding(.horizontal, MaskinSpace.s3).padding(.vertical, MaskinSpace.s1)
					.background(ForYouPalette.waitingBackground, in: RoundedRectangle(cornerRadius: MaskinRadius.btn - 2))
			} else if record == nil, let held = ForYouFormat.heldNote(since: card.latestActivityAt, now: now) {
				Text(held).maskinText(.caption).foregroundStyle(ForYouPalette.heldNote)
			}
			RelativeTime(card.latestActivityAt, style: .compact, compactDayLimit: 7)
				.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
		}
	}

	@ViewBuilder private var bodyText: some View {
		if let decision = card.decision {
			VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				Text(decision.summary).maskinText(.body).foregroundStyle(MaskinColor.ink3)
				Text(decision.ask).maskinText(.body).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
			}
			.fixedSize(horizontal: false, vertical: true)
		} else if !card.body.isEmpty {
			MarkdownContent(card.body)
		}
	}

	private func attribution(_ name: String) -> some View {
		HStack(spacing: MaskinSpace.s3) {
			ActorAvatar(name: name, kind: .agent, size: MaskinSpace.s12 - MaskinSpace.s2)
			Text("from \(name)").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
		}
		.accessibilityElement(children: .combine)
	}

	// MARK: Options

	private func optionRows(_ decision: DecisionPrompt) -> some View {
		VStack(spacing: MaskinSpace.s4) {
			ForEach(decision.options) { option in
				Button {
					if option.destructive { pendingDestructive = option } else { actions.choose(option) }
				} label: {
					OptionLabel(option: option)
				}
				.buttonStyle(OptionButtonStyle(recommended: option.recommended))
				.accessibilityLabel(option.recommended ? "\(option.label), recommended" : option.label)
				.accessibilityHint(option.consequences.joined(separator: ". "))
			}
		}
		.confirmationDialog(
			"Are you sure?", isPresented: Binding(
				get: { pendingDestructive != nil }, set: { if !$0 { pendingDestructive = nil } }),
			titleVisibility: .visible, presenting: pendingDestructive
		) { option in
			Button("Yes, \(option.label)", role: .destructive) { actions.choose(option) }
			Button("Cancel", role: .cancel) {}
		} message: { option in
			Text("\u{201C}\(option.label)\u{201D} can't be undone.")
		}
	}

	// MARK: Reply

	private var replyBar: some View {
		HStack(spacing: MaskinSpace.s4) {
			TextField(sender.map { "Reply to \($0)" } ?? "Reply", text: $draft, axis: .vertical)
				.lineLimit(1...4)
				.maskinText(.body)
				.focused($replyFocused)
				.submitLabel(.send)
				.onSubmit(sendReply)
				.padding(.leading, MaskinSpace.s7)
				.frame(minHeight: MaskinSpace.touchMin - MaskinSpace.s2)
			Button(action: sendReply) {
				Image(systemName: "arrow.up")
					.font(.system(size: MaskinFontSize.t15, weight: .bold))
					.foregroundStyle(MaskinSurface.onInverse)
					.frame(width: MaskinSpace.touchMin - MaskinSpace.s2, height: MaskinSpace.touchMin - MaskinSpace.s2)
					.background(MaskinSurface.inverse, in: Circle())
					.opacity(canSend ? 1 : 0.3)
			}
			.buttonStyle(.plain)
			.disabled(!canSend)
			.accessibilityLabel("Send reply")
		}
		.padding(MaskinSpace.s2)
		.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
	}

	private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

	private func sendReply() {
		guard canSend else { return }
		actions.reply(draft)
		draft = ""
		replyFocused = false
	}

	// MARK: Receipts

	private var isWaiting: Bool {
		if let record, case .reply = record.kind, !isFailed(record) { return true }
		return false
	}

	private func isFailed(_ record: DecisionRecord) -> Bool {
		if case .failed = record.phase { return true }
		return false
	}

	private var failureMessage: String? {
		if let record, case .failed(let message) = record.phase { return message }
		return nil
	}

	@ViewBuilder
	private func receipt(_ record: DecisionRecord) -> some View {
		switch record.phase {
		case .queued:
			queuedNote(record)
		case .held, .sending, .sent:
			doneReceipt(record)
		case .failed:
			EmptyView()
		}
	}

	private func doneReceipt(_ record: DecisionRecord) -> some View {
		let title: String
		switch record.kind {
		case .option(let label): title = "You chose \(label)"
		case .reply: title = sender.map { "Reply sent to \($0)" } ?? "Reply sent"
		case .dismissed: title = "Marked as read"
		}
		let sending: Bool = {
			if case .sending = record.phase { return true }
			return false
		}()
		let consequences: [String] = {
			guard case .option(let label) = record.kind else { return [] }
			return card.decision?.options.first(where: { $0.label == label })?.consequences ?? []
		}()
		return VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack(spacing: MaskinSpace.s4) {
				Image(systemName: "checkmark.circle.fill")
					.foregroundStyle(ForYouPalette.receiptCheck)
					.accessibilityHidden(true)
				Text(title).maskinText(.headline).foregroundStyle(ForYouPalette.receiptForeground)
					.frame(maxWidth: .infinity, alignment: .leading)
				if sending {
					ProgressView().controlSize(.small)
				} else if canUndo(record) {
					Button("Undo", action: actions.undo)
						.maskinText(.subhead).fontWeight(.semibold)
						.foregroundStyle(ForYouPalette.receiptForeground)
						.frame(minHeight: MaskinSpace.touchMin)
						.accessibilityHint("Takes the decision back before it is sent")
				}
			}
			if !consequences.isEmpty {
				VStack(alignment: .leading, spacing: MaskinSpace.s2) {
					ForEach(consequences, id: \.self) {
						Text($0).maskinText(.subhead).foregroundStyle(ForYouPalette.receiptSecondary)
					}
				}
				.padding(.leading, MaskinSpace.s12 + MaskinSpace.s1)
			}
			if record.staysUnread, case .sent = record.phase {
				Text("Sent, but this thread will stay in your feed.")
					.maskinText(.caption).foregroundStyle(ForYouPalette.receiptTertiary)
					.padding(.leading, MaskinSpace.s12 + MaskinSpace.s1)
			}
		}
		.padding(MaskinSpace.s7)
		.background(ForYouPalette.receiptBackground, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous)
				.strokeBorder(ForYouPalette.receiptBorder, lineWidth: 1)
		)
		.accessibilityElement(children: .combine)
		.accessibilityAction(named: "Undo") { if canUndo(record) { actions.undo() } }
	}

	private func canUndo(_ record: DecisionRecord) -> Bool {
		if case .held = record.phase { return true }
		if case .dismissed = record.kind, case .sent = record.phase { return true }
		return false
	}

	private func queuedNote(_ record: DecisionRecord) -> some View {
		let what: String
		switch record.kind {
		case .option(let label): what = "\u{201C}\(label)\u{201D}"
		case .reply: what = "Your reply"
		case .dismissed: what = "Your change"
		}
		return HStack(alignment: .top, spacing: MaskinSpace.s4) {
			Image(systemName: "arrow.up.circle.fill")
				.foregroundStyle(MaskinColor.warning)
				.accessibilityHidden(true)
			Text("\(what) is queued. It will send when you're back online.")
				.maskinText(.subhead).foregroundStyle(MaskinSurface.amberForeground)
				.frame(maxWidth: .infinity, alignment: .leading)
		}
		.padding(MaskinSpace.s7)
		.background(MaskinSurface.amberBackground, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
				.strokeBorder(MaskinSurface.amberBorder, lineWidth: 1)
		)
		.accessibilityElement(children: .combine)
	}

	private func failureBanner(_ message: String) -> some View {
		HStack(alignment: .top, spacing: MaskinSpace.s4) {
			Image(systemName: "exclamationmark.triangle.fill")
				.foregroundStyle(ForYouPalette.failureForeground)
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				Text("Couldn't send that. It's back in your feed.")
					.maskinText(.subhead).fontWeight(.semibold)
				Text(message).maskinText(.caption)
			}
			.foregroundStyle(ForYouPalette.failureForeground)
			Spacer(minLength: 0)
			Button("OK", action: actions.retry)
				.maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(ForYouPalette.failureForeground)
				.frame(minHeight: MaskinSpace.touchMin)
		}
		.padding(MaskinSpace.s7)
		.background(ForYouPalette.failureBackground, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
				.strokeBorder(ForYouPalette.failureBorder, lineWidth: 1)
		)
		.accessibilityElement(children: .combine)
	}
}

// MARK: - Option row

private struct OptionLabel: View {
	let option: DecisionOption

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			HStack(spacing: MaskinSpace.s4) {
				Text(option.label).maskinText(.headline).multilineTextAlignment(.leading)
				Spacer(minLength: MaskinSpace.s3)
				if option.recommended {
					Text("RECOMMENDED").maskinText(.microLabel).opacity(0.7)
				}
			}
			ForEach(option.consequences, id: \.self) { line in
				Text(line).maskinText(.subhead).opacity(0.72).multilineTextAlignment(.leading)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}

/// The recommended option is the filled inverse bar; the others are outlined.
private struct OptionButtonStyle: ButtonStyle {
	let recommended: Bool
	@Environment(\.isEnabled) private var isEnabled

	func makeBody(configuration: Configuration) -> some View {
		let shape = RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
		configuration.label
			.foregroundStyle(recommended ? MaskinSurface.onInverse : MaskinColor.ink)
			.padding(.horizontal, MaskinSpace.s9)
			.padding(.vertical, MaskinSpace.s7)
			.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s3)
			.background(recommended ? MaskinSurface.inverse : MaskinSurface.card, in: shape)
			.overlay(shape.strokeBorder(recommended ? Color.clear : MaskinSurface.line, lineWidth: 1))
			.opacity(isEnabled ? 1 : 0.4)
			.scaleEffect(configuration.isPressed ? 0.985 : 1)
			.animation(MaskinMotion.quick, value: configuration.isPressed)
			.contentShape(shape)
	}
}

extension DecisionCardView.Actions {
	/// The gestures wired to a `ForYouStore`, with the same haptics, animation and VoiceOver
	/// announcements wherever the card appears (the feed, an object's detail).
	@MainActor
	static func live(
		store: ForYouStore, entry: FeedEntry, openObject: ((String) -> Void)?
	) -> Self {
		let card = entry.card
		func announce(_ text: String) { AccessibilityNotification.Announcement(text).post() }
		var actions = Self()
		actions.choose = { option in
			MaskinHaptics.play(.success)
			withAnimation(MaskinMotion.standard) { store.choose(option, on: card) }
			announce("You chose \(option.label). Undo is available for a few seconds.")
		}
		actions.reply = { text in
			MaskinHaptics.play(.light)
			withAnimation(MaskinMotion.standard) { store.reply(text, on: card) }
			announce("Reply sent.")
		}
		actions.undo = {
			MaskinHaptics.play(.selection)
			withAnimation(MaskinMotion.standard) { _ = store.undo(card) }
		}
		actions.dismiss = {
			MaskinHaptics.play(.selection)
			withAnimation(MaskinMotion.standard) { store.dismiss(card) }
		}
		actions.retry = { store.decisions.clear(card.id) }
		if let open = openObject { actions.open = { open(card.id) } }
		return actions
	}
}
