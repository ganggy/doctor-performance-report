/* ===================================================
   app.js — Doctor Performance Report Frontend Logic
   =================================================== */

const API = '/api';

// ชื่อเดือนภาษาไทย (ปีงบประมาณ: ต.ค. - ก.ย.)
const MONTH_NAMES = {
    1: 'ม.ค.', 2: 'ก.พ.', 3: 'มี.ค.', 4: 'เม.ย.',
    5: 'พ.ค.', 6: 'มิ.ย.', 7: 'ก.ค.', 8: 'ส.ค.',
    9: 'ก.ย.', 10: 'ต.ค.', 11: 'พ.ย.', 12: 'ธ.ค.'
};

// ลำดับเดือนปีงบประมาณ ต.ค. → ก.ย. (fiscal year)
const FISCAL_MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];

// ข้อมูลจาก API
let allDoctors = [];   // [{ code, doctor_name }]
let doctorOrder = [];  // รหัสแพทย์ตามลำดับที่ user กำหนด
let reportData = {};   // { doctorCode: { "yr-mo": { admit, adjrw } } }
let months = [];       // [{ yr, mo }] ตามช่วงเลือก

// Sortable instance
let sortableInstance = null;

// ============ INIT ============
window.onload = async () => {
    populateFiscalYears();
    await fetchDoctors();
    await loadReport();
};

// แปลง ปีงบประมาณ (Thai) → ช่วงเดือน CE
function fyToDateRange(thaiYear) {
    const ceY = thaiYear - 544; // ปีปฏิทินของเดือน ต.ค. คือ ปีงบ - 1 (CE)
    return {
        start: `${ceY}-10`,      // ต.ค.  CE year
        end: `${ceY + 1}-09`   // ก.ย.  CE year+1
    };
}

// หาปีงบประมาณปัจจุบัน
function currentFiscalYear() {
    const now = new Date();
    const yr = now.getFullYear();
    const mo = now.getMonth() + 1; // 1-12
    // เดือน 10-12 อยู่ในปีงบถัดไป  e.g. Oct 2025 → ปีงบ 2569
    return mo >= 10 ? (yr + 543 + 1) : (yr + 543);
}

function populateFiscalYears() {
    const targetFY = document.getElementById('targetFY');
    const curFY = currentFiscalYear();
    const firstFY = 2566; // ปีงบ 2566 = ต.ค. 2566

    targetFY.innerHTML = '';

    for (let y = firstFY; y <= curFY; y++) {
        const opt = new Option(`ปีงบประมาณ ${y}`, y);
        targetFY.appendChild(opt);
    }

    // default: ปีงบปัจจุบัน
    targetFY.value = curFY;
}

// ============ LOAD DOCTORS (initial - no filter) ============
async function fetchDoctors() {
    setStatus('กำลังโหลดรายชื่อแพทย์...');
    try {
        const res = await fetch(`${API}/doctors`);
        const json = await res.json();
        if (!json.success) throw new Error(json.error);
        allDoctors = json.data;
        renderDoctorList(allDoctors);
        setStatus('โหลดรายชื่อแพทย์สำเร็จ กด "โหลดรายงาน" เพื่อแสดงข้อมูล');
    } catch (err) {
        setStatus(`โหลดรายชื่อแพทย์ไม่ได้: ${err.message}`);
        renderDoctorList([]);
    }
}

function renderDoctorList(doctors) {
    const list = document.getElementById('doctorList');
    if (doctors.length === 0) {
        list.innerHTML = '<div class="loading-text">ไม่พบข้อมูลแพทย์</div>';
        return;
    }

    list.innerHTML = doctors.map((d, i) => `
    <div class="doctor-item" data-code="${d.code}">
      <span class="drag-handle">⠿</span>
      <span class="doctor-num">${i + 1}</span>
      <span class="doctor-name-small">${d.doctor_name}</span>
    </div>
  `).join('');

    // Drag & Drop ด้วย SortableJS
    if (sortableInstance) sortableInstance.destroy();
    sortableInstance = new Sortable(list, {
        animation: 200,
        handle: '.drag-handle',
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        onEnd: updateDoctorNumbers
    });
}

