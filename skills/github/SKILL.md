---
name: github
description: Interact with the public GitHub API — search repositories, users and code, fetch repo metadata and READMEs. Use for anything about GitHub repos, projects or developers.
---

# GitHub Skill

Talks to the public GitHub REST API (no token required, rate-limited) and returns structured results.

## Usage

Hand the skill an instruction as `input`. Supported operations:

- `search repos: <query>` — repository search (name/description/readme)
- `search users: <query>` — user/org search
- `search code: <query>` — code search (public code only)
- `repo: <owner>/<name>` — repo metadata (stars, language, description, updated)
- `readme: <owner>/<name>` — rendered README (as text)

## Output

Compact JSON with the requested data. If the GitHub API rate limit is hit, the error message with retry info is returned.

## Notes

- Public API allows 60 requests/hour unauthenticated; use sparingly.
- Attach a token by setting `GITHUB_TOKEN` in the environment for higher limits and private access.
