import MaskinDesign
import SwiftUI

/// One pill per tag in use, plus "All". The chosen pill sits on a fill, like the For you filters.
struct TagPills: View {
	let tags: [String]
	@Binding var selection: String?

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s2) {
				pill("All", tag: nil)
				ForEach(tags, id: \.self) { pill($0, tag: $0) }
			}
		}
	}

	private func pill(_ title: String, tag: String?) -> some View {
		let isSelected = selection == tag
		return Button { selection = tag } label: {
			Text(title)
				.maskinText(.subhead)
				.fontWeight(isSelected ? .semibold : .regular)
				.foregroundStyle(isSelected ? MaskinColor.ink : MaskinColor.ink4)
				.padding(.horizontal, MaskinSpace.s6)
				.frame(minHeight: MaskinSpace.s14)
				.background(isSelected ? MaskinSurface.fill : Color.clear, in: Capsule())
				.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: isSelected ? 0 : 1))
				.contentShape(Capsule())
		}
		.buttonStyle(.plain)
		.accessibilityAddTraits(isSelected ? .isSelected : [])
	}
}
