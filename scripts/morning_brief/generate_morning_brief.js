#!/usr/bin/env node
/**
 * VELA Morning Brief Generator — Greg Shindler Install
 * Runs at 6:00 AM ET weekdays via cron
 *
 * Flow:
 *   1. Query hannah.db (6 queries)
 *   2. Read COMMITMENT_TRACKER.md
 *   3. Query calendar (filtered)
 *   4. Query inbox (priority contacts only)
 *   5. Build styled DOCX matching VELA template
 *   6. Convert to PDF via LibreOffice
 *   7. Upload PDF to Google Drive (Chief of Staff folder)
 *   8. Send email to greg@gregshindler.com with PDF attached
 *   9. Send Telegram 3-line summary + Drive link
 *
 * Usage:
 *   node generate_morning_brief.js           # live run
 *   node generate_morning_brief.js --dry-run # skip email/telegram/drive
 */

'use strict';

const {
  Document, Packer, Paragraph, TextRun, ImageRun,
  AlignmentType, BorderStyle, Header, Footer
} = require('docx');

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const { spawnSync } = require('child_process');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const HOME      = process.env.HOME;
const DRY_RUN   = process.argv.includes('--dry-run');

const DB_PATH   = path.join(HOME, '.openclaw/hannah.db');
const WORKSPACE = path.join(HOME, '.openclaw/workspace-cos');
const OUT_DIR   = path.join(HOME, '.openclaw/briefs');
const ENV_FILE  = path.join(HOME, '.openclaw/.env');
const DRIVE_AUTH= path.join(HOME, '.openclaw/workspace-cos/scripts/.drive_auth.json');
const RETICLE   = path.join(__dirname, 'template_assets/d731c64d522f982565ffbbca4660b35d1d129dd4.png');

// Greg-specific delivery config
const DRIVE_FOLDER_ID = '16lnvbDk_RWtfUR7vfF9ZgoOqiU9cb0No';
const EMAIL_TO        = 'greg@gregshindler.com';
const EMAIL_FROM      = 'cos.gregshindler@gmail.com';
const GOG_ACCOUNT     = 'greg@gregshindler.com';

const NOW         = new Date();
const TODAY_ISO   = NOW.toISOString().split('T')[0];
const TODAY_LABEL = NOW.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase();

// Brand palette
const C = {
  near_black: '2D2D2D', olive: '8B9F6B', divider: 'C8C4BC',
  muted: '999999', signal_red: 'C0392B', signal_amber: 'D4A017',
};

// Calendar blocks to filter — per CORE.md CALENDAR FILTER RULE
const CALENDAR_FILTER = [
  'no igf','trizepitide','tirzepatide','semaglutide',
  'injection','supplement','workout','rest day','weigh-in','fasting','fast day'
];

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  fs.readFileSync(ENV_FILE, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_]+)=["']?(.+?)["']?\s*$/);
    if (m) process.env[m[1]] = m[2];
  });
}

