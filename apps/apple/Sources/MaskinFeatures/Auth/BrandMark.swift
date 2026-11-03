import MaskinUI
import SwiftUI

/// The Maskin logo tile for the sign-in screens: a thin wrapper over the shared `MaskinLogoTile`.
struct BrandMark: View {
	var size: CGFloat = 56

	var body: some View { MaskinLogoTile(size: size) }
}
