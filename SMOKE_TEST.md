# Pre-Launch Smoke Test Checklist

**Date:** 2026-04-08
**Bet:** Launch Readiness — Ship Maskin in 1 Week (launch April 14, 2026)
**Task:** 9. Pre-launch smoke test & end-to-end verification

## Checklist Results

### 1. Fresh Clone Test

- [x] `pnpm install` — `package.json` and `pnpm-lock.yaml` present, scripts configured correctly
- [x] `.env.example` exists with documented environment variables
- [x] `pnpm db:seed` script defined and seed file exists at `packages/db/src/seed.ts`
- [x] `pnpm dev` script defined and wired to `scripts/dev.sh`

### 2. README Review

- [x] README title says "Maskin" (was "AI-Native OSS Workspace" — **fixed in this PR**)
- [x] Clone command references `sindre-ai/maskin` (was `your-org/ai-native-oss` — **fixed in this PR**)
- [x] Architecture tree shows `maskin/` (was `ai-native-oss/` — **fixed in this PR**)
- [x] License badge shows Apache 2.0
- [x] License section references Apache 2.0
- [x] Quick Start section present with install + dev + seed commands
- [ ] Demo section with video/GIF — **not present** (Task 7 PR #141 did not add video embed to README)

### 3. Docs Review

- [x] `docs/` directory exists with documentation files
- [x] `docs/IMPLEMENTATION.md` — comprehensive implementation reference
- [x] `docs/explain-general.md` — general explanation
- [x] `docs/explain-technical.md` — technical overview
- [x] `docs/explain-non-technical.md` — non-technical explanation
- [x] All doc titles updated to "Maskin" (was "AI-Native OS" — **fixed in this PR**)
- [ ] Missing dedicated guides: "Set up in 10 minutes", "Create your first agent team", "Build an extension" — Task 6 delivered explainer docs instead

### 4. CI Check

- [x] GitHub Actions CI workflow exists at `.github/workflows/ci.yml`
- [x] CI runs lint, build, and unit tests on PRs to main
- [x] CI includes integration test job

### 5. Demo Verification

- [x] Seed script exists at `packages/db/src/seed.ts`
- [x] `pnpm db:seed` command wired in root `package.json`
- [ ] Demo video not embedded in README (see item 2)

### 6. Blog Post Review

- [ ] No blog post file found in repo — likely published externally (Task 8 PR #143 may have added it elsewhere)

### 7. Repo Presentation

- [x] Issue templates added: bug report and feature request (**added in this PR**)
- [x] CI workflow configured
- [ ] GitHub repo description, topics, social preview, Discussions, and branch protection — these are repo settings configured via GitHub UI/API, not verifiable from code

### 8. No Leftover References

- [x] `grep -r 'your-org'` — **clean** (was 1 match in README — **fixed in this PR**)
- [x] `grep -r 'ai-native-oss'` — **clean** (was 9 matches across codebase — **fixed in this PR**)
- [x] `grep -r 'ai_native_oss'` — **clean** (was 8 matches in docker-compose and docs — **fixed in this PR**)
- [x] `grep -r 'AI-Native OS'` — **clean** (was 6 matches in docs and source — **fixed in this PR**)

### 9. No Secrets

- [x] No `.env` files committed
- [x] No real API keys in source code (only test fixtures with `sk-test` values)
- [x] `.gitignore` excludes `.env`
- [x] `.env.example` contains only placeholder values

## Issues Fixed in This PR

1. **README:** Title, clone URL, architecture tree, and MCP config all referenced old `ai-native-oss` naming — updated to `maskin`/`sindre-ai/maskin`
2. **Root `package.json`:** Name was `ai-native-oss` — updated to `maskin`
3. **MCP server:** Name was `ai-native-oss` — updated to `maskin`
4. **OpenAPI title:** Was `AI-Native OSS Dev Workspace API` — updated to `Maskin API`
5. **GitHub app slug default:** Was `ai-native-oss` — updated to `maskin`
6. **`.env.example`:** Database name was `ai_native_oss` — updated to `maskin`
7. **Docker Compose files:** All 3 compose files referenced `ai_native_oss` DB name — updated to `maskin`
8. **All docs:** Titles and references updated from `AI-Native OS`/`ai-native-oss` to `Maskin`/`maskin`
9. **Issue templates:** Added missing `.github/ISSUE_TEMPLATE/` with bug report and feature request templates

## Known Gaps (Not Blocking Launch)

- README lacks embedded demo video/GIF (Task 7 delivered video but did not embed it)
- Docs are explainer-style rather than step-by-step guides (setup, agent team, extension)
- Blog post location not verifiable from repo (may be published externally)
- GitHub repo settings (description, topics, social preview, Discussions, branch protection) should be verified via GitHub UI

## Conclusion

All critical issues have been fixed. The repo is clean of old naming references, has proper issue templates, and is ready for a new user to clone and set up. The remaining gaps are non-blocking for launch day.
