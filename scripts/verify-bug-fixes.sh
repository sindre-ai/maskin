#!/usr/bin/env bash
# verify-bug-fixes.sh — Pre-launch verification of all 13 bug fixes
# Run from the repo root: ./scripts/verify-bug-fixes.sh
#
# This script checks the codebase for evidence that each fix is present.
# It does NOT replace manual QA in staging, but confirms the code changes
# have landed on the current branch.

set -euo pipefail

PASS=0
FAIL=0
WARN=0

pass() { echo "  ✅ PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ FAIL: $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  ⚠️  WARN: $1"; WARN=$((WARN + 1)); }

echo "============================================"
echo " Bug Fix Verification — Pre-Launch Checklist"
echo " Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo " Branch: $(git rev-parse --abbrev-ref HEAD)"
echo " Commit: $(git rev-parse --short HEAD)"
echo "============================================"
echo ""

# --- Task 1: Fix scrolling on objects page ---
echo "Task 1: Fix scrolling on objects page"
if grep -rq "flex-1 min-h-0" apps/web/src/components/objects/ apps/web/src/routes/ 2>/dev/null; then
  pass "Flex layout (flex-1 min-h-0) found in objects page / data-table"
else
  fail "Expected flex-1 min-h-0 in objects/data-table — magic height calc may still be present"
fi
if grep -rq 'calc(100vh' apps/web/src/routes/ 2>/dev/null; then
  fail "Legacy calc(100vh-...) still present in routes"
else
  pass "No legacy calc(100vh) in routes"
fi
echo ""

# --- Task 2: Fix toast notification z-index ---
echo "Task 2: Fix toast notification z-index"
if grep -rq 'z-\[9999\]\|z-50\|style.*zIndex' apps/web/src/components/ui/sonner.tsx 2>/dev/null || \
   grep -rq 'toastOptions.*zIndex\|className.*z-' apps/web/src/components/ui/sonner.tsx 2>/dev/null; then
  pass "Toast z-index override found in sonner component"
else
  warn "Toast z-index fix not found on this branch — check if PR is merged"
fi
echo ""

# --- Task 3: Fix agent card text unreadable when status is 'working' ---
echo "Task 3: Fix agent card text readability for 'working' status"
CARD_FILES=$(find apps/web/src/components -name "*card*" -o -name "*session*" -o -name "*agent*" 2>/dev/null | grep -E '\.(tsx|ts)$' | head -10)
if [ -n "$CARD_FILES" ]; then
  if grep -lq "working" $CARD_FILES 2>/dev/null; then
    if grep -q "working.*text-\|working.*contrast\|working.*white\|working.*foreground" $CARD_FILES 2>/dev/null; then
      pass "Text contrast handling found for 'working' status in card components"
    else
      warn "Working status referenced but no explicit text contrast fix detected — needs manual QA"
    fi
  else
    warn "No 'working' status handling in card components — needs manual QA"
  fi
else
  warn "Card components not found — needs manual QA"
fi
echo ""

# --- Task 4: Fix bet detail page not showing linked tasks ---
echo "Task 4: Fix bet detail page showing linked tasks (sourceType filtering)"
BET_ROUTES=$(find apps/web/src -path "*bet*" -o -path "*object*detail*" 2>/dev/null | grep -E '\.(tsx|ts)$' | head -10)
if [ -n "$BET_ROUTES" ]; then
  if grep -rq "breaks_into\|sourceType\|source_type\|targetType\|target_type" $BET_ROUTES 2>/dev/null; then
    pass "Bet/object detail queries relationships with type filtering"
  else
    warn "Bet detail routes exist but relationship type filtering not confirmed — needs manual QA"
  fi
else
  warn "Bet detail routes not found — needs manual QA"
fi
echo ""

# --- Task 5: Show owner for objects in detail view ---
echo "Task 5: Show owner for objects in detail view"
DETAIL_FILES=$(find apps/web/src -name "*detail*" -o -name "*object*" 2>/dev/null | grep -E '\.(tsx|ts)$' | head -10)
if [ -n "$DETAIL_FILES" ]; then
  if grep -rq "owner" $DETAIL_FILES 2>/dev/null; then
    pass "Owner field referenced in object detail views"
  else
    warn "Object detail files exist but owner display not confirmed — needs manual QA"
  fi
else
  warn "Object detail files not found — needs manual QA"
fi
echo ""

# --- Task 6: Show current active workspace in selector ---
echo "Task 6: Show current active workspace in workspace selector"
if grep -rq "currentWorkspace\|Check.*className" apps/web/src/components/ 2>/dev/null; then
  pass "Active workspace indicator found in components"
else
  fail "Active workspace indicator not found"
fi
echo ""

