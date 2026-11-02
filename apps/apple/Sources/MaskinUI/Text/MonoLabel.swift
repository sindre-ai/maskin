import MaskinDesign
import SwiftUI

/// The uppercase mono micro-label ("DECISION", "3 OPEN").
public struct MonoLabel: View {
	/// `.chip` 10pt (chips, row type labels), `.section` 12pt (group headers), `.micro` 9pt (inside briefing cards).
	public enum Size: Sendable {
		case chip, section, micro

		var role: MaskinTextRole {
			switch self {
			case .chip: .microLabel
			case .section: .microLabelLarge
			case .micro: .microLabelMicro
			}
		}
	}

	private let text: String
	private let color: Color
	private let size: Size

	public init(_ text: String, color: Color = MaskinColor.ink4, size: Size = .chip) {
		self.text = text
		self.color = color
		self.size = size
	}

	public var body: some View {
		Text(text.uppercased())
			.maskinText(size.role)
			.foregroundStyle(color)
			.lineLimit(1)
			.accessibilityLabel(text)
	}
}

/// A group header: mono label on the left, optional trailing detail (count, action).
public struct SectionHeader<Trailing: View>: View {
	private let title: String
	private let trailing: Trailing

	public init(_ title: String, @ViewBuilder trailing: () -> Trailing) {
		self.title = title
		self.trailing = trailing()
	}

	public var body: some View {
		HStack(alignment: .firstTextBaseline) {
			MonoLabel(title)
			Spacer(minLength: MaskinSpace.s4)
			trailing
		}
		.accessibilityAddTraits(.isHeader)
	}
}

extension SectionHeader where Trailing == EmptyView {
	public init(_ title: String) {
		self.init(title) { EmptyView() }
	}
}

#Preview("Labels — light") { LabelGallery().preferredColorScheme(.light) }
#Preview("Labels — dark") { LabelGallery().preferredColorScheme(.dark) }

private struct LabelGallery: View {
	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			MonoLabel("Decision")
			SectionHeader("Needs you") { Text("3").maskinText(.mono).foregroundStyle(MaskinColor.ink4) }
			SectionHeader("Recent")
		}
		.padding(MaskinSpace.s9)
		.background(MaskinSurface.grouped)
	}
}
