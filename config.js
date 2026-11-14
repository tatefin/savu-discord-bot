const fs = require("fs");
const path = require("path");
const { normalisoiLaskurit } = require("./laskurit.js");

const CONFIG_PATH = path.join(__dirname, "config.json");

// discord.js ActivityType-arvot: Playing=0, Listening=2, Watching=3, Competing=5.
// Streaming (1) jätetty pois — vaatii kelvollisen twitch.tv/youtube.com-URL:n toimiakseen.
// Custom (4) jätetty pois — Discordin API:n mukaan tarkoitettu vain käyttäjätileille,
// ei toimi luotettavasti boteilla.
const ACTIVITY_TYPES = {
  PLAYING: 0,
  LISTENING: 2,
  WATCHING: 3,
  COMPETING: 5
};

const OSAKE_AIKAVALIT = ["5d", "1mo", "3mo", "1y", "5y"];

const AAMUTERVEHDYS_TAVAT = ["oletus", "mukautettu"];


const DEFAULT_FEATURES = {
  "nimipäivät": true,
  "liputuspaiva": true,
  "joulu": true,
  "juhannus": true,
  "nimipaiva": true,
  "synttarit": true,
  "nimihaku": true,
  "sahko": true,
  "saa": true,
  "liikenne.tie": true,
  "liikenne.juna": true,
  "liikenne.meri": true,
  "lampo.koti": true,
  "lampo.savu": true,
  "alko.halvinhinta": true,
  "alko.halvinannos": true,
  "alko.dokaviteetti": true,
  "osake": true,
  "btc": true,
  "eth": true,
  "uni": true,
  "uutiset.luetuimmat": true,
  "uutiset.uusimmat": true,
  "th": true,
  "tm": true,
  "pp2": true,
  "wow": true,
  "lotto": true,
  "eurojaska": true,
  "uptime": true,
  "ai": true,
  "cron.aamutervehdys": true,
  "cron.uutiskooste": true,
  "cron.pp2": true,
  "cron.mukautettu": true,
  "cron.lotto": true,
  "cron.eurojaska": true,
  "cron.tmUutiset": true,
  "cron.tmPaivitykset": true,
  // WoW Forever -muistutukset: oletuksena pois, kytketään päälle palvelinkohtaisesti.
  "cron.wow": false,
  "cron.joulu": false,
  "cron.juhannus": false
};

