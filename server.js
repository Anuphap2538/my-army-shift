const express = require('express');
const mysql = require('mysql2/promise'); // ประกาศครั้งเดียวพอ
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
const dbConfig = {
    host: 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
    user: '2FUpHhTtXJDwkTV.root', // 👈 เช็คดีๆ นะว่าก๊อปมาครบไหม
    password: 'UikEOsL5EdIDomNr', // 👈 รหัสผ่าน TiDB ของเพื่อน
    database: 'shift_db',
    port: 4000,
    ssl: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true
    }
};

// ฟังก์ชันสำหรับดึง Connection (เพิ่มเข้าไปให้แล้ว)
async function getConnection() {
    return await mysql.createConnection(dbConfig);
}

// ฟังก์ชันทดสอบการเชื่อมต่อ
async function testConnection() {
    try {
        const connection = await getConnection();
        console.log("✅ เชื่อมต่อฐานข้อมูล Cloud สำเร็จแล้วเพื่อน!");
        await connection.end();
    } catch (err) {
        console.error("❌ เชื่อมต่อไม่ได้เพราะ: ", err.message);
    }
}
testConnection();

// 3. ตั้งค่า Google OAuth 
// ⚠️ อย่าลืมเปลี่ยน http://localhost:3000 เป็น URL ของ Render เพื่อนนะ!
const REDIRECT_URI = process.env.RENDER_EXTERNAL_URL 
    ? `${process.env.RENDER_EXTERNAL_URL}/google/callback` 
    : 'http://localhost:3000/google/callback';

const oauth2Client = new google.auth.OAuth2(
    '1055278075819-3degsqjsed1f3o8k35doqot6f45ih9re.apps.googleusercontent.com',
    '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',
    REDIRECT_URI
);

// --- 🌟 ฟังก์ชันหลักสำหรับส่งเข้า Calendar 🌟 ---
async function addDutyToCalendar(summary, date, tokenJson) {
    if (!tokenJson) return false;
    try {
        const userAuth = new google.auth.OAuth2(
            '1055278075819-3degsqjsed1f3o8k35doqot6f45ih9re.apps.googleusercontent.com',
            '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',
            REDIRECT_URI
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

// --- 5. API ต่างๆ (ใช้ getConnection ที่สร้างใหม่) ---
app.post('/sync-existing-shifts', async (req, res) => {
    const { month, year, group } = req.query;
    try {
        const connection = await getConnection();
        const sql = `
            SELECT s.shift_date, s.role_type, u.rank_name, u.google_token 
            FROM shift_assignments s
            JOIN users u ON s.user_id = u.id
            WHERE u.google_token IS NOT NULL 
              AND MONTH(s.shift_date) = ? 
              AND YEAR(s.shift_date) = ? 
              AND s.group_name = ?
        `;
        const [shifts] = await connection.execute(sql, [month, year, group]);
        await connection.end();
        if (shifts.length === 0) return res.send("❌ ไม่พบเวรที่ซิงค์ได้");
        let successCount = 0;
        for (const shift of shifts) {
            const summary = `${shift.role_type} (${shift.rank_name})`;
            const isDone = await addDutyToCalendar(summary, shift.shift_date, shift.google_token);
            if (isDone) successCount++;
        }
        res.send(`✅ ซิงค์สำเร็จ ${successCount} รายการ`);
    } catch (err) { res.status(500).send(err.message); }
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

// API สำหรับนำเข้ารายชื่อ (รองรับหัวข้อภาษาไทยจาก Excel ของเพื่อน)
app.post('/import-users', async (req, res) => {
    const { users } = req.body; 
    if (!users || !Array.isArray(users)) return res.status(400).send("ข้อมูลไม่ถูกต้อง");

    try {
        const connection = await getConnection();
        // เราจะเก็บ "ยศ - ชื่อ" ลงใน rank_name และ "หน้าที่" ลงใน role
        const sql = "INSERT INTO users (rank_name, role, email) VALUES (?, ?, ?)";
        
        for (const user of users) {
            // ดึงค่าตามหัวข้อในไฟล์ CSV ของเพื่อนเป๊ะๆ
            const rankAndName = user["ยศ - ชื่อ"] || "";
            const role = user["หน้าที่"] || "";
            const email = user["email"] || "";

            if (rankAndName) { // บันทึกเฉพาะแถวที่มีชื่อ
                await connection.execute(sql, [rankAndName, role, email]);
            }
        }
        
        await connection.end();
        res.send(`✅ นำเข้าสำเร็จ ${users.length} รายชื่อลง Cloud เรียบร้อย!`);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error: " + err.message);
    }
});

// API สำหรับล้างข้อมูลผู้ใช้ทั้งหมด
app.delete('/clear-all-users', async (req, res) => {
    try {
        const connection = await getConnection();
        // ลบข้อมูลในตาราง users ทั้งหมด
        await connection.execute("TRUNCATE TABLE users");
        await connection.end();
        res.send('ok');
    } catch (err) {
        console.error(err);
        res.status(500).send("ลบไม่สำเร็จ: " + err.message);
    }
});

// 1. API สำหรับล้างรายชื่อทหารทั้งหมด (จากปุ่ม clearAllUsers)
app.delete('/clear-all-users', async (req, res) => {
    try {
        const connection = await getConnection();
        // ลบข้อมูลเวรที่ผูกกับคนออกก่อน เพื่อป้องกัน Error ติด Foreign Key
        await connection.execute("DELETE FROM shift_assignments");
        // ลบรายชื่อทั้งหมด
        await connection.execute("DELETE FROM users"); 
        await connection.end();
        res.send('ok');
    } catch (err) {
        console.error(err);
        res.status(500).send("ลบรายชื่อไม่สำเร็จ: " + err.message);
    }
});

// 2. API สำหรับล้างข้อมูลการจัดเวรทั้งหมด (จากปุ่ม clearAllShifts)
// หมายเหตุ: เปลี่ยนจาก app.get เป็น app.delete เพื่อความปลอดภัยตามมาตรฐาน
app.delete('/clear-shifts', async (req, res) => {
    try {
        const connection = await getConnection();
        await connection.execute("DELETE FROM shift_assignments");
        await connection.end();
        res.send('✅ ล้างข้อมูลการจัดเวรทั้งหมดเรียบร้อยแล้ว!');
    } catch (err) {
        console.error(err);
        res.status(500).send("ลบข้อมูลเวรไม่สำเร็จ: " + err.message);
    }
});

// API สำหรับล้างรายชื่อทหารทั้งหมด (ปุ่มแดง)
app.delete('/clear-all-users', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        // 1. ต้องลบข้อมูลในตารางเวรก่อน (เพราะมันเชื่อมโยงกัน)
        await connection.execute("DELETE FROM shift_assignments");
        // 2. ลบรายชื่อทั้งหมด
        await connection.execute("DELETE FROM users"); 
        await connection.end();
        res.send('ok');
    } catch (err) {
        if (connection) await connection.end();
        console.error(err);
        res.status(500).send("ลบไม่สำเร็จ: " + err.message);
    }
});

app.delete('/clear-all-users', async (req, res) => {
    try {
        const connection = await getConnection();
        await connection.execute("DELETE FROM shift_assignments"); // ลบเวรก่อน
        await connection.execute("DELETE FROM users"); // แล้วค่อยลบชื่อ
        await connection.end();
        res.send('ok');
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// 6. Start Server (แก้ Port ให้รองรับ Render)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 ระบบพร้อมใช้งานบน Port: ${PORT}`);
});









