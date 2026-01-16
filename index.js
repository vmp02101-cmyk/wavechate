const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const { initDB, getDB } = require('./db');
require('dotenv').config();

const app = express();

// Middleware to handle ngrok browser warning
app.use((req, res, next) => {
    res.setHeader('ngrok-skip-browser-warning', 'true');
    next();
});

app.use(cors());
app.use(express.json());

// --- SERVE MEDIA ---
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use('/recordings', express.static(path.join(__dirname, 'public/recordings')));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

let db;

// Root route
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'WaveChat Backend API',
        version: '1.0.1'
    });
});

// Initialize Database
initDB().then(database => {
    db = database;
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
    }).on('error', (err) => {
        console.error('❌ Server Error:', err);
    });
}).catch(err => {
    console.error('❌ Database Initialization Failed:', err);
});

const fs = require('fs');

// Register/Update User
app.post('/api/users/register', async (req, res) => {
    let { id, name, phone, image } = req.body;
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    try {
        // Dynamic Query based on DB Type
        const isMySQL = db.constructor.name === 'MySQLWrapper';
        let query;

        if (isMySQL) {
            query = "INSERT INTO users (id, name, phone, image) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), phone=VALUES(phone), image=VALUES(image), lastSeen=CURRENT_TIMESTAMP";
        } else {
            query = "INSERT INTO users (id, name, phone, image) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, image=excluded.image, lastSeen=CURRENT_TIMESTAMP";
        }

        await db.run(query, [id, name, cleanPhone, image]);
        res.status(200).json({ success: true });
    } catch (err) {
        console.error('Registration Error:', err);
        res.status(500).json({ error: "Database error" });
    }
});

