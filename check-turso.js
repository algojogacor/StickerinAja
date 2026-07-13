require('dotenv').config();
const { createClient } = require('@libsql/client');

const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;

if (!url) {
    console.log('❌ TURSO_DATABASE_URL not set in .env');
    process.exit(1);
}

console.log('🔌 Connecting to:', url.replace(/\/\/.*@/, '//***@'));

const client = createClient({ url, authToken: token });

(async () => {
    try {
        // List tables
        const tables = await client.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        );
        console.log('\n📋 Tables:', tables.rows.map(r => r.name).join(', ') || '(none)');

        // Check baileys_auth_state
        const count = await client.execute('SELECT COUNT(*) as cnt FROM baileys_auth_state');
        const rowCount = count.rows[0]?.cnt || 0;
        console.log(`📊 Auth rows in baileys_auth_state: ${rowCount}`);

        if (rowCount > 0) {
            const keys = await client.execute(
                'SELECT session_id, key, updated_at FROM baileys_auth_state ORDER BY updated_at DESC LIMIT 15'
            );
            console.log('\n🔑 Recent auth keys:');
            for (const r of keys.rows) {
                console.log(`   [${r.session_id}] ${r.key} — ${r.updated_at}`);
            }

            // Check if creds.json exists (indicates a complete auth session)
            const creds = await client.execute(
                "SELECT value FROM baileys_auth_state WHERE session_id = ? AND key = 'creds.json' LIMIT 1",
                [process.env.TURSO_AUTH_SESSION_ID || 'default']
            );
            if (creds.rows[0]) {
                try {
                    const parsed = JSON.parse(creds.rows[0].value);
                    console.log('\n✅ creds.json FOUND — Auth session is stored in Turso!');
                    console.log(`   NoiseKey exists: ${!!parsed.noiseKey}`);
                    console.log(`   SignedPreKey exists: ${!!parsed.signedPreKey}`);
                    console.log(`   AdvSecretKey exists: ${!!parsed.advSecretKey}`);
                    console.log(`   LastAccountSync: ${parsed.lastAccountSyncTimestamp || 'N/A'}`);
                    console.log('\n   ✅ READY FOR KOYEB DEPLOY — session will survive restarts');
                } catch (e) {
                    console.log('   ⚠️ creds.json found but JSON parse failed:', e.message);
                }
            } else {
                console.log('\n⚠️ No creds.json in Turso — bot has NOT completed QR login yet');
                console.log('   Run the bot, scan QR code, wait 30s, then check again.');
            }
        } else {
            console.log('\n⚠️ baileys_auth_state table is EMPTY');
            console.log('   The bot has not been started with Turso, or login was never completed.');
        }
    } catch (e) {
        console.error('❌ Error:', e.message);
    } finally {
        process.exit(0);
    }
})();
