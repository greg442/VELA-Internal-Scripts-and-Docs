# VELA Hannah — System Architecture & Intelligence Layer
## Current State: March 23, 2026

---

## Overview

Hannah is Greg Shindler's AI Chief of Staff running on OpenClaw on a Mac Mini M4.
She operates across three delivery channels: Telegram (primary), Email, and WhatsApp (bridged via Telegram).

All intelligence flows through a single SQLite database: `~/.openclaw/hannah.db`

---

## File Structure

```
~/.openclaw/
├── hannah.db                          # Single source of truth — all intelligence
├── .env                               # API keys, Telegram tokens (never commit)
├── workspace-cos/                     # Hannah's active workspace
│   ├── CORE.md                        # Hannah's operating system and instructions
│   ├── BOOT.md                        # Session startup sequence
│   ├── COMMITMENT_TRACKER.md          # Hard commitments with dates
│   ├── DISPATCH_RULES.md              # Agent routing rules
│   ├── LIVE_PRIORITY_MAP.md           # Priority context
│   ├── DECISION_LOG.md                # Decision history
│   ├── CORRECTIONS.md                 # Logged corrections to Hannah's behavior
│   └── memory/                        # Daily session notes
├── morning_brief/                     # Morning brief system
│   ├── brief_template.html            # VELA-branded HTML template
│   ├── hannah_morning_brief_prompt.txt # Hannah's 9-step brief generation prompt
│   ├── hannah_email_loop_prompt.txt   # Hannah's email intelligence loop prompt
│   ├── generate_morning_brief.js      # Node.js fallback brief generator
│   ├── template_assets/               # VELA reticle image
│   └── node_modules/                  # docx npm package
├── datasette/
│   ├── static/
│   │   ├── dashboard.html             # Executive intelligence dashboard
│   │   └── briefs/                    # Daily HTML briefs (auto-generated)
│   │       └── today.html             # Always points to today's brief
│   └── datasette.yaml                 # Dashboard configuration
├── cron/
│   └── jobs.json                      # OpenClaw scheduler — all Hannah jobs
├── scripts/
│   ├── email-triage.py                # DISABLED — replaced by email loop job
│   ├── generate_morning_brief.py      # DISABLED — replaced by HTML brief system
│   ├── whatsapp-monitor.py            # WhatsApp bridge (active)
│   └── monitoring/
│       └── health_check.sh            # System health checks every 15 min
└── logs/                              # All system logs
```

---

## Intelligence Database Schema

```sql
entities (id, type, name, status, priority, context, tags, last_updated, stage,
          next_action, strategic_val, owner, risk, deal_type, category, momentum, last_contact)

signals (id, ts, source, entity_id, signal_type, ium_score, summary, action_taken)

decisions (id, ts, title, context, decision, rationale, assumptions, revisit_date, outcome, status, entity_id)

priorities (rank, entity_id, objective, next_action, owner, deadline, urgency, momentum, updated)

memory (id, ts, category, key, value, source)
```

**IUM Score** (Internal Urgency Metric): 1-10 scale
- 1-3: Low signal, informational
- 4-6: Worth watching, not yet actionable
- 7-8: Actionable, surface to Greg
- 9-10: Critical, immediate attention

---

## OpenClaw Cron Jobs

All jobs defined in `~/.openclaw/cron/jobs.json`

| Job Name | Schedule | Purpose |
|----------|----------|---------|
| hannah-morning | 6:00 AM ET weekdays | Morning intelligence brief |
| hannah-email-loop | Every 30 min, 7 AM-7 PM ET weekdays | Email intelligence loop |
| hannah-evening | 5:00 PM ET daily | Evening debrief |
| hannah-deal-velocity | 8:00 AM ET weekdays | Deal stall detection |
| hannah-wednesday-drift | 12:00 PM ET Wednesdays | Focus drift check |
| hannah-sunday-dashboard | 7:00 PM ET Sundays | Weekly dashboard |
| hannah-sunday-commitments | 8:00 PM ET Sundays | Weekly commitment review |
| hannah-relationship-drift | 9:00 AM ET Mondays | Relationship drift check |

---

## Morning Brief System

### How It Works

Hannah runs the morning brief via the `hannah-morning` OpenClaw cron job at 6 AM ET weekdays.

**9-step process:**
1. Query hannah.db (6 tables: priorities, decisions, signals, entities, relationships, deals)
2. Read COMMITMENT_TRACKER.md in full
3. Query calendar via gog-wrapper (filter personal/health blocks)
4. Check inbox for priority contacts only
5. Think through the data using structured reasoning questions
6. Write each section as HTML using the brief template CSS classes
7. Assemble complete HTML from brief_template.html
8. Save to `~/.openclaw/datasette/static/briefs/YYYY-MM-DD.html` and `today.html`
9. Send email + Telegram + log to memory

### Brief Sections (in order)
1. **Opening Verdict** — Hannah's synthesized read on the day (no label, Georgia serif)
2. **What Only You Can Do Today** — 1-3 filtered actions requiring Greg specifically
3. **Your Day, Interpreted** — Real meetings with intelligence and prep notes
4. **The Relationship That Needs You** — One degrading relationship with stakes named
5. **What Is About To Quietly Die** — One stalling item with no visible deadline
6. **Hannah's Recommendations** — Decisions where inaction costs something today
7. **What Hannah Is Watching** — Developing signals, optional, omitted if nothing real

### Brief URLs
- Local: `http://100.89.207.104:8001/dashboard/briefs/today.html`
- Tailscale (anywhere): `https://gregs-mac-mini.tail1143b3.ts.net:8001/dashboard/briefs/today.html`
- Auto-refreshes every 5 minutes

