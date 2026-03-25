---
name: clarity-patterns
description: "Bundled Clarity smart contract patterns library — query, search, and retrieve best-practice code patterns, testing workflows, and registry contract templates for Stacks development."
metadata:
  author: "gregoryford963-sys"
  author-agent: "Amber Otter"
  user-invocable: "false"
  arguments: "list | get | search | all"
  entry: "clarity-patterns/clarity-patterns.ts"
  mcp-tools: ""
  requires: ""
  tags: "read-only, l2"
---

# Clarity Patterns Skill

Provides instant access to a curated library of Clarity smart contract patterns, testing recipes, and registry contract templates. Patterns are bundled at build time from `whoabuddy/claude-knowledge` — no runtime fetch required.

Use this skill before writing, auditing, or reviewing any Clarity contract to check for established patterns that apply to your use case.

## Usage

```bash
bun run clarity-patterns/clarity-patterns.ts <subcommand> [options]
```

## Subcommands

### list

List all available pattern categories.

```bash
bun run clarity-patterns/clarity-patterns.ts list
bun run clarity-patterns/clarity-patterns.ts list --group code
bun run clarity-patterns/clarity-patterns.ts list --group testing
bun run clarity-patterns/clarity-patterns.ts list --group registry
```

**Options:**
- `--group <code|testing|registry>` — filter by pattern group (default: all)

**Output:**
```json
{
  "groups": ["code", "testing", "registry"],
  "patterns": [
    { "group": "code", "name": "Public Function Template", "slug": "public-function-template" },
    ...
  ]
}
```

### get

Get the full content of a pattern by slug or partial name match.

```bash
bun run clarity-patterns/clarity-patterns.ts get --slug public-function-template
bun run clarity-patterns/clarity-patterns.ts get --name "bit flags"
```

**Options:**
- `--slug <slug>` — exact slug match
- `--name <name>` — case-insensitive partial name match

**Output:**
```json
{
  "group": "code",
  "name": "Bit Flags for Status/Permissions",
  "slug": "bit-flags-for-status-permissions",
  "content": "...(full markdown content)..."
}
```

### search

Search all patterns by keyword across name and content.

```bash
bun run clarity-patterns/clarity-patterns.ts search --keyword "treasury"
bun run clarity-patterns/clarity-patterns.ts search --keyword "asserts!"
```

**Options:**
- `--keyword <keyword>` — search term (case-insensitive)

**Output:**
```json
{
  "keyword": "treasury",
  "matches": [
    { "group": "code", "name": "Treasury Pattern with as-contract", "slug": "...", "excerpt": "..." },
    ...
  ]
}
```

### all

Output the complete pattern library as structured JSON.

```bash
bun run clarity-patterns/clarity-patterns.ts all
bun run clarity-patterns/clarity-patterns.ts all --group code
```

**Options:**
- `--group <code|testing|registry>` — filter to one group

**Output:**
```json
{
  "version": "1.0.0",
  "source": "whoabuddy/claude-knowledge",
  "groups": { "code": [...], "testing": [...], "registry": [...] }
}
```
