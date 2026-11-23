// mend: a CLI that applies AI-written edits in four formats, per SPEC.md.
// Sections 1-4, 9 and 10 follow the kit's starter (MIT); sections 3, 5-8 are
// implemented here. Node 22, standard library only.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) { this.line = line; }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try { if (statSync(p).isFile()) v = readFileSync(p, 'utf8'); } catch { v = null; }
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
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${first + 1}`); }
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
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- section 3: a file's lines and its line break -------------------------

type FileLines = { br: string; final: boolean; lines: string[] };

function fileLines(text: string): FileLines {
  if (text === '') return { br: '\n', final: false, lines: [] };
  const at = text.indexOf('\n');
  const br = at > 0 && text[at - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { br, final, lines };
}

function fileText(f: FileLines, lines: string[], final = f.final): string {
  return lines.length === 0 ? '' : lines.join(f.br) + (final ? f.br : '');
}

// ---- section 5: finding and writing matched lines -------------------------

const stripEnd = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leading = (s: string): string => /^[ \t]*/.exec(s)![0];
function keyOf(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? stripEnd(s) : stripBoth(s);
}

type Found = { tier: number; positions: number[] };

function foundAt(O: string[], file: string[], from: number, strict: boolean, eofOnly = false): Found | null {
  if (O.length === 0 || O.length > file.length) return null;
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const keys = O.map((l) => keyOf(l, tier));
    const positions: number[] = [];
    for (let i = from; i + O.length <= file.length; i += 1) {
      if (eofOnly && i + O.length !== file.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j += 1) {
        if (keyOf(file[i + j]!, tier) !== keys[j]) { ok = false; break; }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** N written over the matched lines. Context lines come from the file; tier 2 re-indents the rest. */
function renderNew(O: string[], N: string[], ctx: boolean[], ctxO: number[], file: string[], at: number, tier: number): string[] {
  const F = file.length > 0 ? leading(file[Math.min(at, file.length - 1)]!) : '';
  const P = O.length > 0 ? leading(O[0]!) : '';
  return N.map((line, i) => {
    if (ctx[i]) return file[at + ctxO[i]!] ?? line;
    if (tier === 2 && !/^[ \t]*$/.test(line) && line.startsWith(P)) return F + line.slice(P.length);
    return line;
  });
}

// Moves are reported as one R line; filled by the unified and V4A readers.
const MOVES = new Map<string, string>();

// ---- section 6: unified diffs ---------------------------------------------

type Hunk = {
  A: number;
  O: string[];
  N: string[];
  ctx: boolean[];
  ctxO: number[];
  noFinal: boolean;
};
type USection = {
  old: string | null;
  new: string | null;
  mode: 'change' | 'create' | 'delete' | 'move';
  header: boolean;
  hunks: Hunk[];
};

function pathAfter(line: string, cut: number): string | null {
  let p = line.slice(cut).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function applyHunks(base: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = fileLines(base);
  let lines = f.lines.slice();
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const O = h.O;
    let at: number;
    let found: Found | null = null;
    if (O.length > 0) {
      found = foundAt(O, lines, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let best = found.positions[0]!;
      let dist = Math.abs(best - target);
      for (const p of found.positions) {
        const dd = Math.abs(p - target);
        if (dd < dist) { best = p; dist = dd; }
      }
      at = best;
    } else {
      at = Math.min(h.A + d, lines.length);
    }
    const endHere = at + O.length === lines.length;
    const rendered = renderNew(O, h.N, h.ctx, h.ctxO, lines, at, found === null ? 0 : found.tier);
    lines = [...lines.slice(0, at), ...rendered, ...lines.slice(at + O.length)];
    if (endHere) final = !h.noFinal;
    d += h.N.length - O.length;
  }
  return fileText(f, lines, final);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { old: m[1]!, new: m[2]!, mode: 'change', header: true, hunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = pathAfter(l, 4);
      const newP = pathAfter(lines[i + 1]!, 4);
      if (cur === null || !cur.header || cur.hunks.length > 0) {
        cur = { old: oldP, new: newP, mode: 'change', header: true, hunks: [] };
        sections.push(cur);
      } else {
        cur.old = oldP;
        cur.new = newP;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && cur !== null && cur.header && cur.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (cur !== null && cur.header && (l.startsWith('rename from ') || l.startsWith('rename to '))) {
      const p = l.slice(l.startsWith('rename from ') ? 12 : 11).trim();
      if (l.startsWith('rename from ')) cur.old = p; else cur.new = p;
      i += 1;
      continue;
    }
    if (cur !== null && cur.header && (l.startsWith('new file mode') || l.startsWith('deleted file mode'))) {
      if (l.startsWith('new file mode')) cur.new = cur.new ?? cur.old; else cur.old = cur.old ?? cur.new;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.header = false;
      const h: Hunk = { A: Number(m[1]), O: [], N: [], ctx: [], ctxO: [], noFinal: false };
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ') || (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) || b.startsWith('@@')) break;
        if (b.startsWith('\\')) { h.noFinal = true; i += 1; continue; }
        if (b.startsWith(' ')) {
          const t = b.slice(1);
          h.ctxO.push(h.O.length);
          h.O.push(t); h.N.push(t); h.ctx.push(true); i += 1; continue;
        }
        if (b.startsWith('-')) { h.O.push(b.slice(1)); i += 1; continue; }
        if (b.startsWith('+')) { h.N.push(b.slice(1)); h.ctx.push(false); h.ctxO.push(-1); i += 1; continue; }
        if (b === '') {
          h.ctxO.push(h.O.length);
          h.O.push(''); h.N.push(''); h.ctx.push(true); i += 1; continue;
        }
        break;
      }
      while (h.ctx.length > 0 && h.ctx[h.ctx.length - 1] === true && h.O[h.O.length - 1] === '' && h.N[h.N.length - 1] === '') {
        h.ctx.pop(); h.ctxO.pop(); h.O.pop(); h.N.pop();
      }
      cur.hunks.push(h);
      continue;
    }
    i += 1;
  }

  const out: Edit[] = [];
  for (const s of sections) {
    if (s.old === null) s.mode = 'create';
    else if (s.new === null) s.mode = 'delete';
    else if (s.old !== s.new) s.mode = 'move';
    const oldP = s.old ?? s.new ?? '';
    const newP = s.new ?? s.old ?? '';
    if (s.mode === 'create') {
      out.push((tree) => {
        if (!safe(newP) || newP === '') throw new Fail('unsafe', newP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const added: string[] = [];
        let noFinal = false;
        for (const h of s.hunks) {
          for (let k = 0; k < h.N.length; k += 1) if (!h.ctx[k]) added.push(h.N[k]!);
          if (h.N.some((_, k) => !h.ctx[k])) noFinal = h.noFinal;
        }
        const f: FileLines = { br: '\n', final: !noFinal, lines: added };
        tree.now.set(newP, fileText(f, added));
      });
      continue;
    }
    if (s.mode === 'delete') {
      out.push((tree) => {
        if (!safe(oldP) || oldP === '') throw new Fail('unsafe', oldP);
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
      });
      continue;
    }
    out.push((tree) => {
      if (!safe(oldP) || !safe(newP)) throw new Fail('unsafe', safe(oldP) ? newP : oldP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (s.mode === 'move') {
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
      }
      let result: string;
      try { result = applyHunks(before, s.hunks, strict, oldP); }
      catch (e) {
        if (e instanceof Fail) throw new Fail(e.code, s.mode === 'move' && e.code !== 'unsafe' ? oldP : e.path);
        throw e;
      }
      if (s.mode === 'move') {
        tree.now.set(oldP, null);
        tree.now.set(newP, result);
        MOVES.set(newP, oldP);
      } else {
        tree.now.set(oldP, result);
      }
    });
  }
  return out;
}

// ---- section 7: SEARCH/REPLACE blocks ------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const out: Edit[] = [];
  let i = 0;
  let blockStart = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchLine = i + 1;
    let p: string | null = null;
    for (let k = i - 1; k >= blockStart; k -= 1) {
      const t = lines[k]!.trim();
      if (t !== '' && !t.startsWith('```')) { p = t; break; }
    }
    if (p === null) p = prevPath;
    if (p === null) throw new Exit2(`error: parse ${searchLine}`);
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j += 1;
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (j >= lines.length || k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    const O = lines.slice(i + 1, j);
    const N = lines.slice(j + 1, k);
    const path = p;
    prevPath = p;
    out.push((tree) => {
      if (!safe(path) || path === '') throw new Fail('unsafe', path);
      if (O.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        const f: FileLines = { br: '\n', final: true, lines: N };
        tree.now.set(path, fileText(f, N));
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const f = fileLines(before);
      const found = foundAt(O, f.lines, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.positions.length > 1) throw new Fail('ambiguous', path);
      const at = found.positions[0]!;
      const rendered = renderNew(O, N, N.map(() => false), N.map(() => -1), f.lines, at, found.tier);
      const linesOut = [...f.lines.slice(0, at), ...rendered, ...f.lines.slice(at + O.length)];
      tree.now.set(path, fileText(f, linesOut));
    });
    i = k + 1;
    blockStart = i;
  }
  return out;
}

