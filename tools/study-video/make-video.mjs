#!/usr/bin/env node
/**
 * Athena study-video renderer.
 *
 * Renders a flashcard deck or a quiz set from the Athena API (or a local JSON
 * file) into a shareable, silent MP4: an intro cover, then per item a question
 * card followed by an answer/reveal card, then an outro. Styled with the
 * Athena dark theme (see src/theme/index.ts).
 *
 * Self-contained: frames are drawn with @napi-rs/canvas and encoded with the
 * ffmpeg binary bundled by ffmpeg-static - no system installs required.
 *
 * Install once:  npm install        (inside tools/study-video)
 * Examples:      node make-video.mjs --list
 *                node make-video.mjs --deck 1
 *                node make-video.mjs --json sample-quiz.json --format landscape
 */
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_API = process.env.ATHENA_API_URL || 'https://athena-api-w018.onrender.com';

// ── theme (src/theme/index.ts) ───────────────────────────────────────────────

const C = {
  background: '#0B1220',
  surface: '#111A2C',
  surfaceAlt: '#182338',
  border: '#233150',
  track: '#1C2942',
  text: '#F1F5F9',
  textSoft: '#CBD5E1',
  textMuted: '#94A3B8',
  onSurface: '#E2E8F0',
  primary: '#2DD4BF',
  primaryText: '#04241F',
  accent: '#38BDF8',
  white: '#FFFFFF',
};

const FORMATS = {
  portrait: { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
  square: { width: 1080, height: 1080 },
};

// ── fonts ────────────────────────────────────────────────────────────────────

const FONTS = { regular: null, semibold: null, bold: null };

function initFonts() {
  const win = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  const groups = {
    regular: [path.join(win, 'segoeui.ttf'), '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Helvetica.ttc'],
    semibold: [path.join(win, 'seguisb.ttf'), path.join(win, 'segoeuib.ttf'), '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
    bold: [path.join(win, 'segoeuib.ttf'), '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  };
  for (const [key, candidates] of Object.entries(groups)) {
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && GlobalFonts.registerFromPath(candidate, `Athena-${key}`)) {
          FONTS[key] = `Athena-${key}`;
          break;
        }
      } catch {
        // try the next candidate
      }
    }
  }
}
initFonts();

function fontFamily(weight) {
  if (weight >= 700) return FONTS.bold || FONTS.semibold || FONTS.regular;
  if (weight >= 600) return FONTS.semibold || FONTS.bold || FONTS.regular;
  return FONTS.regular || FONTS.bold || null;
}

function setFont(ctx, size, weight = 400) {
  const family = fontFamily(weight);
  ctx.font = `${Math.round(size)}px ${family ? `"${family}"` : 'sans-serif'}`;
}

// ── drawing helpers ──────────────────────────────────────────────────────────

function rgba(hex, alpha) {
  const value = parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function pad(W, H) {
  return Math.round(Math.min(W, H) * 0.075);
}

function pathRoundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Greedy word wrap using real text measurement (hard-breaks long words). */
function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split(/\s*\n\s*/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) {
        lines.push(line);
        line = '';
      }
      if (ctx.measureText(word).width <= maxWidth) {
        line = word;
        continue;
      }
      let rest = word;
      while (rest.length > 0) {
        let lo = 1;
        let hi = rest.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (ctx.measureText(rest.slice(0, mid)).width <= maxWidth) lo = mid;
          else hi = mid - 1;
        }
        if (lo >= rest.length) {
          line = rest;
          rest = '';
        } else {
          lines.push(rest.slice(0, lo));
          rest = rest.slice(lo);
        }
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function clampWithEllipsis(ctx, line, maxWidth) {
  if (ctx.measureText(`${line}\u2026`).width <= maxWidth) return `${line}\u2026`;
  let out = line;
  while (out.length > 1 && ctx.measureText(`${out}\u2026`).width > maxWidth) out = out.slice(0, -1);
  return `${out}\u2026`;
}

/** Fits text by shrinking the font until it fits the box; clamps as a fallback. */
function fitBlock(ctx, text, opts) {
  const {
    maxWidth,
    maxHeight,
    maxFont,
    minFont,
    lineHeight = 1.24,
    weight = 400,
    maxLines = Number.POSITIVE_INFINITY,
  } = opts;
  for (let size = maxFont; size >= minFont; size -= 2) {
    setFont(ctx, size, weight);
    const lines = wrapLines(ctx, text, maxWidth);
    if (lines.length <= maxLines && lines.length * size * lineHeight <= maxHeight) {
      return { size, lines, lineHeight, weight, height: lines.length * size * lineHeight, overflow: false };
    }
  }
  setFont(ctx, minFont, weight);
  let lines = wrapLines(ctx, text, maxWidth);
  let overflow = false;
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    overflow = true;
  }
  while (lines.length > 1 && lines.length * minFont * lineHeight > maxHeight) {
    lines.pop();
    overflow = true;
  }
  if (overflow && lines.length > 0) lines[lines.length - 1] = clampWithEllipsis(ctx, lines[lines.length - 1], maxWidth);
  return { size: minFont, lines, lineHeight, weight, height: lines.length * minFont * lineHeight, overflow };
}

/** Fits text at one fixed font size, clamping to maxLines with an ellipsis. */
function fitBlockAt(ctx, text, opts) {
  const { size, maxWidth, maxLines = 2, lineHeight = 1.24, weight = 400 } = opts;
  setFont(ctx, size, weight);
  let lines = wrapLines(ctx, text, maxWidth);
  let overflow = false;
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    overflow = true;
  }
  if (overflow && lines.length > 0) lines[lines.length - 1] = clampWithEllipsis(ctx, lines[lines.length - 1], maxWidth);
  return { size, lines, lineHeight, weight, height: lines.length * size * lineHeight, overflow };
}