function sql(query) {
  const r = spawnSync('sqlite3', ['-separator', '\t', DB_PATH, query], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.trim().split('\n').filter(Boolean).map(l => l.split('\t'));
}

function dbReachable() {
  return spawnSync('sqlite3', [DB_PATH, 'SELECT 1;'], { encoding: 'utf8' }).status === 0;
}

function readWorkspaceFile(rel) {
  try { return fs.readFileSync(path.join(WORKSPACE, rel), 'utf8'); } catch { return ''; }
}

// ─── CALENDAR ────────────────────────────────────────────────────────────────

function queryCalendar() {
  try {
    const r = spawnSync('bash', ['-c',
      `gog-wrapper calendar list -a ${GOG_ACCOUNT} --days 1 2>/dev/null`
    ], { encoding: 'utf8' });
    if (!r.stdout) return [];
    return r.stdout.split('\n').filter(Boolean).map(line => {
      const [time, summary, attendees] = line.split('|').map(s => s.trim());
      return { time, summary, attendees: attendees || '' };
    }).filter(e => e.summary && !CALENDAR_FILTER.some(f => e.summary.toLowerCase().includes(f)));
  } catch { return []; }
}

// ─── INBOX ───────────────────────────────────────────────────────────────────

function queryInbox() {
  try {
    const priorityNames = sql(`SELECT name FROM entities WHERE type='relationship' AND strategic_val='high'`).map(r => r[0].toLowerCase());
    const r = spawnSync('bash', ['-c',
      `gog-wrapper gmail search "is:unread is:important" -a ${GOG_ACCOUNT} --limit 20 2>/dev/null`
    ], { encoding: 'utf8' });
    if (!r.stdout) return [];
    return r.stdout.split('\n').filter(Boolean).map(line => {
      const [sender, subject] = line.split('|').map(s => s.trim());
      return { sender, subject };
    }).filter(({ sender }) => priorityNames.some(n => sender.toLowerCase().includes(n.split(' ')[0])));
  } catch { return []; }
}

// ─── DRIVE UPLOAD ────────────────────────────────────────────────────────────

async function getDriveToken() {
  if (!fs.existsSync(DRIVE_AUTH)) return null;
  const auth = JSON.parse(fs.readFileSync(DRIVE_AUTH, 'utf8'));
  return new Promise(resolve => {
    const body = JSON.stringify({ client_id: auth.client_id, client_secret: auth.client_secret, refresh_token: auth.refresh_token, grant_type: 'refresh_token' });
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d).access_token); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

async function uploadToDrive(filePath, fileName) {
  if (DRY_RUN) { console.log(`[DRY RUN] Drive upload: ${fileName}`); return 'https://drive.google.com/dry-run'; }
  const token = await getDriveToken();
  if (!token) { console.warn('Drive token unavailable.'); return null; }
  return new Promise(resolve => {
    const fileData  = fs.readFileSync(filePath);
    const mimeType  = filePath.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const metadata  = JSON.stringify({ name: fileName, parents: [DRIVE_FOLDER_ID] });
    const boundary  = 'vela_boundary_xyz';
    const body = Buffer.concat([
      Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      fileData,
      Buffer.from(`\r\n--${boundary}--`)
    ]);
    const req = https.request({ hostname: 'www.googleapis.com', path: '/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/related; boundary="${boundary}"`, 'Content-Length': body.length } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d).webViewLink || null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

// ─── EMAIL ───────────────────────────────────────────────────────────────────

function sendEmail(pdfPath, driveLink) {
  if (DRY_RUN) { console.log(`[DRY RUN] Email to ${EMAIL_TO} with attachment ${pdfPath}`); return; }
  const subject  = `VELA Morning Brief - ${TODAY_LABEL}`;
  const linkLine = driveLink ? `Drive link: ${driveLink}` : 'Drive upload failed - brief attached directly.';
  const bodyText = `Good morning,\n\nYour morning intelligence brief for ${TODAY_LABEL} is attached.\n\n${linkLine}\n\nHannah Cross | Chief of Staff\ncos.gregshindler@gmail.com`;

  // Write body to temp file - avoids stdin permission issues on macOS
  const bodyFile = path.join(OUT_DIR, '.email_body.txt');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(bodyFile, bodyText);

  const r = spawnSync('gog-wrapper', [
    'gmail', 'send',
    '--from',      EMAIL_FROM,
    '--to',        EMAIL_TO,
    '--cc',        GOG_ACCOUNT,
    '--subject',   subject,
    '--body-file', bodyFile,
    '--attach',    pdfPath,
    '-a',          EMAIL_FROM,
    '-y'
  ], { encoding: 'utf8' });

  try { fs.unlinkSync(bodyFile); } catch {}

  if (r.status !== 0) {
    console.warn('Email warning:', r.stdout || r.stderr);
  } else {
    console.log(`Email sent to ${EMAIL_TO}`);
  }
}

// ─── TELEGRAM ────────────────────────────────────────────────────────────────

function sendTelegram(msg) {
  if (DRY_RUN) { console.log('[DRY RUN] Telegram:', msg); return; }
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_USER_CHAT_ID;
  if (!token || !chatId) { console.warn('Telegram credentials missing from .env'); return; }
  const body = JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' });
  const req = https.request({ hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, res => res.resume());
  req.on('error', e => console.warn('Telegram error:', e.message));
  req.write(body); req.end();
}

// ─── PDF CONVERSION ──────────────────────────────────────────────────────────

function convertToPDF(docxPath) {
  const dir = path.dirname(docxPath);
  const pdfPath = docxPath.replace('.docx', '.pdf');
  const sofficePy = path.join(HOME, '.openclaw/tools/soffice.py');
  const args = ['--headless', '--convert-to', 'pdf', '--outdir', dir, docxPath];
  if (fs.existsSync(sofficePy)) {
    spawnSync('python3', [sofficePy, ...args], { encoding: 'utf8' });
  } else {
    spawnSync('soffice', args, { encoding: 'utf8' });
  }
  return fs.existsSync(pdfPath) ? pdfPath : null;
}

// ─── DOCUMENT ELEMENTS ───────────────────────────────────────────────────────

const hr = () => new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 3, color: C.divider, space: 1 } }, spacing: { before: 160, after: 160 }, children: [] });

const secHead = (text) => new Paragraph({ spacing: { before: 320, after: 120 }, children: [new TextRun({ text, font: 'Georgia', bold: true, color: C.olive, size: 20, allCaps: true })] });

const bod = (text, o = {}) => new Paragraph({ spacing: { before: o.before || 0, after: o.after || 80 }, children: [new TextRun({ text, font: 'Lato', size: o.size || 22, color: o.color || C.near_black, bold: o.bold || false, italics: o.italic || false })] });

const lbl = (text) => new Paragraph({ spacing: { before: 140, after: 60 }, children: [new TextRun({ text, font: 'Courier New', size: 16, color: C.muted, allCaps: true })] });

const mut = (text) => bod(text, { color: C.muted, italic: true });

// ─── COVER PAGE ──────────────────────────────────────────────────────────────

function buildCover(reticleData) {
  const els = [];
  if (reticleData) {
    els.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 800, after: 400 }, children: [new ImageRun({ data: reticleData, type: 'png', transformation: { width: 100, height: 101 } })] }));
  } else {
    els.push(new Paragraph({ spacing: { before: 1200 }, children: [] }));
  }
  els.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 }, children: [new TextRun({ text: 'V   E   L   A', font: 'Georgia', size: 72, color: C.near_black, characterSpacing: 200 })] }));
  els.push(new Paragraph({ spacing: { before: 800, after: 200 }, border: { bottom: { style: BorderStyle.SINGLE, size: 3, color: C.divider, space: 1 } }, children: [] }));
  els.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200, after: 120 }, children: [new TextRun({ text: 'Morning Intelligence Brief', font: 'Georgia', size: 52, color: C.near_black })] }));
  els.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 80, after: 200 }, children: [new TextRun({ text: TODAY_LABEL, font: 'Georgia', italics: true, size: 22, color: C.olive })] }));
  els.push(new Paragraph({ spacing: { before: 200, after: 200 }, border: { bottom: { style: BorderStyle.SINGLE, size: 3, color: C.divider, space: 1 } }, children: [] }));
  els.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200, after: 80 }, children: [new TextRun({ text: 'Greg Shindler  \u00B7  greg@gregshindler.com  \u00B7  202-439-5834  \u00B7  @Vela_Greg', font: 'Courier New', size: 16, color: C.muted })] }));
  els.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'PRIVATE ACCESS  \u00B7  BY INTRODUCTION ONLY', font: 'Courier New', size: 14, color: C.muted })] }));
  return els;
}

