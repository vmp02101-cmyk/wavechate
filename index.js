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
app.get('/api', (req, res) => {
    res.json({
        status: 'ok',
        message: 'WaveChat Backend API',
        version: '1.0.1'
    });
});

// DEBUG ROUTE (Temporary)
app.get('/api/debug-db', async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Database instance is null' });

        // 1. Check Tables
        const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table'");

        // 2. Check Last 5 Messages
        const messages = await db.all("SELECT * FROM messages ORDER BY id DESC LIMIT 5");

        res.json({
            status: 'Database Connected',
            tables: tables,
            recent_messages: messages
        });
    } catch (e) {
        res.status(500).json({ error: e.message, stack: e.stack });
    }
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

// --- OTP STORE (Simple In-Memory) ---
const otpStore = new Map(); // Stores phone -> { code, expires }

// --- FAST2SMS CONFIG ---
const FAST2SMS_API_KEY = "JIxboAdQND7ME8K6S30qOYvh5VnULymWP1gBptcR9ZlsiXzFrjtrZzya83oELYxA4e6qIRFSvPUJBNbk"; // Replace with your key

// Send OTP
app.post('/api/otp/send', async (req, res) => {
    let { phone } = req.body;

    // Ensure 10 digit number
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const number = cleanPhone.slice(-10);

    if (cleanPhone.length < 10) {
        return res.status(400).json({ error: "Invalid phone number" });
    }

    // Generate 6 digit OTP (or fixed)
    const otp = Math.floor(100000 + Math.random() * 900000);

    // Store OTP (Expires in 5 mins)
    otpStore.set(number, {
        code: otp,
        expires: Date.now() + 5 * 60 * 1000
    });

    console.log(`🔒 Generated OTP for ${number}: ${otp}`);

    // SIMULATED OTP (No Fast2SMS)
    // Ensures login always works without external keys/errors
    res.json({
        success: true,
        message: "OTP Sent (Simulated). Code: " + otp,
        isTest: true,
        debugOtp: otp
    });
});

// Verify OTP
app.post('/api/otp/verify', (req, res) => {
    // BYPASS: Accept ANY code for easy login
    return res.json({ success: true });
});

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

