// Generates test files for the any-size upload pipeline:
//   node scripts/make-test-files.js pdf <outPath> [pages]
//   node scripts/make-test-files.js txt <outPath> [megabytes]
//
// The PDF needs pdfkit (`npm install --no-save pdfkit` in server/).

import { writeFile } from 'node:fs/promises';

const [, , mode, outPath, amountRaw] = process.argv;
if (!mode || !outPath) {
  console.error('usage: node scripts/make-test-files.js pdf|txt <outPath> [amount]');
  process.exit(1);
}

if (mode === 'txt') {
  const megabytes = Number(amountRaw) || 30;
  const line = 'The human heart pumps blood through the circulation with a steady rhythm and pressure. ';
  const linesPerMb = Math.floor((1024 * 1024) / line.length);
  const chunk = (line + '\n').repeat(linesPerMb);
  const handle = await import('node:fs');
  const stream = handle.createWriteStream(outPath);
  const sections = megabytes;
  await new Promise((resolve, reject) => {
    let written = 0;
    const writeNext = () => {
      if (written >= sections) {
        stream.end();
        resolve();
        return;
      }
      written += 1;
      if (!stream.write(chunk)) stream.once('drain', writeNext);
      else writeNext();
    };
    stream.on('error', reject);
    writeNext();
  });
  console.log(`wrote ${outPath} (~${sections} MB of text)`);
} else if (mode === 'pdf') {
  const pages = Number(amountRaw) || 600;
  const { default: PDFDocument } = await import('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  const chunks = [];
  doc.on('data', (piece) => chunks.push(piece));
  const finished = new Promise((resolve) => doc.on('end', resolve));

  const paragraph =
    'Cardiac physiology describes how the heart generates pressure, how the valves keep flow ' +
    'unidirectional, and how cardiac output is regulated by preload, afterload and contractility. ' +
    'This chapter reviews the essential mechanisms tested in medical examinations. ';

  for (let page = 1; page <= pages; page++) {
    if (page > 1) doc.addPage();
    if ((page - 1) % 40 === 0) {
      doc.fontSize(22).text(`Chapter ${Math.floor((page - 1) / 40) + 1} — Cardiac Science`, { align: 'left' });
      doc.moveDown(1);
    }
    doc.fontSize(12);
    for (let block = 0; block < 29; block++) {
      doc.text(paragraph, { align: 'justify' });
      doc.moveDown(0.35);
    }
    doc.fontSize(9).text(`page ${page}`, { align: 'center' });
  }
  doc.end();
  await finished;
  await writeFile(outPath, Buffer.concat(chunks));
  const { stat } = await import('node:fs/promises');
  const info = await stat(outPath);
  console.log(`wrote ${outPath} (${pages} pages, ${(info.size / 1024 / 1024).toFixed(1)} MB)`);
} else {
  console.error('mode must be pdf or txt');
  process.exit(1);
}