// ─── BRIEF CONTENT ───────────────────────────────────────────────────────────

function buildContent(data) {
  const { priorities, decisions, signalsToday, signalsWeek, relationships, deals, commitmentTracker, calendarEvents, inboxItems } = data;
  const els = [];

  // Page break after cover
  els.push(new Paragraph({ pageBreakBefore: true, children: [] }));

  // ── 1. TODAY'S CALL ──────────────────────────────────────────────────────
  els.push(secHead("1. Today's Call"));
  els.push(hr());

  const urgentDecision = decisions.find(d => d[3] && (new Date(d[3]) - NOW) / 86400000 <= 1);
  const top1 = priorities[0];
  let todaysCall;

  if (urgentDecision && top1) {
    todaysCall = `If you do one thing today: make a call on "${urgentDecision[0]}" — revisit date is ${urgentDecision[3]}. Leaving it open gates downstream movement. One decision, multiple priorities unblocked.`;
  } else if (top1) {
    const [,entityId, objective, nextAction, deadline, urgency, momentum] = top1;
    if (urgency === 'now' && deadline) {
      todaysCall = `If you do one thing today: advance ${objective}. Next move: ${nextAction}. Deadline is ${deadline} and momentum is ${momentum}. Everything downstream waits on this.`;
    } else {
      todaysCall = `If you do one thing today: advance ${objective}. Next move: ${nextAction}. Highest-ranked priority and most likely to compound if it moves today.`;
    }
  } else {
    todaysCall = 'Priority data unavailable. Verify hannah.db before the day starts.';
  }
  els.push(bod(todaysCall, { bold: true, before: 80 }));

  // ── 2. COMMAND LAYER ─────────────────────────────────────────────────────
  els.push(secHead('2. Command Layer'));
  els.push(hr());

  if (priorities.length === 0) {
    els.push(mut('No priority data available.'));
  } else {
    priorities.slice(0, 3).forEach(([rank,,objective, nextAction, deadline, urgency, momentum]) => {
      const uc = urgency === 'now' ? C.signal_red : urgency === 'soon' ? C.signal_amber : C.near_black;
      els.push(new Paragraph({ spacing: { before: 100, after: 60 }, children: [
        new TextRun({ text: `${rank}. `, font: 'Lato', bold: true, size: 22, color: C.olive }),
        new TextRun({ text: objective, font: 'Lato', bold: true, size: 22, color: C.near_black }),
        new TextRun({ text: `  |  ${nextAction || 'no next action set'}`, font: 'Lato', size: 20, color: C.near_black }),
        new TextRun({ text: `  |  Urgency: `, font: 'Lato', size: 18, color: C.muted }),
        new TextRun({ text: urgency || 'n/a', font: 'Lato', size: 18, bold: true, color: uc }),
        new TextRun({ text: `  |  Momentum: ${momentum || 'n/a'}`, font: 'Lato', size: 18, color: C.muted }),
        new TextRun({ text: deadline ? `  |  Deadline: ${deadline}` : '', font: 'Lato', size: 18, color: C.muted }),
      ]}));
    });
  }

  // ── 3. COMMITMENT PRESSURE ───────────────────────────────────────────────
  els.push(secHead('3. Commitment Pressure'));
  els.push(hr());

  const in48h = new Date(NOW.getTime() + 2 * 86400000);
  const due = [], atRisk = [], overdue = [];
  const stalledEntities = deals.filter(d => d[2] === 'stalled').map(d => d[0].toLowerCase());

  // Parse structured COMMITMENT_TRACKER.md format
  // Each commitment block has: Commitment title (###), To:, By:, Context:, Status:
  const commitBlocks = (commitmentTracker || '').split(/^###/m).filter(b => b.trim());
  commitBlocks.forEach(block => {
    const titleMatch  = block.match(/^\s*(.+?)\n/);
    const byMatch     = block.match(/^By:\s*(.+)$/m);
    const statusMatch = block.match(/^Status:\s*(.+)$/m);
    const toMatch     = block.match(/^To:\s*(.+)$/m);

    if (!titleMatch || !byMatch) return;

    const title  = titleMatch[1].trim();
    const byRaw  = byMatch[1].trim();
    const status = statusMatch ? statusMatch[1].trim().toLowerCase() : '';
    const to     = toMatch ? toMatch[1].trim() : '';

    // Skip completed commitments
    if (status.includes('complete')) return;

    // Try to parse a date from the By: field
    const isoMatch  = byRaw.match(/(\d{4}-\d{2}-\d{2})/);
    const textMatch = byRaw.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:\s+at\s+[\d:apmPMAM\s]+(?:PT|ET|UTC)?)?(?:,?\s*(\d{4}))?/i);

    let byDate = null;
    if (isoMatch) {
      byDate = new Date(isoMatch[1]);
    } else if (textMatch) {
      const year = textMatch[3] || NOW.getFullYear();
      byDate = new Date(`${textMatch[1]} ${textMatch[2]} ${year}`);
    }

    const displayLine = `${title} — To: ${to} — By: ${byRaw}`;

    if (byRaw.toLowerCase().includes('tbd') || byRaw.toLowerCase().includes('gated') || !byDate) {
      // No hard date — check if it involves a stalled entity
      if (stalledEntities.some(e => title.toLowerCase().includes(e) || to.toLowerCase().includes(e))) {
        atRisk.push(displayLine);
      }
      return;
    }

    if (byDate < NOW) overdue.push(displayLine);
    else if (byDate <= in48h) due.push(displayLine);
    else if (stalledEntities.some(e => title.toLowerCase().includes(e))) atRisk.push(displayLine);
  });

  let commitRendered = false;
  if (due.length)    { els.push(lbl('Due in 48 Hours'));              due.forEach(l => els.push(bod(l)));                             commitRendered = true; }
  if (atRisk.length) { els.push(lbl('At Risk of Slipping'));          atRisk.forEach(l => els.push(bod(l, { color: C.signal_amber }))); commitRendered = true; }
  if (overdue.length){ els.push(lbl('Credibility at Risk — Overdue')); overdue.forEach(l => els.push(bod(l, { color: C.signal_amber }))); commitRendered = true; }
  if (!commitRendered) els.push(mut('No hard commitments in the next 48 hours.'));

  // ── 4. CALENDAR INTELLIGENCE ─────────────────────────────────────────────
  els.push(secHead('4. Calendar Intelligence'));
  els.push(hr());

  if (calendarEvents.length === 0) {
    els.push(mut('Calendar is clear.'));
  } else {
    calendarEvents.forEach(({ time, summary, attendees }) => {
      els.push(new Paragraph({ spacing: { before: 100, after: 40 }, children: [
        new TextRun({ text: time || '', font: 'Lato', bold: true, size: 22, color: C.near_black }),
        new TextRun({ text: '  —  ', font: 'Lato', size: 22, color: C.muted }),
        new TextRun({ text: summary || '', font: 'Lato', bold: true, size: 22, color: C.near_black }),
      ]}));
      if (attendees) els.push(bod(`Attendees: ${attendees}`, { color: C.muted }));
      // Prep note: look for matching entity in db
      const entityMatch = sql(`SELECT context, next_action FROM entities WHERE name LIKE '%${(summary||'').split(' ')[0]}%' LIMIT 1`);
      if (entityMatch[0] && entityMatch[0][0]) {
        els.push(bod(`Context: ${entityMatch[0][0]}`, { color: C.muted }));
      }
    });
  }

  // ── 5. INBOX: WHAT ACTUALLY MATTERS ──────────────────────────────────────
  els.push(secHead('5. Inbox: What Actually Matters'));
  els.push(hr());

  if (inboxItems.length === 0) {
    els.push(mut('Inbox is clear of priority items.'));
  } else {
    inboxItems.forEach(({ sender, subject }) => {
      els.push(new Paragraph({ spacing: { before: 80, after: 40 }, children: [
        new TextRun({ text: sender, font: 'Lato', bold: true, size: 22, color: C.near_black }),
        new TextRun({ text: `  —  ${subject}`, font: 'Lato', size: 22, color: C.near_black }),
      ]}));
    });
  }

  // ── 6. RELATIONSHIP TEMPERATURE ──────────────────────────────────────────
  els.push(secHead('6. Relationship Temperature'));
  els.push(hr());

  const highPri = relationships.filter(r => r[2] === 'high');
  const needsContact = highPri.filter(([,lastContact]) => !lastContact || lastContact === 'null' || (NOW - new Date(lastContact)) / 86400000 > 7);
  const drifting     = highPri.filter(([,lastContact]) => { if (!lastContact || lastContact === 'null') return false; const d = (NOW - new Date(lastContact)) / 86400000; return d > 14 && d <= 30; });
  const trustItems   = overdue.filter(l => highPri.some(([name]) => l.toLowerCase().includes(name.toLowerCase())));

  let relRendered = false;
  if (needsContact.length > 0) {
    els.push(lbl('Needs Contact Now'));
    needsContact.forEach(([name, lastContact,,, nextAction]) => {
      const days = lastContact && lastContact !== 'null' ? Math.floor((NOW - new Date(lastContact)) / 86400000) : '?';
      els.push(new Paragraph({ spacing: { before: 80, after: 40 }, children: [
        new TextRun({ text: name, font: 'Lato', bold: true, size: 22, color: C.near_black }),
        new TextRun({ text: `  Last contact: ${days} days ago`, font: 'Lato', size: 20, color: C.muted }),
        new TextRun({ text: nextAction && nextAction !== 'null' ? `  |  ${nextAction}` : '', font: 'Lato', size: 20, color: C.near_black }),
      ]}));
    });
    relRendered = true;
  }
  if (drifting.length > 0) {
    els.push(lbl('Drifting'));
    drifting.forEach(([name, lastContact]) => {
      const days = Math.floor((NOW - new Date(lastContact)) / 86400000);
      els.push(bod(`${name} — ${days} days since last contact. Was active. Worth a check-in before the silence becomes a signal.`, { color: C.muted }));
    });
    relRendered = true;
  }
  if (trustItems.length > 0) {
    els.push(lbl('Trust Ledger — Clear Today to Unblock'));
    trustItems.forEach(l => els.push(bod(l, { italic: true })));
    relRendered = true;
  }
  if (!relRendered) els.push(mut('High-priority relationships are current.'));

  // ── 7. DECISION PRESSURE ─────────────────────────────────────────────────
  if (decisions.length > 0) {
    els.push(secHead('7. Decision Pressure'));
    els.push(hr());

    decisions.forEach(([title,, context, revisitDate]) => {
      const daysTo = revisitDate ? Math.floor((new Date(revisitDate) - NOW) / 86400000) : null;
      const isUrgent = daysTo !== null && daysTo <= 2;
      els.push(new Paragraph({ spacing: { before: 120, after: 40 }, children: [
        new TextRun({ text: title, font: 'Lato', bold: true, size: 22, color: isUrgent ? C.signal_amber : C.near_black }),
        new TextRun({ text: revisitDate ? `  |  Revisit: ${revisitDate}${daysTo !== null ? ` (${daysTo}d)` : ''}` : '', font: 'Lato', size: 18, color: C.muted }),
      ]}));
      if (context && context !== 'null') els.push(bod(context, { color: C.muted }));
      if (isUrgent) els.push(bod('Inaction today creates downstream risk. Make a call.', { italic: true, color: C.signal_amber }));
    });
  }

  // ── 8. WHAT HANNAH IS WATCHING ───────────────────────────────────────────
  const weakSignals = signalsWeek.filter(s => { const sc = parseInt(s[3]); return sc >= 4 && sc < 7; }).slice(0, 3);
  const entityDays = {};
  signalsWeek.forEach(([ts, entityId]) => {
    if (!entityId || entityId === 'null') return;
    const day = (ts || '').split('T')[0] || (ts || '').split(' ')[0];
    if (!entityDays[entityId]) entityDays[entityId] = new Set();
    entityDays[entityId].add(day);
  });
  const patterns = Object.entries(entityDays).filter(([,days]) => days.size >= 3)
    .map(([e, days]) => `${e} has appeared in signals on ${days.size} separate days this week. Elevated pattern worth tracking.`);

  if (weakSignals.length > 0 || patterns.length > 0) {
    els.push(secHead('8. What Hannah Is Watching'));
    els.push(hr());
    weakSignals.forEach(([ts, entityId, signalType, iuScore, summary]) => {
      // Use summary first word as label if entity_id is null
      const displayName = (entityId && entityId !== 'null')
        ? entityId
        : (summary ? summary.split(' ').slice(0, 3).join(' ') : 'Signal');
      const scoreLabel = iuScore ? `  Signal strength: ${iuScore}/10` : '';
      const typeLabel  = (signalType && signalType !== 'null') ? `  ${signalType}` : '';
      els.push(new Paragraph({ spacing: { before: 80, after: 40 }, children: [
        new TextRun({ text: displayName, font: 'Lato', bold: true, size: 22, color: C.near_black }),
        new TextRun({ text: `${typeLabel}${scoreLabel}`, font: 'Lato', size: 18, color: C.muted }),
      ]}));
      if (summary && summary !== 'null') els.push(bod(summary, { color: C.muted }));
    });
    patterns.forEach(p => els.push(mut(p)));
  }

  els.push(new Paragraph({ spacing: { before: 400 }, children: [] }));
  return els;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nVELA Morning Brief — ${TODAY_LABEL}`);
  if (DRY_RUN) console.log('MODE: DRY RUN\n');

  loadEnv();

  if (!dbReachable()) {
    const msg = 'Morning brief aborted — hannah.db unreachable. Check Mac Mini.';
    console.error(msg); sendTelegram(msg); process.exit(1);
  }

  console.log('Querying hannah.db...');
  const priorities     = sql(`SELECT rank, entity_id, objective, next_action, deadline, urgency, momentum FROM priorities ORDER BY rank ASC LIMIT 6`);
  const decisions      = sql(`SELECT title, decision, context, revisit_date, status FROM decisions WHERE status='active' ORDER BY revisit_date ASC`);
  const signalsToday   = sql(`SELECT ts, source, entity_id, signal_type, ium_score, summary FROM signals WHERE ts >= datetime('now','-24 hours') AND ium_score >= 7 ORDER BY ium_score DESC`);
  const signalsWeek    = sql(`SELECT ts, entity_id, signal_type, ium_score, summary FROM signals WHERE ts >= datetime('now','-7 days') ORDER BY ts DESC LIMIT 100`);
  const relationships  = sql(`SELECT name, last_contact, strategic_val, status, next_action FROM entities WHERE type='relationship' ORDER BY last_contact ASC`);
  const deals          = sql(`SELECT name, status, momentum, stage, next_action, last_updated, strategic_val FROM entities WHERE type IN ('deal','priority') ORDER BY momentum DESC`);
  const commitmentTracker = readWorkspaceFile('COMMITMENT_TRACKER.md');

  console.log(`Priorities: ${priorities.length} | Decisions: ${decisions.length} | Signals (today): ${signalsToday.length}`);

  console.log('Querying calendar and inbox...');
  const calendarEvents = queryCalendar();
  const inboxItems     = queryInbox();
  console.log(`Calendar (filtered): ${calendarEvents.length} | Inbox priority items: ${inboxItems.length}`);

  const data = { priorities, decisions, signalsToday, signalsWeek, relationships, deals, commitmentTracker, calendarEvents, inboxItems };

  console.log('Building document...');
  const reticleData = fs.existsSync(RETICLE) ? fs.readFileSync(RETICLE) : null;

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Lato', size: 22, color: C.near_black } } } },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1800, right: 1800, bottom: 1440, left: 1800 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, border: { bottom: { style: BorderStyle.SINGLE, size: 3, color: C.divider, space: 4 } }, spacing: { after: 200 }, children: [new TextRun({ text: `VELA MORNING BRIEF  \u00B7  ${TODAY_LABEL}`, font: 'Courier New', size: 14, color: C.muted })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, border: { top: { style: BorderStyle.SINGLE, size: 3, color: C.divider, space: 4 } }, spacing: { before: 200 }, children: [new TextRun({ text: 'VELA \u2014 PRIVATE COMMAND INFRASTRUCTURE', font: 'Courier New', size: 14, color: C.muted })] })] }) },
      children: [...buildCover(reticleData), ...buildContent(data)]
    }]
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const docxPath = path.join(OUT_DIR, `VELA_Morning_Brief_${TODAY_ISO}.docx`);
  fs.writeFileSync(docxPath, await Packer.toBuffer(doc));
  console.log(`DOCX: ${docxPath}`);

  console.log('Converting to PDF...');
  const pdfPath     = convertToPDF(docxPath);
  const deliverPath = pdfPath || docxPath;
  const deliverName = path.basename(deliverPath);
  console.log(`Delivery: ${deliverPath}`);

  console.log('Uploading to Drive...');
  const driveLink = await uploadToDrive(deliverPath, deliverName);
  console.log(`Drive: ${driveLink || 'upload failed'}`);

  console.log('Sending email...');
  sendEmail(deliverPath, driveLink);

  const p1 = priorities[0];

  // Compute commitment counts directly from raw tracker (due/overdue/atRisk are scoped in buildContent)
  const in48hTg = new Date(NOW.getTime() + 2 * 86400000);
  const tgDue = [], tgOverdue = [];
  (commitmentTracker || '').split(/^###/m).filter(b => b.trim()).forEach(block => {
    const byMatch     = block.match(/^By:\s*(.+)$/m);
    const statusMatch = block.match(/^Status:\s*(.+)$/m);
    if (!byMatch) return;
    const byRaw  = byMatch[1].trim();
    const status = statusMatch ? statusMatch[1].trim().toLowerCase() : '';
    if (status.includes('complete')) return;
    const isoM = byRaw.match(/(\d{4}-\d{2}-\d{2})/);
    const txtM = byRaw.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})/i);
    let d = null;
    if (isoM) d = new Date(isoM[1]);
    else if (txtM) d = new Date(`${txtM[1]} ${txtM[2]} ${NOW.getFullYear()}`);
    if (!d || byRaw.toLowerCase().includes('tbd') || byRaw.toLowerCase().includes('gated')) return;
    if (d < NOW) tgOverdue.push(byRaw);
    else if (d <= in48hTg) tgDue.push(byRaw);
  });

  // Build Telegram — one-liner per section, omit if no content
  const tgLines = [];
  tgLines.push(`*VELA Morning Brief - ${TODAY_LABEL}*`);
  tgLines.push('');

  // Today's Call
  if (p1) {
    const [,, obj, nxt, dl] = p1;
    tgLines.push(`*Call:* Advance ${obj}${dl ? ' by ' + dl : ''}. Next: ${nxt}.`);
  }

  // Command Layer — top 3 compressed
  if (priorities.length > 0) {
    const items = priorities.slice(0, 3).map(([rank,,obj,,,urg]) => `${rank}. ${obj} [${urg}]`).join(' / ');
    tgLines.push(`*Priorities:* ${items}`);
  }

  // Commitments
  const tgCommitParts = [];
  if (tgDue.length)     tgCommitParts.push(`${tgDue.length} due in 48h`);
  if (tgOverdue.length) tgCommitParts.push(`${tgOverdue.length} overdue`);
  if (tgCommitParts.length > 0) tgLines.push(`*Commitments:* ${tgCommitParts.join(', ')}`);

  // Calendar
  if (calendarEvents.length > 0) {
    const evts = calendarEvents.slice(0, 2).map(e => `${e.time} ${e.summary}`).join(', ');
    tgLines.push(`*Calendar:* ${evts}`);
  }

  // Inbox
  if (inboxItems.length > 0) {
    tgLines.push(`*Inbox:* ${inboxItems.length} priority item${inboxItems.length > 1 ? 's' : ''} — ${inboxItems[0].sender}`);
  }

  // Decisions
  if (decisions.length > 0) {
    const urgentDecs = decisions.filter(d => d[3] && (new Date(d[3]) - NOW) / 86400000 <= 3);
    if (urgentDecs.length > 0) {
      tgLines.push(`*Decisions:* ${urgentDecs[0][0]} — revisit ${urgentDecs[0][3]}`);
    } else {
      tgLines.push(`*Decisions:* ${decisions.length} open`);
    }
  }

  // Signals
  if (signalsToday.length > 0) {
    const sigEntity = (signalsToday[0][2] && signalsToday[0][2] !== 'null') ? signalsToday[0][2] : 'Signal';
    tgLines.push(`*Signal:* ${sigEntity} — strength ${signalsToday[0][4]}/10 — ${signalsToday[0][5]}`);
  }

  tgLines.push('');
  tgLines.push(driveLink ? `Full brief: ${driveLink}` : 'Drive upload failed - check email for attachment.');

  // Build final Telegram message — standard Markdown mode
  // Bold = *text*, no escaping needed for standard Markdown
  // Add blank line after each labeled section for spacing
  const tgMsgLines = [];
  tgMsgLines.push(`*VELA Morning Brief \u2014 ${TODAY_LABEL}*`);
  tgMsgLines.push('');

  tgLines.slice(2).forEach(line => {
    if (line === '') return; // skip blanks from tgLines — we control spacing here
    const labelMatch = line.match(/^\*(.+?):\*\s*(.*)$/);
    if (labelMatch) {
      // Strip any chars that break standard Markdown bold: underscores
      const labelClean   = labelMatch[1].replace(/_/g, '-');
      const contentClean = labelMatch[2].replace(/_/g, '-');
      tgMsgLines.push(`*${labelClean}:* ${contentClean}`);
      tgMsgLines.push('');
    } else {
      tgMsgLines.push(line.replace(/_/g, '-'));
    }
  });

  const tgMsg = tgMsgLines.join('\n');

  sendTelegram(tgMsg);
  console.log('\n--- TELEGRAM MESSAGE ---');
  console.log(tgMsg);
  console.log('------------------------\n');
  console.log('Done.');
}

main().catch(err => {
  const msg = `Morning brief failed: ${err.message}`;
  console.error(msg);
  loadEnv();
  sendTelegram(msg);
  process.exit(1);
});
