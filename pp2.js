const axios = require("axios");
const cheerio = require("cheerio");

const PP2_HOSTLIST_URL = "http://propilkki.ddns.net/propilkki2/P2_hostlist/P2_hostlist.php";
const PP2_PALVELIN_NIMI = "Suljettu osasto";

async function haePP2Palvelin() {
  try {
    // Sivu on ISO-8859-1-koodattu — haetaan raakana ja dekoodataan itse, ettei ä/ö/å mene rikki.
    const res = await axios.get(PP2_HOSTLIST_URL, { responseType: "arraybuffer", timeout: 10000 });
    const html = Buffer.from(res.data).toString("latin1");
    const $ = cheerio.load(html);

    let loytyi = null;
    $("table tbody tr").each((_, rivi) => {
      const cols = $(rivi).find("td").map((_, td) => $(td).text().trim()).get();
      if (cols.length < 13) return;
      if (cols[2] === PP2_PALVELIN_NIMI) {
        loytyi = {
          ip: cols[0],
          portti: cols[1],
          nimi: cols[2],
          maa: cols[3],
          versio: cols[4],
          kartta: cols[5],
          aika: cols[6],
          pelaajat: cols[7],
          salasanaVaaditaan: cols[8] === "1",
          autohost: cols[9] === "1",
          records: cols[10] === "1",
          uptime: cols[11],
          info: cols[12]
        };
        return false;
      }
    });
    return loytyi;
  } catch (err) {
    console.error("haePP2Palvelin virhe:", err.response?.status, err.message);
    return null;
  }
}

module.exports = { PP2_HOSTLIST_URL, PP2_PALVELIN_NIMI, haePP2Palvelin };
