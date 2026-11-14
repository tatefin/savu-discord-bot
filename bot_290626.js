require("dotenv").config();

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, InteractionContextType, ApplicationIntegrationType, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");
const cron = require("node-cron");
const axios = require("axios");
const cheerio = require("cheerio");
const { createCanvas } = require("canvas");
const { loadConfig, saveConfig, loadGuildConfig, saveGuildConfig, ensureGuildExists, isFeatureEnabled, ACTIVITY_TYPES } = require("./config.js");
const { PP2_PALVELIN_NIMI, haePP2Palvelin } = require("./pp2.js");
const { haeOmaTMPalvelinTila, TM_JOIN_URL } = require("./tm.js");
const Laskurit = require("./laskurit.js");

function rakennaAktiviteetti(entry) {
  const type = ACTIVITY_TYPES[entry?.type] ?? 0;
  return { name: entry?.text || "/help", type };
}

const { TOKEN, CLIENT_ID, WEATHER_API_KEY, TM_LOGIN, TM_PASSWORD, TM_OAUTH_ID, TM_OAUTH_SECRET, SATO_USERNAME, SATO_PASSWORD, HSL_SUBSCRIPTION_KEY } = process.env;
const client = new Client({
  // DirectMessages: yksityisviestien MESSAGE_CREATE-paketit DM-lokia varten (ks. client.on("raw")).
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  // Asetetaan luotettavasti jo IDENTIFY-kättelyssä (setPresence() pian yhteyden jälkeen on epäluotettava,
  // ks. paivitaPresenceKierto alempana kiertoa/uudelleenvahvistusta varten).
  presence: { activities: [rakennaAktiviteetti(loadConfig().settings.presences[0])], status: "online" }
});
const DT_HEADERS = { "Digitraffic-User": "discord-bot/savu" };

// Ilman tätä mikä tahansa Clientin sisäisesti emittoima "error" (esim. discord.js:n oma
// validointi/verkkovirhe joka ei kulje interaktiokäsittelijän try/catchin kautta) kaataisi
// koko prosessin, koska Node heittää oletuksena EventEmitterin käsittelemättömän "error"-eventin.
client.on("error", err => console.error("Discord-clientin virhe:", err));

/* --- APU --- */

const tanyKey = () => {
  const d = new Date();
  return `${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};

const lueJSON = (tiedosto) => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, tiedosto))); }
  catch { return {}; }
};

// Palvelinkohtainen data (esim. syntymäpäivät) — nimipäivät sen sijaan ovat yhteinen
// kalenteri kaikille palvelimille eivätkä tarvitse tätä.
const GUILD_DATA_DIR = path.join(__dirname, "data");
const guildDataPolku = (guildId, tiedosto) => path.join(GUILD_DATA_DIR, guildId, tiedosto);
const lueGuildJSON = (guildId, tiedosto) => {
  try { return JSON.parse(fs.readFileSync(guildDataPolku(guildId, tiedosto))); }
  catch { return {}; }
};

const muotoilePaivaEro = d => d === 0 ? "tänään!" : d === 1 ? "huomenna" : `${d} päivän päästä`;

function muotoileKesto(sekunnit) {
  const paivat = Math.floor(sekunnit / 86400);
  const tunnit = Math.floor((sekunnit % 86400) / 3600);
  const minuutit = Math.floor((sekunnit % 3600) / 60);
  const osat = [];
  if (paivat) osat.push(`${paivat} pv`);
  if (tunnit) osat.push(`${tunnit} h`);
  osat.push(`${minuutit} min`);
  return osat.join(" ");
}

const muotoileNimet = nimet =>
  !nimet.length ? "Tänään ei ole nimipäiviä. 😊"
  : nimet.length === 1 ? `🎉 Onnea **${nimet[0]}**!`
  : `🎊 Nimipäivät: **${nimet.join(", ")}**`;

const muotoileSynttarit = nimet =>
  nimet.length ? `🎂 Tänään synttärit: ${nimet.join(", ")}!` : null;

const KUUKAUDET = ["tammikuuta","helmikuuta","maaliskuuta","huhtikuuta","toukokuuta","kesäkuuta",
  "heinäkuuta","elokuuta","syyskuuta","lokakuuta","marraskuuta","joulukuuta"];

// Ottaa listan "MM-DD"-päivämääriä, palauttaa lähimmän tulevan (tai tämänpäiväisen) esiintymän
// muodossa { text: "X. kuuta", diff: <päiviä nyt hetkestä> }. Käytetään sekä /nimipaiva- että
// /synttarit-haussa, koska molemmat ovat "milloin tämä päivä on seuraavaksi" -kyselyitä.
function seuraavaEsiintyma(paivamaarat) {
  const today = new Date();
  const formatted = paivamaarat.map(p => {
    const [kk, pv] = p.split("-").map(Number);
    return { text: `${pv}. ${KUUKAUDET[kk-1]}`, date: new Date(today.getFullYear(), kk-1, pv) };
  });
  return formatted.reduce((best, f) => {
    let d = new Date(f.date);
    if (d < today) d.setFullYear(d.getFullYear()+1);
    const diff = Math.ceil((d-today)/(864e5));
    return diff < best.diff ? { ...f, diff } : best;
  }, { diff:Infinity });
}

const haeNimipaivat = () => lueJSON("nimipaivat.json")[tanyKey()] || [];
const haeSynttarit  = (guildId) => guildId ? (lueGuildJSON(guildId, "syntymapaivat.json")[tanyKey()] || []) : [];

// /lampo koti näyttää botin omistajan omaa kotia, ei mitään palvelinkohtaista dataa,
// joten sallittujen lista on globaali (config.json: lampoKotiAllowedUserIds) ja koskee
// yhtä lailla guild- ja DM-käyttöä.
function isLampoKotiAllowed(interaction) {
  return loadConfig().lampoKotiAllowedUserIds.includes(interaction.user.id);
}

/* --- LIPUTUSPÄIVÄT --- */

function getEaster(year) {
  const f = Math.floor, a = year%19, b = f(year/100), c = year%100,
    d = f(b/4), e = b%4, g = f((8*b+13)/25),
    h = (19*a+b-d-g+15)%30, j = f(c/4), k = c%4,
    m = f((a+11*h)/319), r = (2*e+2*j-k-h+m+32)%7,
    n = f((h-m+r+90)/25), p = (h-m+r+n+19)%32;
  return new Date(year, n-1, p);
}

const addDays = (date, days) => { const d = new Date(date); d.setDate(d.getDate()+days); return d; };

const getNthWeekday = (year, month, weekday, nth) => {
  const first = new Date(year, month, 1);
  return new Date(year, month, 1 + (7+weekday-first.getDay())%7 + (nth-1)*7);
};

const findSaturday = (year, month, from, to) => {
  for (let d = from; d <= to; d++) {
    const date = new Date(year, month, d);
    if (date.getDay() === 6) return date;
  }
};

function haeLiputuspaiva() {
  const d = new Date(), year = d.getFullYear();
  const isSame = dt => dt && dt.getDate()===d.getDate() && dt.getMonth()===d.getMonth();

  const fixed = {
    "01-06":"Loppiainen",
    "02-03":"Alvar ja Aino Aallon sekä suomalaisen arkkitehtuurin ja muotoilun päivä",
    "02-05":"J.L. Runebergin päivä","02-06":"Saamelaisten kansallispäivä",
    "02-28":"Kalevalan päivä, suomalaisen kulttuurin päivä",
    "03-19":"Minna Canthin päivä, tasa-arvon päivä","04-08":"Kansainvälinen romanipäivä",
    "04-09":"Mikael Agricolan päivä, suomen kielen päivä","04-20":"Evakkojen päivä",
    "04-27":"Kansallinen veteraanipäivä",
    "05-01":"Vappu, suomalaisen työn päivä","05-09":"Eurooppa-päivä",
    "05-12":"J.V. Snellmanin päivä, suomalaisuuden päivä",
    "06-04":"Puolustusvoimain lippujuhlan päivä","07-06":"Eino Leinon päivä, runon ja suven päivä",
    "08-09":"Tove Janssonin ja suomalaisen taiteen päivä",
    "10-01":"Miina Sillanpään päivä, kansalaisvaikuttamisen päivä",
    "10-10":"Aleksis Kiven päivä, suomalaisen kirjallisuuden päivä","10-24":"YK:n päivä",
    "11-06":"Ruotsalaisuuden päivä, Kustaa Aadolfin päivä","11-20":"Lapsen oikeuksien päivä",
    "12-06":"Itsenäisyyspäivä","12-08":"Jean Sibeliuksen päivä, suomalaisen musiikin päivä"
  };

  const easter = getEaster(year);
  const liikkuvat = [
    [addDays(easter,-2),"Pitkäperjantai"], [easter,"Pääsiäispäivä"],
    [addDays(easter,39),"Helatorstai"],    [addDays(easter,49),"Helluntai"],
    [getNthWeekday(year,4,0,2),"Äitienpäivä"],
    [getNthWeekday(year,4,0,3),"Kaatuneitten muistopäivä"],
    [getNthWeekday(year,10,0,2),"Isänpäivä"],
    [findSaturday(year,5,20,26),"Juhannus, Suomen lipun päivä"],
    [findSaturday(year,9,31,37),"Pyhäinpäivä"],
    [findSaturday(year,7,25,31),"Suomen luonnon päivä"],
  ];

  return liikkuvat.find(([dt])=>isSame(dt))?.[1] || fixed[tanyKey()] || null;
}

/* --- NIMIHAKU (DVV:n nimipalvelu) ---
   Sivu on Next.js-sovellus, mutta palvelin renderöi taulukon tavallisena HTML:nä
   (<table><thead>/<tbody>/<tfoot>), joten se on suoraan cheerio-luettavissa — ei
   tarvita erillistä JS-ajoa. Jos taulukkoa ei löydy sivulta, nimeä ei ole rekisterissä. */

function muotoileNimihakuTaulukko(otsikot, rivit) {
  const leveydet = otsikot.map((otsikko, i) => Math.max(otsikko.length, ...rivit.map(r => r[i].length)));
  const muotoileRivi = solut => solut.map((s, i) => i === 0 ? s.padEnd(leveydet[i]) : s.padStart(leveydet[i])).join("  ");
  return `\`\`\`\n${[muotoileRivi(otsikot), ...rivit.map(muotoileRivi)].join("\n")}\n\`\`\``;
}

// DVV:n taulukon luvut on muotoiltu tuhaterottimin ("6 820") ja osa on
// tietosuojan takia peitelty ("alle 5"), joten pylväitä varten poimitaan
// pelkät numerot merkkijonosta. Miehet ja naiset pinotaan samaan pylvääseen
// väreittäin eroteltuna, jolloin pylvään kokonaiskorkeus näyttää summan.
function piirraNimihakuGraafi(rivit, miehetIdx, naisetIdx, otsikkoTeksti) {
  const W = 800, H = 400, PAD = { top:46, right:20, bottom:64, left:60 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#2b2d31";
  ctx.fillRect(0, 0, W, H);

  const parseLuku = s => parseInt(String(s).replace(/[^\d]/g, ""), 10) || 0;
  const labels = rivit.map(r => r[0]);
  const miehet = rivit.map(r => parseLuku(r[miehetIdx]));
  const naiset = rivit.map(r => parseLuku(r[naisetIdx]));
  const yhteensa = rivit.map((_, i) => miehet[i] + naiset[i]);
  const maxV = Math.max(...yhteensa, 1);

  const xStep = cw / rivit.length;
  const toX = i => PAD.left + i * xStep + xStep / 2;
  const VARI_MIEHET = "#5865f2", VARI_NAISET = "#eb459e";

  // Vaakaviivat ja y-akselitunnisteet
  ctx.strokeStyle = "#3f4147";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + (ch / 4) * i;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cw, y); ctx.stroke();
    const label = Math.round(maxV - (maxV / 4) * i).toLocaleString("fi-FI");
    ctx.fillStyle = "#9b9d9f";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(label, PAD.left - 6, y + 4);
  }

  // Pinotut palkit: miehet pohjalla, naiset päällä
  rivit.forEach((_, i) => {
    const x = PAD.left + i * xStep + 2;
    const yPohja = PAD.top + ch;
    const mH = (miehet[i] / maxV) * ch;
    const nH = (naiset[i] / maxV) * ch;

    ctx.fillStyle = VARI_MIEHET;
    ctx.fillRect(x, yPohja - mH, xStep - 4, Math.max(mH, miehet[i] > 0 ? 1 : 0));

    ctx.fillStyle = VARI_NAISET;
    ctx.fillRect(x, yPohja - mH - nH, xStep - 4, Math.max(nH, naiset[i] > 0 ? 1 : 0));
  });

  // Kokonaismäärä pylvään päälle. Tietosuojan takia peitelty "alle 5" on laskettu yllä viitosena,
  // joten jos jompikumpi osa on peitelty, todellinen summa on pienempi kuin laskettu: näytetään "<summa".
  const peitelty = s => /alle/i.test(String(s));
  const luku = n => n.toLocaleString("fi-FI");
  piirraPalkkienLuvut(ctx, rivit.map((r, i) => ({
    x: toX(i),
    y: PAD.top + ch - (yhteensa[i] / maxV) * ch,
    arvo: (peitelty(r[miehetIdx]) || peitelty(r[naisetIdx]) ? "<" : "") + luku(yhteensa[i]),
    vari: "#ffffff"
  })), xStep, [13, 12, 11, 10].map(f => [f, String]));

  // X-akselitunnisteet kallistettuna, jotta esim. vuosikymmenet mahtuvat
  ctx.fillStyle = "#9b9d9f";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "right";
  labels.forEach((label, i) => {
    ctx.save();
    ctx.translate(toX(i), H - PAD.bottom + 6);
    ctx.rotate(-Math.PI / 5);
    ctx.fillText(label, 0, 0);
    ctx.restore();
  });

  // Otsikko
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 14px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(otsikkoTeksti, 4, 22);

  // Selite
  ctx.font = "12px sans-serif";
  ctx.textAlign = "left";
  ctx.fillStyle = VARI_MIEHET;
  ctx.fillRect(W - 172, 12, 12, 12);
  ctx.fillStyle = "#ffffff";
  ctx.fillText("Miehet", W - 156, 22);

  ctx.fillStyle = VARI_NAISET;
  ctx.fillRect(W - 92, 12, 12, 12);
  ctx.fillStyle = "#ffffff";
  ctx.fillText("Naiset", W - 76, 22);

  return canvas.toBuffer("image/png");
}

// DVV:n sivu (Next.js) striimaa OSAN taulukon soluista myöhemmin saapuvana erillisenä
// palana — tyypillisesti niitä, joissa on tietosuojan takia peiteltyjä pieniä lukuja
// ("alle 5") ja jotka vaativat ylimääräisen tarkistuksen. Nämä solut näkyvät alkuperäisessä
// HTML:ssä vain tyhjinä <template id="P:x">-paikanpitäjinä, ja niiden oikea sisältö odottaa
// piilotettuna elementissä id="S:x" — selain siirtäisi ne paikoilleen ajamalla sivun
// $RS("S:x","P:x")-skriptit, mutta cheerio ei aja skriptejä, joten se tehdään itse tässä
// ennen taulukon lukemista. Ilman tätä esim. harvinaisten nimien taulukko katkeaisi kesken.
function ratkaiseSuspenseKappaleet($) {
  const html = $.html();
  const parit = [...html.matchAll(/\$RS\("(S:[0-9a-zA-Z]+)","(P:[0-9a-zA-Z]+)"\)/g)];
  for (const [, sId, pId] of parit) {
    const lahde = $(`[id="${sId}"]`).first();
    const kohde = $(`[id="${pId}"]`).first();
    if (!lahde.length || !kohde.length) continue;
    kohde.replaceWith(lahde.html());
  }
}

async function haeEtunimihaku(nimi) {
  const url = `https://nimipalvelu.dvv.fi/etunimihaku?nimi=${encodeURIComponent(nimi)}`;
  try {
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      timeout: 10000
    });
    const $ = cheerio.load(data);
    ratkaiseSuspenseKappaleet($);
    const table = $("table").first();
    if (!table.length) return { url, found: false };

    // .each() eikä .map(), koska cheerion (jQueryn tapaan) .map() litistäisi
    // sisäkkäiset taulukot yhdeksi tasoksi jos callback palauttaa taulukon.
    const rivit = [];
    table.find("tbody tr").each((_, tr) => {
      const solut = $(tr).find("td").map((_, td) => $(td).text().trim()).get();
      if (solut.length >= 4) rivit.push(solut);
    });

    const yhteensa = table.find("tfoot tr td").map((_, td) => $(td).text().trim()).get();
    if (yhteensa.length >= 4) rivit.push(yhteensa);

    return { url, found: true, rivit };
  } catch (err) {
    console.error("haeEtunimihaku virhe:", err.message);
    return null;
  }
}

async function haeSukunimihaku(nimi) {
  const url = `https://nimipalvelu.dvv.fi/sukunimihaku?nimi=${encodeURIComponent(nimi)}`;
  try {
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      timeout: 10000
    });
    const $ = cheerio.load(data);
    ratkaiseSuspenseKappaleet($);
    const table = $("table").first();
    if (!table.length) return { url, found: false };

    const rivit = [];
    table.find("tbody tr").each((_, tr) => {
      const solut = $(tr).find("td").map((_, td) => $(td).text().trim()).get();
      if (solut.length >= 6) rivit.push(solut);
    });

    const yhteensa = table.find("tfoot tr td").map((_, td) => $(td).text().trim()).get();
    if (yhteensa.length >= 6) rivit.push(yhteensa);

    return { url, found: true, rivit };
  } catch (err) {
    console.error("haeSukunimihaku virhe:", err.message);
    return null;
  }
}

/* --- SÄHKÖ --- */

function parsePrice(text) {
  return parseFloat(text.replace(",",".").replace(/[^\d.\-−]/g,"").replace("−","-"));
}

async function haePorssisahkoData(onlyFuture = false) {
  try {
    const $ = cheerio.load((await axios.get("https://www.porssisahkoa.fi/")).data);
    const prices = [];
    $("table tbody tr").each((_, el) => {
      const cols = $(el).find("td").map((_,td) => $(td).text().trim()).get();
      if (cols.length >= 2) {
        const hour = parseInt(cols[0]);
        const price = parsePrice(cols[1]);
        if (!isNaN(hour) && !isNaN(price)) prices.push({ time: String(hour).padStart(2,"0"), price });
      }
    });
    if (!prices.length) return null;
    const filtered = onlyFuture
      ? prices.filter(p => parseInt(p.time) >= new Date().getHours())
      : prices;
    if (!filtered.length) return null;
    const sorted = [...filtered].sort((a,b) => a.price-b.price);
    return {
      halvin: sorted[0],
      kallein: sorted.at(-1),
      keski: (filtered.reduce((a,b) => a+b.price, 0) / filtered.length).toFixed(2),
      kaikki: prices  // koko päivä aina mukana graafille
    };
  } catch { return null; }
}

/* --- UUTISET --- */

async function haeAmpparitUutiset(url, maara = 5) {
  try {
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    });
    const $ = cheerio.load(data);
    const uutiset = [];

    $("h4 a").each((_, el) => {
      if (uutiset.length >= maara) return false;
      const otsikko = $(el).text().trim();
      const linkki = $(el).attr("href");
      if (otsikko && linkki && linkki.startsWith("http")) {
        uutiset.push({ otsikko, linkki });
      }
    });

    return uutiset.length ? uutiset : null;
  } catch (err) {
    console.error("haeAmpparitUutiset virhe:", err.message);
    return null;
  }
}

// Säilytetään vanha nimi yhteensopivuuden vuoksi
const haeLuetuimmatUutiset = (maara = 3) =>
  haeAmpparitUutiset("https://www.ampparit.com/luetuimmat", maara);



async function haeTiehairot() {
  try {
    const { data } = await axios.get(
      "https://tie.digitraffic.fi/api/traffic-message/v1/messages?inactiveHours=0&includeAreaGeometry=false&situationType=TRAFFIC_ANNOUNCEMENT",
      { headers: DT_HEADERS }
    );
    return (data.features || []).slice(0,5).map(f => {
      const ann = f.properties.announcements?.[0];
      return {
        otsikko: ann?.title?.replace(/\.$/,"") || "Häiriö",
        sijainti: ann?.location?.description || "",
        alkoi: ann?.timeAndDuration?.startTime
          ? new Date(ann.timeAndDuration.startTime).toLocaleString("fi-FI",{timeZone:"Europe/Helsinki"})
          : null
      };
    });
  } catch (err) {
    console.error("haeTiehairot virhe:", err.response?.status, err.message);
    return null;
  }
}

async function haeJunahahairot() {
  try {
    const vastaukset = await Promise.all(
      ["HKI","TPE","TKU","OUL","JY"].map(asema =>
        axios.get(
          `https://rata.digitraffic.fi/api/v1/live-trains/station/${asema}?arrived_trains=0&arriving_trains=10&departed_trains=0&departing_trains=10&include_nonstopping=false&train_categories=Long-distance`,
          { headers: DT_HEADERS }
        ).then(r=>r.data).catch(()=>[])
      )
    );
    const junat = Object.values(
      vastaukset.flat().reduce((acc,t) => { acc[t.trainNumber]=t; return acc; }, {})
    );
    return junat
      .filter(t => t.timeTableRows?.some(r => r.differenceInMinutes > 5))
      .map(t => {
        const worst = t.timeTableRows
          .filter(r => r.differenceInMinutes > 0)
          .sort((a,b) => b.differenceInMinutes-a.differenceInMinutes)[0];
        return { juna:`${t.trainType}${t.trainNumber}`, myohassa:worst?.differenceInMinutes||0, asema:worst?.stationShortCode||"" };
      })
      .sort((a,b) => b.myohassa-a.myohassa)
      .slice(0,5);
  } catch (err) {
    console.error("haeJunahahairot virhe:", err.response?.status, err.message);
    return null;
  }
}

const MERI_TYYPIT = {
  "Unlit": "Valo ei pala",
  "Damaged": "Vaurioitunut",
  "Destroyed/Missing": "Tuhoutunut/kadonnut",
  "Off station": "Siirtynyt paikaltaan",
  "Light unreliable": "Valo epäluotettava",
  "Limited visibility": "Näkyvyys rajoittunut",
  "Maintenance works": "Huoltotyö"
};

async function haeMeriHairot() {
  try {
    const { data } = await axios.get(
      "https://meri.digitraffic.fi/api/aton/v1/faults",
      { headers: DT_HEADERS }
    );
    return (data.features || [])
      .filter(f => !f.properties.fixed)
      .sort((a,b) => new Date(b.properties.entry_timestamp) - new Date(a.properties.entry_timestamp))
      .slice(0, 5)
      .map(f => {
        const p = f.properties;
        return {
          nimi: p.aton_name_fi,
          tyyppi: MERI_TYYPIT[p.type] || p.type,
          vayla: p.fairway_name_fi,
          alue: p.area_description,
          alkoi: new Date(p.entry_timestamp).toLocaleString("fi-FI", { timeZone:"Europe/Helsinki" })
        };
      });
  } catch (err) {
    console.error("haeMeriHairot virhe:", err.response?.status, err.message);
    return null;
  }
}

/* --- HSL (Digitransit GraphQL) --- */

async function haeHslHairiot() {
  try {
    const { data } = await axios.post(
      "https://api.digitransit.fi/routing/v2/hsl/gtfs/v1",
      { query: `{ alerts(feeds: ["HSL"]) {
          alertHeaderText alertDescriptionText alertSeverityLevel effectiveStartDate
        } }` },
      { headers: { "Content-Type": "application/json", "digitransit-subscription-key": HSL_SUBSCRIPTION_KEY } }
    );
    return (data.data?.alerts || [])
      .sort((a, b) => b.effectiveStartDate - a.effectiveStartDate)
      .slice(0, 5)
      .map(a => ({
        otsikko: a.alertHeaderText || "Häiriö",
        kuvaus: a.alertDescriptionText || "",
        vakavuus: a.alertSeverityLevel,
        alkoi: new Date(a.effectiveStartDate * 1000).toLocaleString("fi-FI", { timeZone:"Europe/Helsinki" })
      }));
  } catch (err) {
    console.error("haeHslHairiot virhe:", err.response?.status, err.message);
    return null;
  }
}

async function haeHslPysakinLahdot(nimi, linja) {
  try {
    const { data } = await axios.post(
      "https://api.digitransit.fi/routing/v2/hsl/gtfs/v1",
      { query: `{ stops(name: ${JSON.stringify(nimi)}) {
          name code
          stoptimesWithoutPatterns(numberOfDepartures: ${linja ? 30 : 5}) {
            scheduledDeparture realtimeDeparture realtime serviceDay headsign
            trip { route { shortName } }
          }
        } }` },
      { headers: { "Content-Type": "application/json", "digitransit-subscription-key": HSL_SUBSCRIPTION_KEY } }
    );
    const pysakit = data.data?.stops || [];
    const linjaPieni = linja?.trim().toLowerCase();
    return pysakit
      .flatMap(p => (p.stoptimesWithoutPatterns || []).map(st => ({
        pysakki: p.code ? `${p.name} (${p.code})` : p.name,
        linja: st.trip?.route?.shortName || "?",
        suunta: st.headsign || "",
        hetki: st.serviceDay + (st.realtime ? st.realtimeDeparture : st.scheduledDeparture)
      })))
      .filter(l => !linjaPieni || l.linja.toLowerCase() === linjaPieni)
      .sort((a, b) => a.hetki - b.hetki)
      .slice(0, 5)
      .map(l => ({
        ...l,
        aika: new Date(l.hetki * 1000).toLocaleTimeString("fi-FI", { timeZone:"Europe/Helsinki", hour:"2-digit", minute:"2-digit" })
      }));
  } catch (err) {
    console.error("haeHslPysakinLahdot virhe:", err.response?.status, err.message);
    return null;
  }
}

/* --- SÄHKÖGRAAFI --- */

// Kirjoittaa jokaisen pylvään yläpuolelle sen arvon. Kuva pienenee Discordissa, joten luvut
// lihavoidaan ja valitaan ensimmäinen [fonttikoko, muotoilufunktio] -vaihtoehto, jolla leveinkin
// luku mahtuu pylvään levyiseksi. Jos mikään ei mahdu, luvut kirjoitetaan pystyyn.
// palkit: [{ x: pylvään keskikohta, y: pylvään yläreuna, arvo, vari }]
function piirraPalkkienLuvut(ctx, palkit, xStep, vaihtoehdot) {
  const maxTekstiLeveys = xStep - 2;
  const levein = ([fontti, muotoile]) => {
    ctx.font = `bold ${fontti}px sans-serif`;
    return Math.max(...palkit.map(p => ctx.measureText(muotoile(p.arvo)).width));
  };
  const sopiva = vaihtoehdot.find(v => levein(v) <= maxTekstiLeveys);
  const [fontti, muotoile] = sopiva || vaihtoehdot.at(-1);
  ctx.font = `bold ${fontti}px sans-serif`;
  palkit.forEach(p => {
    ctx.fillStyle = p.vari;
    if (sopiva) {
      ctx.textAlign = "center";
      ctx.fillText(muotoile(p.arvo), p.x, p.y - 4);
    } else {
      ctx.save();
      ctx.translate(p.x + fontti / 3, p.y - 3);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "left";
      ctx.fillText(muotoile(p.arvo), 0, 0);
      ctx.restore();
    }
  });
}

function piirraGraafi(prices, naytaNykyhetki = true) {
  const W = 800, H = 400, PAD = { top:40, right:20, bottom:40, left:55 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Tausta
  ctx.fillStyle = "#2b2d31";
  ctx.fillRect(0, 0, W, H);

  const vals = prices.map(p => p.price);
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  const range = maxV - minV || 1;

  const xStep = cw / prices.length;
  const toX = i => PAD.left + i * xStep + xStep / 2;
  const toY = v => PAD.top + ch - ((v - minV) / range) * ch;

  // Vaakaviivat
  ctx.strokeStyle = "#3f4147";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + (ch / 4) * i;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cw, y); ctx.stroke();
    const label = (maxV - (range / 4) * i).toFixed(2);
    ctx.fillStyle = "#9b9d9f";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`${label}`, PAD.left - 6, y + 4);
  }

  // Palkit
  const now = new Date().getHours();
  const minPrice = Math.min(...vals), maxPrice = Math.max(...vals);
  const EPS = 0.001;
  prices.forEach((p, i) => {
    const x = PAD.left + i * xStep + 2;
    const barH = Math.max(4, ((p.price - minV) / range) * ch);
    const y = PAD.top + ch - barH;
    const isPast = naytaNykyhetki && parseInt(p.time) < now;
    ctx.fillStyle = Math.abs(p.price - minPrice) < EPS ? "#57f287"
      : Math.abs(p.price - maxPrice) < EPS ? "#ed4245"
      : isPast ? "#4a4d52"
      : "#5865f2";
    ctx.fillRect(x, y, xStep - 4, barH);
  });

  // Hintaluvut palkkien yläpuolelle; desimaaleja karsitaan ennen kuin fonttia pienennetään liikaa.
  const hinta = des => v => v.toFixed(des);
  piirraPalkkienLuvut(ctx, prices.map((p, i) => ({
    x: toX(i),
    y: PAD.top + ch - Math.max(4, ((p.price - minV) / range) * ch),
    arvo: p.price,
    vari: naytaNykyhetki && parseInt(p.time) < now ? "#c4c9ce" : "#ffffff"
  })), xStep, [[13, hinta(2)], [12, hinta(2)], [13, hinta(1)], [12, hinta(1)], [11, hinta(1)], [13, hinta(0)], [11, hinta(0)]]);

  // X-akselitunnisteet (joka toinen tunti)
  ctx.fillStyle = "#9b9d9f";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  prices.forEach((p, i) => {
    if (i % 2 === 0) ctx.fillText(p.time, toX(i), H - PAD.bottom + 16);
  });

  // Nykyinen tunti -viiva
  if (naytaNykyhetki) {
    const nowX = PAD.left + now * xStep;
    ctx.strokeStyle = "#fee75c";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(nowX, PAD.top); ctx.lineTo(nowX, PAD.top + ch); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Otsikko
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 14px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("c/kWh", 4, PAD.top - 10);

  return canvas.toBuffer("image/png");
}

