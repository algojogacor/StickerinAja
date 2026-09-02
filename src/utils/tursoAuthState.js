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

    // Non-blocking background prune on startup
    Promise.resolve(pruneTursoAuthState({ sessionId, logger })).catch(() => {});

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
                    if (!ids || ids.length === 0) return data;

                    const keyToId = new Map();
                    const fixedKeys = [];
                    for (const id of ids) {
                        const keyName = fixKeyName(`${type}-${id}.json`);
                        keyToId.set(keyName, id);
                        fixedKeys.push(keyName);
                        data[id] = null;
                    }

                    const placeholders = fixedKeys.map(() => '?').join(',');
                    try {
                        const res = await client.execute({
                            sql: `SELECT key, value FROM ${TABLE_NAME} WHERE session_id = ? AND key IN (${placeholders})`,
                            args: [sessionId, ...fixedKeys]
                        });

                        for (const row of res.rows) {
                            const id = keyToId.get(row.key);
                            if (id !== undefined && row.value) {
                                let value = JSON.parse(row.value, BufferJSON.reviver);
                                if (type === 'app-state-sync-key' && value) {
                                    value = proto.Message.AppStateSyncKeyData.fromObject(value);
                                }
                                data[id] = value;
                            }
                        }
                    } catch (err) {
                        logger?.error?.({ err, type }, 'Failed to batch get auth keys from Turso');
                    }

                    return data;
                },
                set: async (data) => {
                    const statements = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const fixedKey = fixKeyName(`${category}-${id}.json`);
                            if (value) {
                                statements.push({
                                    sql: `
                                        INSERT INTO ${TABLE_NAME} (session_id, key, value, updated_at)
                                        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                                        ON CONFLICT(session_id, key)
                                        DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
                                    `,
                                    args: [sessionId, fixedKey, JSON.stringify(value, BufferJSON.replacer)]
                                });
                            } else {
                                statements.push({
                                    sql: `DELETE FROM ${TABLE_NAME} WHERE session_id = ? AND key = ?`,
                                    args: [sessionId, fixedKey]
                                });
                            }
                        }
                    }
                    if (statements.length > 0) {
                        try {
                            await client.batch(statements, 'write');
                        } catch (err) {
                            logger?.error?.({ err, count: statements.length }, 'Failed to atomic batch write auth keys to Turso');
                        }
                    }
                }
            }
        },
        saveCreds: async () => writeData(creds, 'creds.json')
    };
}

async function deleteTursoSession(sessionId) {
    const client = createTursoClientFromEnv();
    if (!client) return false;
    await client.execute({
        sql: `DELETE FROM ${TABLE_NAME} WHERE session_id = ?`,
        args: [sessionId]
    });
    return true;
}

async function pruneTursoAuthState({ sessionId = 'default', maxSenderKeys = 500, maxPreKeys = 100, logger } = {}) {
    const client = createTursoClientFromEnv();
    if (!client) return { senderKeysPruned: 0, preKeysPruned: 0 };

    try {
        // Prune sender keys exceeding maxSenderKeys
        const r1 = await client.execute({
            sql: `
                DELETE FROM ${TABLE_NAME}
                WHERE session_id = ?
                  AND (key LIKE 'sender-key-%' OR key LIKE 'sender-key-memory-%')
                  AND key NOT IN (
                      SELECT key FROM ${TABLE_NAME}
                      WHERE session_id = ?
                        AND (key LIKE 'sender-key-%' OR key LIKE 'sender-key-memory-%')
                      ORDER BY updated_at DESC
                      LIMIT ?
                  )
            `,
            args: [sessionId, sessionId, maxSenderKeys]
        });

        // Prune pre-keys exceeding maxPreKeys
        const r2 = await client.execute({
            sql: `
                DELETE FROM ${TABLE_NAME}
                WHERE session_id = ?
                  AND key LIKE 'pre-key-%'
                  AND key NOT IN (
                      SELECT key FROM ${TABLE_NAME}
                      WHERE session_id = ?
                        AND key LIKE 'pre-key-%'
                      ORDER BY updated_at DESC
                      LIMIT ?
                  )
            `,
            args: [sessionId, sessionId, maxPreKeys]
        });

        const totalPruned = (r1.rowsAffected || 0) + (r2.rowsAffected || 0);
        if (totalPruned > 0) {
            logger?.info?.(`[Turso GC] Pruned ${totalPruned} stale auth keys for session [${sessionId}] (SenderKeys: ${r1.rowsAffected}, PreKeys: ${r2.rowsAffected})`);
        }
        return { senderKeysPruned: r1.rowsAffected || 0, preKeysPruned: r2.rowsAffected || 0 };
    } catch (err) {
        logger?.warn?.({ err: err?.message }, `[Turso GC] Failed to prune auth state for [${sessionId}]`);
        return { senderKeysPruned: 0, preKeysPruned: 0 };
    }
}

module.exports = {
    useTursoAuthState,
    deleteTursoSession,
    pruneTursoAuthState
};
