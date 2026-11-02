import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Lays chips out left to right and wraps. Used for question options and composer chips.
struct ChipFlow: Layout {
	var spacing: CGFloat = MaskinSpace.s3

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
		arrange(width: proposal.width ?? .infinity, subviews: subviews).size
	}

	func placeSubviews(
		in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
	) {
		let result = arrange(width: bounds.width, subviews: subviews)
		for (index, origin) in result.origins.enumerated() {
			subviews[index].place(
				at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), proposal: .unspecified)
		}
	}

	private func arrange(width: CGFloat, subviews: Subviews) -> (origins: [CGPoint], size: CGSize) {
		var origins: [CGPoint] = []
		var x: CGFloat = 0
		var y: CGFloat = 0
		var rowHeight: CGFloat = 0
		var maxX: CGFloat = 0
		for subview in subviews {
			let size = subview.sizeThatFits(.init(width: width, height: nil))
			if x > 0, x + size.width > width {
				x = 0
				y += rowHeight + spacing
				rowHeight = 0
			}
			origins.append(CGPoint(x: x, y: y))
			x += size.width + spacing
			rowHeight = max(rowHeight, size.height)
			maxX = max(maxX, x - spacing)
		}
		return (origins, CGSize(width: maxX, height: y + rowHeight))
	}
}

enum ChatByteFormat {
	static func string(_ bytes: Int?) -> String? {
		guard let bytes else { return nil }
		return ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
	}
}

/// The chips' shared frame: 36pt tall, `fill`, radius 12, a 15pt glyph, a 14pt semibold label and
/// a ✕ on the right. Spec 7 §1 → "A picked attachment becomes a 36pt chip inside the bar".
private enum ComposerChipStyle {
	static let height: CGFloat = MaskinSpace.s14 + MaskinSpace.s2
	static let shape = RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
	static let label = MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline)
	static let detail = MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption)
}

/// The ✕ on a chip. The chip is 36pt, so the hit area is the chip's own height.
private struct ChipRemoveButton: View {
	let label: String
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			Image(systemName: "xmark")
				.maskinSymbol(MaskinFontSize.t11, weight: .heavy)
				.foregroundStyle(MaskinColor.ink4)
				.frame(width: ComposerChipStyle.height, height: ComposerChipStyle.height)
				.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel(label)
	}
}

/// One attachment in the composer: uploading, ready, or failed (retry / remove).
struct AttachmentChip: View {
	let draft: ChatAttachmentDraft
	var onRetry: () -> Void = {}
	var onRemove: () -> Void = {}

	var body: some View {
		HStack(spacing: MaskinSpace.s3) {
			leading.frame(width: MaskinSpace.s9)
			Text(draft.name).font(ComposerChipStyle.label).foregroundStyle(MaskinColor.ink2)
				.lineLimit(1).truncationMode(.middle)
			if let detail { Text(detail).font(ComposerChipStyle.detail).foregroundStyle(detailColor).lineLimit(1) }
			if case .failed = draft.state {
				Button("Retry", action: onRetry).font(ComposerChipStyle.label).buttonStyle(.maskinPressed)
					.foregroundStyle(MaskinColor.ink)
			}
			ChipRemoveButton(label: "Remove \(draft.name)", action: onRemove)
		}
		.padding(.leading, MaskinSpace.s6)
		.frame(height: ComposerChipStyle.height)
		.frame(maxWidth: 260, alignment: .leading)
		.background(MaskinSurface.fill, in: ComposerChipStyle.shape)
		.overlay {
			if case .failed = draft.state {
				ComposerChipStyle.shape.strokeBorder(MaskinColor.danger, lineWidth: 1)
			}
		}
		.accessibilityElement(children: .contain)
	}

	@ViewBuilder
	private var leading: some View {
		switch draft.state {
		case .uploading:
			ProgressView().controlSize(.small)
		case .failed:
			Image(systemName: "exclamationmark.triangle").maskinSymbol(MaskinFontSize.t15, weight: .semibold)
				.foregroundStyle(MaskinColor.danger).accessibilityHidden(true)
		case .uploaded:
			Image(systemName: draft.isImage ? "photo" : "doc").maskinSymbol(MaskinFontSize.t15, weight: .regular)
				.foregroundStyle(MaskinColor.ink3).accessibilityHidden(true)
		}
	}

	private var detail: String? {
		switch draft.state {
		case .uploading: "Uploading…"
		case .failed(let reason): reason
		case .uploaded: nil
		}
	}

	private var detailColor: Color {
		if case .failed = draft.state { return MaskinColor.danger }
		return MaskinColor.ink4
	}
}

/// An `@` mention picked in the composer.
struct MentionChip: View {
	let mention: ChatMention
	var onRemove: (() -> Void)?

	var body: some View {
		HStack(spacing: MaskinSpace.s2) {
			Image(systemName: "at").maskinSymbol(MaskinFontSize.t13, weight: .semibold)
				.foregroundStyle(MaskinColor.ink3).accessibilityHidden(true)
			Text(mention.name).font(ComposerChipStyle.label).foregroundStyle(MaskinColor.ink2).lineLimit(1)
			if let onRemove {
				ChipRemoveButton(label: "Remove mention of \(mention.name)", action: onRemove)
			}
		}
		.padding(.leading, MaskinSpace.s6)
		.padding(.trailing, onRemove == nil ? MaskinSpace.s6 : 0)
		.frame(height: ComposerChipStyle.height)
		.background(MaskinSurface.fill, in: ComposerChipStyle.shape)
		.accessibilityElement(children: .contain)
	}
}

/// The chip rows above the text field: attachments, then mentions.
struct ComposerChips: View {
	let model: ChatComposerModel

	var body: some View {
		if !model.attachments.isEmpty || !model.mentions.isEmpty {
			ChipFlow {
				ForEach(model.attachments) { draft in
					AttachmentChip(
						draft: draft, onRetry: { model.retryAttachment(draft.id) },
						onRemove: { model.removeAttachment(draft.id) })
				}
				ForEach(model.mentions) { mention in
					MentionChip(mention: mention, onRemove: { model.removeMention(mention.id) })
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, MaskinSpace.s2)
		}
	}
}