// --- Palvelinkohtainen (per-guild) asetuslohko ---
// Kaikki tämä on YKSILÖLLISTÄ jokaiselle Discord-palvelimelle jolla botti on käytössä:
// kanavat, ajastukset, ominaisuuskytkimet, ilmoitukset ja laskurit.
function defaultGuildConfig() {
  return {
    name: "",
    channels: {
      CHANNEL_ID: "",
      NEWS_CHANNEL_ID: "",
      PP2_CHANNEL_ID: "",
      // Lotto- ja Eurojackpot-tulosten automaattinen postaus (molemmat samalle kanavalle).
      LOTTO_CHANNEL_ID: "",
      // Trackmania-uutisten/päivitysten automaattinen postaus (trackmania.com/news).
      TM_NEWS_CHANNEL_ID: ""
    },
    cron: {
      aamutervehdys: "0 6 * * *",
      uutiskooste: "0 6 * * *",
      pp2: "0 21 * * 5"
    },
    features: { ...DEFAULT_FEATURES },
    settings: {
      osakeDefaultAikavali: "1mo",
      // "oletus" = nykyinen kiinteä sisältö (nimipäivät/liputuspäivä/syntymäpäivät/sähkö).
      // "mukautettu" = aamutervehdysMukautettu-teksti, jossa {nimipäivät}/{syntymäpäivät}/
      // {liputuspäivä}/{sähkö} korvataan lähetyshetkellä oikealla sisällöllä.
      aamutervehdysTapa: "oletus",
      aamutervehdysMukautettu: ""
    },
    // Täysin erilliset, aina-mukautetut ilmoitukset omiin kanaviinsa — voi olla useita,
    // kukin omalla kellonajallaan/kanavallaan/tekstillään. "date" tyhjä = toistuu joka päivä
    // kellonaikana hour:minute; "date" asetettu (YYYY-MM-DD) = lähetetään VAIN kyseisenä
    // päivänä (kertaluontoinen ilmoitus), muina päivinä ajastus ei laukaise mitään.
    // Samat {nimipäivät}/{syntymäpäivät}/{liputuspäivä}/{sähkö}-merkinnät käytössä kuin
    // aamutervehdyksen mukautetussa sisällössä. Tyhjä teksti tai kanava puuttuu → ei lähetetä mitään.
    mukautetut: [],
    // Botti päivittää nämä onnistuneen lähetyksen jälkeen (ei tarvitse muokata käsin).
    lastSent: {
      aamutervehdys: 0,
      uutiskooste: 0,
      pp2: 0,
      lotto: 0,
      eurojaska: 0,
      tmUutiset: 0,
      tmPaivitykset: 0,
      mukautettu: {}
    },
    // Viimeksi tälle palvelimelle käsitellyn arvonnan tunniste (lähdesivun arvontapäivä-teksti).
    // Botti postaa tuloksen vain kun tunniste vaihtuu; tyhjä = ei vielä yhtään havaintoa, jolloin
    // ensimmäinen havainto vain kirjataan postaamatta (ettei vanhaa tulosta postata deployn jälkeen).
    arvonnat: {
      lotto: "",
      eurojaska: ""
    },
    // Jo käsitellyt trackmania.com-artikkelien ID:t (uusin ensin). Tyhjä = ensimmäinen havainto
    // vain kirjataan postaamatta, samaan tapaan kuin arvonnoissa.
    tmNahdyt: [],
    // Laskurien (WoW Forever, joulu, juhannus, mukautetut) kanavat ja muistutusajat, ks. laskurit.js.
    // Kiinteiden laskurien päälle/pois on features["cron.<avain>"], mukautetuilla oma paalla-kenttä.
    laskurit: normalisoiLaskurit({})
  };
}

