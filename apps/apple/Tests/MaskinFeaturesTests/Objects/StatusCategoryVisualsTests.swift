import MaskinCore
import MaskinDesign
import MaskinUI
import Testing

/// MaskinUI cannot import MaskinCore, so its status tones mirror `StatusCategory`'s table. This
/// keeps the two from drifting.
@Suite("Status category visuals")
struct StatusCategoryVisualsTests {
	static let keys = [
		"backlog", "todo", "new", "signal", "define", "proposed", "paused", "parked", "holding",
		"in_review", "waiting_for_input", "in_progress", "active", "live", "processing", "clustered",
		"done", "completed", "validated", "succeeded", "scored", "discarded", "archived", "failed",
		"my_custom_status",
	]

	@Test(arguments: keys)
	func toneMatchesCategory(status: String) {
		let expected: MaskinStatus.Tone =
			switch StatusCategory.of(status) {
			case .needsYou, .active: .patina
			case .done: .ink
			case .backlog, .cancelled: .grey
			}
		#expect(MaskinStatus.tone(for: status) == expected, "\(status)")
	}

	@Test func nothingObjectLikeIsGreenAmberOrBlue() {
		for status in Self.keys where status != "failed" {
			let colors = MaskinStatus.colors(for: status)
			let allowed = [MaskinStatus.patina, MaskinStatus.done, MaskinStatus.fallback]
			#expect(allowed.contains { $0.fg == colors.fg && $0.bg == colors.bg }, "\(status)")
		}
	}
}
