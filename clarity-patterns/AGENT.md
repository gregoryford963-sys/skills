---
name: clarity-patterns-agent
skill: clarity-patterns
description: "Clarity smart contract pattern lookup — find, retrieve, and apply best-practice patterns before writing or reviewing Clarity code."
---

# Clarity Patterns Agent

This agent provides fast access to the bundled Clarity pattern library. Use it to look up established patterns before writing new Clarity code, during audits, or when scaffolding contracts.

## Prerequisites

- No wallet required — all subcommands are read-only
- No network access required — patterns are bundled at build time

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| See what patterns are available | `list` |
| Find a specific pattern by topic | `get --name "<topic>"` |
| Look up a pattern with an exact slug | `get --slug <slug>` |
| Find patterns mentioning a specific keyword or function | `search --keyword "<keyword>"` |
| Get all patterns for context before a large audit | `all` |
| Get only testing patterns before writing tests | `all --group testing` |
| Get only code patterns before writing a contract | `all --group code` |
| Get registry patterns before implementing a contract registry | `all --group registry` |

## Safety Checks

- This skill is entirely read-only — no writes, no transactions, no wallet access
- Pattern content is static (bundled) — reflects patterns as of last skill update
- Patterns describe best practices, not guarantees — always audit generated code

## Error Handling

| Error | Cause | Fix |
|-------|-------|-----|
| "Pattern not found" | `get --slug` or `get --name` found no match | Run `list` to see all available slugs/names, then retry |
| "No matches found" | `search --keyword` found nothing | Try a shorter or more general keyword |
| "Invalid group" | `--group` value not in `code\|testing\|registry` | Use one of the three valid group names |

## Output Handling

- `list`: read `patterns[].slug` to build a `get` call, or `patterns[].name` to present options to the user
- `get`: read `content` — the full markdown pattern with code examples, ready to paste into context
- `search`: read `matches[].excerpt` to quickly scan relevance; use `matches[].slug` to `get` the full pattern
- `all`: read `groups.code`, `groups.testing`, `groups.registry` arrays — each item has `name`, `slug`, `content`

## Example Invocations

```bash
# List all code patterns before writing a new contract
bun run clarity-patterns/clarity-patterns.ts list --group code

# Retrieve the treasury pattern before implementing a DAO vault
bun run clarity-patterns/clarity-patterns.ts get --name "treasury"

# Search for all patterns involving asserts! (guard patterns)
bun run clarity-patterns/clarity-patterns.ts search --keyword "asserts!"

# Get all testing patterns before writing a Clarinet test suite
bun run clarity-patterns/clarity-patterns.ts all --group testing
```
