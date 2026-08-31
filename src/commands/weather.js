async function getWeather(city) {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
}

function translateCondition(desc) {
    const map = {
        'clear': 'Cerah ☀️',
        'sunny': 'Cerah Terang ☀️',
        'partly cloudy': 'Cerah Berawan ⛅',
        'cloudy': 'Berawan ☁️',
        'overcast': 'Mendung Tebal ☁️',
        'patchy rain nearby': 'Hujan Ringan Setempat 🌦️',
        'patchy rain possible': 'Berpotensi Hujan Ringan 🌦️',
        'light rain': 'Hujan Ringan 🌧️',
        'moderate rain': 'Hujan Sedang 🌧️',
        'heavy rain': 'Hujan Lebat ⛈️',
        'thunderstorm': 'Badai Petir ⚡⛈️',
        'mist': 'Berkabut / Halimun 🌫️',
        'fog': 'Kabut Tebal 🌫️',
        'haze': 'Udara Kabur (Haze) 🌫️'
    };
    const key = String(desc || '').toLowerCase().trim();
    return map[key] || `${desc} 🌤️`;
}

module.exports = {
    names: ['cuaca', 'weather', 'prakiraan'],
    execute: async (sock, msg, args, ctx) => {
        const remoteJid = msg.key?.remoteJid;
        const city = args.join(' ').trim();

        if (!city) {
            return sock.sendMessage(remoteJid, {
                text: `🌦️ *INFO CUACA REALTIME*\n\n` +
                      `Cek suhu dan prakiraan cuaca di kota manapun di dunia!\n\n` +
                      `📌 *Format:* \`!cuaca <nama kota>\`\n\n` +
                      `💡 *Contoh:*\n` +
                      `• \`!cuaca Jakarta\`\n` +
                      `• \`!cuaca Surabaya\`\n` +
                      `• \`!cuaca Bandung\`\n` +
                      `• \`!cuaca Tokyo\``
            }, { quoted: msg });
        }

        try {
            const data = await getWeather(city);
            const current = data.current_condition?.[0];
            const area = data.nearest_area?.[0];

            if (!current || !area) {
                throw new Error('Data cuaca tidak ditemukan');
            }

            const areaName = area.areaName?.[0]?.value || city;
            const region = area.region?.[0]?.value || '';
            const country = area.country?.[0]?.value || '';
            const condition = translateCondition(current.weatherDesc?.[0]?.value);
            const temp = current.temp_C;
            const feelsLike = current.FeelsLikeC;
            const humidity = current.humidity;
            const wind = current.windspeedKmph;
            const uvIndex = current.uvIndex;

            // Forecast tomorrow if available
            const tomorrow = data.weather?.[1];
            let forecastText = '';
            if (tomorrow) {
                const maxTemp = tomorrow.maxtempC;
                const minTemp = tomorrow.mintempC;
                const tomDesc = translateCondition(tomorrow.hourly?.[4]?.weatherDesc?.[0]?.value);
                forecastText = `\n📅 *Prakiraan Besok:* ${minTemp}°C - ${maxTemp}°C (${tomDesc})`;
            }

            const message = `🌦️ *PRAKIRAAN CUACA: ${areaName.toUpperCase()}*\n\n` +
                            `📍 *Lokasi:* ${areaName}, ${region} (${country})\n` +
                            `🌤️ *Kondisi:* ${condition}\n` +
                            `🌡️ *Suhu:* *${temp}°C* (Terasa seperti ${feelsLike}°C)\n` +
                            `💧 *Kelembapan:* ${humidity}%\n` +
                            `💨 *Angin:* ${wind} km/jam\n` +
                            `☀️ *Indeks UV:* ${uvIndex}\n` +
                            forecastText + `\n\n` +
                            `_Data akurat & realtime via wttr.in_`;

            return sock.sendMessage(remoteJid, { text: message }, { quoted: msg });
        } catch (error) {
            ctx?.logger?.error({ err: error, city }, '[Weather] Error fetching weather');
            return sock.sendMessage(remoteJid, {
                text: `❌ *Gagal Mendapatkan Info Cuaca*\n\nKota \`${city}\` tidak ditemukan atau server cuaca sedang sibuk.`
            }, { quoted: msg });
        }
    }
};