/* --- SÄHKÖN KUUKAUSIVERTAILU JA HUOMISEN HINTA (Elering, Nord Pool -pörssihinta) --- */

async function haeEleringHinnat(alku, loppu) {
  try {
    const url = `https://dashboard.elering.ee/api/nps/price?start=${alku.toISOString()}&end=${loppu.toISOString()}`;
    const { data } = await axios.get(url);
    if (!data.success || !Array.isArray(data.data?.fi)) return null;
    // EUR/MWh -> snt/kWh (jako 10). Huom: pörssihinta ilman ALV:ia/marginaalia,
    // ei siis suoraan sama luku kuin /sahko-komennon porssisahkoa.fi-hinta.
    return data.data.fi.map(p => ({ aika: new Date(p.timestamp * 1000), hinta: p.price / 10 }));
  } catch (err) {
    console.error("haeEleringHinnat virhe:", err.response?.status, err.message);
    return null;
  }
}

function tunneittain(pisteet) {
  const map = new Map();
  pisteet.forEach(p => {
    const tunti = String(p.aika.getHours()).padStart(2, "0");
    if (!map.has(tunti)) map.set(tunti, []);
    map.get(tunti).push(p.hinta);
  });
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([time, hh]) => ({ time, price: Number((hh.reduce((a, b) => a + b, 0) / hh.length).toFixed(2)) }));
}

// Nord Pool julkaisee seuraavan päivän hinnat tyypillisesti klo 12:45-13 Suomen aikaa —
// palauttaa null jos huomista ei ole vielä (kokonaan) julkaistu.
async function haeHuomisenSahko() {
  const nyt = new Date();
  const huomennaAlku = new Date(nyt.getFullYear(), nyt.getMonth(), nyt.getDate() + 1);
  const huomennaLoppu = new Date(nyt.getFullYear(), nyt.getMonth(), nyt.getDate() + 2);

  const raaka = await haeEleringHinnat(huomennaAlku, huomennaLoppu);
  if (!raaka?.length) return null;

  const pisteet = raaka.filter(p => p.aika >= huomennaAlku && p.aika < huomennaLoppu);
  const prices = tunneittain(pisteet);
  if (prices.length < 20) return null;

  const sorted = [...prices].sort((a, b) => a.price - b.price);
  return {
    prices,
    halvin: sorted[0],
    kallein: sorted.at(-1),
    keski: (prices.reduce((a, b) => a + b.price, 0) / prices.length).toFixed(2)
  };
}

function kuukausiTilastot(pisteet) {
  const hinnat = pisteet.map(p => p.hinta);
  const paivatMap = new Map();
  pisteet.forEach(p => {
    const paiva = p.aika.getDate();
    if (!paivatMap.has(paiva)) paivatMap.set(paiva, []);
    paivatMap.get(paiva).push(p.hinta);
  });
  const paivittain = [...paivatMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([paiva, hh]) => ({ paiva, keski: hh.reduce((a, b) => a + b, 0) / hh.length }));

  return {
    keski: hinnat.reduce((a, b) => a + b, 0) / hinnat.length,
    min: Math.min(...hinnat),
    max: Math.max(...hinnat),
    paivittain
  };
}

async function haeKuukausiSahkoVertailu() {
  const nyt = new Date();
  const paiviaTassaKk = nyt.getDate();
  const viimeKkPaiviaYhteensa = new Date(nyt.getFullYear(), nyt.getMonth(), 0).getDate();
  const paivia = Math.min(paiviaTassaKk, viimeKkPaiviaYhteensa);

  const tamaKkAlku = new Date(nyt.getFullYear(), nyt.getMonth(), 1);
  const tamaKkLoppu = new Date(nyt.getFullYear(), nyt.getMonth(), paivia + 1);
  const viimeKkAlku = new Date(nyt.getFullYear(), nyt.getMonth() - 1, 1);
  const viimeKkLoppu = new Date(nyt.getFullYear(), nyt.getMonth() - 1, paivia + 1);

  const [tamaRaaka, viimeRaaka] = await Promise.all([
    haeEleringHinnat(tamaKkAlku, tamaKkLoppu),
    haeEleringHinnat(viimeKkAlku, viimeKkLoppu)
  ]);
  if (!tamaRaaka?.length || !viimeRaaka?.length) return null;

  // API:n loppuraja on käytännössä inklusiivinen ensimmäiseen seuraavan päivän pisteeseen asti;
  // rajataan tarkasti haluttuihin päiviin ettei graafiin/tilastoihin lipsahda ylimääräistä pistettä.
  const tama = tamaRaaka.filter(p => p.aika.getDate() <= paivia);
  const viime = viimeRaaka.filter(p => p.aika.getDate() <= paivia);

  const kkNimi = pvm => pvm.toLocaleDateString("fi-FI", { month: "long", year: "numeric" });

  return {
    paivia,
    tamaKk: { nimi: kkNimi(tamaKkAlku), ...kuukausiTilastot(tama) },
    viimeKk: { nimi: kkNimi(viimeKkAlku), ...kuukausiTilastot(viime) }
  };
}

function piirraKuukausiGraafi(vertailu) {
  const W = 800, H = 400, PAD = { top: 40, right: 20, bottom: 40, left: 60 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#2b2d31";
  ctx.fillRect(0, 0, W, H);

  const kaikkiHinnat = [...vertailu.tamaKk.paivittain, ...vertailu.viimeKk.paivittain].map(p => p.keski);
  const minV = Math.min(...kaikkiHinnat), maxV = Math.max(...kaikkiHinnat);
  const range = (maxV - minV) || 1;

  const toX = paiva => PAD.left + ((paiva - 1) / Math.max(1, vertailu.paivia - 1)) * cw;
  const toY = v => PAD.top + ch - ((v - minV) / range) * ch;

  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const v = minV + (range / 4) * (4 - i);
    const y = PAD.top + (ch / 4) * i;
    ctx.strokeStyle = "#3f4147";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cw, y); ctx.stroke();
    ctx.fillStyle = "#9b9d9f";
    ctx.fillText(v.toFixed(1), PAD.left - 6, y + 4);
  }

  function piirraViiva(paivittain, vari, katkoviiva) {
    ctx.strokeStyle = vari;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.setLineDash(katkoviiva ? [6, 4] : []);
    ctx.beginPath();
    paivittain.forEach((p, i) => (i === 0 ? ctx.moveTo(toX(p.paiva), toY(p.keski)) : ctx.lineTo(toX(p.paiva), toY(p.keski))));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  piirraViiva(vertailu.viimeKk.paivittain, "#9b9d9f", true);
  piirraViiva(vertailu.tamaKk.paivittain, "#5865f2", false);

  ctx.fillStyle = "#9b9d9f";
  ctx.textAlign = "center";
  ctx.font = "11px sans-serif";
  const xMerkki = Math.max(1, Math.floor(vertailu.paivia / 8));
  for (let d = 1; d <= vertailu.paivia; d++) {
    if (d % xMerkki === 0 || d === 1 || d === vertailu.paivia) ctx.fillText(String(d), toX(d), H - PAD.bottom + 18);
  }

  ctx.font = "13px sans-serif";
  ctx.textAlign = "left";
  ctx.fillStyle = "#5865f2";
  ctx.fillRect(PAD.left, 12, 12, 12);
  ctx.fillStyle = "#e3e5e8";
  ctx.fillText(vertailu.tamaKk.nimi, PAD.left + 18, 22);
  const viimeKkX = PAD.left + 18 + ctx.measureText(vertailu.tamaKk.nimi).width + 24;
  ctx.fillStyle = "#9b9d9f";
  ctx.fillRect(viimeKkX, 12, 12, 12);
  ctx.fillStyle = "#e3e5e8";
  ctx.fillText(vertailu.viimeKk.nimi, viimeKkX + 18, 22);

  return canvas.toBuffer("image/png");
}

async function haeSaa(kaupunki) {
  try {
    const { data } = await axios.get(
      `https://api.weatherapi.com/v1/forecast.json?key=${WEATHER_API_KEY}&q=${encodeURIComponent(kaupunki+", Finland")}&lang=fi&days=1&aqi=no&alerts=no`
    );
    return data;
  } catch { return null; }
}

function muunna12h24h(aika) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(aika || "");
  if (!m) return aika;
  let h = parseInt(m[1], 10);
  const ap = m[3].toUpperCase();
  if (ap === "AM") { if (h === 12) h = 0; }
  else if (h !== 12) { h += 12; }
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

function etsiMaxLampoAika(hourArray, maxtempC) {
  if (!Array.isArray(hourArray)) return null;
  const osuma = hourArray.find(h => h.temp_c === maxtempC);
  if (!osuma || !osuma.time) return null;
  return osuma.time.split(" ")[1] || null;
}

/* --- UNIPISTEET --- */

function uniClamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function uniScoreKesto(minuutit) {
  const h = minuutit / 60;
  return uniClamp(100 - Math.abs(h - 7.5) * 18, 0, 100);
}
function uniScoreSyva(prosentti) {
  return uniClamp(100 - Math.abs(prosentti - 25) * 3, 0, 100);
}
function uniScoreRem(prosentti) {
  return uniClamp(100 - Math.abs(prosentti - 20) * 4, 0, 100);
}
function uniScoreKevyt(prosentti) {
  if (prosentti <= 55) return uniClamp(100 - Math.max(0, prosentti - 45) * 3, 0, 100);
  return uniClamp(70 - (prosentti - 55) * 4, 0, 100);
}
function uniScoreHeraamiset(maara) {
  if (maara <= 2) return uniClamp(100 - maara * 10, 0, 100);
  return uniClamp(80 - (maara - 2) * 20, 0, 100);
}

const UNI_PAINOT = { kesto: 0.30, syva: 0.25, rem: 0.20, kevyt: 0.15, heraamiset: 0.10 };

function laskeUnipisteet({ minuutit, syva, kevyt, rem, heraamiset }) {
  const osat = {
    kesto: uniScoreKesto(minuutit),
    syva: uniScoreSyva(syva),
    kevyt: uniScoreKevyt(kevyt),
    rem: uniScoreRem(rem),
    heraamiset: uniScoreHeraamiset(heraamiset)
  };
  const kokonais = Math.round(
    osat.kesto * UNI_PAINOT.kesto +
    osat.syva * UNI_PAINOT.syva +
    osat.kevyt * UNI_PAINOT.kevyt +
    osat.rem * UNI_PAINOT.rem +
    osat.heraamiset * UNI_PAINOT.heraamiset
  );
  return { osat, kokonais };
}

function uniPalkki(pisteet, pituus = 14) {
  const taytetyt = Math.round((pisteet / 100) * pituus);
  return "█".repeat(taytetyt) + "░".repeat(pituus - taytetyt);
}

function uniLuokka(pisteet) {
  if (pisteet >= 85) return "Erinomainen 🟢";
  if (pisteet >= 70) return "Hyvä 🟡";
  if (pisteet >= 55) return "Kohtalainen 🟠";
  return "Heikko 🔴";
}

/* --- SATO (KOTI) --- */

const SATO_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/plain, */*",
  "Origin": "https://oma.sato.fi",
  "Referer": "https://oma.sato.fi/login",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
};
let satoToken = null;
let satoIdToken = null;
let satoTokenExpiry = 0;
let satoApartmentId = null;

async function haeSatoAuth() {
  if (satoToken && Date.now() < satoTokenExpiry) return { token: satoToken, idToken: satoIdToken };
  const { data } = await axios.post(
    "https://oma.sato.fi/api/identity/v1/auth/signin",
    { username: SATO_USERNAME, password: SATO_PASSWORD },
    { headers: { ...SATO_HEADERS, "Auth-Type": "awscognito" } }
  );
  satoToken = data.token;
  satoIdToken = data.idToken;
  satoTokenExpiry = Date.now() + (data.expiresIn - 60) * 1000;
  return { token: satoToken, idToken: satoIdToken };
}

async function haeSatoApartmentId(authHeaders) {
  if (satoApartmentId) return satoApartmentId;
  const { data } = await axios.get(
    "https://oma.sato.fi/api/realestates/v1/homes/apartments/myapartments",
    { headers: authHeaders }
  );
  satoApartmentId = data.ownApartments?.[0]?.apartmentId || null;
  return satoApartmentId;
}

async function haeKotiMittaukset() {
  try {
    const { token, idToken } = await haeSatoAuth();
    const authHeaders = { ...SATO_HEADERS, Authorization: `Bearer ${token}`, AuthorizationID: idToken };
    const apartmentId = await haeSatoApartmentId(authHeaders);
    if (!apartmentId) return null;

    const startDateTime = Math.floor((Date.now() - 7 * 24 * 3600 * 1000) / 1000);
    const { data } = await axios.get(
      `https://oma.sato.fi/api/omasato/v1/apartments/${apartmentId}/measurements`,
      { headers: authHeaders, params: { startDateTime, measurementType: "TEMPERATURE" } }
    );
    return data?.[0]?.measurements || null;
  } catch (err) {
    console.error("haeKotiMittaukset virhe:", err.response?.status, err.message);
    return null;
  }
}

// Tuntikohtainen kotilämpötilan raja-arvohälytys yksityisviestillä (ei liity /lampo koti -komennon oikeuksiin).
// Vastaanottaja ja raja tulevat .env:stä; ilman LAMPO_HALYTYS_USER_ID:tä hälytys on pois päältä.
const LAMPO_HALYTYS_USER_ID = (process.env.LAMPO_HALYTYS_USER_ID || "").trim();
const LAMPO_HALYTYS_RAJA = Number(process.env.LAMPO_HALYTYS_RAJA) || 26;

async function tarkistaKotiLampoHalytys() {
  if (!LAMPO_HALYTYS_USER_ID) return;
  try {
    const mittaukset = await haeKotiMittaukset();
    if (!mittaukset || !mittaukset.length) return;
    const viimeisin = mittaukset.reduce((a, b) => (new Date(b.timestamp) > new Date(a.timestamp) ? b : a));
    if (viimeisin.value > LAMPO_HALYTYS_RAJA) {
      const user = await client.users.fetch(LAMPO_HALYTYS_USER_ID);
      await user.send(`🌡️ Kodin lämpötila on ${viimeisin.value.toFixed(1)}°C — yli ${LAMPO_HALYTYS_RAJA}°C rajan.`);
    }
  } catch (err) {
    console.error("tarkistaKotiLampoHalytys virhe:", err.response?.status, err.message);
  }
}

function piirraLampoGraafi(mittaukset) {
  const W = 800, H = 400, PAD = { top:40, right:20, bottom:40, left:55 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#2b2d31";
  ctx.fillRect(0, 0, W, H);

  const pisteet = mittaukset.map(m => ({ pvm:new Date(m.timestamp), arvo:m.value }));
  const arvot = pisteet.map(p => p.arvo);
  const minV = Math.min(...arvot), maxV = Math.max(...arvot);
  const range = maxV - minV || 1;

  const toX = i => PAD.left + (i / (pisteet.length - 1)) * cw;
  const toY = v => PAD.top + ch - ((v - minV) / range) * ch;

  // Vaakaviivat ja y-akselitunnisteet
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const v = minV + (range / 4) * (4 - i);
    const y = PAD.top + (ch / 4) * i;
    ctx.strokeStyle = "#3f4147";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cw, y); ctx.stroke();
    ctx.fillStyle = "#9b9d9f";
    ctx.fillText(v.toFixed(1), PAD.left - 6, y + 4);
  }

  // Täyttöalue
  const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + ch);
  grad.addColorStop(0, "rgba(240,136,62,0.25)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(toX(0), PAD.top + ch);
  pisteet.forEach((p, i) => ctx.lineTo(toX(i), toY(p.arvo)));
  ctx.lineTo(toX(pisteet.length - 1), PAD.top + ch);
  ctx.closePath();
  ctx.fill();

  // Viiva
  ctx.strokeStyle = "#f0883e";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  pisteet.forEach((p, i) => i === 0 ? ctx.moveTo(toX(i), toY(p.arvo)) : ctx.lineTo(toX(i), toY(p.arvo)));
  ctx.stroke();

  // X-akselitunnisteet (max 6 tasaisesti)
  const xMerkki = Math.max(1, Math.floor(pisteet.length / 6));
  ctx.fillStyle = "#9b9d9f";
  ctx.textAlign = "center";
  ctx.font = "11px sans-serif";
  pisteet.forEach((p, i) => {
    if (i % xMerkki === 0 || i === pisteet.length - 1) {
      const label = p.pvm.toLocaleDateString("fi-FI", { day:"2-digit", month:"2-digit" });
      ctx.fillText(label, toX(i), H - PAD.bottom + 18);
    }
  });

  // Otsikko
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 14px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("°C", 4, PAD.top - 10);

  return canvas.toBuffer("image/png");
}

function haeSavuLampotila() {
  try {
    const millideg = parseInt(fs.readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8").trim(), 10);
    return millideg / 1000;
  } catch (err) {
    console.error("haeSavuLampotila virhe:", err.message);
    return null;
  }
}

/* --- ALKO (juomaan.fi) --- */

const ALKO_URL = "https://juomaan.fi/alko_tuotteet.json";
const ALKO_HEADERS = { "User-Agent": "discord-bot-savu / juomaan.fi-data-proxy" };
let alkoCache = null;
let alkoCacheExpiry = 0;

async function haeAlkoTuotteet() {
  if (alkoCache && Date.now() < alkoCacheExpiry) return alkoCache;
  try {
    const { data } = await axios.get(ALKO_URL, { headers: ALKO_HEADERS });
    alkoCache = data;
    alkoCacheExpiry = Date.now() + loadConfig().settings.alkoCacheMinutes * 60 * 1000;
    return alkoCache;
  } catch (err) {
    console.error("haeAlkoTuotteet virhe:", err.response?.status, err.message);
    return null;
  }
}

// Pantti lasketaan mukaan hintaan (juomaan.fi:n oletustila)
const alkoEfHinta = t => (t.hinta_eur || 0) + (t.pantti_eur || 0);

// 1 annos = 1,5 cl puhdasta alkoholia (juomaan.fi:n käyttämä vakio)
function alkoAnnosHinta(t) {
  const puhdasCl = t.tilavuus_litraa * 100 * (t.alkoholi_prosentti / 100);
  if (!puhdasCl) return Infinity;
  return alkoEfHinta(t) / (puhdasCl / 1.5);
}

function muotoileAlkoLista(tuotteet, hintaFn, yksikko) {
  return tuotteet.map((t, i) =>
    `**${i+1}.** [${t.nimi}](${t.linkki})\n${hintaFn(t).toFixed(2)} ${yksikko} · ${t.tyyppi || "?"} · ${t.alkoholi_prosentti}% · ${t.tilavuus_litraa} L`
  ).join("\n\n");
}

/* --- TRACKMANIA --- */

const TM_UA = "discord-bot-savu / savu-bot / contact@example.com";
let tmToken = null;
let tmTokenExpiry = 0;
let tmOAuthToken = null;
let tmOAuthExpiry = 0;

async function haeTMToken() {
  if (tmToken && Date.now() < tmTokenExpiry) return tmToken;
  try {
    const creds = Buffer.from(`${TM_LOGIN}:${TM_PASSWORD}`).toString("base64");
    const { data } = await axios.post(
      "https://prod.trackmania.core.nadeo.online/v2/authentication/token/basic",
      { audience: "NadeoLiveServices" },
      { headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${creds}`,
        "User-Agent": TM_UA
      }}
    );
    tmToken = data.accessToken;
    tmTokenExpiry = Date.now() + 55 * 60 * 1000;
    return tmToken;
  } catch (err) {
    console.error("TM auth virhe:", err.response?.status, err.message);
    return null;
  }
}

async function haeTMOAuthToken() {
  if (tmOAuthToken && Date.now() < tmOAuthExpiry) return tmOAuthToken;
  try {
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: TM_OAUTH_ID,
      client_secret: TM_OAUTH_SECRET,
    });
    const { data } = await axios.post(
      "https://api.trackmania.com/api/access_token",
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": TM_UA } }
    );
    tmOAuthToken = data.access_token;
    tmOAuthExpiry = Date.now() + (data.expires_in - 60) * 1000;
    console.log("TM OAuth token uusittu.");
    return tmOAuthToken;
  } catch (err) {
    console.error("TM OAuth auth virhe:", err.response?.status, err.message);
    return null;
  }
}

function tmHeaders(token) {
  return { "Authorization": `nadeo_v1 t=${token}`, "User-Agent": TM_UA };
}

async function haeKlubi(nimi) {
  const token = await haeTMToken();
  if (!token) return null;
  try {
    const { data } = await axios.get(
      `https://live-services.trackmania.nadeo.live/api/token/club?length=10&offset=0&name=${encodeURIComponent(nimi)}`,
      { headers: tmHeaders(token) }
    );
    return data.clubList?.[0] || null;
  } catch (err) {
    console.error("haeKlubi virhe:", err.response?.status, err.message);
    return null;
  }
}

async function haeKlubiJasenet(clubId) {
  const token = await haeTMToken();
  if (!token) return null;
  try {
    const { data } = await axios.get(
      `https://live-services.trackmania.nadeo.live/api/token/club/${clubId}/member?length=250&offset=0`,
      { headers: tmHeaders(token) }
    );
    console.log(`haeKlubiJasenet: löytyi ${data.clubMemberList?.length ?? 0} jäsentä (itemCount: ${data.itemCount})`);
    return data.clubMemberList || [];
  } catch (err) {
    console.error("haeKlubiJasenet virhe:", err.response?.status, err.message);
    return null;
  }
}

async function haeTrophyRankingit(accountIds) {
  const token = await haeTMToken();
  if (!token) return null;
  try {
    const { data } = await axios.post(
      "https://live-services.trackmania.nadeo.live/api/token/leaderboard/trophy/player",
      { listPlayer: accountIds.map(id => ({ accountId: id })) },
      { headers: { ...tmHeaders(token), "Content-Type": "application/json" } }
    );
    return data.rankings || [];
  } catch (err) {
    console.error("haeTrophyRankingit virhe:", err.response?.status, err.message);
    return null;
  }
}

async function haeNimet(accountIds) {
  const token = await haeTMOAuthToken();
  if (!token) return Object.fromEntries(accountIds.map(id => [id, id.slice(0, 8)]));
  try {
    const erissä = [];
    for (let i = 0; i < accountIds.length; i += 50) erissä.push(accountIds.slice(i, i + 50));
    const tulokset = await Promise.all(erissä.map(erä => {
      const params = erä.map(id => `accountId[]=${encodeURIComponent(id)}`).join("&");
      return axios.get(
        `https://api.trackmania.com/api/display-names?${params}`,
        { headers: { "Authorization": `Bearer ${token}`, "User-Agent": TM_UA } }
      ).then(r => r.data).catch(() => ({}));
    }));
    return Object.assign({}, ...tulokset);
  } catch (err) {
    console.error("haeNimet virhe:", err.response?.status, err.message);
    return Object.fromEntries(accountIds.map(id => [id, id.slice(0, 8)]));
  }
}

async function haeWeeklyShorts() {
  const token = await haeTMToken();
  if (!token) return null;
  try {
    const { data } = await axios.get(
      "https://live-services.trackmania.nadeo.live/api/campaign/weekly-shorts?length=1&offset=0",
      { headers: tmHeaders(token) }
    );
    return data.campaignList?.[0] || null;
  } catch (err) {
    console.error("haeWeeklyShorts virhe:", err.response?.status, err.message);
    return null;
  }
}

async function haeKarttaTuloksetKlubille(groupUid, mapUid, clubId) {
  const token = await haeTMToken();
  if (!token) return null;
  try {
    const { data } = await axios.get(
      `https://live-services.trackmania.nadeo.live/api/token/leaderboard/group/${groupUid}/map/${mapUid}/club/${clubId}/top?length=10&offset=0`,
      { headers: tmHeaders(token) }
    );
    return data.top || [];
  } catch (err) {
    console.error("haeKarttaTuloksetKlubille virhe:", err.response?.status, err.message);
    return [];
  }
}

async function haeKlubiKampanjat(clubId) {
  const token = await haeTMToken();
  if (!token) return null;
  try {
    const { data } = await axios.get(
      `https://live-services.trackmania.nadeo.live/api/token/club/${clubId}/campaign?length=20&offset=0`,
      { headers: tmHeaders(token) }
    );
    return data.clubCampaignList || [];
  } catch (err) {
    console.error("haeKlubiKampanjat virhe:", err.response?.status, err.message);
    return null;
  }
}

async function haeKlubiHuoneet(clubId) {
  const token = await haeTMToken();
  if (!token) return null;
  try {
    const { data } = await axios.get(
      `https://live-services.trackmania.nadeo.live/api/token/club/${clubId}/room?length=20&offset=0`,
      { headers: tmHeaders(token) }
    );
    return data.clubRoomList || [];
  } catch (err) {
    console.error("haeKlubiHuoneet virhe:", err.response?.status, err.message);
    return null;
  }
}

async function haeKlubiAktiviteetit(clubId) {
  const token = await haeTMToken();
  if (!token) return null;
  try {
    const { data } = await axios.get(
      `https://live-services.trackmania.nadeo.live/api/token/club/${clubId}/activity?length=30&offset=0&active=true`,
      { headers: tmHeaders(token) }
    );
    return data.activityList || [];
  } catch (err) {
    console.error("haeKlubiAktiviteetit virhe:", err.response?.status, err.message);
    return null;
  }
}



const YF_HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

async function haeOsakeTicker(haku) {
  // Jos näyttää jo tickeriltä, käytetään suoraan
  if (/^[A-Z0-9.\-]{1,10}$/.test(haku.trim())) return haku.trim().toUpperCase();
  try {
    const { data } = await axios.get(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(haku)}&quotesCount=5&newsCount=0&listsCount=0`,
      { headers: YF_HEADERS }
    );
    const osakkeet = (data.quotes || []).filter(q => q.quoteType === "EQUITY");
    return osakkeet[0]?.symbol || null;
  } catch { return null; }
}

async function haeOsaketiedot(ticker, range = "1mo") {
  try {
    const interval = range === "5d" ? "1h" : range === "1mo" ? "1d" : range === "3mo" ? "1d" : "1wk";
    const { data } = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`,
      { headers: YF_HEADERS }
    );
    const res = data.chart?.result?.[0];
    if (!res) return null;
    const timestamps = res.timestamp || [];
    const closes = res.indicators.quote[0].close || [];
    const meta = res.meta;
    return {
      nimi: meta.longName || meta.shortName || ticker,
      ticker: meta.symbol,
      valuutta: meta.currency,
      hinta: meta.regularMarketPrice,
      muutos: meta.regularMarketPrice - meta.chartPreviousClose,
      muutosProsentti: ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100),
      pisteet: timestamps.map((ts, i) => ({
        pvm: new Date(ts * 1000),
        hinta: closes[i]
      })).filter(p => p.hinta != null)
    };
  } catch { return null; }
}

