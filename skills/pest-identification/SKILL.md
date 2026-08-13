---
name: pest-identification
description: Identify common garden and crop pests from descriptions (insects, chewing damage, webbing, eggs) and return control advice. Use for bug identification questions.
---

# Pest Identification Skill

Matches keywords from the user's pest description to common agricultural pests and returns identification details plus control recommendations.

## Usage

Hand the skill the pest description as `input`. Example:

- `input: "small green insects clustered on new tomato shoots"`
- `input: "tiny white flies that fly up when I touch the plant"`

## Output

A JSON list of candidate pests: `[{ pest, match, signs, damage, control }]`. If nothing matches, returns guidance to capture a photo and contact an entomologist / extension service.

## Notes

- Keyword-based best-effort identification; confirm before applying pesticides.
- Prefer integrated pest management (IPM) and biological control over broad-spectrum chemicals.
