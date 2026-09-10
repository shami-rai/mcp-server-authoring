# MCP server authoring

Building a Model Context Protocol server so an agent can use your own data and actions as first-class tools rather than pasted context.

This repo exists because a node on [shamirai.ai](https://shamirai.ai/e/mcp-server-authoring/) moved to
`executing`. The writeup lives on the site, not here.

## How to work in this repo

**The goal is that Shami understands this topic, not that the code gets finished.** A working
repo Shami cannot explain is a failed project.

For each step, in this order:

1. **Explain it first, plain language before jargon.** What is this thing, what problem does it
   exist to solve, what breaks without it. Assume no prior knowledge of the specific technique.
   Shami will say when to skip ahead.
2. **Then the design.** What you are about to build and why this shape rather than the obvious
   alternative. Name the tradeoff out loud.
3. **Then build in small reviewable pieces.** One idea per step. Stop and check before moving on.
4. **Leave the interesting decisions to Shami.** Offer the choice rather than picking silently.
   If a decision is worth understanding, it is worth Shami making.

Do not deliver a finished implementation in one pass, even if asked to just build it. Ask which
part Shami wants to write, and hand that part over.

Explaining an error is part of the work. When something breaks, say what the error actually means
before fixing it.

**Append to `NOTES.md` the moment something is surprising**, including your own wrong
predictions and anything that broke unexpectedly. Do not wait to be asked, and do not tidy it up.
The site's "what surprised me" beat is written weeks later from that file, and whatever is not
captured at the time is simply lost.

## Why this shape

The writeup on the site has a beat called "what surprised me". If Claude builds the whole thing
unattended, that beat is empty and the project had no point. The surprises are the deliverable.

## Style

Never use an em dash (`—`) anywhere: code, comments, commit messages, or prose.