function piirraOsakeGraafi(pisteet, nimi, valuutta) {
  const W = 800, H = 400, PAD = { top:40, right:20, bottom:50, left:70 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#2b2d31";
  ctx.fillRect(0, 0, W, H);

  const hinnat = pisteet.map(p => p.hinta);
  const minH = Math.min(...hinnat), maxH = Math.max(...hinnat);
  const range = maxH - minH || 1;
  const nousee = hinnat.at(-1) >= hinnat[0];

  // Y-akselille väljyyttä ylös ja alas, jotta korkeimman/matalimman pisteen hintaluku mahtuu piirtoalueelle
  const yMin = minH - range * 0.12, yRange = range * 1.24;
  const toX = i => PAD.left + (i / (pisteet.length - 1)) * cw;
  const toY = v => PAD.top + ch - ((v - yMin) / yRange) * ch;

  // Vaakaviivat ja y-akselitunnisteet
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const v = yMin + (yRange / 4) * (4 - i);
    const y = PAD.top + (ch / 4) * i;
    ctx.strokeStyle = "#3f4147";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cw, y); ctx.stroke();
    ctx.fillStyle = "#9b9d9f";
    ctx.fillText(v.toFixed(2), PAD.left - 6, y + 4);
  }

  // Täyttöalue
  const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + ch);
  grad.addColorStop(0, nousee ? "rgba(87,242,135,0.25)" : "rgba(237,66,69,0.25)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(toX(0), PAD.top + ch);
  pisteet.forEach((p, i) => ctx.lineTo(toX(i), toY(p.hinta)));
  ctx.lineTo(toX(pisteet.length - 1), PAD.top + ch);
  ctx.closePath();
  ctx.fill();

  // Viiva
  ctx.strokeStyle = nousee ? "#57f287" : "#ed4245";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  pisteet.forEach((p, i) => i === 0 ? ctx.moveTo(toX(i), toY(p.hinta)) : ctx.lineTo(toX(i), toY(p.hinta)));
  ctx.stroke();

  // Hintaluvut avainpisteisiin: loppu (nykyhinta), korkein, matalin ja alku — tässä tärkeysjärjestyksessä,
  // jotta päällekkäin osuvista luvuista jätetään pois vähiten tärkeä. Matalimman luku piirretään pisteen alle,
  // muut yläpuolelle. Tumma tausta pitää luvun luettavana, vaikka viiva kulkisi sen takaa.
  const viimeinen = pisteet.length - 1;
  const maxIdx = hinnat.indexOf(maxH), minIdx = hinnat.indexOf(minH);
  const avainpisteet = [...new Set([viimeinen, maxIdx, minIdx, 0])];
  const piirretyt = [];
  ctx.font = "bold 13px sans-serif";
  avainpisteet.forEach(i => {
    const teksti = hinnat[i].toFixed(2);
    const leveys = ctx.measureText(teksti).width + 8, korkeus = 18;
    const px = toX(i), py = toY(hinnat[i]);
    const alle = i === minIdx && i !== maxIdx;
    const x = Math.min(Math.max(px - leveys / 2, PAD.left), PAD.left + cw - leveys);
    const y = alle ? py + 8 : py - 8 - korkeus;
    if (piirretyt.some(r => x < r.x + r.leveys && r.x < x + leveys && y < r.y + r.korkeus && r.y < y + korkeus)) return;
    piirretyt.push({ x, y, leveys, korkeus });

    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(30,31,34,0.85)";
    ctx.beginPath(); ctx.roundRect(x, y, leveys, korkeus, 4); ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.fillText(teksti, x + leveys / 2, y + 13);
  });

  // X-akselitunnisteet (max 6 tasaisesti)
  const xMerkki = Math.max(1, Math.floor(pisteet.length / 6));
  ctx.fillStyle = "#9b9d9f";
  ctx.textAlign = "center";
  ctx.font = "11px sans-serif";
  pisteet.forEach((p, i) => {
    // Viimeinen piste saa aina oman tunnisteensa, joten sitä liian lähellä oleva väli-tunniste jätetään pois
    if ((i % xMerkki === 0 && i <= pisteet.length - 1 - xMerkki / 2) || i === pisteet.length - 1) {
      const label = p.pvm.toLocaleDateString("fi-FI", { day:"2-digit", month:"2-digit" });
      ctx.fillText(label, toX(i), H - PAD.bottom + 18);
    }
  });

  // Otsikko
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 14px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(nimi, PAD.left, 24);
  ctx.fillStyle = "#9b9d9f";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(valuutta, W - PAD.right, 24);

  return canvas.toBuffer("image/png");
}

/* --- PRO PILKKI 2 --- */

function rakennaPp2Viesti(palvelin) {
  const liittymisUrl = `http://${palvelin.ip}:${palvelin.portti}`;

  const embed = new EmbedBuilder()
    .setTitle(`🎣 ${palvelin.nimi}`)
    .setColor(0x2f81f7)
    .setDescription("\"Liity\"-nappi avaa palvelimen liittymislinkin — käynnistääkö se Pro Pilkki 2:n suoraan riippuu siitä, onko linkkityyppi rekisteröity pelin/selaimen kautta koneellasi.")
    .addFields(
      { name:"🌐 Osoite", value:`${palvelin.ip}:${palvelin.portti}`, inline:true },
      { name:"👥 Pelaajia", value: palvelin.pelaajat || "?", inline:true },
      { name:"🗺️ Kartta", value: palvelin.kartta || "?", inline:true },
      { name:"⏱️ Uptime", value: palvelin.uptime || "?", inline:true },
      { name:"🧩 Versio", value: palvelin.versio || "?", inline:true },
      { name:"🌍 Maa", value: palvelin.maa || "?", inline:true }
    )
    .setFooter({ text: "Onnea pilkille." });

  const nappi = new ButtonBuilder().setLabel("🎣 Liity").setStyle(ButtonStyle.Link).setURL(liittymisUrl);
  const nettisivuNappi = new ButtonBuilder().setLabel("🎣 Suljettu osasto").setStyle(ButtonStyle.Link).setURL("https://tate.stream/pp2");
  const row = new ActionRowBuilder().addComponents(nappi, nettisivuNappi);

  return { embeds:[embed], components:[row] };
}

async function suoritaTmServeri(interaction) {
  await interaction.deferReply({ flags: 64 });
  const tila = await haeOmaTMPalvelinTila();
  if (!tila) {
    return interaction.editReply("Trackmania-palvelimen tilaa ei saatu haettua juuri nyt — palvelin voi olla tilapäisesti pois päältä.");
  }

  const embed = new EmbedBuilder()
    .setTitle(`🏁 ${tila.serverName}`)
    .setColor(0x2f81f7)
    .addFields(
      { name:"🗺️ Kartta", value: tila.mapName, inline:true },
      { name:"🎨 Ympäristö", value: tila.environment, inline:true },
      { name:"👥 Pelaajia", value: `${tila.playerCount} / ${tila.maxPlayers}`, inline:true },
      // Discordin Link-napit hyväksyvät vain http/https/discord-protokollat, joten
      // trackmania://-liittymislinkkiä ei voi laittaa napiksi — pelkkänä tekstinä Discord
      // silti usein linkittää sen automaattisesti jos pelin protokollakäsittelijä on asennettu.
      { name:"🔗 Liity", value: `${TM_JOIN_URL}\nTai hae palvelinlistalta nimellä **${tila.serverName}**.` }
    )
    .setFooter({ text: "Savu — kotipalvelin" });
  if (tila.comment) embed.setDescription(tila.comment);

  const nappi = new ButtonBuilder().setLabel("Savu Trackmania").setStyle(ButtonStyle.Link).setURL("https://tate.stream/trackmania");
  const row = new ActionRowBuilder().addComponents(nappi);

  return interaction.editReply({ embeds:[embed], components:[row] });
}

/* --- TRACKMANIA-UUTISET --- */

// trackmania.com/news listaa uutiset kortteina (uusin ensin); update-kategoria on oma sivunsa.
// Molemmat haetaan ja yhdistetään artikkelin ID:n perusteella, jotta päivitykset tunnistetaan
// varmasti, vaikka ne putoaisivat kaikkien uutisten listalta. Huom: listan järjestys on
// julkaisupäivän mukainen, ei ID:n — uusien tunnistus tehdään siksi nähtyjen ID:iden joukolla.
const TM_UUTISET_URL = "https://www.trackmania.com/news";
const TM_PAIVITYKSET_URL = "https://www.trackmania.com/news/category/update";
const TM_UUTISET_CACHE_MS = 10 * 60 * 1000;
const TM_HEADERS = { "User-Agent": "Mozilla/5.0 (savu-botti)", "Accept-Language": "en" };
let tmUutisetCache = { aika: 0, data: null };
const tmKuvausCache = new Map();

// Kortin päiväys tulee kielestä riippuen muodossa "Oct 9, 2026" tai "09.10.2026" → aina "9.10.2026".
function tmPaiva(teksti) {
  const pvm = teksti.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  const aika = pvm ? Date.UTC(pvm[3], pvm[2] - 1, pvm[1]) : Date.parse(`${teksti} UTC`);
  return Number.isNaN(aika) ? teksti : new Date(aika).toLocaleDateString("fi-FI", { timeZone: "UTC" });
}

function jasennaTmUutiskortit(html) {
  const $ = cheerio.load(html);
  return $(".card").toArray().map(el => {
    const kortti = $(el);
    const linkki = kortti.find("a.stretched-link");
    const id = (linkki.attr("href") || "").match(/\/news\/(\d+)$/)?.[1];
    if (!id) return null;
    return {
      id,
      otsikko: linkki.text().trim(),
      url: `${TM_UUTISET_URL}/${id}`,
      kuva: kortti.find("img.card-img-top").attr("src") || null,
      paiva: tmPaiva(kortti.find("small").first().text().trim()),
      kategoriat: kortti.find(".badge").toArray().map(b => $(b).text().trim()).filter(Boolean)
    };
  }).filter(Boolean);
}

// Palauttaa { uutiset, paivitykset } (molemmat uusin ensin) tai null virheessä.
async function haeTmUutiset(ohitaValimuisti = false) {
  if (!ohitaValimuisti && tmUutisetCache.data && Date.now() - tmUutisetCache.aika < TM_UUTISET_CACHE_MS) return tmUutisetCache.data;
  try {
    const [kaikki, paivitys] = await Promise.all([TM_UUTISET_URL, TM_PAIVITYKSET_URL].map(url =>
      axios.get(url, { headers: TM_HEADERS, timeout: 10000 }).then(r => jasennaTmUutiskortit(r.data))
    ));
    if (!kaikki.length) throw new Error("uutislista tyhjä — sivun rakenne muuttunut?");
    const paivitysIdt = new Set(paivitys.map(u => u.id));
    for (const u of kaikki) u.paivitys = paivitysIdt.has(u.id) || u.kategoriat.includes("Update");
    for (const u of paivitys) u.paivitys = true;
    const data = { uutiset: kaikki, paivitykset: paivitys };
    tmUutisetCache = { aika: Date.now(), data };
    return data;
  } catch (err) {
    console.error("haeTmUutiset virhe:", err.message);
    return null;
  }
}

// Ingressi artikkelin rungon alusta (otsikot, kappaleet, listat riveittäin — og:description
// liimaa kappaleet yhteen ilman välejä, joten se on vain varalla). Puuttuminen ei estä embediä.
const TM_KUVAUS_MAX = 500;

function tmArtikkelinIngressi($) {
  const rivit = [];
  let pituus = 0;
  for (const el of $("main .col-12").first().find("h1, h2, h3, h4, p, li").toArray()) {
    const teksti = $(el).text().replace(/\s+/g, " ").trim();
    if (!teksti || teksti.startsWith("Tags:")) continue;
    const tagi = el.tagName.toLowerCase();
    rivit.push(tagi === "li" ? `• ${teksti}` : /^h\d$/.test(tagi) ? `**${teksti}**` : teksti);
    pituus += teksti.length;
    if (pituus > TM_KUVAUS_MAX) break;
  }
  return rivit.join("\n");
}

async function haeTmUutisenKuvaus(uutinen) {
  if (tmKuvausCache.has(uutinen.id)) return tmKuvausCache.get(uutinen.id);
  try {
    const { data } = await axios.get(uutinen.url, { headers: TM_HEADERS, timeout: 10000 });
    const $ = cheerio.load(data);
    const kuvaus = tmArtikkelinIngressi($) || $('meta[property="og:description"]').attr("content")?.trim() || "";
    tmKuvausCache.set(uutinen.id, kuvaus);
    return kuvaus;
  } catch (err) {
    console.error(`TM-uutisen ${uutinen.id} kuvauksen haku epäonnistui:`, err.message);
    return "";
  }
}

// Yhteinen /tm n- ja /tm u-komennoille sekä automaattiselle postaukselle. aiemmat = lista
// vanhemmista uutisista, jotka näytetään linkkeinä (vain komennossa).
async function rakennaTmUutisEmbed(uutinen, aiemmat = []) {
  const kuvaus = await haeTmUutisenKuvaus(uutinen);
  const embed = new EmbedBuilder()
    .setColor(uutinen.paivitys ? 0x00c853 : 0x2f81f7)
    .setAuthor({ name: uutinen.paivitys ? "🛠️ Trackmania-päivitys" : "📰 Trackmania-uutinen" })
    .setTitle(uutinen.otsikko.slice(0, 256))
    .setURL(uutinen.url)
    .setFooter({ text: `Lähde: trackmania.com · ${uutinen.paiva}` + (uutinen.kategoriat.length ? ` · ${uutinen.kategoriat.join(", ")}` : "") });
  if (kuvaus) embed.setDescription(kuvaus.length > TM_KUVAUS_MAX ? kuvaus.slice(0, TM_KUVAUS_MAX).trimEnd() + "…" : kuvaus);
  if (uutinen.kuva) embed.setImage(uutinen.kuva);
  if (aiemmat.length) {
    embed.addFields({
      name: "Aiemmat",
      value: aiemmat.map(u => `${u.paiva} — [${u.otsikko.replace(/[[\]]/g, "")}](${u.url})`).join("\n").slice(0, 1024)
    });
  }
  return embed;
}

// sub: "n" = uusin uutinen (kaikki kategoriat), "u" = uusin päivitys (update-kategoria).
async function suoritaTmUutiset(interaction, sub) {
  await interaction.deferReply({ flags: 64 });
  const data = await haeTmUutiset();
  const lista = data && (sub === "u" ? data.paivitykset : data.uutiset);
  if (!lista?.length) {
    return interaction.editReply("Trackmania-uutisten hakeminen epäonnistui. Yritä hetken kuluttua uudelleen.");
  }
  return interaction.editReply({ embeds: [await rakennaTmUutisEmbed(lista[0], lista.slice(1, 5))] });
}

/* --- HELP --- */

const HELP_KATEGORIAT = [
  {
    value: "nimipaivat", label: "Nimipäivät", emoji: "📅",
    description: "Nimipäivät, liputus, joulu- ja juhannuslaskuri sekä DVV-nimihaku",
    fields: [
      { name:"📅 /nimipäivät", value:"Näyttää tämän päivän nimipäivät." },
      { name:"🇫🇮 /liputuspaiva", value:"Näyttää tämän päivän liputuspäivän, jos sellainen on." },
      { name:"🎄 /joulu", value:"Laskee montako päivää on jouluaattoon." },
      { name:"🌿 /juhannus", value:"Laskee montako päivää on juhannusaattoon." },
      { name:"🔍 /nimipaiva [nimi]", value:"Hakee milloin nimen nimipäivä on ja koska se tulee seuraavan kerran." },
      { name:"🎂 /synttarit [haku]", value:"Hakee palvelimen jäsenen syntymäpäivän nimimerkillä, käyttäjänimellä tai user ID:llä." },
      { name:"👤 /nimihaku etu [nimi]", value:"Etunimen haltijamäärä vuosikymmenittäin, suoraan DVV:n nimipalvelusta." },
      { name:"👥 /nimihaku suku [nimi]", value:"Sukunimen haltijamäärä (nykyisenä/entisenä nimenä, kuolleilla), suoraan DVV:n nimipalvelusta." },
    ]
  },
  {
    value: "saa-sahko", label: "Sähkö & sää", emoji: "⚡",
    description: "Pörssisähkö ja säätila",
    fields: [
      { name:"⚡ /sahko [näkymä]", value:"Pörssisähkön hinnat + graafi.\n`yhteenveto` · `matalin` · `kallein` · `kaikki` · `kuukausi` (tämä kk vs viime kk) · `huomenna` (jos julkaistu)" },
      { name:"🌤️ /saa [kaupunki] (tai /sää)", value:"Näyttää kaupungin säätilan: lämpötila, tuuli, kosteus, pilvisyys, näkyvyys, auringonnousu/-lasku, päivän ylin lämpötila ja lumisade." },
    ]
  },
  {
    value: "liikenne", label: "Liikenne", emoji: "🚦",
    description: "Tie-, juna- ja meriliikenteen häiriöt",
    fields: [
      { name:"🚗 /liikenne tie", value:"Tieliikenteen häiriötiedotteet." },
      { name:"🚆 /liikenne juna", value:"Myöhässä olevat kaukojunat." },
      { name:"⚓ /liikenne meri", value:"Merenkulun turvalaitteiden viat (poijut, valot ym.)." },
      { name:"🚌 /hsl hairiot", value:"5 viimeisintä HSL:n liikennetiedotetta (Helsingin seudun joukkoliikenne)." },
      { name:"🚏 /hsl pysakki [nimi] [linja]", value:"Seuraavat 5 lähtöä valitulta pysäkiltä: linja, suunta ja kellonaika. Valinnainen `linja` rajaa tiettyyn bussiin." },
    ]
  },
  {
    value: "raha", label: "Osakkeet", emoji: "📈",
    description: "Osakekurssit ja graafit",
    fields: [
      { name:"📈 /osake [haku] [aikaväli]", value:"Osakkeen kurssi ja graafi Yahoo Financesta.\nHae nimellä tai tickerillä (esim. `Nokia`, `AAPL`, `NOKIA.HE`)\nAikaväli: `1 viikko` · `1 kuukausi` · `3 kuukautta` · `1 vuosi` · `5 vuotta`" },
      { name:"₿ /btc [aikaväli]", value:"Bitcoinin kurssi ja graafi (Yahoo Finance, BTC-USD)." },
      { name:"Ξ /eth [aikaväli]", value:"Ethereumin kurssi ja graafi (Yahoo Finance, ETH-USD)." },
    ]
  },
  {
    value: "uni", label: "Uni", emoji: "😴",
    description: "Unipisteiden laskenta",
    fields: [
      { name:"😴 /uni [tunnit] [syva] [kevyt] [rem] [heraamiset]", value:"Laskee unipisteet (0-100) unianalyysisi lukemista." },
    ]
  },
  {
    value: "trackmania", label: "Trackmania", emoji: "🏆",
    description: "Klubien tiedot, rankingit ja trackmania.com-uutiset",
    fields: [
      { name:"🏆 /tm ranking <klubi>", value:"Top-15 trophy-ranking klubin sisällä." },
      { name:"ℹ️ /tm info <klubi>", value:"Klubin perustiedot: ID, tag, jäsenmäärä, suosio." },
      { name:"📋 /tm kampanjat <klubi>", value:"Klubin kampanjat karttalukuineen ja julkaisupäivineen." },
      { name:"🖥️ /tm huoneet <klubi>", value:"Klubin serverit ja aktiiviset pelaajamäärät." },
      { name:"📂 /tm aktiviteetit <klubi>", value:"Kaikki klubin aktiviteetit (kampanjat, huoneet, uutiset, kilpailut)." },
      { name:"⏱️ /tm shorts <klubi>", value:"Tämän viikon Weekly Shorts -tulokset klubin sisällä, kartoittain." },
      { name:"🏁 /tm serveri", value:"Savun oman Trackmania-palvelimen tila (kartta, pelaajat) ja liittymisnappi." },
      { name:"📰 /tm n", value:"Uusin uutinen trackmania.com:sta (+ muutama aiempi linkkeinä)." },
      { name:"🛠️ /tm u", value:"Uusin päivitys (Update-kategoria) trackmania.com:sta." },
    ]
  },
  {
    value: "uutiset", label: "Uutiset", emoji: "📰",
    description: "Ampparit.com-uutiset ja Tilannehuone.fi",
    fields: [
      { name:"📰 /uutiset luetuimmat", value:"5 luetuinta uutista juuri nyt Ampparit.com:sta." },
      { name:"🆕 /uutiset uusimmat", value:"5 uusinta uutista juuri nyt Ampparit.com:sta." },
      { name:"📰 /th uusimmat", value:"Tilannehuone.fi:n 10 uusinta uutista (etusivun Uusimmat)." },
      { name:"🚨 /th lista", value:"Tilannehuone.fi:n hälytyslistan 10 viimeisintä hälytystä." },
      { name:"📍 /th haku <paikkakunta> [km]", value:"Viimeisimmät hälytykset paikkakunnan ympäriltä (oletus 100 km säde), arvioidun etäisyyden kanssa." },
    ]
  },
  {
    value: "viihde", label: "Viihde", emoji: "🎬",
    description: "Päivän TV-elokuvat, Lotto ja Eurojackpot",
    fields: [
      { name:"🎬 /leffat [milloin]", value:"Päivän TV-elokuvat kanavittain (Iltalehti/Telkku). `tänään` (oletus) tai `huomenna`." },
      { name:"🎱 /lotto", value:"Viimeisimmän Lotto-arvonnan oikea rivi, lisänumero, Plus-numero ja voitonjako (Veikkaus)." },
      { name:"⭐ /eurojaska", value:"Viimeisimmän Eurojackpot-arvonnan oikea rivi, tähtinumerot, voitonjako sekä seuraavan arvonnan aika ja arvioitu päävoitto (Veikkaus, potti rahapelisanomat.fi)." },
    ]
  },
  {
    value: "pp2", label: "Pro Pilkki 2", emoji: "🎣",
    description: `"${PP2_PALVELIN_NIMI}" -palvelimen tila`,
    fields: [
      { name:"🎣 /pp2", value:`Näyttää "${PP2_PALVELIN_NIMI}" -palvelimen pelaajamäärän, kartan ja liittymislinkin.` },
    ]
  },
  {
    value: "wow", label: "WoW Forever", emoji: "⚔️",
    description: "Laskuri WoW Foreverin julkaisuun",
    fields: [
      { name:"⚔️ /wow", value:"Näyttää paljonko aikaa on WoW Foreverin julkaisuun (5.11. klo 00.00 CET). Botin ylläpitäjä voi kytkeä config.json:ssa muistutukset tälle, joulu- ja juhannuslaskurille sekä omille laskureille." },
    ]
  },
  {
    value: "alko", label: "Alko", emoji: "🍺",
    description: "Alkon hintavertailu (juomaan.fi)",
    fields: [
      { name:"🍺 /alko halvinhinta", value:"5 halvinta tuotetta kokonaishinnalla mitattuna." },
      { name:"🍻 /alko halvinannos", value:"5 halvinta tuotetta €/annos-hinnalla mitattuna." },
      { name:"🥂 /alko dokaviteetti", value:"Sama kuin halvinannos — paras alkoholimäärä per euro." },
    ]
  },
  {
    value: "ai", label: "AI-tunnistus", emoji: "🤖",
    description: "Onko kuva tai ääni tekoälyn tekemä? (OpenAI Content Provenance)",
    fields: [
      { name:"🤖 /ai tiedosto:<liite>", value:"Tarkistaa ladatusta kuvasta (PNG/JPEG/WebP) tai äänestä (MP3/Opus/AAC/FLAC/WAV, max 60 s) AI-merkinnät: OpenAI:n C2PA-allekirjoituksen ja SynthID-vesileiman." },
      { name:"🔗 /ai linkki:<osoite>", value:"Sama linkin takaa löytyvälle tiedostolle. Nettisivulle kokeillaan sen esikatselukuvaa (og:image)." },
      { name:"⚠️ Huom.", value:"Jos merkintää ei löydy, sisältö voi silti olla AI:n tekemä — merkinnät katoavat esim. kuvakaappauksessa ja uudelleenpakkauksessa." },
    ]
  },
  {
    value: "tila", label: "Botin tila", emoji: "🖥️",
    description: "Isäntäkoneen käyntiaika ja kuormitus",
    fields: [
      { name:"🖥️ /uptime", value:"Näyttää botin isäntäkoneen käyntiajan ja kuormitusasteen (load average), selitteineen." },
    ]
  },
];

function rakennaHelpEmbed(valittu) {
  const kategoria = HELP_KATEGORIAT.find(k => k.value === valittu) || HELP_KATEGORIAT[0];
  return new EmbedBuilder()
    .setTitle(`📖 Komennot — ${kategoria.emoji} ${kategoria.label}`)
    .addFields(...kategoria.fields)
    .setFooter({ text:"💬 Näkyy vain sinulle. Valitse toinen kategoria alta. 🐾 Vinkki: /savu antaa saman valikon, mutta suorittaa valitun komennon suoraan." });
}

function rakennaHelpValikko(valittu) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("help-kategoria")
      .setPlaceholder("Valitse kategoria")
      .addOptions(HELP_KATEGORIAT.map(k => ({
        label: k.label, value: k.value, description: k.description, emoji: k.emoji, default: k.value === valittu
      })))
  );
}

/* --- SAVU (dropdown-valikko, joka SUORITTAA valitun komennon) ---
   Toisin kuin /help (joka vain selostaa komennot), /savu ajaa valitun komennon oikeasti.
   Komennot ilman pakollisia parametrejä ajetaan suoraan valinnasta; parametrejä vaativat
   avaavat Discordin modal-lomakkeen (max 5 tekstikenttää/modal, siksi esim. /uni sopii
   juuri ja juuri yhteen modaliin). /sahko ja /osake ajetaan oletusnäkymällä/-aikavälillä,
   koska Discordin modal ei tue valintalistoja — muut näkymät saa edelleen suoraan /sahko:lla. */
const SAVU_KATEGORIAT = [
  {
    value: "nimipaivat", label: "Nimipäivät", emoji: "📅",
    toiminnot: [
      { value:"nimipäivät", label:"Nimipäivät", emoji:"📅", args:[] },
      { value:"liputuspaiva", label:"Liputuspäivä", emoji:"🇫🇮", args:[] },
      { value:"joulu", label:"Päiviä jouluun", emoji:"🎄", args:[] },
      { value:"juhannus", label:"Päiviä juhannukseen", emoji:"🌿", args:[] },
      { value:"nimipaiva", label:"Nimipäivähaku", emoji:"🔍",
        args:[{ key:"nimi", label:"Nimi", placeholder:"esim. Matti" }] },
      { value:"synttarit", label:"Syntymäpäivähaku", emoji:"🎂",
        args:[{ key:"haku", label:"Nimimerkki, käyttäjänimi tai ID", placeholder:"esim. Matti" }] },
      { value:"nimihaku-etu", label:"Etunimihaku (DVV)", emoji:"👤",
        args:[{ key:"nimi", label:"Etunimi", placeholder:"esim. Kukka-Maaria" }] },
      { value:"nimihaku-suku", label:"Sukunimihaku (DVV)", emoji:"👥",
        args:[{ key:"nimi", label:"Sukunimi", placeholder:"esim. Virtanen" }] },
    ]
  },
  {
    value: "saa-sahko", label: "Sähkö & sää", emoji: "⚡",
    toiminnot: [
      { value:"sahko", label:"Sähkön hinta (yhteenveto)", emoji:"⚡", args:[] },
      { value:"saa", label:"Sää", emoji:"🌤️",
        args:[{ key:"kaupunki", label:"Kaupunki", placeholder:"esim. Helsinki" }] },
    ]
  },
  {
    value: "liikenne", label: "Liikenne", emoji: "🚦",
    toiminnot: [
      { value:"liikenne-tie", label:"Tieliikenne", emoji:"🚗", args:[] },
      { value:"liikenne-juna", label:"Junaliikenne", emoji:"🚆", args:[] },
      { value:"liikenne-meri", label:"Merenkulku", emoji:"⚓", args:[] },
      { value:"hsl-hairiot", label:"HSL-häiriöt", emoji:"🚌", args:[] },
      { value:"hsl-pysakki", label:"HSL-pysäkin lähdöt", emoji:"🚏",
        args:[{ key:"nimi", label:"Pysäkin nimi", placeholder:"esim. Kamppi" }] },
    ]
  },
  {
    value: "raha", label: "Osakkeet", emoji: "📈",
    toiminnot: [
      { value:"osake", label:"Osakekurssi", emoji:"📈",
        args:[{ key:"haku", label:"Yhtiön nimi tai ticker", placeholder:"esim. Nokia, AAPL, NOKIA.HE" }] },
      { value:"btc", label:"Bitcoin (BTC-USD)", emoji:"₿", args:[] },
      { value:"eth", label:"Ethereum (ETH-USD)", emoji:"Ξ", args:[] },
    ]
  },
  {
    value: "lampo", label: "Lämpötila", emoji: "🌡️",
    toiminnot: [
      { value:"lampo-koti", label:"Kodin lämpötila", emoji:"🏠", args:[] },
      { value:"lampo-savu", label:"Savun sisäinen lämpötila", emoji:"🐾", args:[] },
    ]
  },
  {
    value: "alko", label: "Alko", emoji: "🍺",
    toiminnot: [
      { value:"alko-halvinhinta", label:"Halvin hinta", emoji:"🍺", args:[] },
      { value:"alko-halvinannos", label:"Halvin annos", emoji:"🍻", args:[] },
      { value:"alko-dokaviteetti", label:"Dokaviteetti", emoji:"🥂", args:[] },
    ]
  },
  {
    value: "uni", label: "Uni", emoji: "😴",
    toiminnot: [
      { value:"uni", label:"Laske unipisteet", emoji:"😴", args:[
        { key:"tunnit", label:"Aika vuoteessa, tunnit (esim. 6.3)", placeholder:"6.3" },
        { key:"syva", label:"Syvä uni, %", placeholder:"20" },
        { key:"kevyt", label:"Kevyt uni, %", placeholder:"55" },
        { key:"rem", label:"REM-uni, %", placeholder:"20" },
        { key:"heraamiset", label:"Heräämiskerrat", placeholder:"2" },
      ]},
    ]
  },
  {
    value: "trackmania", label: "Trackmania", emoji: "🏆",
    toiminnot: [
      { value:"tm-ranking", label:"Trophy-ranking", emoji:"🏆", args:[{ key:"klubi", label:"Klubin nimi", placeholder:"esim. Trackmania" }] },
      { value:"tm-info", label:"Klubin tiedot", emoji:"ℹ️", args:[{ key:"klubi", label:"Klubin nimi", placeholder:"esim. Trackmania" }] },
      { value:"tm-kampanjat", label:"Kampanjat", emoji:"📋", args:[{ key:"klubi", label:"Klubin nimi", placeholder:"esim. Trackmania" }] },
      { value:"tm-huoneet", label:"Huoneet", emoji:"🖥️", args:[{ key:"klubi", label:"Klubin nimi", placeholder:"esim. Trackmania" }] },
      { value:"tm-aktiviteetit", label:"Aktiviteetit", emoji:"📂", args:[{ key:"klubi", label:"Klubin nimi", placeholder:"esim. Trackmania" }] },
      { value:"tm-shorts", label:"Weekly Shorts", emoji:"⏱️", args:[{ key:"klubi", label:"Klubin nimi", placeholder:"esim. Trackmania" }] },
      { value:"tm-serveri", label:"Savun oma TM-palvelin", emoji:"🏁", args:[] },
      { value:"tm-n", label:"Uusin uutinen", emoji:"📰", args:[] },
      { value:"tm-u", label:"Uusin päivitys", emoji:"🛠️", args:[] },
    ]
  },
  {
    value: "uutiset", label: "Uutiset", emoji: "📰",
    toiminnot: [
      { value:"uutiset-luetuimmat", label:"Luetuimmat", emoji:"🔥", args:[] },
      { value:"uutiset-uusimmat", label:"Uusimmat", emoji:"🆕", args:[] },
      { value:"th-uusimmat", label:"Tilannehuone — uusimmat", emoji:"📰", args:[] },
      { value:"th-lista", label:"Tilannehuone — hälytyslista", emoji:"🚨", args:[] },
      { value:"th-haku", label:"Tilannehuone — hälytykset lähelläsi", emoji:"📍", args:[{ key:"paikkakunta", label:"Paikkakunta", placeholder:"esim. Nurmijärvi" }] },
    ]
  },
  {
    value: "lotto", label: "Lotto & Eurojackpot", emoji: "🎱",
    toiminnot: [
      { value:"lotto", label:"Lotto — viimeisin oikea rivi", emoji:"🎱", args:[] },
      { value:"eurojaska", label:"Eurojackpot — viimeisin oikea rivi", emoji:"⭐", args:[] },
    ]
  },
  {
    value: "pp2", label: "Pro Pilkki 2", emoji: "🎣",
    toiminnot: [
      { value:"pp2", label:"Palvelimen tila", emoji:"🎣", args:[] },
    ]
  },
  {
    value: "wow", label: "WoW Forever", emoji: "⚔️",
    toiminnot: [
      { value:"wow", label:"Aikaa julkaisuun", emoji:"⚔️", args:[] },
    ]
  },
  {
    value: "ai", label: "AI-tunnistus", emoji: "🤖",
    toiminnot: [
      { value:"ai", label:"Onko AI:n tekemä? (linkki)", emoji:"🤖",
        args:[{ key:"linkki", label:"Linkki kuvaan tai äänitiedostoon", placeholder:"https://…" }] },
    ]
  },
  {
    value: "tila", label: "Botin tila", emoji: "🖥️",
    toiminnot: [
      { value:"uptime", label:"Käyntiaika ja kuormitus", emoji:"🖥️", args:[] },
    ]
  },
];

