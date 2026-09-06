// Lokale test van api/formulier.js. Stubt fetch: er gaat NIETS naar Notion.
const handler = require('../api/formulier.js');

let notionCalls = [];
global.fetch = async (url, opts) => {
  notionCalls.push({ url, opts });
  if (global.__faalNotion) return { ok: false, status: 401, text: async () => '{"message":"unauthorized"}' };
  return { ok: true, status: 200, text: async () => '{}' };
};

function mockRes() {
  const r = { _status: 0, _body: null, _headers: {} };
  r.status = (s) => { r._status = s; return r; };
  r.json = (b) => { r._body = b; return r; };
  r.setHeader = (k, v) => { r._headers[k] = v; };
  return r;
}

const geldig = () => ({
  formulier: 'aanmelding',
  naam_ouder: 'Marieke Peeters',
  email: 'marieke@example.be',
  telefoon: '0470 12 34 56',
  kinderen: 'Lotte, 7 jaar\nJonas, 5 jaar',
  interesse: 'Gewenning',
  ervaring: 'Nog nooit op een pony gezeten.',
  bericht: 'Liefst op woensdagnamiddag.',
  website: '',
  t: Date.now() - 30000,
});

let geslaagd = 0, gefaald = 0;

function meld(ok, naam, extra) {
  console.log(`${ok ? 'OK  ' : 'FOUT'}  ${naam}`);
  if (extra) console.log(`        ${extra}`);
  ok ? geslaagd++ : gefaald++;
}

async function draai(req) {
  notionCalls = [];
  const res = mockRes();
  await handler(req, res);
  return { res, rijen: notionCalls.length, payload: notionCalls[0] ? JSON.parse(notionCalls[0].opts.body) : null };
}

async function test(naam, req, verwacht) {
  const { res, rijen, payload } = await draai(req);
  const ok = res._status === verwacht.status && rijen === verwacht.rijen;
  meld(ok, naam, `status ${res._status} (verwacht ${verwacht.status}), notion-calls ${rijen} (verwacht ${verwacht.rijen})`
    + (res._body && res._body.fout ? `\n        melding: "${res._body.fout}"` : ''));
  return { res, rijen, payload };
}

function opmerking(payload) {
  // payload is null als er GEEN rij is weggeschreven. Dat is precies het geval
  // dat deze test moet betrappen, dus hier niet stukvallen maar een herkenbare
  // waarde teruggeven — anders stopt de hele run en zie je de rest niet meer.
  if (!payload) return '(GEEN RIJ WEGGESCHREVEN)';
  const p = payload.properties.Opmerkingen;
  if (!p) return null;
  return p.rich_text.length ? p.rich_text[0].text.content : '';
}

