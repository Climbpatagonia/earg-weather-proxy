import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const PRIMARY_URL = 'http://earg_met.mooo.com:88/meteo/';
const BACKUP_URL = 'http://earg.fcaglp.unlp.edu.ar/meteorologia/vp2s1/vantalhb.htm';

const WG_UID = process.env.WG_UID;
const WG_PASSWORD = process.env.WG_PASSWORD;

const weatherCache = new NodeCache({ stdTTL: 300 });

// --- FUNCIONES DE LIMPIEZA (Sintaxis simplificada para evitar errores) ---

function toKnots(value) {
  if (!value) return "--";
  let s = value.toString().replace(/,/g, '.');
  s = s.replace(/[^0-9.-]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? "--" : (n * 0.539957).toFixed(1);
}

function cleanNumeric(text) {
  if (!text) return "";
  const match = text.match(/[-+]?[0-9]*[.,]?[0-9]+/);
  if (!match) return "";
  return match[0].replace(',', '.');
}

function cleanText(text) {
  if (!text) return "";
  let t = text.toString();
  // Limpieza de caracteres de la UNLP y otros
  t = t.replace(//g, '°');
  t = t.replace(/&deg;/g, '°');
  t = t.replace(/&nbsp;/g, ' ');
  return t.trim();
}

// --- EXTRACCIÓN ---

function extract(html, className, keywords) {
  const classRegex = new RegExp(`<[^>]*class=["']?${className}["']?[^>]*>\\s*([^<]+)`, 'i');
  let m = html.match(classRegex);
  if (m && m[1]) return m[1].trim();

  for (const word of keywords) {
    const tableRegex = new RegExp(`${word}[^<]*<\\/td>\\s*<td[^>]*>\\s*([^<]+)`, 'i');
    m = html.match(tableRegex);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function parseAll(html) {
  return {
    timestamp: cleanText(extract(html, 'lastupdate', ['Hora', 'Actualiz'])),
    temp: cleanNumeric(extract(html, 'outtemp', ['Temperatura Ext', 'Temp Ext'])),
    st: cleanNumeric(extract(html, 'feelslike', ['Sensaci', 'Termica', 'ST'])),
    wind: extract(html, 'curwindspeed', ['Velocidad del Viento', 'Viento']),
    gust: extract(html, 'curwindgust', ['Rafaga', 'Viento Max']),
    dir: cleanText(extract(html, 'winddir', ['Direcci', 'Viento del'])),
    hum: cleanNumeric(extract(html, 'outHumidity', ['Humedad Ext', 'Hum Ext'])),
    press: cleanNumeric(extract(html, 'barometer', ['Barometro', 'Presion'])),
    rain: cleanNumeric(extract(html, 'dayRain', ['Precipitacion Diaria', 'Lluvia']))
  };
}

async function getData() {
  const cached = weatherCache.get("weather");
  if (cached) return cached;

  try {
    const r = await axios.get(PRIMARY_URL, { timeout: 7000 });
    const d = parseAll(r.data);
    if (d.temp) {
      weatherCache.set("weather", d);
      return d;
    }
  } catch (e) {
    console.log("Probando respaldo...");
  }

  try {
    const r = await axios.get(BACKUP_URL, { timeout: 10000 });
    const d = parseAll(r.data);
    if (d.temp) {
      weatherCache.set("weather", d);
      return d;
    }
  } catch (e) {
    return null;
  }
  return null;
}

// --- RUTAS ---

app.get('/weather-view', async (req, res) => {
  const d = await getData();
  if (!d) return res.status(502).json({ error: "offline" });
  res.json({
    temp: d.temp,
    st: d.st || d.temp,
    windKnots: toKnots(d.wind),
    gustKnots: toKnots(d.gust),
    direction: d.dir,
    time: d.timestamp
  });
});

app.get('/', async (req, res) => {
  const d = await getData();
  if (!d) return res.status(502).send("Sistemas offline.");

  res.send(`
    <body style="background:#0f172a; color:white; font-family:sans-serif; display:flex; justify-content:center; padding:20px;">
      <div style="background:#1e293b; padding:25px; border-radius:15px; width:300px; border:1px solid #334155;">
        <h2 style="color:#38bdf8; text-align:center;">Río Grande</h2>
        <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid #334155;">
          <span>Temp</span><b>${d.temp} °C</b>
        </div>
        <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid #334155;">
          <span>Viento</span><b>${toKnots(d.wind)} kn</b>
        </div>
        <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid #334155;">
          <span>Ráfaga</span><b>${toKnots(d.gust)} kn</b>
        </div>
        <div style="display:flex; justify-content:space-between; padding:10px 0;">
          <span>Dirección</span><b>${d.dir}</b>
        </div>
        <p style="text-align:center; font-size:0.7rem; color:#6366f1;">${d.timestamp}</p>
      </div>
    </body>
  `);
});

// --- WINDGURU ---
setInterval(async () => {
  if (!WG_UID) return;
  const d = await getData();
  if (!d) return;
  try {
    const salt = Date.now().toString();
    const hash = md5(salt + WG_UID + WG_PASSWORD);
    await axios.get('http://www.windguru.cz/upload/api.php', {
      params: {
        uid: WG_UID, salt, hash, interval: 120,
        wind_avg: toKnots(d.wind), wind_max: toKnots(d.gust), temperature: d.temp
      }
    });
  } catch (e) {}
}, 120000);

app.listen(PORT);
