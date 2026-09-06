// Aanmeldformulier katriensponyclub.be -> Notion 📥 Aanvraag
//
// Schrijft één rij weg. Leest niets. Geen afhankelijkheden: fetch zit in Node 18+.
// Grondslag: DEC-CLD-2026-191.
//
// Notion-API: versie 2026-03-11, parent via data_source_id (zie handover).

const NOTION_VERSION = '2026-03-11';
const AANVRAAG_DATA_SOURCE_ID = 'a3f35185-6904-438c-a36c-2b916320c8e9';

const MAX_KORT = 200;   // naam, e-mail, telefoon
const MAX_LANG = 2000;  // kinderen, ervaring, bericht
const MIN_INVULTIJD_MS = 2000;

const INTERESSES = ['Gewenning', 'Rijles', 'Kampje', 'Anders'];

// Notitie op een inzending die verdacht snel binnenkwam. Sinds de tweede ronde
// gooien we die NIET meer weg: een verloren echte aanmelding is duurder dan een
// botrij die Hans wegklikt. De meting blijft, maar als signaal, niet als oordeel.
const NOTITIE_SNEL = '[systeem] Snel ingevuld: minder dan 2 seconden na het laden van de pagina. Mogelijk automatisch ingediend.';
const NOTITIE_GEEN_TIJD = '[systeem] Geen invultijd meegestuurd. Mogelijk automatisch ingediend.';

// --- kleine hulpjes ---------------------------------------------------------

// HET antwoord bij succes. Eén bron, want de honeypot-tak geeft exact hetzelfde
// terug: zou dat ook maar één teken verschillen, dan kan een aanvaller met twee
// inzendingen uitvissen welk veld de val is en die voortaan leeg laten.
// Nieuwe functie, geen losse string: zo kan een tekstwijziging de takken niet
// uit elkaar laten lopen.
function succesAntwoord() {
  // Geen "Bedankt!" in de tekst: de kop boven deze zin zegt dat al.
  return { ok: true, bericht: 'We nemen zo snel mogelijk contact met je op om een proefles in te plannen.' };
}

function tekst(waarde, max) {
  if (typeof waarde !== 'string') return '';
  return waarde.trim().slice(0, max);
}

// Bewust ruim: een te strenge controle weigert echte adressen van ouders.
function ziternuitalsemail(waarde) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(waarde);
}

function richText(waarde) {
  return waarde ? { rich_text: [{ text: { content: waarde } }] } : { rich_text: [] };
}

function vandaag() {
  // Europe/Brussels, niet UTC: een inzending om 01:00 hoort bij vandaag, niet gisteren.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Brussels' });
}

function stuur(res, status, body) {
  res.status(status).json(body);
}

