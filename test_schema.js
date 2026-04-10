const mysql = require('mysql2/promise');
const fs = require('fs');

async function run() {
    const pool = mysql.createPool({
        host: '192.168.2.254',
        user: 'opd',
        password: 'opd',
        database: 'hos',
        port: 3306,
        charset: 'utf8',
        connectTimeout: 5000
    });

    try {
        const [an_stat] = await pool.query('DESCRIBE an_stat');
        const keys = an_stat.map(r => r.Field);

        const [ward] = await pool.query('DESCRIBE ward');

        const [sample_an] = await pool.query(`
            SELECT a.an, a.hn, a.ward, a.admdate, a.dchdate, a.income, i.adjrw 
            FROM an_stat a
            JOIN ipt i ON a.an = i.an
            WHERE a.dchdate IS NOT NULL AND a.ward IS NOT NULL 
            LIMIT 5
        `);

        const out = {
            an_stat_keys: keys,
            sample: sample_an
        };

        fs.writeFileSync('out_an_stat.json', JSON.stringify(out, null, 2));
        console.log("Wrote out_an_stat.json");

    } catch (e) {
        console.error(e);
    }
    pool.end();
}
run();
