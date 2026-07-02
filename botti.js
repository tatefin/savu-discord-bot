require("dotenv").config();

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require("discord.js");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const axios = require("axios");
const cheerio = require("cheerio");
const { createCanvas } = require("canvas");

const { TOKEN, CLIENT_ID, CHANNEL_ID, WEATHER_API_KEY, TM_LOGIN, TM_PASSWORD, TM_OAUTH_ID, TM_OAUTH_SECRET } = process.env;
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const DT_HEADERS = { "Digitraffic-User": "discord-bot/savu" };

/* --- APU --- */

const tanyKey = () => {
  const d = new Date();
  return `${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};

const lueJSON = (tiedosto) => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, tiedosto))); }
  catch { return {}; }
};

const muotoilePaivaEro = d => d === 0 ? "tänään!" : d === 1 ? "huomenna" : `${d} päivän päästä`;

const muotoileNimet = nimet =>
  !nimet.length ? "Tänään ei ole nimipäiviä. 😊"
  : nimet.length === 1 ? `🎉 Onnea **${nimet[0]}**!`
  : `🎊 Nimipäivät: **${nimet.join(", ")}**`;

const muotoileSynttarit = nimet =>
  nimet.length ? `🎂 Tänään synttärit: ${nimet.join(", ")}!` : null;

const haeNimipaivat = () => lueJSON("nimipaivat.json")[tanyKey()] || [];
const haeSynttarit  = () => lueJSON("syntymapaivat.json")[tanyKey()] || [];

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
    "01-06":"Loppiainen","02-05":"Runebergin päivä","02-28":"Kalevalan päivä",
    "03-19":"Minna Canthin päivä","04-09":"Agricolan päivä","04-27":"Veteraanipäivä",
    "05-01":"Vappu","05-09":"Eurooppa-päivä","05-12":"Snellmanin päivä",
    "06-04":"Puolustusvoimat","07-06":"Eino Leinon päivä","10-10":"Aleksis Kiven päivä",
    "10-24":"YK-päivä","11-06":"Ruotsalaisuuden päivä","11-20":"Lapsen oikeudet",
    "12-06":"Itsenäisyyspäivä","12-08":"Sibeliuksen päivä"
  };

  const easter = getEaster(year);
  const liikkuvat = [
    [addDays(easter,-2),"Pitkäperjantai"], [easter,"Pääsiäispäivä"],
    [addDays(easter,39),"Helatorstai"],    [addDays(easter,49),"Helluntai"],
    [getNthWeekday(year,4,0,2),"Äitienpäivä"],
    [getNthWeekday(year,10,0,2),"Isänpäivä"],
    [findSaturday(year,5,20,26),"Juhannuspäivä"],
    [findSaturday(year,9,31,37),"Pyhäinpäivä"],
  ];

  return liikkuvat.find(([dt])=>isSame(dt))?.[1] || fixed[tanyKey()] || null;
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

/* --- LIIKENNE --- */

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

/* --- SÄHKÖGRAAFI --- */

function piirraGraafi(prices) {
  const W = 800, H = 400, PAD = { top:30, right:20, bottom:40, left:55 };
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
    const isPast = parseInt(p.time) < now;
    ctx.fillStyle = Math.abs(p.price - minPrice) < EPS ? "#57f287"
      : Math.abs(p.price - maxPrice) < EPS ? "#ed4245"
      : isPast ? "#4a4d52"
      : "#5865f2";
    ctx.fillRect(x, y, xStep - 4, barH);
  });

  // X-akselitunnisteet (joka toinen tunti)
  ctx.fillStyle = "#9b9d9f";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  prices.forEach((p, i) => {
    if (i % 2 === 0) ctx.fillText(p.time, toX(i), H - PAD.bottom + 16);
  });

  // Nykyinen tunti -viiva
  const nowX = PAD.left + now * xStep;
  ctx.strokeStyle = "#fee75c";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(nowX, PAD.top); ctx.lineTo(nowX, PAD.top + ch); ctx.stroke();
  ctx.setLineDash([]);

  // Otsikko
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 14px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("c/kWh", 4, PAD.top - 10);

  return canvas.toBuffer("image/png");
}



async function haeSaa(kaupunki) {
  try {
    const { data } = await axios.get(
      `https://api.weatherapi.com/v1/current.json?key=${WEATHER_API_KEY}&q=${encodeURIComponent(kaupunki+", Finland")}&lang=fi`
    );
    return data;
  } catch { return null; }
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

  const toX = i => PAD.left + (i / (pisteet.length - 1)) * cw;
  const toY = v => PAD.top + ch - ((v - minH) / range) * ch;

  // Vaakaviivat ja y-akselitunnisteet
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const v = minH + (range / 4) * (4 - i);
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
  ctx.fillText(nimi, PAD.left, 24);
  ctx.fillStyle = "#9b9d9f";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(valuutta, W - PAD.right, 24);

  return canvas.toBuffer("image/png");
}