function updateDoctorNumbers() {
    const items = document.querySelectorAll('#doctorList .doctor-item');
    items.forEach((item, i) => {
        item.querySelector('.doctor-num').textContent = i + 1;
    });
}

function applyOrder() {
    const items = document.querySelectorAll('#doctorList .doctor-item');
    doctorOrder = Array.from(items).map(el => el.dataset.code);
    if (Object.keys(reportData).length > 0) renderReport();
    setStatus('อัปเดตลำดับแพทย์แล้ว');
}

// ============ LOAD REPORT ============
async function loadReport() {
    const targetFY = parseInt(document.getElementById('targetFY').value);

    if (!targetFY) {
        alert('กรุณาเลือกปีงบประมาณ');
        return;
    }

    // แปลง ปีงบ → ช่วงเดือน
    const { start } = fyToDateRange(targetFY);
    const { end } = fyToDateRange(targetFY);
    const fyLabel = `ปีงบประมาณ ${targetFY}`;

    const btn = document.getElementById('loadBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-icon" aria-hidden="true">↻</span> กำลังโหลด...';

    setStatus('กำลังดึงข้อมูลจากฐานข้อมูล HOSxP...');

    try {
        const [res, wardRes] = await Promise.all([
            fetch(`${API}/report?start=${start}&end=${end}`),
            fetch(`${API}/ward-report?start=${start}&end=${end}`)
        ]);

        const json = await res.json();
        const wardJson = await wardRes.json();

        if (!json.success) throw new Error(json.error);
        if (!wardJson.success) throw new Error(wardJson.error);

        // สร้าง months array จากช่วงที่เลือก
        months = generateMonthRange(start, end);

        // แปลงข้อมูลเป็น dictionary สำหรับหมอ
        reportData = {};
        const doctorMap = {}; // code → doctor_name (เฉพาะที่มีข้อมูล)

        json.data.forEach(row => {
            const key = `${row.yr}-${row.mo}`;
            if (!reportData[row.doctor_code]) reportData[row.doctor_code] = {};
            reportData[row.doctor_code][key] = {
                admit: row.admit_count,
                adjrw: parseFloat(row.total_adjrw)
            };
            // เก็บชื่อแพทย์ที่มีข้อมูล
            doctorMap[row.doctor_code] = row.doctor_name;
        });

        // อัปเดต allDoctors ให้เฉพาะแพทย์ที่มีข้อมูลในช่วงนี้
        const activeDoctors = Object.entries(doctorMap).map(([code, doctor_name]) => ({ code, doctor_name }));

        // จัดลำดับตาม doctorOrder ที่มีอยู่ก่อน แล้วเพิ่มใหม่ท้าย
        const prevOrder = Array.from(document.querySelectorAll('#doctorList .doctor-item')).map(el => el.dataset.code);
        const orderedActive = [];
        const remaining = [...activeDoctors];

        prevOrder.forEach(code => {
            const idx = remaining.findIndex(d => d.code === code);
            if (idx >= 0) orderedActive.push(remaining.splice(idx, 1)[0]);
        });
        orderedActive.push(...remaining);

        // ถ้า sidebar ยังว่างอยู่ ให้เรียงตาม Excel order
        if (prevOrder.length === 0) {
            const excelOrder = ['ณัฐปภัสร์', 'ณัฐูปกัสร์', 'ภาษิต', 'ชานนท์', 'นฤนาท', 'พรพจน์'];
            const sorted = [];
            const rest = [...activeDoctors];
            excelOrder.forEach(keyword => {
                const idx = rest.findIndex(d => d.doctor_name.includes(keyword));
                if (idx >= 0) sorted.push(rest.splice(idx, 1)[0]);
            });
            sorted.push(...rest);
            orderedActive.length = 0;
            orderedActive.push(...sorted);
        }

        allDoctors = orderedActive;
        renderDoctorList(orderedActive);

        // อัปเดต label แสดงปีงบประมาณ
        document.getElementById('reportDateLabel').textContent =
            `${fyLabel}  |  ข้อมูล ณ วันที่ ${formatThaiDate(new Date())}`;

        const doctorCount = activeDoctors.length;
        renderReport();
        renderWardReport(wardJson.data, months);
        updateMetrics(doctorsWithDataCount(), wardJson.data);
        setStatus(`โหลดสำเร็จ - ${fyLabel} | ${doctorCount} แพทย์ | ข้อมูลตึก ${wardJson.data.length} รายการ`);
    } catch (err) {
        setStatus(`เกิดข้อผิดพลาด: ${err.message}`);
        document.getElementById('reportContainer').innerHTML =
            `<div class="empty-state"><div class="empty-icon" aria-hidden="true"></div><p>${err.message}</p></div>`;
    }

    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon" aria-hidden="true">↻</span> โหลดรายงาน';
}

function generateMonthRange(start, end) {
    const result = [];
    const [sy, sm] = start.split('-').map(Number);
    const [ey, em] = end.split('-').map(Number);
    let y = sy, m = sm;
    while (y < ey || (y === ey && m <= em)) {
        result.push({ yr: y, mo: m });
        m++;
        if (m > 12) { m = 1; y++; }
    }
    return result;
}

// ============ RENDER REPORT ============
function renderReport() {
    // ดึงลำดับแพทย์จาก sidebar ปัจจุบัน
    const items = document.querySelectorAll('#doctorList .doctor-item');
    const doctorsInOrder = items.length > 0
        ? Array.from(items).map(el => ({
            code: el.dataset.code,
            doctor_name: el.querySelector('.doctor-name-small').textContent
        }))
        : allDoctors; // fallback

    // เฉพาะแพทย์ที่มีข้อมูลในช่วงเวลาที่เลือก
    const activeCodesInPeriod = new Set(Object.keys(reportData));
    const doctorsWithData = doctorsInOrder.filter(d => activeCodesInPeriod.has(d.code));

    const container = document.getElementById('reportContainer');

    // Build table HTML
    let html = `
    <div class="report-wrapper">
      <div class="report-title-row">
        รายงานการสรุปเวชระเบียนผู้ป่วย ใน โรงพยาบาลโคกศรีสุพรรณ จังหวัดสกลนคร
        (ข้อมูล ณ วันที่ ${formatThaiDate(new Date())})
      </div>
      <div class="table-scroll">
      <table class="report-table">
        <thead>
          <tr>
            <th class="col-label">เดือน</th>
            ${months.map(m => `<th>${MONTH_NAMES[m.mo]}-${(m.yr + 543).toString().slice(-2)}</th>`).join('')}
            <th>รวม</th>
          </tr>
        </thead>
        <tbody>
  `;

    // Summary accumulators
    const totalAdmit = {}; // mo-key → total
    const totalAdjRW = {};
    months.forEach(m => {
        const k = `${m.yr}-${m.mo}`;
        totalAdmit[k] = 0;
        totalAdjRW[k] = 0;
    });
    let grandAdmit = 0, grandAdjRW = 0;

    doctorsWithData.forEach(doctor => {
        const data = reportData[doctor.code] || {};
        let doctorAdmit = 0, doctorAdjRW = 0;

        months.forEach(m => {
            const k = `${m.yr}-${m.mo}`;
            const d = data[k] || { admit: 0, adjrw: 0 };
            totalAdmit[k] = (totalAdmit[k] || 0) + d.admit;
            totalAdjRW[k] = (totalAdjRW[k] || 0) + d.adjrw;
            doctorAdmit += d.admit;
            doctorAdjRW += d.adjrw;
        });

        grandAdmit += doctorAdmit;
        grandAdjRW += doctorAdjRW;

        // Doctor header
        html += `<tr class="row-doctor-header"><td colspan="${months.length + 2}">${doctor.doctor_name}</td></tr>`;

        // Admit row
        html += `<tr class="row-admit">
      <td class="label-cell">จำนวนผู้ป่วย Admit</td>
      ${months.map(m => {
            const k = `${m.yr}-${m.mo}`;
            const v = data[k]?.admit || 0;
            return `<td class="num-cell ${v === 0 ? 'num-zero' : ''}">${v > 0 ? v.toLocaleString() : ''}</td>`;
        }).join('')}
      <td class="num-cell" style="font-weight:700;color:#1e40af">${doctorAdmit.toLocaleString()}</td>
    </tr>`;

        // AdjRW row - per doctor
        html += `<tr class="row-adjrw">
      <td class="label-cell">จำนวน Adjusted RW</td>
      ${months.map(m => {
            const k = `${m.yr}-${m.mo}`;
            const v = data[k]?.adjrw || 0;
            return `<td class="num-cell ${v === 0 ? 'num-zero' : ''}">${v > 0 ? fmtAdjRW(v, 3) : ''}</td>`;
        }).join('')}
      <td class="num-cell total-adjrw-cell">${doctorAdjRW > 0 ? fmtAdjRW(doctorAdjRW, 3) : ''}</td>
    </tr>`;

        // Spacer
        html += `<tr class="row-spacer"><td colspan="${months.length + 2}"></td></tr>`;
    });

    html += `<tr class="row-total-admitx">
    <td class="label-cell grand-label">รวมราย</td>
    ${months.map(m => {
        const k = `${m.yr}-${m.mo}`;
        const v = totalAdmit[k] || 0;
        return `<td class="num-cell admit-summary-cell">${v > 0 ? v.toLocaleString() : ''}</td>`;
    }).join('')}
    <td class="num-cell admit-summary-cell grand-total">${grandAdmit.toLocaleString()}</td>
  </tr>`;

    html += `<tr class="row-total-adjrw">
    <td class="label-cell grand-label">รวม Adj RW</td>
    ${months.map(m => {
        const k = `${m.yr}-${m.mo}`;
        const v = totalAdjRW[k] || 0;
        const isGreen = v >= 250;
        const colorClass = v > 0 ? (isGreen ? 'adjrw-green' : 'adjrw-red') : 'adjrw-empty';
        return `<td class="num-cell adjrw-summary-cell ${colorClass}">${v > 0 ? fmtAdjRW(v, 1) : ''}</td>`;
    }).join('')}
    <td class="num-cell adjrw-summary-cell adjrw-neutral grand-total">${fmtAdjRW(grandAdjRW, 1)}</td>
  </tr>`;

    html += `<tr class="row-sum-adjrw">
    <td colspan="${months.length + 2}">SumAdjRW รวม 250/เดือน</td>
  </tr>`;

    html += `</tbody></table></div></div>`;

    container.innerHTML = html;
}

// ============ RENDER WARD REPORT ============
function renderWardReport(data, months) {
    const container = document.getElementById('wardReportContainer');
    if (!data || data.length === 0) {
        container.innerHTML = '';
        return;
    }

    // Grouping data by month: { "yr-mo": [ row1, row2, ... ] }
    const groupedByMonth = {};
    months.forEach(m => {
        groupedByMonth[`${m.yr}-${m.mo}`] = [];
    });

    data.forEach(row => {
        const key = `${row.yr}-${row.mo}`;
        if (groupedByMonth[key]) {
            groupedByMonth[key].push(row);
        } else {
            groupedByMonth[key] = [row];
        }
    });

    let html = '';

    months.forEach(m => {
        const key = `${m.yr}-${m.mo}`;
        const rows = groupedByMonth[key] || [];
        if (rows.length === 0) return; // Skip months with no data

        const monthName = MONTH_NAMES[m.mo];
        const yearThai = m.yr + 543;

        html += `
        <div class="ward-report-wrapper">
            <div class="ward-report-title">
                รายงานสรุป IPD ตามตึก เดือน${monthName} ${yearThai}
            </div>
            <div class="table-scroll">
                <table class="ward-report-table">
                    <thead>
                        <tr>
                            <th>Ward</th>
                            <th>คน</th>
                            <th>ครั้ง</th>
                            <th>วันนอน</th>
                            <th>ค่าใช้จ่าย</th>
                            <th>AdjRW</th>
                            <th>CMI</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        let sumPerson = 0, sumAdmit = 0, sumLos = 0, sumIncome = 0, sumAdjrw = 0;

        rows.forEach(r => {
            const person = parseInt(r.person_count);
            const admit = parseInt(r.admit_count);
            const los = parseInt(r.total_los);
            const income = parseFloat(r.total_income);
            const adjrw = parseFloat(r.total_adjrw);
            const cmi = admit > 0 ? (adjrw / admit) : 0;

            sumPerson += person;
            sumAdmit += admit;
            sumLos += los;
            sumIncome += income;
            sumAdjrw += adjrw;

            html += `
                <tr>
                    <td class="ward-name-cell">${r.ward_name || r.ward_code}</td>
                    <td class="ward-num-cell">${person.toLocaleString()}</td>
                    <td class="ward-num-cell">${admit.toLocaleString()}</td>
                    <td class="ward-num-cell">${los.toLocaleString()}</td>
                    <td class="ward-num-cell">${income.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td class="ward-num-cell">${fmtAdjRW(adjrw, 4)}</td>
                    <td class="ward-num-cell">${fmtAdjRW(cmi, 4)}</td>
                </tr>
            `;
        });

        const totalCmi = sumAdmit > 0 ? (sumAdjrw / sumAdmit) : 0;

        html += `
                    <tr class="ward-total-row">
                        <td class="ward-name-cell">รวม</td>
                        <td class="ward-num-cell">${sumPerson.toLocaleString()}</td>
                        <td class="ward-num-cell">${sumAdmit.toLocaleString()}</td>
                        <td class="ward-num-cell">${sumLos.toLocaleString()}</td>
                        <td class="ward-num-cell">${sumIncome.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td class="ward-num-cell">${fmtAdjRW(sumAdjrw, 4)}</td>
                        <td class="ward-num-cell">${fmtAdjRW(totalCmi, 4)}</td>
                    </tr>
                    </tbody>
                </table>
            </div>
        </div>
        `;
    });

    container.innerHTML = html;
}

// ============ UTILS ============
function setStatus(msg) {
    document.getElementById('statusText').textContent = msg;
}

function doctorsWithDataCount() {
    return Object.keys(reportData).length;
}

function updateMetrics(doctorCount, wardRows = []) {
    let admitTotal = 0;
    let adjrwTotal = 0;
    Object.values(reportData).forEach(monthMap => {
        Object.values(monthMap).forEach(item => {
            admitTotal += Number(item.admit || 0);
            adjrwTotal += Number(item.adjrw || 0);
        });
    });

    const wardCodes = new Set(wardRows.map(row => row.ward_code || row.ward_name).filter(Boolean));

    document.getElementById('metricDoctors').textContent = doctorCount.toLocaleString();
    document.getElementById('metricAdmit').textContent = admitTotal.toLocaleString();
    document.getElementById('metricAdjrw').textContent = fmtAdjRW(adjrwTotal, 1) || '0.0';
    document.getElementById('metricWards').textContent = wardCodes.size.toLocaleString();
}

// จัดรูปแบบตัวเลข AdjRW พร้อม comma
function fmtAdjRW(v, decimals = 3) {
    if (!v || v === 0) return '';
    const parts = v.toFixed(decimals).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
}

function formatThaiDate(date) {
    const d = date.getDate().toString().padStart(2, '0');
    const m = date.getMonth() + 1;
    const y = date.getFullYear() + 543;
    const mNames = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
    return `${d}/${mNames[m]}/${y}`;
}

function printReport() {
    if (Object.keys(reportData).length === 0) {
        alert('กรุณาโหลดรายงานก่อนพิมพ์');
        return;
    }
    window.print();
}
