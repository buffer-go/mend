// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------- Section 3: file lines ----------
interface FileParts { lines: string[]; br: string; final: boolean }
function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, final: fin };
}
function joinFile(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}
const leadWS = (s: string): string => { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; };
const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

// ---------- Section 5: matching ----------
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}
function findOccurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > file.length) return out;
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) if (!lineEq(file[i + k]!, o[k]!, tier)) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}
/** First tier (0,1,2 unless strict) at which O occurs, with its positions. */
function findTiered(file: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = findOccurrences(file, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}
interface NLine { text: string; ctx: boolean }
/** Build replacement lines for O matched at pos (tier). Context lines come from the file. */
function buildReplacement(file: string[], pos: number, o: string[], oCtx: boolean[], n: NLine[], tier: number): string[] {
  const oCtxIdx: number[] = [];
  o.forEach((_, i) => { if (oCtx[i]) oCtxIdx.push(i); });
  const p = o.length > 0 ? leadWS(o[0]!) : '';
  const f = pos < file.length ? leadWS(file[pos]!) : '';
  const out: string[] = [];
  let ctxCount = 0;
  for (const nl of n) {
    if (nl.ctx) {
      out.push(file[pos + oCtxIdx[ctxCount]!]!);
      ctxCount++;
    } else if (tier === 2 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(p)) {
      out.push(f + nl.text.slice(p.length));
    } else {
      out.push(nl.text);
    }
  }
  return out;
}
/** Apply O->N to lines (copy), returning new lines, or throwing Fail('no-match', path) with a custom chooser. */
function applyChunk(lines: string[], o: string[], oCtx: boolean[], n: NLine[], strict: boolean, path: string, choose: (pos: number[]) => number, finalBreak: boolean): { lines: string[]; final: boolean } {
  const found = findTiered(lines, o, strict);
  if (!found) throw new Fail('no-match', path);
  const pos = choose(found.pos);
  const rep = buildReplacement(lines, pos, o, oCtx, n, found.tier);
  const next = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + o.length)];
  const fin = pos + o.length === lines.length ? finalBreak : finalBreak;
  return { lines: next, final: fin };
}

// ---------- Section 6: unified diffs ----------
interface Hunk { a: number; o: string[]; oCtx: boolean[]; n: NLine[]; noeol: boolean }
interface USection { old: string | null; nw: string | null; create: boolean; del: boolean; hunks: Hunk[] }
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}
function parseHeaderPath(line: string): string | null {
  // line starts '--- ' or '+++ '
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  return stripAB(t);
}
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*|)$/;
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let headerHasPair = false;
  let i = 0;
  const startSection = (oldP: string | null, newP: string | null): void => {
    cur = { old: oldP, nw: newP, create: false, del: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
    headerHasPair = false;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader || headerHasPair) {
        startSection(parseHeaderPath(line), parseHeaderPath(lines[i + 1]!));
        headerHasPair = true;
        i += 2;
        continue;
      }
      // ---/+++ pair belonging to current section's header
      if (cur.old === null && cur.nw === null) { /* keep git paths if already set */ }
      const op = parseHeaderPath(line);
      const np = parseHeaderPath(lines[i + 1]!);
      // Only overwrite when the pair names something (null = /dev/null is meaningful)
      cur.old = op;
      cur.nw = np;
      headerHasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      // body
      const body: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\') || bl === '') { body.push(bl); i++; }
        else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const o: string[] = []; const oCtx: boolean[] = []; const n: NLine[] = [];
      let lastCtxPlusIdx = -1; // index into body of last context/+ line
      let noeol = false;
      for (let bi = 0; bi < body.length; bi++) {
        const bl = body[bi]!;
        if (bl.startsWith('\\')) {
          if (lastCtxPlusIdx >= 0 && bi === body.length - 1) noeol = true;
          // also: backslash after last ctx/+ anywhere at end of body
          continue;
        }
        if (bl.startsWith(' ')) { o.push(bl.slice(1)); oCtx.push(true); n.push({ text: bl.slice(1), ctx: true }); lastCtxPlusIdx = bi; }
        else if (bl.startsWith('-')) { o.push(bl.slice(1)); oCtx.push(false); lastCtxPlusIdx = -1; }
        else if (bl.startsWith('+')) { n.push({ text: bl.slice(1), ctx: false }); lastCtxPlusIdx = bi; }
        else if (bl === '') { o.push(''); oCtx.push(true); n.push({ text: '', ctx: true }); lastCtxPlusIdx = bi; }
      }
      // noeol only when the \ line is the last body line and follows a ctx/+ line
      if (!(body.length > 0 && body[body.length - 1]!.startsWith('\\'))) noeol = false;
      else {
        // find the body line before the trailing \ lines
        let j = body.length - 1;
        while (j >= 0 && body[j]!.startsWith('\\')) j--;
        noeol = j >= 0 && (body[j]!.startsWith(' ') || body[j]!.startsWith('+') || body[j] === '');
      }
      cur.hunks.push({ a, o, oCtx, n, noeol });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        // --- not followed by +++ inside a header
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) cur.old = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.nw = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
      // index / old mode / new mode / similarity / Index: / others ignored
      i++;
      continue;
    }
    // outside bodies / headers: ignored prose
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict));
}
function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.old;
    const newP = sec.nw;
    // safety before anything else (dev/null = no path)
    for (const p of [oldP, newP]) if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    const isCreate = sec.create || oldP === null;
    const isDelete = sec.del || newP === null;
    if (isCreate && !isDelete) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let noeol = false;
      for (const h of sec.hunks) {
        for (const nl of h.n) if (!nl.ctx) plus.push(nl.text);
        noeol = h.noeol;
      }
      // noeol only matters if the last hunk actually contributed + lines; if no hunks, empty file
      const content = plus.length === 0 ? '' : plus.join('\n') + (noeol ? '' : '\n');
      tree.now.set(np, content);
      return;
    }
    if (isDelete && !isCreate) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      // move
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const parts = splitFile(before);
      let lines = parts.lines;
      let fin = parts.final;
      let d = 0;
      for (const h of sec.hunks) {
        const res = applyUnifiedHunk(lines, fin, parts.br, h, d, strict, oldP);
        lines = res.lines; fin = res.final; d += h.n.length - h.o.length;
      }
      const content = joinFile(lines, parts.br, fin);
      tree.now.set(oldP, null);
      tree.now.set(newP, content);
      tree.moves.push([oldP, newP]);
      return;
    }
    // change of one path
    const p = (oldP ?? newP)!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const parts = splitFile(before);
    let lines = parts.lines;
    let fin = parts.final;
    let d = 0;
    for (const h of sec.hunks) {
      const res = applyUnifiedHunk(lines, fin, parts.br, h, d, strict, p);
      lines = res.lines; fin = res.final; d += h.n.length - h.o.length;
    }
    tree.now.set(p, joinFile(lines, parts.br, fin));
  };
}
function applyUnifiedHunk(lines: string[], fin: boolean, _br: string, h: Hunk, d: number, strict: boolean, path: string): { lines: string[]; final: boolean } {
  if (h.o.length === 0) {
    const at = Math.min(h.a + d, lines.length);
    const rep = h.n.map((x) => x.text);
    const next = [...lines.slice(0, at), ...rep, ...lines.slice(at)];
    let f = fin;
    if (at === lines.length && rep.length > 0) f = !h.noeol;
    return { lines: next, final: f };
  }
  const found = findTiered(lines, h.o, strict);
  if (!found) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  for (const pos of found.pos) {
    if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
  }
  const rep = buildReplacement(lines, best, h.o, h.oCtx, h.n, found.tier);
  const next = [...lines.slice(0, best), ...rep, ...lines.slice(best + h.o.length)];
  let f = fin;
  if (best + h.o.length === lines.length) f = !h.noeol;
  return { lines: next, final: f };
}

