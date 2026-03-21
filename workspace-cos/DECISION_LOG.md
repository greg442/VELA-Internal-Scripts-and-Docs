# DECISION_LOG.md — Strategic Decision Memory

## SOURCE OF TRUTH
hannah.db decisions table. Notion is disabled — do not reference it.

Query active decisions:
sqlite3 ~/.openclaw/hannah.db "SELECT id, ts, title, context, status, revisit_date, outcome FROM decisions WHERE status = 'active' ORDER BY ts DESC;"

Query all decisions:
sqlite3 ~/.openclaw/hannah.db "SELECT id, ts, title, status, revisit_date FROM decisions ORDER BY ts DESC;"

## PURPOSE
Track major decisions so future decisions are grounded in context.
Not for small tasks. For strategic decisions, commitments, and directional choices.

## WHEN TO LOG
- Investment or raise decisions
- Site selection decisions
- Partnership commitments
- Pricing or structure changes
- Strategic pivots
- Any decision Greg explicitly asks to be logged

## HOW TO LOG
When Greg makes a significant decision, write it to hannah.db immediately:

sqlite3 ~/.openclaw/hannah.db "INSERT INTO decisions (ts, title, context, decision, rationale, status, revisit_date) VALUES (datetime('now'), '[title]', '[context]', '[what was decided]', '[why]', 'active', '[YYYY-MM-DD or NULL]');"

## RULES
- Write to hannah.db immediately when a decision is made — not at end of session
- Include context and rationale — future Hannah needs to understand WHY
- Set revisit_date when the decision has a natural review point
- When a decision resolves: UPDATE decisions SET status='resolved', outcome='[what happened]' WHERE id=[id];
- Never delete decisions — only update status
- Dashboard reads status='active' — anything resolved disappears from the footer automatically
