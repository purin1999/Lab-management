// Fills the 様式2の2 Word template (one per waste type) with a tank's entries.
// A straight port of build_form_docx() from the old Flask app, so the files it
// makes match the ones the old system made.

export const FORM_ROWS = 36; // blank rows the printed sheet holds
export const FORM_TEMPLATES = { 'f-OH': 'templates/f-OH.docx', k: 'templates/k.docx' };

const CELL_RE = /<w:tc>[\s\S]*?<\/w:tc>/g;
const PARA_RE = /<w:p\b([^>]*)\/>/;
const ROW_RE = /<w:tr\b[\s\S]*?<\/w:tr>/g;
const RSID_RE = /\s(?:w14:paraId|w14:textId)="[^"]*"/g;

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Python's f"{x:g}": 0.05 -> '0.05', 2.0 -> '2', 0.00001 -> '1e-05'.
export function pyG(x) {
  if (x === 0) return '0';
  const [mant, expStr] = x.toExponential(5).split('e');
  const exp = Number(expStr);
  const trim = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  if (exp < -4 || exp >= 6) return `${trim(mant)}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  return trim(x.toFixed(Math.max(0, 5 - exp)));
}
export const formNum = (v) => (v === null || v === undefined || v === '' ? '' : pyG(Number(v)));

function formDate(at) {
  const [y, m, d] = at.slice(0, 10).split('-');
  return `${y}.${Number(m)}.${Number(d)}`;
}

function headerDate(iso) {
  if (!iso) return '　年　月　日';
  const [y, m, d] = iso.split('-');
  return `${y}年${Number(m)}月${Number(d)}日`;
}

// Put one string into each of the row's six cells, skipping empty ones.
function fillRow(rowXml, values) {
  let out = ''; let last = 0; let i = 0;
  for (const cell of rowXml.matchAll(CELL_RE)) {
    if (i >= values.length) break;
    const val = values[i++];
    out += rowXml.slice(last, cell.index);
    let xml = cell[0];
    if (val) {
      const run = `<w:r><w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr><w:t xml:space="preserve">${xmlEscape(val)}</w:t></w:r>`;
      xml = xml.replace(PARA_RE, (_, attrs) => `<w:p${attrs}>${run}</w:p>`);
    }
    out += xml;
    last = cell.index + cell[0].length;
  }
  return out + rowXml.slice(last);
}

// entries: oldest first, each { at, by, solvents: [{ name, L, solute, conc }] }
export function fillDocumentXml(doc, entries, { date = '', name = '', container = '' } = {}) {
  for (const [token, value] of [['{{DATE}}', headerDate(date)], ['{{NAME}}', name], ['{{CONTAINER}}', container]]) {
    doc = doc.split(token).join(xmlEscape(value));
  }
  const tStart = doc.indexOf('<w:tbl>');
  const tEnd = doc.indexOf('</w:tbl>', tStart) + '</w:tbl>'.length;
  const tbl = doc.slice(tStart, tEnd);
  const rows = tbl.match(ROW_RE);
  if (!rows || rows.length !== 3) throw new Error('Unexpected template layout (the table should have 3 rows)');
  const [headerRow, rawBlank, rawTotal] = rows;
  const preamble = tbl.slice(0, tbl.indexOf(headerRow));
  // Cloned rows must not reuse the template row's revision ids.
  const blankRow = rawBlank.replace(RSID_RE, '');

  const lines = []; let total = 0;
  for (const e of entries) {
    const d = formDate(e.at);
    e.solvents.forEach((s, i) => {
      total += s.L;
      lines.push([
        i === 0 ? d : '',     // 年・月・日
        s.name,               // 内容物名
        formNum(s.L),         // 量（l）
        formNum(s.conc),      // 濃度（g/l）
        i === 0 ? e.by : '',  // 投入者氏名
        s.solute || '',       // 備考
      ]);
    });
  }
  const body = lines.map((v) => fillRow(blankRow, v)).join('') + blankRow.repeat(Math.max(0, FORM_ROWS - lines.length));
  const totalRow = fillRow(rawTotal, ['', '', formNum(Math.round(total * 1e4) / 1e4), '', '', '']);
  return doc.slice(0, tStart) + preamble + headerRow + body + totalRow + '</w:tbl>' + doc.slice(tEnd);
}

// templateBytes: ArrayBuffer/Uint8Array of the .docx; JSZip: the JSZip constructor.
export async function buildFormDocx(JSZip, templateBytes, entries, header) {
  const zip = await JSZip.loadAsync(templateBytes);
  const doc = await zip.file('word/document.xml').async('string');
  zip.file('word/document.xml', fillDocumentXml(doc, entries, header));
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}
