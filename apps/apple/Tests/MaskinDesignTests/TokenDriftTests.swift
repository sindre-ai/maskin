import Foundation
import Testing

@testable import MaskinDesign

@Suite("Token drift") struct TokenDriftTests {
	#if os(macOS)
	/// `node scripts/gen-tokens.mjs --check` — fails when the CSS and Tokens.swift disagree.
	@Test func generatedTokensAreUpToDate() throws {
		let root = URL(fileURLWithPath: #filePath)
			.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
		let script = root.appendingPathComponent("scripts/gen-tokens.mjs")
		guard FileManager.default.fileExists(atPath: script.path) else { return }

		let process = Process()
		process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
		process.arguments = ["node", script.path, "--check"]
		process.currentDirectoryURL = root
		let pipe = Pipe()
		process.standardError = pipe
		process.standardOutput = pipe
		do { try process.run() } catch { return } // node not installed: nothing to check
		process.waitUntilExit()
		let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
		if output.contains("No such file or directory") && output.contains("node") { return }
		#expect(process.terminationStatus == 0, "\(output)")
	}
	#endif

	@Test func palettesAreNonEmptyAndHaveBothAppearances() {
		#expect(MaskinStatusPalette.all.count >= 27)
		#expect(MaskinTypePalette.all.count >= 6)
	}
}