// Kertoo mitä featureä (config.js:n features-avainta) mikin /savu-valinta vastaa, jotta
// config.json:ssa pois kytketty ominaisuus estyy myös /savu:n kautta — sama sääntö kuin suoralla komennolla.
const SAVU_KOMENTO_MAP = {
  "nimipäivät": { cmd:"nimipäivät" },
  "liputuspaiva": { cmd:"liputuspaiva" },
  "joulu": { cmd:"joulu" },
  "juhannus": { cmd:"juhannus" },
  "nimipaiva": { cmd:"nimipaiva" },
  "synttarit": { cmd:"synttarit" },
  "nimihaku-etu": { cmd:"nimihaku", sub:"etu" },
  "nimihaku-suku": { cmd:"nimihaku", sub:"suku" },
  "sahko": { cmd:"sahko" },
  "saa": { cmd:"saa" },
  "liikenne-tie": { cmd:"liikenne", sub:"tie" },
  "liikenne-juna": { cmd:"liikenne", sub:"juna" },
  "liikenne-meri": { cmd:"liikenne", sub:"meri" },
  "hsl-hairiot": { cmd:"hsl", sub:"hairiot" },
  "hsl-pysakki": { cmd:"hsl", sub:"pysakki" },
  "lampo-koti": { cmd:"lampo", sub:"koti" },
  "lampo-savu": { cmd:"lampo", sub:"savu" },
  "alko-halvinhinta": { cmd:"alko", sub:"halvinhinta" },
  "alko-halvinannos": { cmd:"alko", sub:"halvinannos" },
  "alko-dokaviteetti": { cmd:"alko", sub:"dokaviteetti" },
  "osake": { cmd:"osake" },
  "btc": { cmd:"btc" },
  "eth": { cmd:"eth" },
  "uni": { cmd:"uni" },
  "pp2": { cmd:"pp2" },
  "wow": { cmd:"wow" },
  "lotto": { cmd:"lotto" },
  "eurojaska": { cmd:"eurojaska" },
  "uptime": { cmd:"uptime" },
  "ai": { cmd:"ai" },
  "uutiset-luetuimmat": { cmd:"uutiset", sub:"luetuimmat" },
  "uutiset-uusimmat": { cmd:"uutiset", sub:"uusimmat" },
  "th-uusimmat": { cmd:"th", sub:"uusimmat" },
  "th-lista": { cmd:"th", sub:"lista" },
  "th-haku": { cmd:"th", sub:"haku" },
  "tm-ranking": { cmd:"tm", sub:"ranking" },
  "tm-info": { cmd:"tm", sub:"info" },
  "tm-kampanjat": { cmd:"tm", sub:"kampanjat" },
  "tm-huoneet": { cmd:"tm", sub:"huoneet" },
  "tm-aktiviteetit": { cmd:"tm", sub:"aktiviteetit" },
  "tm-shorts": { cmd:"tm", sub:"shorts" },
  "tm-serveri": { cmd:"tm", sub:"serveri" },
  "tm-n": { cmd:"tm", sub:"n" },
  "tm-u": { cmd:"tm", sub:"u" },
};

function loydaSavuToiminto(value) {
  for (const kategoria of SAVU_KATEGORIAT) {
    const t = kategoria.toiminnot.find(t => t.value === value);
    if (t) return t;
  }
  return null;
}

function rakennaSavuEmbed(kategoriaValue) {
  const kategoria = SAVU_KATEGORIAT.find(k => k.value === kategoriaValue) || SAVU_KATEGORIAT[0];
  return new EmbedBuilder()
    .setTitle("🐾 Savu — komentovalikko")
    .setDescription(`Valitse ensin kategoria, sitten komento — botti suorittaa sen suoraan.\nKategoria: **${kategoria.emoji} ${kategoria.label}**`)
    .setFooter({ text:"💬 Näkyy vain sinulle. Osa komennoista avaa pienen lomakkeen ennen ajoa." });
}

function rakennaSavuKategoriaValikko(valittu) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("savu-kategoria")
      .setPlaceholder("Valitse kategoria")
      .addOptions(SAVU_KATEGORIAT.map(k => ({
        label: k.label, value: k.value, emoji: k.emoji, default: k.value === valittu
      })))
  );
}

function rakennaSavuToimintoValikko(kategoriaValue) {
  const kategoria = SAVU_KATEGORIAT.find(k => k.value === kategoriaValue) || SAVU_KATEGORIAT[0];
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("savu-toiminto")
      .setPlaceholder("Valitse komento")
      .addOptions(kategoria.toiminnot.map(t => ({
        label: t.label, value: t.value, emoji: t.emoji
      })))
  );
}

/* --- KOMENNOT --- */

const commands = [
  new SlashCommandBuilder().setName("nimipäivät").setDescription("Näyttää nimipäivät"),
  new SlashCommandBuilder().setName("liputuspaiva").setDescription("Näyttää tämän päivän liputuspäivän, jos sellainen on"),
  new SlashCommandBuilder().setName("joulu").setDescription("Laskee montako päivää on jouluaattoon"),
  new SlashCommandBuilder().setName("juhannus").setDescription("Laskee montako päivää on juhannusaattoon"),
  new SlashCommandBuilder().setName("synttarit").setDescription("Hae palvelimen jäsenen syntymäpäivä")
    .addStringOption(o => o.setName("haku").setDescription("Nimimerkki, käyttäjänimi tai user ID").setRequired(true)),
  new SlashCommandBuilder().setName("nimipaiva").setDescription("Hae milloin nimen nimipäivä on")
    .addStringOption(o => o.setName("nimi").setDescription("Nimi").setRequired(true)),
  new SlashCommandBuilder().setName("nimihaku").setDescription("Hae nimitietoja DVV:n nimipalvelusta")
    .addSubcommand(s => s.setName("etu").setDescription("Hae etunimiä DVV:n nimipalvelusta")
      .addStringOption(o => o.setName("nimi").setDescription("Etunimi (esim. Matti, Kukka-Maaria)").setRequired(true)))
    .addSubcommand(s => s.setName("suku").setDescription("Hae sukunimiä DVV:n nimipalvelusta")
      .addStringOption(o => o.setName("nimi").setDescription("Sukunimi (esim. Virtanen, von Taffelsson)").setRequired(true))),
  new SlashCommandBuilder().setName("sahko").setDescription("Näyttää sähkön hinnan")
    .addStringOption(o => o.setName("näkymä").setDescription("Mitä näytetään").setRequired(false)
      .addChoices(
        { name:"yhteenveto (oletus)", value:"yhteenveto" },
        { name:"matalin – halvimmat tunnit", value:"matalin" },
        { name:"kallein – kalleimmat tunnit", value:"kallein" },
        { name:"kaikki – koko päivän lista", value:"kaikki" },
        { name:"kuukausi – tämä kk vs viime kk", value:"kuukausi" },
        { name:"huomenna – huomisen hinnat (jos julkaistu)", value:"huomenna" },
      )),
  new SlashCommandBuilder().setName("saa").setDescription("Näyttää säätilan")
    .addStringOption(o => o.setName("kaupunki").setDescription("Kaupunki").setRequired(true)),
  new SlashCommandBuilder().setName("sää").setDescription("Näyttää säätilan")
    .addStringOption(o => o.setName("kaupunki").setDescription("Kaupunki").setRequired(true)),
  new SlashCommandBuilder().setName("liikenne").setDescription("Liikennetilanne")
    .addSubcommand(s => s.setName("tie").setDescription("Tieliikenteen häiriötiedotteet"))
    .addSubcommand(s => s.setName("juna").setDescription("Myöhässä olevat kaukojunat"))
    .addSubcommand(s => s.setName("meri").setDescription("Merenkulun turvalaitteiden viat")),
  new SlashCommandBuilder().setName("hsl").setDescription("HSL:n liikennetiedotteet")
    .addSubcommand(s => s.setName("hairiot").setDescription("5 viimeisintä HSL-häiriötiedotetta"))
    .addSubcommand(s => s.setName("pysakki").setDescription("Seuraavat 5 lähtöä pysäkiltä")
      .addStringOption(o => o.setName("nimi").setDescription("Pysäkin nimi (esim. Kamppi)").setRequired(true))
      .addStringOption(o => o.setName("linja").setDescription("Rajaa tiettyyn linjaan (esim. 20)").setRequired(false))),
  new SlashCommandBuilder().setName("lampo").setDescription("Kodin lämpötila")
    .addSubcommand(s => s.setName("koti").setDescription("Hakee asunnon huoneenlämpötilan OmaSATOsta"))
    .addSubcommand(s => s.setName("savu").setDescription("Näyttää Savu-palvelimen sisäisen (SoC) lämpötilan")),
  new SlashCommandBuilder().setName("alko").setDescription("Alkon hintavertailu (juomaan.fi)")
    .addSubcommand(s => s.setName("halvinhinta").setDescription("Halvimmat tuotteet hinnalla mitattuna"))
    .addSubcommand(s => s.setName("halvinannos").setDescription("Halvin alkoholiannos (€/annos)"))
    .addSubcommand(s => s.setName("dokaviteetti").setDescription("Paras dokaviteetti (= halvin alkoholiannos)")),
  new SlashCommandBuilder().setName("osake").setDescription("Näyttää osakkeen kurssin ja graafin")
    .addStringOption(o => o.setName("haku").setDescription("Yhtiön nimi tai ticker (esim. Nokia, AAPL, NOKIA.HE)").setRequired(true))
    .addStringOption(o => o.setName("aikaväli").setDescription("Aikaväli (oletus: 1kk)").setRequired(false)
      .addChoices(
        { name:"1 viikko",  value:"5d"  },
        { name:"1 kuukausi", value:"1mo" },
        { name:"3 kuukautta", value:"3mo" },
        { name:"1 vuosi",   value:"1y"  },
        { name:"5 vuotta",  value:"5y"  },
      )),
  new SlashCommandBuilder().setName("btc").setDescription("Näyttää Bitcoinin kurssin ja graafin")
    .addStringOption(o => o.setName("aikaväli").setDescription("Aikaväli (oletus: 1kk)").setRequired(false)
      .addChoices(
        { name:"1 viikko",  value:"5d"  },
        { name:"1 kuukausi", value:"1mo" },
        { name:"3 kuukautta", value:"3mo" },
        { name:"1 vuosi",   value:"1y"  },
        { name:"5 vuotta",  value:"5y"  },
      )),
  new SlashCommandBuilder().setName("eth").setDescription("Näyttää Ethereumin kurssin ja graafin")
    .addStringOption(o => o.setName("aikaväli").setDescription("Aikaväli (oletus: 1kk)").setRequired(false)
      .addChoices(
        { name:"1 viikko",  value:"5d"  },
        { name:"1 kuukausi", value:"1mo" },
        { name:"3 kuukautta", value:"3mo" },
        { name:"1 vuosi",   value:"1y"  },
        { name:"5 vuotta",  value:"5y"  },
      )),
  new SlashCommandBuilder().setName("uni").setDescription("Laske unipisteet unianalyysin lukemista")
    .addNumberOption(o => o.setName("tunnit").setDescription("Aika vuoteessa, tunnit (esim. 6.3)").setRequired(true).setMinValue(0).setMaxValue(16))
    .addNumberOption(o => o.setName("syva").setDescription("Syvän unen osuus, %").setRequired(true).setMinValue(0).setMaxValue(100))
    .addNumberOption(o => o.setName("kevyt").setDescription("Kevyen unen osuus, %").setRequired(true).setMinValue(0).setMaxValue(100))
    .addNumberOption(o => o.setName("rem").setDescription("REM-unen osuus, %").setRequired(true).setMinValue(0).setMaxValue(100))
    .addIntegerOption(o => o.setName("heraamiset").setDescription("Heräämiskerrat").setRequired(true).setMinValue(0).setMaxValue(30)),
  new SlashCommandBuilder().setName("pp2").setDescription(`Pro Pilkki 2 – "${PP2_PALVELIN_NIMI}" -palvelimen tila`),
  new SlashCommandBuilder().setName("wow").setDescription("Laskuri WoW Foreverin julkaisuun (5.11. klo 00.00 CET)"),
  new SlashCommandBuilder().setName("ai").setDescription("Tarkista, onko kuva tai ääni tekoälyn tekemä (OpenAI)")
    .addAttachmentOption(o => o.setName("tiedosto").setDescription("Kuva (PNG/JPEG/WebP) tai ääni (MP3/Opus/AAC/FLAC/WAV, max 60 s)"))
    .addStringOption(o => o.setName("linkki").setDescription("Linkki kuvaan tai äänitiedostoon").setMaxLength(1000)),
  new SlashCommandBuilder().setName("uptime").setDescription("Näyttää botin isäntäkoneen käyntiajan ja kuormitusasteen"),
  new SlashCommandBuilder().setName("help").setDescription("Näyttää kaikki komennot"),
  new SlashCommandBuilder().setName("savu").setDescription("Valitse ja suorita komento pudotusvalikosta"),
  new SlashCommandBuilder().setName("uutiset").setDescription("Näyttää uutisia Ampparit.com:sta")
    .addSubcommand(s => s.setName("luetuimmat").setDescription("5 luetuinta uutista juuri nyt"))
    .addSubcommand(s => s.setName("uusimmat").setDescription("5 uusinta uutista juuri nyt")),
  new SlashCommandBuilder().setName("th").setDescription("Tilannehuone.fi — uutiset ja hälytykset")
    .addSubcommand(s => s.setName("uusimmat").setDescription("10 uusinta uutista Tilannehuoneesta"))
    .addSubcommand(s => s.setName("lista").setDescription("10 viimeisintä hälytystä Tilannehuoneen hälytyslistalta"))
    .addSubcommand(s => s.setName("haku").setDescription("Viimeisimmät hälytykset paikkakunnan lähellä (oletus 100 km)")
      .addStringOption(o => o.setName("paikkakunta").setDescription("Kunta, esim. Nurmijärvi").setRequired(true).setMaxLength(50))
      .addIntegerOption(o => o.setName("km").setDescription("Säde kilometreinä (oletus 100)").setMinValue(1).setMaxValue(300))),
  new SlashCommandBuilder().setName("leffat").setDescription("Päivän elokuvat TV:ssä (Iltalehti)")
    .addStringOption(o => o.setName("milloin").setDescription("Mikä päivä (oletus: tänään)").setRequired(false)
      .addChoices(
        { name:"tänään (oletus)", value:"tänään" },
        { name:"huomenna", value:"huomenna" },
      )),
  new SlashCommandBuilder().setName("lotto").setDescription("Viimeisimmän Lotto-arvonnan oikea rivi"),
  new SlashCommandBuilder().setName("eurojaska").setDescription("Viimeisimmän Eurojackpot-arvonnan oikea rivi ja seuraava arvonta"),
  new SlashCommandBuilder().setName("tm").setDescription("Trackmania-klubin tiedot")
    .addSubcommand(s => s.setName("ranking").setDescription("Top-15 trophy-ranking")
      .addStringOption(o => o.setName("klubi").setDescription("Klubin nimi").setRequired(true)))
    .addSubcommand(s => s.setName("info").setDescription("Klubin perustiedot ja jäsenmäärä")
      .addStringOption(o => o.setName("klubi").setDescription("Klubin nimi").setRequired(true)))
    .addSubcommand(s => s.setName("kampanjat").setDescription("Klubin kampanjat ja karttamäärät")
      .addStringOption(o => o.setName("klubi").setDescription("Klubin nimi").setRequired(true)))
    .addSubcommand(s => s.setName("huoneet").setDescription("Klubin serverit ja huoneet")
      .addStringOption(o => o.setName("klubi").setDescription("Klubin nimi").setRequired(true)))
    .addSubcommand(s => s.setName("aktiviteetit").setDescription("Kaikki klubin aktiviteetit")
      .addStringOption(o => o.setName("klubi").setDescription("Klubin nimi").setRequired(true)))
    .addSubcommand(s => s.setName("shorts").setDescription("Weekly Shorts -tulokset klubin sisällä")
      .addStringOption(o => o.setName("klubi").setDescription("Klubin nimi").setRequired(true)))
    .addSubcommand(s => s.setName("serveri").setDescription("Savun oman Trackmania-palvelimen tila ja liittymisnappi"))
    .addSubcommand(s => s.setName("n").setDescription("Uusin uutinen trackmania.com:sta"))
    .addSubcommand(s => s.setName("u").setDescription("Uusin päivitys (update) trackmania.com:sta")),
].map(c => c
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .toJSON()
);

(async () => {
  try {
    await new REST({ version:"10" }).setToken(TOKEN).put(Routes.applicationCommands(CLIENT_ID), { body:commands });
    console.log("Slash-komennot rekisteröity.");
  } catch (err) { console.error(err); }
})();

/* --- Komentojen suorituslogiikka: nämä toteuttavat itse komennot, ja niitä kutsutaan
   sekä suoraan slash-komennosta että /savu-pudotusvalikosta (ja sen modal-lomakkeista). --- */

async function suoritaNimipaivat(interaction) {
  return interaction.reply({
    flags: 64,
    embeds: [new EmbedBuilder().setTitle("📅 Nimipäivät").setDescription(muotoileNimet(haeNimipaivat()))]
  });
}

async function suoritaLiputuspaiva(interaction) {
  const paiva = haeLiputuspaiva();
  return interaction.reply({
    flags: 64,
    embeds: [new EmbedBuilder()
      .setTitle("🇫🇮 Liputuspäivä")
      .setDescription(paiva ? `🎌 Tänään liputetaan: **${paiva}**` : "Tänään ei ole virallista liputuspäivää.")]
  });
}

// Päiviä jouluaattoon (24.12.) Helsingin kalenteripäivän mukaan. Päivämäärät lasketaan UTC-keskiöinä,
// jolloin kesäaikasiirtymät eivät sotke päivien erotusta.
function laskePaiviaJouluun() {
  const [v, kk, pv] = tamanPaivanPaivamaaraHelsinki().split("-").map(Number);
  const tanaan = Date.UTC(v, kk - 1, pv);
  let aatto = Date.UTC(v, 11, 24);
  if (tanaan > Date.UTC(v, 11, 26)) aatto = Date.UTC(v + 1, 11, 24);
  return { paivia: Math.round((aatto - tanaan) / 86400000), aatto: new Date(aatto) };
}

function rakennaJouluEmbed() {
  const { paivia, aatto } = laskePaiviaJouluun();
  const viikonpaiva = aatto.toLocaleDateString("fi-FI", { timeZone: "UTC", weekday: "long" });

  let kuvaus;
  if (paivia === 0) kuvaus = "🎅 **Tänään on jouluaatto!** Hyvää joulua! 🎁";
  else if (paivia === -1) kuvaus = "⛪ **Tänään on joulupäivä!** Hyvää joulua! 🎄";
  else if (paivia === -2) kuvaus = "🌟 **Tänään on tapaninpäivä!** Hyvää joulun jatkoa!";
  else if (paivia === 1) kuvaus = "⏳ **Huomenna on jouluaatto!** 🎁";
  else kuvaus = `⏳ Jouluaattoon on **${paivia} päivää**.`;

  const embed = new EmbedBuilder().setTitle("🎄 Joululaskuri").setDescription(kuvaus);
  if (paivia > 0) {
    embed.addFields({ name:"📅 Jouluaatto", value:`${viikonpaiva} ${aatto.getUTCDate()}.12.${aatto.getUTCFullYear()}` });
  }
  return embed;
}

async function suoritaJoulu(interaction) {
  return interaction.reply({ flags: 64, embeds: [rakennaJouluEmbed()] });
}

// Juhannusaatto on 19.–25.6. välinen perjantai. Laskenta kuten joulussa (UTC-keskiöt, Helsingin päivä);
// laskuri siirtyy seuraavaan vuoteen vasta juhannuspäivän jälkeen.
function juhannusaatto(vuosi) {
  const d = new Date(Date.UTC(vuosi, 5, 19));
  d.setUTCDate(19 + ((5 - d.getUTCDay() + 7) % 7));
  return d.getTime();
}

function laskePaiviaJuhannukseen() {
  const [v, kk, pv] = tamanPaivanPaivamaaraHelsinki().split("-").map(Number);
  const tanaan = Date.UTC(v, kk - 1, pv);
  let aatto = juhannusaatto(v);
  if (tanaan > aatto + 86400000) aatto = juhannusaatto(v + 1);
  return { paivia: Math.round((aatto - tanaan) / 86400000), aatto: new Date(aatto) };
}

function rakennaJuhannusEmbed() {
  const { paivia, aatto } = laskePaiviaJuhannukseen();

  let kuvaus;
  if (paivia === 0) kuvaus = "🔥 **Tänään on juhannusaatto!** Hyvää juhannusta! 🌞";
  else if (paivia === -1) kuvaus = "🇫🇮 **Tänään on juhannuspäivä!** Hyvää juhannusta! 🌿";
  else if (paivia === 1) kuvaus = "⏳ **Huomenna on juhannusaatto!** 🔥";
  else kuvaus = `⏳ Juhannusaattoon on **${paivia} päivää**.`;

  const embed = new EmbedBuilder().setTitle("🌿 Juhannuslaskuri").setDescription(kuvaus);
  if (paivia > 0) {
    embed.addFields({ name:"📅 Juhannusaatto", value:`perjantai ${aatto.getUTCDate()}.6.${aatto.getUTCFullYear()}` });
  }
  return embed;
}

async function suoritaJuhannus(interaction) {
  return interaction.reply({ flags: 64, embeds: [rakennaJuhannusEmbed()] });
}

/* --- WOW FOREVER --- */

// Julkaisuhetki (5.11.2026 klo 00.00 CET) ja kaikkien laskurien muistutuslogiikka ovat laskurit.js:ssä.
// Ajankohta kirjoitetaan suomeksi (Laskurit.muotoileAjankohta), koska Discordin <t:…>-aikaleima
// näkyisi lukijan Discord-sovelluksen kielellä.
const { WOW_JULKAISU } = Laskurit;

function muotoileWowJaljella(ms) {
  const min = Math.ceil(ms / 60000);
  const pv = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  const osat = [];
  if (pv) osat.push(`${pv} pv`);
  if (h) osat.push(`${h} h`);
  if (m || !osat.length) osat.push(`${m} min`);
  return osat.join(" ");
}

function rakennaWowEmbed() {
  const jaljella = WOW_JULKAISU - Date.now();
  const ajankohta = `${Laskurit.muotoileAjankohta(WOW_JULKAISU)} (Suomen aikaa)`;
  const embed = new EmbedBuilder().setTitle("⚔️ WoW Forever -laskuri").setColor(0xf8b700);
  if (jaljella > 0) {
    embed.setDescription(`⏳ Julkaisuun on **${muotoileWowJaljella(jaljella)}**.`)
      .addFields({ name:"📅 Julkaisu", value:ajankohta });
  } else {
    embed.setDescription(`🎉 **WoW Forever on julkaistu!** (${ajankohta})`);
  }
  return embed;
}

async function suoritaWow(interaction) {
  return interaction.reply({ flags: 64, embeds: [rakennaWowEmbed()] });
}

/* --- LASKURIMUISTUTUKSET (WoW, joulu, juhannus, mukautetut) --- */

// guildId -> laskuriavain -> { kohde, kasitellyt }, ettei uudelleenkäynnistys lähetä samaa toiste.
const LASKURI_TILA_POLKU = path.join(__dirname, "laskuri-muistutukset.json");
// 1.11.2026 version WoW-tilatiedosto; siirretään uuteen tilaan käynnistyksessä.
const VANHA_WOW_TILA_POLKU = path.join(__dirname, "wow-muistutukset.json");

function lueLaskuriTila() {
  try { return JSON.parse(fs.readFileSync(LASKURI_TILA_POLKU, "utf8")); } catch { return {}; }
}

