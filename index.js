import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';

/**
 * CONFIGURACIÓN DE PARÁMETROS
 * Ajusta aquí las URLs y credenciales
 */
const app = express();
app.use(cors());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PRIMARY_URL = 'http://earg_met.mooo.com:88/meteo/'; 
const BACKUP_URL = 'http://earg.fcaglp.unlp.edu.ar/meteorologia/vp2s1/vantalhb.htm';

const WG_UID = process.env.WG_UID;
const WG_PASSWORD = process.env.WG_PASSWORD;

// Cache de 5 minutos para no saturar las estaciones
const weatherCache = new NodeCache({ stdTTL: 300 });

/**
 * BLOQUE 1: UTILIDADES DE PROCESAMIENTO
 */

// Convierte Km/h a Nudos (Knots) de forma segura
function toKnots(value) {
    if (!value) return "--";
    // Limpiamos todo lo que no sea número, punto o coma
    const cleanValue = value.toString().replace(/,/g, '.').replace(/[^0-9.-]/g, '');
    const num = parseFloat(cleanValue);
    return isNaN(num) ? "--" : (num * 0.539957).toFixed(1);
}

// Limpiador de texto para evitar errores de codificación (acentos y grados)
function cleanText(text) {
    if (!text) return "";
    return text
        .replace(/&deg;/g, '°')
        .replace(/&#176;/g, '°')
        .replace(/&nbsp;/g, ' ')
        .replace(/&oacute;/g, 'o')
        .replace(/&aacute;/g, 'a')
        .replace(/&eacute;/g, 'e')
        .replace(/&iacute;/g, 'i')
        .replace(/&uacute;/g, 'u')
        .replace(/&ntilde;/g, 'ñ')
        .trim();
}

/**
 * BLOQUE 2: EL "EXTRACTOR" (SCRAPER)
 * Busca datos ya sea por Clase CSS o por posición en tablas (UNLP)
 */
function extract(html, className, keywords) {
    // 1. Intento por Clase (Estación Principal)
    const classRegex = new RegExp(`<[^>]*class=["']?${className}["']?[^>]*>\\s*([^<]+)`, 'i');
    let match = html.match(classRegex);
    if (match && match[1]) return cleanText(match[1]);

    // 2. Intento por Palabra Clave (Respaldo UNLP / Tablas)
    for (const word of keywords) {
        // Busca el texto de la etiqueta y captura lo que hay en el siguiente TD
        const tableRegex = new RegExp(`${word}[^<]*<\\/td>\\s*<td[^>]*>\\s*([^<]+)`, 'i');
        match = html.match(tableRegex);
        if (match && match[1]) return cleanText(match[1]);
    }
    return null;
}

/**
 * BLOQUE 3: LÓGICA DE DATOS Y REDUNDANCIA
 */

function parseAll(html) {
    return {
        timestamp: extract(html, 'lastupdate', ['Hora', 'Actualiz']),
        temp: extract(html, 'outtemp', ['Temperatura Ext', 'Temp Ext']),
        st: extract(html, 'feelslike', ['Sensaci', 'Termica', 'ST']),
        wind: extract(html, 'curwindspeed', ['Velocidad del Viento', 'Viento']),
        gust: extract(html, 'curwindgust', ['Rafaga', 'Viento Max']),
        dir: extract(html, 'winddir', ['Direcci', 'Viento del']),
        hum: extract(html, 'outHumidity', ['Humedad Ext', 'Hum Ext']),
        press: extract(html, 'barometer', ['Barometro', 'Presion']),
        rain: extract(html, 'dayRain', ['Precipitacion Diaria', 'Lluvia'])
    };
}

async function fetchReliableData() {
    let cachedData = weatherCache.get("current_weather");
    if (cachedData) return cachedData;

    console.log("--- Iniciando ciclo de obtención de datos ---");

    // Intento A: Estación Principal
    try {
        console.log("Intentando Estación Principal (mooo.com)...");
        const res = await axios.get(PRIMARY_URL, { timeout: 8000 });
        const data = parseAll(res.data);
        
        if (data.temp && data.temp !== "") {
            console.log("✅ Datos obtenidos de Principal");
            weatherCache.set("current_weather", data);
            return data;
        }
    } catch (err) {
        console.warn("⚠️ Principal fuera de servicio o lenta.");
    }

    // Intento B: Estación UNLP (Respaldo)
    try {
        console.log("Intentando Estación UNLP (Respaldo)...");
        const res = await axios.get(BACKUP_URL, { timeout: 10000 });
        const data = parseAll(res.data);
        
        if (data.temp) {
            console.log("✅ Datos obtenidos de UNLP");
            weatherCache.set("current_weather", data);
            return data;
        }
    } catch (err) {
        console.error("❌ Error crítico: Ambas estaciones offline.");
    }

    return null;
}

/**
 * BLOQUE 4: ENDPOINTS (INTERFAZ)
 */

// Para el Reloj Garmin
app.get('/weather-view', async (req, res) => {
    const d = await fetchReliableData();
    if (!d) return res.status(502).json({ status: "error", message: "No data available" });

    res.json({
        temp: d.temp,
        st: d.st,
        windKnots: toKnots(d.wind),
        gustKnots: toKnots(d.gust),
        direction: d.dir,
        time: d.timestamp
    });
});

// Para visualización Web (Render)
app.get('/', async (req, res) => {
    const d = await fetchReliableData();
    if (!d) return res.status(502).send("Sistemas meteorológicos de Río Grande temporalmente fuera de línea.");

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Meteo Río Grande</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: white; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
                .box { background: #1e293b; padding: 30px; border-radius: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.3); width: 320px; border: 1px solid #334155; }
                h1 { font-size: 1.2rem; color: #38bdf8; text-align: center; margin-bottom: 20px; text-transform: uppercase; letter-spacing: 1px; }
                .row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #334155; }
                .label { color: #94a3b8; font-size: 0.9rem; }
                .val { font-weight: bold; color: #f1f5f9; }
                .footer { text-align: center; color: #6366f1; font-size: 0.75rem; margin-top: 20px; font-weight: 500; }
            </style>
        </head>
        <body>
            <div class="box">
                <h1>Río Grande Meteo</h1>
                <div class="row"><span class="label">Temperatura</span><span class="val">${d.temp} °C</span></div>
                <div class="row"><span class="label">S. Térmica</span><span class="val">${d.st || d.temp} °C</span></div>
                <div class="row"><span class="label">Viento</span><span class="val">${toKnots(d.wind)} kn</span></div>
                <div class="row"><span class="label">Ráfaga</span><span class="val">${toKnots(d.gust)} kn</span></div>
                <div class="row"><span class="label">Dirección</span><span class="val">${d.dir}</span></div>
                <div class="row"><span class="label">Humedad</span><span class="val">${d.hum} %</span></div>
                <div class="row"><span class="label">Presión</span><span class="val">${d.press} hPa</span></div>
                <div class="row" style="border:none;"><span class="label">Lluvia</span><span class="val">${d.rain} mm</span></div>
                <div class="footer">Actualizado: ${d.timestamp}</div>
            </div>
        </body>
        </html>
    `);
});

/**
 * BLOQUE 5: TAREAS AUTOMÁTICAS (WINDGURU)
 */
setInterval(async () => {
    if (!WG_UID || !WG_PASSWORD) return;
    
    const d = await fetchReliableData();
    if (!d) return;

    try {
        const salt = Date.now().toString();
        const hash = md5(salt + WG_UID + WG_PASSWORD);
        const params = {
            uid: WG_UID,
            salt: salt,
            hash: hash,
            interval: 120,
            wind_avg: toKnots(d.wind),
            wind_max: toKnots(d.gust),
            temperature: d.temp.replace(/[^0-9.-]/g, '')
        };

        await axios.get('http://www.windguru.cz/upload/api.php', { params });
        console.log("📤 Datos enviados a Windguru exitosamente");
    } catch (e) {
        console.error("❌ Error al subir a Windguru:", e.message);
    }
}, 120000); // Cada 2 minutos

app.listen(PORT, () => {
    console.log(`✅ Servidor iniciado en puerto ${PORT}`);
    console.log(`🔗 Monitoreo activo para Windguru ID: ${WG_UID}`);
});
