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

const weatherCache = new NodeCache({ stdTTL: 300 });

// --- FUNCIONES DE UTILIDAD ---

function kmhToKnots(value) {
  if (!value) return null;
  const normalized = value.toString().replace(/,/g, '.').replace(/[^0-9.\-]/g, '').trim();
  return normalized.length ? (parseFloat(normalized) * 0.539957).toFixed(1) : null;
}

function extractByClass(html, className) {
  const regex = new RegExp(`<[^>]*class=["']?${className}["']?[^>]*>\\s*([^<]+)`, 'i');
  const match = html.match(regex);
  return match ? match[1].replace(/&deg;|&#176;|°/g, '').trim() : null;
}

function extractAirportData(html) {
  try {
    // Selectores específicos para el formato de metar-taf.com
    const tempMatch = html.match(/id="temp-val"[^>]*>([\d.-]+)/i);
    const windMatch = html.match(/id="wind-val"[^>]*>([\d.-]+)/i);
    const dirMatch = html.match(/id="wind-dir"[^>]*>([^<]+)/i);
    
    return {
      stationTime: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) + " (SAWE)",
      temperature: tempMatch ? tempMatch[1] : "--",
      feelsLike: tempMatch ? tempMatch[1] : "--",
      windSpeed: windMatch ? windMatch[1] : "0",
      windGust: "0",
      windDir: dirMatch ? dirMatch[1].trim() : "--",
      pressure: "--",
      humidity: "--",
      rain: "0.0",
      source: "Aeropuerto"
    };
  } catch (e) { return null; }
}

function parseEARGData(html) {
  let stationTime = extractByClass(html, 'lastupdate');
  return {
    stationTime: stationTime || (new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) + " hs"),
    temperature: extractByClass(html, 'outtemp'),
    feelsLike: (extractByClass(html, 'feelslike') || '').replace(/^ST:\s*/i, '').trim(),
    windSpeed: extractByClass(html, 'curwindspeed'),
    windGust: extractByClass(html, 'curwindgust'),
    windDir: extractByClass(html, 'winddir') || "--",
    pressure: extractByClass(html, 'barometer'),
    humidity: extractByClass(html, 'outHumidity'),
    rain: extractByClass(html, 'dayRain'),
    source: "EARG"
  };
}

// --- ENDPOINTS ---

app.get('/weather-view', async (req, res) => {
  let data = weatherCache.get("weather_data");
  if (data) return res.json(data);

  // 1. Intentar EARG (Principal)
  try {
    const r1 = await axios.get(SOURCE_URL, { timeout: 5000 });
    data = parseEARGData(r1.data);
    if (data.temperature && data.temperature !== "null") {
      weatherCache.set("weather_data", data);
      return res.json(data);
    }
  } catch (e) {
    console.log("EARG Offline, saltando a SAWE...");
  }

  // 2. Intentar SAWE (Aeropuerto)
  try {
    const r3 = await axios.get(AIRPORT_URL, { timeout: 6000 });
    data = extractAirportData(r3.data);
    if (data) {
      weatherCache.set("weather_data", data);
      return res.json(data);
    }
  } catch (e) {}

  res.status(502).json({ error: "Sin datos disponibles" });
});

app.get('/', async (req, res) => {
  let data = weatherCache.get("weather_data");
  if (!data) {
    try {
      const resp = await axios.get(`http://localhost:${PORT}/weather-view`);
      data = resp.data;
    } catch (e) { return res.status(502).send("Error de conexión"); }
  }

  const knots = kmhToKnots(data.windSpeed);
  const gustKnots = kmhToKnots(data.windGust);

  res.send(`
    <body style="font-family:sans-serif; background:#0f172a; color:#e2e8f0; display:flex; justify-content:center; padding:2rem 1rem;">
      <div style="background:#1e293b; padding:2rem; border-radius:1.2rem; width:100%; max-width:400px; border:1px solid #334155;">
        <h1 style="color:#7dd3fc; font-size:1.3rem; text-align:center; margin:0;">Estación Río Grande</h1>
        <p style="font-size:0.85rem; color:#94a3b8; text-align:center; border-bottom:1px solid #334155; padding-bottom:10px;">
          Fuente: ${data.source === 'Aeropuerto' ? 'SAWE (Aeropuerto)' : 'EARG (Principal)'}
        </p>
        <table style="width:100%; margin-top:1rem; border-collapse:collapse;">
          <tr><td style="padding:10px; border-bottom:1px solid #334155;">Temperatura</td><td style="text-align:right; font-weight:bold;">${data.temperature || '--'} °C</td></tr>
          <tr><td style="padding:10px; border-bottom:1px solid #334155;">Viento</td><td style="text-align:right; font-weight:bold;">${knots || '--'} kn</td></tr>
          <tr><td style="padding:10px; border-bottom:1px solid #334155;">Dirección</td><td style="text-align:right; font-weight:bold;">${data.windDirection || data.windDir || '--'}</td></tr>
          <tr><td style="padding:10px; border-bottom:1px solid #334155;">Lluvia</td><td style="text-align:right; font-weight:bold;">${data.rain || '0.0'} mm</td></tr>
        </table>
        <p style="text-align:center; font-size:0.8rem; color:#6366f1; margin-top:20px;">🕒 ${data.stationTime}</p>
      </div>
    </body>
  `);
});

// Windguru Job
setInterval(async () => {
  if (!WG_UID || !WG_PASSWORD) return;
  let d = weatherCache.get("weather_data");
  if (!d) return;
  try {
    const salt = Date.now().toString();
    const hash = md5(salt + WG_UID + WG_PASSWORD);
    const wAvg = kmhToKnots(d.windSpeed);
    const wMax = kmhToKnots(d.windGust);
    await axios.get(`http://www.windguru.cz/upload/api.php?uid=${WG_UID}&salt=${salt}&hash=${hash}&wind_avg=${wAvg}&wind_max=${wMax}&temperature=${d.temperature}`);
  } catch (e) {}
}, 120000);

app.listen(PORT);
