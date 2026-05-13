import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';

const app = express();
app.use(cors());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PRIMARY_URL = 'http://earg_met.mooo.com:88/meteo/'; 
const BACKUP_URL = 'http://earg.fcaglp.unlp.edu.ar/meteorologia/vp2s1/vantalhb.htm';

const WG_UID = process.env.WG_UID;
const WG_PASSWORD = process.env.WG_PASSWORD;

const weatherCache = new NodeCache({ stdTTL: 300 });

/**
 * BLOQUE 1: UTILIDADES DE LIMPIEZA ADAPTATIVA
 */

function toKnots(value) {
    if (!value) return "--";
    // Eliminamos el carácter extraño  y cualquier otra cosa que no sea número o decimal
    const cleanValue = value.toString().replace(/,/g, '.').replace(/[^0-9.-]/g, '');
    const num = parseFloat(cleanValue);
    return isNaN(num) ? "--" : (num * 0.539957).toFixed(1);
}

function cleanNumericString(text) {
    if (!text) return "";
    // Esta es la clave: extraemos solo los números y el separador decimal
    // ignorando símbolos de grado rotos como 
    const match = text.match(/[-+]?[0-9]*[.,]?[0-9]+/);
    return match ? match[0].replace(',', '.') : text.trim();
}

function cleanGeneralText(text) {
    if (!text) return "";
    return text
        .replace(//g, '°') // Reemplazamos el rombo de error por el símbolo de grado
        .replace(/&deg;/g, '°')
        .replace(/&nbsp;/g, ' ')
        .trim();
}

/**
 * BLOQUE 2: EXTRACCIÓN MEJORADA
 */
function extract(html, className, keywords) {
    // 1. Intento por Clase (Principal)
    const classRegex = new RegExp(`<[^>]*class=["']?${className}["']?[^>]*>\\s*([^<]+)`, 'i');
    let match = html.match(classRegex);
    if (match && match[1]) return match[1].trim();

    // 2. Intento por Palabra Clave (UNLP con manejo de )
    for (const word of keywords) {
        const tableRegex = new RegExp(`${word}[^<]*<\\/td>\\s*<td[^>]*>\\s*([^<]+)`, 'i');
        match = html.match(tableRegex);
        if (match && match[1]) return match[1].trim();
    }
    return null;
}

/**
 * BLOQUE 3: LÓGICA DE PROCESAMIENTO
 */
function parseAll(html) {
    const rawTime = extract(html, 'lastupdate', ['Hora', 'Actualiz']);
    const rawTemp = extract(html, 'outtemp', ['Temperatura Ext', 'Temp Ext']);
    const rawWind = extract(html, 'curwindspeed', ['Velocidad del Viento', 'Viento']);
    const rawGust = extract(html, 'curwindgust', ['Rafaga', 'Viento Max']);
    const rawHum = extract(html, 'outHumidity', ['Humedad Ext', 'Hum Ext']);
    const rawPress = extract(html, 'barometer', ['Barometro', 'Presion']);
    const rawRain = extract(html, 'dayRain', ['Precipitacion Diaria', 'Lluvia']);

    return {
        timestamp: cleanGeneralText(rawTime),
        temp: cleanNumericString(rawTemp),
        st: cleanNumericString(extract(html, 'feelslike', ['Sensaci', 'Termica', 'ST'])),
        wind: rawWind, 
        gust: rawGust,
        dir: cleanGeneralText(extract(html, 'winddir', ['Direcci', 'Viento del'])),
        hum: cleanNumericString(rawHum),
        press: cleanNumericString(rawPress),
        rain: cleanNumericString(rawRain)
    };
}

async function fetchReliableData() {
    let cachedData = weatherCache.get("current_weather");
    if (cachedData) return cachedData;

    try {
        console.log("Intentando Principal...");
        const res = await axios.get(PRIMARY_URL, { timeout: 8000 });
        const data = parseAll(res.data);
        if (data.temp) {
            weatherCache.set("current_weather", data);
            return data;
        }
    } catch (err) {
        console.warn("Principal caída.");
    }

    try {
        console.log("Intentando UNLP...");
        // Forzamos a axios a manejar la respuesta como arraybuffer para evitar ruidos de codificación
        const res = await axios.get(BACKUP_URL, { timeout: 10000, responseType: 'text' });
        const data = parseAll(res.data);
        if (data.temp) {
            weatherCache.set("current_weather", data);
            return data;
        }
    } catch (err) {
        console.error("Fallo total.");
    }
    return null;
}

/**
 * BLOQUE 4: INTERFAZ
 */
app.get('/weather-view', async (req, res) => {
    const d = await fetchReliableData();
    if (!d) return res.status(502).json({ error: "Offline" });
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
    const d = await fetchReliableData();
    if (!d) return res.status(502).send("Sistemas fuera de línea.");

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: sans-serif; background: #0f172a; color: white; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
                .box { background: #1e293b; padding: 30px; border-radius: 20px; width: 320px; border: 1px solid #334155; }
                h1 { font-size: 1.1rem; color: #38bdf8; text-align: center; border-bottom: 1px solid #334155; padding-bottom: 15px; }
                .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #334155; }
                .label { color: #94a3b8; }
                .footer { text-align: center; color: #6366f1; font-size: 0.7rem; margin-top: 15px; }
            </style>
        </head>
        <body>
            <div class="box">
                <h1>ESTACIÓN RÍO GRANDE</h1>
                <div class="row"><span class="label">Temperatura</span><span>${d.temp} °C</span></div>
                <div class="row"><span class="label">Sensación</span><span>${d.st || d.temp} °C</span></div>
                <div class="row"><span class="label">Viento</span><span>${toKnots(d.wind)} kn</span></div>
                <div class="row"><span class="label">Ráfaga</span><span>${toKnots(d.gust)} kn</span></div>
                <div class="row"><span class="label">Dirección</span><span>${d.dir}</span></div>
                <div class="row"><span class="label">Humedad</span><span>${d.hum} %</span></div>
                <div class="row" style="border:none;"><span class="label">Lluvia</span><span>${d.rain} mm</span></div>
                <div class="footer">Sincronizado: ${d.timestamp}</div>
            </div>
        </body>
        </html>
    `);
});

/**
 * BLOQUE 5: WINDGURU
 */
setInterval(async () => {
    if (!WG_UID) return;
    const d = await fetchReliableData();
    if (!d) return;
    try {
        const salt = Date.now().toString();
        const hash = md5(salt + WG_UID + WG_PASSWORD);
        await axios.get('http://www.windguru.cz/upload/api.php', {
            params: {
                uid: WG_UID, salt, hash, interval: 120,
                wind_avg: toKnots(d.wind),
                wind_max: toKnots(d.gust),
                temperature: d.temp
            }
        });
    } catch (e) { console.error("Windguru error"); }
}, 120000);

app.listen(PORT);
