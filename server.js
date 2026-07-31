const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const fs = require('fs/promises');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const settingsPath = path.join(__dirname, 'data', 'doctor-settings.json');

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

const DEFAULT_DOCTOR_SETTINGS = {
    doctors: [
        { code: '1036', active: true },
        { code: '2548', active: true },
        { code: '2558', active: true },
        { code: '2620', active: true },
        { code: '2625', active: true },
        { code: '2632', active: true }
    ]
};

function normalizeDoctorSettings(settings) {
    const seen = new Set();
    const doctors = Array.isArray(settings?.doctors) ? settings.doctors : [];

    return {
        doctors: doctors
            .map((doctor, index) => ({
                code: String(doctor.code || '').trim(),
                active: doctor.active !== false,
                sort_order: Number.isFinite(Number(doctor.sort_order)) ? Number(doctor.sort_order) : index + 1
            }))
            .filter(doctor => doctor.code && !seen.has(doctor.code) && seen.add(doctor.code))
            .sort((a, b) => a.sort_order - b.sort_order)
            .map(({ code, active }) => ({ code, active }))
    };
}

async function readDoctorSettings() {
    try {
        const raw = await fs.readFile(settingsPath, 'utf8');
        return normalizeDoctorSettings(JSON.parse(raw));
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error('doctor settings read error:', err.message);
        }
        await writeDoctorSettings(DEFAULT_DOCTOR_SETTINGS);
        return normalizeDoctorSettings(DEFAULT_DOCTOR_SETTINGS);
    }
}

async function writeDoctorSettings(settings) {
    const normalized = normalizeDoctorSettings(settings);
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(normalized, null, 2), 'utf8');
    return normalized;
}

async function getDoctorRowsByCodes(codes) {
    if (codes.length === 0) return [];

    const placeholders = codes.map(() => '?').join(',');
    const [rows] = await pool.query(`
        SELECT code, name AS doctor_name, active AS hosxp_active, council_code
        FROM doctor
        WHERE code IN (${placeholders})
        ORDER BY FIELD(code, ${placeholders})
    `, [...codes, ...codes]);

    return rows.map(row => ({ ...row, code: String(row.code) }));
}

async function getConfiguredDoctors({ activeOnly = false } = {}) {
    const settings = await readDoctorSettings();
    const configured = activeOnly
        ? settings.doctors.filter(doctor => doctor.active)
        : settings.doctors;
    const codes = configured.map(doctor => doctor.code);
    const rows = await getDoctorRowsByCodes(codes);
    const rowMap = new Map(rows.map(row => [String(row.code), row]));

    return configured.map((doctor, index) => ({
        code: doctor.code,
        doctor_name: rowMap.get(doctor.code)?.doctor_name || `ไม่พบรหัสแพทย์ ${doctor.code}`,
        hosxp_active: rowMap.get(doctor.code)?.hosxp_active ?? null,
        council_code: rowMap.get(doctor.code)?.council_code ?? null,
        active: doctor.active,
        sort_order: index + 1,
        missing: !rowMap.has(doctor.code)
    }));
}

async function resolveTargetDoctorCodes() {
    const doctors = await getConfiguredDoctors({ activeOnly: true });
    return doctors.map(doctor => doctor.code);
}

// ดึงรายชื่อแพทย์เป้าหมาย
app.get('/api/doctors', async (req, res) => {
    try {
        const rows = await getConfiguredDoctors({ activeOnly: true });
        res.json({ success: true, data: rows });
    } catch (err) {
        console.error('doctors error:', err.message);
        res.json({ success: false, error: err.message, data: [] });
    }
});

app.get('/api/settings/doctors', async (req, res) => {
    try {
        const rows = await getConfiguredDoctors();
        res.json({ success: true, data: rows });
    } catch (err) {
        console.error('settings doctors error:', err.message);
        res.json({ success: false, error: err.message, data: [] });
    }
});

app.get('/api/settings/doctor-search', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) {
            return res.json({ success: true, data: [] });
        }

        const like = `%${q}%`;
        const [rows] = await pool.query(`
            SELECT code, name AS doctor_name, fname, lname, active AS hosxp_active, council_code
            FROM doctor
            WHERE code = ?
               OR name LIKE ?
               OR fname LIKE ?
               OR lname LIKE ?
            ORDER BY
                CASE WHEN code = ? THEN 0 ELSE 1 END,
                active DESC,
                name
            LIMIT 30
        `, [q, like, like, like, q]);

        const configured = await getConfiguredDoctors();
        const configuredCodes = new Set(configured.map(doctor => doctor.code));
        res.json({
            success: true,
            data: rows.map(row => ({
                ...row,
                code: String(row.code),
                configured: configuredCodes.has(String(row.code))
            }))
        });
    } catch (err) {
        console.error('doctor search error:', err.message);
        res.json({ success: false, error: err.message, data: [] });
    }
});

