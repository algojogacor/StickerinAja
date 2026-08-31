async function fetchKbbi(word) {
    const url = `https://kbbi.raf555.dev/api/v1/entry/${encodeURIComponent(word)}`;
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
    });
    if (!res.ok) {
        return null;
    }
    return res.json();
}

function formatKbbi(data, queryWord) {
    if (!data || !data.lemma || !Array.isArray(data.entries) || data.entries.length === 0) {
        return `❌ Kata "${queryWord}" tidak ditemukan di KBBI.`;
    }

    let out = `📖 *${data.lemma}*\n\n`;
    const allDerived = [];

    data.entries.forEach((entryObj) => {
        const entryName = entryObj.entry || data.lemma;

        // Ambil label yang kind === "Kelas Kata", tampilkan code-nya dalam kurung
        const entryClasses = new Set();
        (entryObj.definitions || []).forEach(def => {
            (def.labels || []).forEach(l => {
                if (l.kind === 'Kelas Kata' && l.code) {
                    entryClasses.add(l.code);
                }
            });
        });

        const classLabel = entryClasses.size > 0 ? ` (${Array.from(entryClasses).join(', ')})` : '';
        out += `*${entryName}*${classLabel}\n`;

        // Loop definisi
        (entryObj.definitions || []).forEach((def, idx) => {
            const num = idx + 1;
            out += `${num}. ${def.definition}\n`;

            if (Array.isArray(def.usageExamples) && def.usageExamples.length > 0) {
                def.usageExamples.forEach(ex => {
                    const replaced = ex.replace(/~|--/g, queryWord);
                    out += `    📝 _${replaced}_\n`;
                });
            }
        });

        out += `\n`;

        if (Array.isArray(entryObj.derivedWords) && entryObj.derivedWords.length > 0) {
            entryObj.derivedWords.forEach(dw => {
                if (!allDerived.includes(dw)) allDerived.push(dw);
            });
        }
    });

    if (allDerived.length > 0) {
        out += `📌 *Kata turunan:* ${allDerived.join(', ')}\n`;
    }

    return out.trim();
}

function normalizeParams(sockOrOpts, msg, args, ctx) {
    if (sockOrOpts && sockOrOpts.sock) {
        return {
            sock: sockOrOpts.sock,
            msg: sockOrOpts.msg,
            args: sockOrOpts.args || [],
            cmdName: sockOrOpts.cmdName,
            remoteJid: sockOrOpts.remoteJid || sockOrOpts.msg?.key?.remoteJid,
            logger: sockOrOpts.logger
        };
    }
    return {
        sock: sockOrOpts,
        msg,
        args: args || [],
        cmdName: args?._command || 'kbbi',
        remoteJid: msg?.key?.remoteJid,
        logger: ctx?.logger
    };
}

module.exports = {
    names: ['kbbi', 'kamus', 'artikata', 'arti'],
    fetchKbbi,
    formatKbbi,
    execute: async (sockOrOpts, rawMsg, rawArgs, ctx) => {
        const { sock, msg, args, remoteJid, logger } = normalizeParams(sockOrOpts, rawMsg, rawArgs, ctx);
        const query = args.join(' ').trim().toLowerCase();

        if (!query) {
            return sock.sendMessage(remoteJid, {
                text: `📖 *KAMUS BESAR BAHASA INDONESIA (KBBI)*\n\n` +
                      `Cari definisi dan arti kata resmi sesuai KBBI daring!\n\n` +
                      `📌 *Format:* \`!kbbi <kata>\`\n` +
                      `💡 *Contoh:* \`!kbbi cinta\` atau \`!kbbi algojo\``
            }, { quoted: msg });
        }

        try {
            const data = await fetchKbbi(query);
            if (!data) {
                return sock.sendMessage(remoteJid, {
                    text: `❌ Kata "${query}" tidak ditemukan di KBBI.`
                }, { quoted: msg });
            }

            const formatted = formatKbbi(data, query);
            return sock.sendMessage(remoteJid, {
                text: formatted
            }, { quoted: msg });

        } catch (err) {
            logger?.error?.({ err, query }, '[KBBI] Error fetching word');
            return sock.sendMessage(remoteJid, {
                text: `❌ Kata "${query}" tidak ditemukan di KBBI.`
            }, { quoted: msg });
        }
    }
};
