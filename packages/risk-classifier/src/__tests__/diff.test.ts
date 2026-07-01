import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from '../lib/diff.js'

const SAMPLE = `diff --git a/apps/dev/src/foo.ts b/apps/dev/src/foo.ts
index abc..def 100644
--- a/apps/dev/src/foo.ts
+++ b/apps/dev/src/foo.ts
@@ -1,3 +1,4 @@
 unchanged
-removed
+added one
+added two
diff --git a/packages/auth/src/new.ts b/packages/auth/src/new.ts
new file mode 100644
index 000..123
--- /dev/null
+++ b/packages/auth/src/new.ts
@@ -0,0 +1,2 @@
+line a
+line b
`

describe('parseUnifiedDiff', () => {
	it('splits two file diffs and counts additions/deletions', () => {
		const files = parseUnifiedDiff(SAMPLE)
		expect(files).toHaveLength(2)
		expect(files[0]?.path).toBe('apps/dev/src/foo.ts')
		expect(files[0]?.additions).toBe(2)
		expect(files[0]?.deletions).toBe(1)
		expect(files[0]?.status).toBe('modified')
		expect(files[1]?.path).toBe('packages/auth/src/new.ts')
		expect(files[1]?.status).toBe('added')
		expect(files[1]?.additions).toBe(2)
	})

	it('handles an empty diff', () => {
		expect(parseUnifiedDiff('')).toEqual([])
	})
})