function tallennaLaskuriTila(tila) {
  const tmp = `${LASKURI_TILA_POLKU}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tila, null, 2));
  fs.renameSync(tmp, LASKURI_TILA_POLKU);
}

function migroiVanhaWowTila() {
  if (!fs.existsSync(VANHA_WOW_TILA_POLKU)) return;
  const vanha = Laskurit.migroiWowTila(JSON.parse(fs.readFileSync(VANHA_WOW_TILA_POLKU, "utf8")));
  const tila = lueLaskuriTila();
  for (const [guildId, merkinnat] of Object.entries(vanha)) {
    tila[guildId] = { ...merkinnat, ...tila[guildId] };
  }
  tallennaLaskuriTila(tila);
  fs.renameSync(VANHA_WOW_TILA_POLKU, `${VANHA_WOW_TILA_POLKU}.migrated`);
  console.log("wow-muistutukset.json siirretty laskuri-muistutukset.json:iin.");
}

async function lahetaKanavalle(guildId, kanavaId, teksti) {
  await Laskurit.lahetaOmalleKanavalle({ haeKanava: id => client.channels.fetch(id), guildId, kanavaId, teksti });
}

async function tarkistaLaskuriMuistutukset() {
  const { tila, muuttui } = await Laskurit.ajaLaskuriMuistutukset({
    guildIdt: [...client.guilds.cache.keys()],
    haeGuildConfig: loadGuildConfig,
    onFeature: isFeatureEnabled,
    laheta: lahetaKanavalle,
    tila: lueLaskuriTila(),
    nyt: Date.now(),
    loki: viesti => console.error(viesti)
  });
  if (muuttui) tallennaLaskuriTila(tila);
}

async function suoritaNimipaivaHaku(interaction, nimiRaaka) {
  const nimi = nimiRaaka.toLowerCase();
  const data = lueJSON("nimipaivat.json");
  const loydot = Object.entries(data)
    .filter(([,nimet]) => nimet.map(n=>n.toLowerCase()).includes(nimi))
    .map(([pvm]) => pvm);

  if (!loydot.length) return interaction.reply({ content:`Nimelle **${nimi}** ei löytynyt nimipäivää.`, flags:64 });

  const next = seuraavaEsiintyma(loydot);
  const formatted = loydot.map(p => {
    const [kk,pv] = p.split("-").map(Number);
    return `${pv}. ${KUUKAUDET[kk-1]}`;
  });

  return interaction.reply({
    flags: 64,
    embeds: [new EmbedBuilder()
      .setTitle("🔍 Nimipäivähaku")
      .setDescription(`**${nimi}**: ${formatted.join(", ")}`)
      .addFields({ name:"⏭️ Seuraava", value:`${next.text} (${muotoilePaivaEro(next.diff)})` })]
  });
}

async function suoritaSynttaritHaku(interaction, hakuRaaka) {
  await interaction.deferReply({ flags: 64 });
  const guild = interaction.guild;
  if (!guild) return interaction.editReply("Tämä komento toimii vain palvelimella.");

  const haku = hakuRaaka.trim();
  let jasen = null;

  if (/^\d{5,25}$/.test(haku)) {
    jasen = await guild.members.fetch(haku).catch(() => null);
  } else {
    const tulokset = await guild.members.search({ query: haku, limit: 10 }).catch(() => null);
    if (tulokset && tulokset.size) {
      const hakuLower = haku.toLowerCase();
      jasen = tulokset.find(j =>
        j.nickname?.toLowerCase() === hakuLower ||
        j.user.username.toLowerCase() === hakuLower ||
        j.user.globalName?.toLowerCase() === hakuLower
      ) || (tulokset.size === 1 ? tulokset.first() : null);
    }
  }

  if (!jasen) return interaction.editReply(`Käyttäjää **${haku}** ei löytynyt palvelimelta.`);

  const data = lueGuildJSON(guild.id, "syntymapaivat.json");
  const mention = `<@${jasen.id}>`;
  const pvm = Object.entries(data).find(([, mainitut]) => (mainitut || []).includes(mention))?.[0];

  if (!pvm) return interaction.editReply(`Syntymäpäivää ei asetettu. Botin ylläpitäjä voi lisätä sen tiedostoon \`data/${guild.id}/syntymapaivat.json\` (muoto: \`{ "KK-PP": ["<@käyttäjä-id>"] }\`).`);

  const next = seuraavaEsiintyma([pvm]);
  return interaction.editReply({
    embeds: [new EmbedBuilder()
      .setTitle("🎂 Syntymäpäivähaku")
      .setDescription(`**${jasen.displayName}**: ${next.text}`)
      .addFields({ name:"⏭️ Seuraava", value:`${next.text} (${muotoilePaivaEro(next.diff)})` })]
  });
}

async function suoritaNimihaku(interaction, sub, nimi) {
  await interaction.deferReply({ flags: 64 });

  if (sub === "etu") {
    const tulos = await haeEtunimihaku(nimi);
    if (!tulos) return interaction.editReply("Nimipalvelun haku epäonnistui. Yritä hetken kuluttua uudelleen.");
    if (!tulos.found) return interaction.editReply(`Väestötietojärjestelmässä ei ole hakemaasi etunimeä: **${nimi}**.`);

    // Viimeinen rivi on tfoot:sta tullut "Yhteensä"-summarivi, ei oma vuosikymmen — jätetään pois pylväistä.
    const graafi = piirraNimihakuGraafi(tulos.rivit.slice(0, -1), 1, 2, "Henkilöä");
    const attachment = new AttachmentBuilder(graafi, { name:"nimihaku.png" });

    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle(`👤 Etunimihaku: ${nimi}`)
        .setURL(tulos.url)
        .setDescription(muotoileNimihakuTaulukko(["Vuodet", "Miehiä", "Naisia", "Yhteensä"], tulos.rivit))
        .setImage("attachment://nimihaku.png")
        .setFooter({ text:"Lähde: Digi- ja väestötietovirasto (DVV) · syntymävuosikymmenittäin" })
        .setColor(0x003580)],
      files: [attachment]
    });
  }

  if (sub === "suku") {
    const tulos = await haeSukunimihaku(nimi);
    if (!tulos) return interaction.editReply("Nimipalvelun haku epäonnistui. Yritä hetken kuluttua uudelleen.");
    if (!tulos.found) return interaction.editReply(`Väestötietojärjestelmässä ei ole hakemaasi sukunimeä: **${nimi}**.`);

    const graafi = piirraNimihakuGraafi(tulos.rivit.slice(0, -1), 2, 3, "Henkilöä");
    const attachment = new AttachmentBuilder(graafi, { name:"nimihaku.png" });

    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle(`👥 Sukunimihaku: ${nimi}`)
        .setURL(tulos.url)
        .setDescription(muotoileNimihakuTaulukko(["", "Kaikki", "Miehet", "Naiset", "Suomessa", "Ulkomailla"], tulos.rivit))
        .setImage("attachment://nimihaku.png")
        .setFooter({ text:"Lähde: Digi- ja väestötietovirasto (DVV)" })
        .setColor(0x003580)],
      files: [attachment]
    });
  }
}

async function suoritaUutiset(interaction, sub) {
  await interaction.deferReply({ flags: 64 });
  const isLuetuimmat = sub === "luetuimmat";

  const url = isLuetuimmat
    ? "https://www.ampparit.com/luetuimmat"
    : "https://www.ampparit.com/uusimmat";

  const uutiset = await haeAmpparitUutiset(url, 5);
  if (!uutiset?.length) return interaction.editReply("Uutisten haku epäonnistui. Yritä hetken kuluttua uudelleen.");

  return interaction.editReply({
    embeds: [new EmbedBuilder()
      .setTitle(isLuetuimmat ? "🔥 Ampparit — Luetuimmat" : "🆕 Ampparit — Uusimmat")
      .setURL(url)
      .setColor(isLuetuimmat ? 0xd63031 : 0x0984e3)
      .setDescription(uutiset.map((u, i) => `**${i+1}.** [${u.otsikko}](${u.linkki})`).join("\n\n"))
      .setFooter({ text:"Lähde: Ampparit.com" })
      .setTimestamp()]
  });
}

/* --- TILANNEHUONE --- */

// "Uusimmat" = etusivun sivupalkin toimituksen uutislaatikko, "lista" = halytys.php:n
// hälytyslista, "haku" = kysely.php:n kuntahaku. Sivuston rss.xml jää tunteja jälkeen eikä
// sisällä kaikkia tehtäviä, joten kaikki jäsennetään HTML:stä. Tehtävän tunniste on
// 32-merkkinen hash (tehtava.php?hash=…).
const TH_BASE = "https://www.tilannehuone.fi";
const TH_HEADERS = { "User-Agent": "Mozilla/5.0 (savu-botti)" };
const TH_CACHE_MS = 3 * 60 * 1000;
const TH_MAARA = 10;
// kysely.php:n suurin sallittu tulosmäärä — kattaa noin 2–3 vuorokautta.
const TH_HAKU_MAARA = 100;
const thCache = {};

// Kuvakkeen nimestä (flame-3-tie.png, flame-2-poliisi.png, alarm-usr.png, dot.png) tehtävätyypin emoji.
function thEmoji(kuva = "") {
  if (kuva.includes("-tie")) return "🚗";
  if (kuva.includes("poliisi")) return "🚓";
  if (kuva.includes("flame")) return "🔥";
  if (kuva.includes("alarm")) return "🚨";
  return "▪️";
}

// Sivu käyttää pitkissä sanoissa näkymättömiä tavutusmerkkejä (U+00AD).
function thTeksti(teksti) {
  return teksti.replace(/­/g, "").replace(/\s+/g, " ").trim();
}

async function haeThSivu(polku, params) {
  const { data } = await axios.get(`${TH_BASE}/${polku}`, { headers: TH_HEADERS, params, timeout: 10000 });
  return cheerio.load(data);
}

// halytys.php ja kysely.php käyttävät samaa table.halytyslista-rakennetta. kysely.php:n
// keskus/etaisyys-haussa palvelin ei karsi rivejä vaan värjää etäisyyden sisällä olevat:
// tausta #ff0000 = itse kunta, ja mitä vaaleampi (#ffXXXX), sitä kauempana — XX/255 × etäisyys.
function jasennaThHalytykset($, etaisyys = null) {
  return $("table.halytyslista tr.halytys").toArray().map(el => {
    const rivi = $(el);
    // Käyttäjähavainnoilla ei aina ole tehtäväsivua: silloin rivillä ei ole .artlnk-spaneja eikä hashia.
    const hash = (rivi.find(".artlnk").attr("class") || "").match(/but_info_([0-9a-f]{32})/)?.[1];
    const pvm = rivi.find("td.pvm").text().replace(/\s+/g, " ").trim(); // "12.10.2026 18:28:00" tai "… 7:30:00"
    const [paiva, kelloRaaka = ""] = pvm.split(" ");
    const [tunnit = "", minuutit = ""] = kelloRaaka.split(":");
    const tehtavaSolu = rivi.find("td").eq(3);
    const korostus = (rivi.attr("style") || "").match(/background:\s*#ff([0-9a-f]{2})[0-9a-f]{2}/i)?.[1];
    return {
      kunta: thTeksti(rivi.find("td.kunta").text()),
      otsikko: thTeksti(tehtavaSolu.clone().find(".kayttajahavainto").remove().end().text()),
      kayttajahavainto: tehtavaSolu.find(".kayttajahavainto").length > 0,
      paiva, kello: `${tunnit.padStart(2, "0")}:${minuutit}`,
      emoji: thEmoji(rivi.find("td img").first().attr("src")),
      url: hash ? `${TH_BASE}/tehtava.php?hash=${hash}` : null,
      km: korostus && etaisyys ? Math.round(parseInt(korostus, 16) / 255 * etaisyys) : null
    };
  }).filter(r => r.kunta || r.otsikko);
}

async function haeTilannehuone(sub) {
  const valimuisti = thCache[sub];
  if (valimuisti && Date.now() - valimuisti.aika < TH_CACHE_MS) return valimuisti.data;
  try {
    let rivit;
    if (sub === "lista") {
      rivit = jasennaThHalytykset(await haeThSivu("halytys.php"));
    } else {
      const $ = await haeThSivu("index.php");
      const laatikko = $("h2").filter((_, h) => $(h).text().trim() === "Uusimmat").first().closest("div");
      rivit = laatikko.find(".minilista a[href*='tehtava.php?hash=']").toArray().map(el => {
        const linkki = $(el);
        const spanit = linkki.find("span");
        return {
          kunta: spanit.eq(0).text().trim(),
          otsikko: thTeksti(spanit.eq(1).text()),
          emoji: thEmoji(linkki.find("img").attr("src")),
          url: `${TH_BASE}/${linkki.attr("href").replace(/^\//, "")}`
        };
      });
    }

    rivit = rivit.filter(r => r.kunta || r.otsikko).slice(0, TH_MAARA);
    if (!rivit.length) throw new Error(`ei rivejä (${sub}) — sivun rakenne muuttunut?`);
    thCache[sub] = { aika: Date.now(), data: rivit };
    return rivit;
  } catch (err) {
    console.error("haeTilannehuone virhe:", err.message);
    return null;
  }
}

// Palauttaa { rivit, yhteensa } — rivit = etäisyyden sisällä olevat hälytykset uusin ensin,
// yhteensa = montako hälytystä haku kattoi. Tuntematon kunta → rivit tyhjä (sivu ei kerro virhettä).
async function haeThLahella(kunta, km) {
  const avain = `haku:${kunta.toLowerCase()}:${km}`;
  const valimuisti = thCache[avain];
  if (valimuisti && Date.now() - valimuisti.aika < TH_CACHE_MS) return valimuisti.data;
  try {
    const kaikki = jasennaThHalytykset(
      await haeThSivu("kysely.php", { keskus: kunta, etaisyys: km, maara: TH_HAKU_MAARA }), km
    );
    if (!kaikki.length) throw new Error("ei rivejä (haku) — sivun rakenne muuttunut?");
    const data = { rivit: kaikki.filter(r => r.km !== null), yhteensa: kaikki.length, vanhin: kaikki.at(-1).paiva };
    thCache[avain] = { aika: Date.now(), data };
    return data;
  } catch (err) {
    console.error("haeThLahella virhe:", err.message);
    return null;
  }
}

function thHalytysRivi(r, tanaan, naytaKm = false) {
  // Päivä näytetään vain, jos hälytys ei ole tältä päivältä.
  const aika = r.paiva === tanaan ? r.kello : `${r.paiva.slice(0, 6)} ${r.kello}`;
  const otsikko = r.otsikko.replace(/[[\]]/g, "") || "(ei kuvausta)";
  return `${r.emoji} \`${aika}\` **${r.kunta}**` + (naytaKm && r.km ? ` (~${r.km} km)` : "") +
    ` — ${r.url ? `[${otsikko}](${r.url})` : otsikko}` +
    (r.kayttajahavainto ? " *(käyttäjähavainto)*" : "");
}

// Kokoaa rivit embedin kuvaukseen (max 4096 merkkiä) ja kertoo lopussa montako jäi pois.
function thKuvaus(rivit) {
  const mukaan = [];
  let pituus = 0;
  for (const [i, rivi] of rivit.entries()) {
    const loput = `\n…ja ${rivit.length - i} muuta`;
    if (pituus + rivi.length + 1 + loput.length > 4096) { mukaan.push(loput.trim()); break; }
    mukaan.push(rivi);
    pituus += rivi.length + 1;
  }
  return mukaan.join("\n");
}

function thTanaan() {
  return new Date().toLocaleDateString("fi-FI", { timeZone: "Europe/Helsinki", day: "2-digit", month: "2-digit", year: "numeric" });
}

// sub: "uusimmat" = toimituksen 10 uusinta uutista, "lista" = 10 viimeisintä hälytystä.
async function suoritaTilannehuone(interaction, sub, kunta, km) {
  if (sub === "haku") return suoritaThHaku(interaction, kunta, km);
  await interaction.deferReply({ flags: 64 });
  const rivit = await haeTilannehuone(sub);
  if (!rivit) return interaction.editReply("Tilannehuoneen tietojen haku epäonnistui. Yritä hetken kuluttua uudelleen.");

  const tanaan = thTanaan();
  const kuvaus = sub === "lista"
    ? rivit.map(r => thHalytysRivi(r, tanaan))
    : rivit.map(r => `${r.emoji} **${r.kunta}** — [${r.otsikko.replace(/[[\]]/g, "")}](${r.url})`);

  return interaction.editReply({
    embeds: [new EmbedBuilder()
      .setTitle(sub === "lista" ? "🚨 Tilannehuone — Hälytyslista" : "📰 Tilannehuone — Uusimmat")
      .setURL(sub === "lista" ? `${TH_BASE}/halytys.php` : `${TH_BASE}/index.php`)
      .setColor(sub === "lista" ? 0xe8824b : 0x45759f)
      .setDescription(kuvaus.join("\n").slice(0, 4096))
      .setFooter({ text: "Lähde: Tilannehuone.fi" })
      .setTimestamp()]
  });
}

async function suoritaThHaku(interaction, kunta, km) {
  await interaction.deferReply({ flags: 64 });
  kunta = thTeksti(kunta || "").replace(/(^|[\s-])(\p{L})/gu, (_, eteen, kirjain) => eteen + kirjain.toUpperCase());
  km = km || 100;
  if (!kunta) return interaction.editReply("Anna paikkakunta, esim. `/th haku paikkakunta:Nurmijärvi`.");

  const tulos = await haeThLahella(kunta, km);
  if (!tulos) return interaction.editReply("Tilannehuoneen tietojen haku epäonnistui. Yritä hetken kuluttua uudelleen.");

  const hakuUrl = `${TH_BASE}/kysely.php?${new URLSearchParams({ keskus: kunta, etaisyys: km, maara: TH_HAKU_MAARA })}`;
  const embed = new EmbedBuilder()
    .setTitle(`📍 Tilannehuone — ${km} km säteellä: ${kunta}`.slice(0, 256))
    .setURL(hakuUrl)
    .setColor(0xff4646)
    .setFooter({ text: `Lähde: Tilannehuone.fi · haettu ${tulos.yhteensa} viimeisintä hälytystä (alkaen ${tulos.vanhin}) · etäisyys arvio` })
    .setTimestamp();

  if (!tulos.rivit.length) {
    return interaction.editReply({ embeds: [embed.setDescription(
      `Ei hälytyksiä ${km} km säteellä paikkakunnasta **${kunta}** ${tulos.yhteensa} viimeisimmän hälytyksen joukossa.\n` +
      "Tarkista paikkakunnan nimi — tuntemattomalla nimellä haku ei löydä mitään."
    )] });
  }

  const tanaan = thTanaan();
  embed.setDescription(thKuvaus(tulos.rivit.map(r => thHalytysRivi(r, tanaan, true))));
  return interaction.editReply({ embeds: [embed] });
}

/* --- LEFFAT --- */

const LEFFAT_URLIT = {
  "tänään": "https://www.iltalehti.fi/telkku",
  "huomenna": "https://www.iltalehti.fi/telkku/tv-ohjelmat/huomenna"
};

async function haeLeffat(milloin) {
  try {
    const { data } = await axios.get(LEFFAT_URLIT[milloin], {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      timeout: 10000
    });
    const $ = cheerio.load(data);
    const leffat = [];

    $(".programs-container .telkku-channel-publications").each((_, kortti) => {
      const kanava = $(kortti).find("img.channel-logo").attr("alt")?.replace(/ logo$/, "") || "?";
      $(kortti).find(".telkku-publication").each((_, julkaisu) => {
        const otsikko = $(julkaisu).find(".publication-title").text().trim();
        if (!otsikko.startsWith("Elokuva: ")) return;
        const aika = $(julkaisu).find("time").text().trim();
        if (aika) leffat.push({ kanava, aika, nimi: otsikko.slice("Elokuva: ".length) });
      });
    });

    return leffat;
  } catch (err) {
    console.error("haeLeffat virhe:", err.message);
    return null;
  }
}

// Yöllä alkavat elokuvat (00:00–05:59) listataan lähetyspäivän lopussa, joten ne
// eivät ole "menneet" vaikka niiden kellonaika-merkkijono olisi pienempi kuin nykyhetki.
function eiOleVielaMennyt(aika, nyt) {
  return aika < "06:00" || aika >= nyt;
}

// Linkki IMDB-hakuun elokuvan nimellä. Ikäraja-suffiksi (esim. "(12)") siivotaan
// pois hakusanasta, ettei se häiritse osumaa — näyttönimessä se pysyy ennallaan.
function imdbHakuUrl(nimi) {
  const puhdas = nimi.replace(/\s*\(\d+\)\s*$/, "");
  return `https://www.imdb.com/find/?q=${encodeURIComponent(puhdas)}&s=tt&ttype=ft`;
}

async function suoritaLeffat(interaction, milloinRaaka) {
  await interaction.deferReply({ flags: 64 });
  const milloin = milloinRaaka === "huomenna" ? "huomenna" : "tänään";
  const leffat = await haeLeffat(milloin);

  const paivamaara = new Date(Date.now() + (milloin === "huomenna" ? 86400000 : 0))
    .toLocaleDateString("fi-FI", { timeZone: "Europe/Helsinki", day: "numeric", month: "numeric" });

  const embed = new EmbedBuilder()
    .setTitle(`🎬 Päivän elokuvat — ${milloin} ${paivamaara}.`)
    .setURL(LEFFAT_URLIT[milloin])
    .setColor(0x9b1c1c)
    .setFooter({ text: "Lähde: Iltalehti / Telkku" })
    .setTimestamp();

  if (!leffat) {
    embed.setDescription("Elokuvatietojen hakeminen epäonnistui. Yritä hetken kuluttua uudelleen.");
    return interaction.editReply({ embeds: [embed] });
  }

  const nyt = new Date().toLocaleTimeString("fi-FI", { timeZone: "Europe/Helsinki", hour: "2-digit", minute: "2-digit", hour12: false });
  const nakyvat = milloin === "tänään" ? leffat.filter(l => eiOleVielaMennyt(l.aika, nyt)) : leffat;

  if (!nakyvat.length) {
    embed.setDescription(milloin === "tänään" ? "Ei enää elokuvia tänään." : "Elokuvia ei löytynyt huomiselle.");
    return interaction.editReply({ embeds: [embed] });
  }

  const kanavat = [...new Set(nakyvat.map(l => l.kanava))];
  embed.setDescription(
    kanavat.map(kanava =>
      `**${kanava}**\n` + nakyvat.filter(l => l.kanava === kanava).map(l => `${l.aika} — [${l.nimi}](${imdbHakuUrl(l.nimi)})`).join("\n")
    ).join("\n\n")
  );

  return interaction.editReply({ embeds: [embed] });
}

/* --- LOTTO --- */

// Lotto- ja Eurojackpot-tulokset haetaan Veikkauksen omasta tulosrajapinnasta (sama, jota
// veikkaus.fi:n tulossivu käyttää). Aiemmin käytetyt lotto-numerot.com ja rahapelisanomat.fi
// vaihtoivat sivurakenteensa 10/2026, jolloin jäsennys hajosi hiljaa.
// Rajapinta palauttaa ISO-viikon arvonnat; uusin tuloksellinen arvonta löytyy kuluvalta tai
// edelliseltä viikolta. Summat ovat sentteinä.
const VEIKKAUS_TULOKSET_URL = "https://www.veikkaus.fi/api/draw-results/v1/games";
const VEIKKAUS_HEADERS = { Accept: "application/json", "X-ESA-API-Key": "ROBOT" };
const LOTTO_CACHE_MS = 10 * 60 * 1000;
let lottoCache = { aika: 0, data: null };

function isoViikko(aika) {
  const d = new Date(Date.UTC(aika.getUTCFullYear(), aika.getUTCMonth(), aika.getUTCDate()));
  const viikonpaiva = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - viikonpaiva); // ISO-viikon vuosi = viikon torstain vuosi
  const vuodenAlku = Date.UTC(d.getUTCFullYear(), 0, 1);
  const viikko = Math.ceil(((d - vuodenAlku) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(viikko).padStart(2, "0")}`;
}

async function haeVeikkausUusinArvonta(peli) {
  const nyt = new Date();
  const viikot = [isoViikko(nyt), isoViikko(new Date(nyt.getTime() - 7 * 86400000))];
  const arvonnat = [];
  for (const viikko of viikot) {
    const { data } = await axios.get(`${VEIKKAUS_TULOKSET_URL}/${peli}/draws/by-week/${viikko}`, {
      headers: VEIKKAUS_HEADERS, timeout: 10000
    });
    if (Array.isArray(data)) arvonnat.push(...data);
  }
  return arvonnat
    .filter(a => a.results?.[0]?.primary?.length)
    .sort((x, y) => y.drawTime - x.drawTime)[0] || null;
}

// Sama DD.MM.YYYY-muoto kuin aiemmin, koska guildCfg.arvonnat vertaa tätä merkkijonoa.
function arvontaPaiva(ms) {
  return new Date(ms).toLocaleDateString("fi-FI", { timeZone: "Europe/Helsinki", day: "2-digit", month: "2-digit", year: "numeric" });
}

function euroa(sentit) {
  return (sentit / 100).toLocaleString("fi-FI", { style: "currency", currency: "EUR" });
}

// Voitonjako on lopullinen vasta, kun arvonta on PAYABLE-tilassa; sitä ennen summat voivat olla nollia.
function veikkausVoitonjako(arvonta, tasot) {
  if (arvonta.status !== "PAYABLE") return [];
  return tasot.map(t => ({
    luokka: t.name,
    voittajia: t.shareCount.toLocaleString("fi-FI"),
    voitto: t.shareCount ? euroa(t.shareAmount) : "–"
  }));
}

async function haeLotto(ohitaValimuisti = false) {
  if (!ohitaValimuisti && lottoCache.data && Date.now() - lottoCache.aika < LOTTO_CACHE_MS) return lottoCache.data;
  try {
    const arvonta = await haeVeikkausUusinArvonta("LOTTO");
    const rivi = arvonta?.results[0];
    if (!rivi || rivi.primary.length !== 7) return null;

    const tasot = arvonta.prizeTiers || [];
    const tulos = {
      paiva: arvontaPaiva(arvonta.drawTime),
      numerot: rivi.primary,
      lisanumerot: rivi.secondary || [],
      plus: rivi.tertiary?.[0] || "",
      voitonjako: [
        { otsikko: "Lotto", rivit: veikkausVoitonjako(arvonta, tasot.filter(t => !t.multiplier)) },
        { otsikko: "Lotto + Plus", rivit: veikkausVoitonjako(arvonta, tasot.filter(t => t.multiplier)) }
      ].filter(o => o.rivit.length)
    };

    lottoCache = { aika: Date.now(), data: tulos };
    return tulos;
  } catch (err) {
    console.error("haeLotto virhe:", err.message);
    return null;
  }
}

// Yhteinen /lotto-komennolle ja automaattiselle tulospostaukselle. tulos = null → virhe-embed.
function rakennaLottoEmbed(tulos) {
  const embed = new EmbedBuilder()
    .setColor(0xf5c400)
    .setFooter({ text: "Lähde: Veikkaus" })
    .setTimestamp();

  if (!tulos) {
    return embed.setTitle("🎱 Lotto").setDescription("Lottotulosten hakeminen epäonnistui. Yritä hetken kuluttua uudelleen.");
  }

  const pallot = numerot => numerot.map(n => `\`${n.padStart(2, " ")}\``).join(" ");
  const rivit = [`**Oikea rivi:** ${pallot(tulos.numerot)}`];
  if (tulos.lisanumerot.length) rivit.push(`**Lisänumero${tulos.lisanumerot.length > 1 ? "t" : ""}:** ${pallot(tulos.lisanumerot)}`);
  if (tulos.plus) rivit.push(`**Plus-numero:** ${pallot([tulos.plus])}`);

  embed.setTitle(`🎱 Lotto — arvonta ${tulos.paiva}`).setDescription(rivit.join("\n"));
  for (const osio of tulos.voitonjako) {
    embed.addFields({
      name: `💰 Voitonjako — ${osio.otsikko}`,
      value: osio.rivit.map(r => `${r.luokka}: **${r.voitto}** (${r.voittajia} kpl)`).join("\n").slice(0, 1024)
    });
  }
  return embed;
}

async function suoritaLotto(interaction) {
  await interaction.deferReply({ flags: 64 });
  return interaction.editReply({ embeds: [rakennaLottoEmbed(await haeLotto())] });
}

/* --- EUROJACKPOT --- */

// Tulokset Veikkauksen rajapinnasta (ks. LOTTO yllä). Seuraavan arvonnan aika lasketaan
// aikataulusta (ti ja pe samaan Suomen aikaan kuin edellinen arvonta), ja arvioitu päävoitto
// haetaan lisätietona rahapelisanomat.fi:n potinkehitys-widgetistä — jos se epäonnistuu,
// tulokset näytetään silti ilman sitä.
const EUROJASKA_POTTI_URL = "https://rahapelisanomat.fi/eurojackpot/";
let eurojaskaCache = { aika: 0, data: null };

function helsinginAikaMs(vuosi, kuukausi, paiva, tunti, minuutti) {
  const arvaus = Date.UTC(vuosi, kuukausi - 1, paiva, tunti, minuutti);
  const osat = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Helsinki", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric"
  }).formatToParts(arvaus).map(o => [o.type, Number(o.value)]));
  const siirtyma = Date.UTC(osat.year, osat.month - 1, osat.day, osat.hour, osat.minute) - arvaus;
  return arvaus - siirtyma;
}

function seuraavaEurojaskaArvonta(edellinenMs) {
  const osat = ms => Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Helsinki", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short"
  }).formatToParts(ms).map(o => [o.type, o.type === "weekday" ? o.value : Number(o.value)]));
  const klo = osat(edellinenMs);
  let ms = edellinenMs;
  for (let i = 0; i < 7; i++) {
    ms += 86400000;
    const p = osat(ms);
    if (p.weekday === "Tue" || p.weekday === "Fri") {
      const seuraava = helsinginAikaMs(p.year, p.month, p.day, klo.hour, klo.minute);
      if (seuraava > Date.now()) return seuraava;
    }
  }
  return null;
}

async function haeEurojaskaPotti() {
  try {
    const { data } = await axios.get(EUROJASKA_POTTI_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      timeout: 10000
    });
    const $ = cheerio.load(data);
    const otsikko = $(".ss-widget--jackpot-development").first().attr("aria-label") || "";
    const osuma = otsikko.match(/n\.\s*([\d,]+)\s*milj/i);
    return osuma ? `n. ${osuma[1]} milj. €` : "";
  } catch (err) {
    console.error("haeEurojaskaPotti virhe:", err.message);
    return "";
  }
}

