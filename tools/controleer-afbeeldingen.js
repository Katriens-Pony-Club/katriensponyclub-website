// Legt elke verwijzing naar images/ in de HTML naast de echte map.
//
// Waarom dit bestaat: Windows is niet hoofdlettergevoelig, Vercel wel. Een
// verwijzing naar Foto.jpeg terwijl het bestand Foto.JPEG heet, werkt lokaal
// prima en geeft online een 404. Zo'n fout zag niemand tot ze op Preview stond.
//
// Draaien vanuit de map van de site:   node tools/controleer-afbeeldingen.js
// Stopt met code 1 als er iets niet klopt, zodat dit in een controle past.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAP = 'images';

const bestanden = new Set(fs.readdirSync(path.join(ROOT, MAP)));
const htmls = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));

// Pakt images/... uit src=, href=, content= en uit absolute URLs.
const PATROON = /(?:src|href|content)\s*=\s*["']([^"']*\bimages\/[^"']+)["']/gi;

let fouten = 0;
let gecontroleerd = 0;

for (const html of htmls) {
  const inhoud = fs.readFileSync(path.join(ROOT, html), 'utf8');
  const regels = inhoud.split('\n');

  for (const [i, regel] of regels.entries()) {
    for (const m of regel.matchAll(PATROON)) {
      const verwijzing = m[1];
      // Alleen het stuk na images/ interesseert ons; absolute URL of niet.
      const naam = decodeURIComponent(verwijzing.split(`${MAP}/`).pop().split(/[?#]/)[0]);
      gecontroleerd++;

      if (bestanden.has(naam)) continue;

      fouten++;
      console.log(`FOUT  ${html}:${i + 1}  ->  ${MAP}/${naam}`);

      // Meedenken: is het alleen een kwestie van hoofdletters?
      const bijna = [...bestanden].find((b) => b.toLowerCase() === naam.toLowerCase());
      if (bijna) {
        console.log(`      bestaat wel als: ${MAP}/${bijna}  (alleen hoofdletters verschillen — werkt lokaal, faalt op Vercel)`);
      } else {
        const stam = naam.toLowerCase().replace(/[^a-z0-9]/g, '');
        const geleken = [...bestanden].filter((b) => {
          const bs = b.toLowerCase().replace(/[^a-z0-9]/g, '');
          return bs.includes(stam.slice(0, 8)) || stam.includes(bs.slice(0, 8));
        });
        if (geleken.length) console.log(`      bedoelde je: ${geleken.join(', ')}`);
      }
    }
  }
}

console.log(`\n${gecontroleerd} verwijzingen gecontroleerd in ${htmls.length} HTML-bestanden.`);

// Andersom is geen fout, maar wel goed om te weten.
const gebruikt = new Set();
for (const html of htmls) {
  const inhoud = fs.readFileSync(path.join(ROOT, html), 'utf8');
  for (const m of inhoud.matchAll(PATROON)) {
    gebruikt.add(decodeURIComponent(m[1].split(`${MAP}/`).pop().split(/[?#]/)[0]));
  }
}
const ongebruikt = [...bestanden].filter((b) => !gebruikt.has(b));
if (ongebruikt.length) {
  console.log(`\nNiet gebruikt in de HTML (geen fout, alleen ter info):`);
  for (const b of ongebruikt) console.log(`  ${MAP}/${b}`);
}

if (fouten) {
  console.log(`\n${fouten} kapotte verwijzing(en).`);
  process.exit(1);
}
console.log('\nAlle verwijzingen kloppen.');