function drawBlock(ctx, block, x, yTop, { fill, align = 'center' }) {
  ctx.textBaseline = 'top';
  setFont(ctx, block.size, block.weight ?? 400);
  ctx.fillStyle = fill;
  ctx.textAlign = align;
  const lh = block.size * block.lineHeight;
  block.lines.forEach((line, i) => ctx.fillText(line, x, yTop + i * lh));
  return block.lines.length * lh;
}

function drawSpacedText(ctx, text, x, yTop, { size, weight = 600, spacing = 0, fill, align = 'left' }) {
  ctx.textBaseline = 'top';
  setFont(ctx, size, weight);
  ctx.fillStyle = fill;
  const chars = Array.from(String(text));
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * Math.max(0, chars.length - 1);
  let cursor = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  ctx.textAlign = 'left';
  chars.forEach((ch, i) => {
    ctx.fillText(ch, cursor, yTop);
    cursor += widths[i] + spacing;
  });
  return total;
}

// ── shared chrome ────────────────────────────────────────────────────────────

const ICON_PATH = path.join(HERE, '..', '..', 'assets', 'images', 'icon.png');
let ICON = null;
try {
  if (fs.existsSync(ICON_PATH)) ICON = await loadImage(ICON_PATH);
} catch {
  ICON = null;
}

function drawIcon(ctx, x, y, size) {
  if (ICON) {
    ctx.save();
    pathRoundRect(ctx, x, y, size, size, size * 0.24);
    ctx.clip();
    ctx.drawImage(ICON, x, y, size, size);
    ctx.restore();
    return;
  }
  ctx.fillStyle = C.primary;
  pathRoundRect(ctx, x, y, size, size, size * 0.24);
  ctx.fill();
  ctx.textBaseline = 'top';
  setFont(ctx, size * 0.54, 700);
  ctx.fillStyle = C.primaryText;
  ctx.textAlign = 'center';
  ctx.fillText('A', x + size / 2, y + size * 0.22);
}

