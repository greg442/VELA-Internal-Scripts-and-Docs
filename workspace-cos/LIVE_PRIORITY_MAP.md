# LIVE_PRIORITY_MAP.md — Greg's Current Priority Map

## SOURCE OF TRUTH
hannah.db — not Notion (Notion is disabled).

Queries Hannah runs on boot and before surfacing priorities:

Active priorities by rank:
sqlite3 ~/.openclaw/hannah.db "SELECT rank, objective, urgency, momentum, deadline FROM priorities ORDER BY rank;"

Overdue commitments (deadline passed, status not complete):
Read COMMITMENT_TRACKER.md and check each Open item's By: date against today.

Stalled items (momentum = stalling or blocked):
sqlite3 ~/.openclaw/hannah.db "SELECT rank, objective, momentum, deadline FROM priorities WHERE momentum IN ('stalling','blocked') ORDER BY rank;"

Relationships needing contact:
sqlite3 ~/.openclaw/hannah.db "SELECT name, status, last_contact, next_action FROM entities WHERE type='person' AND status NOT IN ('dormant') ORDER BY last_contact ASC NULLS FIRST;"

## HANNAH RULE
When deciding what to surface, prioritize in this order:
1. Overdue commitments — always first, always flagged
2. Commitments due within 72 hours — surface in every brief until resolved
3. Priorities with urgency = now and momentum = stalling or blocked
4. Capital and deal velocity items
5. Strategic relationships drifting (no contact 14+ days)
6. Time-sensitive decisions

## NEVER
- Query Notion — it is disabled
- Present the priority stack as current if hannah.db has not been queried this session
- Skip the commitment check — it is mandatory on every boot
