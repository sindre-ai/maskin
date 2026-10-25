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

	init(
		object: WorkObject, preview: ObjectPreview, defaultExpanded: Bool = false,
		onApproved: @escaping (_ title: String?, _ body: String) -> Void = { _, _ in }
	) {
		self.object = object
		self.preview = preview
		self.onApproved = onApproved
		_expanded = State(initialValue: defaultExpanded)
	}

	private var title: String {
		let trimmed = object.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		return trimmed.isEmpty ? "Untitled" : trimmed
	}

	private var phase: DraftApprovalPhase? { store?.phase(of: object.id) }
	private var isApproving: Bool { phase == .approving }

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
			ObjectPreviewMetaView(preview: preview)
			Text(preview.body)
				.font(MaskinTypeface.sans(MaskinFontSize.t15))
				.lineSpacing(MaskinSpace.s2)
				.foregroundStyle(MaskinColor.ink)
				.frame(maxWidth: .infinity, alignment: .leading)
				.fixedSize(horizontal: false, vertical: true)
			footer
		}
		.padding(.horizontal, MaskinSpace.s6)
		.padding(.vertical, MaskinSpace.s5)
	}

	@ViewBuilder
	private var footer: some View {
		VStack(alignment: .trailing, spacing: MaskinSpace.s3) {
			switch preview.delivery {
			case .sent: receipt("Sent")
			case .approved: receipt("Approved")
			case .draft, nil: approveButton
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

	private var approveButton: some View {
		let enabled = preview.canApprove && !isApproving && store != nil
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
		Task {
			let result = await store.approve(objectID: object.id, preview: shown)
			if case .approved(let approved) = result {
				MaskinHaptics.play(.success)
				onApproved(object.title, approved.body)
			} else {
				MaskinHaptics.play(.warning)
			}
		}
	}
}
