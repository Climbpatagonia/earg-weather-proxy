import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';

const app = express();
app.use(cors());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SOURCE_URL = 'http://earg_met.mooo.com:88/meteo/'; 
const BACKUP_URL = 'http://earg.fcaglp.unlp.edu.ar/meteorologia/vp2s1/vantalhb.htm';

const WG_UID = process.env.WG_UID;
const WG_PASSWORD = process.env.WG_PASSWORD;

const weatherCache = new NodeCache({ stdTTL: 300 });

// --- UTILIDADES ---

function getLocalTime() {
  return new Date().toLocaleTimeString('es-AR', { 
    timeZone: 'America/Argentina/Buenos_Aires', 
    hour: '2-digit', minute: '2-digit', hour12: false 
  }) + " hs";
}

function cleanNumeric(text) {
  if (!text) return "0.0";
  const match = text.match(/[-+]?[0-9]*[.,]?[0-9]+/);
  return match ? match[0].replace(',', '.') : "0.0";
}

function toKnots(value) {
  const n = parseFloat(cleanNumeric(value));
  return isNaN(n) || n === 0 ? "--" : (n * 0.539957).toFixed(1);
}

// --- EXTRACTORES ---

function extractByClass(html, className) {
  const regex = new RegExp(`<[^>]*class=["']?${className}["']?[^>]*>\\s*([^<]+)`, 'i');
  const match = html.match(regex);
  return match ? match[1].trim() : null;
}

function extractByLabel(html, labels) {
  for (const label of labels) {
    const regex = new RegExp(`${label}[^<]*<\\/font>[^<]*<font[^>]*>[^<]*<small>[^<]*<font[^>]*>([^<]+)`, 'i');
    const match = html.match(regex);
    if (match) return match[1].trim();
  }
  return null;
}

function parseMeteo(html, isBackup = false) {
  if (isBackup) {
    return {
      time: getLocalTime(),
      temp: cleanNumeric(extractByLabel(html, ["Temperatura"])),
      st: cleanNumeric(extractByLabel(html, ["Sensacion Termica", "ST"])),
      wind: cleanNumeric(extractByLabel(html, ["Velocidad", "Viento"])),
      gust: cleanNumeric(extractByLabel(html, ["Rafaga", "Viento Max"])),
      dir: extractByLabel(html, ["Direccion"]) || "--",
      rain: cleanNumeric(extractByLabel(html, ["Diario", "Lluvia", "Precipitacion"]))
    };
  }
  
  return {
    time: extractByClass(html, 'lastupdate') || getLocalTime(),
    temp: cleanNumeric(extractByClass(html, 'outtemp')),
    st: cleanNumeric(extractByClass(html, 'feelslike')),
    wind: cleanNumeric(extractByClass(html, 'curwindspeed')),
    gust: cleanNumeric(extractByClass(html, 'curwindgust')),
    dir: extractByClass(html, 'winddir') || "--",
    rain: cleanNumeric(extractByClass(html, 'dayRain'))
  };
}

// --- RUTAS ---

app.get('/weather-view', async (req, res) => {
  let data = weatherCache.get("data");
  if (data) return res.json(data);

  // 1. Intento Mooo.com
  try {
    const r = await axios.get(SOURCE_URL, { timeout: 5000 });
    data = parseMeteo(r.data, false);
    if (data.temp !== "0.0") {
      weatherCache.set("data", data);
      return res.json(data);
    }
  } catch (e) {}

  // 2. Intento UNLP
  try {
    const r = await axios.get(BACKUP_URL, { timeout: 7000 });
    data = parseMeteo(r.data, true);
    weatherCache.set("data", data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: "Offline" });
  }
});

app.get('/', async (req, res) => {
  try {
    const r = await axios.get(`http://localhost:${PORT}/weather-view`);
    const d = r.data;
    res.send(`
      <body style="background:#0f172a; color:#e2e8f0; font-family:sans-serif; display:flex; justify-content:center; padding:20px;">
        <div style="background:#1e293b; padding:20px; border-radius:15px; width:300px; border:1px solid #334155;">
          <h2 style="text-align:center; color:#7dd3fc; margin:0;">Río Grande</h2>
          <p style="text-align:center; font-size:0.8rem; color:#94a3b8; margin-bottom:15px;">EARG / UNLP Sync</p>
          <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #334155;">
            <span>Temperatura</span><b>${d.temp} °C</b>
          </div>
          <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #334155;">
            <span>Viento</span><b>${toKnots(d.wind)} kn</b>
          </div>
          <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #334155;">
            <span>Dirección</span><b>${d.dir}</b>
          </div>
          <div style="display:flex; justify-content:space-between; padding:8px 0;">
            <span>Lluvia</span><b>${d.rain} mm</b>
          </div>
          <p style="text-align:center; font-size:0.7rem; color:#6366f1; margin-top:20px;">🕒 ${d.time}</p>
        </div>
      </body>
    `);
  } catch (e) { res.status(502).send("Error"); }
});

app.listen(PORT);
