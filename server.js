/**
 * ระบบบริหารจัดการตารางเวรทหาร (Army Shift Management System)
 * พัฒนาโดย: [ชื่อของมึง]
 * โครงสร้าง: Node.js (Express), MySQL (TiDB Cloud), Google Calendar API
 */

import express from 'express';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import { google } from 'googleapis';

// --- [SECTION 1: CONFIGURATION & MIDDLEWARE] ---

dotenv.config(); // โหลดค่า Environment Variables จากไฟล์ .env
const app = express();

// ตั้งค่าให้ Express รองรับข้อมูลแบบ JSON และดึงไฟล์จากโฟลเดอร์ public (Frontend)
app.use(express.json());
app.use(express.static('public'));

/**
 * ตั้งค่าระบบ Session เพื่อใช้ในการคงสถานะการเข้าสู่ระบบ (Authentication Persistent)
 * รองรับการเก็บข้อมูลผู้ใช้ในฝั่ง Server
 */
app.use(session({
    secret: 'army-duty-secret-key', // คีย์ลับสำหรับเข้ารหัส Session
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // ปรับเป็น true หากใช้งานผ่าน HTTPS
}));

// --- [SECTION 2: DATABASE CONNECTION (TiDB Cloud)] ---

/**
 * ข้อมูลการเชื่อมต่อฐานข้อมูล TiDB Cloud (AWS Southeast Asia)
 * ใช้โปรโตคอล SSL เพื่อความปลอดภัยในการส่งข้อมูล
 */
const dbConfig = {
    host: 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
    user: '2FUpHhTtXJDwkTV.root', 
    password: 'UikEOsL5EdIDomNr',
    database: 'shift_db',
    port: 4000,
    ssl: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true
    }
};

/** * ฟังก์ชันสร้าง Connection Pool สำหรับติดต่อฐานข้อมูลแบบ Asynchronous 
 * @returns {Promise<mysql.Connection>}
 */
async function getConnection() {
    return await mysql.createConnection(dbConfig);
}

/** ฟังก์ชันตรวจสอบสถานะการเชื่อมต่อฐานข้อมูลเริ่มต้น */
async function testDatabaseConnection() {
    try {
        const connection = await getConnection();
        console.log("------------------------------------------");
        console.log("✅ SYSTEM: DATABASE CONNECTED SUCCESSFULLY");
        console.log("------------------------------------------");
        await connection.end();
    } catch (err) {
        console.error("❌ SYSTEM ERROR: DATABASE CONNECTION FAILED ->", err.message);
    }
}
testDatabaseConnection();

// --- [SECTION 3: GOOGLE OAUTH 2.0 & CALENDAR INTEGRATION] ---

/**
 * ตั้งค่า Google OAuth 2.0 Client สำหรับขออนุญาตเข้าถึงปฏิทินของผู้ใช้
 * REDIRECT_URI จะถูกปรับเปลี่ยนตามสภาพแวดล้อม (Local หรือ Production)
 */
const REDIRECT_URI = process.env.RENDER_EXTERNAL_URL 
    ? `https://my-army-shift.onrender.com/login-redirect` 
    : 'http://localhost:3000/login-redirect';

const oauth2Client = new google.auth.OAuth2(
    '1055278075819-3degsqjsed1f3o8k35doqot6f45ih9re.apps.googleusercontent.com',
    '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',
    REDIRECT_URI
);

/**
 * ฟังก์ชันส่งข้อมูลการเข้าเวรไปยัง Google Calendar
 * มีระบบคำนวณสรุปยอดเวรรวม และตั้งค่าการแจ้งเตือนล่วงหน้า 60 นาที (07:00 น.)
 * @param {google.auth.OAuth2} auth - ข้อมูลสิทธิ์เข้าถึงของผู้ใช้
 * @param {Object} shiftData - ข้อมูลเวรรายบุคคล
 * @param {Array} allShiftsOfDay - รายการเวรทั้งหมดในวันนั้นเพื่อสรุปยอด
 */
