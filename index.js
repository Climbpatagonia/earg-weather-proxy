import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';
// IMPORTAMOS EL KEEPALIVE
import { startKeepAlive } from './keepalive.js';

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const SOURCE_URL = 'http://earg_met.mooo.com:88/meteo/';
const NOAA_RAW_URL = 'https://tgftp.nws.noaa.gov/data/observations/metar/stations/SAWE.TXT';
const SELF_URL = 'https://earg-weather-proxy.onrender.com/'; 

const WG_UID = process.env.WG_UID;
const WG_PASSWORD = process.env.WG_PASSWORD;
const weatherCache = new NodeCache({ stdTTL: 600 });

// --- UTILIDADES ---
function getLocalTime() {
    return new Date().toLocaleString("es-AR", {
        timeZone: "America/Argentina/Rio_Gallegos",
        hour: '2-digit', minute: '2-digit'
    }) + " hs";
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
        let t = "--";
        if (tempMatch) t = parseInt(tempMatch[1].replace('M', '-')).toString();
        const windMatch = metar.match(/(\d{3})(\d{2})(?:G(\d{2}))?KT/);
        let w = "0", g = "0", d = "--";
        if (windMatch) {
            d = windMatch[1] + "°";
            w = (parseInt(windMatch[2]) * 1.852).toFixed(1);
            if (windMatch[3]) g = (parseInt(windMatch[3]) * 1.852).toFixed(1);
        }
        return { temp: t, wind: w, gust: g, dir: d };
    } catch (e) { return null; }
}

async function getWeatherData() {
    try {
        const r = await axios.get(SOURCE_URL, { timeout: 5000 });
        const html = r.data;
        if (html.includes('outtemp')) {
            const data = {
                stationTime: extractByClass(html, 'lastupdate') || getLocalTime(),
                temperature: extractByClass(html, 'outtemp'),
                feelsLike: (extractByClass(html, 'feelslike') || '').replace(/^ST:\s*/i, '').trim(),
                windSpeed: extractByClass(html, 'curwindspeed'),
                windGust: extractByClass(html, 'curwindgust'),
                windDir: extractByClass(html, 'winddir') || "--",
                pressure: extractByClass(html, 'barometer'),
                humidity: extractByClass(html, 'outHumidity'),
                rain: extractByClass(html, 'dayRain'),
                source: "EARG (Principal)"
            };
            weatherCache.set("last_valid", data);
            return data;
        }
    } catch (e) {}
    // Intento NOAA/SAWE... (aquí iría el resto de la lógica de backup)
    return weatherCache.get("last_valid") || null;
}

// --- RUTAS ---
app.get('/weather-view', async (req, res) => {
    const data = await getWeatherData();
    data ? res.json(data) : res.status(502).json({ error: "Offline" });
});

app.get('/', async (req, res) => {
    const data = await getWeatherData();
    if (!data) return res.status(502).send("Error de conexión");
    const k = kmhToKnots(data.windSpeed);
    const gk = kmhToKnots(data.windGust);
    res.send(`
        <body style="background:#0f172a;color:#e2e8f0;font-family:sans-serif;display:flex;justify-content:center;padding:20px;">
            <div style="background:#1e293b;padding:20px;border-radius:15px;width:300px;text-align:center;border:1px solid #334155;">
                <h2 style="color:#7dd3fc;margin:0;">Estación Río Grande</h2>
                <p style="color:#94a3b8;font-size:0.8rem;">Fuente: ${data.source}</p>
                <div style="font-size:1.2rem;font-weight:bold;margin:15px 0;">${k || '--'} kn | ${data.temperature || '--'}°C</div>
                <p style="font-size:0.7rem;color:#6366f1;">🕒 ${data.stationTime}</p>
            </div>
        </body>
    `);
});

// --- WINDGURU JOB ---
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
        const wgUrl = "http://www.windguru.cz/upload/api.php?uid=" + WG_UID + "&salt=" + salt + "&hash=" + hash + "&wind_avg=" + wAvg + "&wind_max=" + wMax + "&temperature=" + temp;
        await axios.get(wgUrl);
    } catch (e) {}
}, 120000);

// --- INICIO DEL SERVIDOR ---
app.listen(PORT, () => {
    console.log("Servidor corriendo en puerto " + PORT);
    // LLAMAMOS AL KEEPALIVE DESDE EL OTRO ARCHIVO
    startKeepAlive(SELF_URL, SOURCE_URL);
});