### Calendar Filter
Events excluded from the brief (case-insensitive substring match):
no igf, no peptides, trizepitide, tirzepatide, semaglutide, injection, supplement,
workout, rest day, weigh-in, fasting, clear hannah, launch sequence, deep work,
do not book, break, lunch, protected, email triage, decisions queue

### Telegram Summary Format
Delivered via HTML parse mode. Sections:
- Header (bold, date)
- Today (single most important move)
- Priorities (top 3 compressed)
- Calendar (one meeting per line)
- Decisions (if time-sensitive)
- Signal (if IUM 7+ in last 24 hours)
- Full brief link

---

## Email Intelligence Loop

### How It Works

Hannah runs the email loop via `hannah-email-loop` every 30 minutes, weekdays 7 AM-7 PM ET.

**11-step process:**
1. Fetch both inboxes (greg@ and cos.@) via gog-wrapper
2. Filter noise by Gmail label (CATEGORY_PROMOTIONS, UPDATES, SOCIAL, FORUMS)
3. Classify remaining emails with Ollama qwen2.5:7b (free, local, fast)
4. Discard NOISE classifications
5. Pull full context from hannah.db for each sender
6. Think through each email: what is the real request, what context matters, what voice
7. Draft reply in correct voice (Greg's for investors/deals, Hannah's for logistics)
8. Update hannah.db: last_contact, signal log, deal momentum, commitments
9. Surface drafts to Greg via Telegram (one message per email, full draft text)
10. Mark processed emails as read
11. Log completion if anything was actioned

### Voice Rules
- **Greg's voice (greg@)**: Investors, deal partners, legal counterparties, site partners
- **Hannah's voice (cos.@)**: Scheduling, logistics, coordination, follow-up
- Default to Greg's voice when uncertain

### Telegram Draft Format
```
Reply needed -- [SENDER NAME]
[subject line]

[One sentence context]

Draft ([greg@ or cos.@ voice]):
[full draft text]

Send? Y to send, N to discard, or send edits
```

### What Updates the Database
Every processed email triggers:
- `entities.last_contact` updated for sender
- Signal logged to `signals` table
- Commitment added to COMMITMENT_TRACKER.md if applicable
- Entity momentum/context updated if deal movement detected

---

## WhatsApp Bridge

### How It Works

WhatsApp messages are received by OpenClaw via the WhatsApp plugin and logged to:
`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

A Python monitor (`~/.openclaw/scripts/whatsapp-monitor.py`) tails this log every 2 seconds.
When it detects an inbound message from a known contact, it forwards to Greg's Telegram chat.

Hannah sees the forwarded message in Telegram and can respond there.
OpenClaw routes Hannah's Telegram reply back through the WhatsApp plugin to the original sender.

### Known WhatsApp Contacts
| Number | Name |
|--------|------|
| +12023605591 | Hilary |
| +17873600077 | Manuel |
| +15128177923 | Greg Walker |
| +12026152012 | Ricky |
| +17132985539 | Stephanie |
| +16159729979 | Britnie |
| +12142139500 | Waldo |
| +12024395582 | Greg (202) |

### LaunchAgent
`~/Library/LaunchAgents/ai.openclaw.whatsapp-monitor.plist`
Runs at login, keeps alive automatically.

---

## Delivery Infrastructure

### Datasette Dashboard
- Runs via launchd: `~/Library/LaunchAgents/com.vela.datasette.plist`
- Port: 8001, bound to 0.0.0.0 (accessible via Tailscale)
- Static files served at: `/dashboard/[filename]`
- Briefs served at: `/dashboard/briefs/[date].html`

### Tailscale
- Mac Mini hostname: `gregs-mac-mini.tail1143b3.ts.net`
- Used for remote access to dashboard, briefs, and webhook endpoint

### Telegram
- Bot token and chat ID stored in `~/.openclaw/.env`
- All Hannah communications use HTML parse mode for bold/italic formatting
- Greg's chat ID: 8248659673

### Google Drive
- Brief folder: `16lnvbDk_RWtfUR7vfF9ZgoOqiU9cb0No` (My Drive > VELA Greg > Chief of Staff)
- Auth config: `~/.openclaw/workspace-cos/scripts/.drive_auth.json`
- PDF briefs archived to Drive after each morning brief generation

---

## Disabled Scripts

These scripts are disabled and should not be re-enabled:

| Script | Replaced By |
|--------|------------|
| `scripts/generate_morning_brief.py` | `hannah-morning` OpenClaw cron job |
| `scripts/email-triage.py` | `hannah-email-loop` OpenClaw cron job |

Both renamed to `.disabled` extension. Do not delete — kept for reference.

---

## Active System Crons (user crontab)

```
*/15 * * * *     health_check.sh
0 23 * * *       reset-bloated-sessions.sh
0 2 * * *        backup_gdrive.sh
*/15 * * * 1-5   meeting_prep.py
0 8 * * 1-5      commitments_engine.py check
0 16 * * 5       chief_weekly_report.py
```

---

## Key Principles

1. **hannah.db is the single source of truth.** All intelligence flows in and out through the database. No Notion. No markdown files for live data.

2. **The brief reads from the database. Email writes to it.** Email loop runs all day updating intelligence. Morning brief synthesizes everything into a decision-ready document.

3. **Hannah must always know what is in the brief.** The brief is her output, not a separate system's output. She generates it, she owns it, she starts the day already knowing its contents.

4. **Silence is correct when there is nothing worth saying.** The email loop sends nothing if there is nothing actionable. The brief omits sections when there is nothing real to put in them.

5. **Every autonomous action logs a signal.** Hannah logs what she does so the pattern of her work is visible and auditable.

6. **Draft and surface. Never send without approval.** All email drafts require Greg's explicit Y approval before sending.
