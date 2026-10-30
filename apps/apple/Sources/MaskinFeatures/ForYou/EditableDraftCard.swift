import MaskinCore
import MaskinDesign
import SwiftUI

/// A message an agent drafted, open for editing and approval right in the feed: a tag for what it
/// is, who wrote it, the text itself as an editable field (and for an email, who it goes to and the
/// subject), and one button that approves what is on screen. "Edited" shows as soon as the text
/// differs from the agent's, and Revert puts the agent's text back.
///
/// The button sends the EDITED text: the store saves the edit to the draft before approving it.
struct EditableDraftCard: View {
	let draft: ReviewDraft
	let store: DraftReviewStore

	@ScaledMetric(relativeTo: .body) private var labelWidth: CGFloat = 64
	@Environment(\.dynamicTypeSize) private var typeSize

	private var edit: DraftEdit { store.edit(for: draft) }
	private var failure: String? {
		if case .failed(let message) = store.phase(of: draft) { return message }
		return nil
	}

	private var bodyFont: Font { MaskinTypeface.sans(MaskinFontSize.t15) }

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			head
			Rectangle().fill(MaskinSurface.separator).frame(height: 1)
			if draft.isEmail { emailRows }
			bodyEditor
			hintRow
			if let reason = store.blockedReason(draft) { reasonRow(reason) }
			if let failure { failureRow(failure) }
			approveButton
		}
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.brief, style: .continuous))
		.accessibilityElement(children: .contain)
	}

	// MARK: Head

	private var head: some View {
		let layout = typeSize.isAccessibilitySize
			? AnyLayout(VStackLayout(alignment: .leading, spacing: MaskinSpace.s3))
			: AnyLayout(HStackLayout(spacing: MaskinSpace.s4))
		return layout {
			Text(draft.chip)
				.font(MaskinTypeface.mono(MaskinFontSize.t11, weight: .semibold)).tracking(0.88)
				.foregroundStyle(MaskinColor.successStrong)
				.padding(.horizontal, MaskinSpace.s4)
				.padding(.vertical, MaskinSpace.s2)
				.background(MaskinColor.successTint, in: RoundedRectangle(cornerRadius: MaskinRadius.tag2, style: .continuous))
			Text(draft.source)
				.font(MaskinTypeface.sans(MaskinFontSize.t13))
				.foregroundStyle(MaskinColor.ink4)
				.lineLimit(typeSize.isAccessibilitySize ? nil : 1)
				.frame(maxWidth: .infinity, alignment: .leading)
			if store.isEdited(draft) {
				Text("Edited")
					.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .bold))
					.foregroundStyle(MaskinColor.successStrong)
			}
		}
		.padding(.horizontal, MaskinSpace.s8)
		.padding(.vertical, MaskinSpace.s6)
	}

	// MARK: Email fields

	private var emailRows: some View {
		VStack(spacing: 0) {
			if let to = draft.toLine {
				fieldRow(label: "To") {
					Text(to)
						.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
						.foregroundStyle(MaskinColor.ink)
						.frame(maxWidth: .infinity, alignment: .leading)
				}
				Rectangle().fill(MaskinSurface.separator).frame(height: 1)
			}
			fieldRow(label: "Subject") {
				TextField(
					"Subject",
					text: Binding(
						get: { store.edit(for: draft).subject ?? "" },
						set: { store.setSubject($0, for: draft) })
				)
				.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
				.foregroundStyle(MaskinColor.ink)
				.disabled(!store.isEditable(draft))
				.accessibilityLabel("Subject")
			}
			Rectangle().fill(MaskinSurface.separator).frame(height: 1)
		}
		.padding(.horizontal, MaskinSpace.s8)
	}

	private func fieldRow<Content: View>(label: String, @ViewBuilder content: () -> Content) -> some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s5) {
			Text(label)
				.font(MaskinTypeface.sans(MaskinFontSize.t14))
				.foregroundStyle(MaskinColor.ink5)
				.frame(width: labelWidth, alignment: .leading)
			content()
		}
		.frame(minHeight: MaskinSpace.touchMin)
	}

	// MARK: Text

	private var bodyEditor: some View {
		let text = Binding(
			get: { store.edit(for: draft).body },
			set: { store.setBody($0, for: draft) })
		return ZStack(alignment: .topLeading) {
			// An invisible copy of the text gives the editor its height: it grows with what is typed.
			Text(text.wrappedValue + "\n")
				.font(bodyFont).lineSpacing(MaskinSpace.s2)
				.opacity(0)
				.padding(.horizontal, MaskinSpace.s2 + MaskinSpace.s1)
				.padding(.vertical, MaskinSpace.s4)
				.frame(maxWidth: .infinity, alignment: .leading)
				.accessibilityHidden(true)
			TextEditor(text: text)
				.font(bodyFont).lineSpacing(MaskinSpace.s2)
				.foregroundStyle(MaskinColor.ink)
				.scrollContentBackground(.hidden)
				.scrollDisabled(true)
				.disabled(!store.isEditable(draft))
				.accessibilityLabel(draft.isPost ? "Post text" : "Message text")
				.accessibilityHint("Double tap to edit")
		}
		.frame(minHeight: MaskinSpace.touchMin * 3)
		.padding(.horizontal, MaskinSpace.s8 - (MaskinSpace.s2 + MaskinSpace.s1))
		.padding(.top, MaskinSpace.s5)
	}

	private var hintRow: some View {
		HStack(spacing: MaskinSpace.s4) {
			Text(draft.hint)
				.font(MaskinTypeface.sans(MaskinFontSize.t12))
				.foregroundStyle(MaskinColor.ink5)
				.frame(maxWidth: .infinity, alignment: .leading)
			if store.isEdited(draft), store.isEditable(draft) {
				Button {
					MaskinHaptics.play(.selection)
					withAnimation(MaskinMotion.standard) { store.revert(draft) }
				} label: {
					Text("Revert to draft")
						.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
						.foregroundStyle(MaskinColor.ink)
						.padding(.horizontal, MaskinSpace.s4)
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
				}
				.buttonStyle(.maskinPressed)
				.accessibilityHint("Puts back the text the agent wrote")
			}
		}
		.padding(.horizontal, MaskinSpace.s8)
		.padding(.bottom, MaskinSpace.s3)
	}

	// MARK: Actions

	private func reasonRow(_ reason: String) -> some View {
		Text(reason)
			.font(MaskinTypeface.sans(MaskinFontSize.t13))
			.foregroundStyle(MaskinColor.ink3)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, MaskinSpace.s8)
			.padding(.bottom, MaskinSpace.s4)
	}

	private func failureRow(_ message: String) -> some View {
		Text(message)
			.font(MaskinTypeface.sans(MaskinFontSize.t13))
			.foregroundStyle(ForYouPalette.failureForeground)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, MaskinSpace.s8)
			.padding(.bottom, MaskinSpace.s4)
			.accessibilityLabel("Couldn\u{2019}t send. \(message)")
	}

	private var approveButton: some View {
		let retrying = failure != nil
		let enabled = store.canApprove(draft)
		return Button {
			MaskinHaptics.play(.success)
			if retrying {
				store.retry(draft)
			} else {
				withAnimation(MaskinMotion.standard) { store.approve(draft) }
				AccessibilityNotification.Announcement("Approved. Sending in a few seconds. Undo is available.").post()
			}
		} label: {
			Text(retrying ? "Try again" : draft.approveTitle)
				.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .bold))
				.foregroundStyle(MaskinSurface.onInverse)
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin + MaskinSpace.s4)
				.background(MaskinSurface.inverse, in: Capsule())
				.opacity(enabled ? 1 : 0.4)
				.contentShape(Capsule())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.disabled(!enabled)
		.padding(.horizontal, MaskinSpace.s8)
		.padding(.bottom, MaskinSpace.s8)
		.accessibilityLabel(retrying ? "Try again" : draft.approveTitle)
		.accessibilityHint(hint(enabled: enabled))
	}

	private func hint(enabled: Bool) -> String {
		store.blockedReason(draft) ?? "Sends the text as shown. You can undo for a few seconds."
	}
}

