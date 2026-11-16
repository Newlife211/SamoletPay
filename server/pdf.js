'use strict';
/**
 * Минимальный генератор PDF без зависимостей: встраивает TrueType-шрифт (DejaVu Sans,
 * свободная лицензия) как CIDFontType2 / Identity-H, поэтому кириллица отображается
 * и копируется (есть ToUnicode). Понимает разметку наших шаблонов: h2, h3, p, p.r, b, br, table.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const FONT_PATH = process.env.PDF_FONT || path.join(__dirname, 'fonts', 'DejaVuSans.ttf');
let FONT = null;

function parseTTF(buf) {
  const numTables = buf.readUInt16BE(4); const tables = {};
  for (let i = 0; i < numTables; i++) { const o = 12 + i * 16; tables[buf.toString('latin1', o, o + 4)] = { off: buf.readUInt32BE(o + 8), len: buf.readUInt32BE(o + 12) }; }
  const head = tables.head.off, unitsPerEm = buf.readUInt16BE(head + 18);
  const bbox = [buf.readInt16BE(head + 36), buf.readInt16BE(head + 38), buf.readInt16BE(head + 40), buf.readInt16BE(head + 42)];
  const hhea = tables.hhea.off, ascent = buf.readInt16BE(hhea + 4), descent = buf.readInt16BE(hhea + 6), nHM = buf.readUInt16BE(hhea + 34);
  const hmtx = tables.hmtx.off; const adv = (g) => buf.readUInt16BE(hmtx + 4 * Math.min(g, nHM - 1));
  // cmap: Windows Unicode BMP, формат 4
  const cm = tables.cmap.off; let sub = null;
  for (let i = 0, n = buf.readUInt16BE(cm + 2); i < n; i++) { const o = cm + 4 + i * 8; if (buf.readUInt16BE(o) === 3 && buf.readUInt16BE(o + 2) === 1) sub = cm + buf.readUInt32BE(o + 4); }
  if (sub === null || buf.readUInt16BE(sub) !== 4) throw new Error('Шрифт без cmap формата 4');
  const segX2 = buf.readUInt16BE(sub + 6), ends = sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
  const cache = new Map();
  function gid(cp) {
    if (cache.has(cp)) return cache.get(cp);
    let g = 0;
    for (let i = 0; i < segX2 / 2; i++) {
      const end = buf.readUInt16BE(ends + i * 2); if (cp > end) continue;
      const start = buf.readUInt16BE(starts + i * 2); if (cp < start) break;
      const delta = buf.readInt16BE(deltas + i * 2), ro = buf.readUInt16BE(ranges + i * 2);
      if (ro === 0) g = (cp + delta) & 0xffff;
      else { const ga = ranges + i * 2 + ro + (cp - start) * 2; const v = buf.readUInt16BE(ga); g = v ? (v + delta) & 0xffff : 0; }
      break;
    }
    cache.set(cp, g); return g;
  }
  return { buf, unitsPerEm, bbox, ascent, descent, gid, width: (cp) => adv(gid(cp)) * 1000 / unitsPerEm };
}
function font() { return FONT || (FONT = parseTTF(fs.readFileSync(FONT_PATH))); }

/* ---------- HTML шаблона → блоки ---------- */
const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
function runsOf(html) {
  const runs = []; let bold = false;
  for (const part of html.replace(/<br\s*\/?>/gi, '\n').split(/(<\/?b>)/i)) {
    if (/^<b>$/i.test(part)) bold = true; else if (/^<\/b>$/i.test(part)) bold = false;
    else { const t = decode(part.replace(/<[^>]+>/g, '')); if (t) runs.push({ t, bold }); }
  }
  return runs;
}
function blocksOf(html) {
  const out = [];
  const re = /<(h2|h3|p|table)([^>]*)>([\s\S]*?)<\/\1>/gi; let m;
  while ((m = re.exec(html))) {
    const [, tag, attrs, inner] = m;
    if (tag === 'table') {
      for (const row of inner.match(/<tr>[\s\S]*?<\/tr>/gi) || []) {
        const cells = (row.match(/<t[hd]>([\s\S]*?)<\/t[hd]>/gi) || []).map((c) => decode(c.replace(/<[^>]+>/g, '')));
        out.push({ kind: 'row', cells, bold: /<th>/i.test(row) });
      }
    } else out.push({ kind: tag, align: /class="r"/.test(attrs) ? 'right' : tag === 'h2' ? 'center' : 'left', runs: runsOf(inner) });
  }
  return out;
}

