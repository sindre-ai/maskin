import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// A draft an agent wants approved, as a card in the conversation: what it is, where it goes, the
/// exact text, and Approve. Tapping the head folds it open and shut. Approving records the person's
/// yes to this exact text (the preview's hash), then tells the agent what was approved.
struct LinkedDraftCard: View {
	let object: WorkObject
	let preview: ObjectPreview
	/// Tells the agent after a successful approval: the draft's title and the text that was approved.
	var onApproved: (_ title: String?, _ body: String) -> Void = { _, _ in }
	/// Tells the agent the person skipped the draft. Nil where nobody can be told (the Linked
	/// sheet), so the Skip button is not drawn at all.
	var onSkipped: (() -> Void)?

	@Environment(\.linkedItems) private var store
	@State private var expanded: Bool
	/// What the reader has typed over the draft; nil while the draft reads as the agent wrote it.
	@State private var edit: DraftEdit?
	/// Skip was pressed on this device; the button then reads Skipped.
	@State private var skipped: Bool

	init(
		object: WorkObject, preview: ObjectPreview, defaultExpanded: Bool = false, edited: DraftEdit? = nil,
		skipped: Bool = false,
		onApproved: @escaping (_ title: String?, _ body: String) -> Void = { _, _ in },
		onSkipped: (() -> Void)? = nil
	) {
		self.object = object
		self.preview = preview
		self.onApproved = onApproved
		self.onSkipped = onSkipped
		_skipped = State(initialValue: skipped)
		_expanded = State(initialValue: defaultExpanded)
		_edit = State(initialValue: edited)
	}

	private var title: String {
		let trimmed = object.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		return trimmed.isEmpty ? "Untitled" : trimmed
	}

	private var phase: DraftApprovalPhase? { store?.phase(of: object.id) }
	private var isApproving: Bool { phase == .approving }

	private var isEmail: Bool { preview.kind == "email" }
	private var original: DraftEdit { DraftEdit(preview: preview) }
	private var current: DraftEdit { edit ?? original }
	/// A draft not yet approved or sent is drawn as an editor (read-only while it is being approved).
	private var canEdit: Bool {
		store != nil && (preview.delivery == nil || preview.delivery == .draft)
	}

	/// What the lines above the text show. An email's subject is a field while editing, so its
	/// read-only line is left out.
	private var metaPreview: ObjectPreview {
		guard canEdit, isEmail else { return preview }
		var rest = preview
		rest.subject = nil
		return rest
	}

	private func keep(_ new: DraftEdit) {
		edit = new == original ? nil : new
		if case .failed? = phase { store?.clearApprovalFailure(object.id) }
	}

	var body: some View {
		LinkedCardChrome {
			VStack(alignment: .leading, spacing: 0) {
				head
				if expanded {
					Rectangle().fill(MaskinSurface.separator).frame(height: 1)
					details
				}
			}
		}
		.accessibilityElement(children: .contain)
		// A draft that was read again (it changed, or it was approved) starts from its new text.
		.onChange(of: preview.contentHash) { edit = nil }
	}

