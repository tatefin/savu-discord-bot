# Savubotti – nimipäivät, pörssisähkö ja paljon muuta

Suomenkielinen Discord-botti. Alun perin se kertoi päivän nimipäivät, liputuspäivät ja pörssisähkön
hinnan. Nyt se tekee paljon muutakin: säätiedot, liikennetiedotteet, uutiset, Lotto- ja
Eurojackpot-tulokset, Trackmania- ja Pro Pilkki 2 -palvelinten tilan, kurssit, ajastetut viestit ja
muuta. Botti tukee useaa Discord-palvelinta, ja jokaisella palvelimella on omat asetuksensa
tiedostossa `config.json`.

Tämä repo sisältää vain Discord-botin. Web-käyttöliittymä (hallintapaneeli, julkiset sivut ja
palvelinten tilasivut) ei kuulu tähän repoon. Sitä voi käyttää osoitteessa
**https://tate.stream** (ks. [Web-käyttöliittymä](#web-käyttöliittymä)).

## Rakenne

```
bot_290626.js          Botti (slash-komennot, ajastukset, automaattiset postaukset)
config.js              Asetusmoduuli, lukee/kirjoittaa config.json:ia ja täyttää oletukset
laskurit.js            Laskurit ja niiden muistutukset (esim. /wow, joulu, juhannus)
pp2.js                 Pro Pilkki 2 -palvelimen tila
tm.js                  Oman Trackmania-palvelimen tila GBXRemoten kautta
deploy/                systemd-yksikkö
examples/              Esimerkit datatiedostoista
.env.example           Kaikki ympäristömuuttujat
```

## Ominaisuudet

**Slash-komennot** (jokaisen voi kytkeä päälle tai pois palvelinkohtaisesti `config.json`:issa):

| Komento | Kuvaus |
|---|---|
| `/nimipäivät`, `/nimipaiva`, `/nimihaku` | Päivän nimipäivät, tietyn nimen nimipäivä, DVV:n nimitiedot |
| `/liputuspaiva`, `/joulu`, `/juhannus` | Liputuspäivä ja laskurit juhliin |
| `/synttarit` | Palvelimen jäsenten syntymäpäivät |
| `/sahko` | Pörssisähkön hinta (Elering / porssisahkoa.fi) |
| `/saa`, `/sää` | Sää (weatherapi.com) |
| `/liikenne tie / juna / meri`, `/hsl` | Digitrafficin liikennetiedotteet, HSL:n häiriöt |
| `/lampo koti / savu` | Kodin lämpötila (SATO OmaSato) ja isäntäkoneen CPU-lämpö |
| `/alko` | Halvin hinta alkoholiyksikköä kohden (juomaan.fi) |
| `/osake`, `/btc`, `/eth` | Kurssit ja kuvaajat |
| `/uutiset`, `/th`, `/leffat` | Ampparit-uutiset, Tilannehuone.fi:n hälytykset, päivän TV-elokuvat |
| `/lotto`, `/eurojaska` | Viimeisimmät arvontatulokset (Veikkauksen API) |
| `/tm`, `/pp2` | Trackmania-klubi ja -uutiset, Pro Pilkki 2 -palvelimen tila |
| `/uni`, `/wow`, `/uptime`, `/ai` | Unipisteet, laskuri, isäntäkoneen tila, tekoälysisällön tunnistus |
| `/help`, `/savu` | Ohje ja pudotusvalikko kaikille komennoille |

**Ajastetut viestit** (cron, palvelinkohtaiset): aamutervehdys (nimipäivät, liputuspäivä, sähkö,
synttärit), uutiskooste, viikoittainen PP2-muistutus, rajaton määrä omia ilmoituksia (toistuvia
tai kertaluontoisia), automaattiset Lotto- ja Eurojackpot-tulokset sekä Trackmania-uutiset ja
-päivitykset.

## Vaatimukset

- Node.js 20+
- Linux. `canvas` ja `puppeteer` tarvitsevat järjestelmäkirjastoja, esim. Debianissa
  `sudo apt install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev`
  sekä Chromiumin riippuvuudet Puppeteeria varten
- Discord-sovellus: https://discord.com/developers/applications
  - Botin token → `TOKEN`, Application ID → `CLIENT_ID`

## Asennus