/* ---------- раскладка ---------- */
const PAGE_W = 595.28, PAGE_H = 841.89, M = 56, CW = PAGE_W - 2 * M;
function layout(blocks, F) {
  const pages = [[]]; let y = PAGE_H - M;
  const used = new Set();
  const textW = (t, size) => [...t].reduce((s, ch) => s + F.width(ch.codePointAt(0)), 0) * size / 1000;
  const newPage = () => { pages.push([]); y = PAGE_H - M; };
  const ensure = (h) => { if (y - h < M) newPage(); };
  function para(runs, size, align, gapAfter) {
    // слова с признаком жирности → строки
    const words = []; for (const r of runs) r.t.split(/(\n| )/).forEach((w) => { if (w === ' ') words.push({ sp: true, bold: r.bold }); else if (w === '\n') words.push({ nl: true }); else if (w) words.push({ t: w, bold: r.bold }); });
    const lines = []; let line = [], lw = 0; const spW = textW(' ', size);
    for (const w of words) {
      if (w.nl) { lines.push({ line, lw }); line = []; lw = 0; continue; }
      if (w.sp) { if (line.length) { line.push({ t: ' ', bold: w.bold }); lw += spW; } continue; }
      const ww = textW(w.t, size);
      if (lw + ww > CW && line.length) { while (line.length && line[line.length - 1].t === ' ') { line.pop(); lw -= spW; } lines.push({ line, lw }); line = []; lw = 0; }
      line.push(w); lw += ww;
    }
    if (line.length) lines.push({ line, lw });
    const lh = size * 1.4;
    for (const { line: l, lw: w } of lines) {
      ensure(lh); y -= lh;
      let x = align === 'right' ? M + CW - w : align === 'center' ? M + (CW - w) / 2 : M;
      for (const seg of l) { pages[pages.length - 1].push({ x, y, size, t: seg.t, bold: seg.bold }); for (const ch of seg.t) used.add(ch.codePointAt(0)); x += textW(seg.t, size); }
    }
    y -= gapAfter;
  }
  for (const b of blocks) {
    if (b.kind === 'h2') para(b.runs.map((r) => ({ ...r, bold: true })), 12.5, 'center', 8);
    else if (b.kind === 'h3') { y -= 4; para(b.runs.map((r) => ({ ...r, bold: true })), 11, 'left', 3); }
    else if (b.kind === 'p') para(b.runs, 10, b.align, 5);
    else if (b.kind === 'row') {
      const lh = 15; ensure(lh); y -= lh;
      const [a, v] = b.cells; const size = 10;
      pages[pages.length - 1].push({ x: M + 6, y, size, t: a || '', bold: b.bold }, { x: M + CW - 6 - textW(v || '', size), y, size, t: v || '', bold: b.bold }, { line: [M, y - 4, M + CW, y - 4] });
      for (const ch of (a || '') + (v || '')) used.add(ch.codePointAt(0));
    } else if (b.kind === 'stamp') {
      const h = 58; ensure(h + 10); y -= 14;
      const w = (CW - 16) / 2;
      b.items.forEach((s, i) => {
        const x = M + i * (w + 16);
        pages[pages.length - 1].push({ rect: [x, y - h, w, h], color: s.ok ? [0.06, 0.46, 0.43] : [0.6, 0.6, 0.6], dash: !s.ok });
        s.lines.forEach((t, j) => { pages[pages.length - 1].push({ x: x + 10, y: y - 16 - j * 13, size: j === 0 ? 9.5 : 8.5, t, bold: j === 0, color: s.ok ? [0.06, 0.46, 0.43] : [0.45, 0.45, 0.45] }); for (const ch of t) used.add(ch.codePointAt(0)); });
      });
      y -= h + 6;
    } else if (b.kind === 'small') { para([{ t: b.t, bold: false }], 7.5, 'left', 2); }
  }
  return { pages, used };
}