async function haeEurojaska(ohitaValimuisti = false) {
  if (!ohitaValimuisti && eurojaskaCache.data && Date.now() - eurojaskaCache.aika < LOTTO_CACHE_MS) return eurojaskaCache.data;
  try {
    const [arvonta, potti] = await Promise.all([haeVeikkausUusinArvonta("EJACKPOT"), haeEurojaskaPotti()]);
    const rivi = arvonta?.results[0];
    if (!rivi || rivi.primary.length !== 5 || rivi.secondary?.length !== 2) return null;

    const seuraavaMs = seuraavaEurojaskaArvonta(arvonta.drawTime);
    const tulos = {
      paiva: arvontaPaiva(arvonta.drawTime),
      numerot: rivi.primary,
      tahdet: rivi.secondary,
      voitonjako: veikkausVoitonjako(arvonta, arvonta.prizeTiers || []),
      seuraava: seuraavaMs
        ? new Date(seuraavaMs).toLocaleString("fi-FI", { timeZone: "Europe/Helsinki", weekday: "long", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })
        : "",
      seuraavaUnix: seuraavaMs ? Math.floor(seuraavaMs / 1000) : null,
      potti
    };

    eurojaskaCache = { aika: Date.now(), data: tulos };
    return tulos;
  } catch (err) {
    console.error("haeEurojaska virhe:", err.message);
    return null;
  }
}

// naytaVoitonjako=false: automaattinen tulospostaus näyttää vain oikean rivin, koska voitonjako
// valmistuu Veikkaukselle vasta myöhemmin kuin numerot. /eurojaska näyttää sen aina.
function rakennaEurojaskaEmbed(tulos, naytaVoitonjako = true) {
  const embed = new EmbedBuilder()
    .setColor(0x6d19d6)
    .setFooter({ text: "Lähde: Veikkaus" })
    .setTimestamp();

  if (!tulos) {
    return embed.setTitle("⭐ Eurojackpot").setDescription("Eurojackpot-tulosten hakeminen epäonnistui. Yritä hetken kuluttua uudelleen.");
  }

  const pallot = numerot => numerot.map(n => `\`${n.padStart(2, " ")}\``).join(" ");
  embed.setTitle(`⭐ Eurojackpot — arvonta ${tulos.paiva}`).setDescription([
    `**Oikea rivi:** ${pallot(tulos.numerot)}`,
    `**Tähtinumerot:** ${pallot(tulos.tahdet)}`
  ].join("\n"));

  if (naytaVoitonjako && tulos.voitonjako.length) {
    embed.addFields({
      name: "💰 Voitonjako",
      value: tulos.voitonjako.map(r => `${r.luokka}: **${r.voitto}** (${r.voittajia} kpl)`).join("\n").slice(0, 1024)
    });
  }

  const seuraava = [];
  if (tulos.seuraava) seuraava.push(tulos.seuraava + (tulos.seuraavaUnix ? ` (<t:${tulos.seuraavaUnix}:R>)` : ""));
  if (tulos.potti) seuraava.push(`Arvioitu päävoitto: **${tulos.potti}**`);
  if (seuraava.length) embed.addFields({ name: "⏳ Seuraava arvonta", value: seuraava.join("\n") });
  return embed;
}

async function suoritaEurojaska(interaction) {
  await interaction.deferReply({ flags: 64 });
  return interaction.editReply({ embeds: [rakennaEurojaskaEmbed(await haeEurojaska())] });
}

async function suoritaSahko(interaction, nakymaRaaka) {
  await interaction.deferReply({ flags:64 });
  const nakyma = nakymaRaaka || "yhteenveto";

  if (nakyma === "kuukausi") {
    const vertailu = await haeKuukausiSahkoVertailu();
    if (!vertailu) return interaction.editReply("Kuukausivertailun hakeminen epäonnistui. Yritä hetken kuluttua uudelleen.");

    const graafi = piirraKuukausiGraafi(vertailu);
    const attachment = new AttachmentBuilder(graafi, { name:"sahko-kuukausi.png" });

    const muutos = vertailu.viimeKk.keski > 0
      ? ((vertailu.tamaKk.keski - vertailu.viimeKk.keski) / vertailu.viimeKk.keski) * 100
      : null;
    const muutosTeksti = muutos === null ? ""
      : muutos > 0.05 ? ` (📈 +${muutos.toFixed(1)} %)`
      : muutos < -0.05 ? ` (📉 ${muutos.toFixed(1)} %)`
      : " (ennallaan)";

    const embed = new EmbedBuilder()
      .setTitle("⚡ Sähkön kuukausivertailu")
      .setDescription(`${vertailu.tamaKk.nimi} vs ${vertailu.viimeKk.nimi} — ensimmäiset ${vertailu.paivia} päivää molemmista`)
      .setImage("attachment://sahko-kuukausi.png")
      .addFields(
        { name:`⚖️ ${vertailu.tamaKk.nimi}`, value:
          `Keski: **${vertailu.tamaKk.keski.toFixed(2)} c/kWh**${muutosTeksti}\nMin: ${vertailu.tamaKk.min.toFixed(2)} · Max: ${vertailu.tamaKk.max.toFixed(2)}`, inline:true },
        { name:`⚖️ ${vertailu.viimeKk.nimi}`, value:
          `Keski: **${vertailu.viimeKk.keski.toFixed(2)} c/kWh**\nMin: ${vertailu.viimeKk.min.toFixed(2)} · Max: ${vertailu.viimeKk.max.toFixed(2)}`, inline:true }
      )
      .setFooter({ text:"Lähde: Elering (Nord Pool -pörssihinta, ALV 0%) — ei suoraan sama luku kuin muissa /sahko-näkymissä" });

    return interaction.editReply({ embeds:[embed], files:[attachment] });
  }

  if (nakyma === "huomenna") {
    const huominen = await haeHuomisenSahko();
    if (!huominen) {
      const huomisenPvm = new Date(Date.now() + 86400000).toLocaleDateString("fi-FI", { weekday:"long", day:"numeric", month:"numeric" });
      return interaction.editReply(`Huomisen (${huomisenPvm}) sähkön hintoja ei ole vielä julkaistu. Nord Pool julkaisee ne yleensä klo 12:45-13 tänään.`);
    }

    const graafi = piirraGraafi(huominen.prices, false);
    const attachment = new AttachmentBuilder(graafi, { name:"sahko-huomenna.png" });
    const huomisenPvm = new Date(Date.now() + 86400000).toLocaleDateString("fi-FI", { weekday:"long", day:"numeric", month:"numeric" });

    const embed = new EmbedBuilder()
      .setTitle(`⚡ Sähkö huomenna (${huomisenPvm})`)
      .setImage("attachment://sahko-huomenna.png")
      .addFields(
        { name:"🔻 Halvin", value:`${huominen.halvin.price} c/kWh\nklo ${huominen.halvin.time}`, inline:true },
        { name:"⚖️ Keski",  value:`${huominen.keski} c/kWh`, inline:true },
        { name:"🔺 Kallein",value:`${huominen.kallein.price} c/kWh\nklo ${huominen.kallein.time}`, inline:true }
      )
      .setFooter({ text:"Lähde: Elering (Nord Pool -pörssihinta, ALV 0%) — ei suoraan sama luku kuin muissa /sahko-näkymissä" });

    return interaction.editReply({ embeds:[embed], files:[attachment] });
  }

  const data = await haePorssisahkoData(false);
  if (!data) return interaction.editReply("Sähkötietoja ei saatu haettua. Yritä hetken kuluttua uudelleen.");

  const prices = data.kaikki;
  const sorted = [...prices].sort((a,b) => a.price - b.price);

  // Graafi aina mukana
  const graafi = piirraGraafi(prices);
  const attachment = new AttachmentBuilder(graafi, { name:"sahko.png" });

  const embed = new EmbedBuilder()
    .setTitle("⚡ Pörssisähkö")
    .setURL("https://www.porssisahkoa.fi/")
    .setImage("attachment://sahko.png");

  if (nakyma === "yhteenveto") {
    embed.addFields(
      { name:"🔻 Halvin", value:`${data.halvin.price} c/kWh\nklo ${data.halvin.time}`, inline:true },
      { name:"⚖️ Keski",  value:`${data.keski} c/kWh`, inline:true },
      { name:"🔺 Kallein",value:`${data.kallein.price} c/kWh\nklo ${data.kallein.time}`, inline:true }
    );
  } else if (nakyma === "matalin") {
    const halvimmat = sorted.slice(0, 5);
    embed.addFields({ name:"🔻 Halvimmat tunnit", value:
      halvimmat.map((p,i) => `${i+1}. klo ${p.time} — **${p.price} c/kWh**`).join("\n")
    });
  } else if (nakyma === "kallein") {
    const kalleimmat = sorted.slice(-5).reverse();
    embed.addFields({ name:"🔺 Kalleimmat tunnit", value:
      kalleimmat.map((p,i) => `${i+1}. klo ${p.time} — **${p.price} c/kWh**`).join("\n")
    });
  } else if (nakyma === "kaikki") {
    const lista = prices.map(p => `klo ${p.time} — ${p.price} c/kWh`).join("\n");
    embed.addFields(
      { name:"⚖️ Keskihinta", value:`${data.keski} c/kWh`, inline:true },
      { name:"🔻 Halvin", value:`${data.halvin.price} c/kWh (klo ${data.halvin.time})`, inline:true },
      { name:"🔺 Kallein", value:`${data.kallein.price} c/kWh (klo ${data.kallein.time})`, inline:true },
      { name:"📋 Kaikki tunnit", value: lista }
    );
  }

  return interaction.editReply({ embeds:[embed], files:[attachment] });
}

async function suoritaSaa(interaction, kaupunki) {
  await interaction.deferReply({ flags:64 });
  const data = await haeSaa(kaupunki);
  if (!data) return interaction.editReply("Säätietoja ei löytynyt.");
  const c = data.current;
  const embed = new EmbedBuilder()
    .setTitle(`🌤️ Sää: ${data.location.name}`)
    .setDescription(c.condition.text)
    .setThumbnail(`https:${c.condition.icon}`)
    .addFields(
      { name:"🌡️ Lämpötila",  value:`${c.temp_c} °C`,                    inline:true },
      { name:"🤔 Tuntuu kuin", value:`${c.feelslike_c} °C`,               inline:true },
      { name:"💨 Tuuli",       value:`${(c.wind_kph/3.6).toFixed(1)} m/s`,inline:true },
      { name:"💧 Kosteus",     value:`${c.humidity}%`,                    inline:true },
      { name:"☁️ Pilvisyys",   value:`${c.cloud}%`,                       inline:true },
      { name:"👀 Näkyvyys",    value:`${c.vis_km} km`,                    inline:true }
    );

  const paiva = data.forecast?.forecastday?.[0];
  if (paiva) {
    if (paiva.astro?.sunrise) {
      embed.addFields({ name:"🌅 Auringonnousu", value: muunna12h24h(paiva.astro.sunrise), inline:true });
    }
    if (paiva.astro?.sunset) {
      embed.addFields({ name:"🌇 Auringonlasku", value: muunna12h24h(paiva.astro.sunset), inline:true });
    }
    if (paiva.day?.maxtemp_c !== undefined) {
      const aika = etsiMaxLampoAika(paiva.hour, paiva.day.maxtemp_c);
      embed.addFields({ name:"🔥 Päivän ylin lämpötila", value: aika ? `${paiva.day.maxtemp_c} °C (klo ${aika})` : `${paiva.day.maxtemp_c} °C`, inline:true });
    }
    if (paiva.day?.totalsnow_cm > 0) {
      embed.addFields({ name:"❄️ Lumisade", value:`${paiva.day.totalsnow_cm} cm`, inline:true });
    }
  }

  return interaction.editReply({ embeds:[embed] });
}

async function suoritaUni(interaction, tunnit, syva, kevyt, rem, heraamiset) {
  const prosenttiSumma = syva + kevyt + rem;
  const { osat, kokonais } = laskeUnipisteet({ minuutit: tunnit * 60, syva, kevyt, rem, heraamiset });

  const h = Math.floor(tunnit);
  const m = Math.round((tunnit - h) * 60);

  const embed = new EmbedBuilder()
    .setTitle("😴 Unipisteet")
    .setDescription(`## ${kokonais} / 100 — ${uniLuokka(kokonais)}\n${uniPalkki(kokonais)}`)
    .addFields(
      { name:"Kesto", value:`${h}h ${m}min\n${uniPalkki(osat.kesto)} ${Math.round(osat.kesto)}`, inline:false },
      { name:"Syvä uni", value:`${syva}%\n${uniPalkki(osat.syva)} ${Math.round(osat.syva)}`, inline:false },
      { name:"Kevyt uni", value:`${kevyt}%\n${uniPalkki(osat.kevyt)} ${Math.round(osat.kevyt)}`, inline:false },
      { name:"REM-uni", value:`${rem}%\n${uniPalkki(osat.rem)} ${Math.round(osat.rem)}`, inline:false },
      { name:"Heräämiset", value:`${heraamiset} kertaa\n${uniPalkki(osat.heraamiset)} ${Math.round(osat.heraamiset)}`, inline:false }
    )
    .setFooter({ text: Math.abs(prosenttiSumma - 100) > 3 ? `Huom: syvä+kevyt+rem = ${prosenttiSumma.toFixed(0)}%, ei täysin 100%` : "Painotus: kesto 30% · syvä 25% · rem 20% · kevyt 15% · heräämiset 10%" })
    .setColor(kokonais >= 85 ? 0x57f287 : kokonais >= 70 ? 0xfee75c : kokonais >= 55 ? 0xe8a000 : 0xed4245);

  return interaction.reply({ embeds:[embed], flags:64 });
}

async function suoritaPp2(interaction) {
  await interaction.deferReply({ flags:64 });
  const palvelin = await haePP2Palvelin();
  if (!palvelin) {
    return interaction.editReply(`"${PP2_PALVELIN_NIMI}" -palvelinta ei löytynyt hostlistalta juuri nyt (voi olla offline, tai lista ei vastaa).`);
  }
  return interaction.editReply(rakennaPp2Viesti(palvelin));
}

async function suoritaUptime(interaction) {
  const kaynti = muotoileKesto(Math.floor(os.uptime()));
  const [load1, load5, load15] = os.loadavg();
  const ytimet = os.cpus().length;

  const embed = new EmbedBuilder()
    .setTitle("🖥️ Palvelimen käyntiaika ja kuormitus")
    .addFields(
      { name:"⏱️ Käyntiaika", value: kaynti },
      { name:"⚙️ Kuormitusaste (load average)", value:
        `1 min: **${load1.toFixed(2)}**\n5 min: **${load5.toFixed(2)}**\n15 min: **${load15.toFixed(2)}**` }
    )
    .setFooter({ text:`Isäntäkoneella on ${ytimet} suoritinydintä. Kuormitusaste kertoo kuinka monta prosessia keskimäärin odottaa suoritinaikaa — arvo ytimien määrän (${ytimet}) tienoilla tarkoittaa konetta täydessä käytössä, sen yli menevä jonottamista.` });

  return interaction.reply({ embeds:[embed], flags:64 });
}

async function suoritaLiikenne(interaction, sub) {
  await interaction.deferReply({ flags:64 });

  if (sub === "tie") {
    const tieData = await haeTiehairot();
    const embed = new EmbedBuilder()
      .setTitle("🚗 Tieliikenne")
      .setURL("https://liikennetilanne.fintraffic.fi/")
      .setColor(0xe8a000)
      .setFooter({ text:"Lähde: Digitraffic / Fintraffic" }).setTimestamp();

    if (!tieData) embed.setDescription("Tietoja ei saatavilla.");
    else if (!tieData.length) embed.setDescription("✅ Ei aktiivisia häiriöitä.");
    else embed.setDescription(
      tieData.map(h => `• **${h.otsikko}**${h.sijainti?`\n  ${h.sijainti}`:""}${h.alkoi?`\n  🕐 Alkaen ${h.alkoi}`:""}`).join("\n\n")
    );
    return interaction.editReply({ embeds:[embed] });
  }

  if (sub === "juna") {
    const junaData = await haeJunahahairot();
    const embed = new EmbedBuilder()
      .setTitle("🚆 Junaliikenne")
      .setURL("https://liikennetilanne.fintraffic.fi/")
      .setColor(0xe8a000)
      .setFooter({ text:"Lähde: Digitraffic / Fintraffic" }).setTimestamp();

    if (!junaData) embed.setDescription("Tietoja ei saatavilla.");
    else if (!junaData.length) embed.setDescription("✅ Ei merkittäviä myöhästymisiä.");
    else embed.setDescription(
      junaData.map(j => `• **${j.juna}** — myöhässä **${j.myohassa} min** (${j.asema})`).join("\n")
    );
    return interaction.editReply({ embeds:[embed] });
  }

  if (sub === "meri") {
    const meriData = await haeMeriHairot();
    const embed = new EmbedBuilder()
      .setTitle("⚓ Merenkulku")
      .setURL("https://www.traficom.fi/")
      .setColor(0xe8a000)
      .setFooter({ text:"Lähde: Digitraffic / Fintraffic (turvalaitteiden viat)" }).setTimestamp();

    if (!meriData) embed.setDescription("Tietoja ei saatavilla.");
    else if (!meriData.length) embed.setDescription("✅ Ei aktiivisia turvalaitehäiriöitä.");
    else embed.setDescription(
      meriData.map(m => `• **${m.nimi}** — ${m.tyyppi}\n  ${m.vayla} (${m.alue})\n  🕐 ${m.alkoi}`).join("\n\n")
    );
    return interaction.editReply({ embeds:[embed] });
  }
}

const HSL_VAKAVUUS_EMOJI = { INFO: "ℹ️", WARNING: "⚠️", SEVERE: "🛑" };

async function suoritaHsl(interaction, sub, nimi, linja) {
  await interaction.deferReply({ flags:64 });

  if (sub === "hairiot") {
    const hairiot = await haeHslHairiot();
    const embed = new EmbedBuilder()
      .setTitle("🚌 HSL — 5 viimeisintä häiriötiedotetta")
      .setURL("https://www.hsl.fi/hairiot")
      .setColor(0x007ac9)
      .setFooter({ text:"Lähde: HSL / Digitransit" }).setTimestamp();

    if (!hairiot) embed.setDescription("Tietoja ei saatavilla juuri nyt.");
    else if (!hairiot.length) embed.setDescription("✅ Ei aktiivisia häiriötiedotteita.");
    else embed.setDescription(
      hairiot.map(h => `${HSL_VAKAVUUS_EMOJI[h.vakavuus] || "•"} **${h.otsikko}**\n${h.kuvaus}\n🕐 Alkaen ${h.alkoi}`).join("\n\n")
    );
    return interaction.editReply({ embeds:[embed] });
  }

  if (sub === "pysakki") {
    const lahdot = await haeHslPysakinLahdot(nimi, linja);
    const embed = new EmbedBuilder()
      .setTitle(linja ? `🚏 Seuraavat lähdöt — ${nimi} (linja ${linja})` : `🚏 Seuraavat lähdöt — ${nimi}`)
      .setURL("https://www.hsl.fi/reitit")
      .setColor(0x007ac9)
      .setFooter({ text:"Lähde: HSL / Digitransit" }).setTimestamp();

    if (!lahdot) embed.setDescription("Tietoja ei saatavilla juuri nyt.");
    else if (!lahdot.length) embed.setDescription(
      linja ? `Pysäkkiä ei löytynyt, tai linjalla ${linja} ei ole tulevia lähtöjä sieltä juuri nyt.`
            : "Pysäkkiä ei löytynyt, tai sillä ei ole tulevia lähtöjä juuri nyt."
    );
    else embed.setDescription(
      lahdot.map(l => `🚌 **${l.linja}** → ${l.suunta}\n📍 ${l.pysakki}\n🕐 ${l.aika}`).join("\n\n")
    );
    return interaction.editReply({ embeds:[embed] });
  }
}

async function suoritaLampo(interaction, sub) {
  if (sub === "koti") {
    if (!isLampoKotiAllowed(interaction)) {
      return interaction.reply({ content:"Sinulla ei ole oikeuksia tähän komentoon.", flags:64 });
    }
    await interaction.deferReply({ flags:64 });
    const mittaukset = await haeKotiMittaukset();
    if (!mittaukset?.length) return interaction.editReply("Lämpötilan hakeminen epäonnistui. Yritä hetken kuluttua uudelleen.");

    const mittaus = mittaukset.at(-1);
    const aika = new Date(mittaus.timestamp).toLocaleString("fi-FI", { timeZone:"Europe/Helsinki", dateStyle:"short", timeStyle:"short" });
    const graafi = piirraLampoGraafi(mittaukset);
    const attachment = new AttachmentBuilder(graafi, { name:"lampo.png" });

    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle("🌡️ Kodin lämpötila")
        .setDescription(`**${mittaus.value.toFixed(1)} °C**`)
        .addFields({ name:"🕐 Mittausaika", value: aika })
        .setImage("attachment://lampo.png")
        .setFooter({ text:"Lähde: OmaSATO" })],
      files: [attachment]
    });
  }

  if (sub === "savu") {
    const celsius = haeSavuLampotila();
    if (celsius == null) return interaction.reply({ content:"Lämpötilan lukeminen epäonnistui.", flags:64 });

    return interaction.reply({
      flags: 64,
      embeds: [new EmbedBuilder()
        .setTitle("🌡️ Savu — sisäinen lämpötila")
        .setDescription(`**${celsius.toFixed(1)} °C**`)
        .setFooter({ text:"Raspberry Pi SoC-lämpötila" })]
    });
  }
}

/* --- /ai: AI-sisällön tunnistus (OpenAI Content Provenance API) ---
   Tunnistaa vain allekirjoitukset/vesileimat: OpenAI:n C2PA-manifestin (kuvat) ja SynthID-vesileiman
   (kuvat ja ääni). "Ei löytynyt" EI tarkoita, että sisältö olisi aitoa. */

const OPENAI_PROVENANCE_URL = "https://api.openai.com/v1/content_provenance_checks";
const AI_MAX_KOKO = 50 * 1024 * 1024; // API:n raja 50 MiB
const AI_COOLDOWN_MS = 20 * 1000;     // API:n rate limitit ovat tiukat
const aiCooldown = new Map();          // käyttäjä-id → viimeisimmän tarkistuksen aika

// Linkin takaa ei haeta botin kotiverkosta (LAN, localhost) — muut palvelut voivat olla samassa koneessa/verkossa.
function onYksityinenIp(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return onYksityinenIp(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function tarkistaJulkinenUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error("Linkki ei ole kelvollinen osoite."); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Vain http- ja https-linkit kelpaavat.");
  const osoitteet = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!osoitteet.length) throw new Error("Linkin palvelinta ei löytynyt.");
  if (osoitteet.some(o => onYksityinenIp(o.address))) throw new Error("Linkki osoittaa sisäverkkoon, sitä ei haeta.");
  return u;
}

// Lataa tiedoston kokorajalla. Uudelleenohjaukset seurataan käsin, jotta jokainen hyppy tarkistetaan.
async function lataaAiTiedosto(url) {
  let nykyinen = url;
  for (let hyppy = 0; hyppy < 4; hyppy++) {
    const u = await tarkistaJulkinenUrl(nykyinen);
    const res = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
      headers: { "User-Agent": "Mozilla/5.0 (discord-bot-savu; AI-tunnistus)" }
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      nykyinen = new URL(res.headers.get("location"), u).href;
      continue;
    }
    if (!res.ok) throw new Error(`Linkin haku epäonnistui (HTTP ${res.status}).`);
    if (Number(res.headers.get("content-length")) > AI_MAX_KOKO) throw new Error("Tiedosto on yli 50 Mt.");

    const palat = [];
    let koko = 0;
    for await (const pala of res.body) {
      koko += pala.length;
      if (koko > AI_MAX_KOKO) throw new Error("Tiedosto on yli 50 Mt.");
      palat.push(pala);
    }
    return { data: Buffer.concat(palat), tyyppi: res.headers.get("content-type") || "", url: u.href };
  }
  throw new Error("Linkki ohjaa liian monta kertaa eteenpäin.");
}

