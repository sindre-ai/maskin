import MaskinCore
import MaskinDesign
import SwiftUI

/// One card, several messages: each is its own preview with its own quiet Send and Skip, stacked so
/// the reader decides them one at a time. Send reaches a real person, so it asks first. A message
/// that has been dealt with folds down to a one-line receipt, and once the last one is, the card
/// is marked read (`allDone`). The card's own options still apply to the whole batch.
struct DraftStackView: View {
	let drafts: [DecisionDraft]
	/// Queues the reply for one message. Returns false when it could not be queued, so the message stays open.
	let act: (DecisionDraft, DecisionService.DraftAction) -> Bool
	/// Every message has been sent or skipped.
	let allDone: () -> Void

	@State private var done: [String: DecisionService.DraftAction] = [:]
	@State private var confirming: DecisionDraft?
	@State private var failedKey: String?

	private func key(_ draft: DecisionDraft, _ index: Int) -> String { draft.id ?? String(index) }

	/// Something to send: a file card or a draft already approved or sent has no Send and Skip.
	private func offersActions(_ draft: DecisionDraft) -> Bool {
		draft.file == nil && draft.preview?.delivery != .approved && draft.preview?.delivery != .sent
	}

	private func name(_ draft: DecisionDraft) -> String {
		let to = draft.to?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		return to.isEmpty ? draft.label : to
	}

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			ForEach(Array(drafts.enumerated()), id: \.offset) { index, draft in
				let k = key(draft, index)
				if let outcome = done[k] {
					Text(
						outcome == .send
							? "Told the agent to send \u{00B7} \(name(draft))" : "Skipped \u{00B7} \(name(draft))"
					)
					.font(MaskinTypeface.sans(MaskinFontSize.t13))
					.foregroundStyle(MaskinColor.ink4)
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding(MaskinSpace.s6)
					.overlay(
						RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous)
							.strokeBorder(MaskinSurface.line, lineWidth: 1))
					.accessibilityElement(children: .combine)
				} else {
					VStack(alignment: .leading, spacing: MaskinSpace.s5) {
						DraftPreview(draft: draft, showsReadOnlyNote: false)
						if offersActions(draft) {
							HStack(spacing: MaskinSpace.s5) {
								Button {
									confirming = draft
								} label: {
									// Quiet on purpose: the card's own ink bar is the main action, this is
									// for sending one reply on its own.
									Text("Send")
										.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
										.foregroundStyle(MaskinColor.ink)
										.frame(minWidth: MaskinSpace.touchMin * 2, minHeight: MaskinSpace.touchMin)
										.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
										.contentShape(Capsule())
								}
								.buttonStyle(.maskinPressed(.shrink))
								.accessibilityLabel("Send to \(name(draft))")
								Button {
									settle(draft, index: index, action: .skip)
								} label: {
									Text("Skip")
										.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
										.foregroundStyle(MaskinColor.ink4)
										.frame(minWidth: MaskinSpace.touchMin * 1.5, minHeight: MaskinSpace.touchMin)
								}
								.accessibilityLabel("Skip \(name(draft))")
								if failedKey == k {
									Text("Couldn\u{2019}t send your reply. Try again.")
										.font(MaskinTypeface.sans(MaskinFontSize.t12))
										.foregroundStyle(MaskinColor.ink4)
								}
							}
						}
					}
				}
			}
		}
		.confirmationDialog(
			confirming.map { "Send to \(name($0))?" } ?? "Send?",
			isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
			titleVisibility: .visible
		) {
			Button("Send") {
				if let draft = confirming, let index = drafts.firstIndex(of: draft) {
					settle(draft, index: index, action: .send)
				}
				confirming = nil
			}
			Button("Cancel", role: .cancel) { confirming = nil }
		} message: {
			Text("This can\u{2019}t be undone. It goes to a real person.")
		}
	}

	private func settle(_ draft: DecisionDraft, index: Int, action: DecisionService.DraftAction) {
		let k = key(draft, index)
		guard act(draft, action) else {
			failedKey = k
			return
		}
		failedKey = nil
		withAnimation(MaskinMotion.standard) { done[k] = action }
		if done.count == drafts.filter(offersActions).count { allDone() }
	}
}
