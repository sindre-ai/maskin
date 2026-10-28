import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The card for a linked target once it is known to deserve one; nothing while it is not. An object
/// link shows a placeholder while its lookup is out.
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
		case .object(let object)?:
			LinkedObjectCard(object: object)
		case .loop(let loop)?:
			LinkedLoopCard(loop: loop)
		case .trigger(let trigger)?:
			LinkedTriggerCard(trigger: trigger)
		case .deleted?:
			LinkedDeletedCard(kind: Self.deletedKind(of: target))
		default:
			if target.kind == .object, store?.showsCard(target) == true { LinkedCardSkeleton() }
		}
	}

	/// "loop", "trigger" or "object": what the deleted card says was deleted.
	private static func deletedKind(of target: LinkedTarget) -> String {
		switch target.kind {
		case .loop: "loop"
		case .trigger: "trigger"
		case .object, .file: "object"
		}
	}
}
