import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const SOURCE_URL = 'http://earg_met.mooo.com:88/meteo/';
// Usamos el archivo de datos crudos de la NOAA, que es más confiable
const NOAA_RAW_URL = 'https://tgftp.nws.noaa.gov/data/observations/metar/stations/SAWE.TXT';

const WG_UID = process.env.WG_UID;
const WG_PASSWORD = process.env.WG_PASSWORD;

const weatherCache = new NodeCache({ stdTTL: 600 });

// --- DECODIFICADOR METAR CRUDO ---
function decodeMetar(metar) {
    try {
        // Buscar temperatura y rocío (ej: 08/02 o M02/M05)
        // El formato es [Temp]/[Dew], M significa negativo
        const tempMatch = metar.match(/(?:\s|)(M?\d{2})\/(M?\d{2})(?:\s|)/);
        let temp = "--";
        if (tempMatch) {
            temp = tempMatch[1].replace('M', '-');
            temp = parseInt(temp).toString(); // Quita ceros a la izquierda
        }

        // Buscar Viento (ej: 27015G25KT -> Dir 270, Vel 15, Ráfaga 25)
        const windMatch = metar.match(/(\d{3})(\d{2})(?:G(\d{2}))?KT/);
        let wind = "0", gust = "0", dir = "--";
        if (windMatch) {
            dir = windMatch[1] + "°";
            wind = (parseInt(windMatch[2]) * 1.852).toFixed(1); // Nudos a KMH para el conversor
            if (windMatch[3]) {
                gust = (parseInt(windMatch[3]) * 1.852).toFixed(1);
            }
        }

        return { temp, wind, gust, dir };
    } catch (e) { return null; }
}

async function getWeatherData() {
    // 1. INTENTO EARG
    try {
        const r = await axios.get(SOURCE_URL, { timeout: 4000 });
        const html = r.data;
        const extract = (cls) => {
            const m = html.match(new RegExp(`class=["']?${cls}["']?[^>]*>\\s*([^<]+)`, 'i'));
            return m ? m[1].replace(/&deg;|°/g, '').trim() : null;
        };

        if (html.includes('outtemp')) {
            return {
                stationTime: extract('lastupdate') || "Sinc. EARG",
                temperature: extract('outtemp'),
                feelsLike: (extract('feelslike') || '').replace(/^ST:\s*/i, '').trim(),
                windSpeed: extract('curwindspeed'),
                windGust: extract('curwindgust'),
                windDir: extract('winddir') || "--",
                pressure: extract('barometer'),
                humidity: extract('outHumidity'),
                rain: extract('dayRain'),
                source: "EARG (Principal)"
            };
        }
    } catch (e) {}

    // 2. INTENTO NOAA CRUDO (SAWE)
    try {
        const r = await axios.get(NOAA_RAW_URL, { timeout: 4000 });
        const lines = r.data.split('\n');
        const metarLine = lines[1]; // La segunda línea tiene el METAR
        const decoded = decodeMetar(metarLine);

        if (decoded) {
            return {
                stationTime: lines[0] + " (SAWE)",
                temperature: decoded.temp,
                feelsLike: decoded.temp,
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

// ... (El resto de las rutas / y /weather-view se mantienen igual al anterior) ...

function kmhToKnots(value) {
    if (!value || value === "--") return null;
    const n = parseFloat(value.toString().replace(/,/g, '.').replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? null : (n * 0.539957).toFixed(1);
}

app.get('/weather-view', async (req, res) => {
    const data = await getWeatherData();
    if (data) { weatherCache.set("last_valid", data); return res.json(data); }
    res.status(502).json({ error: "Offline" });
});

app.get('/', async (req, res) => {
    const data = await getWeatherData() || weatherCache.get("last_valid");
    if (!data) return res.send("Error");
    
    const knots = kmhToKnots(data.windSpeed);
    const gustKnots = kmhToKnots(data.windGust);

    res.send(`
      <body style="font-family:sans-serif; background:#0f172a; color:#e2e8f0; display:flex; justify-content:center; padding:2rem 1rem;">
        <div style="background:#1e293b; padding:2rem; border-radius:1.2rem; width:100%; max-width:400px; border:1px solid #334155;">
          <h1 style="color:#7dd3fc; font-size:1.3rem; margin:0; text-align:center;">Estación Río Grande</h1>
          <p style="font-size:0.85rem; color:#94a3b8; text-align:center; border-bottom:1px solid #334155; padding-bottom:10px;">Fuente: ${data.source}</p>
          <table style="width:100%; border-collapse:collapse; margin-top:1rem;">
            <tr><td style="padding:10px; border-bottom:1px solid #334155; color:#94a3b8;">Temperatura</td><td style="text-align:right; font-weight:700;">${data.temperature || '--'} °C</td></tr>
            <tr><td style="padding:10px; border-bottom:1px solid #334155; color:#94a3b8;">Viento</td><td style="text-align:right; font-weight:700;">${knots || '--'} kn</td></tr>
            <tr><td style="padding:10px; border-bottom:1px solid #334155; color:#94a3b8;">Ráfaga</td><td style="text-align:right; font-weight:700;">${gustKnots || '--'} kn</td></tr>
            <tr><td style="padding:10px; border-bottom:1px solid #334155; color:#94a3b8;">Dirección</td><td style="text-align:right; font-weight:700;">${data.windDir || '--'}</td></tr>
          </table>
          <p style="text-align:center; font-size:0.8rem; color:#6366f1; margin-top:20px;">🕒 ${data.stationTime}</p>
        </div>
      </body>
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