// Get Group Messages
app.get('/api/groups/:groupId/messages', async (req, res) => {
    try {
        const { groupId } = req.params;
        const rows = await db.all("SELECT * FROM messages WHERE chatId = ? ORDER BY timestamp ASC", [String(groupId)]);
        res.status(200).json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get Chats List for a User (Groups + Private)
app.get('/api/chats/:userId', async (req, res) => {
    const rawUserId = req.params.userId;

    // Normalize ID for consistent DB querying
    const clean = (id) => {
        if (!id) return '';
        return String(id).replace(/\D/g, '').slice(-10);
    };
    const cleanId = clean(rawUserId);

    if (!cleanId || cleanId.length < 5) {
        return res.status(400).json({ error: "Invalid User ID" });
    }

    // Support both Raw (+91..) and Clean (91..) IDs to handle legacy data
    const possibleIds = [rawUserId, cleanId, `+${cleanId}`].filter(Boolean);
    const placeholders = possibleIds.map(() => '?').join(',');

    try {
        const uniqueChats = [];

        // 1. FETCH GROUPS (Robust Query)
        try {
            const groups = await db.all(
                `SELECT DISTINCT g.* FROM groups_table g 
                 JOIN group_members gm ON g.id = gm.groupId 
                 WHERE gm.userId IN (${placeholders})`,
                possibleIds
            );

            for (const g of groups) {
                // Get Last Message for Group
                const lastMsg = await db.get("SELECT * FROM messages WHERE chatId = ? ORDER BY timestamp DESC LIMIT 1", [g.id]);

                // Get Members with Names
                const members = await db.all(`
                    SELECT gm.userId as id, gm.role, u.name 
                    FROM group_members gm 
                    LEFT JOIN users u ON gm.userId = u.phone 
                    WHERE gm.groupId = ?
                `, [g.id]);

                uniqueChats.push({
                    id: g.id,
                    name: g.name,
                    isGroup: true,
                    members: members.map(m => ({ id: m.id, isAdmin: m.role === 'admin' })),
                    lastMessage: lastMsg ? (lastMsg.text || 'Media') : 'Tap to chat',
                    time: lastMsg ? lastMsg.timestamp : (g.createdAt || new Date().toISOString()),
                    unread: 0,
                    avatar: g.icon,
                    createdBy: g.createdBy,
                    admins: JSON.parse(g.admins || '[]'),
                    type: g.type // Fix: Pass group type (public/private) to frontend
                });
            }
        } catch (e) {
            console.error("Error fetching groups:", e);
            // Continue to private chats even if groups fail
        }

        // 2. FETCH PRIVATE CHATS
        const rawMessages = await db.all("SELECT * FROM messages WHERE chatId LIKE ?", [`%${cleanId}%`]);
        const seenChats = new Set();

        // Add existing groups to seen to avoid duplication if msg logic overlaps (unlikely)
        uniqueChats.forEach(c => seenChats.add(c.id));

        rawMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        // clean function hoisted to top

        for (const msg of rawMessages) {
            if (!msg.chatId) continue;

            // If it's a group ID (no _ separator usually, or different format), stick to private logic
            // Private chats strictly defined as containing userId
            // Filter out group messages here if mixed?
            // Assuming private chat is A_B format.
            if (!String(msg.chatId).includes('_')) continue; // Skip groups

            const cleanParts = String(msg.chatId).split('_').map(clean).sort();
            const normCid = cleanParts.join('_');

            if (seenChats.has(normCid)) continue;

            // Fix: userId doesn't exist, use cleanId
            const myCleanId = cleanId;
            const otherId = cleanParts.find(id => id !== myCleanId);

            if (!otherId || otherId === 'null' || otherId === 'undefined' || otherId.length < 10) continue;

            seenChats.add(normCid);

            // Fetch user
            const user = await db.get("SELECT name, image FROM users WHERE phone LIKE ?", [`%${otherId}`]);

            uniqueChats.push({
                id: normCid, // Map chatId to id
                name: user ? user.name : otherId,
                avatar: user ? user.image : `https://ui-avatars.com/api/?name=${otherId}&background=random`,
                phone: otherId,
                lastMessage: msg.text || 'Media',
                time: msg.timestamp,
                unread: 0,
                isGroup: false,
                isArchived: false
            });
        }

        uniqueChats.sort((a, b) => new Date(b.time) - new Date(a.time));
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
        resource_type: 'auto' // Allow all formats (Images, Video, Audio, Raw)
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
        // Force HTTPS to prevent Mixed Content errors
        const secureUrl = req.file.path.replace(/^http:/, 'https:');
        res.json({ url: secureUrl });
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

        // Auto-join Group Rooms
        try {
            db.all("SELECT groupId FROM group_members WHERE userId = ?", [normalized])
                .then(groups => {
                    groups.forEach(g => {
                        socket.join(g.groupId);
                        console.log(`✅ [DEBUG] Auto-Joined Group: ${g.groupId}`);
                    });
                })
                .catch(e => console.error("Auto-join error", e));

            // Auto-join Groups Created by User (Fix for Legacy Groups)
            db.all("SELECT id FROM groups_table WHERE createdBy = ? OR createdBy = ?", [userId, normalized])
                .then(groups => {
                    groups.forEach(g => {
                        socket.join(g.id);
                        console.log(`✅ [DEBUG] Auto-Joined Created Group: ${g.id}`);
                    });
                }).catch(e => { });

        } catch (e) { }
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

        let normChatId;
        // Private Chat (Phone_Phone) -> Normalization (Clean & Sort)
        if (safeChatId.includes('_')) {
            normChatId = safeChatId.split('_').map(clean).sort().join('_');
        } else {
            // Group Chat -> Keep Original ID (Don't slice timestamps!)
            normChatId = safeChatId;
        }

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
            } else {
                // GROUP CHAT BROADCAST

                // FORCE JOIN (Failsafe)
                socket.join(safeChatId);
                console.log(`✅ [DEBUG] Socket forced to join group room: ${safeChatId}`);

                // Permission Check for Private Groups
                try {
                    const groupInfo = await db.get("SELECT type, createdBy FROM groups_table WHERE id = ?", [safeChatId]);

                    // Legacy Fix: Ensure Creator gets message even if not in members
                    if (groupInfo && groupInfo.createdBy) {
                        const cleanCreator = clean(groupInfo.createdBy);
                        io.to(groupInfo.createdBy).emit('receive_message', newMessage);
                        io.to(cleanCreator).emit('receive_message', newMessage);
                    }

                    if (groupInfo && groupInfo.type === 'private') {
                        const member = await db.get("SELECT role FROM group_members WHERE groupId = ? AND userId = ?", [safeChatId, clean(sender)]);
                        if (!member || member.role !== 'admin') {
                            console.log(`⛔ Blocked message from non-admin ${sender} in Private Group ${safeChatId}`);
                            return;
                        }
                    }
                } catch (e) { console.error("Permission check failed", e); }

                console.log(`🚀 Dispatching Group Msg to: ${safeChatId}`);

                // Helper to safely emit
                const safeEmit = (targetId) => {
                    if (!targetId) return;
                    io.to(String(targetId)).emit('receive_message', newMessage); // Force String
                    const c = clean(targetId);
                    if (c) {
                        io.to(c).emit('receive_message', newMessage);
                        io.to('+' + c).emit('receive_message', newMessage);
                    }
                };

                // 1. Emit to GROUP ROOM (Always)
                io.to(safeChatId).emit('receive_message', newMessage);

                // 2. Emit to SENDER (Sync - Always)
                safeEmit(sender);

                // 3. Emit to CREATOR (Legacy Fix)
                if (groupInfo && groupInfo.createdBy) {
                    safeEmit(groupInfo.createdBy);
                }

                // 4. Emit to MEMBERS (Try-Catch)
                try {
                    const members = await db.all("SELECT userId FROM group_members WHERE groupId = ?", [safeChatId]);
                    members.forEach(m => {
                        safeEmit(m.userId);
                    });
                } catch (e) { console.error("Group dispatch error", e); }
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

    socket.on('create_group', async (groupData) => {
        console.log('Creating Group:', groupData.name);
        try {
            const safeId = String(groupData.id);
            await db.run(
                "INSERT INTO groups_table (id, name, icon, createdBy, admins, type) VALUES (?, ?, ?, ?, ?, ?)",
                [safeId, groupData.name, groupData.avatar, groupData.createdBy, JSON.stringify(groupData.admins || []), groupData.type || 'public']
            );

            // Members: Ensure we handle array of objects {id, isAdmin}
            const clean = (id) => String(id).replace(/\D/g, '').slice(-10);

            for (const m of groupData.members) {
                const cleanMemberId = clean(m.id);
                try {
                    await db.run("INSERT INTO group_members (groupId, userId, role) VALUES (?, ?, ?)",
                        [safeId, cleanMemberId, m.isAdmin ? 'admin' : 'member']);
                } catch (e) { }

                // Broadcast to Member (Robust)
                io.to(String(m.id)).emit('new_group_created', groupData);
                if (cleanMemberId) {
                    io.to(cleanMemberId).emit('new_group_created', groupData);
                    io.to('+' + cleanMemberId).emit('new_group_created', groupData);
                }
            }

            // Explicitly Add Creator as Admin Member
            if (groupData.createdBy) {
                const creatorId = clean(groupData.createdBy);
                // Check if already processed
                const alreadyAdded = groupData.members.find(m => clean(m.id) === creatorId);
                if (!alreadyAdded) {
                    await db.run("INSERT INTO group_members (groupId, userId, role) VALUES (?, ?, ?)",
                        [safeId, creatorId, 'admin']);
                }
            }
        } catch (e) {
            console.error('Group Create Error:', e);
        }
    });

    // --- CALL SIGNALING (Zego Cloud Compatible) ---
    socket.on('call_user', (data) => {
        // Frontend sends: { callerId, receiverId, channelId, type }
        const { callerId, receiverId, channelId, type } = data;
        const cleanTo = String(receiverId).replace(/\D/g, '').slice(-10);
        console.log(`📞 Call Request from ${callerId} to ${cleanTo} (Chan: ${channelId})`);

        // Emit exactly what Frontend expects in listenToIncomingCalls
        io.to(cleanTo).emit('incoming_call', {
            callerId,
            channelId,
            type
        });
    });

    socket.on('answer_call', (data) => {
        // Not used heavily in Zego flow (usually handled by Zego SDK events), 
        // but kept for custom signaling if needed
    });

    socket.on('reject_call', (data) => {
        // Frontend emits { callerId } (the person who CALLED)
        const { callerId } = data;
        const cleanTo = String(callerId).replace(/\D/g, '').slice(-10);
        io.to(cleanTo).emit('call_rejected');
    });

    socket.on('end_call', (data) => {
        const { receiverId } = data;
        const cleanTo = String(receiverId).replace(/\D/g, '').slice(-10);
        io.to(cleanTo).emit('call_ended');
    });

    // --- GROUP CALL SIGNALING ---
    socket.on('group_call', async (data) => {
        const { groupId, signalData, from, name } = data;
        const cleanFrom = String(from).replace(/\D/g, '').slice(-10);
        console.log(`📞 Group Call Started in ${groupId} by ${from}`);

        try {
            const members = await db.all("SELECT userId FROM group_members WHERE groupId = ?", [String(groupId)]);
            const clean = (id) => String(id).replace(/\D/g, '').slice(-10);

            const safeEmit = (targetId, payload) => {
                if (!targetId) return;
                io.to(targetId).emit('incoming_call', payload);
                const c = clean(targetId);
                if (c) {
                    io.to(c).emit('incoming_call', payload);
                    io.to('+' + c).emit('incoming_call', payload);
                }
            };

            members.forEach(m => {
                const mClean = clean(m.userId);
                if (mClean !== cleanFrom) {
                    const payload = {
                        signal: signalData,
                        from,
                        name,
                        isGroupCall: true,
                        groupId
                    };
                    // Emit to Raw and Clean for reliability
                    safeEmit(m.userId, payload);
                }
            });
            console.log(`✅ Group Call Signaling dispatched to ${members.length} members`);
        } catch (e) { console.error("Group call error", e); }
    });

    socket.on('disconnect', () => { });
});






