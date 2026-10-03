import MaskinDesign
import SwiftUI

/// An object type as a tinted badge, mono chip, tile with glyph, or a bare dot.
public struct TypeBadge: View {
	public enum Style: Sendable { case badge, mono, tile, dot }

	private let type: String
	private let label: String?
	private let style: Style

	/// - Parameter label: the workspace's display name for the type; falls back to the raw key.
	public init(_ type: String, label: String? = nil, style: Style = .badge) {
		self.type = type
		self.label = label
		self.style = style
	}

	private var title: String { label ?? type }

	public var body: some View {
		let colors = MaskinObjectType.colors(for: type)
		Group {
			switch style {
			case .badge:
				Text(title)
					.maskinText(.caption)
					.foregroundStyle(colors.fg)
					.padding(.horizontal, MaskinSpace.s4)
					.padding(.vertical, MaskinSpace.s1)
					.background(colors.bg, in: Capsule())
			case .mono:
				MonoLabel(title, color: MaskinColor.ink4)
			case .tile:
				tile(colors)
			case .dot:
				Circle().fill(colors.fg).frame(width: MaskinSpace.s3, height: MaskinSpace.s3)
			}
		}
		.lineLimit(1)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("Type \(title)")
	}

	private func tile(_ colors: MaskinColorPair) -> some View {
		let side = MaskinSpace.s14 - MaskinSpace.s1
		return ZStack {
			RoundedRectangle(cornerRadius: MaskinRadius.panel, style: .continuous).fill(colors.bg)
			if let symbol = MaskinObjectType.symbol(for: type) {
				Image(systemName: symbol).font(.system(size: MaskinFontSize.t15, weight: .semibold))
			} else {
				Text(type.prefix(1).uppercased()).font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold))
			}
		}
		.foregroundStyle(colors.fg)
		.frame(width: side, height: side)
	}
}

#Preview("Type — light") { TypeBadgeGallery().preferredColorScheme(.light) }
#Preview("Type — dark") { TypeBadgeGallery().preferredColorScheme(.dark) }

private struct TypeBadgeGallery: View {
	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			ForEach(["insight", "bet", "task", "file", "conversation", "session", "custom"], id: \.self) { t in
				HStack(spacing: MaskinSpace.s7) {
					TypeBadge(t, style: .tile)
					TypeBadge(t)
					TypeBadge(t, style: .mono)
					TypeBadge(t, style: .dot)
				}
			}
		}
		.padding(MaskinSpace.s9)
		.background(MaskinSurface.grouped)
	}
}
