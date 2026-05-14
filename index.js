import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const SOURCE_URL = 'http://earg_met.mooo.com:88/meteo/';
const NOAA_RAW_URL = 'https://tgftp.nws.noaa.gov/data/observations/metar/stations/SAWE.TXT';

const WG_UID = process.env.WG_UID;
const WG_PASSWORD = process.env.WG_PASSWORD;

const weatherCache = new NodeCache({ stdTTL: 600 });

// --- UTILIDADES ---

function getWindDirection(deg) {
    if (typeof deg === 'string' && isNaN(parseInt(deg))) return deg;
    const d = parseInt(deg);
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return directions[Math.round(((d %= 360) < 0 ? d + 360 : d) / 22.5) % 16];
}

function calculateWindChill(tempC, windKmh) {
    if (tempC > 10 || windKmh < 4.8) return tempC.toFixed(1);
    // Fórmula oficial de Wind Chill
    const chill = 13.12 + 0.6215 * tempC - 11.37 * Math.pow(windKmh, 0.16) + 0.3965 * tempC * Math.pow(windKmh, 0.16);
    return chill.toFixed(1);
}

function kmhToKnots(value) {
    if (!value || value === "--") return null;
    const normalized = value.toString().replace(/,/g, '.').replace(/[^0-9.\-]/g, '').trim();
    return normalized.length ? (parseFloat(normalized) * 0.539957).toFixed(1) : null;
}

function extractByClass(html, className) {
    const regex = new RegExp(`<[^>]*class=["']?${className}["']?[^>]*>\\s*([^<]+)`, 'i');
    const match = html.match(regex);
    return match ? match[1].replace(/&deg;|&#176;|°/g, '').trim() : null;
}

function decodeMetar(metar) {
    try {
        const tempMatch = metar.match(/(?:\s|)(M?\d{2})\/(M?\d{2})(?:\s|)/);
        let temp = 0;
        if (tempMatch) {
            let t = tempMatch[1].replace('M', '-');
            temp = parseInt(t);
        }
        const windMatch = metar.match(/(\d{3})(\d{2})(?:G(\d{2}))?KT/);
        let wind = 0, gust = 0, dirDeg = 0;
        if (windMatch) {
            dirDeg = parseInt(windMatch[1]);
            wind = parseFloat((parseInt(windMatch[2]) * 1.852).toFixed(1));
            if (windMatch[3]) gust = parseFloat((parseInt(windMatch[3]) * 1.852).toFixed(1));
        }
        return { 
            temp: temp.toString(), 
            wind: wind.toString(), 
            gust: gust.toString(), 
            dir: getWindDirection(dirDeg),
            feelsLike: calculateWindChill(temp, wind)
        };
    } catch (e) { return null; }
}

async function getWeatherData() {
    try {
        const r = await axios.get(SOURCE_URL, { timeout: 4500 });
        const html = r.data;
        if (html.includes('outtemp')) {
            return {
                stationTime: extractByClass(html, 'lastupdate') || (new Date().toLocaleTimeString('es-AR') + " hs"),
                temperature: extractByClass(html, 'outtemp'),
                feelsLike: (extractByClass(html, 'feelslike') || '').replace(/^ST:\s*/i, '').trim(),
                windSpeed: extractByClass(html, 'curwindspeed'),
                windGust: extractByClass(html, 'curwindgust'),
                windDir: extractByClass(html, 'winddir') || extractByClass(html, 'curwinddir') || "--",
                pressure: extractByClass(html, 'barometer'),
                humidity: extractByClass(html, 'outHumidity'),
                rain: extractByClass(html, 'dayRain'),
                source: "EARG (Principal)"
            };
        }
    } catch (e) {}

    try {
        const r = await axios.get(NOAA_RAW_URL, { timeout: 4000 });
        const lines = r.data.split('\n');
        const decoded = decodeMetar(lines[1]);
        if (decoded) {
            return {
                stationTime: lines[0] + " (SAWE)",
                temperature: decoded.temp,
                feelsLike: decoded.feelsLike,
                windSpeed: decoded.wind,
                windGust: decoded.gust,
                windDir: decoded.dir,
                pressure: "--",
                humidity: "--",
                rain: "0.0",
                source: "SAWE (Aeropuerto)"
            };
        }
    } catch (e) {}

    return weatherCache.get("last_valid") || null;
}

// --- RUTAS Y SERVIDOR (IGUAL QUE EL ORIGINAL) ---

app.get('/weather-view', async (req, res) => {
    const data = await getWeatherData();
    if (data) { weatherCache.set("last_valid", data); return res.json(data); }
    res.status(502).json({ error: "Offline" });
});

app.get('/', async (req, res) => {
    const data = await getWeatherData() || weatherCache.get("last_valid");
    if (!data) return res.status(502).send("Error");

    const knots = kmhToKnots(data.windSpeed);
    const gustKnots = kmhToKnots(data.windGust);

    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="300">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: sans-serif; background: #0f172a; color: #e2e8f0; display: flex; justify-content: center; padding: 2rem 1rem; }
          .card { background: #1e293b; padding: 2rem; border-radius: 1.2rem; width: 100%; max-width: 400px; border: 1px solid #334155; }
          h1 { color: #7dd3fc; font-size: 1.3rem; margin: 0; text-align: center; }
          .subtitle { font-size: 0.85rem; color: #94a3b8; text-align: center; margin-bottom: 0.5rem; padding-bottom: 1rem; border-bottom: 1px solid #334155; }
          table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
          td { padding: 10px 8px; border-bottom: 1px solid #334155; }
          .label { color: #94a3b8; }
          .value { text-align: right; font-weight: 700; color: #f1f5f9; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Estación Río Grande</h1>
          <p class="subtitle">Fuente: ${data.source}</p>
          <table>
            <tr><td class="label">Temperatura</td><td class="value">${data.temperature || '--'} °C</td></tr>
            <tr><td class="label">Sensación térmica</td><td class="value">${data.feelsLike || '--'} °C</td></tr>
            <tr><td class="label">Viento</td><td class="value">${knots || '--'} kn</td></tr>
            <tr><td class="label">Ráfaga</td><td class="value">${gustKnots || '--'} kn</td></tr>
            <tr><td class="label">Dirección</td><td class="value">${data.windDir || '--'}</td></tr>
            <tr><td class="label">Presión</td><td class="value">${data.pressure || '--'} hPa</td></tr>
            <tr><td class="label">Humedad</td><td class="value">${data.humidity || '--'} %</td></tr>
            <tr><td class="label">Lluvia día</td><td class="value">${data.rain || '--'} mm</td></tr>
          </table>
          <p style="text-align:center; font-size:0.8rem; color:#6366f1; margin-top:20px;">🕒 ${data.stationTime}</p>
        </div>
      </body>
      </html>
    `);
});

setInterval(async () => {
    if (!WG_UID || !WG_PASSWORD) return;
    const d = weatherCache.get("last_valid");
    if (!d) return;
    try {
        const salt = Date.now().toString();
        const hash = md5(salt + WG_UID + WG_PASSWORD);
        const wAvg = kmhToKnots(d.windSpeed) || 0;
        const wMax = kmhToKnots(d.windGust) || 0;
        const temp = (d.temperature || '').toString().replace(/[^0-9.-]/g, '');
        await axios.get(`http://www.windguru.cz/upload/api.php?uid=${WG_UID}&salt=${salt}&hash=${hash}&wind_avg=${wAvg}&wind_max=${wMax}&temperature=${temp}`);
    } catch (e) {}
}, 120000);

app.listen(PORT);
