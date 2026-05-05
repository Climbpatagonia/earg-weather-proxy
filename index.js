// 1. Actualiza la función parseWeatherData para incluir 'feelsLike'
function parseWeatherData(html) {
  const feelsLikeRaw = extractValue(html, 'feelslike');
  return {
    updatedAt: new Date().toISOString(),
    temperature: extractValue(html, 'outtemp'),
    // Limpiamos el prefijo "ST:" que suele traer la página original
    feelsLike: feelsLikeRaw ? feelsLikeRaw.replace(/^ST:\s*/i, '').trim() : null,
    windSpeed: extractValue(html, 'curwindspeed'),
    windGust: extractValue(html, 'curwindgust'),
    windDir: extractValue(html, 'curwinddir'),
    pressure: extractValue(html, 'barometer'),
    humidity: extractValue(html, 'outHumidity'),
    rain: extractValue(html, 'dayRain'),
  };
}

// 2. Actualiza la ruta principal (app.get('/')) para mostrar la fila en la tabla
app.get('/', async (req, res) => {
  try {
    const cacheKey = "html_view";
    let data = weatherCache.get(cacheKey);

    if (!data) {
      const response = await axios.get(SOURCE_URL, { timeout: 8000 });
      data = parseWeatherData(response.data);
      weatherCache.set(cacheKey, data);
    }

    const knots = kmhToKnots(data.windSpeed);
    const gustKnots = kmhToKnots(data.windGust);

    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>EARG - Clima</title>
        <style>
          body { font-family: sans-serif; background: #0f172a; color: #e2e8f0; display: flex; justify-content: center; padding: 2rem; }
          .card { background: #1e293b; padding: 2rem; border-radius: 1rem; width: 100%; max-width: 400px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
          h1 { color: #7dd3fc; font-size: 1.2rem; margin-bottom: 0.5rem; text-align: center; }
          .subtitle { font-size: 0.8rem; color: #64748b; text-align: center; margin-bottom: 1.5rem; }
          table { width: 100%; border-collapse: collapse; }
          td { padding: 10px; border-bottom: 1px solid #334155; }
          .label { color: #94a3b8; }
          .value { text-align: right; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Estación Río Grande</h1>
          <p class="subtitle">Datos en tiempo real (Proxy HTTPS)</p>
          <table>
            <tr><td class="label">Temperatura</td><td class="value">${data.temperature || '--'} °C</td></tr>
            <tr><td class="label">Sensación térmica</td><td class="value">${data.feelsLike || '--'} °C</td></tr>
            <tr><td class="label">Viento</td><td class="value">${knots || '--'} kn</td></tr>
            <tr><td class="label">Ráfaga</td><td class="value">${gustKnots || '--'} kn</td></tr>
            <tr><td class="label">Dirección</td><td class="value">${data.windDir || '--'}</td></tr>
            <tr><td class="label">Humedad</td><td class="value">${data.humidity || '--'}</td></tr>
            <tr><td class="label">Presión</td><td class="value">${data.pressure || '--'}</td></tr>
          </table>
          <p style="font-size: 0.7rem; color: #475569; margin-top: 1rem; text-align: center;">Actualizado: ${new Date(data.updatedAt).toLocaleTimeString('es-AR')}</p>
        </div>
      </body>
      </html>
    `);
  } catch (e) {
    res.status(502).send("Error conectando con la estación local.");
  }
});