async function sendToGoogleCalendar(auth, shiftData, allShiftsOfDay) {
    const calendar = google.calendar({ version: 'v3', auth });
    
    // กรองและสรุปจำนวนผู้เข้าเวรในแต่ละกลุ่มงาน
    const kpCount = allShiftsOfDay.filter(s => (s.group_name || "").trim() === 'กองพัน').length;
    const spkCount = allShiftsOfDay.filter(s => (s.group_name || "").trim() === 'ศปก').length;
    const supervisor = allShiftsOfDay.find(s => (s.role_type || "").includes('นายทหารเวร'));
    const loginLink = `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}/dashboard.html`;

    // กำหนดหัวข้อและเนื้อหาการแจ้งเตือนตามบทบาท (Role-based messaging)
    let summary = (shiftData.role_type || "").includes('นายทหารเวร') ? `🛡️ เวร: ${shiftData.role_type}` : `💂 เวร: ${shiftData.role_type}`;
    let description = (shiftData.role_type || "").includes('นายทหารเวร') 
        ? `📊 สรุปยอดเวรวันนี้:\n- กองพัน: ${kpCount} นาย\n- ศปก.: ${spkCount} นาย\n\n🔗 ตรวจสอบรายชื่อ:\n${loginLink}`
        : `👤 นายทหารเวรวันนี้: ${supervisor ? supervisor.rank_name : 'ยังไม่ได้ระบุ'}\n\n🔗 ดูรายละเอียด:\n${loginLink}`;

    const dateOnly = new Date(shiftData.shift_date).toISOString().split('T')[0];

    return calendar.events.insert({
        calendarId: 'primary',
        resource: {
            summary: summary,
            description: description,
            start: { dateTime: `${dateOnly}T08:00:00`, timeZone: 'Asia/Bangkok' },
            end: { dateTime: `${dateOnly}T09:00:00`, timeZone: 'Asia/Bangkok' },
            reminders: {
                useDefault: false,
                overrides: [
                    { method: 'popup', minutes: 60 } // แจ้งเตือนเวลา 07:00 น.
                ]
            }
        },
    });
}

// --- [SECTION 4: AUTHENTICATION ROUTES] ---

/** Route สำหรับเริ่มต้นการขอสิทธิ์ (Auth URL Generation) */
app.get('/google/auth', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // บังคับให้ขอ Refresh Token เสมอ
        scope: [
            'https://www.googleapis.com/auth/calendar.events',
            'https://www.googleapis.com/auth/userinfo.email',
            'openid'
        ]
    });
    res.redirect(url);
});

/** Route สำหรับรับ Callback จาก Google และบันทึก Token ลงฐานข้อมูล */
app.get('/login-redirect', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send("❌ Authentication Error: No code provided.");
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        const email = userInfo.data.email;

        const connection = await getConnection();
        const [rows] = await connection.execute('SELECT id, rank_name FROM users WHERE email = ?', [email]);
        
        if (rows.length > 0) {
            // บันทึกข้อมูลลงใน Session
            req.session.userId = rows[0].id;
            req.session.userName = rows[0].rank_name;
            req.session.userEmail = email;
            // บันทึก Google Token เพื่อใช้สำหรับ Calendar API ในภายหลัง
            await connection.execute('UPDATE users SET google_token = ? WHERE email = ?', [JSON.stringify(tokens), email]);
            await connection.end();
            res.redirect('/dashboard.html'); 
        } else {
            await connection.end();
            res.send(`❌ ไม่พบอีเมล ${email} ในฐานข้อมูล กรุณาติดต่อผู้ดูแลระบบ`);
        }
    } catch (err) { res.status(500).send("Login Redirect Error: " + err.message); }
});

// --- [SECTION 5: MAIN API FOR SHIFT MANAGEMENT] ---

