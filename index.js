import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const SOURCE_URL = 'http://earg_met.mooo.com:88/meteo/';
// Fuente oficial NOAA para Río Grande (SAWE)
const NOAA_URL = 'https://tgftp.nws.noaa.gov/data/observations/metar/decoded/SAWE.TXT';

const weatherCache = new NodeCache({ stdTTL: 600 });

// --- UTILIDADES ---

function kmhToKnots(value) {
    if (!value) return "--";
    const n = parseFloat(value.toString().replace(/,/g, '.').replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? "--" : (n * 0.539957).toFixed(1);
}

// --- EXTRACCIÓN DE DATOS ---

async function getWeatherData() {
    // 1. INTENTO EARG (Tu estación principal)
    try {
        const r = await axios.get(SOURCE_URL, { timeout: 4000 });
        const html = r.data;
        const tempMatch = html.match(/class=["']outtemp["'][^>]*>([^<]+)/i);
        if (tempMatch) {
            return {
                temp: tempMatch[1].trim(),
                wind: html.match(/class=["']curwindspeed["'][^>]*>([^<]+)/i)?.[1] || "0",
                dir: html.match(/class=["']winddir["'][^>]*>([^<]+)/i)?.[1] || "--",
                gust: html.match(/class=["']curwindgust["'][^>]*>([^<]+)/i)?.[1] || "0",
                source: "EARG (Principal)",
                time: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
            };
        }
    } catch (e) { console.log("EARG offline"); }

    // 2. INTENTO NOAA (Aeropuerto SAWE - Sin API Key)
    try {
        const r = await axios.get(NOAA_URL, { timeout: 5000 });
        const txt = r.data; // La NOAA devuelve un texto plano fácil de leer

        // Buscamos Temperatura (ej: Temperature: 7 Celsius)
        const tempMatch = txt.match(/Temperature:\s*([-\d.]+)\s*C/i);
        // Buscamos Viento (ej: Wind: from the W at 20 MPH)
        const windMatch = txt.match(/Wind:.*at\s*([\d.]+)\s*MPH/i);
        const dirMatch = txt.match(/Wind: from the\s*([A-Z]+)/i);

        // Convertimos MPH a KMH para que kmhToKnots funcione igual
        const windKmh = windMatch ? (parseFloat(windMatch[1]) * 1.60934).toFixed(1) : "0";

        return {
            temp: tempMatch ? tempMatch[1] : "--",
            wind: windKmh,
            dir: dirMatch ? dirMatch[1] : "--",
            gust: "0",
            source: "SAWE (Aeropuerto - NOAA)",
            time: txt.split('\n')[0] // La primera línea del TXT es la fecha/hora
        };
    } catch (e) { console.log("NOAA offline"); }

    return weatherCache.get("last_valid") || null;
}

// --- RUTAS ---

app.get('/weather-view', async (req, res) => {
    const data = await getWeatherData();
    if (data) {
        weatherCache.set("last_valid", data);
        return res.json({
            temperature: data.temp,
            windSpeed: data.wind,
            windDirection: data.dir,
            windGust: data.gust,
            stationTime: data.time
        });
    }
    res.status(502).json({ error: "Sistemas no disponibles" });
});

app.get('/', async (req, res) => {
    const d = await getWeatherData() || weatherCache.get("last_valid");
    if (!d) return res.send("Error de conexión con todas las fuentes.");

    res.send(`
        <body style="background:#0f172a; color:white; font-family:sans-serif; display:flex; justify-content:center; padding:20px;">
            <div style="background:#1e293b; padding:20px; border-radius:15px; width:300px; border:1px solid #334155;">
                <h2 style="text-align:center; color:#38bdf8;">Río Grande</h2>
                <p style="text-align:center; font-size:0.8rem; color:#94a3b8;">${d.source}</p>
                <div style="font-size:2.5rem; text-align:center; margin:20px 0;">${d.temp}°C</div>
                <div style="display:flex; justify-content:space-around; border-top:1px solid #334155; padding-top:15px;">
                    <div><span style="color:#94a3b8; display:block;">Viento</span><b>${kmhToKnots(d.wind)} kn</b></div>
                    <div><span style="color:#94a3b8; display:block;">Dir</span><b>${d.dir}</b></div>
                </div>
                <p style="text-align:center; font-size:0.7rem; color:#6366f1; margin-top:20px;">🕒 ${d.time}</p>
            </div>
        </body>
    `);
});

app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
