---
name: web-search
description: Search the web for a query and return ranked results with titles, URLs and snippets. Use for current events, docs, prices, facts, or anything needing live public info.
---

# Web Search Skill

Searches the public web via the DuckDuckGo HTML endpoint (no API key needed) and returns the top results with title, URL and a text snippet.

## Usage

Hand the skill the natural-language query as `input`. Example:

- `input: "Hermes Forge agent workbench"`
- `input: "latest Nous Research Hermes model release"`

## Output

A JSON list of results: `[{ title, url, snippet }]`. If the network or parser fails, a clear error string is returned instead.

## Notes

- Results are ranked by the search engine, not by relevance to your conversation.
- Always cite the returned URLs when you use this information in an answer.