// Tunnistaa tiedostotyypin sisällöstä (ei päätteestä/otsakkeesta, jotka ovat usein väärin).
function tunnistaAiMediatyyppi(buf) {
  if (buf.length < 12) return null;
  const ascii = (alku, loppu) => buf.toString("latin1", alku, loppu);
  if (buf[0] === 0x89 && ascii(1, 4) === "PNG") return { mime: "image/png", paate: "png", laji: "kuva" };
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { mime: "image/jpeg", paate: "jpg", laji: "kuva" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { mime: "image/webp", paate: "webp", laji: "kuva" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return { mime: "audio/wav", paate: "wav", laji: "ääni" };
  if (ascii(0, 4) === "fLaC") return { mime: "audio/flac", paate: "flac", laji: "ääni" };
  // Discordin ääniviestit ovat Ogg Opusta; Ogg Vorbis ei ole tuettu.
  if (ascii(0, 4) === "OggS") return ascii(0, 200).includes("OpusHead") ? { mime: "audio/ogg", paate: "ogg", laji: "ääni" } : null;
  if (ascii(0, 3) === "ID3") return { mime: "audio/mpeg", paate: "mp3", laji: "ääni" };
  if (buf[0] === 0xFF && (buf[1] & 0xF6) === 0xF0) return { mime: "audio/aac", paate: "aac", laji: "ääni" };   // ADTS
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0 && (buf[1] & 0x06)) return { mime: "audio/mpeg", paate: "mp3", laji: "ääni" };
  if (ascii(4, 8) === "ftyp" && ["M4A ", "M4B "].includes(ascii(8, 12))) return { mime: "audio/mp4", paate: "m4a", laji: "ääni" };
  return null;
}

// Jos linkki on tavallinen nettisivu, kokeillaan sen og:image/og:audio-esikatselua.
function etsiSivunMedia(html, sivunUrl) {
  const $ = cheerio.load(html);
  const osoite = $('meta[property="og:audio"], meta[property="og:audio:url"]').attr("content")
    || $('meta[property="og:image"], meta[name="twitter:image"]').attr("content");
  if (!osoite) return null;
  try { return new URL(osoite, sivunUrl).href; } catch { return null; }
}

const AI_VALIDOINTI = {
  trusted: "luotettu", valid: "kelvollinen", invalid: "virheellinen", not_present: "ei manifestia"
};

function muotoileAiTulos(r) {
  const rivit = [r.outcome === "detected" ? "✅ **Löytyi**" : "➖ Ei löytynyt"];
  if (r.type === "c2pa" && r.validation_state) rivit.push(`Allekirjoitus: ${AI_VALIDOINTI[r.validation_state] || r.validation_state}`);
  if (r.issuer) rivit.push(`Julkaisija: ${r.issuer}`);
  if (r.model) rivit.push(`Malli: \`${r.model}\``);
  if (r.generated_at) {
    const aika = new Date(r.generated_at);
    if (!isNaN(aika)) rivit.push(`Luotu: <t:${Math.floor(aika / 1000)}:f>`);
  }
  return rivit.join("\n");
}

function rakennaAiEmbed(vastaus, tiedot) {
  const tulokset = Array.isArray(vastaus.results) ? vastaus.results : [];
  const havaittu = tulokset.some(r => r.outcome === "detected");
  const c2pa = tulokset.find(r => r.type === "c2pa");

  let kuvaus;
  if (havaittu) {
    kuvaus = "🤖 **Tiedostosta löytyi AI-merkintä** — se on todennäköisesti tekoälyllä tehty.";
  } else if (!tulokset.length) {
    kuvaus = "Yksikään tarkistus ei soveltunut tälle tiedostolle.";
  } else {
    kuvaus = "Tunnettuja AI-merkintöjä ei löytynyt.\n" +
      "-# Tämä **ei todista**, että sisältö on aitoa: tarkistus tunnistaa vain OpenAI:n C2PA-allekirjoituksen ja " +
      "SynthID-vesileiman, ja merkinnät katoavat usein kuvakaappauksessa, muokatessa tai somepalvelun uudelleenpakatessa.";
    if (c2pa && ["trusted", "valid"].includes(c2pa.validation_state) && c2pa.issuer) {
      kuvaus += `\n\nℹ️ Tiedostossa on C2PA-allekirjoitus julkaisijalta **${c2pa.issuer}**, mutta tämä tarkistus tulkitsee vain OpenAI:n merkinnät.`;
    }
  }

  const NIMET = { c2pa: "🔏 C2PA (Content Credentials)", synthid: "💧 SynthID-vesileima" };
  const embed = new EmbedBuilder()
    .setTitle(havaittu ? "🤖 AI-tunnistus — AI-merkintä löytyi" : "🔍 AI-tunnistus — ei AI-merkintää")
    .setColor(havaittu ? 0xff4fa3 : 0x95a5a6)
    .setDescription(kuvaus)
    .addFields(tulokset.map(r => ({ name: NIMET[r.type] || r.type, value: muotoileAiTulos(r), inline: true })))
    .setFooter({ text: `OpenAI Content Provenance · ${tiedot.nimi} · ${tiedot.laji}, ${(tiedot.koko / 1024 / 1024).toFixed(2)} Mt` });
  if (tiedot.laji === "kuva" && tiedot.esikatselu) embed.setThumbnail(tiedot.esikatselu);
  return embed;
}

async function suoritaAi(interaction, liite, linkki) {
  linkki = linkki?.trim();
  if (!liite === !linkki) {
    return interaction.reply({ content: "Anna joko **tiedosto** (liite) tai **linkki** — toinen niistä, ei molempia.", flags: 64 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return interaction.reply({ content: "AI-tunnistus ei ole käytössä: OpenAI-API-avainta ei ole määritetty.", flags: 64 });
  }
  const viimeksi = aiCooldown.get(interaction.user.id) || 0;
  if (Date.now() - viimeksi < AI_COOLDOWN_MS) {
    const odota = Math.ceil((AI_COOLDOWN_MS - (Date.now() - viimeksi)) / 1000);
    return interaction.reply({ content: `⏳ Odota ${odota} s ennen seuraavaa tarkistusta.`, flags: 64 });
  }
  if (liite && liite.size > AI_MAX_KOKO) {
    return interaction.reply({ content: "Tiedosto on liian suuri (enintään 50 Mt).", flags: 64 });
  }

  await interaction.deferReply({ flags: 64 });
  aiCooldown.set(interaction.user.id, Date.now());

  let lataus, nimi;
  try {
    if (liite) {
      lataus = await lataaAiTiedosto(liite.url);
      nimi = liite.name;
    } else {
      lataus = await lataaAiTiedosto(linkki);
      if (!tunnistaAiMediatyyppi(lataus.data) && /text\/html/i.test(lataus.tyyppi)) {
        const media = etsiSivunMedia(lataus.data.toString("utf8"), lataus.url);
        if (media) lataus = await lataaAiTiedosto(media);
      }
      nimi = decodeURIComponent(new URL(lataus.url).pathname.split("/").pop() || "") || "linkki";
    }
  } catch (err) {
    return interaction.editReply(`❌ ${err.name === "TimeoutError" ? "Tiedoston lataus aikakatkaistiin." : err.message}`);
  }

  const tyyppi = tunnistaAiMediatyyppi(lataus.data);
  if (!tyyppi) {
    return interaction.editReply(
      "❌ Tiedostotyyppiä ei tueta. Kelpaavat: kuvat **PNG, JPEG, WebP** ja ääni **MP3, Opus (Discordin ääniviestit), AAC, FLAC, WAV**." +
      (linkki ? "\n-# Linkin pitää osoittaa suoraan kuva- tai äänitiedostoon." : "")
    );
  }

  const lomake = new FormData();
  lomake.append("file", new Blob([lataus.data], { type: tyyppi.mime }), `tiedosto.${tyyppi.paate}`);
  let res, vastaus;
  try {
    res = await fetch(OPENAI_PROVENANCE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: lomake,
      signal: AbortSignal.timeout(60000)
    });
    vastaus = await res.json().catch(() => ({}));
  } catch (err) {
    console.error("AI-tunnistus: pyyntö epäonnistui:", err.message);
    return interaction.editReply("❌ OpenAI-palveluun ei saatu yhteyttä. Yritä hetken kuluttua uudelleen.");
  }

  if (!res.ok) {
    const viesti = vastaus?.error?.message || "";
    console.error(`AI-tunnistus: HTTP ${res.status} ${viesti}`);
    if (res.status === 429) return interaction.editReply("⏳ OpenAI:n käyttöraja täyttyi. Yritä hetken kuluttua uudelleen.");
    if (res.status === 404) return interaction.editReply("❌ OpenAI-tilillä ei ole pääsyä AI-tunnistukseen (Content Provenance).");
    if (res.status === 400) {
      return interaction.editReply(`❌ Tiedostoa ei voitu tarkistaa. Ääni saa olla enintään 60 sekuntia.${viesti ? `\n-# OpenAI: ${viesti.slice(0, 300)}` : ""}`);
    }
    return interaction.editReply(`❌ AI-tunnistus epäonnistui (HTTP ${res.status}). Yritä hetken kuluttua uudelleen.`);
  }

  return interaction.editReply({
    embeds: [rakennaAiEmbed(vastaus, {
      nimi, laji: tyyppi.laji, koko: lataus.data.length,
      esikatselu: liite ? liite.url : lataus.url
    })]
  });
}

async function suoritaAlko(interaction, sub) {
  await interaction.deferReply({ flags:64 });
  const tuotteet = await haeAlkoTuotteet();
  if (!tuotteet) return interaction.editReply("Tuotetietojen hakeminen epäonnistui. Yritä hetken kuluttua uudelleen.");

  if (sub === "halvinhinta") {
    const halvimmat = [...tuotteet]
      .filter(t => t.alkoholi_prosentti > 0)
      .sort((a,b) => alkoEfHinta(a) - alkoEfHinta(b))
      .slice(0, 5);
    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle("🍺 Alko — Halvin hinta")
        .setURL("https://juomaan.fi/")
        .setDescription(muotoileAlkoLista(halvimmat, alkoEfHinta, "€"))
        .setFooter({ text:"Lähde: juomaan.fi (Alko) · pantti sisältyy hintaan" })]
    });
  }

  if (sub === "halvinannos" || sub === "dokaviteetti") {
    const halvimmat = [...tuotteet]
      .filter(t => alkoAnnosHinta(t) !== Infinity)
      .sort((a,b) => alkoAnnosHinta(a) - alkoAnnosHinta(b))
      .slice(0, 5);
    const otsikko = sub === "dokaviteetti" ? "🍻 Alko — Paras dokaviteetti" : "🍻 Alko — Halvin annos";
    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle(otsikko)
        .setURL("https://juomaan.fi/")
        .setDescription(muotoileAlkoLista(halvimmat, alkoAnnosHinta, "€/annos"))
        .setFooter({ text:"Lähde: juomaan.fi (Alko) · 1 annos = 1,5 cl puhdasta alkoholia" })]
    });
  }
}

async function suoritaOsake(interaction, haku, aikavaliOverride) {
  await interaction.deferReply({ flags:64 });

  const aikaväli = aikavaliOverride || loadGuildConfig(interaction.guildId).settings.osakeDefaultAikavali;
  const aikavaliNimi = { "5d":"1 viikko", "1mo":"1 kuukausi", "3mo":"3 kuukautta", "1y":"1 vuosi", "5y":"5 vuotta" };

  const ticker = await haeOsakeTicker(haku);
  if (!ticker) return interaction.editReply(`Osaketta **${haku}** ei löytynyt. Kokeile tickeriä suoraan (esim. \`NOKIA.HE\`, \`AAPL\`).`);

  const data = await haeOsaketiedot(ticker, aikaväli);
  if (!data) return interaction.editReply(`Kurssidata haulle **${ticker}** epäonnistui. Tarkista ticker.`);

  const muutosEmoji = data.muutos >= 0 ? "📈" : "📉";
  const muutosMerkki = data.muutos >= 0 ? "+" : "";

  const graafi = piirraOsakeGraafi(data.pisteet, data.nimi, data.valuutta);
  const attachment = new AttachmentBuilder(graafi, { name:"osake.png" });

  const embed = new EmbedBuilder()
    .setTitle(`${muutosEmoji} ${data.nimi} (${data.ticker})`)
    .setURL(`https://finance.yahoo.com/quote/${data.ticker}`)
    .setImage("attachment://osake.png")
    .addFields(
      { name:"💰 Hinta",   value:`${data.hinta.toFixed(2)} ${data.valuutta}`, inline:true },
      { name:"📊 Muutos",  value:`${muutosMerkki}${data.muutos.toFixed(2)} (${muutosMerkki}${data.muutosProsentti.toFixed(2)}%)`, inline:true },
      { name:"📅 Aikaväli", value:aikavaliNimi[aikaväli], inline:true }
    )
    .setFooter({ text:"Lähde: Yahoo Finance · Hinnat voivat olla viiveellä" })
    .setTimestamp();

  return interaction.editReply({ embeds:[embed], files:[attachment] });
}

async function suoritaTm(interaction, sub, klubiNimi) {
  if (sub === "serveri") return suoritaTmServeri(interaction);
  if (sub === "n" || sub === "u") return suoritaTmUutiset(interaction, sub);

  await interaction.deferReply({ flags: 64 });

  const klubi = await haeKlubi(klubiNimi);
  if (!klubi) return interaction.editReply(`Klubia **${klubiNimi}** ei löytynyt.`);

  const ikonUrl = klubi.iconUrlPngSmall || klubi.iconUrlPngMedium || null;
  const baseEmbed = () => new EmbedBuilder()
    .setTitle(`🎮 ${klubi.name}` + (klubi.tag ? ` [${klubi.tag}]` : ""))
    .setURL(`https://www.trackmania.com/clubs/${klubi.id}`)
    .setFooter({ text:"Lähde: Trackmania Nadeo API" })
    .setTimestamp();

  // --- RANKING ---
  if (sub === "ranking") {
    const jasenet = await haeKlubiJasenet(klubi.id);
    if (!jasenet?.length) return interaction.editReply(`Klubin **${klubi.name}** jäsenten haku epäonnistui.`);

    const accountIds = jasenet.map(j => j.accountId);
    const erissä = [];
    for (let i = 0; i < accountIds.length; i += 25) erissä.push(accountIds.slice(i, i + 25));
    const rankingVastaukset = await Promise.all(erissä.map(erä => haeTrophyRankingit(erä)));
    const kaikkirankingit = rankingVastaukset.flat().filter(Boolean);
    if (!kaikkirankingit.length) return interaction.editReply("Trophy-rankingien haku epäonnistui.");

    const jarjestetty = kaikkirankingit.sort((a, b) => b.countPoint - a.countPoint).slice(0, 15);
    const nimiMap = await haeNimet(jarjestetty.map(r => r.accountId));
    const mitalit = ["🥇", "🥈", "🥉"];
    const rivit = jarjestetty.map((r, i) => {
      const nimi = nimiMap[r.accountId] || r.accountId.slice(0, 8);
      const pisteet = r.countPoint.toLocaleString("fi-FI");
      return `${mitalit[i] || `**${i + 1}.**`} ${nimi} — ${pisteet} tp`;
    }).join("\n");

    const embed = baseEmbed()
      .setTitle(`🏆 ${klubi.name} — Trophy-ranking`)
      .setDescription(rivit)
      .addFields({ name:"👥 Jäseniä yhteensä", value:`${jasenet.length}`, inline:true });
    if (ikonUrl) embed.setThumbnail(ikonUrl);
    return interaction.editReply({ embeds:[embed] });
  }

  // --- INFO ---
  if (sub === "info") {
    const jasenet = await haeKlubiJasenet(klubi.id);
    const embed = baseEmbed()
      .setTitle(`ℹ️ ${klubi.name}`)
      .addFields(
        { name:"🆔 Klubi-ID",    value:`${klubi.id}`,                               inline:true },
        { name:"🏷️ Tag",          value:klubi.tag || "—",                            inline:true },
        { name:"👥 Jäseniä",      value:`${jasenet?.length ?? "?"}`,                 inline:true },
        { name:"✅ Vahvistettu",   value:klubi.isVerified ? "Kyllä" : "Ei",           inline:true },
        { name:"⭐ Suosio",        value:`${klubi.popularityLevel ?? "—"}`,           inline:true },
      );
    if (klubi.description) embed.setDescription(klubi.description);
    if (ikonUrl) embed.setThumbnail(ikonUrl);
    return interaction.editReply({ embeds:[embed] });
  }

  // --- KAMPANJAT ---
  if (sub === "kampanjat") {
    const kampanjat = await haeKlubiKampanjat(klubi.id);
    if (!kampanjat?.length) return interaction.editReply(`Klubilla **${klubi.name}** ei ole kampanjoita.`);

    const rivit = kampanjat.slice(0, 15).map(k => {
      const pvm = k.publicationTimestamp
        ? new Date(k.publicationTimestamp * 1000).toLocaleDateString("fi-FI")
        : "—";
      return `🗺️ **${k.name}** — ${k.mapsCount ?? "?"} karttaa *(${pvm})*`;
    }).join("\n");

    const embed = baseEmbed()
      .setTitle(`📋 ${klubi.name} — Kampanjat`)
      .setDescription(rivit)
      .addFields({ name:"📊 Yhteensä", value:`${kampanjat.length} kampanjaa`, inline:true });
    if (ikonUrl) embed.setThumbnail(ikonUrl);
    return interaction.editReply({ embeds:[embed] });
  }

  // --- HUONEET ---
  if (sub === "huoneet") {
    const huoneet = await haeKlubiHuoneet(klubi.id);
    if (!huoneet?.length) return interaction.editReply(`Klubilla **${klubi.name}** ei ole huoneita.`);

    const rivit = huoneet.slice(0, 15).map(h => {
      const pelaajat = h.playerCount != null ? ` — ${h.playerCount} pelaajaa` : "";
      const region = h.region ? ` *(${h.region})*` : "";
      return `🖥️ **${h.name}**${pelaajat}${region}`;
    }).join("\n");

    const embed = baseEmbed()
      .setTitle(`🖥️ ${klubi.name} — Huoneet`)
      .setDescription(rivit)
      .addFields({ name:"📊 Yhteensä", value:`${huoneet.length} huonetta`, inline:true });
    if (ikonUrl) embed.setThumbnail(ikonUrl);
    return interaction.editReply({ embeds:[embed] });
  }

  // --- AKTIVITEETIT ---
  if (sub === "aktiviteetit") {
    const aktiviteetit = await haeKlubiAktiviteetit(klubi.id);
    if (!aktiviteetit?.length) return interaction.editReply(`Klubilla **${klubi.name}** ei ole aktiviteetteja.`);

    const tyyppiEmoji = { "room":"🖥️", "campaign":"📋", "news":"📰", "competition":"🏆", "upload":"📤" };
    const rivit = aktiviteetit.slice(0, 20).map(a => {
      const emoji = tyyppiEmoji[a.activityType?.toLowerCase()] || "▪️";
      const pvm = a.publicationTimestamp
        ? new Date(a.publicationTimestamp * 1000).toLocaleDateString("fi-FI")
        : "";
      return `${emoji} **${a.name}** *(${a.activityType ?? "?"})* ${pvm}`;
    }).join("\n");

    const embed = baseEmbed()
      .setTitle(`📂 ${klubi.name} — Aktiviteetit`)
      .setDescription(rivit)
      .addFields({ name:"📊 Yhteensä", value:`${aktiviteetit.length} aktiviteettia`, inline:true });
    if (ikonUrl) embed.setThumbnail(ikonUrl);
    return interaction.editReply({ embeds:[embed] });
  }

  // --- SHORTS ---
  if (sub === "shorts") {
    const shorts = await haeWeeklyShorts();
    if (!shorts) return interaction.editReply("Weekly Shorts -tietoja ei saatu haettua.");

    const kartat = shorts.campaign?.playlist || [];
    if (!kartat.length) return interaction.editReply("Weekly Shorts -karttoja ei löytynyt.");

    const groupUid = shorts.campaign?.leaderboardGroupUid || "Personal_Best";
    const viikko = shorts.campaign?.name || "Weekly Shorts";

    // Haetaan kaikki kartat rinnakkain
    const tulokset = await Promise.all(
      kartat.map(k => haeKarttaTuloksetKlubille(groupUid, k.mapUid, klubi.id))
    );

    // Kerätään kaikki uniikit pelaajat nimihakua varten
    const kaikkiIds = [...new Set(tulokset.flat().map(r => r.accountId))];
    const nimiMap = kaikkiIds.length ? await haeNimet(kaikkiIds) : {};

    const msToTime = ms => {
      const min = Math.floor(ms / 60000);
      const sec = Math.floor((ms % 60000) / 1000);
      const hun = Math.floor((ms % 1000) / 10);
      return min > 0
        ? `${min}:${String(sec).padStart(2,"0")}.${String(hun).padStart(2,"0")}`
        : `${sec}.${String(hun).padStart(2,"0")}`;
    };

    const mitalit = ["🥇","🥈","🥉"];
    const embeds = [];

    kartat.forEach((k, i) => {
      const top = tulokset[i] || [];
      if (!top.length) return;

      const rivit = top.map((r, j) => {
        const nimi = nimiMap[r.accountId] || r.accountId.slice(0, 8);
        const aika = msToTime(r.score);
        return `${mitalit[j] || `**${j+1}.**`} ${nimi} — \`${aika}\``;
      }).join("\n");

      embeds.push(new EmbedBuilder()
        .setTitle(`🗺️ Kartta ${i + 1}`)
        .setDescription(rivit || "Ei tuloksia klubin jäseniltä.")
        .setColor(0x5865f2)
      );
    });

    if (!embeds.length) return interaction.editReply(`Kukaan klubin **${klubi.name}** jäsenistä ei ole ajanut Weekly Shorts -karttoja tällä viikolla.`);

    // Discord sallii max 10 embeddiä per viesti
    const header = baseEmbed()
      .setTitle(`⏱️ ${klubi.name} — ${viikko}`)
      .setDescription(`Klubin sisäiset tulokset tämän viikon Weekly Shorts -kartoilla.\n**${kartat.length} karttaa** · top 10 per kartta`)
      .setColor(0x5865f2);
    if (ikonUrl) header.setThumbnail(ikonUrl);

    return interaction.editReply({ embeds: [header, ...embeds.slice(0, 9)] });
  }
}

/* --- /savu-valikon suoritus: yhdistää yllä olevat suoritaX-funktiot valittuun toimintoon --- */

async function suoritaSavuToiminto(interaction, toimintoValue, kentat) {
  switch (toimintoValue) {
    case "nimipäivät": return suoritaNimipaivat(interaction);
    case "liputuspaiva": return suoritaLiputuspaiva(interaction);
    case "joulu": return suoritaJoulu(interaction);
    case "juhannus": return suoritaJuhannus(interaction);
    case "nimipaiva": return suoritaNimipaivaHaku(interaction, kentat.nimi);
    case "synttarit": return suoritaSynttaritHaku(interaction, kentat.haku);
    case "nimihaku-etu": return suoritaNimihaku(interaction, "etu", kentat.nimi);
    case "nimihaku-suku": return suoritaNimihaku(interaction, "suku", kentat.nimi);
    case "sahko": return suoritaSahko(interaction, "yhteenveto");
    case "saa": return suoritaSaa(interaction, kentat.kaupunki);
    case "liikenne-tie": return suoritaLiikenne(interaction, "tie");
    case "liikenne-juna": return suoritaLiikenne(interaction, "juna");
    case "liikenne-meri": return suoritaLiikenne(interaction, "meri");
    case "hsl-hairiot": return suoritaHsl(interaction, "hairiot");
    case "hsl-pysakki": return suoritaHsl(interaction, "pysakki", kentat.nimi);
    case "lampo-koti": return suoritaLampo(interaction, "koti");
    case "lampo-savu": return suoritaLampo(interaction, "savu");
    case "alko-halvinhinta": return suoritaAlko(interaction, "halvinhinta");
    case "alko-halvinannos": return suoritaAlko(interaction, "halvinannos");
    case "alko-dokaviteetti": return suoritaAlko(interaction, "dokaviteetti");
    case "osake": return suoritaOsake(interaction, kentat.haku, null);
    case "btc": return suoritaOsake(interaction, "BTC-USD", null);
    case "eth": return suoritaOsake(interaction, "ETH-USD", null);
    case "uni": {
      const tunnit = Number(kentat.tunnit);
      const syva = Number(kentat.syva);
      const kevyt = Number(kentat.kevyt);
      const rem = Number(kentat.rem);
      const heraamiset = Number(kentat.heraamiset);
      const virheet = [];
      if (!Number.isFinite(tunnit) || tunnit < 0 || tunnit > 16) virheet.push("Aika vuoteessa: numero väliltä 0–16.");
      if (!Number.isFinite(syva) || syva < 0 || syva > 100) virheet.push("Syvä uni: numero väliltä 0–100.");
      if (!Number.isFinite(kevyt) || kevyt < 0 || kevyt > 100) virheet.push("Kevyt uni: numero väliltä 0–100.");
      if (!Number.isFinite(rem) || rem < 0 || rem > 100) virheet.push("REM-uni: numero väliltä 0–100.");
      if (!Number.isInteger(heraamiset) || heraamiset < 0 || heraamiset > 30) virheet.push("Heräämiskerrat: kokonaisluku väliltä 0–30.");
      if (virheet.length) return interaction.reply({ content:`Tarkista syötteet:\n• ${virheet.join("\n• ")}`, flags:64 });
      return suoritaUni(interaction, tunnit, syva, kevyt, rem, heraamiset);
    }
    case "pp2": return suoritaPp2(interaction);
    case "wow": return suoritaWow(interaction);
    case "lotto": return suoritaLotto(interaction);
    case "eurojaska": return suoritaEurojaska(interaction);
    case "uptime": return suoritaUptime(interaction);
    case "ai": return suoritaAi(interaction, null, kentat.linkki);
    case "uutiset-luetuimmat": return suoritaUutiset(interaction, "luetuimmat");
    case "uutiset-uusimmat": return suoritaUutiset(interaction, "uusimmat");
    case "th-uusimmat": return suoritaTilannehuone(interaction, "uusimmat");
    case "th-lista": return suoritaTilannehuone(interaction, "lista");
    case "th-haku": return suoritaThHaku(interaction, kentat.paikkakunta, 100);
    case "tm-ranking": return suoritaTm(interaction, "ranking", kentat.klubi);
    case "tm-info": return suoritaTm(interaction, "info", kentat.klubi);
    case "tm-kampanjat": return suoritaTm(interaction, "kampanjat", kentat.klubi);
    case "tm-huoneet": return suoritaTm(interaction, "huoneet", kentat.klubi);
    case "tm-aktiviteetit": return suoritaTm(interaction, "aktiviteetit", kentat.klubi);
    case "tm-shorts": return suoritaTm(interaction, "shorts", kentat.klubi);
    case "tm-serveri": return suoritaTmServeri(interaction);
    case "tm-n": return suoritaTmUutiset(interaction, "n");
    case "tm-u": return suoritaTmUutiset(interaction, "u");
    default: return interaction.reply({ content:"Tuntematon komento.", flags:64 });
  }
}

async function kasitteleSavuValinta(interaction, toimintoValue) {
  const toiminto = loydaSavuToiminto(toimintoValue);
  if (!toiminto) return interaction.reply({ content:"Tuntematon komento.", flags:64 });

  const map = SAVU_KOMENTO_MAP[toimintoValue];
  const featureKey = map ? (map.sub ? `${map.cmd}.${map.sub}` : map.cmd) : toimintoValue;
  if (!isFeatureEnabled(interaction.guildId, featureKey)) {
    return interaction.reply({ content:"🚫 Tämä ominaisuus on tilapäisesti pois käytöstä.", flags:64 });
  }

  if (!toiminto.args.length) {
    return suoritaSavuToiminto(interaction, toimintoValue, {});
  }

  const modal = new ModalBuilder()
    .setCustomId(`savu-modal:${toimintoValue}`)
    .setTitle(toiminto.label.slice(0, 45));
  for (const kentta of toiminto.args) {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(kentta.key)
        .setLabel(kentta.label.slice(0, 45))
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(kentta.placeholder || "")
        .setRequired(true)
    ));
  }
  return interaction.showModal(modal);
}

async function kasitteleSavuModalinLahetys(interaction) {
  const toimintoValue = interaction.customId.slice("savu-modal:".length);
  const toiminto = loydaSavuToiminto(toimintoValue);
  if (!toiminto) return interaction.reply({ content:"Tuntematon komento.", flags:64 });
  const kentat = {};
  for (const kentta of toiminto.args) {
    kentat[kentta.key] = interaction.fields.getTextInputValue(kentta.key);
  }
  return suoritaSavuToiminto(interaction, toimintoValue, kentat);
}

/* --- INTERAKTIOT --- */

client.on("interactionCreate", async interaction => {
  try {
    await kasitteleInteraktio(interaction);
  } catch (err) {
    console.error(`Interaktion käsittely epäonnistui (${interaction.id}):`, err);
    try {
      const viesti = "Komennon suoritus epäonnistui odottamattomasti. Yritä hetken kuluttua uudelleen.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(viesti);
      } else if (typeof interaction.reply === "function") {
        await interaction.reply({ content: viesti, flags: 64 });
      }
    } catch (vastausVirhe) {
      console.error("Virheviestin lähetys epäonnistui:", vastausVirhe.message);
    }
  }
});

// Yhden interaktion käsittely omana funktionaan, jotta yllä oleva try/catch kattaa kaiken —
// yksittäisen komennon virhe (esim. huono syöte ulkoisesta API:sta) ei enää kaada koko bottia.
async function kasitteleInteraktio(interaction) {
  if (interaction.isStringSelectMenu() && interaction.customId === "help-kategoria") {
    const valittu = interaction.values[0];
    return interaction.update({
      embeds: [rakennaHelpEmbed(valittu)],
      components: [rakennaHelpValikko(valittu)]
    });
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "savu-kategoria") {
    const valittu = interaction.values[0];
    return interaction.update({
      embeds: [rakennaSavuEmbed(valittu)],
      components: [rakennaSavuKategoriaValikko(valittu), rakennaSavuToimintoValikko(valittu)]
    });
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "savu-toiminto") {
    return kasitteleSavuValinta(interaction, interaction.values[0]);
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("savu-modal:")) {
    return kasitteleSavuModalinLahetys(interaction);
  }

  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  if (cmd !== "help") {
    const sub = interaction.options.getSubcommand(false);
    const featureKey = sub ? `${cmd}.${sub}` : (cmd === "sää" ? "saa" : cmd);
    if (!isFeatureEnabled(interaction.guildId, featureKey)) {
      return interaction.reply({ content: "🚫 Tämä ominaisuus on tilapäisesti pois käytöstä.", flags: 64 });
    }
  }

  if (cmd === "help") {
    const oletus = HELP_KATEGORIAT[0].value;
    return interaction.reply({
      flags: 64,
      embeds: [rakennaHelpEmbed(oletus)],
      components: [rakennaHelpValikko(oletus)]
    });
  }

  if (cmd === "savu") {
    const oletus = SAVU_KATEGORIAT[0].value;
    return interaction.reply({
      flags: 64,
      embeds: [rakennaSavuEmbed(oletus)],
      components: [rakennaSavuKategoriaValikko(oletus), rakennaSavuToimintoValikko(oletus)]
    });
  }

  if (cmd === "nimipäivät") return suoritaNimipaivat(interaction);
  if (cmd === "liputuspaiva") return suoritaLiputuspaiva(interaction);
  if (cmd === "joulu") return suoritaJoulu(interaction);
  if (cmd === "juhannus") return suoritaJuhannus(interaction);
  if (cmd === "nimipaiva") return suoritaNimipaivaHaku(interaction, interaction.options.getString("nimi"));
  if (cmd === "synttarit") return suoritaSynttaritHaku(interaction, interaction.options.getString("haku"));

  if (cmd === "nimihaku") {
    return suoritaNimihaku(interaction, interaction.options.getSubcommand(), interaction.options.getString("nimi"));
  }

  if (cmd === "uutiset") return suoritaUutiset(interaction, interaction.options.getSubcommand());
  if (cmd === "th") {
    return suoritaTilannehuone(interaction, interaction.options.getSubcommand(),
      interaction.options.getString("paikkakunta"), interaction.options.getInteger("km"));
  }
  if (cmd === "leffat") return suoritaLeffat(interaction, interaction.options.getString("milloin"));
  if (cmd === "lotto") return suoritaLotto(interaction);
  if (cmd === "eurojaska") return suoritaEurojaska(interaction);
  if (cmd === "sahko") return suoritaSahko(interaction, interaction.options.getString("näkymä"));
  if (cmd === "saa" || cmd === "sää") return suoritaSaa(interaction, interaction.options.getString("kaupunki"));

  if (cmd === "uni") {
    return suoritaUni(
      interaction,
      interaction.options.getNumber("tunnit"),
      interaction.options.getNumber("syva"),
      interaction.options.getNumber("kevyt"),
      interaction.options.getNumber("rem"),
      interaction.options.getInteger("heraamiset")
    );
  }

  if (cmd === "pp2") return suoritaPp2(interaction);
  if (cmd === "wow") return suoritaWow(interaction);
  if (cmd === "uptime") return suoritaUptime(interaction);
  if (cmd === "ai") return suoritaAi(interaction, interaction.options.getAttachment("tiedosto"), interaction.options.getString("linkki"));
  if (cmd === "liikenne") return suoritaLiikenne(interaction, interaction.options.getSubcommand());
  if (cmd === "hsl") return suoritaHsl(interaction, interaction.options.getSubcommand(), interaction.options.getString("nimi"), interaction.options.getString("linja"));
  if (cmd === "lampo") return suoritaLampo(interaction, interaction.options.getSubcommand());
  if (cmd === "alko") return suoritaAlko(interaction, interaction.options.getSubcommand());

  if (cmd === "osake") {
    return suoritaOsake(interaction, interaction.options.getString("haku"), interaction.options.getString("aikaväli"));
  }

  if (cmd === "btc") return suoritaOsake(interaction, "BTC-USD", interaction.options.getString("aikaväli"));
  if (cmd === "eth") return suoritaOsake(interaction, "ETH-USD", interaction.options.getString("aikaväli"));

  if (cmd === "tm") {
    return suoritaTm(interaction, interaction.options.getSubcommand(), interaction.options.getString("klubi"));
  }
}

