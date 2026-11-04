import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Spec 7 §5b: one-tap answers in the composer stack, right-aligned. 40pt pills, `card` fill, 1pt
/// `line` border, 14pt semibold. The rules that pick them are `QuickReplyRules` in Core; this only
/// draws what it is given and sends on tap.
struct QuickReplyChips: View {
	let replies: [String]
	let onPick: (String) -> Void

	static let height: CGFloat = MaskinSpace.s14 + MaskinSpace.s4

	var body: some View {
		if !replies.isEmpty {
			QuickReplyWrap(spacing: MaskinSpace.s4) {
				ForEach(replies, id: \.self) { reply in
					Button {
						MaskinHaptics.play(.light)
						onPick(reply)
					} label: {
						Text(reply)
							.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
							.foregroundStyle(MaskinColor.ink)
							.lineLimit(1)
							.padding(.horizontal, MaskinSpace.s8)
							.frame(height: Self.height)
							.background(MaskinSurface.card, in: Capsule())
							.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
							.contentShape(Capsule())
					}
					.buttonStyle(.maskinPressed)
				}
			}
			.frame(maxWidth: .infinity, alignment: .trailing)
			.accessibilityElement(children: .contain)
			.accessibilityLabel("Quick replies")
		}
	}
}

/// Pills that wrap onto further rows, each row right-aligned (the mockup wraps them; it never scrolls).
private struct QuickReplyWrap: Layout {
	var spacing: CGFloat

	private func rows(_ subviews: Subviews, width: CGFloat) -> [[Int]] {
		var rows: [[Int]] = [[]]
		var used: CGFloat = 0
		for (index, view) in subviews.enumerated() {
			let size = view.sizeThatFits(.unspecified)
			let needed = (rows[rows.count - 1].isEmpty ? 0 : spacing) + size.width
			if used + needed > width, !rows[rows.count - 1].isEmpty {
				rows.append([index])
				used = size.width
			} else {
				rows[rows.count - 1].append(index)
				used += needed
			}
		}
		return rows
	}

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
		let width = proposal.width ?? .infinity
		let rows = rows(subviews, width: width)
		let heights = rows.map { $0.map { subviews[$0].sizeThatFits(.unspecified).height }.max() ?? 0 }
		return CGSize(
			width: proposal.width ?? 0,
			height: heights.reduce(0, +) + CGFloat(max(0, rows.count - 1)) * spacing)
	}

	func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
		var y = bounds.minY
		for row in rows(subviews, width: bounds.width) {
			let sizes = row.map { subviews[$0].sizeThatFits(.unspecified) }
			let total = sizes.reduce(0) { $0 + $1.width } + CGFloat(max(0, row.count - 1)) * spacing
			var x = bounds.maxX - total
			for (offset, index) in row.enumerated() {
				subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(sizes[offset]))
				x += sizes[offset].width + spacing
			}
			y += (sizes.map(\.height).max() ?? 0) + spacing
		}
	}
}
