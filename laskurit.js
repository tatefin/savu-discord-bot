// Laskurit: WoW Forever-, joulu-, juhannus- ja mukautettujen laskurien muistutukset.
// Kaikki logiikka on täällä puhtaina funktioina, jotta config.js ja botti käyttävät
// samoja sääntöjä ja niitä voi testata ilman Discordia (ks. tests/laskurit.test.js).
const crypto = require("crypto");

// Julkaisu 5.11.2026 klo 00.00 CET (= klo 01.00 Suomen aikaa).
const WOW_JULKAISU = Date.UTC(2026, 10, 4, 23, 0, 0);

// Muistutusten ajat minuutteina ennen kohdehetkeä, aina viisi kappaletta; 0 = paikka ei käytössä.
const LASKURI_OLETUSAJAT = {
  wow: [1440, 720, 180, 60, 5],
  joulu: [43200, 20160, 10080, 4320, 1440],
  juhannus: [43200, 20160, 10080, 4320, 1440],
  mukautettu: [10080, 1440, 180, 60, 10]
};
const MUISTUTUKSET_MAARA = 5;
const MUISTUTUS_MAX_MIN = 365 * 1440;
const MUKAUTETUT_MAX = 20;
// Yli tämän verran myöhässä oleva muistutus (botti oli alhaalla) vain kuitataan, koska sen
// teksti ("24 tuntia") ei enää pitäisi paikkaansa.
const MYOHASSA_MAX_MS = 10 * 60000;
const KIINTEAT = ["wow", "joulu", "juhannus"];

function normalisoiAjat(raw, oletus) {
  if (!Array.isArray(raw) || raw.length !== MUISTUTUKSET_MAARA) return [...oletus];
  const arvot = raw.map(Number);
  if (!arvot.every(n => Number.isInteger(n) && n >= 0 && n <= MUISTUTUS_MAX_MIN)) return [...oletus];
  return arvot;
}

// Katkaisee merkkijonon enintään max UTF-16-yksikköön rikkomatta emojia kahtia.
function katkaise(s, max) {
  let tulos = "";
  for (const merkki of s) {
    if (tulos.length + merkki.length > max) break;
    tulos += merkki;
  }
  return tulos;
}

// Vain Discordin numeerinen kanava-ID kelpaa.
function normalisoiKanava(raw) {
  const id = typeof raw === "string" ? raw.trim() : "";
  return /^\d{17,20}$/.test(id) ? id : "";
}

function normalisoiKiintea(raw, oletus) {
  return {
    channelId: normalisoiKanava(raw?.channelId),
    muistutukset: normalisoiAjat(raw?.muistutukset, oletus)
  };
}

function normalisoiMukautettu(raw, kaytetytIdt) {
  const nimi = typeof raw.nimi === "string" ? katkaise(raw.nimi.trim(), 60) : "";
  const emoji = typeof raw.emoji === "string" ? katkaise(raw.emoji.trim(), 8) : "";
  return {
    id: uniikkiId(raw.id, kaytetytIdt),
    nimi: nimi || "Mukautettu laskuri",
    emoji: emoji || "🎉",
    paiva: typeof raw.paiva === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.paiva) ? raw.paiva : "",
    aika: typeof raw.aika === "string" && /^\d{2}:\d{2}$/.test(raw.aika) ? raw.aika : "18:00",
    channelId: normalisoiKanava(raw.channelId),
    muistutukset: normalisoiAjat(raw.muistutukset, LASKURI_OLETUSAJAT.mukautettu),
    teksti: typeof raw.teksti === "string" ? raw.teksti.slice(0, 2000) : "",
    paalla: Boolean(raw.paalla)
  };
}

// Mukautetun laskurin ID on tilatiedoston avain: sen pitää olla uniikki (muuten kaksi laskuria
// nollaisivat toistensa kuittaukset joka kierros) ja lyhyt hex-merkkijono.
function uniikkiId(raw, kaytetytIdt) {
  let id = typeof raw === "string" && /^[a-f0-9]{1,32}$/.test(raw) ? raw : "";
  while (!id || kaytetytIdt.has(id)) id = crypto.randomBytes(6).toString("hex");
  kaytetytIdt.add(id);
  return id;
}

