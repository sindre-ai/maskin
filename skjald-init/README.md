# Skjald

Self-owned, Apache 2.0-licensed meeting bot infrastructure.

## Prerequisites

- Node.js >= 20
- pnpm 9.15.0

## Getting Started

```bash
pnpm install
pnpm build
pnpm dev
```

## Project Structure

```
apps/
  bot-runner/       - Headless browser bot that joins meetings
  orchestrator/     - REST API that manages bots
  speaking-bot/     - Bot that can speak in meetings
  transcript-ui/    - UI for viewing transcripts
  e2e/              - End-to-end tests (Playwright)
packages/
  shared/           - Shared types and utilities
  db/               - Database layer
  transcription/    - Transcription service
  mcp/              - MCP server (Maskin integration)
  speaking-mcp/     - MCP server for speaking bot
docker/             - Docker base images
```

## Scripts

- `pnpm dev` - Start all services in dev mode
- `pnpm build` - Build all packages
- `pnpm test` - Run all tests
- `pnpm lint` - Lint with Biome
- `pnpm lint:fix` - Auto-fix lint issues
- `pnpm format` - Format with Biome
- `pnpm type-check` - TypeScript type checking

## License

Apache-2.0
