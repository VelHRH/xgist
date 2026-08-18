# Global Coding Rules

## Comments

- Never add comments to code unless explicitly requested.
- Never add JSDoc or documentation comments unless requested.

## Code Style

- Preserve the existing formatting style.
- Prefer modifying existing code instead of rewriting files.
- Keep changes as small as possible.

## Communication

- If a requirement is ambiguous, ask before implementing.

## Context7

Use Context7 MCP to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service. Start by resolving the library ID, then query the selected library's documentation with one focused concept per query. Prefer Context7 over web search for library documentation.

Do not use Context7 for refactoring, scripts written from scratch, business-logic debugging, code review, or general programming concepts.

## Agent skills

### Issue tracker

Issues are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Domain docs

This repository uses a single-context domain glossary and root ADR directory. See `docs/agents/domain.md`.
