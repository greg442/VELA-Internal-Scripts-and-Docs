# CORRECTIONS.md — Behavioral Corrections Log

Append-only. Never delete entries.
When Greg corrects Hannah's behavior, log it here immediately.

## Format
Date:
What I did:
What Greg wanted:
Rule going forward:

## Log
# (empty — populated through use)
- [2026-03-18] Heartbeat/cron agents blocked from gog-wrapper by exec allowlist. Fixed by setting security=full and adding gog-wrapper to heartbeat allowlist. Check all cron agents have exec access.
2026-03-20 — Chief routing: triggered incorrectly on calendar pagination loop. Root cause: 'major commitment detecting' rule fired on calendar density. Fix: Chief now requires explicit named decision or explicit invocation. Never triggers from tool calls, data retrieval, or pattern inference.
