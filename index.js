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

// --- FUNCIONES BÁSICAS ---

function kmhToKnots(val) {
  if (!val) return "--";
  const n = parseFloat(val.toString().replace(/,/g, '.').replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? "--" : (n * 0.539957).toFixed(1);
}

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

async function getWeatherData() {
  const cached = weatherCache.get("meteo");
  if (cached) return cached;

  try {
    const r = await axios.get(PRIMARY_URL, { timeout: 8000 });
    const h = r.data;
    const d = {
      temp: extract(h, 'outtemp', ['Temperatura Ext']),
      wind: extract(h, 'curwindspeed', ['Velocidad del Viento']),
      gust: extract(h, 'curwindgust', ['Rafaga']),
      dir: extract(h, 'winddir', ['Direccion']),
      time: extract(h, 'lastupdate', ['Hora'])
    };
    if (d.temp) {
      weatherCache.set("meteo", d);
      return d;
    }
  } catch (e) { console.log("Reintentando con UNLP..."); }

  try {
    const r = await axios.get(BACKUP_URL, { timeout: 10000 });
    const h = r.data;
    const d = {
      temp: extract(h, 'outtemp', ['Temperatura Ext']),
      wind: extract(h, 'curwindspeed', ['Velocidad del Viento']),
      gust: extract(h, 'curwindgust', ['Rafaga']),
      dir: extract(h, 'winddir', ['Direccion']),
      time: extract(h, 'lastupdate', ['Hora'])
    };
    weatherCache.set("meteo", d);
    return d;
  } catch (e) { return null; }
}

// --- RUTAS ---

app.get('/weather-view', async (req, res) => {
  const d = await getWeatherData();
  if (!d) return res.status(502).json({ error: "offline" });
  res.json({
    temp: d.temp,
    windKnots: kmhToKnots(d.wind),
    gustKnots: kmhToKnots(d.gust),
    direction: d.dir,
    time: d.time
  });
});

app.get('/', async (req, res) => {
  const d = await getWeatherData();
  if (!d) return res.status(502).send("Estaciones offline");
  res.send(`
    <body style="background:#0f172a; color:white; font-family:sans-serif; padding:40px; display:flex; justify-content:center;">
      <div style="background:#1e293b; padding:20px; border-radius:10px; width:280px; border:1px solid #334155;">
        <h2 style="text-align:center;color:#38bdf8;">Río Grande</h2>
        <p>Temp: <b>${d.temp}</b></p>
        <p>Viento: <b>${kmhToKnots(d.wind)} kn</b></p>
        <p>Ráfaga: <b>${kmhToKnots(d.gust)} kn</b></p>
        <p>Dir: <b>${d.dir}</b></p>
        <p style="font-size:0.7rem; color:#6366f1; text-align:center;">${d.time}</p>
      </div>
    </body>
  `);
});

// --- TAREA WINDGURU ---
setInterval(async () => {
  if (!WG_UID) return;
  const d = await getWeatherData();
  if (!d) return;
  try {
    const salt = Date.now().toString();
    const hash = md5(salt + WG_UID + WG_PASSWORD);
    await axios.get('http://www.windguru.cz/upload/api.php', {
      params: {
        uid: WG_UID, salt, hash, interval: 120,
        wind_avg: kmhToKnots(d.wind), wind_max: kmhToKnots(d.gust), temperature: d.temp
      }
    });
  } catch (e) {}
}, 120000);

app.listen(PORT);