// --- handler ----------------------------------------------------------------

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return stuur(res, 405, { ok: false, fout: 'Methode niet toegestaan.' });
  }

  let data = req.body;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return stuur(res, 400, { ok: false, fout: 'Onleesbare aanvraag.' });
    }
  }
  if (!data || typeof data !== 'object') {
    return stuur(res, 400, { ok: false, fout: 'Onleesbare aanvraag.' });
  }

  // 1. Honeypot: alleen vaststellen, nog niet handelen. Dit veld vult een mens
  //    nooit in, dus een treffer is zeker genoeg om weg te gooien — maar dat
  //    gebeurt pas na de veldcontrole hieronder. Zou de val meteen een 200
  //    geven, dan kan een aanvaller met twee inzendingen (één keer met, één
  //    keer zonder een verdacht veld, allebei met een ongeldig e-mailadres) de
  //    val alsnog aanwijzen: 200 tegenover 400 verklapt hem. Door pas na de
  //    validatie te beslissen, is elk antwoord identiek aan dat van een gewone
  //    bezoeker die exact hetzelfde invulde.
  const isBot = tekst(data.website, MAX_KORT) !== '';

  // 2. Tijdcontrole: alleen signaleren, niet weggooien. Een ouder met een
  //    wachtwoordmanager die alles ineens invult, is echt en mag niet verdwijnen.
  const geladenOp = Number(data.t);
  let notitie = '';
  if (!Number.isFinite(geladenOp)) {
    notitie = NOTITIE_GEEN_TIJD;
  } else if (Date.now() - geladenOp < MIN_INVULTIJD_MS) {
    notitie = NOTITIE_SNEL;
  }

  // 3. Velden opschonen en begrenzen.
  const isAanmelding = data.formulier !== 'vraag';
  const naamOuder = tekst(data.naam_ouder, MAX_KORT);
  const email = tekst(data.email, MAX_KORT);
  const telefoon = tekst(data.telefoon, MAX_KORT);
  const kinderen = tekst(data.kinderen, MAX_LANG);
  const ervaring = tekst(data.ervaring, MAX_LANG);
  const bericht = tekst(data.bericht, MAX_LANG);

  const gekozen = tekst(data.interesse, MAX_KORT);
  const interesse = INTERESSES.includes(gekozen) ? gekozen : '';

  // 4. Verplichte velden.
  const ontbreekt = [];
  if (!naamOuder) ontbreekt.push('je naam');
  if (!email) ontbreekt.push('je e-mailadres');
  else if (!ziternuitalsemail(email)) ontbreekt.push('een geldig e-mailadres');
  if (isAanmelding && !kinderen) ontbreekt.push('de naam en leeftijd van je kind');

  if (ontbreekt.length) {
    return stuur(res, 400, {
      ok: false,
      fout: `Vul nog even ${ontbreekt.join(' en ')} in.`,
    });
  }

  // De velden zijn in orde. Nu pas de val dichtklappen: stil weggooien, met
  // exact het antwoord dat een echte bezoeker hier zou krijgen.
  if (isBot) {
    return stuur(res, 200, succesAntwoord());
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    console.error('NOTION_TOKEN ontbreekt in de omgeving.');
    return stuur(res, 500, {
      ok: false,
      fout: 'Er ging iets mis bij het versturen. Mail ons gerust op katriensponyclub@gmail.com — dan pikken we het daar op.',
    });
  }

  // 5. Rij samenstellen.
  const type = isAanmelding ? 'Aanmelding' : 'Vraag';
  const datum = vandaag();

  const properties = {
    'Naam': { title: [{ text: { content: `${datum} · ${type} · ${naamOuder}` } }] },
    'Type': { select: { name: type } },
    'Status': { select: { name: 'Nieuw' } },
    'Bron': { select: { name: 'Website' } },
    'Ontvangen op': { date: { start: datum } },
    'Naam ouder': richText(naamOuder),
    'E-mail': { email: email },
    'Telefoon': { phone_number: telefoon || null },
    'Kinderen': richText(kinderen),
    'Ervaring': richText(ervaring),
    'Bericht': richText(bericht),
  };

  if (interesse) {
    properties['Interesse'] = { select: { name: interesse } };
  }

  // Opmerkingen vullen we alleen als er iets te melden is, zodat het veld verder
  // van Hans blijft. De notitie komt bovenaan als er ooit toch al iets stond.
  if (notitie) {
    properties['Opmerkingen'] = richText(notitie);
  }

  // 6. Wegschrijven.
  try {
    const antwoord = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parent: { type: 'data_source_id', data_source_id: AANVRAAG_DATA_SOURCE_ID },
        properties,
      }),
    });

    if (!antwoord.ok) {
      // Alleen loggen, nooit naar de bezoeker: dit kan de tokenstatus prijsgeven.
      const details = await antwoord.text();
      console.error('Notion weigerde de rij:', antwoord.status, details);
      throw new Error(`Notion antwoordde ${antwoord.status}`);
    }
  } catch (fout) {
    console.error('Wegschrijven naar Notion mislukt:', fout);
    return stuur(res, 500, {
      ok: false,
      fout: 'Er ging iets mis bij het versturen. Mail ons gerust op katriensponyclub@gmail.com — dan pikken we het daar op.',
    });
  }

  return stuur(res, 200, succesAntwoord());
};