/** API: Sync ข้อมูลเวรที่จัดไว้แล้วเข้าสู่ Google Calendar ของแต่ละบุคคล */
app.post('/sync-existing-shifts', async (req, res) => {
    const { month, year, group } = req.query;
    try {
        const connection = await getConnection();
        const [allShifts] = await connection.execute(
            `SELECT s.*, u.rank_name, u.email, u.google_token 
             FROM shift_assignments s 
             JOIN users u ON s.user_id = u.id 
             WHERE MONTH(s.shift_date) = ? AND YEAR(s.shift_date) = ?`,
            [month, year]
        );

        // กรองเฉพาะข้อมูลที่ตรงกับกลุ่มงานที่ระบุ (กองพัน หรือ ศปก.)
        const targetShifts = allShifts.filter(s => (s.group_name || "").trim() === (group || "").trim());
        
        let successCount = 0;
        let skipCount = 0;

        for (const shift of targetShifts) {
            if (!shift.google_token) { skipCount++; continue; }
            try {
                const userAuth = new google.auth.OAuth2('1055278075819-3degsqjsed1f3o8k35doqot6f45ih9re.apps.googleusercontent.com', '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', REDIRECT_URI);
                userAuth.setCredentials(JSON.parse(shift.google_token));
                
                const dayShifts = allShifts.filter(s => new Date(s.shift_date).toDateString() === new Date(shift.shift_date).toDateString());
                await sendToGoogleCalendar(userAuth, shift, dayShifts); 
                successCount++;
            } catch (err) { skipCount++; }
        }
        await connection.end();
        res.json({ success: true, count: successCount, message: `ซิงค์สำเร็จ ${successCount} นาย` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** API: ดึงรายชื่อผู้ใช้ทั้งหมด (สำหรับหน้า Admin) */
app.get('/get-users', async (req, res) => {
    try {
        const connection = await getConnection();
        const [rows] = await connection.execute(`
            SELECT id, rank_name, role, email, 
            (google_token IS NOT NULL AND google_token != '') AS is_linked 
            FROM users ORDER BY id ASC
        `);
        await connection.end();
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** API: บันทึกการจัดเวรใหม่ลงฐานข้อมูล */
app.post('/assign-shift', async (req, res) => {
    const { user_id, shift_date, role_type, group_name, shift_turn, note } = req.body; 
    try {
        const connection = await getConnection();
        await connection.execute(
            "INSERT INTO shift_assignments (user_id, shift_date, role_type, group_name, shift_turn, note) VALUES (?, ?, ?, ?, ?, ?)", 
            [user_id, shift_date, role_type, group_name, shift_turn, note || '']
        );
        const [user] = await connection.execute("SELECT google_token, rank_name FROM users WHERE id = ?", [user_id]);
        await connection.end();
        
        // หากผู้ใช้เชื่อมต่อ Calendar ไว้ ให้ส่งข้อมูลทันที
        if (user.length > 0 && user[0].google_token) {
            const userAuth = new google.auth.OAuth2('1055278075819-3degsqjsed1f3o8k35doqot6f45ih9re.apps.googleusercontent.com', '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', REDIRECT_URI);
            userAuth.setCredentials(JSON.parse(user[0].google_token));
            await sendToGoogleCalendar(userAuth, { shift_date, role_type, rank_name: user[0].rank_name }, []);
        }
        res.send('ok');
    } catch (err) { res.status(500).send(err.message); }
});

/** API: ลบข้อมูลการเข้าเวร */
app.delete('/delete-shift/:id', async (req, res) => {
    try {
        const connection = await getConnection();
        await connection.execute("DELETE FROM shift_assignments WHERE id = ?", [req.params.id]); 
        await connection.end();
        res.send('ok');
    } catch (err) { res.status(500).send(err.message); }
});

// --- [SECTION 6: EXCEL IMPORT & DATA MANAGEMENT] ---

/** API: นำเข้ารายชื่อทหารจากไฟล์ Excel (JSON Format) */
app.post('/import-users', async (req, res) => {
    const { users } = req.body;
    try {
        const connection = await getConnection();
        const sql = "INSERT INTO users (rank_name, role, email) VALUES (?, ?, ?)";
        for (const user of users) {
            if (user["ยศ - ชื่อ"]) {
                await connection.execute(sql, [user["ยศ - ชื่อ"], user["หน้าที่"], user["email"]]);
            }
        }
        await connection.end();
        res.send('ok');
    } catch (err) { res.status(500).send(err.message); }
});

/** API: ล้างข้อมูลรายชื่อและตารางเวรทั้งหมด (Danger Zone) */
app.delete('/clear-all-users', async (req, res) => {
    try {
        const connection = await getConnection();
        await connection.execute("DELETE FROM shift_assignments"); // ลบตารางที่เชื่อมโยงก่อน
        await connection.execute("DELETE FROM users"); 
        await connection.end();
        res.send('ok');
    } catch (err) { res.status(500).send(err.message); }
});

// --- [SECTION 7: REPORTING & DASHBOARD] ---

/** API: ดึงข้อมูลสรุปตารางเวรประจำเดือนสำหรับหน้าปฏิทินกลาง */
app.get('/get-report-calendar', async (req, res) => {
    const { month, year, group } = req.query;
    try {
        const connection = await getConnection();
        const sql = `SELECT s.id, s.shift_date, s.shift_turn, u.rank_name, u.role 
                     FROM shift_assignments s JOIN users u ON s.user_id = u.id 
                     WHERE MONTH(s.shift_date) = ? AND YEAR(s.shift_date) = ? AND s.group_name = ? 
                     ORDER BY s.shift_date ASC`;
        const [rows] = await connection.execute(sql, [month, year, group]);
        await connection.end();
        res.json(rows);
    } catch (err) { res.status(500).send(err.message); }
});

/** API: ดึงข้อมูลสรุปสำหรับการส่งออก Excel */
app.get('/get-excel-summary', async (req, res) => {
    const { month, year, group } = req.query;
    try {
        const connection = await getConnection();
        const sql = `SELECT u.rank_name, u.role, GROUP_CONCAT(DAY(s.shift_date) ORDER BY s.shift_date ASC) as days 
                     FROM shift_assignments s JOIN users u ON s.user_id = u.id 
                     WHERE MONTH(s.shift_date) = ? AND YEAR(s.shift_date) = ? AND s.group_name = ? 
                     GROUP BY u.id`;
        const [rows] = await connection.execute(sql, [month, year, group]);
        await connection.end();
        res.json(rows);
    } catch (err) { res.status(500).send(err.message); }
});

/** API: ดึงข้อมูลโปรไฟล์ของผู้ใช้ที่ Login อยู่ (Session-based) */
app.get('/api/my-profile', (req, res) => {
    if (!req.session.userId) return res.status(401).send('Unauthorized');
    res.json({ id: req.session.userId, rank_name: req.session.userName, email: req.session.userEmail });
});

/** API: ดึงตารางเวรส่วนตัวสำหรับหน้า Dashboard */
app.get('/get-my-duty', async (req, res) => {
    try {
        const connection = await getConnection();
        const [rows] = await connection.execute(
            `SELECT s.shift_date, s.role_type, s.shift_turn, u.rank_name 
             FROM shift_assignments s
             LEFT JOIN users u ON s.user_id = u.id 
             WHERE MONTH(s.shift_date) = 3 AND YEAR(s.shift_date) = 2026`
        );
        await connection.end();
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- [SECTION 8: SERVER ACTIVATION] ---

const PORT = process.env.PORT || 3000; 
app.listen(PORT, '0.0.0.0', () => {
    console.log("------------------------------------------");
    console.log(`🚀 ARMY SHIFT SYSTEM: PORT ${PORT} IS ACTIVE`);
    console.log("------------------------------------------");
});