// Get User by Phone
app.get('/api/users/phone/:phone', async (req, res) => {
    const cleanPhone = req.params.phone.replace(/[^0-9]/g, '');
    try {
        const row = await db.get("SELECT * FROM users WHERE phone = ?", [cleanPhone]);
        if (row) {
            res.status(200).json(row);
        } else {
            res.status(404).json({ error: "User not found" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Messages for a Chat
app.get('/api/messages/:chatId', async (req, res) => {
    let { chatId } = req.params;
    const clean = (id) => id.toString().replace(/\D/g, '').slice(-10);
    const normChatId = chatId.split('_').map(clean).sort().join('_');

    try {
        const rows = await db.all(
            "SELECT * FROM messages WHERE chatId = ? OR chatId = ? ORDER BY timestamp ASC",
            [chatId, normChatId]
        );
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Chats List for a User
app.get('/api/chats/:userId', async (req, res) => {
    const userId = req.params.userId;
    try {
        // Note: '||' is standard SQL concatenation, works in SQLite. 
        // MySQL uses CONCAT() strictly unless pipes_as_concat is enabled, but usually pipes fail in default MySQL.
        // Let's use a cleaner approach compatible with both using ? params or simple LIKE

        // This query is complex enough that we should check DB type if we face issues.
        // For now, let's assume the wrapper handles simple queries.

        // Getting recent chats via simple logic might be safer
        const rawMessages = await db.all("SELECT * FROM messages WHERE chatId LIKE ?", [`%${userId}%`]);

        // Grouping in JS to avoid complex incompatible SQL GROUP BY
        const uniqueChats = [];
        const seenChats = new Set();

        // Sort by time desc
        rawMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        const clean = (id) => id.toString().replace(/\D/g, '').slice(-10);

        for (const msg of rawMessages) {
            // Normalize ID
            const cleanParts = msg.chatId.split('_').map(clean).sort();
            const normCid = cleanParts.join('_');

            if (seenChats.has(normCid)) continue;
            seenChats.add(normCid);

            const otherId = cleanParts.find(id => id !== clean(userId));
            if (!otherId) continue;

            // Fetch user details
            const user = await db.get("SELECT name, image, id FROM users WHERE phone LIKE ?", [`%${otherId}`]);

            uniqueChats.push({
                chatId: normCid,
                text: msg.text,
                timestamp: msg.timestamp,
                otherUserName: user ? user.name : otherId,
                otherUserImage: user ? user.image : `https://ui-avatars.com/api/?name=${encodeURIComponent(otherId)}&background=00a884&color=fff`,
                otherUserId: otherId,
                unread: 0,
                online: false
            });
        }
        res.status(200).json(uniqueChats);
    } catch (err) {
        console.error("Error in getUserChats:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- CLOUDINARY CONFIG ---
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

cloudinary.config({
    cloud_name: 'djrsvab8b',
    api_key: '927344822344179',
    api_secret: 'Q73j2dAbfXyGZlO6Ds5Q7ArWv2c'
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'wavechat_media',
        allowed_formats: ['jpg', 'png', 'jpeg', 'mp4', 'webm', 'wav', 'mp3'],
        resource_type: 'auto' // Important for video/audio
    }
});

const upload = multer({ storage: storage });

app.post('/api/upload', (req, res) => {
    upload.single('file')(req, res, (err) => {
        if (err) {
            console.error('❌ Upload Error Details:', err);
            return res.status(500).json({ error: err.message || "Upload Failed" });
        }
        if (!req.file) {
            console.error('❌ No file received in request');
            return res.status(400).json({ error: "No file uploaded" });
        }

        console.log('✅ File Uploaded to Cloudinary:', req.file.path);
        res.json({ url: req.file.path });
    });
});

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    socket.on('join_chat', (chatId) => {
        socket.join(chatId);
    });

    socket.on('register', (userId) => {
        if (!userId) return;
        console.log(`📡 [DEBUG] Register Request: ${userId}`);
        const normalized = userId.toString().replace(/\D/g, '').slice(-10);
        socket.join(userId);
        if (normalized.length === 10 && normalized !== userId) {
            socket.join(normalized);
            console.log(`✅ [DEBUG] Joined Normalized Room: ${normalized}`);
        }
        console.log(`👤 User Registered: ${userId}`);
    });

    socket.on('send_message', async (data) => {
        const { chatId, sender, text, type, mediaUrl } = data;

        console.log(`📨 [DEBUG] New Message from ${sender} in ${chatId}`);

        if (!chatId || !sender) {
            console.error('❌ [DEBUG] Message rejected: Missing chatId or sender');
            return;
        }

        const clean = (id) => id.toString().replace(/\D/g, '').slice(-10);
        // Ensure chatId is a string to prevent crashes
        const safeChatId = String(chatId);
        const normChatId = safeChatId.split('_').map(clean).sort().join('_');

        try {
            const result = await db.run(
                "INSERT INTO messages (chatId, sender, text, type, mediaUrl) VALUES (?, ?, ?, ?, ?)",
                [normChatId, sender, text || null, type || 'text', mediaUrl || null]
            );

            const newMessage = {
                id: result.lastID,
                ...data,
                chatId: normChatId,
                timestamp: new Date().toISOString()
            };

            const parts = safeChatId.split('_');
            if (parts.length === 2) {
                const normParts = parts.map(clean);
                const normReceiver = normParts.find(p => p !== clean(sender));

                console.log(`🚀 Dispatching Msg to: ${normChatId} AND Receiver: ${normReceiver}`);

                // Emit to rooms
                io.to(safeChatId).emit('receive_message', newMessage);
                io.to(`${parts[1]}_${parts[0]}`).emit('receive_message', newMessage);
                if (normReceiver) io.to(normReceiver).emit('receive_message', newMessage);
                io.to(clean(sender)).emit('receive_message', newMessage); // Sync sender
            }
        } catch (err) {
            console.error('❌ Insert Error:', err);
        }
    });

    // Status Logic
    app.post('/api/status', async (req, res) => {
        const { userId, userName, type, content, bgColor, mediaUrl } = req.body;
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        try {
            const result = await db.run(
                "INSERT INTO status (userId, userName, type, content, bgColor, mediaUrl, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [userId, userName, type, content, bgColor, mediaUrl, expiresAt]
            );
            const newStatus = {
                id: result.lastID,
                userId, userName, type, content, bgColor, mediaUrl, expiresAt,
                timestamp: new Date().toISOString()
            };
            io.emit('new_status', newStatus);
            res.status(200).json({ success: true, status: newStatus });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get Status
    app.get('/api/status', async (req, res) => {
        try {
            const rows = await db.all("SELECT * FROM status WHERE expiresAt > CURRENT_TIMESTAMP ORDER BY timestamp DESC");
            res.status(200).json(rows);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    socket.on('disconnect', () => { });
});