// ---------- Section 7: SEARCH/REPLACE ----------
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1; // index of previous >>>>>>> REPLACE
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const sIdx = i;
    // path: nearest non-blank, non-fence line before SEARCH, after prev block
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${sIdx + 1}`);
    // find ======= then >>>>>>> REPLACE
    let eq = -1; let rep = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (eq < 0) {
        if (lines[j]!.trimEnd() === '=======') eq = j;
      } else if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldL = lines.slice(sIdx + 1, eq);
    const newL = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldL, newL, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}
function srEdit(path: string, oldL: string[], newL: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldL.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newL.length === 0 ? '' : newL.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const parts = splitFile(before);
    const found = findTiered(parts.lines, oldL, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const nLines: NLine[] = newL.map((t) => ({ text: t, ctx: false }));
    const rep = buildReplacement(parts.lines, pos, oldL, oldL.map(() => false), nLines, found.tier);
    const next = [...parts.lines.slice(0, pos), ...rep, ...parts.lines.slice(pos + oldL.length)];
    tree.now.set(path, joinFile(next, parts.br, parts.final));
  };
}

// ---------- Section 8: V4A ----------
interface VChunk { anchor: string | null; o: string[]; oCtx: boolean[]; n: NLine[]; eof: boolean }
type VSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[]; lineNo: number };
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = (() => { for (let k = lines.length - 1; k >= 0; k--) if (!blank(lines[k]!)) return k; return -1; })();
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) { i++; continue; }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) { kind = 'add'; path = line.slice('*** Add File: '.length).trim(); }
    else if (line.startsWith('*** Delete File: ')) { kind = 'delete'; path = line.slice('*** Delete File: '.length).trim(); }
    else if (line.startsWith('*** Update File: ')) { kind = 'update'; path = line.slice('*** Update File: '.length).trim(); }
    else throw new Exit2(`error: parse ${i + 1}`);
    if (path === '') throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i + 1;
    i++;
    // collect body until next section start or End Patch
    const bodyStart = i;
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      if (l.trim() === '*** End Patch') break;
      i++;
    }
    const body = lines.slice(bodyStart, i);
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
    if (kind === 'add') {
      const fl: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const bl = body[k]!;
        if (bl.startsWith('+')) fl.push(bl.slice(1));
        else if (bl === '') fl.push('');
        else throw new Exit2(`error: parse ${bodyStart + k + 1}`);
      }
      sections.push({ kind: 'add', path, lines: fl });
    } else if (kind === 'delete') {
      for (let k = 0; k < body.length; k++) if (!blank(body[k]!)) throw new Exit2(`error: parse ${bodyStart + k + 1}`);
      sections.push({ kind: 'delete', path });
    } else {
      let moveTo: string | null = null;
      let bi = 0;
      if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
        moveTo = body[0]!.slice('*** Move to: '.length).trim();
        if (moveTo === '') throw new Exit2(`error: parse ${bodyStart + 1}`);
        bi = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let started = false;
      const close = (): void => { if (cur !== null) { chunks.push(cur); cur = null; } };
      for (; bi < body.length; bi++) {
        const bl = body[bi]!;
        const ln = bodyStart + bi + 1;
        if (bl.startsWith('@@')) {
          close();
          cur = { anchor: bl.slice(2).trim(), o: [], oCtx: [], n: [], eof: false };
          started = true;
          continue;
        }
        if (bl.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${ln}`);
          cur.eof = true;
          close();
          continue;
        }
        if (bl.startsWith('*** ')) throw new Exit2(`error: parse ${ln}`);
        if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl === '') {
          if (cur === null) {
            if (started) throw new Exit2(`error: parse ${ln}`);
            cur = { anchor: null, o: [], oCtx: [], n: [], eof: false };
            started = true;
          }
          if (bl.startsWith(' ')) { cur.o.push(bl.slice(1)); cur.oCtx.push(true); cur.n.push({ text: bl.slice(1), ctx: true }); }
          else if (bl.startsWith('-')) { cur.o.push(bl.slice(1)); cur.oCtx.push(false); }
          else if (bl.startsWith('+')) { cur.n.push({ text: bl.slice(1), ctx: false }); }
          else { cur.o.push(''); cur.oCtx.push(true); cur.n.push({ text: '', ctx: true }); }
          continue;
        }
        throw new Exit2(`error: parse ${ln}`);
      }
      close();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      sections.push({ kind: 'update', path, moveTo, chunks, lineNo: secLine });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}