/* ---------- сборка PDF ---------- */
function build(blocks, { title = 'Документ' } = {}) {
  const F = font();
  const { pages, used } = layout(blocks, F);
  const footer = (pi) => `${title} · стр. ${pi + 1} из ${pages.length}`;
  pages.forEach((_, pi) => { for (const ch of footer(pi)) used.add(ch.codePointAt(0)); });
  const hex = (n) => n.toString(16).padStart(4, '0');
  const enc = (t) => [...t].map((ch) => hex(F.gid(ch.codePointAt(0)))).join('');
  const objs = []; const add = (s) => { objs.push(s); return objs.length; };
  const stream = (dict, data, compress = true) => { const d = compress ? zlib.deflateSync(data) : data; return Buffer.concat([Buffer.from(`<< ${dict} /Length ${d.length}${compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1'), d, Buffer.from('\nendstream', 'latin1')]); };

  // ширины использованных глифов + ToUnicode
  const gids = new Map(); for (const cp of used) gids.set(F.gid(cp), cp);
  const W = [...gids.keys()].sort((a, b) => a - b).map((g) => `${g} [${Math.round(F.width(gids.get(g)))}]`).join(' ');
  const cmapLines = [...gids.entries()].map(([g, cp]) => `<${hex(g)}> <${cp > 0xffff ? '003F' : hex(cp)}>`);
  const chunks = []; for (let i = 0; i < cmapLines.length; i += 100) chunks.push(`${Math.min(100, cmapLines.length - i)} beginbfchar\n${cmapLines.slice(i, i + 100).join('\n')}\nendbfchar`);
  const toUni = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n${chunks.join('\n')}\nendcmap CMapName currentdict /CMap defineresource pop end end`;

  const catalog = add(null), pagesObj = add(null);
  const fontFile = add(stream(`/Length1 ${F.buf.length}`, F.buf));
  const s = 1000 / F.unitsPerEm;
  const desc = add(`<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 32 /FontBBox [${F.bbox.map((v) => Math.round(v * s)).join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(F.ascent * s)} /Descent ${Math.round(F.descent * s)} /CapHeight 729 /StemV 80 /FontFile2 ${fontFile} 0 R >>`);
  const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /CIDToGIDMap /Identity /DW 600 /W [${W}] >>`);
  const tu = add(stream('', Buffer.from(toUni, 'latin1')));
  const fontObj = add(`<< /Type /Font /Subtype /Type0 /BaseFont /DejaVuSans /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tu} 0 R >>`);

  const pageIds = [];
  pages.forEach((items, pi) => {
    let c = '';
    for (const it of items) {
      if (it.line) { c += `0.75 G 0.5 w ${it.line[0].toFixed(2)} ${it.line[1].toFixed(2)} m ${it.line[2].toFixed(2)} ${it.line[3].toFixed(2)} l S\n`; continue; }
      if (it.rect) { const [r, g, b] = it.color; c += `${r} ${g} ${b} RG 1.2 w ${it.dash ? '[3 2] 0 d' : '[] 0 d'} ${it.rect.map((v) => v.toFixed(2)).join(' ')} re S [] 0 d\n`; continue; }
      const [r, g, b] = it.color || [0.07, 0.07, 0.07];
      // жирность имитируется обводкой глифов (режим 2), чтобы не встраивать второй шрифт
      c += `BT ${r} ${g} ${b} rg ${r} ${g} ${b} RG ${it.bold ? '2 Tr 0.35 w' : '0 Tr'} /F1 ${it.size} Tf ${it.x.toFixed(2)} ${it.y.toFixed(2)} Td <${enc(it.t)}> Tj ET\n`;
    }
    c += `BT 0.55 g 0 Tr /F1 7.5 Tf ${M} 28 Td <${enc(footer(pi))}> Tj ET\n`;
    const content = add(stream('', Buffer.from(c, 'latin1')));
    pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${content} 0 R >>`));
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`;
  const info = add(`<< /Producer (SamoletPay) /Title <FEFF${Buffer.from(title, 'utf16le').swap16().toString('hex')}> >>`);

  const parts = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')]; const offsets = []; let len = parts[0].length;
  objs.forEach((o, i) => { offsets.push(len); const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]); parts.push(b); len += b.length; });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${len}\n%%EOF`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

/** PDF документа со штампами подписей и контрольной суммой. */
function documentPdf(d, { companyName, personName, verifyUrl }) {
  const blocks = blocksOf(d.body);
  const fmt = (s) => s ? s.replace('T', ' ').slice(0, 16) + ' UTC' : '';
  const items = [
    { ok: !!d.company_signed_at, lines: [d.company_signed_at ? 'Подписано ПЭП · Сторона 1' : 'Сторона 1 — ожидает подписи', companyName + (d.company_signer ? ', ' + d.company_signer : ''), fmt(d.company_signed_at)] },
    { ok: !!d.contractor_signed_at, lines: [d.contractor_signed_at ? 'Подписано ПЭП · Сторона 2' : 'Сторона 2 — ожидает подписи', personName, fmt(d.contractor_signed_at)] },
  ];
  blocks.push({ kind: 'stamp', items: d.type === 'kedo_consent' ? items.slice(1) : items });
  if (d.sign_hash) { blocks.push({ kind: 'small', t: 'SHA-256: ' + d.sign_hash }); if (verifyUrl) blocks.push({ kind: 'small', t: 'Проверка подлинности: ' + verifyUrl }); }
  return build(blocks, { title: d.title });
}

module.exports = { build, documentPdf, blocksOf, parseTTF };
