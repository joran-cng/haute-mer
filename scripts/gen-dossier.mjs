// Construit docs/dossier/dossier-technique.pdf depuis dossier-technique.md (+ USAGE-IA.md en annexe).
//   cd tests/e2e && npm ci && cd ../.. && node scripts/gen-dossier.mjs
// Rendu par Google Chrome (playwright-core), comme les tests de bout en bout.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const tooling = createRequire(new URL('tests/e2e/package.json', ROOT));
const playwright = await import(pathToFileURL(tooling.resolve('playwright-core')).href);
const chromium = playwright.chromium ?? playwright.default.chromium;
const markedModule = await import(pathToFileURL(tooling.resolve('marked')).href);
const marked = markedModule.marked ?? markedModule.default.marked;

const DIR = new URL('docs/dossier/', ROOT);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8').replace(/\r\n/g, '\n');

// En-tête YAML minimal : clés simples sur une ligne.
const source = read('docs/dossier/dossier-technique.md');
const [, front, body] = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
const meta = Object.fromEntries(front.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));

// Annexe : USAGE-IA.md, titres descendus de deux niveaux pour rester sous la section 10.
const usage = read('USAGE-IA.md').replace(/^# .*\n/, '').replace(/^(#{1,4}) /gm, '$1## ');
const markdown = body.replace('<!-- USAGE-IA -->', `<div class="annex">\n\n${usage}\n\n</div>`);

const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${meta.title}</title>
<base href="${DIR.href}">
<style>
  @page { size: A4; margin: 18mm 17mm 18mm 17mm; }
  :root { --ink: #16212b; --soft: #4c5b66; --line: #d5dce1; --accent: #b4621b; --tint: #f3f6f8; }
  html { font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; font-size: 9.6pt; line-height: 1.45; color: var(--ink); }
  body { margin: 0; }
  .cover { height: 250mm; display: flex; flex-direction: column; justify-content: center; page-break-after: always; }
  .cover .kicker { color: var(--accent); letter-spacing: .18em; text-transform: uppercase; font-size: 9pt; font-weight: 600; }
  .cover h1 { font-size: 34pt; margin: 6mm 0 3mm; border: 0; letter-spacing: -.01em; }
  .cover .sub { font-size: 13pt; color: var(--soft); max-width: 140mm; }
  .cover .meta { margin-top: 18mm; font-size: 10pt; color: var(--soft); border-top: 2px solid var(--accent); padding-top: 4mm; width: 110mm; }
  .toc { margin-top: 14mm; font-size: 10pt; columns: 2; column-gap: 10mm; width: 150mm; }
  .toc div { break-inside: avoid; padding: 1mm 0; border-bottom: 1px dotted var(--line); }
  h1 { font-size: 15pt; margin: 7mm 0 3mm; padding-bottom: 1.5mm; border-bottom: 2px solid var(--accent); break-after: avoid; }
  h1.page { break-before: page; margin-top: 0; }
  h2 { font-size: 11.5pt; margin: 5mm 0 2mm; break-after: avoid; }
  h3, h4 { font-size: 10pt; margin: 4mm 0 1.5mm; break-after: avoid; }
  p { margin: 0 0 2.4mm; text-align: justify; hyphens: auto; }
  ol, ul { margin: 0 0 2.4mm; padding-left: 6mm; }
  li { margin: .6mm 0; }
  table { width: 100%; border-collapse: collapse; margin: 2mm 0 4mm; font-size: 8.1pt; line-height: 1.32; break-inside: auto; }
  tr { break-inside: avoid; }
  th { text-align: left; background: var(--tint); font-weight: 600; }
  th, td { border: 1px solid var(--line); padding: 1.2mm 1.6mm; vertical-align: top; }
  code { font-family: Consolas, 'SF Mono', monospace; font-size: .9em; background: var(--tint); padding: 0 .6mm; border-radius: 1mm; }
  pre { background: var(--tint); border-left: 2px solid var(--accent); padding: 2.4mm 3mm; font-size: 7.6pt; line-height: 1.35; overflow: hidden; white-space: pre-wrap; break-inside: avoid; }
  pre code { background: none; padding: 0; }
  img { display: block; max-width: 100%; max-height: 78mm; margin: 2mm auto 1mm; border: 1px solid var(--line); }
  img + em, .caption { display: block; text-align: center; color: var(--soft); font-size: 8pt; margin-bottom: 4mm; }
  strong { font-weight: 650; }
  .annex { font-size: 8.4pt; }
  .annex table { font-size: 7.3pt; }
</style></head><body>
<section class="cover">
  <div class="kicker">Dossier technique</div>
  <h1>${meta.title.split(' — ')[0]}</h1>
  <div class="sub">${meta.subtitle}</div>
  <div class="meta">${meta.group}<br>${meta.date}</div>
  <div class="toc">${[...body.matchAll(/^# (.+)$/gm)].map((m) => `<div>${m[1]}</div>`).join('')}</div>
</section>
${marked.parse(markdown)}
</body></html>`;

// Chaque grande section qui suit une section longue commence sur une nouvelle page ; la liste est
// ajustée à la main pour éviter les titres orphelins en bas de page.
const pageBreaks = (process.env.DOSSIER_BREAKS ?? '8').split(',').map(Number);
const finalHtml = html.replace(/<h1>(\d+)\./g, (m, n) => (pageBreaks.includes(Number(n)) ? `<h1 class="page">${n}.` : m));

// Les légendes sont tirées du texte alternatif des images.
const withCaptions = finalHtml.replace(/<img src="([^"]+)" alt="([^"]*)">/g, '<img src="$1" alt="$2"><span class="caption">$2</span>');

const htmlFile = new URL('dossier-technique.html', DIR);
writeFileSync(htmlFile, withCaptions);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.goto(htmlFile.href, { waitUntil: 'networkidle' });
const pdf = new URL('dossier-technique.pdf', DIR);
await page.pdf({
  path: pdf.pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate: `<div style="width:100%;font-size:7pt;color:#6b7882;padding:0 17mm;display:flex;justify-content:space-between;font-family:Segoe UI,Arial,sans-serif">
    <span>${meta.title}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
  margin: { top: '16mm', bottom: '18mm', left: '17mm', right: '17mm' },
});
await browser.close();
console.log('docs/dossier/dossier-technique.pdf');
