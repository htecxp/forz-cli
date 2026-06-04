#!/usr/bin/env bash
# Regenerate AGENTS.md from SKILL.md so the Codex / AGENTS.md-compatible
# instructions stay in sync with the Claude skill. SKILL.md is the single source
# of truth; run this after editing it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/forz-cli/SKILL.md"
dst="$here/forz-cli/AGENTS.md"

{
  cat <<'NOTE'
<!-- Generated from SKILL.md by skill/sync-skill-docs.sh — do not edit by hand. -->

> **Using OpenAI Codex or another `AGENTS.md`-compatible agent?** Append the rest
> of this file to your project's `AGENTS.md` (or `~/.codex/AGENTS.md`). It is the
> same guidance as the Claude skill at `skill/forz-cli/SKILL.md`, minus the
> Claude-specific frontmatter.

NOTE
  # Everything after the closing (second) `---` of the YAML frontmatter.
  awk 'f{print; next} /^---[[:space:]]*$/{c++; if(c==2) f=1}' "$src"
} > "$dst"

echo "Wrote $dst ($(wc -l < "$dst") lines)"
