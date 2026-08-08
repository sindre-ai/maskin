import SwiftUI

/// Port of the mono object-type tag pattern from the design guidelines: a 10%-tint of
/// the type's own hue at `--r-tag` radius, no border, mono type.
struct ObjectTypeTag: View {
	let type: String

	var body: some View {
		Text(type.uppercased())
			.font(MaskinFont.mono(9, weight: .medium))
			.tracking(0.4)
			.padding(.horizontal, 6)
			.padding(.vertical, 3)
			.background(backgroundColor)
			.foregroundStyle(MaskinColor.objectColor(for: type))
			.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.tag))
	}

	private var backgroundColor: Color {
		switch type {
		case "insight": return MaskinColor.objInsightBg
		case "bet": return MaskinColor.objBetBg
		case "task": return MaskinColor.objTaskBg
		case "loop": return MaskinColor.objKnowledgeBg
		default: return MaskinColor.linen
		}
	}
}

/// A quiet status pill — matches the design's "quiet" chip flavour (`--linen` fill,
/// `1px --rule` border, `--ink-2` text).
struct StatusPill: View {
	let text: String
	var accent = false

	var body: some View {
		Text(text)
			.font(MaskinFont.xs.weight(.medium))
			.padding(.horizontal, MaskinSpacing.s2)
			.padding(.vertical, 3)
			.background(accent ? MaskinColor.accentDim : MaskinColor.linen)
			.foregroundStyle(accent ? MaskinColor.accent : MaskinColor.ink2)
			.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.chip))
	}
}

struct MaskinCard<Content: View>: View {
	@ViewBuilder let content: Content

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpacing.s2) {
			content
		}
		.padding(MaskinSpacing.cardPadding)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinColor.surface)
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.lg)
				.stroke(MaskinColor.rule, lineWidth: MaskinBorder.width)
		)
		.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.lg))
	}
}
