const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const { google } = require('googleapis');
const session = require('express-session');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// 1. ตั้งค่า Session
app.use(session({
    secret: 'army-duty-secret-key',
    resave: false,
    saveUninitialized: true
}));

// 2. ตั้งค่า Database
const mysql = require('mysql2/promise');

const dbConfig = {
    host: 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com', // 👈 ก๊อปจากหน้า Connect
    user: '//EqdV8U5ZwzH6aqD.root',                                     // 👈 ก๊อปจากหน้า Connect
    password: '@gateway01.ap-southeast-1.',                       // 👈 รหัสที่เพื่อนจดไว้
    database: 'shift_db',                                   // 👈 ใส่ชื่อนี้ไว้ก่อน
    port: 4000,
    ssl: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true                            // 👈 บรรทัดนี้ห้ามลืม!
    }
};

// ฟังก์ชันทดสอบการเชื่อมต่อ
async function testConnection() {
    try {
        const connection = await mysql.createConnection(dbConfig);
        console.log("✅ เชื่อมต่อฐานข้อมูล Cloud สำเร็จแล้วเพื่อน!");
        await connection.end();
    } catch (err) {
        console.error("❌ เชื่อมต่อไม่ได้เพราะ: ", err.message);
    }
}

testConnection();

// 3. ตั้งค่า Google OAuth
const oauth2Client = new google.auth.OAuth2(
    '1055278075819-3degsqjsed1f3o8k35doqot6f45ih9re.apps.googleusercontent.com',
    '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',
    'http://localhost:3000/google/callback'
);

// --- 🌟 ฟังก์ชันหลักสำหรับส่งเข้า Calendar (มีอันเดียวพอ!) 🌟 ---
async function addDutyToCalendar(summary, date, tokenJson) {
    if (!tokenJson) {
        console.log("❌ ไม่มี Token สำหรับรายการนี้");
        return false;
    }
    try {
        const userAuth = new google.auth.OAuth2(
            '1055278075819-3degsqjsed1f3o8k35doqot6f45ih9re.apps.googleusercontent.com',
            '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',
            'http://localhost:3000/google/callback'
        );
        userAuth.setCredentials(JSON.parse(tokenJson));
        const calendar = google.calendar({ version: 'v3', auth: userAuth });
        
        const d = new Date(date);
        const dateString = d.toISOString().split('T')[0];

        await calendar.events.insert({
            calendarId: 'primary',
            resource: {
                summary: `📅 เวร: ${summary}`,
                description: 'ระบบจัดเวร กองพันทหารอากาศโยธิน',
                start: { date: dateString, timeZone: 'Asia/Bangkok' },
                end: { date: dateString, timeZone: 'Asia/Bangkok' },
            },
        });
        return true;
    } catch (error) {
        console.error('❌ Google Insert Error:', error.message);
        return false;
    }
}

// --- 4. Google Auth Routes ---
app.get('/google/auth', (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).send("ไม่พบ User ID");
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/calendar.events'],
        state: userId.toString()
    });
    res.redirect(url);
});