	private var head: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s3) {
			Button {
				withAnimation(MaskinMotion.standard) { expanded.toggle() }
			} label: {
				VStack(alignment: .leading, spacing: MaskinSpace.s3) {
					HStack(spacing: MaskinSpace.s4) {
						LinkedKindChip(text: preview.label)
						Spacer(minLength: 0)
						LinkedChevron(expanded: expanded)
					}
					Text(title)
						.maskinText(.subhead).fontWeight(.semibold)
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(expanded ? nil : 1)
						.multilineTextAlignment(.leading)
						.frame(maxWidth: .infinity, alignment: .leading)
				}
				.padding(.vertical, MaskinSpace.s5)
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.accessibilityLabel("\(preview.label), \(title)")
			.accessibilityValue(expanded ? "Expanded" : "Collapsed")
			.accessibilityHint(expanded ? "Contracts the preview" : "Expands the preview")
			LinkedOpenButton(target: LinkedTarget(kind: .object, uuid: object.id))
				.padding(.top, MaskinSpace.s1)
		}
		.padding(.leading, MaskinSpace.s6)
		.padding(.trailing, MaskinSpace.s3)
	}

	private var details: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			ObjectPreviewMetaView(preview: metaPreview)
			if let original = preview.originalMessage { originalMessage(original) }
			if canEdit && isEmail { subjectField }
			if canEdit {
				bodyEditor
				editedRow
			} else {
				Text(preview.body)
					.font(MaskinTypeface.sans(MaskinFontSize.t15))
					.lineSpacing(MaskinSpace.s2)
					.foregroundStyle(MaskinColor.ink)
					.frame(maxWidth: .infinity, alignment: .leading)
					.fixedSize(horizontal: false, vertical: true)
			}
			footer
		}
		.padding(.horizontal, MaskinSpace.s6)
		.padding(.vertical, MaskinSpace.s5)
	}

	/// The message this draft answers, above the draft text. Read only, and not part of what Approve
	/// is bound to.
	private func originalMessage(_ text: String) -> some View {
		HStack(alignment: .top, spacing: MaskinSpace.s4) {
			RoundedRectangle(cornerRadius: MaskinRadius.tag, style: .continuous)
				.fill(MaskinColor.sigHi).frame(width: MaskinSpace.s1 + 1)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text("In reply to")
					.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .bold))
					.foregroundStyle(MaskinColor.ink4)
				Text(text)
					.font(MaskinTypeface.sans(MaskinFontSize.t14))
					.foregroundStyle(MaskinColor.ink3)
					.frame(maxWidth: .infinity, alignment: .leading)
					.fixedSize(horizontal: false, vertical: true)
			}
		}
		.fixedSize(horizontal: false, vertical: true)
		.accessibilityElement(children: .combine)
		.accessibilityLabel("In reply to: \(text)")
	}

	private var subjectField: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s5) {
			Text("Subject")
				.font(MaskinTypeface.sans(MaskinFontSize.t14))
				.foregroundStyle(MaskinColor.ink5)
				.frame(width: 72, alignment: .leading)
			TextField(
				"Subject",
				text: Binding(
					get: { current.subject ?? "" },
					set: { value in
						var next = current
						next.subject = value
						keep(next)
					})
			)
			.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
			.foregroundStyle(MaskinColor.ink)
			.disabled(isApproving)
			.accessibilityLabel("Subject")
		}
		.frame(minHeight: MaskinSpace.touchMin)
	}

	private var bodyEditor: some View {
		DraftBodyEditor(
			text: Binding(
				get: { current.body },
				set: { value in
					var next = current
					next.body = value
					keep(next)
				}),
			isEnabled: !isApproving, accessibilityLabel: preview.kind == "linkedin_post" ? "Post text" : "Message text"
		)
		.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.tag2, style: .continuous))
	}

	/// "Edited" and the way back to the agent's text, once the reader has changed something.
	@ViewBuilder
	private var editedRow: some View {
		if edit != nil {
			HStack(spacing: MaskinSpace.s4) {
				Text("Edited")
					.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .bold))
					.foregroundStyle(MaskinColor.successStrong)
					.frame(maxWidth: .infinity, alignment: .leading)
				Button {
					MaskinHaptics.play(.selection)
					withAnimation(MaskinMotion.standard) { keep(original) }
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
	}

	@ViewBuilder
	private var footer: some View {
		VStack(alignment: .trailing, spacing: MaskinSpace.s3) {
			switch preview.delivery {
			case .sent: receipt("Sent")
			case .approved: receipt("Approved")
			case .draft, nil:
				HStack(spacing: MaskinSpace.s4) {
					if onSkipped != nil { skipButton }
					approveButton
				}
			}
			if let reason = blockedReason {
				Text(reason)
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink4)
					.frame(maxWidth: .infinity, alignment: .trailing)
					.multilineTextAlignment(.trailing)
			}
			if case .failed(let message)? = phase {
				Text(message)
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.danger)
					.frame(maxWidth: .infinity, alignment: .trailing)
					.multilineTextAlignment(.trailing)
					.accessibilityLabel("Could not approve. \(message)")
			}
		}
		.frame(maxWidth: .infinity, alignment: .trailing)
	}

	/// Why Approve is off because of what the reader typed. Something the draft itself lacks is
	/// not explained here, as before.
	private var blockedReason: String? {
		guard canEdit, preview.canApprove, !isApproving else { return nil }
		return current.blockedReason(isEmail: isEmail)
	}

	private func receipt(_ text: String) -> some View {
		Label(text, systemImage: "checkmark")
			.maskinText(.caption).fontWeight(.semibold)
			.foregroundStyle(MaskinColor.ink4)
			.frame(minHeight: MaskinSpace.touchMin)
	}

	private var skipButton: some View {
		Button {
			MaskinHaptics.play(.light)
			skipped = true
			onSkipped?()
		} label: {
			Text(skipped ? "Skipped" : "Skip")
				.maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(MaskinColor.ink)
				.padding(.horizontal, MaskinSpace.s8)
				.frame(minHeight: MaskinSpace.touchMin - MaskinSpace.s3)
				.background(MaskinSurface.fill, in: Capsule())
				.opacity(isApproving || skipped ? 0.4 : 1)
		}
		.buttonStyle(.maskinPressed(.shrink))
		.disabled(isApproving || skipped)
		.accessibilityLabel(skipped ? "Skipped \(title)" : "Skip \(title)")
		.accessibilityHint("Tells the agent not to send this draft")
	}

	private var approveButton: some View {
		let enabled = preview.canApprove && current.isApprovable(isEmail: isEmail) && !isApproving && store != nil
		return Button(action: approve) {
			HStack(spacing: MaskinSpace.s3) {
				if isApproving { ProgressView().controlSize(.small).tint(MaskinSurface.onInverse) }
				Text("Approve")
			}
			.maskinText(.subhead).fontWeight(.semibold)
			.foregroundStyle(MaskinSurface.onInverse)
			.padding(.horizontal, MaskinSpace.s9)
			.frame(minHeight: MaskinSpace.touchMin - MaskinSpace.s3)
			.background(MaskinSurface.inverse, in: Capsule())
			.opacity(enabled ? 1 : 0.4)
		}
		.buttonStyle(.maskinPressed(.shrink))
		.disabled(!enabled)
		.accessibilityLabel("Approve \(title)")
		.accessibilityHint(preview.canApprove ? "Approves the text exactly as shown" : "Something the draft needs is missing")
	}

	private func approve() {
		guard let store else { return }
		let shown = preview
		let text = current
		Task {
			let result = await store.approve(objectID: object.id, preview: shown, edit: text)
			if case .approved(let approved) = result {
				MaskinHaptics.play(.success)
				onApproved(object.title, approved.body)
			} else {
				MaskinHaptics.play(.warning)
			}
		}
	}
}
