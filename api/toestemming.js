// Toestemmingsformulier katriensponyclub.be -> Notion 📝 Toestemmingsinzending
//
// Fase 4 van DEC-CLD-2026-191. Grondslag voor het ontwerp: DEC-CLD-2026-194.
//
// Twee acties achter één POST-endpoint:
//   opvragen  — token in, roepnaam van het kind uit. Zet Geopend op.
//   indienen  — schrijft één rij in de tussen-DB. Zet Ingevuld op.
//
// Waarom dit NIET in formulier.js zit: dat bestand is een schrijfpoort die
// niets teruggeeft over de inhoud van de databank. Hier moet wel iets naar
// buiten, namelijk de naam van het kind. Eén lek in die tak zou dan meteen
// de aanmeldpoort raken. Aparte functie, aparte tokencontrole.
//
// Waarom alles POST is, ook het opvragen: een token in een query string komt
// in de serverlogs, in de Referer-header en in de browsergeschiedenis terecht.
// De pagina houdt de token in de fragment (#) en stuurt hem in de body.
//
// Waarom de roepnaam van de Uitnodiging komt en niet van de Participant: dan
// zou deze integratie leesrecht op 🧒 Participant nodig hebben, en daar staan
// de gezondheidsnotities van alle kinderen. Een token die op een publieke
// website leeft, hoort daar niet bij te kunnen. Nu raakt hij alleen aan
// 📨 Uitnodiging en 📝 Toestemmingsinzending. Het veld Roepnaam kind wordt
// bij het aanmaken van de link ingevuld. Om dezelfde reden schrijft dit
// endpoint de Participant-relatie niet op de inzending: de identiteit hangt
// aan de Uitnodiging, en de relatie wordt bij de verwerking gelegd (PB-015).

const NOTION_VERSION = '2026-03-11';
const UITNODIGING_DATA_SOURCE_ID = '5026bbed-34a4-445a-9e1e-ab34ea82b7c1';
const INZENDING_DATA_SOURCE_ID = '47897cc7-7a3c-43c0-8a5b-3af91ffbc718';

const MAX_KORT = 200;
const MAX_LANG = 2000;
const MIN_INVULTIJD_MS = 2000;
const VROEGSTE_T = Date.UTC(2020, 0, 1);

// 32 bytes base64url is 43 tekens zonder opvulling. De controle staat hier om
// een reden die niets met veiligheid te maken heeft: ze houdt goedkoop
// gefuzz weg van de Notion-API, waar de club een deelbaar quotum heeft.
// De echte bescherming is de lengte van de token zelf.
const TOKEN_VORM = /^[A-Za-z0-9_-]{20,64}$/;

const JA_NEE = ['Ja', 'Nee'];
const HERKENBAARHEID = ['Ja', 'Nee', 'Alleen niet-herkenbaar'];

// De vijf beeldkanalen, plus Herkenbaarheid apart omdat die een derde
// antwoord kent. De sleutels zijn wat de pagina meestuurt, de waarden zijn
// de kolomnamen in Notion.
const BEELDVELDEN = {
  ouder: 'Beeld - Rechtstreeks aan ouder',
  whatsapp: 'Beeld - WhatsApp kampjes',
  sociaal: 'Beeld - Facebook en Instagram',
  website: 'Beeld - Website',
  drukwerk: 'Beeld - Drukwerk',
};

const GEZONDHEIDSVELDEN = {
  allergie: 'Allergieen',
  medicatie: 'Medicatie',
  zon: 'Zon en warmte',
  overig: 'Overige aandachtspunten',
};

const NOTITIE_SNEL = '[systeem] Snel ingevuld: minder dan 2 seconden na het laden van de pagina.';
const NOTITIE_GEEN_TIJD = '[systeem] Geen invultijd meegestuurd.';
const NOTITIE_HERINZENDING = '[systeem] Herinzending: er stond al een onbewerkte inzending voor deze link. Die is op Genegeerd gezet.';

const FOUT_ALGEMEEN = 'Er ging iets mis. Mail ons gerust op katriensponyclub@gmail.com, dan pikken we het daar op.';

// --- hulpjes ----------------------------------------------------------------

function tekst(waarde, max) {
  if (typeof waarde !== 'string') return '';
  return waarde.trim().slice(0, max);
}

function richText(waarde) {
  return waarde ? { rich_text: [{ text: { content: waarde } }] } : { rich_text: [] };
}

function keuze(waarde, toegelaten) {
  return toegelaten.includes(waarde) ? { select: { name: waarde } } : { select: null };
}

function vandaag() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Brussels' });
}

function stuur(res, status, body) {
  res.status(status).json(body);
}

