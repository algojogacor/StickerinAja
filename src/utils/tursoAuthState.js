const { createClient } = require('@libsql/client');
const { BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');

const TABLE_NAME = 'baileys_auth_state';

function createTursoClientFromEnv() {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (!url) return null;

    return createClient({
        url,
        authToken
    });
}

function fixKeyName(key) {
    return key?.replace(/\//g, '__')?.replace(/:/g, '-');
}

async function useTursoAuthState({ logger, sessionId = process.env.TURSO_AUTH_SESSION_ID || 'default' } = {}) {
    const client = createTursoClientFromEnv();
    if (!client) return null;

    await client.execute(`
        CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
            session_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (session_id, key)
        )
    `);

    const readData = async (key) => {
        const fixedKey = fixKeyName(key);
        const result = await client.execute({
            sql: `SELECT value FROM ${TABLE_NAME} WHERE session_id = ? AND key = ? LIMIT 1`,
            args: [sessionId, fixedKey]
        });

        const row = result.rows[0];
        if (!row?.value) return null;
        return JSON.parse(row.value, BufferJSON.reviver);
    };

    const writeData = async (data, key) => {
        const fixedKey = fixKeyName(key);
        const value = JSON.stringify(data, BufferJSON.replacer);
        await client.execute({
            sql: `
                INSERT INTO ${TABLE_NAME} (session_id, key, value, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(session_id, key)
                DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
            `,
            args: [sessionId, fixedKey, value]
        });
    };

    const removeData = async (key) => {
        const fixedKey = fixKeyName(key);
        await client.execute({
            sql: `DELETE FROM ${TABLE_NAME} WHERE session_id = ? AND key = ?`,
            args: [sessionId, fixedKey]
        });
    };

    const creds = (await readData('creds.json')) || initAuthCreds();

    logger?.info(`Using Turso auth state session: ${sessionId}`);

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}.json`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}.json`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => writeData(creds, 'creds.json')
    };
}

module.exports = {
    useTursoAuthState
};
