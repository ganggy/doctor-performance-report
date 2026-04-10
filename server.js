const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// HOSxP Database config
const dbConfig = {
    host: '192.168.2.254',
    user: 'opd',
    password: 'opd',
    database: 'hos',
    port: 3306,
    charset: 'utf8',
    connectTimeout: 10000
};

let pool;

async function initDB() {
    try {
        pool = mysql.createPool({ ...dbConfig, waitForConnections: true, connectionLimit: 5 });
        const conn = await pool.getConnection();
        console.log('✅ เชื่อมต่อฐานข้อมูล HOSxP สำเร็จ');
        conn.release();
    } catch (err) {
        console.error('❌ เชื่อมต่อฐานข้อมูลไม่ได้:', err.message);
    }
}

// รายชื่อแพทย์เป้าหมาย 5 คน (hardcoded)
const TARGET_DOCTOR_CODES = ['1036', '2548', '2558', '2620', '2625'];
// ลำดับตาม Excel: ณัฐปภัสร์, ภาษิต, ชานนท์, นฤนาท, พรพจน์
const TARGET_DOCTOR_ORDER = ['1036', '2548', '2558', '2620', '2625'];

// ดึงรายชื่อแพทย์เป้าหมาย
app.get('/api/doctors', async (req, res) => {
    try {
        const placeholders = TARGET_DOCTOR_CODES.map(() => '?').join(',');
        const [rows] = await pool.query(`
      SELECT code, name AS doctor_name
      FROM doctor
      WHERE code IN (${placeholders})
      ORDER BY FIELD(code, ${placeholders})
    `, [...TARGET_DOCTOR_CODES, ...TARGET_DOCTOR_CODES]);
        res.json({ success: true, data: rows });
    } catch (err) {
        console.error('doctors error:', err.message);
        res.json({ success: false, error: err.message, data: [] });
    }
});

// ดึงข้อมูลรายงาน (เฉพาะ 5 แพทย์เป้าหมาย)
app.get('/api/report', async (req, res) => {
    try {
        const { start, end } = req.query;
        const startDate = start ? `${start}-01` : null;
        const endDate = end ? `${end}-31` : null;

        const placeholders = TARGET_DOCTOR_CODES.map(() => '?').join(',');
        let whereClause = `WHERE i.dchdate IS NOT NULL AND i.admdoctor IN (${placeholders})`;
        const params = [...TARGET_DOCTOR_CODES];
        if (startDate && endDate) {
            whereClause += " AND i.dchdate >= ? AND i.dchdate <= ?";
            params.push(startDate, endDate);
        }

        const [rows] = await pool.query(`
      SELECT 
        d.code AS doctor_code,
        d.name AS doctor_name,
        YEAR(i.dchdate) AS yr,
        MONTH(i.dchdate) AS mo,
        COUNT(i.an) AS admit_count,
        ROUND(SUM(COALESCE(i.adjrw, 0)), 3) AS total_adjrw
      FROM ipt i
      JOIN doctor d ON i.admdoctor = d.code
      ${whereClause}
      GROUP BY d.code, d.name, YEAR(i.dchdate), MONTH(i.dchdate)
      ORDER BY FIELD(d.code, ${placeholders}), yr, mo
    `, [...params, ...TARGET_DOCTOR_CODES]);

        res.json({ success: true, data: rows });
    } catch (err) {
        console.error('report error:', err.message);
        res.json({ success: false, error: err.message, data: [] });
    }
});

// ดึงข้อมูลรายงานตามตึก (รายเดือน)
app.get('/api/ward-report', async (req, res) => {
    try {
        const { start, end } = req.query;
        const startDate = start ? `${start}-01` : null;
        const endDate = end ? `${end}-31` : null;

        let whereClause = `WHERE a.dchdate IS NOT NULL AND a.ward IS NOT NULL`;
        const params = [];
        if (startDate && endDate) {
            whereClause += " AND a.dchdate >= ? AND a.dchdate <= ?";
            params.push(startDate, endDate);
        }

        const [rows] = await pool.query(`
      SELECT 
        w.ward AS ward_code,
        w.name AS ward_name,
        YEAR(a.dchdate) AS yr,
        MONTH(a.dchdate) AS mo,
        COUNT(DISTINCT a.hn) AS person_count,
        COUNT(a.an) AS admit_count,
        SUM(a.los) AS total_los,
        SUM(a.income) AS total_income,
        SUM(COALESCE(i.adjrw, 0)) AS total_adjrw
      FROM an_stat a
      JOIN ipt i ON a.an = i.an
      JOIN ward w ON a.ward = w.ward
      ${whereClause}
      GROUP BY w.ward, w.name, YEAR(a.dchdate), MONTH(a.dchdate)
      ORDER BY YEAR(a.dchdate), MONTH(a.dchdate), w.name
    `, params);

        res.json({ success: true, data: rows });
    } catch (err) {
        console.error('ward-report error:', err.message);
        res.json({ success: false, error: err.message, data: [] });
    }
});