// rawGuild = palvelimen raaka-asetukset. Migraatio: 1.11.2026 versio tallensi WoW-asetukset
// kenttiin wowMuistutukset ja channels.WOW_CHANNEL_ID; ne siirtyvät laskurit.wow:iin, jos sitä ei vielä ole.
function normalisoiLaskurit(rawGuild) {
  const raw = rawGuild?.laskurit && typeof rawGuild.laskurit === "object" ? rawGuild.laskurit : {};
  const idJoukko = new Set();
  const wowRaw = raw.wow || {
    channelId: rawGuild?.channels?.WOW_CHANNEL_ID,
    muistutukset: rawGuild?.wowMuistutukset
  };
  return {
    wow: normalisoiKiintea(wowRaw, LASKURI_OLETUSAJAT.wow),
    joulu: normalisoiKiintea(raw.joulu, LASKURI_OLETUSAJAT.joulu),
    juhannus: normalisoiKiintea(raw.juhannus, LASKURI_OLETUSAJAT.juhannus),
    mukautetut: (Array.isArray(raw.mukautetut) ? raw.mukautetut : [])
      .filter(m => m && typeof m === "object")
      .slice(0, MUKAUTETUT_MAX)
      .map(m => normalisoiMukautettu(m, idJoukko))
  };
}

// Helsingin paikallinen hetki → UTC-millisekunnit. Arvataan ensin talviaika (UTC+2) ja korjataan
// sen mukaan, mitä Helsingin kello arvatulla hetkellä oikeasti näyttää (kesäajassa UTC+3).
function helsinkiHetkiUtc(paiva, aika) {
  const [v, kk, pv] = paiva.split("-").map(Number);
  const [h, mi] = aika.split(":").map(Number);
  const tavoite = Date.UTC(v, kk - 1, pv, h, mi);
  let arvaus = tavoite - 2 * 3600000;
  for (let i = 0; i < 2; i++) {
    const osat = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Helsinki", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).formatToParts(arvaus).map(o => [o.type, o.value]));
    const nakyva = Date.UTC(+osat.year, +osat.month - 1, +osat.day, +osat.hour, +osat.minute);
    arvaus += tavoite - nakyva;
  }
  return arvaus;
}

function pvm(v, kk, pv) {
  return `${v}-${String(kk).padStart(2, "0")}-${String(pv).padStart(2, "0")}`;
}

// Juhannusaatto on 19.–25.6. välinen perjantai.
function juhannusaatonPaiva(vuosi) {
  const d = new Date(Date.UTC(vuosi, 5, 19));
  return 19 + ((5 - d.getUTCDay() + 7) % 7);
}

function helsinginVuosi(nyt) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Helsinki", year: "numeric" }).format(nyt));
}

// Laskurin kohdehetki UTC-millisekunteina. Joulu ja juhannus: seuraava aatto, jonka alku
// (klo 00.00 Suomen aikaa) on vielä tulossa. Mukautettu ilman päivää → null.
function kohdehetki(avain, laskuri, nyt) {
  if (avain === "wow") return WOW_JULKAISU;
  if (avain === "joulu" || avain === "juhannus") {
    const vuosi = helsinginVuosi(nyt);
    for (const v of [vuosi, vuosi + 1]) {
      const hetki = avain === "joulu"
        ? helsinkiHetkiUtc(pvm(v, 12, 24), "00:00")
        : helsinkiHetkiUtc(pvm(v, 6, juhannusaatonPaiva(v)), "00:00");
      if (hetki > nyt) return hetki;
    }
    return null;
  }
  if (!laskuri?.paiva) return null;
  return helsinkiHetkiUtc(laskuri.paiva, laskuri.aika || "00:00");
}

function laskuriLista(laskurit) {
  return [
    ...KIINTEAT.map(avain => ({ avain, tyyppi: avain, laskuri: laskurit[avain] })),
    ...laskurit.mukautetut.map(m => ({ avain: `muk:${m.id}`, tyyppi: "mukautettu", laskuri: m }))
  ];
}

