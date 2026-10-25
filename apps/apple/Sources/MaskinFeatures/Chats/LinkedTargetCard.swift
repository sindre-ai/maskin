import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The card for a linked target once it is known to deserve one; nothing while it is not.
struct LinkedTargetCard: View {
	let target: LinkedTarget
	var defaultExpanded = false
	var onApproved: (_ title: String?, _ body: String) -> Void = { _, _ in }
	@Environment(\.linkedItems) private var store

	var body: some View {
		switch store?.item(for: target) {
		case .draft(let object, let preview)?:
			LinkedDraftCard(object: object, preview: preview, defaultExpanded: defaultExpanded, onApproved: onApproved)
		case .file(let file)?:
			LinkedFileCard(file: file, defaultExpanded: defaultExpanded)
		default:
			EmptyView()
		}
	}
}