# --- Task 7: Fix CSV import with header notes ---
echo "Task 7: Fix CSV import failing on files with header notes"
IMPORT_FILES=$(find apps -name "*import*" -name "*.ts" -o -name "*import*" -name "*.tsx" -o -name "*csv*" -name "*.ts" 2>/dev/null | grep -v node_modules | head -10)
if [ -n "$IMPORT_FILES" ]; then
  if grep -rq "header\|preamble\|skip.*row\|headerRow\|findHeader\|detectHeader" $IMPORT_FILES 2>/dev/null; then
    pass "Header detection/skip logic found in import code"
  else
    warn "Import files exist but no header-skip logic detected — needs manual QA"
  fi
else
  warn "CSV import files not found — needs manual QA"
fi
echo ""

# --- Task 8: Fix CSV import merging fields instead of appending ---
echo "Task 8: Fix CSV import field concatenation"
if grep -rq "titleParts\|contentParts" apps/ 2>/dev/null; then
  pass "titleParts/contentParts array-based concatenation found in import code"
else
  if grep -rq "\.join\b.*import\|concat.*title\|push.*title" apps/dev/src/ 2>/dev/null; then
    pass "Field concatenation logic found in import code"
  else
    warn "Field concatenation fix not detected — needs manual QA"
  fi
fi
echo ""

# --- Task 9: Fix session scheduler pending queue not draining ---
echo "Task 9: Fix session scheduler pending queue draining"
if grep -rq "drainQueue\|drain.*[Qq]ueue" apps/dev/src/services/session*.ts 2>/dev/null; then
  pass "drainQueue function found in session manager"
else
  fail "drainQueue not found in session manager"
fi
echo ""

# --- Task 10: Fix GitHub MCP server env var mismatch ---
echo "Task 10: Fix GitHub MCP server env var name (envKey)"
if grep -rq "envKey" apps/dev/src/services/session*.ts 2>/dev/null; then
  pass "envKey lookup found in session manager for MCP env vars"
else
  warn "envKey usage not found in session manager — check if PR is merged"
fi
echo ""

# --- Task 11: Validate notification metadata.actions ---
echo "Task 11: Validate and auto-parse notification metadata.actions"
MCP_FILES=$(find packages apps -path "*/mcp*" -name "*.ts" 2>/dev/null | head -20)
if [ -n "$MCP_FILES" ]; then
  if grep -rq "JSON.parse" $MCP_FILES 2>/dev/null && grep -rq "actions" $MCP_FILES 2>/dev/null; then
    pass "metadata.actions auto-parse (JSON.parse + actions) found in MCP code"
  else
    warn "MCP files exist but auto-parse not confirmed — needs manual QA"
  fi
else
  warn "MCP files not found — needs manual QA"
fi
echo ""

# --- Task 12: Fix agents not responding to comments ---
echo "Task 12: Fix agents responding to comments on object pages"
COMMENT_FILES=$(find apps/dev/src -name "*comment*" -name "*.ts" 2>/dev/null | head -5)
if [ -n "$COMMENT_FILES" ]; then
  if grep -rq "mention\|agent\|session\|trigger" $COMMENT_FILES 2>/dev/null; then
    warn "Comment + agent/trigger integration exists — needs manual verification in staging"
  else
    warn "Comment handling exists but agent trigger not confirmed — needs manual QA"
  fi
else
  warn "Comment handling not found — needs manual QA"
fi
echo ""

# --- Summary ---
echo "============================================"
echo " SUMMARY"
echo "============================================"
echo "  ✅ Passed:  $PASS"
echo "  ❌ Failed:  $FAIL"
echo "  ⚠️  Warnings: $WARN"
echo ""

TOTAL=$((PASS + FAIL + WARN))
echo "  Checks run: $TOTAL"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "❌ BLOCKING: $FAIL check(s) failed — these fixes are missing from the current branch."
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo "⚠️  $WARN item(s) need manual verification in staging."
  echo ""
  echo "  Manual staging QA checklist:"
  echo "  1. Open the objects page and verify scrolling works"
  echo "  2. Trigger a toast and verify it appears above all content"
  echo "  3. Start an agent and verify the 'working' card text is readable"
  echo "  4. Open a bet detail page and confirm all linked tasks appear"
  echo "  5. Open an object detail view and confirm the owner is displayed"
  echo "  6. Open the workspace selector and confirm the active workspace is marked"
  echo "  7. Import a CSV with header notes/preamble and verify it succeeds"
  echo "  8. Import a CSV with multiple columns mapped to same field — verify concatenation"
  echo "  9. Queue several sessions and verify the pending queue drains correctly"
  echo "  10. Connect GitHub integration and verify private repo access"
  echo "  11. Create a notification with metadata.actions as a JSON string — verify auto-parse"
  echo "  12. @mention an agent in a comment on an object page — verify it responds"
  exit 0
else
  echo "✅ All code-level checks passed!"
  exit 0
fi