app.get('/google/callback', async (req, res) => {
    const { code, state } = req.query;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        const connection = await getConnection();
        await connection.execute("UPDATE users SET google_token = ? WHERE id = ?", [JSON.stringify(tokens), state]);
        await connection.end();
        res.send('<h1>เชื่อมต่อสำเร็จ!</h1><p>ระบบบันทึกกุญแจเรียบร้อยแล้ว ปิดหน้านี้ได้เลยครับ</p>');
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

// --- 5. API สำหรับหน้าจัดการและรายงาน ---

// 🔥 ปุ่มซิงค์เวรทั้งหมด
app.post('/sync-existing-shifts', async (req, res) => {
    const { month, year, group } = req.query;
    try {
        const connection = await getConnection();
        const sql = `
            SELECT s.shift_date, s.role_type, s.shift_turn, u.rank_name, u.google_token 
            FROM shift_assignments s
            JOIN users u ON s.user_id = u.id
            WHERE u.google_token IS NOT NULL 
              AND MONTH(s.shift_date) = ? 
              AND YEAR(s.shift_date) = ? 
              AND s.group_name = ?
        `;
        const [shifts] = await connection.execute(sql, [month, year, group]);
        await connection.end();

        if (shifts.length === 0) return res.send("❌ ไม่พบเวรที่ซิงค์ได้ (กำลังพลอาจยังไม่ลงทะเบียน)");

        let successCount = 0;
        for (const shift of shifts) {
            const summary = `${shift.role_type} (${shift.rank_name})`;
            const isDone = await addDutyToCalendar(summary, shift.shift_date, shift.google_token);
            if (isDone) successCount++;
        }
        res.send(`✅ ซิงค์สำเร็จ ${successCount} รายการ`);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.get('/get-users', async (req, res) => {
    try {
        const connection = await getConnection();
        const [rows] = await connection.execute("SELECT * FROM users ORDER BY id ASC");
        await connection.end();
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/assign-shift', async (req, res) => {
    const { user_id, shift_date, role_type, group_name, shift_turn, note } = req.body; 
    try {
        const connection = await getConnection();
        const [existing] = await connection.execute("SELECT id FROM shift_assignments WHERE user_id = ? AND shift_date = ?", [user_id, shift_date]);
        if (existing.length > 0) {
            await connection.end();
            return res.status(400).send("คนนี้มีเวรในวันที่เลือกอยู่แล้วครับ!");
        }
        await connection.execute("INSERT INTO shift_assignments (user_id, shift_date, role_type, group_name, shift_turn, note) VALUES (?, ?, ?, ?, ?, ?)", [user_id, shift_date, role_type, group_name, shift_turn, note || '']);
        const [user] = await connection.execute("SELECT google_token, rank_name FROM users WHERE id = ?", [user_id]);
        await connection.end();

        if (user.length > 0 && user[0].google_token) {
            const summary = `${role_type} (${user[0].rank_name})`;
            await addDutyToCalendar(summary, shift_date, user[0].google_token);
        }
        res.send('ok');
    } catch (err) { res.status(500).send(err.message); }
});

app.delete('/delete-shift/:id', async (req, res) => {
    try {
        const connection = await getConnection();
        await connection.execute("DELETE FROM shift_assignments WHERE id = ?", [req.params.id]); 
        await connection.end();
        res.send('ok');
    } catch (err) { res.status(500).send(err.message); }
});

app.get('/get-report-calendar', async (req, res) => {
    const { month, year, group } = req.query;
    try {
        const connection = await getConnection();
        const sql = `SELECT s.id, s.shift_date, s.shift_turn, u.rank_name, u.role FROM shift_assignments s JOIN users u ON s.user_id = u.id WHERE MONTH(s.shift_date) = ? AND YEAR(s.shift_date) = ? AND s.group_name = ? ORDER BY s.shift_date ASC`;
        const [rows] = await connection.execute(sql, [month, year, group]);
        await connection.end();
        res.json(rows);
    } catch (err) { res.status(500).send(err.message); }
});

app.get('/get-excel-summary', async (req, res) => {
    const { month, year, group } = req.query;
    try {
        const connection = await getConnection();
        const sql = `SELECT u.rank_name, u.role, GROUP_CONCAT(DAY(s.shift_date) ORDER BY s.shift_date ASC) as days FROM shift_assignments s JOIN users u ON s.user_id = u.id WHERE MONTH(s.shift_date) = ? AND YEAR(s.shift_date) = ? AND s.group_name = ? GROUP BY u.id`;
        const [rows] = await connection.execute(sql, [month, year, group]);
        await connection.end();
        res.json(rows);
    } catch (err) { res.status(500).send(err.message); }
});

// 6. Start Server
const PORT = 3000;
app.listen(PORT, () => {
    console.log("========================================");
    console.log(`🚀 ระบบพร้อมใช้งานที่: http://localhost:${PORT}`);
    console.log("========================================");
});