```bash
git clone <tämä repo> nimipaivat-sahkonhinta
cd nimipaivat-sahkonhinta
npm install

cp .env.example .env        # täytä arvot
cp examples/nimipaivat.example.json nimipaivat.json   # täytä omilla nimipäivillä (ks. tekijänoikeus alla)
node bot_290626.js
```

Vain `TOKEN` ja `CLIENT_ID` ovat pakollisia. Muut avaimet tarvitaan vain niitä käyttäviin
komentoihin (sää, SATO, Trackmania, HSL, OpenAI). Kodin lämpötilahälytys yksityisviestinä on
päällä vain, jos `LAMPO_HALYTYS_USER_ID` on asetettu.

### systemd

Muokkaa `deploy/nimipaivat-bot.service`-tiedostosta `User=` ja `WorkingDirectory=` omiksesi ja aja:

```bash
sudo cp deploy/nimipaivat-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nimipaivat-bot.service
journalctl -u nimipaivat-bot.service -f
```

## Asetukset (`config.json`)

Botti luo `config.json`:in oletusasetuksilla ensimmäisellä käynnistyskerralla. Kun botti liittyy
palvelimelle, se lisää tiedostoon `guilds`-rivin palvelimen ID:llä. Botti huomaa tiedostoon tehdyt
muutokset ja ottaa ne käyttöön ilman uudelleenkäynnistystä. Kaikki kentät oletusarvoineen on
kuvattu kommentteineen `config.js`:n funktioissa `defaultGuildConfig()` ja `defaults()`.

Tärkeimmät kentät:

```jsonc
{
  "guilds": {
    "<palvelimen ID>": {
      "channels": {
        "CHANNEL_ID": "…",          // aamutervehdys
        "NEWS_CHANNEL_ID": "…",     // uutiskooste
        "PP2_CHANNEL_ID": "…",
        "LOTTO_CHANNEL_ID": "…",    // Lotto + Eurojackpot
        "TM_NEWS_CHANNEL_ID": "…"
      },
      "cron": { "aamutervehdys": "0 6 * * *", "uutiskooste": "0 6 * * *", "pp2": "0 21 * * 5" },
      "features": { "sahko": true, "cron.lotto": false },  // kytkimet, ks. DEFAULT_FEATURES
      "mukautetut": []              // omat ilmoitukset
    }
  },
  "lampoKotiAllowedUserIds": [],    // ketkä saavat käyttää /lampo koti -komentoa
  "settings": { "presences": [{ "type": "PLAYING", "text": "/help" }] }
}
```

Palvelinkohtainen data tallentuu kansioon `data/<guildId>/`. Syntymäpäivät lisätään käsin
tiedostoon `data/<guildId>/syntymapaivat.json`. Muoto on kuvattu tiedostossa
`examples/syntymapaivat.example.json`.

## Web-käyttöliittymä

Botin web-käyttöliittymä löytyy osoitteesta **https://tate.stream**:

- https://tate.stream/botti-admin/ – hallintapaneeli (Discord-kirjautuminen)
- https://tate.stream/pp2 – Pro Pilkki 2 -palvelimen tila
- https://tate.stream/trackmania – Trackmania-palvelimen tila

`/pp2`- ja `/tm`-komentojen vastauksissa olevat linkkipainikkeet osoittavat näille sivuille.

## Huomioita

- `.env`-tiedostossa arvo, jossa on `#`, pitää laittaa lainausmerkkeihin.
- `node-cron` pidetään versiossa ≥ 4.6.0. Vanhemmat versiot jumittavat 100 % CPU:lla
  kesäajan päättymisyönä.

## Muistutus tekijänoikeuksista!

Helsingin yliopistolla on tekijänoikeus laatimiinsa nimipäiväluetteloihin. Näitä ovat suomalainen ja
suomenruotsalainen nimipäivälista sekä kissojen, koirien ja hevosten nimipäivälistat. Oikeus perustuu
tekijänoikeuslain niin sanottuun luettelopykälään, ja korkein oikeus vahvisti nimipäivien
luettelosuojan vuonna 2000. Siksi repossa on vain esimerkkitiedosto eikä varsinaista nimipäivälistaa.
https://almanakka.helsinki.fi/fi/nimipaivat/nimipaivien-tekijanoikeus/

## Lisenssi

Katso [LICENSE](LICENSE).