/* --- KOMENNOT --- */

const commands = [
  new SlashCommandBuilder().setName("nimipäivät").setDescription("Näyttää nimipäivät"),
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
      )),
  new SlashCommandBuilder().setName("saa").setDescription("Näyttää säätilan")
    .addStringOption(o => o.setName("kaupunki").setDescription("Kaupunki").setRequired(true)),
  new SlashCommandBuilder().setName("liikenne").setDescription("Näyttää tie- ja junaliikenteen häiriöt"),
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
  new SlashCommandBuilder().setName("help").setDescription("Näyttää kaikki komennot"),
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
      .addStringOption(o => o.setName("klubi").setDescription("Klubin nimi").setRequired(true))),
].map(c=>c.toJSON());

(async () => {
  try {
    await new REST({ version:"10" }).setToken(TOKEN).put(Routes.applicationCommands(CLIENT_ID), { body:commands });
    console.log("Slash-komennot rekisteröity.");
  } catch (err) { console.error(err); }
})();

/* --- INTERAKTIOT --- */

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  if (cmd === "help") {
    return interaction.reply({
      flags: 64,
      embeds: [new EmbedBuilder()
        .setTitle("📖 Komennot")
        .addFields(
          { name:"📅 /nimipäivät", value:"Näyttää tämän päivän nimipäivät." },
          { name:"🔍 /nimipaiva [nimi]", value:"Hakee milloin nimen nimipäivä on ja koska se tulee seuraavan kerran." },
          { name:"👤 /nimihaku etu [nimi]", value:"Avaa DVV:n nimipalvelun etunimihaku suoraan linkkinä." },
          { name:"👥 /nimihaku suku [nimi]", value:"Avaa DVV:n nimipalvelun sukunimihaku suoraan linkkinä." },
          { name:"⚡ /sahko [näkymä]", value:"Pörssisähkön hinnat + graafi.\n`yhteenveto` · `matalin` · `kallein` · `kaikki`" },
          { name:"🌤️ /saa [kaupunki]", value:"Näyttää kaupungin säätilan: lämpötila, tuuli, kosteus, pilvisyys ja näkyvyys." },
          { name:"🚦 /liikenne", value:"Tieliikenteen häiriötiedotteet ja myöhässä olevat kaukojunat." },
          { name:"📈 /osake [haku] [aikaväli]", value:"Osakkeen kurssi ja graafi Yahoo Financesta.\nHae nimellä tai tickerillä (esim. `Nokia`, `AAPL`, `NOKIA.HE`)\nAikaväli: `1 viikko` · `1 kuukausi` · `3 kuukautta` · `1 vuosi` · `5 vuotta`" },
          { name:"🏆 /tm ranking <klubi>", value:"Top-15 trophy-ranking klubin sisällä." },
          { name:"ℹ️ /tm info <klubi>", value:"Klubin perustiedot: ID, tag, jäsenmäärä, suosio." },
          { name:"📋 /tm kampanjat <klubi>", value:"Klubin kampanjat karttalukuineen ja julkaisupäivineen." },
          { name:"🖥️ /tm huoneet <klubi>", value:"Klubin serverit ja aktiiviset pelaajamäärät." },
          { name:"📂 /tm aktiviteetit <klubi>", value:"Kaikki klubin aktiviteetit (kampanjat, huoneet, uutiset, kilpailut)." },
          { name:"⏱️ /tm shorts <klubi>", value:"Tämän viikon Weekly Shorts -tulokset klubin sisällä, kartoittain." },
          { name:"📖 /help", value:"Näyttää tämän viestin." },
          { name:"\u200b", value:"💬 Kaikki komennot näkyvät vain sinulle." }
        )
      ]
    });
  }

  if (cmd === "nimipäivät") {
    return interaction.reply({
      flags: 64,
      embeds: [new EmbedBuilder().setTitle("📅 Nimipäivät").setDescription(muotoileNimet(haeNimipaivat()))]
    });
  }

  if (cmd === "nimipaiva") {
    const nimi = interaction.options.getString("nimi").toLowerCase();
    const data = lueJSON("nimipaivat.json");
    const loydot = Object.entries(data)
      .filter(([,nimet]) => nimet.map(n=>n.toLowerCase()).includes(nimi))
      .map(([pvm]) => pvm);

    if (!loydot.length) return interaction.reply({ content:`Nimelle **${nimi}** ei löytynyt nimipäivää.`, flags:64 });

    const kuukaudet = ["tammikuuta","helmikuuta","maaliskuuta","huhtikuuta","toukokuuta","kesäkuuta",
      "heinäkuuta","elokuuta","syyskuuta","lokakuuta","marraskuuta","joulukuuta"];
    const today = new Date();

    const formatted = loydot.map(p => {
      const [kk,pv] = p.split("-").map(Number);
      return { text:`${pv}. ${kuukaudet[kk-1]}`, date:new Date(today.getFullYear(), kk-1, pv) };
    });

    const next = formatted.reduce((best, f) => {
      let d = new Date(f.date);
      if (d < today) d.setFullYear(d.getFullYear()+1);
      const diff = Math.ceil((d-today)/(864e5));
      return diff < best.diff ? { ...f, diff } : best;
    }, { diff:Infinity });

    return interaction.reply({
      flags: 64,
      embeds: [new EmbedBuilder()
        .setTitle("🔍 Nimipäivähaku")
        .setDescription(`**${nimi}**: ${formatted.map(f=>f.text).join(", ")}`)
        .addFields({ name:"⏭️ Seuraava", value:`${next.text} (${muotoilePaivaEro(next.diff)})` })]
    });
  }

  if (cmd === "nimihaku") {
    const sub = interaction.options.getSubcommand();
    const nimi = interaction.options.getString("nimi");
    const nimiEnkoodattu = encodeURIComponent(nimi);

    if (sub === "etu") {
      const url = `https://nimipalvelu.dvv.fi/etunimihaku?nimi=${nimiEnkoodattu}`;
      return interaction.reply({
        flags: 64,
        embeds: [new EmbedBuilder()
          .setTitle(`👤 Etunimihaku: ${nimi}`)
          .setURL(url)
          .setDescription(`Katso **${nimi}**-etunimen tiedot DVV:n nimipalvelusta:\n🔗 ${url}`)
          .addFields({ name:"📊 Tiedot sisältävät", value:"• Nimen haltijoiden lukumäärä\n• Sukupuolijakauma\n• Suosion kehitys vuosikymmenittäin" })
          .setFooter({ text:"Lähde: Digi- ja väestötietovirasto (DVV)" })
          .setColor(0x003580)]
      });
    }

    if (sub === "suku") {
      const url = `https://nimipalvelu.dvv.fi/sukunimihaku?nimi=${nimiEnkoodattu}`;
      return interaction.reply({
        flags: 64,
        embeds: [new EmbedBuilder()
          .setTitle(`👥 Sukunimihaku: ${nimi}`)
          .setURL(url)
          .setDescription(`Katso **${nimi}**-sukunimen tiedot DVV:n nimipalvelusta:\n🔗 ${url}`)
          .addFields({ name:"📊 Tiedot sisältävät", value:"• Nimen haltijoiden lukumäärä\n• Suosion kehitys vuosikymmenittäin" })
          .setFooter({ text:"Lähde: Digi- ja väestötietovirasto (DVV)" })
          .setColor(0x003580)]
      });
    }
  }

  if (cmd === "sahko") {
    await interaction.deferReply({ flags:64 });
    const data = await haePorssisahkoData(false);
    if (!data) return interaction.editReply("Sähkötietoja ei saatu haettua. Yritä hetken kuluttua uudelleen.");

    const nakyma = interaction.options.getString("näkymä") || "yhteenveto";
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

  if (cmd === "saa") {
    await interaction.deferReply({ flags:64 });
    const kaupunki = interaction.options.getString("kaupunki");
    const data = await haeSaa(kaupunki);
    if (!data) return interaction.editReply("Säätietoja ei löytynyt.");
    const c = data.current;
    return interaction.editReply({
      embeds: [new EmbedBuilder()
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
        )]
    });
  }

  if (cmd === "liikenne") {
    await interaction.deferReply({ flags:64 });
    const [tieData, junaData] = await Promise.all([haeTiehairot(), haeJunahahairot()]);

    const embed = new EmbedBuilder()
      .setTitle("🚦 Liikennetilanne")
      .setURL("https://liikennetilanne.fintraffic.fi/")
      .setColor(0xe8a000);

    if (!tieData)
      embed.addFields({ name:"🚗 Tieliikenne", value:"Tietoja ei saatavilla." });
    else if (!tieData.length)
      embed.addFields({ name:"🚗 Tieliikenne", value:"✅ Ei aktiivisia häiriöitä." });
    else
      embed.addFields({ name:`🚗 Tieliikenne (${tieData.length} häiriötä)`, value:
        tieData.map(h => `• **${h.otsikko}**${h.sijainti?`\n  ${h.sijainti}`:""}${h.alkoi?`\n  🕐 Alkaen ${h.alkoi}`:""}`).join("\n\n")
      });

    if (!junaData)
      embed.addFields({ name:"🚆 Junaliikenne", value:"Tietoja ei saatavilla." });
    else if (!junaData.length)
      embed.addFields({ name:"🚆 Junaliikenne", value:"✅ Ei merkittäviä myöhästymisiä." });
    else
      embed.addFields({ name:`🚆 Junaliikenne (${junaData.length} myöhässä)`, value:
        junaData.map(j=>`• **${j.juna}** — myöhässä **${j.myohassa} min** (${j.asema})`).join("\n")
      });

    embed.setFooter({ text:"Lähde: Digitraffic / Fintraffic" }).setTimestamp();
    return interaction.editReply({ embeds:[embed], flags:64 });
  }
  if (cmd === "osake") {
    await interaction.deferReply({ flags:64 });

    const haku = interaction.options.getString("haku");
    const aikaväli = interaction.options.getString("aikaväli") || "1mo";
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
  if (cmd === "tm") {
    await interaction.deferReply({ flags: 64 });

    const sub = interaction.options.getSubcommand();
    const klubiNimi = interaction.options.getString("klubi");

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
});