function drawBackground(ctx, W, H) {
  ctx.fillStyle = C.background;
  ctx.fillRect(0, 0, W, H);
  let glow = ctx.createRadialGradient(W / 2, -H * 0.12, 0, W / 2, -H * 0.12, H * 0.62);
  glow.addColorStop(0, rgba(C.primary, 0.18));
  glow.addColorStop(1, rgba(C.primary, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  glow = ctx.createRadialGradient(W * 0.08, H * 1.02, 0, W * 0.08, H * 1.02, H * 0.5);
  glow.addColorStop(0, rgba(C.accent, 0.1));
  glow.addColorStop(1, rgba(C.accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
}

function drawProgress(ctx, W, total, done) {
  const segments = Math.max(1, Math.min(total, 40));
  const shown = Math.max(0, Math.min(done, segments));
  const gap = 6;
  const h = 12;
  const segW = (W - gap * (segments - 1)) / segments;
  for (let i = 0; i < segments; i++) {
    ctx.fillStyle = i < shown ? C.primary : C.track;
    ctx.fillRect(Math.round(i * (segW + gap)), 0, Math.ceil(segW), h);
  }
}

function drawHeader(ctx, W, H, title, position, total) {
  const p = pad(W, H);
  const y = Math.round(H * 0.04);
  drawIcon(ctx, p, y, 54);
  drawSpacedText(ctx, 'ATHENA', p + 74, y + 11, { size: 30, weight: 700, spacing: 6, fill: C.textMuted });
  ctx.textBaseline = 'top';
  setFont(ctx, 30, 500);
  ctx.fillStyle = C.textMuted;
  ctx.textAlign = 'right';
  ctx.fillText(`${position} / ${total}`, W - p, y + 11);

  if (title) {
    let size = 34;
    setFont(ctx, size, 500);
    while (size > 22 && ctx.measureText(title).width > W - 2 * p - 40) {
      size -= 2;
      setFont(ctx, size, 500);
    }
    let shown = title;
    while (ctx.measureText(shown).width > W - 2 * p - 40 && shown.length > 4) shown = shown.slice(0, -1);
    if (shown !== title) shown = `${shown.slice(0, -1).trimEnd()}\u2026`;
    ctx.fillStyle = C.textMuted;
    ctx.textAlign = 'center';
    ctx.fillText(shown, W / 2, y + 52);
  }
}

// ── option rows (quiz) ───────────────────────────────────────────────────────

const LETTERS = 'ABCDEFGH';

function layoutOptionRows(ctx, options, size, textWidth, maxLines) {
  return options.map((text) => {
    const block = fitBlockAt(ctx, text, { size, maxWidth: textWidth, maxLines, lineHeight: 1.22, weight: 500 });
    return { block, h: Math.max(88, Math.round(block.height + 34)) };
  });
}

function rowsHeight(rows, gap = 18) {
  return rows.reduce((sum, row) => sum + row.h, 0) + gap * (rows.length - 1);
}

function drawOptionRows(ctx, { x, y, w, rows, state }) {
  const gap = 18;
  let cursor = y;
  rows.forEach((row, i) => {
    const mode = state(i);
    const fill = mode === 'correct' ? rgba(C.primary, 0.14) : C.surface;
    const stroke = mode === 'correct' ? C.primary : C.border;
    const textColor = mode === 'correct' ? C.text : mode === 'dim' ? C.textMuted : C.onSurface;
    const badgeFill = mode === 'correct' ? C.primary : C.surfaceAlt;
    const badgeText = mode === 'correct' ? C.primaryText : C.accent;

    pathRoundRect(ctx, x, cursor, w, row.h, 26);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = mode === 'correct' ? 3 : 2;
    ctx.stroke();

    const cy = cursor + row.h / 2;
    ctx.beginPath();
    ctx.arc(x + 62, cy, 29, 0, Math.PI * 2);
    ctx.fillStyle = badgeFill;
    ctx.fill();
    ctx.textBaseline = 'top';
    setFont(ctx, 30, 700);
    ctx.fillStyle = badgeText;
    ctx.textAlign = 'center';
    ctx.fillText(LETTERS[i] ?? String(i + 1), x + 62, cy - 18);

    drawBlock(ctx, row.block, x + 112, cy - row.block.height / 2, { fill: textColor, align: 'left' });
    cursor += row.h + gap;
  });
  return cursor - gap - y;
}

// ── screens ──────────────────────────────────────────────────────────────────

function coverK(W, H) {
  return Math.min(1, Math.max(0.7, Math.sqrt((W * H) / (1080 * 1920))));
}

function drawCover(ctx, W, H, content) {
  drawBackground(ctx, W, H);
  drawProgress(ctx, W, content.total, 0);
  const k = coverK(W, H);
  const cx = W / 2;
  const maxW = W - 2 * pad(W, H);
  const label = content.kind === 'deck' ? 'FLASHCARD DECK' : 'QUIZ SET';
  const title = fitBlock(ctx, content.title, {
    maxWidth: maxW, maxHeight: H * 0.24, maxFont: 96 * k, minFont: 48 * k,
    lineHeight: 1.16, weight: 700, maxLines: 4,
  });
  const subText = content.subtitle || (content.kind === 'deck' ? `${content.total} cards` : `${content.total} questions`);
  const sub = fitBlock(ctx, subText, {
    maxWidth: maxW - 60, maxHeight: H * 0.1, maxFont: 40 * k, minFont: 26 * k,
    lineHeight: 1.3, weight: 400, maxLines: 2,
  });
  const iconSize = 176 * k;
  const stackH = iconSize + 54 * k + 62 * k + 56 * k + 62 * k + title.height + 46 * k + sub.height;
  let y = Math.max(H * 0.1, (H - stackH) / 2 - H * 0.02);
  drawIcon(ctx, cx - iconSize / 2, y, iconSize);
  y += iconSize + 54 * k;
  drawSpacedText(ctx, 'ATHENA', cx, y, { size: 46 * k, weight: 700, spacing: 14 * k, fill: C.white, align: 'center' });
  y += 62 * k;
  drawSpacedText(ctx, label, cx, y, { size: 32 * k, weight: 700, spacing: 10 * k, fill: C.primary, align: 'center' });
  y += 56 * k;
  drawBlock(ctx, title, cx, y, { fill: C.text, align: 'center' });
  y += title.height + 46 * k;
  drawBlock(ctx, sub, cx, y, { fill: C.textMuted, align: 'center' });
  drawSpacedText(ctx, 'MADE WITH ATHENA', cx, H * 0.93, { size: 24, weight: 600, spacing: 8, fill: C.textMuted, align: 'center' });
}

function drawOutro(ctx, W, H, content) {
  drawBackground(ctx, W, H);
  drawProgress(ctx, W, content.total, content.total);
  const k = coverK(W, H);
  const cx = W / 2;
  const maxW = W - 2 * pad(W, H) - 80;
  const title = fitBlock(ctx, content.title, {
    maxWidth: maxW, maxHeight: H * 0.1, maxFont: 40 * k, minFont: 26 * k,
    lineHeight: 1.3, weight: 500, maxLines: 2,
  });
  const iconSize = 150 * k;
  const stackH = iconSize + 60 * k + 70 * k + 58 * k + title.height;
  let y = Math.max(H * 0.16, (H - stackH) / 2 - H * 0.03);
  drawIcon(ctx, cx - iconSize / 2, y, iconSize);
  y += iconSize + 60 * k;
  drawSpacedText(ctx, 'ATHENA', cx, y, { size: 66 * k, weight: 700, spacing: 16 * k, fill: C.primary, align: 'center' });
  y += 70 * k;
  drawSpacedText(ctx, 'STUDY SMARTER WITH ATHENA', cx, y, { size: 30 * k, weight: 600, spacing: 6 * k, fill: C.textMuted, align: 'center' });
  y += 58 * k;
  drawBlock(ctx, title, cx, y, { fill: C.textSoft, align: 'center' });
}

function drawDeckFront(ctx, W, H, { deckTitle, card, index, total }) {
  drawBackground(ctx, W, H);
  drawProgress(ctx, W, total, index);
  drawHeader(ctx, W, H, deckTitle, index + 1, total);
  const maxW = W - 2 * pad(W, H);
  const block = fitBlock(ctx, card.front, {
    maxWidth: maxW, maxHeight: H * 0.3, maxFont: 88, minFont: 44,
    lineHeight: 1.22, weight: 600, maxLines: 9,
  });
  const cy = H * 0.53;
  const yTop = Math.max(H * 0.24, cy - block.height / 2);
  const topic = card.topic ? String(card.topic) : 'FLASHCARD';
  let label = topic.toUpperCase();
  if (label.length > 36) label = `${label.slice(0, 36).trimEnd()}\u2026`;
  drawSpacedText(ctx, label, W / 2, yTop - 84, { size: 30, weight: 700, spacing: 8, fill: C.primary, align: 'center' });
  drawBlock(ctx, block, W / 2, yTop, { fill: C.text, align: 'center' });
  const hintY = Math.min(H * 0.885, yTop + block.height + 90);
  drawSpacedText(ctx, 'ANSWER COMING UP', W / 2, hintY, { size: 26, weight: 600, spacing: 6, fill: C.textMuted, align: 'center' });
}

function drawDeckBack(ctx, W, H, { deckTitle, card, index, total }) {
  drawBackground(ctx, W, H);
  drawProgress(ctx, W, total, index + 1);
  drawHeader(ctx, W, H, deckTitle, index + 1, total);
  const p = pad(W, H);
  const question = fitBlock(ctx, card.front, {
    maxWidth: W - 2 * p, maxHeight: H * 0.16, maxFont: 40, minFont: 26,
    lineHeight: 1.24, weight: 500, maxLines: 3,
  });
  const qY = Math.round(H * 0.14);
  drawBlock(ctx, question, W / 2, qY, { fill: C.textMuted, align: 'center' });

  const inner = 56;
  const labelH = 76;
  const cardW = W - 2 * p;
  const answer = fitBlock(ctx, card.back, {
    maxWidth: cardW - 2 * inner - 40, maxHeight: H * 0.44, maxFont: 62, minFont: 34,
    lineHeight: 1.24, weight: 600, maxLines: 11,
  });
  const cardH = inner * 2 + labelH + answer.height;
  let cardTop = qY + question.height + Math.round(H * 0.06);
  const slack = H * 0.9 - (cardTop + cardH);
  if (slack > 0) cardTop += Math.min(slack * 0.35, 90);
  const maxTop = H * 0.9 - cardH;
  if (cardTop > maxTop) cardTop = Math.max(qY + question.height + 40, maxTop);

  pathRoundRect(ctx, p, cardTop, cardW, cardH, 32);
  ctx.fillStyle = C.surface;
  ctx.fill();
  ctx.strokeStyle = C.border;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = C.primary;
  pathRoundRect(ctx, p + 20, cardTop + 26, 8, cardH - 52, 4);
  ctx.fill();
  drawSpacedText(ctx, 'ANSWER', W / 2, cardTop + inner, { size: 30, weight: 700, spacing: 8, fill: C.primary, align: 'center' });
  drawBlock(ctx, answer, W / 2, cardTop + inner + labelH, { fill: C.text, align: 'center' });
}

function drawQuizQuestion(ctx, W, H, { setTitle, item, index, total }) {
  drawBackground(ctx, W, H);
  drawProgress(ctx, W, total, index);
  drawHeader(ctx, W, H, setTitle, index + 1, total);
  const p = pad(W, H);
  const maxW = W - 2 * p;
  const question = fitBlock(ctx, item.question, {
    maxWidth: maxW, maxHeight: H * 0.28, maxFont: 64, minFont: 38,
    lineHeight: 1.22, weight: 600, maxLines: 7,
  });
  const qY = Math.round(H * 0.17);
  drawBlock(ctx, question, W / 2, qY, { fill: C.text, align: 'center' });

  let optTop = qY + question.height + Math.round(H * 0.055);
  let rows = null;
  for (let size = 44; ; size -= 2) {
    rows = layoutOptionRows(ctx, item.options, size, maxW - 150, 2);
    if (optTop + rowsHeight(rows) <= H * 0.9 || size <= 28) break;
  }
  const stackH = rowsHeight(rows);
  if (optTop + stackH < H * 0.9) optTop += Math.min((H * 0.9 - optTop - stackH) * 0.4, 90);
  drawOptionRows(ctx, { x: p, y: optTop, w: maxW, rows, state: () => 'idle' });
}

function drawQuizReveal(ctx, W, H, { setTitle, item, index, total }) {
  drawBackground(ctx, W, H);
  drawProgress(ctx, W, total, index + 1);
  drawHeader(ctx, W, H, setTitle, index + 1, total);
  const p = pad(W, H);
  const maxW = W - 2 * p;
  const question = fitBlock(ctx, item.question, {
    maxWidth: maxW, maxHeight: H * 0.16, maxFont: 38, minFont: 26,
    lineHeight: 1.22, weight: 500, maxLines: 3,
  });
  const qY = Math.round(H * 0.13);
  drawBlock(ctx, question, W / 2, qY, { fill: C.textMuted, align: 'center' });

  let labelY = qY + question.height + Math.round(H * 0.04);
  let optsTop = labelY + 70;

  const attempts = [
    { opt: 40, exp: 4 }, { opt: 38, exp: 3 }, { opt: 36, exp: 3 },
    { opt: 34, exp: 2 }, { opt: 32, exp: 2 }, { opt: 30, exp: 2 },
  ];
  let chosen = null;
  for (const attempt of attempts) {
    const rows = layoutOptionRows(ctx, item.options, attempt.opt, maxW - 150, 2);
    const stackH = rowsHeight(rows);
    const exp = item.explanation
      ? fitBlock(ctx, item.explanation, {
          maxWidth: maxW - 90, maxHeight: H * 0.22, maxFont: 34, minFont: 24,
          lineHeight: 1.3, weight: 400, maxLines: attempt.exp,
        })
      : null;
    const panelH = exp ? exp.height + 122 : 0;
    const totalH = stackH + (exp ? 44 + panelH : 0);
    chosen = { rows, stackH, exp, panelH, totalH };
    if (optsTop + totalH <= H * 0.945) break;
  }

  const slack = H * 0.94 - (optsTop + chosen.totalH);
  if (slack > 0) {
    const nudge = Math.min(slack * 0.35, 90);
    labelY += nudge;
    optsTop += nudge;
  }

  drawSpacedText(ctx, 'ANSWER', W / 2, labelY, { size: 28, weight: 700, spacing: 8, fill: C.primary, align: 'center' });
  drawOptionRows(ctx, { x: p, y: optsTop, w: maxW, rows: chosen.rows, state: (i) => (i === item.correctIndex ? 'correct' : 'dim') });

  if (chosen.exp) {
    const panelY = optsTop + chosen.stackH + 44;
    pathRoundRect(ctx, p, panelY, maxW, chosen.panelH, 26);
    ctx.fillStyle = C.surfaceAlt;
    ctx.fill();
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 2;
    ctx.stroke();
    drawSpacedText(ctx, 'WHY', p + 40, panelY + 36, { size: 26, weight: 700, spacing: 8, fill: C.accent });
    drawBlock(ctx, chosen.exp, p + 40, panelY + 88, { fill: C.textSoft, align: 'left' });
  }
}

function drawSegment(ctx, W, H, segment, content) {
  switch (segment.kind) {
    case 'cover':
      return drawCover(ctx, W, H, content);
    case 'outro':
      return drawOutro(ctx, W, H, content);
    case 'deck-front':
      return drawDeckFront(ctx, W, H, { deckTitle: content.title, card: content.cards[segment.index], index: segment.index, total: content.total });
    case 'deck-back':
      return drawDeckBack(ctx, W, H, { deckTitle: content.title, card: content.cards[segment.index], index: segment.index, total: content.total });
    case 'quiz-question':
      return drawQuizQuestion(ctx, W, H, { setTitle: content.title, item: content.questions[segment.index], index: segment.index, total: content.total });
    case 'quiz-reveal':
      return drawQuizReveal(ctx, W, H, { setTitle: content.title, item: content.questions[segment.index], index: segment.index, total: content.total });
    default:
      throw new Error(`Unknown segment kind: ${segment.kind}`);
  }
}

// ── content sources ──────────────────────────────────────────────────────────

async function apiFetch(api, route, { method = 'GET', token, body } = {}) {
  const res = await fetch(api + route, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error(`${method} ${route} failed (${res.status}): ${data?.error || res.statusText || 'unknown error'}`);
  return data;
}

async function signIn(args) {
  const api = String(args.api || DEFAULT_API).replace(/\/+$/, '');
  const email = String(args.email || process.env.ATHENA_EMAIL || 'demo@athena.app');
  const password = String(args.password || process.env.ATHENA_PASSWORD || 'athena123');
  log(`Sign in  ${api} as ${email}`);
  log('         (free Render API - the first call can take ~1 min to wake up)');
  const auth = await apiFetch(api, '/api/auth/signin', { method: 'POST', body: { email, password } });
  if (!auth?.token) throw new Error('Sign-in did not return a token.');
  return { api, token: auth.token };
}

function pickBySelector(list, selector, idKey, label) {
  if (list.length === 0) throw new Error(`No ${label} found on this account.`);
  if (selector === undefined || selector === true) return list[0];
  const raw = String(selector);
  const asIndex = Number(raw);
  if (Number.isInteger(asIndex) && String(asIndex) === raw) {
    if (asIndex >= 1 && asIndex <= list.length) return list[asIndex - 1];
    throw new Error(`${label} index ${raw} is out of range (1-${list.length}). Run --list to see the options.`);
  }
  const found = list.find((row) => row[idKey] === raw || row.id === raw);
  if (found) return found;
  throw new Error(`No ${label} matches "${raw}". Run --list to see the options.`);
}

function normalizeQuestion(row) {
  const options = Array.isArray(row.options)
    ? row.options.map((option) => (typeof option === 'string' ? option : String(option?.text ?? option?.label ?? ''))).map((option) => option.trim()).filter(Boolean)
    : [];
  let correctIndex = Number(row.correctIndex ?? row.correct_index ?? 0);
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) correctIndex = 0;
  return {
    question: String(row.question ?? '').trim(),
    options,
    correctIndex,
    explanation: String(row.explanation ?? '').trim(),
  };
}

async function deckFromApi(api, token, decks, selector) {
  const deck = pickBySelector(decks, selector, 'book_id', 'flashcard deck');
  const cards = await apiFetch(api, `/api/decks/${deck.book_id}/cards`, { token });
  const clean = (cards ?? [])
    .map((card) => ({
      front: String(card.front ?? '').trim(),
      back: String(card.back ?? '').trim(),
      topic: card.topic ? String(card.topic) : null,
    }))
    .filter((card) => card.front && card.back);
  log(`Source   deck "${deck.book_title}" - ${clean.length} cards, ${deck.due ?? 0} due`);
  return {
    kind: 'deck',
    title: String(deck.book_title || 'Flashcard deck'),
    subtitle: `${clean.length} cards - active recall review`,
    cards: clean,
    total: clean.length,
  };
}

async function setFromApi(api, token, sets, selector) {
  const row = pickBySelector(sets, selector, 'id', 'quiz set');
  const detail = await apiFetch(api, `/api/sets/${row.id}`, { token });
  const questions = (detail?.mcqs ?? []).map(normalizeQuestion).filter((q) => q.question && q.options.length >= 2);
  const title = String(detail?.set?.title || row.title || 'Quiz set');
  const book = row.chapter?.book?.title ? ` - ${row.chapter.book.title}` : '';
  log(`Source   quiz "${title}" - ${questions.length} questions${book}`);
  return {
    kind: 'quiz',
    title,
    subtitle: `${questions.length} questions${book}`,
    questions,
    total: questions.length,
  };
}

async function loadFromApi(args) {
  const { api, token } = await signIn(args);
  if (args.deck) {
    const decks = await apiFetch(api, '/api/decks', { token });
    return deckFromApi(api, token, decks ?? [], args.deck);
  }
  if (args.set) {
    const sets = await apiFetch(api, '/api/sets', { token });
    return setFromApi(api, token, sets ?? [], args.set);
  }
  const decks = await apiFetch(api, '/api/decks', { token });
  if (Array.isArray(decks) && decks.length > 0) {
    const content = await deckFromApi(api, token, decks, 1);
    log('         (no --deck/--set given; using the first deck)');
    return content;
  }
  const sets = await apiFetch(api, '/api/sets', { token });
  if (Array.isArray(sets) && sets.length > 0) {
    const content = await setFromApi(api, token, sets, 1);
    log('         (no --deck/--set given; using the first quiz set)');
    return content;
  }
  throw new Error('This account has no flashcard decks or quiz sets yet. Generate study material in the app first, or use --json with a local file.');
}

async function listSources(args) {
  const { api, token } = await signIn(args);
  const [decks, sets] = await Promise.all([
    apiFetch(api, '/api/decks', { token }),
    apiFetch(api, '/api/sets', { token }),
  ]);
  console.log('');
  console.log(`Flashcard decks (${(decks ?? []).length}):`);
  (decks ?? []).forEach((deck, i) => console.log(`  [${i + 1}] ${deck.book_title} - ${deck.total} cards, ${deck.due} due`));
  console.log(`Quiz sets (${(sets ?? []).length}):`);
  (sets ?? []).forEach((set, i) => {
    const book = set.chapter?.book?.title ? ` - ${set.chapter.book.title}` : '';
    console.log(`  [${i + 1}] ${set.title || '(untitled)'} - ${set.question_count} questions${book}`);
  });
  console.log('');
  console.log('Render one with:  node make-video.mjs --deck 1   (or --set 2, or --json file.json)');
}

async function loadFromJson(file) {
  const raw = await readFile(path.resolve(file), 'utf8');
  const data = JSON.parse(raw);
  if (Array.isArray(data.cards) && data.cards.length > 0) {
    const cards = data.cards
      .map((card) => ({
        front: String(card.front ?? card.question ?? '').trim(),
        back: String(card.back ?? card.answer ?? '').trim(),
        topic: card.topic ? String(card.topic) : null,
      }))
      .filter((card) => card.front && card.back);
    if (cards.length === 0) throw new Error('No usable cards in the JSON file (each card needs front and back).');
    return {
      kind: 'deck',
      title: String(data.title || 'Flashcard deck'),
      subtitle: String(data.subtitle || `${cards.length} cards`),
      cards,
      total: cards.length,
    };
  }
  const rows = Array.isArray(data.questions) ? data.questions : Array.isArray(data.mcqs) ? data.mcqs : [];
  const questions = rows.map(normalizeQuestion).filter((question) => question.question && question.options.length >= 2);
  if (questions.length === 0) {
    throw new Error('The JSON file needs a "cards" array (front/back) or a "questions" array (question/options/correctIndex).');
  }
  return {
    kind: 'quiz',
    title: String(data.title || 'Quiz set'),
    subtitle: String(data.subtitle || `${questions.length} questions`),
    questions,
    total: questions.length,
  };
}

// ── pipeline ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function readNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function slugify(text) {
  const slug = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'study';
}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function formatClock(seconds) {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function log(line) {
  console.log(line);
}

function printHelp() {
  console.log(`Athena study-video - render a flashcard deck or quiz set into a shareable MP4.

Usage
  node make-video.mjs --deck 1              render the first flashcard deck (live API)
  node make-video.mjs --set 2               render the second quiz set
  node make-video.mjs --json my-cards.json  render a local JSON file (offline)
  node make-video.mjs --list                list decks and quiz sets on the account

Content
  --deck <n|bookId>    flashcard deck (index from --list, or book id)
  --set <n|setId>      quiz set (index from --list, or set id)
  --json <file>        local file: { title, cards:[{front,back,topic}] }
                       or { title, questions:[{question,options,correctIndex,explanation}] }
  --limit <n|all>      max items per video (default 15, max 40)

Style
  --format portrait|landscape|square   default portrait (1080x1920)
  --fps <n>            default 30
  --intro <s>          cover duration (default 3)
  --hold <s>           question duration (default 4)
  --reveal <s>         answer duration (default 6.5)
  --outro <s>          outro duration (default 3)
  --out <file>         output path (default out/athena-<title>-<stamp>.mp4)
  --keep-frames        keep the PNG stills in .frames/

Account
  --api <url>          default $ATHENA_API_URL or ${DEFAULT_API}
  --email <address>    default demo@athena.app (or $ATHENA_EMAIL)
  --password <pw>      default the demo password (or $ATHENA_PASSWORD)`);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg-static is missing. Run "npm install" inside tools/study-video first.'));
      return;
    }
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderr.split('\n').slice(-8).join('\n')}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    return;
  }
  if (args.json === true) throw new Error('--json needs a file path, e.g. --json sample-deck.json');

  const formatName = String(args.format || 'portrait').toLowerCase();
  const format = FORMATS[formatName];
  if (!format) throw new Error(`Unknown --format "${args.format}" (use portrait, landscape or square).`);

  const fps = readNumber(args.fps, 30);
  const timings = {
    intro: readNumber(args.intro, 3),
    hold: readNumber(args.hold, 4),
    reveal: readNumber(args.reveal, 6.5),
    outro: readNumber(args.outro, 3),
  };
  const limit = args.limit === 'all' ? 40 : Math.min(40, Math.max(1, Math.round(readNumber(args.limit, 15))));

  let content;
  if (args.list) {
    await listSources(args);
    return;
  }
  if (typeof args.json === 'string') {
    content = await loadFromJson(args.json);
    log(`Source   ${content.kind} "${content.title}" from ${args.json}`);
  } else {
    content = await loadFromApi(args);
  }

  let items = content.kind === 'deck' ? content.cards : content.questions;
  if (items.length === 0) throw new Error('Nothing to render - the source has no usable items.');
  if (items.length > limit) {
    log(`Note     using the first ${limit} of ${items.length} items (pass --limit all for everything, max 40 per video)`);
    items = items.slice(0, limit);
    if (content.kind === 'deck') content.cards = items;
    else content.questions = items;
  }
  content.total = items.length;

  const segments = [{ name: '00-cover', kind: 'cover', seconds: timings.intro }];
  items.forEach((item, i) => {
    const n = String(i + 1).padStart(2, '0');
    segments.push({
      name: `${n}-a-question`,
      kind: content.kind === 'deck' ? 'deck-front' : 'quiz-question',
      index: i,
      seconds: timings.hold,
    });
    segments.push({
      name: `${n}-b-reveal`,
      kind: content.kind === 'deck' ? 'deck-back' : 'quiz-reveal',
      index: i,
      seconds: timings.reveal,
    });
  });
  segments.push({ name: '99-outro', kind: 'outro', seconds: timings.outro });

  const { width: W, height: H } = format;
  log(`Format   ${formatName} ${W}x${H} @ ${fps}fps`);

  const framesDir = path.join(HERE, '.frames');
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });
  log(`Frames   rendering ${segments.length} stills...`);
  for (const segment of segments) {
    segment.png = path.join(framesDir, `${segment.name}.png`);
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    drawSegment(ctx, W, H, segment, content);
    await writeFile(segment.png, canvas.toBuffer('image/png'));
  }

  const outPath = path.resolve(
    typeof args.out === 'string' ? args.out : path.join(HERE, 'out', `athena-${slugify(content.title)}-${stamp()}.mp4`),
  );
  await mkdir(path.dirname(outPath), { recursive: true });

  const concatPath = path.join(framesDir, 'frames.txt');
  const concatLines = [];
  for (const segment of segments) {
    concatLines.push(`file '${segment.png.replace(/\\/g, '/')}'`, `duration ${segment.seconds.toFixed(3)}`);
  }
  concatLines.push(`file '${segments[segments.length - 1].png.replace(/\\/g, '/')}'`);
  await writeFile(concatPath, concatLines.join('\n'), 'utf8');

  log(`Encode   ffmpeg -> ${path.basename(outPath)} (this can take a minute)...`);
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-vf', `fps=${fps},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-movflags', '+faststart', '-an',
    outPath,
  ]);

  const seconds = segments.reduce((sum, segment) => sum + segment.seconds, 0);
  const size = fs.statSync(outPath).size;
  if (!args['keep-frames']) await rm(framesDir, { recursive: true, force: true });
  log('');
  log(`Done     ${outPath}`);
  log(`         ${formatClock(seconds)} min - ${(size / 1048576).toFixed(1)} MB` + (args['keep-frames'] ? ` - frames kept in ${framesDir}` : ''));
}

main().catch((error) => {
  console.error('');
  console.error(`Error: ${error?.message || error}`);
  process.exitCode = 1;
});