// Uniikki tunniste mukautetulle ilmoitukselle — pysyy samana koko sen elinkaaren ajan,
// jotta lastSent-kartta osaa kohdistaa oikean rivin oikeaan ilmoitukseen.
function uusiMukautettuId() {
  return `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Viikonpäivät JS:n Date#getDay()-numeroinnilla (0 = sunnuntai … 6 = lauantai), sama käytäntö
// kuin PP2-ilmoituksen "pp2Paiva"-valitsimessa jo ennestään.
function normalisoiMukautettuPaivat(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
}

function normalisoiMukautettuItem(raw) {
  const hour = Number(raw?.hour);
  const minute = Number(raw?.minute);
  // Toistotapa on kolme toisensa poissulkevaa vaihtoehtoa: jos "date" on asetettu, se voittaa
  // (kertaluontoinen); muuten jos "days" ei ole tyhjä, toistuu vain niinä viikonpäivinä;
  // muuten (molemmat tyhjät) toistuu joka päivä — vanha, alkuperäinen käytös.
  return {
    id: typeof raw?.id === "string" && raw.id ? raw.id : uusiMukautettuId(),
    teksti: typeof raw?.teksti === "string" ? raw.teksti.slice(0, 3000) : "",
    channelId: typeof raw?.channelId === "string" ? raw.channelId.trim() : "",
    hour: Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.round(hour))) : 12,
    minute: Number.isFinite(minute) ? Math.min(59, Math.max(0, Math.round(minute))) : 0,
    // Valinnainen kertaluontoinen päivämäärä (YYYY-MM-DD). Tyhjä = ei kertaluontoinen.
    date: typeof raw?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : "",
    // Valinnaiset viikonpäivät (0-6). Tyhjä = ei viikonpäivärajoitusta (eli joka päivä, jos ei myöskään "date").
    days: normalisoiMukautettuPaivat(raw?.days)
  };
}

// Migraatio: ennen usean mukautetun ilmoituksen tukea (ks. muisti-/projektihistoria) oli
// vain yksi kiinteä mukautettu ilmoitus (cron.mukautettu + settings.mukautettuTeksti +
// channels.CUSTOM_CHANNEL_ID). Käännetään se yhdeksi listan alkioksi jos uutta "mukautetut"
// -taulukkoa ei vielä ole tallennettu.
function normalisoiMukautetut(rawGuild) {
  if (Array.isArray(rawGuild?.mukautetut)) {
    return rawGuild.mukautetut.map(normalisoiMukautettuItem);
  }

  const legacyTeksti = typeof rawGuild?.settings?.mukautettuTeksti === "string" ? rawGuild.settings.mukautettuTeksti : "";
  const legacyChannel = typeof rawGuild?.channels?.CUSTOM_CHANNEL_ID === "string" ? rawGuild.channels.CUSTOM_CHANNEL_ID : "";
  if (!legacyTeksti.trim() && !legacyChannel) return [];

  const cronMatch = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec((rawGuild?.cron?.mukautettu || "").trim());
  return [normalisoiMukautettuItem({
    id: "legacy",
    teksti: legacyTeksti,
    channelId: legacyChannel,
    hour: cronMatch ? Number(cronMatch[2]) : 12,
    minute: cronMatch ? Number(cronMatch[1]) : 0
  })];
}

// Ennen usean mukautetun tuen lisäämistä lastSent.mukautettu oli
// pelkkiä lukuja (aikaleimoja). Jos vanha luku löytyy ja migraatio tuotti "legacy"-alkion,
// säilytetään aikaleima sille — muuten se katoaisi migraatiossa jäljettömiin.
function normalisoiMukautettuAikaleimat(raw, mukautetut) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "number" && raw > 0 && mukautetut.some(m => m.id === "legacy")) {
    return { legacy: raw };
  }
  return {};
}

// --- Globaalit (koko botin laajuiset) asetukset ---
// Näitä EI voi asettaa palvelinkohtaisesti: Discord-botilla on vain yksi tila/presenssi
// riippumatta siitä montako palvelinta se on liittynyt, Alko-välimuisti on jaettu
// HTTP-optimointi joka koskee kaikkia palvelimia yhtä lailla, ja /lampo koti näyttää
// botin omistajan OMAN oikean kotinsa lämpötilan (OmaSATO) — ei mitään joka liittyisi
// tiettyyn Discord-palvelimeen.
function defaults() {
  return {
    guilds: {},
    lampoKotiAllowedUserIds: [],
    settings: {
      alkoCacheMinutes: 30,
      presenceIntervalMinutes: 10,
      presences: [
        { type: "PLAYING", text: "/help - sekopää apina" }
      ],
      osakeDefaultAikavali: "1mo" // varapaikka DM-käytölle (ei liity mihinkään guildiin)
    }
  };
}

function ensureConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults(), null, 2));
  }
}

function normalisoiPresences(rawSettings, base) {
  if (rawSettings && typeof rawSettings.presenceText === "string" && !rawSettings.presences) {
    return [{ type: "PLAYING", text: rawSettings.presenceText }];
  }
  if (!rawSettings || !Array.isArray(rawSettings.presences)) return base.settings.presences;

  const kelvolliset = rawSettings.presences
    .filter(p => p && typeof p.text === "string" && p.text.trim() && ACTIVITY_TYPES[p.type] !== undefined)
    .map(p => ({ type: p.type, text: p.text.trim().slice(0, 120) }));

  return kelvolliset.length ? kelvolliset : base.settings.presences;
}

function normalisoiGuildConfig(rawGuild) {
  const base = defaultGuildConfig();
  if (!rawGuild || typeof rawGuild !== "object") return base;

  const mukautetut = normalisoiMukautetut(rawGuild);

  return {
    name: typeof rawGuild.name === "string" ? rawGuild.name : base.name,
    // WOW_CHANNEL_ID (1.11.2026 versio) siirtyy laskurit.wow:iin, ks. normalisoiLaskurit.
    channels: Object.fromEntries(Object.entries({ ...base.channels, ...rawGuild.channels }).filter(([k]) => k !== "WOW_CHANNEL_ID")),
    cron: { ...base.cron, ...rawGuild.cron },
    features: { ...base.features, ...rawGuild.features },
    settings: {
      osakeDefaultAikavali: OSAKE_AIKAVALIT.includes(rawGuild.settings?.osakeDefaultAikavali)
        ? rawGuild.settings.osakeDefaultAikavali
        : base.settings.osakeDefaultAikavali,
      aamutervehdysTapa: AAMUTERVEHDYS_TAVAT.includes(rawGuild.settings?.aamutervehdysTapa)
        ? rawGuild.settings.aamutervehdysTapa
        : base.settings.aamutervehdysTapa,
      aamutervehdysMukautettu: typeof rawGuild.settings?.aamutervehdysMukautettu === "string"
        ? rawGuild.settings.aamutervehdysMukautettu.slice(0, 3000)
        : base.settings.aamutervehdysMukautettu
    },
    mukautetut,
    lastSent: {
      ...base.lastSent,
      ...rawGuild.lastSent,
      mukautettu: normalisoiMukautettuAikaleimat(rawGuild.lastSent?.mukautettu, mukautetut)
    },
    arvonnat: {
      lotto: typeof rawGuild.arvonnat?.lotto === "string" ? rawGuild.arvonnat.lotto : base.arvonnat.lotto,
      eurojaska: typeof rawGuild.arvonnat?.eurojaska === "string" ? rawGuild.arvonnat.eurojaska : base.arvonnat.eurojaska
    },
    tmNahdyt: Array.isArray(rawGuild.tmNahdyt)
      ? rawGuild.tmNahdyt.filter(id => typeof id === "string").slice(0, 100)
      : base.tmNahdyt,
    laskurit: normalisoiLaskurit(rawGuild)
  };
}

// Migraatio: hyvin vanha (ennen useiden palvelinten tukea) config.json oli litteä objekti
// ilman "guilds"-avainta. Kääritään sen sisältö yhdeksi "__legacy__"-guildiksi; botti
// korvaa tämän avaimen oikealla guild-ID:llä ensimmäisen käynnistyksen yhteydessä
// (ks. bot_290626.js: ratkaiseLegacyGuild).
function onkoVanhaMuoto(raw) {
  return raw && typeof raw === "object" && !raw.guilds && (raw.channels || raw.cron || raw.features);
}

function migroiVanhaMuoto(raw) {
  const perus = defaults();
  const legacyGuild = normalisoiGuildConfig({
    channels: raw.channels,
    cron: raw.cron,
    features: raw.features,
    settings: raw.settings,
    lastSent: raw.lastSent
  });
  legacyGuild.name = "(tunnistetaan uudelleenkäynnistyksessä)";

  return {
    guilds: { __legacy__: legacyGuild },
    lampoKotiAllowedUserIds: Array.isArray(raw.lampoKotiAllowedUserIds) ? raw.lampoKotiAllowedUserIds : perus.lampoKotiAllowedUserIds,
    settings: {
      alkoCacheMinutes: raw.settings?.alkoCacheMinutes ?? perus.settings.alkoCacheMinutes,
      presenceIntervalMinutes: raw.settings?.presenceIntervalMinutes ?? perus.settings.presenceIntervalMinutes,
      presences: normalisoiPresences(raw.settings, perus),
      osakeDefaultAikavali: perus.settings.osakeDefaultAikavali
    }
  };
}

function loadConfig() {
  ensureConfig();
  const base = defaults();
  try {
    let raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (onkoVanhaMuoto(raw)) {
      raw = migroiVanhaMuoto(raw);
      saveConfig(raw);
    }

    const guilds = {};
    for (const [guildId, guildRaw] of Object.entries(raw.guilds || {})) {
      guilds[guildId] = normalisoiGuildConfig(guildRaw);
    }

    // Migraatio: /lampo koti -oikeudet olivat ennen palvelinkohtaisia, mutta ne koskevat
    // oikeasti vain botin omistajan omaa kotia eivätkä mitään tiettyä Discord-palvelinta.
    // Jos globaalia listaa ei vielä ole, kootaan vanhat per-guild-listat yhteen kertaalleen.
    let lampoKotiAllowedUserIds;
    let lampoMigraatioTarvitaan = false;
    if (Array.isArray(raw.lampoKotiAllowedUserIds)) {
      lampoKotiAllowedUserIds = raw.lampoKotiAllowedUserIds;
    } else {
      const kerätyt = new Set();
      for (const g of Object.values(raw.guilds || {})) {
        if (Array.isArray(g?.lampoKotiAllowedUserIds)) g.lampoKotiAllowedUserIds.forEach(id => kerätyt.add(id));
      }
      lampoKotiAllowedUserIds = kerätyt.size ? [...kerätyt] : base.lampoKotiAllowedUserIds;
      lampoMigraatioTarvitaan = true;
    }

    const cfg = {
      guilds,
      lampoKotiAllowedUserIds,
      settings: {
        alkoCacheMinutes: raw.settings?.alkoCacheMinutes ?? base.settings.alkoCacheMinutes,
        presenceIntervalMinutes: raw.settings?.presenceIntervalMinutes ?? base.settings.presenceIntervalMinutes,
        presences: normalisoiPresences(raw.settings, base),
        osakeDefaultAikavali: base.settings.osakeDefaultAikavali
      }
    };

    if (lampoMigraatioTarvitaan) saveConfig(cfg);
    return cfg;
  } catch (err) {
    console.error("config.json luku epäonnistui, käytetään oletuksia:", err.message);
    return base;
  }
}

// Kirjoittaa atomisesti (tmp-tiedosto + rename), jotta botin fs.watchFile ei näe puolikasta tiedostoa.
function saveConfig(next) {
  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2));
  fs.renameSync(tmpPath, CONFIG_PATH);
}

// Palauttaa yhden palvelimen asetukset, tai oletusarvot (kaikki päällä) jos guildId
// puuttuu (esim. DM-konteksti) tai palvelinta ei vielä ole rekisteröity.
function loadGuildConfig(guildId) {
  const cfg = loadConfig();
  if (!guildId || !cfg.guilds[guildId]) return defaultGuildConfig();
  return cfg.guilds[guildId];
}

function saveGuildConfig(guildId, guildConfig) {
  const cfg = loadConfig();
  cfg.guilds[guildId] = normalisoiGuildConfig(guildConfig);
  saveConfig(cfg);
  return cfg.guilds[guildId];
}

// Kutsutaan botista kun se liittyy (tai käynnistyy jo liittyneenä) palvelimelle —
// varmistaa että config.guilds sisältää rivin, jota voi sitten muokata config.json:ssa.
function ensureGuildExists(guildId, name) {
  const cfg = loadConfig();
  let muuttui = false;

  if (!cfg.guilds[guildId]) {
    cfg.guilds[guildId] = defaultGuildConfig();
    cfg.guilds[guildId].name = name || "";
    muuttui = true;
  } else if (name && cfg.guilds[guildId].name !== name) {
    cfg.guilds[guildId].name = name;
    muuttui = true;
  }

  if (muuttui) saveConfig(cfg);
  return cfg.guilds[guildId];
}

// DM (ei guildia): ominaisuudet ovat aina päällä koska niitä ei voi hallita per-palvelin.
function isFeatureEnabled(guildId, key) {
  if (!guildId) return true;
  const guildCfg = loadGuildConfig(guildId);
  if (key in guildCfg.features) return guildCfg.features[key] !== false;
  const top = key.split(".")[0];
  return guildCfg.features[top] !== false;
}

module.exports = {
  CONFIG_PATH,
  ACTIVITY_TYPES,
  loadConfig,
  saveConfig,
  loadGuildConfig,
  saveGuildConfig,
  ensureGuildExists,
  isFeatureEnabled
};