/* --- CRON --- */

client.once("clientReady", () => {
  console.log(`Kirjautunut: ${client.user.tag}`);

  client.user.setPresence({
    activities: [{ name: "raapii puuta", type: 0 }], // type 0 = Playing
    status: "online"
  });

  cron.schedule("0 6 * * *", async () => {
    const channel = await client.channels.fetch(CHANNEL_ID);
    const embed = new EmbedBuilder()
      .setTitle(":wave:  Huomenta!")
      .setURL("https://www.porssisahkoa.fi/")
      .setDescription(muotoileNimet(haeNimipaivat()));

    const liputus = haeLiputuspaiva();
    if (liputus) embed.addFields({ name:"🇫🇮 Liputuspäivä", value:liputus });

    const synttarit = muotoileSynttarit(haeSynttarit());
    if (synttarit) embed.addFields({ name:"🎂 Onneksi olkoon", value:synttarit });

    const sahko = await haePorssisahkoData(true);
    let attachment = null;
    if (sahko) {
      embed.addFields({ name:"⚡ Sähkö (tästä hetkestä →)", value:
        `🔻 ${sahko.halvin.price} c/kWh\nklo ${sahko.halvin.time}\n` +
        `⚖️ ${sahko.keski} c/kWh\n` +
        `🔺 ${sahko.kallein.price} c/kWh\nklo ${sahko.kallein.time}`
      });
      const graafi = piirraGraafi(sahko.kaikki);
      attachment = new AttachmentBuilder(graafi, { name:"sahko.png" });
      embed.setImage("attachment://sahko.png");
    }

    await channel.send({ embeds:[embed], files: attachment ? [attachment] : [] });
  }, { timezone:"Europe/Helsinki" });
});

client.login(TOKEN);