function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (sec.kind === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    // update
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const parts = splitFile(before);
    let lines = parts.lines;
    let cursor = 0;
    for (const ch of sec.chunks) {
      // anchor search
      if (ch.anchor !== null && ch.anchor !== '') {
        const anchor = ch.anchor;
        let foundAt = -1;
        for (const t of (strict ? [0] : [0, 1, 2])) {
          for (let k = cursor; k < lines.length; k++) {
            if (lineEq(lines[k]!, anchor, t)) { foundAt = k; break; }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', sec.path);
        cursor = foundAt + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const rep = ch.n.map((x) => x.text);
        lines = [...lines.slice(0, at), ...rep, ...lines.slice(at)];
        cursor = at + rep.length;
        continue;
      }
      // find occurrence at/after cursor, first tier with one; eof: only ending at last line
      let chosen: { tier: number; pos: number } | null = null;
      for (const t of (strict ? [0] : [0, 1, 2])) {
        const pos = findOccurrences(lines, ch.o, t).filter((p) => p >= cursor && (!ch.eof || p + ch.o.length === lines.length));
        if (pos.length > 0) { chosen = { tier: t, pos: pos[0]! }; break; }
      }
      if (!chosen) throw new Fail('no-match', sec.path);
      const rep = buildReplacement(lines, chosen.pos, ch.o, ch.oCtx, ch.n, chosen.tier);
      lines = [...lines.slice(0, chosen.pos), ...rep, ...lines.slice(chosen.pos + ch.o.length)];
      cursor = chosen.pos + rep.length;
    }
    const content = joinFile(lines, parts.br, parts.final);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, content);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, content);
    }
  };
}


/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, in order: [old, new]. */
  moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Collapse move chains: origin -> final destination.
  const moveNext = new Map<string, string>();
  const movePrev = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    const origin = movePrev.get(o) ?? o;
    const oldNext = moveNext.get(origin);
    if (oldNext !== undefined) movePrev.delete(oldNext);
    moveNext.set(origin, n);
    movePrev.set(n, origin);
  }
  const rRows = new Map<string, string>(); // destination -> origin, for valid R rows
  const rOrigins = new Set<string>();
  for (const [o, n] of moveNext) {
    if (tree.original(o) !== null && tree.original(n) === null && tree.get(o) === null && tree.get(n) !== null) {
      rRows.set(n, o);
      rOrigins.add(o);
    }
  }
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOrigins.has(p)) continue; // origin covered by R
    if (rRows.has(p)) { rows.push(`R ${rRows.get(p)} -> ${p}`); continue; }
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  // R rows sort by <new>; re-sort rows by their sort key.
  const rowKey = (r: string): string => (r.startsWith('R ') ? r.slice(r.indexOf(' -> ') + 4) : r.slice(2));
  rows.sort((a, b) => byteCmp(rowKey(a), rowKey(b)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
