import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';

const app = express();
app.use(cors());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SOURCE_URL = 'http://earg_met.mooo.com:88/meteo/'; 
const AIRPORT_URL = 'https://metar-taf.com/es/metar/SAWE';

const WG_UID = process.env.WG_UID;
const WG_PASSWORD = process.env.WG_PASSWORD;

// El cache dura 10 minutos (600 seg), pero no se borra si hay error
const weatherCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// --- UTILIDADES ---

function kmhToKnots(value) {
  if (!value) return "--";
  const n = parseFloat(value.toString().replace(/,/g, '.').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? "--" : (n * 0.539957).toFixed(1);
}

function extractByClass(html, className) {
  const regex = new RegExp(`class=["']${className}["'][^>]*>([^<]+)`, 'i');
  const match = html.match(regex);
  return match ? match[1].trim() : null;
}

// --- LOGICA DE EXTRACCION ---

async function fetchAllSources() {
  // 1. Intento EARG
  try {
    const r1 = await axios.get(SOURCE_URL, { timeout: 4000 });
    const temp = extractByClass(r1.data, 'outtemp');
    if (temp) {
      return {
        stationTime: extractByClass(r1.data, 'lastupdate') || "Sinc. EARG",
        temperature: temp,
        windSpeed: extractByClass(r1.data, 'curwindspeed'),
        windGust: extractByClass(r1.data, 'curwindgust'),
        windDir: extractByClass(r1.data, 'winddir') || "--",
        rain: extractByClass(r1.data, 'dayRain') || "0.0",
        source: "EARG (Principal)"
      };
    }
  } catch (e) { console.log("EARG inaccesible"); }

  // 2. Intento SAWE (Aeropuerto) - Usando un User-Agent para evitar bloqueos
  try {
    const r2 = await axios.get(AIRPORT_URL, { 
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' } 
    });
    // Buscador simplificado para el texto del METAR
    const tempMatch = r2.data.match(/(\d+)&deg;C/); 
    const windMatch = r2.data.match(/(\d+)\s*km\/h/);

    return {
      stationTime: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) + " (SAWE)",
      temperature: tempMatch ? tempMatch[1] : "--",
      windSpeed: windMatch ? windMatch[1] : "0",
      windGust: "0",
      windDir: "Variable",
      rain: "0.0",
      source: "Aeropuerto (SAWE)"
    };
  } catch (e) { console.log("SAWE inaccesible"); }

  return null;
}

// --- RUTAS ---

app.get('/weather-view', async (req, res) => {
  let data = await fetchAllSources();
  
  if (data) {
    weatherCache.set("last_valid", data);
  } else {
    // Si todo falla, intentamos usar lo que había en el cache antes
    data = weatherCache.get("last_valid");
  }

  if (!data) return res.status(502).json({ error: "Sin conexión a fuentes" });
  res.json(data);
});

app.get('/', async (req, res) => {
  const resp = await axios.get(`http://localhost:${PORT}/weather-view`).catch(() => null);
  const d = resp ? resp.data : weatherCache.get("last_valid");

  if (!d) return res.status(502).send("Sistemas caídos temporalmente.");

  res.send(`
    <body style="background:#0f172a; color:#f1f5f9; font-family:sans-serif; display:flex; justify-content:center; padding:2rem;">
      <div style="background:#1e293b; padding:2rem; border-radius:1rem; width:300px; border:1px solid #334155;">
        <h2 style="color:#7dd3fc; margin:0; text-align:center;">Río Grande</h2>
        <p style="text-align:center; font-size:0.8rem; color:#94a3b8;">${d.source}</p>
        <hr border="0" style="border-top:1px solid #334155; margin:15px 0;">
        <div style="display:flex; justify-content:space-between; margin:10px 0;">
          <span>Temp</span><b>${d.temperature} °C</b>
        </div>
        <div style="display:flex; justify-content:space-between; margin:10px 0;">
          <span>Viento</span><b>${kmhToKnots(d.windSpeed)} kn</b>
        </div>
        <div style="display:flex; justify-content:space-between; margin:10px 0;">
          <span>Dir</span><b>${d.windDir}</b>
        </div>
        <p style="text-align:center; font-size:0.7rem; color:#6366f1; margin-top:20px;">🕒 ${d.stationTime}</p>
      </div>
    </body>
  `);
});

app.listen(PORT);