app.post('/api/settings/doctors', async (req, res) => {
    try {
        const code = String(req.body.code || '').trim();
        if (!code) {
            return res.status(400).json({ success: false, error: 'กรุณาระบุรหัสแพทย์' });
        }

        const settings = await readDoctorSettings();
        const exists = settings.doctors.some(doctor => doctor.code === code);
        if (exists) {
            return res.status(409).json({ success: false, error: 'มีแพทย์รหัสนี้ในรายการแล้ว' });
        }

        settings.doctors.push({ code, active: req.body.active !== false });
        await writeDoctorSettings(settings);
        res.json({ success: true, data: await getConfiguredDoctors() });
    } catch (err) {
        console.error('add settings doctor error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/settings/doctors/:code', async (req, res) => {
    try {
        const code = String(req.params.code || '').trim();
        const settings = await readDoctorSettings();
        const doctor = settings.doctors.find(item => item.code === code);
        if (!doctor) {
            return res.status(404).json({ success: false, error: 'ไม่พบแพทย์ในรายการตั้งค่า' });
        }

        if (typeof req.body.active === 'boolean') {
            doctor.active = req.body.active;
        }

        await writeDoctorSettings(settings);
        res.json({ success: true, data: await getConfiguredDoctors() });
    } catch (err) {
        console.error('update settings doctor error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/settings/doctors-order', async (req, res) => {
    try {
        const order = Array.isArray(req.body.order) ? req.body.order.map(code => String(code).trim()) : [];
        const settings = await readDoctorSettings();
        const doctorMap = new Map(settings.doctors.map(doctor => [doctor.code, doctor]));
        const ordered = [];

        order.forEach(code => {
            if (doctorMap.has(code)) ordered.push(doctorMap.get(code));
            doctorMap.delete(code);
        });

        ordered.push(...doctorMap.values());
        await writeDoctorSettings({ doctors: ordered });
        res.json({ success: true, data: await getConfiguredDoctors() });
    } catch (err) {
        console.error('doctor order error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/settings/doctors/:code', async (req, res) => {
    try {
        const code = String(req.params.code || '').trim();
        const settings = await readDoctorSettings();
        const nextDoctors = settings.doctors.filter(doctor => doctor.code !== code);
        if (nextDoctors.length === settings.doctors.length) {
            return res.status(404).json({ success: false, error: 'ไม่พบแพทย์ในรายการตั้งค่า' });
        }

        await writeDoctorSettings({ doctors: nextDoctors });
        res.json({ success: true, data: await getConfiguredDoctors() });
    } catch (err) {
        console.error('delete settings doctor error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ดึงข้อมูลรายงานตามรายชื่อแพทย์ที่เปิดใช้งานในหน้า Settings
app.get('/api/report', async (req, res) => {
    try {
        const { start, end } = req.query;
        const startDate = start ? `${start}-01` : null;
        const endDate = end ? `${end}-31` : null;

        const targetDoctorCodes = await resolveTargetDoctorCodes();
        if (targetDoctorCodes.length === 0) {
            return res.json({ success: true, data: [] });
        }
        const placeholders = targetDoctorCodes.map(() => '?').join(',');
        let whereClause = `WHERE i.dchdate IS NOT NULL AND i.admdoctor IN (${placeholders})`;
        const params = [...targetDoctorCodes];
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
    `, [...params, ...targetDoctorCodes]);

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

// สรุป IPD ตามกลุ่มสิทธิการรักษา (รายเดือน)
app.get('/api/coverage-report', async (req, res) => {
    try {
        const { start, end } = req.query;
        const startDate = start ? `${start}-01` : null;
        const endDate = end ? `${end}-31` : null;

        let whereClause = 'WHERE i.dchdate IS NOT NULL';
        const params = [];
        if (startDate && endDate) {
            whereClause += ' AND i.dchdate >= ? AND i.dchdate <= ?';
            params.push(startDate, endDate);
        }

        const [rows] = await pool.query(`
            SELECT
                YEAR(i.dchdate) AS yr,
                MONTH(i.dchdate) AS mo,
                COALESCE(p.pttype_eclaim_id, '') AS coverage_group,
                COALESCE(e.name, 'ไม่ระบุสิทธิการเงิน') AS coverage_name,
                COUNT(DISTINCT i.hn) AS person_count,
                COUNT(DISTINCT i.an) AS admit_count,
                SUM(COALESCE(a.admdate, 0)) AS total_los,
                ROUND(SUM(COALESCE(a.income, 0)), 2) AS total_income,
                ROUND(SUM(COALESCE(a.discount_money, 0)), 2) AS total_discount,
                ROUND(SUM(COALESCE(a.rcpt_money, 0)), 2) AS total_paid,
                ROUND(SUM(
                    COALESCE(a.income, 0)
                    - COALESCE(a.discount_money, 0)
                    - COALESCE(a.rcpt_money, 0)
                ), 2) AS total_debt,
                ROUND(SUM(COALESCE(i.adjrw, 0)), 4) AS total_adjrw
            FROM ipt i
            LEFT JOIN an_stat a ON a.an = i.an
            LEFT JOIN pttype p ON p.pttype = i.pttype
            LEFT JOIN pttype_eclaim e ON e.code = p.pttype_eclaim_id
            ${whereClause}
            GROUP BY YEAR(i.dchdate), MONTH(i.dchdate),
                p.pttype_eclaim_id, e.name
            ORDER BY yr, mo,
                CAST(COALESCE(p.pttype_eclaim_id, '999') AS UNSIGNED),
                coverage_name
        `, params);

        res.json({ success: true, data: rows });
    } catch (err) {
        console.error('coverage-report error:', err.message);
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
        const keywords = ['ณัฐ', 'ภาษิต', 'ชานนท์', 'นฤนาท', 'พรพจน์', 'ณัฐปภัสร', 'นวัตชัย', 'บดินทร์', 'เสนีวงศ์'];
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