// Aika suomeksi, esim. 1440 → "24 tuntia", 90 → "1 tunti ja 30 minuuttia". Tasan yksi
// vuorokausi näytetään tunteina ("24 tuntia" luontevampi kuin "1 päivä").
function muotoileMuistutusaika(minuutit) {
  const pv = Math.floor(minuutit / 1440), h = Math.floor((minuutit % 1440) / 60), m = minuutit % 60;
  const tasanVrk = pv === 1 && !h && !m;
  const osat = [];
  if (pv && !tasanVrk) osat.push(pv === 1 ? "1 päivä" : `${pv} päivää`);
  const tunnit = tasanVrk ? 24 : h;
  if (tunnit) osat.push(tunnit === 1 ? "1 tunti" : `${tunnit} tuntia`);
  if (m) osat.push(m === 1 ? "1 minuutti" : `${m} minuuttia`);
  return osat.length > 1 ? `${osat.slice(0, -1).join(", ")} ja ${osat[osat.length - 1]}` : osat[0];
}

// merkinta = { kohde, kasitellyt } tilatiedostosta. Jos kohde on vaihtunut (uusi vuosi tai
// mukautetun laskurin päivä muuttui), vanhat kuittaukset eivät enää koske tätä kohdetta.
function voimassaOlevat(merkinta, kohde) {
  return new Set(merkinta?.kohde === kohde ? merkinta.kasitellyt : []);
}

function erantyneet(merkinta, kohde, ajat, nyt) {
  if (nyt >= kohde) return { laheta: null, kuitattavat: [] };
  const kasitellyt = voimassaOlevat(merkinta, kohde);
  const kuitattavat = [...new Set(ajat)].filter(min => min > 0).sort((a, b) => b - a)
    .filter(min => nyt >= kohde - min * 60000 && !kasitellyt.has(min));
  if (!kuitattavat.length) return { laheta: null, kuitattavat };
  // Suurimmasta pienimpään, joten viimeinen on tuorein.
  const tuorein = kuitattavat[kuitattavat.length - 1];
  const myohassa = nyt - (kohde - tuorein * 60000);
  return { laheta: myohassa <= MYOHASSA_MAX_MS ? tuorein : null, kuitattavat };
}

function kuittaa(merkinta, kohde, minuutit) {
  return { kohde, kasitellyt: [...new Set([...voimassaOlevat(merkinta, kohde), ...minuutit])] };
}

// Vanha wow-muistutukset.json: { guildId: [minuutit…] } → uuden tilan muoto.
function migroiWowTila(vanha) {
  const tulos = {};
  for (const [guildId, minuutit] of Object.entries(vanha || {})) {
    if (Array.isArray(minuutit)) tulos[guildId] = { wow: { kohde: WOW_JULKAISU, kasitellyt: minuutit } };
  }
  return tulos;
}

// Discordin <t:…>-aikaleima näkyy lukijan Discord-sovelluksen kielellä (usein englanniksi), joten
// ajankohta kirjoitetaan viesteihin valmiiksi suomeksi Suomen ajassa, esim. "torstaina 5.11.2026 klo 1.00".
const VIIKONPAIVAT_ESSIIVI = ["sunnuntaina", "maanantaina", "tiistaina", "keskiviikkona", "torstaina", "perjantaina", "lauantaina"];

function muotoileAjankohta(ms, { kello = true } = {}) {
  const osat = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Helsinki", hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
  }).formatToParts(ms).map(o => [o.type, o.value]));
  const viikonpaiva = new Date(Date.UTC(+osat.year, +osat.month - 1, +osat.day)).getUTCDay();
  const paiva = `${VIIKONPAIVAT_ESSIIVI[viikonpaiva]} ${+osat.day}.${+osat.month}.${osat.year}`;
  return kello ? `${paiva} klo ${+osat.hour}.${osat.minute}` : paiva;
}

const MUKAUTETTU_OLETUSTEKSTI = "{emoji} **{nimi}** alkaa **{aika}** päästä! {ajankohta}";

