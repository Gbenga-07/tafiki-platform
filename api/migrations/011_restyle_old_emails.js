// Emails sent before the current design keep their wording but get the current look in the console archive:
// the Tafiki logo header, greeting, the same paragraphs, any receipt as a details panel, signature and footer.
// Only the stored HTML changes; the text version, subject and wording stay exactly as they were sent.
const { layout } = require('../src/lib/mailer');

const looksLikeField = (l) => /^[A-Z][^:]{0,40}: .+/.test(l);
function parse(text) {
  const chunks = String(text || '').split(/\n\n+/).map((c) => c.trim()).filter(Boolean);
  let name = 'there'; const paragraphs = []; const blocks = []; let team;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (i === 0 && /^Hello .+,$/.test(c)) { name = c.slice(6, -1); continue; }
    if (/^Kind regards,?$/.test(c)) { team = chunks[i + 1]; break; }
    const lines = c.split('\n');
    if (lines.length > 1 && /^[A-Z0-9 ,.'-]+$/.test(lines[0]) && lines.slice(1).some(looksLikeField)) { // a receipt or statement block
      const title = lines[0].toLowerCase().replace(/(^|\s)\S/g, (x) => x.toUpperCase());
      const rows = lines.slice(1).filter(looksLikeField).map((l) => { const k = l.indexOf(': '); return [l.slice(0, k), l.slice(k + 2)]; });
      const note = lines.slice(1).filter((l) => !looksLikeField(l)).join(' ');
      blocks.push({ type: 'kv', title, rows });
      if (note) blocks.push({ type: 'note', tone: 'info', text: note });
      continue;
    }
    paragraphs.push(c.replace(/\*\*/g, ''));
  }
  return { name, paragraphs, blocks, team };
}

exports.up = async (knex) => {
  let last = '';
  for (;;) {
    const rows = await knex('emails').where('id', '>', last).orderBy('id').limit(500).select('id', 'subject', 'category', 'ref', 'audience', 'body_text', 'body_html');
    if (!rows.length) break;
    for (const e of rows) {
      last = e.id;
      if (String(e.body_html || '').includes('email-logo')) continue; // already in the current design
      const p = parse(e.body_text);
      if (!p.paragraphs.length && !p.blocks.length) continue;
      const team = /^Tafiki (Operations|Finance|Member Services|Security)$/.test(p.team || '') ? p.team : undefined;
      const html = layout({ subject: e.subject, category: e.category, ref: e.ref, audience: e.audience, name: p.name, paragraphs: p.paragraphs, blocks: p.blocks, team });
      await knex('emails').where({ id: e.id }).update({ body_html: html });
    }
  }
};
exports.down = async () => {};