/// What replaces a draft once it is approved: a one-line receipt. While Undo is free it says the
/// message is on its way and offers Undo; once it has gone it says so, and Undo is gone with it.
struct DraftReceiptStrip: View {
	let draft: ReviewDraft
	let store: DraftReviewStore

	private var phase: DraftReviewStore.Phase { store.phase(of: draft) }

	private var text: String {
		if case .sent = phase { return draft.sentText }
		return draft.sendingText
	}

	private var canUndo: Bool {
		if case .held = phase { return true }
		return false
	}

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: MaskinRadius.brief, style: .continuous)
		HStack(spacing: MaskinSpace.s5) {
			Image(systemName: "checkmark")
				.maskinSymbol(MaskinFontSize.t13, weight: .bold)
				.foregroundStyle(ForYouPalette.receiptBackground)
				.frame(width: MaskinSpace.s12, height: MaskinSpace.s12)
				.background(ForYouPalette.receiptCheck, in: Circle())
				.accessibilityHidden(true)
			Text(text)
				.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
				.foregroundStyle(ForYouPalette.receiptForeground)
				.frame(maxWidth: .infinity, alignment: .leading)
			if canUndo {
				Button {
					MaskinHaptics.play(.selection)
					withAnimation(MaskinMotion.standard) { store.undo(draft) }
				} label: {
					Text("Undo")
						.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
						.foregroundStyle(ForYouPalette.receiptForeground)
						.padding(.horizontal, MaskinSpace.s4)
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
				}
				.buttonStyle(.maskinPressed)
				.accessibilityLabel("Undo. Don\u{2019}t send")
			}
		}
		.padding(.horizontal, MaskinSpace.s7)
		.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s5)
		.background(ForYouPalette.receiptBackground, in: shape)
		.overlay(shape.strokeBorder(ForYouPalette.receiptBorder, lineWidth: 1))
		.accessibilityElement(children: .contain)
	}
}
