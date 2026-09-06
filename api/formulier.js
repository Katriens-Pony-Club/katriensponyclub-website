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

// --- kleine hulpjes ---------------------------------------------------------

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

  // 1. Honeypot. Stil slikken: een bot mag niet merken dat hij tegengehouden is.
  if (tekst(data.website, MAX_KORT) !== '') {
    return stuur(res, 200, { ok: true, bericht: 'Bedankt voor je bericht.' });
  }

  // 2. Tijdcontrole. Idem stil.
  const geladenOp = Number(data.t);
  if (!Number.isFinite(geladenOp) || Date.now() - geladenOp < MIN_INVULTIJD_MS) {
    return stuur(res, 200, { ok: true, bericht: 'Bedankt voor je bericht.' });
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

  return stuur(res, 200, {
    ok: true,
    bericht: 'Bedankt! We nemen zo snel mogelijk contact met je op.',
  });
};
