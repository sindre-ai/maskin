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

/// One attachment in the composer: uploading, ready, or failed (retry / remove).
struct AttachmentChip: View {
	let draft: ChatAttachmentDraft
	var onRetry: () -> Void = {}
	var onRemove: () -> Void = {}

	var body: some View {
		HStack(spacing: MaskinSpace.s3) {
			leading
			VStack(alignment: .leading, spacing: 0) {
				Text(draft.name).maskinText(.caption).foregroundStyle(MaskinColor.ink)
					.lineLimit(1).truncationMode(.middle)
				if let detail { Text(detail).maskinText(.microLabel).foregroundStyle(detailColor) }
			}
			if case .failed = draft.state {
				Button("Retry", action: onRetry).maskinText(.caption).buttonStyle(.plain)
					.foregroundStyle(MaskinColor.accentFgStrong)
			}
			Button(action: onRemove) {
				Image(systemName: "xmark.circle.fill").foregroundStyle(MaskinColor.ink5)
					.frame(width: MaskinSpace.touchMin - MaskinSpace.s4, height: MaskinSpace.touchMin - MaskinSpace.s4)
					.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel("Remove \(draft.name)")
		}
		.padding(.leading, MaskinSpace.s5)
		.padding(.vertical, MaskinSpace.s1)
		.frame(maxWidth: 260, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous)
				.strokeBorder(borderColor, lineWidth: 1))
		.accessibilityElement(children: .contain)
	}

	@ViewBuilder
	private var leading: some View {
		switch draft.state {
		case .uploading:
			ProgressView().controlSize(.small)
		case .failed:
			Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(MaskinColor.danger)
				.accessibilityHidden(true)
		case .uploaded:
			Image(systemName: draft.isImage ? "photo" : "doc").foregroundStyle(MaskinColor.ink3)
				.accessibilityHidden(true)
		}
	}

	private var detail: String? {
		switch draft.state {
		case .uploading: "Uploading…"
		case .failed(let reason): reason
		case .uploaded(let ref): ChatByteFormat.string(ref.sizeBytes)
		}
	}

	private var detailColor: Color {
		if case .failed = draft.state { return MaskinColor.danger }
		return MaskinColor.ink4
	}

	private var borderColor: Color {
		if case .failed = draft.state { return MaskinColor.danger }
		return MaskinSurface.line
	}
}

/// An `@` mention picked in the composer.
struct MentionChip: View {
	let mention: ChatMention
	var onRemove: (() -> Void)?

	var body: some View {
		HStack(spacing: MaskinSpace.s2) {
			Image(systemName: "at").font(.system(size: MaskinFontSize.t11, weight: .semibold))
				.accessibilityHidden(true)
			Text(mention.name).maskinText(.caption).lineLimit(1)
			if let onRemove {
				Button(action: onRemove) {
					Image(systemName: "xmark").font(.system(size: MaskinFontSize.t10, weight: .bold))
						.frame(width: MaskinSpace.touchMin - MaskinSpace.s5, height: MaskinSpace.touchMin - MaskinSpace.s5)
						.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Remove mention of \(mention.name)")
			}
		}
		.foregroundStyle(MaskinColor.accentFgStrong)
		.padding(.leading, MaskinSpace.s4)
		.padding(.trailing, onRemove == nil ? MaskinSpace.s4 : 0)
		.frame(minHeight: MaskinSpace.s12 + MaskinSpace.s2)
		.background(MaskinColor.accentTint2, in: Capsule())
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
			.padding(.horizontal, MaskinSpace.s4)
		}
	}
}
