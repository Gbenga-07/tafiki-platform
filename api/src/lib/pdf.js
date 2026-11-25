// PDF documents attached to emails: a receipt for every money movement, and the Certificate of Stake.
// The certificate follows the same layout and wording as the one members download from their dashboard.
const path = require('path');
const PDFDocument = require('pdfkit');
const A = (f) => path.join(__dirname, '..', '..', 'assets', f);
const mm = (v) => v * 2.8346;
const G = '#1D4107', O = '#EC7C27', LI = '#6E9E3A', INK = '#16260C', MU = '#5C6A55', SOFT = '#F3F8EC', LINE = '#E0E8D5';

function make(opts) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, ...opts, info: { Producer: 'Tafiki', Creator: 'Tafiki', ...(opts.info || {}) } });
  doc.registerFont('R', A('fonts/FiraSans-Regular.ttf'));
  doc.registerFont('M', A('fonts/FiraSans-Medium.ttf'));
  doc.registerFont('S', A('fonts/FiraSans-SemiBold.ttf'));
  doc.registerFont('B', A('fonts/FiraSans-Bold.ttf'));
  doc.registerFont('H', A('fonts/Poppins-Bold.ttf'));
  doc.registerFont('HM', A('fonts/Poppins-Medium.ttf'));
  return doc;
}
const done = (doc) => new Promise((res, rej) => { const parts = []; doc.on('data', (c) => parts.push(c)); doc.on('end', () => res(Buffer.concat(parts))); doc.on('error', rej); doc.end(); });
const fmtDate = (d) => new Date(d || Date.now()).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' }) + ' WAT';
const day = (d) => new Date(d || Date.now()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' });
const plain = (s) => String(s == null ? '' : s).replace(/\*\*(.+?)\*\*/g, '$1');

/* ------------------------------------------------ Receipt (A4 portrait) ------------------------------------------------ */
// r: { title, number, date, rows:[[label,value]], total:[label,value], note, direction }, to: { name, email }, issuer: team name
async function receiptPdf(r, to = {}, issuer = 'Tafiki Finance') {
  const doc = make({ info: { Title: `${r.title} ${r.number}`, Subject: r.title, Author: issuer } });
  const W = doc.page.width, H = doc.page.height, X = 48, CW = W - 96;
  // header band
  doc.rect(0, 0, W, 112).fill(G);
  doc.rect(0, 112, W, 4).fill(O);
  doc.image(A('logo-light.png'), X, 38, { height: 36 });
  doc.font('H').fontSize(18).fillColor('#FFFFFF').text(String(r.title).toUpperCase(), X, 36, { width: CW, align: 'right', characterSpacing: 0.6 });
  doc.font('M').fontSize(10.5).fillColor('#BFD8A4').text(`No. ${r.number}`, X, 62, { width: CW, align: 'right' });
  doc.font('R').fontSize(9.5).fillColor('#BFD8A4').text(fmtDate(r.date), X, 78, { width: CW, align: 'right' });
  // parties
  let y = 146;
  const box = (x, w, label, lines) => {
    doc.roundedRect(x, y, w, 78, 8).fill(SOFT);
    doc.font('S').fontSize(7.5).fillColor(MU).text(label.toUpperCase(), x + 14, y + 13, { characterSpacing: 0.9 });
    doc.font('S').fontSize(12).fillColor(INK).text(lines[0] || '', x + 14, y + 29, { width: w - 28, ellipsis: true, lineBreak: false });
    doc.font('R').fontSize(9.5).fillColor(MU).text(lines.slice(1).filter(Boolean).join('\n'), x + 14, y + 47, { width: w - 28, lineGap: 1 });
  };
  const half = (CW - 14) / 2;
  const dir = r.direction === 'out' ? ['Paid by', 'Paid to'] : r.direction === 'goods' ? ['Supplied by', 'Received by'] : ['Received by', 'Received from'];
  box(X, half, dir[0], r.direction === 'out' ? ['Tafiki Technology', 'on behalf of FOODCORE Multipurpose Cooperative', 'support@tafiki.com'] : r.direction === 'goods' ? ['Tafiki Distribution Centre', 'for FOODCORE Multipurpose Cooperative', 'support@tafiki.com'] : ['Tafiki Technology', 'for FOODCORE Multipurpose Cooperative', 'support@tafiki.com']);
  box(X + half + 14, half, dir[1], [to.name || '', to.email || '']);
  // detail rows
  y += 104;
  doc.font('S').fontSize(8).fillColor(MU).text('DETAILS', X, y, { characterSpacing: 0.9 }); y += 16;
  doc.moveTo(X, y).lineTo(X + CW, y).lineWidth(1).strokeColor(LINE).stroke();
  const rows = (r.rows || []).filter((x) => x && x[1] !== undefined && x[1] !== null && x[1] !== '');
  for (const [k, v] of rows) {
    const vh = doc.font('M').fontSize(10.5).heightOfString(plain(v), { width: CW * 0.58 });
    const rh = Math.max(26, vh + 14);
    if (y + rh > H - 190) { doc.addPage(); y = 60; }
    doc.font('R').fontSize(10).fillColor(MU).text(plain(k), X, y + 8, { width: CW * 0.4 });
    doc.font('M').fontSize(10.5).fillColor(INK).text(plain(v), X + CW * 0.42, y + 7, { width: CW * 0.58, align: 'right' });
    y += rh; doc.moveTo(X, y).lineTo(X + CW, y).lineWidth(0.6).strokeColor(LINE).stroke();
  }
  // total
  if (r.total) {
    y += 12;
    doc.roundedRect(X, y, CW, 50, 8).fill(G);
    doc.font('S').fontSize(11).fillColor('#BFD8A4').text(String(r.total[0]).toUpperCase(), X + 18, y + 19, { characterSpacing: 0.8 });
    doc.font('B').fontSize(20).fillColor('#FFFFFF').text(plain(r.total[1]), X, y + 13, { width: CW - 18, align: 'right' });
    y += 50;
  }
  // stamp
  const stamp = r.direction === 'out' ? 'PAID' : r.direction === 'goods' ? 'RECEIVED' : r.total ? 'RECEIVED' : '';
  if (stamp) {
    doc.save().rotate(-12, { origin: [X + CW - 70, y + 52] });
    doc.roundedRect(X + CW - 130, y + 32, 120, 40, 6).lineWidth(2).strokeColor(LI).stroke();
    doc.font('H').fontSize(16).fillColor(LI).text(stamp, X + CW - 130, y + 42, { width: 120, align: 'center', characterSpacing: 2 });
    doc.restore();
  }
  if (r.note) { doc.font('R').fontSize(9.5).fillColor(MU).text(plain(r.note), X, y + 22, { width: CW - 150, lineGap: 2 }); }
  // footer
  const fy = H - 118;
  doc.moveTo(X, fy).lineTo(X + CW, fy).lineWidth(0.8).strokeColor(LINE).stroke();
  doc.image(A('logo.png'), X, fy + 16, { height: 22 });
  doc.font('S').fontSize(9.5).fillColor(G).text(issuer, X, fy + 44);
  doc.font('R').fontSize(8.5).fillColor(MU).text('tafiki.com · support@tafiki.com', X, fy + 58);
  doc.font('R').fontSize(7.8).fillColor(MU).text(`This ${String(r.title).toLowerCase()} was issued electronically by Tafiki and is valid without a signature. Quote ${r.number} in any question about it. FOODCORE is a product of FOODCORE Multipurpose Cooperative, licensed by the Lagos State Ministry of Commerce, Cooperatives, Trade and Investment.`, X + CW * 0.42, fy + 16, { width: CW * 0.58, lineGap: 1.5 });
  return done(doc);
}

/* -------------------------------------------- Certificate of Stake (A4 landscape) -------------------------------------------- */
// c: { certNo, holder, ref, units, unitPrice, packageName, area, city, state, targetPct, cycleDays, minHoldMonths, paidBy, payRef,
//      issuedAt, signedName, signedAt, verifyCode, confirmedInMart, totalUnits, packLine(n) }
async function certificatePdf(c) {
  const doc = make({ layout: 'landscape', info: { Title: `Certificate of Stake ${c.certNo}`, Subject: 'Certificate of Stake', Author: 'FOODCORE Multipurpose Cooperative' } });
  const W = doc.page.width, H = doc.page.height;
  const txt = (s, x, y, o = {}) => doc.font(o.f || (o.b ? 'B' : 'R')).fontSize(o.s || 11).fillColor(o.c || INK).text(String(s), x, y, { width: o.w, align: o.a || 'left', characterSpacing: o.cs || 0, lineBreak: o.lb !== false ? undefined : false, lineGap: o.lg || 0 });
  const ngn = (v) => '₦' + Math.round(v).toLocaleString('en-NG');
  doc.rect(0, 0, W, H).fill('#FFFFFF');
  doc.rect(mm(7), mm(7), W - mm(14), H - mm(14)).lineWidth(4.5).strokeColor(G).stroke();
  doc.rect(mm(10.5), mm(10.5), W - mm(21), H - mm(21)).lineWidth(1.1).strokeColor(O).stroke();
  doc.rect(mm(10.5), mm(10.5), W - mm(21), mm(25)).fill(G);
  doc.image(A('logo-light.png'), mm(19), mm(15.5), { width: mm(50) });
  txt('CERTIFICATE OF STAKE', mm(19), mm(17), { f: 'H', s: 16, c: '#FFFFFF', w: W - mm(38), a: 'right', cs: 0.5 });
  txt('No. ' + c.certNo, mm(19), mm(26), { f: 'M', s: 10, c: '#A5C783', w: W - mm(38), a: 'right' });
  const CX = mm(19), CWd = W - mm(38);
  txt('F O O D C O R E   S T O R E   U N I T S', CX, mm(46), { b: 1, s: 9, c: O, w: CWd, a: 'center' });
  txt('This certifies that', CX, mm(55), { s: 12.5, c: MU, w: CWd, a: 'center' });
  txt(c.holder, CX, mm(62), { f: 'H', s: 30, c: G, w: CWd, a: 'center' });
  doc.moveTo(W / 2 - mm(60), mm(79)).lineTo(W / 2 + mm(60), mm(79)).lineWidth(1.6).strokeColor(O).stroke();
  txt('is the registered holder of', CX, mm(83), { s: 12.5, c: MU, w: CWd, a: 'center' });
  txt(`${c.units} unit${c.units > 1 ? 's' : ''} in ${c.packageName}`, CX, mm(91), { f: 'H', s: 19, c: INK, w: CWd, a: 'center' });
  txt([c.area, c.city, c.state ? c.state + ' State' : ''].filter(Boolean).join(', ') + '  ·  ' + ngn(c.units * c.unitPrice) + ' of secured stock financing', CX, mm(102), { s: 11, c: MU, w: CWd, a: 'center' });
  const cells = [['Unit reference', c.ref], ['Capital', ngn(c.units * c.unitPrice)], ['Target return', `${(c.targetPct * 100).toFixed(2)}% per ${c.cycleDays} days`], ['Paid by', c.paidBy || '-'], ['Payment ref', c.payRef || '-'], ['Issued', day(c.issuedAt)], ['Minimum hold', `${c.minHoldMonths} months`]];
  const cw = CWd / cells.length;
  cells.forEach(([l, v], i) => { const x = CX + i * cw; doc.rect(x + 2, mm(112), cw - 4, mm(18)).fill(SOFT); txt(l.toUpperCase(), x + mm(4), mm(115.5), { b: 1, s: 6.5, c: MU, cs: 0.5, w: cw - mm(7) }); txt(String(v), x + mm(4), mm(121.5), { b: 1, s: String(v).length > 16 ? 8 : 9.5, c: INK, w: cw - mm(7), lb: false }); });
  // unit grid: this holder's units, other confirmed units, open units
  txt('Your units in this mart', CX, mm(137), { b: 1, s: 8, c: MU });
  const total = c.totalUnits || 40, mine = c.units, others = Math.max(0, (c.confirmedInMart || mine) - mine);
  for (let i = 0; i < total; i++) { const x = CX + (i % 8) * mm(5.4), y = mm(141) + Math.floor(i / 8) * mm(5.4); if (i < mine) doc.rect(x, y, mm(4.4), mm(4.4)).fill(O); else if (i < mine + others) doc.rect(x, y, mm(4.4), mm(4.4)).fill(G); else doc.rect(x, y, mm(4.4), mm(4.4)).lineWidth(0.8).strokeColor('#C5D2B5').stroke(); }
  const gy = mm(141) + Math.ceil(total / 8) * mm(5.4) + mm(2);
  if (c.packLine) { txt(`${mine} of ${total} units · each unit = ${c.packLine(1)}`, CX, gy, { s: 6.4, c: MU, w: mm(70) }); txt('Your units: ' + c.packLine(mine), CX, gy + mm(6), { s: 6.4, c: MU, b: 1, w: mm(70) }); }
  // signature blocks
  doc.image(A('foodcore-mark.png'), mm(95), mm(140), { width: mm(14) });
  [[mm(95), 'Hybrid Foods and Mart Ltd dba FOODCORE', 'Authorised signatory'], [mm(190), '[Trustee name]', 'Independent trustee for unit holders']].forEach(([x, a, b]) => { doc.moveTo(x, mm(160)).lineTo(x + mm(80), mm(160)).lineWidth(0.8).strokeColor(INK).stroke(); txt(a, x, mm(162), { b: 1, s: 9, c: INK }); txt(b, x, mm(167), { s: 8, c: MU }); });
  txt(`Issued electronically on Tafiki. Verification code ${c.verifyCode} · verify at tafiki.com/verify`, mm(95), mm(175), { b: 1, s: 8, c: G, w: W - mm(114) });
  txt(`Issued under the Unit Subscription and Security Agreement signed by ${c.signedName || c.holder} on ${day(c.signedAt || c.issuedAt)}. Capital is secured by a registered charge over the mart's stock and takings, held by an independent trustee, with recourse limited to that mart. Returns are targets, not guaranteed. Units issued by FOODCORE Multipurpose Cooperative, licensed by the Lagos State MCCTI.`, CX, mm(184), { s: 7, c: MU, w: CWd, lg: 1 });
  return done(doc);
}
module.exports = { receiptPdf, certificatePdf };
