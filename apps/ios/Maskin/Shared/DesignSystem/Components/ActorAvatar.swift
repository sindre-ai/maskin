import SwiftUI
import UIKit

/// Port of `apps/web/src/components/shared/actor-avatar.tsx`. Nothing about an actor's
/// avatar color is persisted server-side — it's a pure function of the actor id, so this
/// must reproduce the web client's djb2-xor hash and 10-color palette exactly or the same
/// actor will show a different color on iOS than on web.
enum ActorAvatarPalette {
	/// Same 10 status-color pairs `actor-avatar.tsx` cycles through, in the same order —
	/// values copied verbatim from `apps/web/src/app.css`'s `--st-<status>-bg`/`-text`
	/// light and dark custom properties (Tailwind's `.dark` class swaps these at runtime
	/// on web; here each pair is a light/dark tuple resolved via `MaskinColor`-style
	/// dynamic lookup).
	private static let palette: [(lightBg: UInt32, lightFg: UInt32, darkBg: UInt32, darkFg: UInt32)] = [
		(0xDBEAFE, 0x1E40AF, 0x172554, 0x93C5FD), // in_progress
		(0xDCFCE7, 0x166534, 0x052E16, 0x86EFAC), // active
		(0xF3E8FF, 0x6B21A8, 0x3B0764, 0xC084FC), // signal
		(0xCCFBF1, 0x115E59, 0x042F2E, 0x5EEAD4), // clustered
		(0xFFF7ED, 0xC2410C, 0x431407, 0xFDBA74), // in_review
		(0xEDE9FE, 0x5B21B6, 0x2E1065, 0xC4B5FD), // validated
		(0xE0F2FE, 0x075985, 0x0C4A6E, 0x7DD3FC), // qualified
		(0xFAE8FF, 0x86198F, 0x4A044E, 0xE879F9), // scored
		(0xFEF3C7, 0x92400E, 0x422006, 0xFBBF24), // processing
		(0xE0E7FF, 0x3730A3, 0x1E1B4B, 0xA5B4FC), // proposed
	]

	/// djb2 xor variant — must match `hashString()` in actor-avatar.tsx bit-for-bit,
	/// including the unsigned 32-bit wraparound.
	private static func hash(_ input: String) -> UInt32 {
		var hash: UInt32 = 5381
		for byte in input.utf8 {
			// (hash << 5) + hash == hash * 33, matching the JS `(hash << 5) + hash`.
			hash = (hash &<< 5) &+ hash
			hash ^= UInt32(byte)
		}
		return hash
	}

	/// Exposed (not `private`) so `ActorAvatarParityTests` can assert this matches the
	/// Node-computed reference index without depending on `Color` internals.
	static func paletteIndex(seed: String?) -> Int {
		let key = (seed?.isEmpty == false) ? seed! : "?"
		return Int(hash(key) % UInt32(palette.count))
	}

	static func colors(seed: String?) -> (bg: Color, fg: Color) {
		let idx = paletteIndex(seed: seed)
		let pair = palette[idx]
		let bg = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: pair.darkBg) : UIColor(hex: pair.lightBg) })
		let fg = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: pair.darkFg) : UIColor(hex: pair.lightFg) })
		return (bg, fg)
	}

	static func initials(name: String) -> String {
		let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return "?" }
		let words = trimmed.split(separator: " ").filter { !$0.isEmpty }
		if words.count >= 2 {
			let first = words[0].first.map(String.init) ?? ""
			let second = words[1].first.map(String.init) ?? ""
			let combined = (first + second).uppercased()
			return combined.isEmpty ? "?" : combined
		}
		let word = words.first.map(String.init) ?? ""
		if word.count >= 2 { return String(word.prefix(2)).uppercased() }
		return word.isEmpty ? "?" : word.uppercased()
	}
}

private extension UIColor {
	convenience init(hex: UInt32) {
		self.init(
			red: CGFloat((hex >> 16) & 0xFF) / 255,
			green: CGFloat((hex >> 8) & 0xFF) / 255,
			blue: CGFloat(hex & 0xFF) / 255,
			alpha: 1
		)
	}
}

struct ActorAvatar: View {
	let name: String
	var id: String?
	var size: CGFloat = 20

	var body: some View {
		let colors = ActorAvatarPalette.colors(seed: id ?? name)
		Circle()
			.fill(colors.bg)
			.frame(width: size, height: size)
			.overlay(
				Text(ActorAvatarPalette.initials(name: name))
					.font(MaskinFont.display(size * 0.42, weight: .semibold))
					.foregroundStyle(colors.fg)
			)
			.accessibilityLabel(name)
	}
}
