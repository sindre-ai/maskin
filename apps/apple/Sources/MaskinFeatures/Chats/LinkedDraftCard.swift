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

	@Environment(\.linkedItems) private var store
	@State private var expanded: Bool
	/// What the reader has typed over the draft; nil while the draft reads as the agent wrote it.
	@State private var edit: DraftEdit?

	init(
		object: WorkObject, preview: ObjectPreview, defaultExpanded: Bool = false, edited: DraftEdit? = nil,
		onApproved: @escaping (_ title: String?, _ body: String) -> Void = { _, _ in }
	) {
		self.object = object
		self.preview = preview
		self.onApproved = onApproved
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
				approveButton
				if let reason = blockedReason { reasonRow(reason) }
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

	private func receipt(_ text: String) -> some View {
		Label(text, systemImage: "checkmark")
			.maskinText(.caption).fontWeight(.semibold)
			.foregroundStyle(MaskinColor.ink4)
			.frame(minHeight: MaskinSpace.touchMin)
	}

	/// Why Approve is off, when the reader can fix it by typing.
	private var blockedReason: String? {
		guard canEdit, preview.canApprove, !isApproving else { return nil }
		return current.approveBlockedReason(isEmail: isEmail)
	}

	private func reasonRow(_ reason: String) -> some View {
		Text(reason)
			.maskinText(.caption)
			.foregroundStyle(MaskinColor.ink3)
			.frame(maxWidth: .infinity, alignment: .trailing)
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