function rakennaLaskuriViesti(tyyppi, laskuri, kohde, minuutit) {
  const aika = muotoileMuistutusaika(minuutit);
  if (tyyppi === "wow") return `⚔️ **WoW Forever** -julkaisuun on enää **${aika}**! Julkaisu ${muotoileAjankohta(kohde)} (Suomen aikaa).`;
  if (tyyppi === "joulu") return `🎄 Jouluaattoon on enää **${aika}**! Jouluaatto on ${muotoileAjankohta(kohde, { kello: false })}.`;
  if (tyyppi === "juhannus") return `🌿 Juhannusaattoon on enää **${aika}**! Juhannusaatto on ${muotoileAjankohta(kohde, { kello: false })}.`;
  const korvaukset = { nimi: laskuri.nimi, emoji: laskuri.emoji, aika, ajankohta: muotoileAjankohta(kohde) };
  return (laskuri.teksti?.trim() ? laskuri.teksti : MUKAUTETTU_OLETUSTEKSTI)
    .replace(/\{(nimi|emoji|aika|ajankohta)\}/g, (_, k) => korvaukset[k]);
}

// Yksi muistutuskierros kaikille palvelimille. tila = { guildId: { laskuriAvain: { kohde, kasitellyt } } };
// palauttaa päivitetyn tilan. Epäonnistunutta lähetystä ei kuitata, jotta se yritetään uudelleen
// (MYOHASSA_MAX_MS:n jälkeen se kuitataan lähettämättä).
async function ajaLaskuriMuistutukset({ guildIdt, haeGuildConfig, onFeature, laheta, tila, nyt, loki }) {
  const uusiTila = { ...tila };
  let muuttui = false;
  for (const guildId of guildIdt) {
    const guildCfg = haeGuildConfig(guildId);
    for (const { avain, tyyppi, laskuri } of laskuriLista(guildCfg.laskurit)) {
      const paalla = tyyppi === "mukautettu" ? laskuri.paalla : onFeature(guildId, `cron.${tyyppi}`);
      if (!paalla || !laskuri.channelId) continue;
      const kohde = kohdehetki(avain, laskuri, nyt);
      if (kohde === null) continue;

      const merkinta = uusiTila[guildId]?.[avain];
      const { laheta: minuutit, kuitattavat } = erantyneet(merkinta, kohde, laskuri.muistutukset, nyt);
      if (!kuitattavat.length) continue;
      if (minuutit !== null) {
        try {
          await laheta(guildId, laskuri.channelId, rakennaLaskuriViesti(tyyppi, laskuri, kohde, minuutit));
        } catch (err) {
          loki(`Laskurimuistutus (${avain}, ${minuutit} min, palvelin ${guildId}) epäonnistui: ${err.message}`);
          continue;
        }
      }
      uusiTila[guildId] = { ...uusiTila[guildId], [avain]: kuittaa(merkinta, kohde, kuitattavat) };
      muuttui = true;
    }
  }
  return { tila: uusiTila, muuttui };
}

// Lähettää vain saman palvelimen kanavalle: kanava-ID tulee palvelimen ylläpitäjältä, eikä sillä
// saa päästä postaamaan toisen palvelimen kanaville.
async function lahetaOmalleKanavalle({ haeKanava, guildId, kanavaId, teksti }) {
  const kanava = await haeKanava(kanavaId);
  if (!kanava || kanava.guildId !== guildId) throw new Error("Kanava ei kuulu tälle palvelimelle.");
  await kanava.send(teksti);
}

// Ajastettu kierros ei saa käynnistyä edellisen ollessa kesken (hidas Discord-API): molemmat
// lukisivat saman tilan ja lähettäisivät saman muistutuksen.
function yksiKerrallaan(fn) {
  let kesken = false;
  return async () => {
    if (kesken) return;
    kesken = true;
    try { return await fn(); } finally { kesken = false; }
  };
}

module.exports = {
  WOW_JULKAISU,
  LASKURI_OLETUSAJAT,
  MUISTUTUS_MAX_MIN,
  MUKAUTETUT_MAX,
  MYOHASSA_MAX_MS,
  normalisoiAjat,
  normalisoiLaskurit,
  helsinkiHetkiUtc,
  kohdehetki,
  laskuriLista,
  muotoileMuistutusaika,
  muotoileAjankohta,
  erantyneet,
  kuittaa,
  migroiWowTila,
  rakennaLaskuriViesti,
  ajaLaskuriMuistutukset,
  lahetaOmalleKanavalle,
  yksiKerrallaan
};