// ---- section 8: V4A patches -----------------------------------------------

type VChunk = {
  anchor: string;
  O: string[];
  N: string[];
  ctx: boolean[];
  ctxO: number[];
  eof: boolean;
};
type VSection = {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: VChunk[];
};

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    if (blank(l)) {
      // A blank line inside a section is an empty line of that section's file
      // (or an empty context line of its current chunk). Blank lines at the
      // end of a section, and between sections, are not.
      let n = i + 1;
      while (n < last && blank(lines[n]!)) n += 1;
      const next = lines[n] ?? '*** End Patch';
      const boundary = n >= last || next.startsWith('*** ') || next.startsWith('@@');
      if (!boundary && cur !== null) {
        if (cur.kind === 'add') cur.lines.push('');
        else if (cur.kind === 'update' && cur.chunks.length > 0) {
          const chunk = cur.chunks[cur.chunks.length - 1]!;
          chunk.ctxO.push(chunk.O.length);
          chunk.O.push(''); chunk.N.push(''); chunk.ctx.push(true);
        }
      }
      continue;
    }
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      const kind: VSection['kind'] = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const path = l.slice(l.indexOf(': ') + 2).trim();
      cur = { kind, path, lines: [], moveTo: null, chunks: [] };
      sections.push(cur);
      continue;
    }
    if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
    if (l.startsWith('*** Move to: ')) {
      if (cur.kind !== 'update' || cur.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
      cur.moveTo = l.slice(13).trim();
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (cur.kind !== 'update' || cur.chunks.length === 0) throw new Exit2(`error: parse ${i + 1}`);
      cur.chunks[cur.chunks.length - 1]!.eof = true;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur.kind !== 'update') throw new Exit2(`error: parse ${i + 1}`);
      cur.chunks.push({ anchor: l.slice(2).trim(), O: [], N: [], ctx: [], ctxO: [], eof: false });
      continue;
    }
    if (cur.kind === 'add') {
      if (!l.startsWith('+') && l !== '') throw new Exit2(`error: parse ${i + 1}`);
      cur.lines.push(l.startsWith('+') ? l.slice(1) : '');
      continue;
    }
    if (cur.kind === 'delete') throw new Exit2(`error: parse ${i + 1}`);
    let chunk = cur.chunks[cur.chunks.length - 1];
    if (chunk === undefined) {
      chunk = { anchor: '', O: [], N: [], ctx: [], ctxO: [], eof: false };
      cur.chunks.push(chunk);
    }
    if (l.startsWith(' ')) {
      const t = l.slice(1);
      chunk.ctxO.push(chunk.O.length);
      chunk.O.push(t); chunk.N.push(t); chunk.ctx.push(true);
    } else if (l.startsWith('-')) {
      chunk.O.push(l.slice(1));
    } else if (l.startsWith('+')) {
      chunk.N.push(l.slice(1)); chunk.ctx.push(false); chunk.ctxO.push(-1);
    } else if (l === '') {
      chunk.ctxO.push(chunk.O.length);
      chunk.O.push(''); chunk.N.push(''); chunk.ctx.push(true);
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  const out: Edit[] = [];
  for (const s of sections) {
    const path = s.path;
    if (!safe(path) || path === '') throw new Exit2('error: parse 1');
    out.push((tree) => {
      if (s.kind === 'add') {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        const f: FileLines = { br: '\n', final: true, lines: s.lines };
        tree.now.set(path, fileText(f, s.lines));
        return;
      }
      if (s.kind === 'delete') {
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
        return;
      }
      if (s.chunks.length === 0 && s.moveTo === null) throw new Fail('no-match', path);
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
      const f = fileLines(before);
      let cursor = 0;
      for (const ch of s.chunks) {
        if (ch.anchor !== '') {
          let at = -1;
          for (let tier = 0; tier <= (strict ? 0 : 2) && at < 0; tier += 1) {
            const key = keyOf(ch.anchor, tier);
            for (let k = cursor; k < f.lines.length; k += 1) {
              if (keyOf(f.lines[k]!, tier) === key) { at = k; break; }
            }
          }
          if (at < 0) throw new Fail('no-match', path);
          cursor = at + 1;
        }
        let at: number;
        let found: Found | null = null;
        if (ch.O.length > 0) {
          found = foundAt(ch.O, f.lines, cursor, strict, ch.eof);
          if (found === null) throw new Fail('no-match', path);
          at = found.positions[0]!;
        } else {
          at = ch.eof ? f.lines.length : cursor;
        }
        const rendered = renderNew(ch.O, ch.N, ch.ctx, ch.ctxO, f.lines, at, found === null ? 0 : found.tier);
        f.lines = [...f.lines.slice(0, at), ...rendered, ...f.lines.slice(at + ch.O.length)];
        cursor = at + rendered.length;
      }
      if (s.moveTo !== null) {
        tree.now.set(path, null);
        tree.now.set(s.moveTo, fileText(f, f.lines));
        MOVES.set(s.moveTo, path);
      } else {
        tree.now.set(path, fileText(f, f.lines));
      }
    });
  }
  return out;
}

function run(args: string[]): { code: number; out: string[] } {
  MOVES.clear();
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
  try { text = readFileSync(file ?? 0, 'utf8'); }
  catch { if (file !== null) return { code: 2, out: ['error: no-patch'] }; }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try { edit(tree); }
    catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { sort: string; line: string }[] = [];
  const movedFrom = new Set(MOVES.values());
  for (const p of tree.now.keys()) {
    if (MOVES.has(p) || (movedFrom.has(p) && tree.now.get(p) === null)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ sort: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const [newP, oldP] of MOVES) {
    const was = tree.original(oldP);
    const now = tree.now.get(newP);
    if (was === null || now === null || tree.original(newP) !== null) continue;
    rows.push({ sort: newP, line: `R ${oldP} -> ${newP}` });
    if (!check) {
      mkdirSync(dirname(newP), { recursive: true });
      writeFileSync(newP, now);
      rmSync(oldP, { force: true });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