async function notion(pad, opties = {}) {
  const antwoord = await fetch(`https://api.notion.com/v1${pad}`, {
    ...opties,
    headers: {
      'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
  });
  if (!antwoord.ok) {
    const details = await antwoord.text();
    // Nooit naar de bezoeker: dit kan de tokenstatus prijsgeven.
    console.error('Notion weigerde', pad, antwoord.status, details);
    throw new Error(`Notion antwoordde ${antwoord.status}`);
  }
  return antwoord.json();
}

// Zoekt de uitnodiging bij een token en beslist of ze bruikbaar is.
// Geeft altijd een object terug met ofwel { fout } ofwel { uitnodiging }.
async function zoekUitnodiging(token) {
  const resultaat = await notion(`/data_sources/${UITNODIGING_DATA_SOURCE_ID}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'Token', rich_text: { equals: token } },
      page_size: 2,
    }),
  });

  const rijen = resultaat.results || [];

  // Twee treffers op één token mag niet bestaan. Gebeurt het toch, dan is er
  // iets grondig mis en willen we geen van beide gebruiken.
  if (rijen.length !== 1) {
    if (rijen.length > 1) console.error('Meerdere uitnodigingen op dezelfde token.');
    return { fout: { status: 404, bericht: 'Deze link kennen we niet. Kijk na of je hem volledig gekopieerd hebt.' } };
  }

  const rij = rijen[0];
  const props = rij.properties;
  const doel = props['Doel']?.select?.name;
  const status = props['Status']?.select?.name;
  const vervalt = props['Vervalt op']?.date?.start;

  // Een kampvoorrangslink hoort hier niet thuis, ook al is de token geldig.
  if (doel !== 'Toestemming') {
    return { fout: { status: 404, bericht: 'Deze link kennen we niet. Kijk na of je hem volledig gekopieerd hebt.' } };
  }

  if (status === 'Ingetrokken') {
    return { fout: { status: 410, bericht: 'Deze link is ingetrokken. Vraag ons gerust om een nieuwe.' } };
  }

  // Datumvergelijking op tekst: beide zijn JJJJ-MM-DD, dus dat volstaat.
  // Een lege vervaldatum behandelen we als vervallen, niet als eeuwig geldig.
  if (!vervalt || vervalt < vandaag()) {
    return { fout: { status: 410, bericht: 'Deze link is vervallen. Vraag ons gerust om een nieuwe.' } };
  }

  const roepnaam = (props['Roepnaam kind']?.rich_text?.[0]?.plain_text || '').trim();
  if (!roepnaam) {
    // Een uitnodiging zonder roepnaam is een fout bij het aanmaken van de
    // link, niet bij de ouder. Die mag dus geen "link onbekend" te zien
    // krijgen, want dan gaat ze zoeken naar iets dat ze goed deed.
    console.error('Uitnodiging zonder Roepnaam kind:', rij.id);
    return { fout: { status: 500, bericht: FOUT_ALGEMEEN } };
  }

  // Leeg telt als Ouder. Zo blijft een uitnodiging die vóór dit veld bestond
  // gewoon werken, en is de veilige stand ook de stand bij vergeten invullen.
  const aanspreekvorm = props['Aanspreekvorm']?.select?.name === 'Deelnemer zelf' ? 'Deelnemer zelf' : 'Ouder';

  return { uitnodiging: { id: rij.id, roepnaam, aanspreekvorm, status, geopendOp: props['Geopend op']?.date?.start } };
}

// --- handler ----------------------------------------------------------------

module.exports = async function handler(req, res) {
  // Het tijdstip van binnenkomst, vastgelegd voor er ook maar iets gebeurt.
  //
  // Dit stond eerst verderop, na het opzoeken van de uitnodiging. Daardoor
  // telde de duur van die Notion-oproep mee in de invultijd van de ouder. Op
  // 07/09/2026 gemeten: een inzending die de browser op hetzelfde ogenblik
  // verstuurde kreeg geen notitie, terwijl het klokverschil met de server
  // maar 211 ms was. De Notion-oproep had er dus ruim anderhalve seconde
  // over gedaan, en de inzending zag eruit als traag ingevuld.
  //
  // Dat verliest geen gegevens, maar het maakt het signaal onbetrouwbaar op
  // precies de momenten dat de server traag is. Een botsignaal dat stilvalt
  // wanneer het druk wordt, is geen signaal.
  const ONTVANGEN_OP = Date.now();

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return stuur(res, 405, { ok: false, fout: 'Methode niet toegestaan.' });
  }

  let data = req.body;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  if (!data || typeof data !== 'object') {
    return stuur(res, 400, { ok: false, fout: 'Onleesbare aanvraag.' });
  }

  const token = tekst(data.token, 64);
  if (!TOKEN_VORM.test(token)) {
    return stuur(res, 400, { ok: false, fout: 'Deze link is onvolledig. Kopieer hem volledig uit de mail.' });
  }

  if (!process.env.NOTION_TOKEN) {
    console.error('NOTION_TOKEN ontbreekt in de omgeving.');
    return stuur(res, 500, { ok: false, fout: FOUT_ALGEMEEN });
  }

  try {
    const gevonden = await zoekUitnodiging(token);
    if (gevonden.fout) {
      return stuur(res, gevonden.fout.status, { ok: false, fout: gevonden.fout.bericht });
    }
    const { id: uitnodigingId, roepnaam, aanspreekvorm, status, geopendOp } = gevonden.uitnodiging;

    // --- opvragen ---------------------------------------------------------
    if (data.actie === 'opvragen') {
      // Alleen de roepnaam gaat naar buiten. Geen achternaam, geen huishouden,
      // geen broers of zussen, en zeker geen gezondheidsgegevens. Wie de token
      // heeft, mag weten over welk kind het gaat, meer niet.
      const antwoord = { ok: true, kind: roepnaam, aanspreekvorm };

      // Geopend op is een eerste-keer-veld. Een tweede bezoek overschrijft het
      // niet, anders verlies je wanneer de ouder de link echt geopend heeft.
      if (!geopendOp) {
        const wijziging = { 'Geopend op': { date: { start: vandaag() } } };
        if (status === 'Verzonden') wijziging['Status'] = { select: { name: 'Geopend' } };
        await notion(`/pages/${uitnodigingId}`, {
          method: 'PATCH',
          body: JSON.stringify({ properties: wijziging }),
        });
      }

      return stuur(res, 200, antwoord);
    }

    // --- indienen ---------------------------------------------------------
    if (data.actie !== 'indienen') {
      return stuur(res, 400, { ok: false, fout: 'Onbekende actie.' });
    }

    const naamOuder = tekst(data.naam_ouder, MAX_KORT);
    if (!naamOuder) {
      return stuur(res, 400, { ok: false, fout: 'Vul nog even je eigen naam in.' });
    }
    if (data.privacy !== true) {
      return stuur(res, 400, { ok: false, fout: 'Bevestig nog even dat je de privacyverklaring gelezen hebt.' });
    }

    const geladenOp = Number(data.t);
    const bruikbareTijd = Number.isFinite(geladenOp) && geladenOp >= VROEGSTE_T;
    const notities = [];
    if (!bruikbareTijd) notities.push(NOTITIE_GEEN_TIJD);
    else if (ONTVANGEN_OP - geladenOp < MIN_INVULTIJD_MS) notities.push(NOTITIE_SNEL);

    // Oudere onbewerkte inzendingen voor dezelfde link op Genegeerd zetten.
    // Ze blijven bestaan: het onbewerkte spoor is precies waarom deze
    // databank er is. Ze verdwijnen alleen uit Hans' werklijst.
    const eerdere = await notion(`/data_sources/${INZENDING_DATA_SOURCE_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: {
          and: [
            { property: 'Uitnodiging', relation: { contains: uitnodigingId } },
            { property: 'Status', select: { equals: 'Nieuw' } },
          ],
        },
        page_size: 20,
      }),
    });
    for (const rij of eerdere.results || []) {
      await notion(`/pages/${rij.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: { 'Status': { select: { name: 'Genegeerd' } } } }),
      });
    }
    if ((eerdere.results || []).length) notities.push(NOTITIE_HERINZENDING);

    const datum = vandaag();

    const properties = {
      'Naam': { title: [{ text: { content: `${datum} · ${roepnaam}` } }] },
      'Uitnodiging': { relation: [{ id: uitnodigingId }] },
      'Ontvangen op': { date: { start: datum } },
      'Status': { select: { name: 'Nieuw' } },
      'Naam ouder': richText(naamOuder),
      'Herkenbaarheid': keuze(data.herkenbaarheid, HERKENBAARHEID),
      'Toelichting beeld': richText(tekst(data.toelichting, MAX_LANG)),
      'Gezondheid toestemming': { checkbox: data.gezondheid_toestemming === true },
      'Privacyverklaring gelezen': { checkbox: true },
    };

    for (const [sleutel, kolom] of Object.entries(BEELDVELDEN)) {
      properties[kolom] = keuze(data[sleutel], JA_NEE);
    }

    // Zonder gezondheidstoestemming schrijven we de vier velden niet weg.
    // De ouder die nee zegt en toch iets typte, mag erop rekenen dat het
    // nergens belandt.
    if (data.gezondheid_toestemming === true) {
      for (const [sleutel, kolom] of Object.entries(GEZONDHEIDSVELDEN)) {
        properties[kolom] = richText(tekst(data[sleutel], MAX_LANG));
      }
    }

    if (notities.length) {
      properties['Opmerkingen'] = richText(notities.join(' '));
    }

    await notion('/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { type: 'data_source_id', data_source_id: INZENDING_DATA_SOURCE_ID },
        properties,
      }),
    });

    await notion(`/pages/${uitnodigingId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        properties: {
          'Status': { select: { name: 'Ingevuld' } },
          'Ingevuld op': { date: { start: datum } },
        },
      }),
    });

    return stuur(res, 200, {
      ok: true,
      bericht: 'We hebben je antwoorden goed ontvangen. Je kan dit formulier opnieuw invullen zolang je link geldig is, als er iets moet veranderen.',
    });
  } catch (fout) {
    console.error('Toestemmingsendpoint mislukt:', fout);
    return stuur(res, 500, { ok: false, fout: FOUT_ALGEMEEN });
  }
};