(async () => {
  process.env.NOTION_TOKEN = 'ntn_test_niet_echt';

  console.log('\n=== 1. geldige inzending ===');
  const goed = await test('geldige aanmelding -> rij', { method: 'POST', body: geldig() }, { status: 200, rijen: 1 });
  meld(opmerking(goed.payload) === null, 'gewone inzending krijgt GEEN systeemnotitie',
    `Opmerkingen: ${JSON.stringify(opmerking(goed.payload))}`);

  // Dit is de kern van correctie 1.
  const SUCCESBODY = JSON.stringify(goed.res._body);
  console.log(`\n        succes-body = ${SUCCESBODY}`);

  console.log('\n=== 2. honeypot: stil weggooien, ononderscheidbaar antwoord ===');
  const hp = await test('honeypot ingevuld -> 200, GEEN rij',
    { method: 'POST', body: { ...geldig(), website: 'http://spam.ru' } }, { status: 200, rijen: 0 });
  meld(JSON.stringify(hp.res._body) === SUCCESBODY,
    'honeypot-antwoord is BYTE-IDENTIEK aan succes',
    `honeypot: ${JSON.stringify(hp.res._body)}`);
  meld(hp.res._status === goed.res._status, 'honeypot-statuscode identiek aan succes',
    `${hp.res._status} vs ${goed.res._status}`);

  console.log('\n=== 3. tijdcontrole: één tabel, gestuurd door de waarde van t ===');
  // Opgezet naar aanleiding van vervolgopdracht 2. De vorige versie toetste
  // alleen t = nu - 300 ms. Dat is "snel", maar het is niet 0 en niet negatief,
  // en juist die twee zijn het interessante geval: de klok van de bezoeker
  // loopt niet gelijk met die van de server in Frankfurt, dus een t die van de
  // server uit in de toekomst ligt is doodgewoon.
  //
  // Elke rij toetst DRIE dingen: de statuscode, of er werkelijk een rij ontstaat,
  // en welke tekst er in Opmerkingen komt. Ontbreekt de rij, dan faalt de test —
  // een controle die alleen kijkt of er "iets" gebeurde, vangt een weglating niet.
  const SNEL = '[systeem] Snel ingevuld: minder dan 2 seconden na het laden van de pagina. Mogelijk automatisch ingediend.';
  const GEEN_TIJD = '[systeem] Geen invultijd meegestuurd. Mogelijk automatisch ingediend.';

  // t wordt PER GEVAL berekend, vlak voor de aanroep. Bij één `nu` bovenaan
  // schuift de looptijd van de lus zelf de grens over: -1999 ms werd dan
  // 2003 ms tegen de tijd dat de handler draaide, en de test viel om op zijn
  // eigen traagheid in plaats van op de code. Vandaar een functie.
  const tijdgevallen = [
    ['t = Date.now()          (0 ms verstreken)', () => Date.now(), SNEL],
    ['t = Date.now() - 10000  (10 s verstreken)', () => Date.now() - 10000, null],
    ['t weggelaten            (onmeetbaar)', () => undefined, GEEN_TIJD],
    ['t = Date.now() - 1500   (binnen de grens)', () => Date.now() - 1500, SNEL],
    ['t = Date.now() - 2500   (buiten de grens)', () => Date.now() - 2500, null],
    ['t = Date.now() + 5000   (klok loopt voor -> negatief)', () => Date.now() + 5000, SNEL],
    ['t = "onzin"             (onbruikbaar)', () => 'onzin', GEEN_TIJD],
    ['t = null                (Number(null) is 0!)', () => null, GEEN_TIJD],
    ['t = ""                  (Number("") is 0!)', () => '', GEEN_TIJD],
    ['t = 0', () => 0, GEEN_TIJD],
    ['t = false', () => false, GEEN_TIJD],
  ];

  for (const [naam, maakT, verwachteNotitie] of tijdgevallen) {
    const r = await draai({ method: 'POST', body: { ...geldig(), t: maakT() } });
    const gekregen = opmerking(r.payload);

    // 1. Er MOET een rij zijn. Dit is de assertie die een stille weglating vangt.
    meld(r.rijen === 1, `${naam} -> maakt een rij aan`, `rijen: ${r.rijen}`);

    // 2. De juiste notitie, of juist geen.
    if (verwachteNotitie === null) {
      meld(gekregen === null, `${naam} -> Opmerkingen onaangeroerd`, `kreeg: ${JSON.stringify(gekregen)}`);
    } else {
      meld(gekregen === verwachteNotitie, `${naam} -> juiste systeemnotitie`,
        `kreeg: ${JSON.stringify(gekregen)}`);
    }

    // 3. Altijd hetzelfde antwoord.
    meld(JSON.stringify(r.res._body) === SUCCESBODY, `${naam} -> antwoord identiek aan succes`);

    // 4. En de gegevens van de ouder staan er gewoon in.
    if (r.rijen === 1) {
      meld(r.payload.properties['Naam ouder'].rich_text[0].text.content === 'Marieke Peeters',
        `${naam} -> de gegevens van de ouder staan in de rij`);
    }
  }

  // De honeypot is de ENIGE tak die nog stil weggooit. Als iemand later een
  // tweede stille afwijzing toevoegt, moet deze test omvallen.
  console.log('\n--- de honeypot is de enige tak die niets wegschrijft ---');
  let zonderRij = 0;
  for (const [, maakT] of tijdgevallen) {
    const r = await draai({ method: 'POST', body: { ...geldig(), t: maakT(), website: '' } });
    if (r.rijen === 0) zonderRij++;
  }
  meld(zonderRij === 0, 'geen enkele waarde van t leidt tot een verdwenen inzending',
    `${zonderRij} van de ${tijdgevallen.length} gevallen maakte geen rij`);

  console.log('\n=== 4. verplichte velden ===');
  await test('naam leeg -> 400', { method: 'POST', body: { ...geldig(), naam_ouder: '  ' } }, { status: 400, rijen: 0 });
  await test('e-mail leeg -> 400', { method: 'POST', body: { ...geldig(), email: '' } }, { status: 400, rijen: 0 });
  await test('e-mail onzin -> 400', { method: 'POST', body: { ...geldig(), email: 'marieke apenstaart' } }, { status: 400, rijen: 0 });
  await test('kinderen leeg bij aanmelding -> 400', { method: 'POST', body: { ...geldig(), kinderen: '' } }, { status: 400, rijen: 0 });
  await test('kinderen leeg bij VRAAG -> mag wel',
    { method: 'POST', body: { ...geldig(), formulier: 'vraag', kinderen: '' } }, { status: 200, rijen: 1 });

  console.log('\n=== 5. de val is niet uit te vissen (twee-inzendingen-proef) ===');
  // De aanval uit de opdracht: dien twee keer in, één keer met een verdacht veld
  // gevuld, en kijk of het antwoord verschilt. Doe dat met GELDIGE en met
  // ONGELDIGE gegevens. Verschilt er iets, dan is de val aangewezen.
  for (const [naam, basis] of [
    ['geldige gegevens', geldig()],
    ['ongeldig e-mailadres', { ...geldig(), email: 'geen adres' }],
    ['lege naam', { ...geldig(), naam_ouder: '' }],
    ['kinderen leeg', { ...geldig(), kinderen: '' }],
  ]) {
    const zonder = await draai({ method: 'POST', body: { ...basis, website: '' } });
    const met = await draai({ method: 'POST', body: { ...basis, website: 'http://spam.ru' } });
    const zelfde = zonder.res._status === met.res._status
      && JSON.stringify(zonder.res._body) === JSON.stringify(met.res._body);
    meld(zelfde, `${naam}: antwoord identiek met en zonder honeypot`,
      `zonder: ${zonder.res._status} ${JSON.stringify(zonder.res._body)}\n        met:    ${met.res._status} ${JSON.stringify(met.res._body)}`);
    meld(met.rijen === 0, `${naam}: honeypot schrijft nooit een rij weg`, `rijen: ${met.rijen}`);
  }

  console.log('\n=== 6. methode ===');
  await test('GET -> 405', { method: 'GET', body: {} }, { status: 405, rijen: 0 });

  console.log('\n=== 7. token weg / Notion weigert ===');
  delete process.env.NOTION_TOKEN;
  await test('geen NOTION_TOKEN -> nette 500', { method: 'POST', body: geldig() }, { status: 500, rijen: 0 });
  process.env.NOTION_TOKEN = 'ntn_test_niet_echt';

  global.__faalNotion = true;
  await test('Notion 401 -> nette 500', { method: 'POST', body: geldig() }, { status: 500, rijen: 1 });
  global.__faalNotion = false;

  console.log('\n=== 8. begrenzing ===');
  const g = await draai({ method: 'POST', body: { ...geldig(), bericht: 'x'.repeat(5000), naam_ouder: 'y'.repeat(500), interesse: 'Onzin' } });
  const p = g.payload.properties;
  meld(p.Bericht.rich_text[0].text.content.length === 2000, 'bericht afgekapt op 2000 tekens');
  meld(p['Naam ouder'].rich_text[0].text.content.length === 200, 'naam afgekapt op 200 tekens');
  meld(p.Interesse === undefined, 'onbekende interesse weggelaten');

  console.log(`\n===== ${geslaagd} geslaagd, ${gefaald} gefaald =====`);
  process.exit(gefaald ? 1 : 0);
})();