/* --- CRON --- */

function merkitseLahetetyksi(guildId, avain, itemId) {
  try {
    const guildCfg = loadGuildConfig(guildId);
    const lastSent = itemId
      ? { ...guildCfg.lastSent, [avain]: { ...guildCfg.lastSent[avain], [itemId]: Date.now() } }
      : { ...guildCfg.lastSent, [avain]: Date.now() };
    saveGuildConfig(guildId, { ...guildCfg, lastSent });
  } catch (err) {
    console.error(`lastSent-merkinnän tallennus epäonnistui (${guildId}/${avain}):`, err.message);
  }
}

// Palauttaa tämänhetkisen päivämäärän Europe/Helsinki-vyöhykkeellä muodossa "YYYY-MM-DD".
function tamanPaivanPaivamaaraHelsinki() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Helsinki" }).format(new Date());
}

// Tämänhetkinen viikonpäivä Europe/Helsinki-vyöhykkeellä JS:n Date#getDay()-numeroinnilla
// (0 = sunnuntai … 6 = lauantai). ISO-päivämäärästä laskeminen UTC-keskiyönä on turvallista,
// koska viikonpäivä ei riipu kellonajasta — vain kalenteripäivästä.
function tamanPaivanViikonpaivaHelsinki() {
  return new Date(`${tamanPaivanPaivamaaraHelsinki()}T00:00:00Z`).getUTCDay();
}

// Rakentaa yhden mukautetun ilmoituksen cron-lausekkeen. "date" (kertaluontoinen) ajetaan aina
// päivittäisenä cronina ja suodatetaan tarkalla päivämäärällä itse ajofunktiossa, koska mikään
// cron-kenttä ei osaa ilmaista "vain tämä yksi kalenteripäivä". "days" (valitut viikonpäivät)
// sen sijaan voidaan ilmaista suoraan cronin viikonpäiväkentässä.
function mukautettuCronExpr(item) {
  if (!item.date && item.days && item.days.length) {
    return `${item.minute} ${item.hour} * * ${item.days.join(",")}`;
  }
  return `${item.minute} ${item.hour} * * *`;
}

async function ajaAamutervehdys(guildId, force = false) {
  if (!force && !isFeatureEnabled(guildId, "cron.aamutervehdys")) return;
  const guildCfg = loadGuildConfig(guildId);
  const { CHANNEL_ID } = guildCfg.channels;
  if (!CHANNEL_ID) return;

  const channel = await client.channels.fetch(CHANNEL_ID);
  const nimipaivatTeksti = muotoileNimet(haeNimipaivat());
  const liputus = haeLiputuspaiva() || "";
  const synttaritTeksti = muotoileSynttarit(haeSynttarit(guildId));

  const sahko = await haePorssisahkoData(true);
  const sahkoTeksti = sahko
    ? `🔻 ${sahko.halvin.price} c/kWh klo ${sahko.halvin.time}\n⚖️ ${sahko.keski} c/kWh\n🔺 ${sahko.kallein.price} c/kWh klo ${sahko.kallein.time}`
    : "";

  const embed = new EmbedBuilder().setTitle(":wave:  Huomenta!").setURL("https://www.porssisahkoa.fi/");
  let attachment = null;

  const mukautettuTeksti = guildCfg.settings.aamutervehdysTapa === "mukautettu"
    ? guildCfg.settings.aamutervehdysMukautettu.trim()
    : "";

  if (mukautettuTeksti) {
    // Sähkökaavio liitetään vain jos merkinnän käyttäjä on itse päättänyt näyttää
    // sähkötiedot — muuten liite jäisi turhaan viestiin ilman että sitä viitataan tekstissä.
    if (sahko && mukautettuTeksti.includes("{sähkö}")) {
      const graafi = piirraGraafi(sahko.kaikki);
      attachment = new AttachmentBuilder(graafi, { name:"sahko.png" });
      embed.setImage("attachment://sahko.png");
    }
    const teksti = mukautettuTeksti
      .replaceAll("{nimipäivät}", nimipaivatTeksti || "-")
      .replaceAll("{syntymäpäivät}", synttaritTeksti || "-")
      .replaceAll("{liputuspäivä}", liputus || "-")
      .replaceAll("{sähkö}", sahkoTeksti || "-");
    embed.setDescription(teksti.slice(0, 4096));
  } else {
    embed.setDescription(nimipaivatTeksti);
    if (liputus) embed.addFields({ name:"🇫🇮 Liputuspäivä", value:liputus });
    if (synttaritTeksti) embed.addFields({ name:"🎂 Onneksi olkoon", value:synttaritTeksti });
    if (sahko) {
      embed.addFields({ name:"⚡ Sähkö (tästä hetkestä →)", value:sahkoTeksti });
      const graafi = piirraGraafi(sahko.kaikki);
      attachment = new AttachmentBuilder(graafi, { name:"sahko.png" });
      embed.setImage("attachment://sahko.png");
    }
  }

  await channel.send({ embeds:[embed], files: attachment ? [attachment] : [] });
  merkitseLahetetyksi(guildId, "aamutervehdys");
}

async function ajaUutiskooste(guildId, force = false) {
  if (!force && !isFeatureEnabled(guildId, "cron.uutiskooste")) return;
  const { NEWS_CHANNEL_ID } = loadGuildConfig(guildId).channels;
  if (!NEWS_CHANNEL_ID) return;

  const [luetuimmat, uusimmat] = await Promise.all([
    haeAmpparitUutiset("https://www.ampparit.com/luetuimmat", 5),
    haeAmpparitUutiset("https://www.ampparit.com/uusimmat", 5)
  ]);

  const uutisKanava = await client.channels.fetch(NEWS_CHANNEL_ID);
  const embeds = [];

  if (luetuimmat?.length) {
    embeds.push(new EmbedBuilder()
      .setTitle("🔥 Ampparit — Luetuimmat")
      .setURL("https://www.ampparit.com/luetuimmat")
      .setColor(0xd63031)
      .setDescription(luetuimmat.map((u, i) => `**${i+1}.** [${u.otsikko}](${u.linkki})`).join("\n\n"))
      .setFooter({ text:"Lähde: Ampparit.com" })
      .setTimestamp()
    );
  }

  if (uusimmat?.length) {
    embeds.push(new EmbedBuilder()
      .setTitle("🆕 Ampparit — Uusimmat")
      .setURL("https://www.ampparit.com/uusimmat")
      .setColor(0x0984e3)
      .setDescription(uusimmat.map((u, i) => `**${i+1}.** [${u.otsikko}](${u.linkki})`).join("\n\n"))
      .setFooter({ text:"Lähde: Ampparit.com" })
      .setTimestamp()
    );
  }

  if (embeds.length) await uutisKanava.send({ embeds });
  merkitseLahetetyksi(guildId, "uutiskooste");
}

async function ajaPp2Ilmoitus(guildId, force = false) {
  if (!force && !isFeatureEnabled(guildId, "cron.pp2")) return;
  const { PP2_CHANNEL_ID } = loadGuildConfig(guildId).channels;
  if (!PP2_CHANNEL_ID) return;

  const palvelin = await haePP2Palvelin();
  if (!palvelin) return;

  const kanava = await client.channels.fetch(PP2_CHANNEL_ID);
  await kanava.send(rakennaPp2Viesti(palvelin));
  merkitseLahetetyksi(guildId, "pp2");
}

// Lotto- ja Eurojackpot-tulosten automaattinen postaus. Tulosten tarkka ilmestymishetki
// lähdesivuilla vaihtelee, joten arvontailtoina sivut tarkistetaan 10 min välein (ks.
// ajastukset clientReadyssä) ja tulos postataan heti kun arvonnan tunniste (päivä) vaihtuu.
// Molemmat pelit postataan samalle LOTTO_CHANNEL_ID-kanavalle.
const ARVONTAPELIT = {
  lotto: { hae: haeLotto, rakennaEmbed: rakennaLottoEmbed },
  eurojaska: { hae: haeEurojaska, rakennaEmbed: tulos => rakennaEurojaskaEmbed(tulos, false) }
};

function kirjaaArvonta(guildId, peli, paiva, lahetetty) {
  try {
    const guildCfg = loadGuildConfig(guildId);
    saveGuildConfig(guildId, {
      ...guildCfg,
      arvonnat: { ...guildCfg.arvonnat, [peli]: paiva },
      lastSent: lahetetty ? { ...guildCfg.lastSent, [peli]: Date.now() } : guildCfg.lastSent
    });
  } catch (err) {
    console.error(`Arvonnan kirjaus epäonnistui (${guildId}/${peli}):`, err.message);
  }
}

async function postaaArvonta(guildId, peli, tulos) {
  const guildCfg = loadGuildConfig(guildId);
  const edellinen = guildCfg.arvonnat[peli];
  if (edellinen === tulos.paiva) return;

  const { LOTTO_CHANNEL_ID } = guildCfg.channels;
  // Ensimmäinen havainto, kytkin pois tai kanava puuttuu: kirjataan arvonta käsitellyksi
  // postaamatta, jotta myöhemmin päälle kytkettäessä ei postata jo vanhentunutta tulosta.
  if (!edellinen || !isFeatureEnabled(guildId, `cron.${peli}`) || !LOTTO_CHANNEL_ID) {
    kirjaaArvonta(guildId, peli, tulos.paiva, false);
    return;
  }

  const kanava = await client.channels.fetch(LOTTO_CHANNEL_ID);
  await kanava.send({ embeds: [ARVONTAPELIT[peli].rakennaEmbed(tulos)] });
  kirjaaArvonta(guildId, peli, tulos.paiva, true);
}

async function tarkistaArvonnat(pelit) {
  const guildIdt = Object.keys(loadConfig().guilds).filter(id => id !== "__legacy__");
  for (const peli of pelit) {
    // Haku hoitaa oman virhelokituksensa; epäonnistuessa yritetään seuraavalla kierroksella.
    const tulos = await ARVONTAPELIT[peli].hae(true);
    if (!tulos?.paiva) continue;
    for (const guildId of guildIdt) {
      await postaaArvonta(guildId, peli, tulos)
        .catch(err => console.error(`Arvontapostaus (${peli}, ${guildId}) epäonnistui:`, err.message));
    }
  }
}

// Trackmania-uutisten automaattinen postaus TM_NEWS_CHANNEL_ID-kanavalle. trackmania.com
// tarkistetaan 15 min välein; guildCfg.tmNahdyt muistaa jo käsitellyt artikkeli-ID:t.
// cron.tmUutiset = kaikki uutiset (sisältää myös päivitykset), cron.tmPaivitykset = vain
// Update-kategoria — molemmat päällä ei tuplaa, koska kukin artikkeli postataan kerran.
const TM_NAHDYT_MAX = 100;
const TM_POSTAUS_MAX = 3;

function kirjaaTmNahdyt(guildId, idt, lahetetyt = []) {
  try {
    const guildCfg = loadGuildConfig(guildId);
    const lastSent = { ...guildCfg.lastSent };
    for (const avain of lahetetyt) lastSent[avain] = Date.now();
    saveGuildConfig(guildId, {
      ...guildCfg,
      tmNahdyt: [...new Set([...idt, ...guildCfg.tmNahdyt])].slice(0, TM_NAHDYT_MAX),
      lastSent
    });
  } catch (err) {
    console.error(`TM-uutisten kirjaus epäonnistui (${guildId}):`, err.message);
  }
}

function yhdistaTmUutiset(data) {
  const kaikki = new Map();
  for (const u of [...data.uutiset, ...data.paivitykset]) if (!kaikki.has(u.id)) kaikki.set(u.id, u);
  return [...kaikki.values()];
}

async function postaaTmUutiset(guildId, data) {
  const guildCfg = loadGuildConfig(guildId);
  const kaikki = yhdistaTmUutiset(data);
  const nahdyt = new Set(guildCfg.tmNahdyt);
  const uudet = kaikki.filter(u => !nahdyt.has(u.id));
  if (!uudet.length) return;

  const kanavaId = guildCfg.channels.TM_NEWS_CHANNEL_ID;
  const kaikkiPaalla = isFeatureEnabled(guildId, "cron.tmUutiset");
  const paivityksetPaalla = isFeatureEnabled(guildId, "cron.tmPaivitykset");
  // Ensimmäinen havainto (tyhjä muisti) vain kirjataan, ettei deployn jälkeen postata vanhoja.
  const postattavat = !nahdyt.size || !kanavaId ? [] :
    uudet.filter(u => kaikkiPaalla || (u.paivitys && paivityksetPaalla)).slice(0, TM_POSTAUS_MAX).reverse();

  // Kirjataan ennen lähetystä: epäonnistunut lähetys ei toistu joka kierroksella eikä tuplaannu.
  kirjaaTmNahdyt(guildId, kaikki.map(u => u.id), [...new Set(postattavat.map(u => u.paivitys ? "tmPaivitykset" : "tmUutiset"))]);
  if (!postattavat.length) return;

  const kanava = await client.channels.fetch(kanavaId);
  for (const u of postattavat) await kanava.send({ embeds: [await rakennaTmUutisEmbed(u)] });
}

async function tarkistaTmUutiset() {
  const data = await haeTmUutiset(true);
  if (!data) return;
  const guildIdt = Object.keys(loadConfig().guilds).filter(id => id !== "__legacy__");
  for (const guildId of guildIdt) {
    await postaaTmUutiset(guildId, data)
      .catch(err => console.error(`TM-uutispostaus (${guildId}) epäonnistui:`, err.message));
  }
}

// Täysin mukautetut, palvelinkohtaiset ilmoitukset omiin kanaviinsa — voi olla useita per
// palvelin (ks. guildCfg.mukautetut). Toisin kuin aamutervehdyksen "mukautettu"-tilassa
// (jossa oletussisältö on vaihtoehto), näillä ei ole kiinteää oletussisältöä lainkaan —
// jos tekstiä tai kanavaa ei ole asetettu, ei lähetetä mitään. Toistotapa (kolme toisensa
// poissulkevaa vaihtoehtoa): item.date asetettu → lähetetään VAIN kyseisenä päivänä
// (kertaluontoinen); muuten item.days ei-tyhjä → toistuu vain niinä viikonpäivinä; muuten
// toistuu joka päivä.
async function ajaMukautettuIlmoitus(guildId, itemId, force = false) {
  if (!force && !isFeatureEnabled(guildId, "cron.mukautettu")) return;
  const guildCfg = loadGuildConfig(guildId);
  const item = (guildCfg.mukautetut || []).find(m => m.id === itemId);
  if (!item) return;

  const mukautettuTeksti = item.teksti.trim();
  if (!item.channelId || !mukautettuTeksti) return;
  if (!force && item.date) {
    if (item.date !== tamanPaivanPaivamaaraHelsinki()) return;
  } else if (!force && item.days && item.days.length) {
    if (!item.days.includes(tamanPaivanViikonpaivaHelsinki())) return;
  }

  const channel = await client.channels.fetch(item.channelId);
  const nimipaivatTeksti = muotoileNimet(haeNimipaivat());
  const liputus = haeLiputuspaiva() || "";
  const synttaritTeksti = muotoileSynttarit(haeSynttarit(guildId));

  const sahko = await haePorssisahkoData(true);
  const sahkoTeksti = sahko
    ? `🔻 ${sahko.halvin.price} c/kWh klo ${sahko.halvin.time}\n⚖️ ${sahko.keski} c/kWh\n🔺 ${sahko.kallein.price} c/kWh klo ${sahko.kallein.time}`
    : "";

  const embed = new EmbedBuilder();
  let attachment = null;
  if (sahko && mukautettuTeksti.includes("{sähkö}")) {
    const graafi = piirraGraafi(sahko.kaikki);
    attachment = new AttachmentBuilder(graafi, { name:"sahko.png" });
    embed.setImage("attachment://sahko.png");
  }
  const teksti = mukautettuTeksti
    .replaceAll("{nimipäivät}", nimipaivatTeksti || "-")
    .replaceAll("{syntymäpäivät}", synttaritTeksti || "-")
    .replaceAll("{liputuspäivä}", liputus || "-")
    .replaceAll("{sähkö}", sahkoTeksti || "-");
  embed.setDescription(teksti.slice(0, 4096));

  await channel.send({ embeds:[embed], files: attachment ? [attachment] : [] });
  merkitseLahetetyksi(guildId, "mukautettu", itemId);
}

// Yksi cron-tehtäväsetti (aamutervehdys/uutiskooste/pp2/mukautettu) jokaiselle palvelimelle
// erikseen, koska kukin palvelin voi valita omat kellonaikansa. Avain "<guildId>:<tyyppi>".
let cronTasks = new Map();

// node-cron kirjoittaa virheen omaan lokitukseensa jo itse, mutta ilman guild/tyyppi-kontekstia.
// Tämä kääre lisää sen, jotta ajastetun lähetyksen kaatuminen erottuu lokista selvästi.
function ajaJaLokitaVirhe(nimi, guildId, promiseFn) {
  promiseFn().catch(err => console.error(`Ajastettu lähetys (${nimi}, ${guildId}) epäonnistui:`, err.message));
}

function paivitaCronAikataulu() {
  for (const task of cronTasks.values()) task.stop();
  cronTasks.clear();

  const cfg = loadConfig();
  const guildIt = Object.entries(cfg.guilds).filter(([id]) => id !== "__legacy__");

  for (const [guildId, guildCfg] of guildIt) {
    // Käärittynä nuolifunktioon: node-cron kutsuu taskia execution-kontekstiolion kanssa,
    // joka muuten menisi vahingossa "force"-parametriksi ja ohittaisi ominaisuuskytkimen aina.
    cronTasks.set(`${guildId}:aamutervehdys`,
      cron.schedule(guildCfg.cron.aamutervehdys, () => ajaJaLokitaVirhe("aamutervehdys", guildId, () => ajaAamutervehdys(guildId)), { timezone:"Europe/Helsinki" }));
    cronTasks.set(`${guildId}:uutiskooste`,
      cron.schedule(guildCfg.cron.uutiskooste, () => ajaJaLokitaVirhe("uutiskooste", guildId, () => ajaUutiskooste(guildId)), { timezone:"Europe/Helsinki" }));
    cronTasks.set(`${guildId}:pp2`,
      cron.schedule(guildCfg.cron.pp2, () => ajaJaLokitaVirhe("pp2", guildId, () => ajaPp2Ilmoitus(guildId)), { timezone:"Europe/Helsinki" }));

    for (const item of guildCfg.mukautetut || []) {
      cronTasks.set(`${guildId}:mukautettu:${item.id}`,
        cron.schedule(mukautettuCronExpr(item), () => ajaJaLokitaVirhe(`mukautettu/${item.id}`, guildId, () => ajaMukautettuIlmoitus(guildId, item.id)), { timezone:"Europe/Helsinki" }));
    }
  }

  console.log(`Cron-aikataulu asetettu ${guildIt.length} palvelimelle.`);
}

// Varmistaa ettei aamun ajastettu lähetys jää lähtemättä huomaamatta, jos node-cronin oma
// ajastin (setTimeout-pohjainen) ei jostain syystä laukea täsmälleen — esim. juuri käynnistyksen
// jälkeen kellon ollessa vielä epävakaa. Tarkistetaan säännöllisin väliajoin: jos kellonaika on jo
// ohittanut palvelimen asetetun ajan tänään eikä lähetystä ole vielä tänään tehty, lähetetään se nyt.
const YKSINKERTAISET_CRONIT = { aamutervehdys: ajaAamutervehdys, uutiskooste: ajaUutiskooste, pp2: ajaPp2Ilmoitus };

function tarkistaOhitetutCronit() {
  const nyt = new Date();
  const helsinginOsat = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Helsinki", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(nyt).map(o => [o.type, o.value])
  );
  const tunti = Number(helsinginOsat.hour) % 24;
  const minuutti = Number(helsinginOsat.minute);
  const tanaan = tamanPaivanPaivamaaraHelsinki();

  const cfg = loadConfig();
  for (const [guildId, guildCfg] of Object.entries(cfg.guilds)) {
    if (guildId === "__legacy__") continue;

    for (const [avain, aja] of Object.entries(YKSINKERTAISET_CRONIT)) {
      if (!isFeatureEnabled(guildId, `cron.${avain}`)) continue;

      const cronMatch = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec((guildCfg.cron[avain] || "").trim());
      if (!cronMatch) continue; // ei-triviaali aikataulu (esim. viikonpäivärajaus) — ei jälkikäteen ajoa
      const [, cronMin, cronHour] = cronMatch;
      const ohiAikataulun = tunti > Number(cronHour) || (tunti === Number(cronHour) && minuutti >= Number(cronMin));
      if (!ohiAikataulun) continue;

      const lastSentPaivamaara = guildCfg.lastSent?.[avain]
        ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Helsinki" }).format(guildCfg.lastSent[avain])
        : null;
      if (lastSentPaivamaara === tanaan) continue; // jo lähetetty tänään

      console.log(`Ohitettu cron havaittu, lähetetään jälkikäteen: ${avain} (palvelin ${guildId}, tänään ${tanaan})`);
      ajaJaLokitaVirhe(`${avain}-jalkikateen`, guildId, () => aja(guildId, true));
    }
  }
}

let presenceKiertoTimer = null;
let presenceIndex = -1;

// Arpoo seuraavan tilan siten ettei sama toistu kahdesti peräkkäin (jos vaihtoehtoja on useampi).
function valitseSeuraavaPresenceIndex(maara) {
  if (maara <= 1) return 0;
  let uusi;
  do {
    uusi = Math.floor(Math.random() * maara);
  } while (uusi === presenceIndex);
  return uusi;
}

// Aina intervallin välein asetetaan (uudelleen) satunnainen tila — myös silloin kun lista
// sisältää vain yhden tilan. Tämä toimii itsekorjaavana: jos yksittäinen setPresence()-kutsu
// tippuisi Discordin verkossa, seuraava kierros palauttaa tilan ilman että se jää jumiin.
function paivitaPresenceKierto() {
  const { presences, presenceIntervalMinutes } = loadConfig().settings;

  if (presenceKiertoTimer) clearInterval(presenceKiertoTimer);
  if (!presences.length) return;

  presenceIndex = valitseSeuraavaPresenceIndex(presences.length);
  client.user.setPresence({ activities: [rakennaAktiviteetti(presences[presenceIndex])], status: "online" });

  presenceKiertoTimer = setInterval(() => {
    presenceIndex = valitseSeuraavaPresenceIndex(presences.length);
    client.user.setPresence({ activities: [rakennaAktiviteetti(presences[presenceIndex])], status: "online" });
  }, Math.max(1, presenceIntervalMinutes) * 60 * 1000);
}

// Hyvin vanha config.json (ennen useiden palvelinten tukea) tallennetaan tilapäisesti
// "__legacy__"-avaimen alle (ks. config.js). Selvitetään oikea guild-ID käynnistyksessä
// CHANNEL_ID:n kautta ja siirretään sekä asetukset että vanha jaettu syntymapaivat.json
// oikean palvelimen alle. Ajetaan vain jos tarvitaan.
async function ratkaiseLegacyGuild() {
  const cfg = loadConfig();
  const legacy = cfg.guilds.__legacy__;
  if (!legacy) return;

  let guildId = null;
  try {
    if (legacy.channels.CHANNEL_ID) {
      const channel = await client.channels.fetch(legacy.channels.CHANNEL_ID);
      guildId = channel?.guild?.id || null;
    }
  } catch (err) {
    console.error("Legacy-guildin tunnistus epäonnistui:", err.message);
  }

  if (!guildId) {
    console.error("Ei pystytty ratkaisemaan vanhan configin oikeaa guild-ID:tä (CHANNEL_ID ei löytynyt). Konfiguraatio jää __legacy__-avaimen alle kunnes tämä korjaantuu.");
    return;
  }

  const guild = client.guilds.cache.get(guildId);
  legacy.name = guild?.name || legacy.name;
  cfg.guilds[guildId] = legacy;
  delete cfg.guilds.__legacy__;
  saveConfig(cfg);
  console.log(`Vanha konfiguraatio siirretty palvelimelle ${guildId} (${legacy.name}).`);

  const vanhaPolku = path.join(__dirname, "syntymapaivat.json");
  const uusiPolku = guildDataPolku(guildId, "syntymapaivat.json");
  if (fs.existsSync(vanhaPolku) && !fs.existsSync(uusiPolku)) {
    fs.mkdirSync(path.dirname(uusiPolku), { recursive: true });
    fs.copyFileSync(vanhaPolku, uusiPolku);
    console.log(`syntymapaivat.json kopioitu palvelimen ${guildId} datakansioon.`);
  }
}

client.once("clientReady", async () => {
  console.log(`Kirjautunut: ${client.user.tag}`);

  await ratkaiseLegacyGuild();

  // Varmistetaan että jokainen palvelin jolla botti jo on, löytyy config.guilds:sta
  // (esim. jos botti lisättiin uudelle palvelimelle sen ollessa offline).
  client.guilds.cache.forEach(g => ensureGuildExists(g.id, g.name));

  client.on("guildCreate", guild => {
    console.log(`Botti liittyi uudelle palvelimelle: ${guild.name} (${guild.id})`);
    ensureGuildExists(guild.id, guild.name);
    paivitaCronAikataulu();
  });

  paivitaPresenceKierto();
  paivitaCronAikataulu();
  cron.schedule("5 * * * *", tarkistaKotiLampoHalytys, { timezone: "Europe/Helsinki" });
  // Arvontaillat: Lotto la, Eurojackpot ti+pe. Seuraavan aamun harvempi tarkistus kattaa
  // tapaukset, joissa lähdesivu päivittyy vasta yöllä.
  cron.schedule("*/10 21-23 * * 6", () => tarkistaArvonnat(["lotto"]), { timezone: "Europe/Helsinki" });
  cron.schedule("*/30 0-11 * * 0", () => tarkistaArvonnat(["lotto"]), { timezone: "Europe/Helsinki" });
  cron.schedule("*/10 21-23 * * 2,5", () => tarkistaArvonnat(["eurojaska"]), { timezone: "Europe/Helsinki" });
  cron.schedule("*/30 0-11 * * 3,6", () => tarkistaArvonnat(["eurojaska"]), { timezone: "Europe/Helsinki" });
  // Käynnistyksessä: kirjaa nykyiset arvonnat uusille palvelimille ja postaa käynnistyksen
  // aikana mahdollisesti ohi menneet tulokset.
  tarkistaArvonnat(["lotto", "eurojaska"]);
  cron.schedule("*/15 * * * *", tarkistaTmUutiset, { timezone: "Europe/Helsinki" });
  tarkistaTmUutiset();
  // Laskurien muistutukset; 30 s väli riittää minuutin tarkkuuteen.
  try { migroiVanhaWowTila(); } catch (err) { console.error("wow-muistutukset.json:n siirto epäonnistui:", err.message); }
  const ajaLaskuriMuistutukset = Laskurit.yksiKerrallaan(() =>
    tarkistaLaskuriMuistutukset().catch(err => console.error("Laskurimuistutusten tarkistus epäonnistui:", err.message)));
  ajaLaskuriMuistutukset();
  setInterval(ajaLaskuriMuistutukset, 30 * 1000);
  tarkistaOhitetutCronit();
  setInterval(tarkistaOhitetutCronit, 10 * 60 * 1000);

  // config.json:iin käsin tehdyt muutokset otetaan käyttöön ilman uudelleenkäynnistystä.
  const { CONFIG_PATH } = require("./config.js");
  let edellinenGuildCronJson = JSON.stringify(
    Object.fromEntries(Object.entries(loadConfig().guilds).map(([id, g]) => [id, { cron: g.cron, mukautetut: g.mukautetut }]))
  );
  let edellinenPresenceJson = JSON.stringify(loadConfig().settings.presences) + loadConfig().settings.presenceIntervalMinutes;

  fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
    const nykyinen = loadConfig();

    const nykyinenGuildCronJson = JSON.stringify(
      Object.fromEntries(Object.entries(nykyinen.guilds).map(([id, g]) => [id, { cron: g.cron, mukautetut: g.mukautetut }]))
    );
    if (nykyinenGuildCronJson !== edellinenGuildCronJson) {
      edellinenGuildCronJson = nykyinenGuildCronJson;
      paivitaCronAikataulu();
    }

    const nykyinenPresenceJson = JSON.stringify(nykyinen.settings.presences) + nykyinen.settings.presenceIntervalMinutes;
    if (nykyinenPresenceJson !== edellinenPresenceJson) {
      edellinenPresenceJson = nykyinenPresenceJson;
      paivitaPresenceKierto();
    }
  });
});

client.login(TOKEN);