// ค้นหาแพทย์เป้าหมายและตรวจสอบว่าใช้ field ไหนใน ipt
app.get('/api/find-doctors', async (req, res) => {
    try {
        // ค้นหาแพทย์ทั้งหมด council_code = '01' ที่ active = Y
        const [allPhysicians] = await pool.query(`
      SELECT code, name, fname, lname, pname, council_code, active
      FROM doctor
      WHERE council_code = '01'
      ORDER BY name
    `);

        // กรองตามคีย์เวิร์ดของ 5 แพทย์ (ตรวจจาก fname หรือ name)
        const keywords = ['ณัฐ', 'ภาษิต', 'ชานนท์', 'นฤนาท', 'พรพจน์', 'ณัฐปภัสร', 'นวัตชัย'];
        const matched = allPhysicians.filter(d =>
            keywords.some(k => (d.name || '').includes(k) || (d.fname || '').includes(k))
        );

        // ตรวจสอบ ipt counts สำหรับแต่ละคนที่เจอ
        const checks = await Promise.all(matched.map(async d => {
            const [[a]] = await pool.query('SELECT COUNT(*) as n FROM ipt WHERE admdoctor = ?', [d.code]);
            const [[b]] = await pool.query('SELECT COUNT(*) as n FROM ipt WHERE dch_doctor = ?', [d.code]);
            return {
                code: d.code, name: d.name, fname: d.fname, lname: d.lname,
                active: d.active,
                admdoctor_count: a.n, dch_doctor_count: b.n
            };
        }));

        // ส่งทั้ง matched และ top 20 ของ physician ทั้งหมด (สำหรับ debug)
        res.json({
            success: true,
            matched_doctors: checks,
            all_physicians_count: allPhysicians.length,
            all_physicians_sample: allPhysicians.slice(0, 30).map(d => ({
                code: d.code, name: d.name, active: d.active
            }))
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ตรวจสอบ schema ตาราง doctor
app.get('/api/schema', async (req, res) => {

    try {
        const [rows] = await pool.query('DESCRIBE doctor');
        res.json({ success: true, columns: rows.map(r => r.Field) });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ดึง top doctors ใน ipt ไม่จำกัด council_code
app.get('/api/top-ipt-doctors', async (req, res) => {
    try {
        const [rows] = await pool.query(`
      SELECT d.code, d.name, d.council_code, d.active,
             COUNT(i.an) as admit_count
      FROM ipt i
      JOIN doctor d ON i.admdoctor = d.code
      WHERE i.dchdate >= '2023-10-01'
      GROUP BY d.code, d.name, d.council_code, d.active
      ORDER BY admit_count DESC
      LIMIT 30
    `);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});


app.get('/api/schema-ipt', async (req, res) => {
    try {
        const [rows] = await pool.query('DESCRIBE ipt');
        res.json({ success: true, columns: rows.map(r => r.Field) });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ดึงตัวอย่างข้อมูล ipt
app.get('/api/ipt-sample', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM ipt LIMIT 2');
        res.json({ success: true, columns: Object.keys(rows[0] || {}), data: rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ดึงตัวอย่างข้อมูล doctor
app.get('/api/doctor-sample', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM doctor LIMIT 3');
        res.json({ success: true, data: rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ทดสอบการเชื่อมต่อ
app.get('/api/test', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT COUNT(*) as total FROM ipt LIMIT 1');
        res.json({ success: true, message: 'เชื่อมต่อสำเร็จ', total_ipt: rows[0].total });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3502;
initDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🏥 Doctor Performance Report running at port ${PORT}`);
    });
});
