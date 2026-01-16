const express = require('express');
const http = require('http');
const path = require('path'); // Added path module
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer'); // Added multer here
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
// Mount specific directories FIRST for better performance/reliability
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

// Root route for health check
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'WaveChat Backend API',
        version: '1.0.0'
    });
});

// Initialize Database before starting server
initDB().then(database => {
    db = database;
    const PORT = process.env.PORT || 5000;
    // Connect to 0.0.0.0 used for network access
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT} with SQLite`);
        console.log(`📡 Accessible on Network: http://<YOUR_PC_IP>:${PORT}`);
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`❌ Port ${PORT} is already in use. Try killing the process or changing the port.`);
        } else {
            console.error('❌ Server Error:', err);
        }
    });
}).catch(err => {
    console.error('❌ Database Initialization Failed:', err);
});

const fs = require('fs');

// --- DEBUG LOGGING UTILITY ---
const logToFile = (msg) => {
    const log = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    fs.appendFileSync(path.join(__dirname, 'debug_logs.txt'), log);
};

// --- GLOBAL ERROR HANDLERS ---
process.on('uncaughtException', (err) => {
    console.error('🔥 UNCAUGHT EXCEPTION:', err);
    logToFile(`🔥 UNCAUGHT EXCEPTION: ${err.message}`);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

// --- API ENDPOINTS ---

// Register/Update User
app.post('/api/users/register', async (req, res) => {
    let { id, name, phone, image } = req.body;
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    try {
        await db.run(
            "INSERT INTO users (id, name, phone, image) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), phone=VALUES(phone), image=VALUES(image), lastSeen=CURRENT_TIMESTAMP",
            [id, name, cleanPhone, image]
        );
        res.status(200).json({ success: true });
    } catch (err) {
        console.error(err);
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
        console.error("Error fetching messages:", err);
        res.status(500).json({ error: err.message });
    }
});

// Get Chats List for a User
app.get('/api/chats/:userId', async (req, res) => {
    const userId = req.params.userId;
    try {
        // 1. Get all recent messages for chats involving this user
        // We use a subquery to get the latest message per chat
        // Helper to normalize the ID from the DB on-the-fly if needed
        const clean = (id) => id.toString().replace(/\D/g, '').slice(-10);
        const getNormChatId = (cid) => {
            const p = cid.split('_');
            if (p.length === 2) return p.map(clean).sort().join('_');
            return cid;
        };

        const msgQuery = `
            SELECT * FROM messages 
            WHERE id IN (
                SELECT MAX(id) 
                FROM messages 
                WHERE chatId LIKE '%' || ? || '%'
                GROUP BY chatId
            )
            ORDER BY timestamp DESC
        `;
        const rawMessages = await db.all(msgQuery, [userId]);

        const uniqueChats = [];
        const seenChats = new Set();

        for (const msg of rawMessages) {
            const normCid = getNormChatId(msg.chatId);
            if (seenChats.has(normCid)) continue;
            seenChats.add(normCid);

            const p = normCid.split('_');
            const otherId = p.find(id => id !== clean(userId));

            if (!otherId) continue;

            const user = await db.get("SELECT name, image, id FROM users WHERE phone LIKE '%' || ? OR id = ?", [otherId, otherId]);

            if (user) {
                uniqueChats.push({
                    chatId: normCid,
                    text: msg.text,
                    timestamp: msg.timestamp,
                    otherUserName: user.name,
                    otherUserImage: user.image,
                    otherUserId: user.id || user.phone,
                    unread: 0,
                    online: false
                });
            } else {
                uniqueChats.push({
                    chatId: normCid,
                    text: msg.text,
                    timestamp: msg.timestamp,
                    otherUserName: otherId,
                    otherUserImage: `https://ui-avatars.com/api/?name=${encodeURIComponent(otherId)}&background=00a884&color=fff`,
                    otherUserId: otherId,
                    unread: 0,
                    online: false
                });
            }
        }

        res.status(200).json(uniqueChats);
    } catch (err) {
        console.error("Error in getUserChats:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- ADMIN ENDPOINTS ---

app.get('/api/admin/users', async (req, res) => {
    try {
        const rows = await db.all("SELECT * FROM users");
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/messages', async (req, res) => {
    try {
        const rows = await db.all("SELECT * FROM messages ORDER BY timestamp DESC LIMIT 500");
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const tableMap = { 'users': 'users', 'messages': 'messages', 'status': 'status' };
    const table = tableMap[type];
    if (!table) return res.status(400).json({ error: "Invalid type" });
    try {
        await db.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
        res.status(200).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Post Status
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
            timestamp: new Date().toISOString() // Send exact time
        };

        // Broadcast to all connected clients
        io.emit('new_status', newStatus);

        res.status(200).json({ success: true, status: newStatus });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- GROUP ENDPOINTS ---

// Create Group
app.post('/api/groups', async (req, res) => {
    const { id, name, icon, createdBy, members } = req.body;
    try {
        // Create group
        await db.run(
            "INSERT INTO groups (id, name, icon, createdBy) VALUES (?, ?, ?, ?)",
            [id, name, icon, createdBy]
        );

        // Add creator as admin
        await db.run(
            "INSERT INTO group_members (groupId, userId, isAdmin) VALUES (?, ?, 1)",
            [id, createdBy]
        );

        // Add other members
        for (const memberId of members) {
            await db.run(
                "INSERT INTO group_members (groupId, userId, isAdmin) VALUES (?, ?, 0)",
                [id, memberId]
            );
        }

        res.status(200).json({ success: true, groupId: id });
    } catch (err) {
        console.error('Group creation error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get User's Groups
app.get('/api/groups/user/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const groups = await db.all(`
            SELECT g.*, 
                   (SELECT COUNT(*) FROM group_members WHERE groupId = g.id) as memberCount,
                   (SELECT text FROM group_messages WHERE groupId = g.id ORDER BY timestamp DESC LIMIT 1) as lastMessage,
                   (SELECT timestamp FROM group_messages WHERE groupId = g.id ORDER BY timestamp DESC LIMIT 1) as lastMessageTime
            FROM groups g
            INNER JOIN group_members gm ON g.id = gm.groupId
            WHERE gm.userId = ?
            ORDER BY g.createdAt DESC
        `, [userId]);

        res.status(200).json(groups);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Group Messages
app.get('/api/groups/:groupId/messages', async (req, res) => {
    const { groupId } = req.params;
    try {
        const messages = await db.all(
            "SELECT * FROM group_messages WHERE groupId = ? ORDER BY timestamp ASC",
            [groupId]
        );
        res.status(200).json(messages);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Send Group Message
app.post('/api/groups/:groupId/messages', async (req, res) => {
    const { groupId } = req.params;
    const { sender, senderName, text, type, mediaUrl } = req.body;

    try {
        const result = await db.run(
            "INSERT INTO group_messages (groupId, sender, senderName, text, type, mediaUrl) VALUES (?, ?, ?, ?, ?, ?)",
            [groupId, sender, senderName, text, type || 'text', mediaUrl]
        );

        const message = {
            id: result.lastID,
            groupId,
            sender,
            senderName,
            text,
            type: type || 'text',
            mediaUrl,
            timestamp: new Date().toISOString()
        };

        // Broadcast to all group members via Socket.IO
        io.to(groupId).emit('group_message', message);

        res.status(200).json(message);
    } catch (err) {
        console.error('Group message error:', err);
        res.status(500).json({ error: err.message });
    }
});

// --- CALL RECORDING ---
// --- FILE UPLOADS ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dest = path.join(__dirname, 'public/uploads');
        cb(null, dest);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `media_${Date.now()}${ext}`);
    }
});
const upload = multer({ storage });

// General Media Upload
app.post('/api/upload', (req, res) => {
    upload.single('file')(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            console.error('❌ Multer Error:', err);
            return res.status(500).json({ error: err.message });
        } else if (err) {
            console.error('❌ Unknown Upload Error:', err);
            return res.status(500).json({ error: 'Internal Server Error' });
        }

        if (!req.file) {
            console.error('⚠️ Upload Attempt Failed: No file provided');
            return res.status(400).json({ error: "No file uploaded" });
        }

        const fileUrl = `/uploads/${req.file.filename}`;
        console.log(`✅ File Uploaded successfully: ${fileUrl}`);
        res.json({ url: fileUrl });
    });
});

// Recording Storage
const recordingStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'public/recordings')),
    filename: (req, file, cb) => cb(null, `call_${Date.now()}.webm`)
});
const uploadRecording = multer({ storage: recordingStorage });

app.post('/api/calls/record', uploadRecording.single('audio'), async (req, res) => {
    const { callId, callerId, receiverId, duration } = req.body;
    const recordingUrl = req.file ? `/recordings/${req.file.filename}` : null;

    try {
        await db.run(
            "INSERT INTO call_recordings (callId, callerId, receiverId, duration, recordingUrl, endTime) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
            [callId, callerId, receiverId, duration, recordingUrl]
        );
        res.status(200).json({ success: true, url: recordingUrl });
    } catch (err) {
        console.error("Recording Save Error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/recordings', async (req, res) => {
    try {
        const rows = await db.all("SELECT * FROM call_recordings ORDER BY startTime DESC");
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/status', async (req, res) => {
    try {
        const rows = await db.all("SELECT * FROM status WHERE expiresAt > CURRENT_TIMESTAMP ORDER BY timestamp DESC");
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/connections', (req, res) => {
    const rooms = io.sockets.adapter.rooms;
    const connections = Array.from(rooms.keys())
        .filter(k => k.length < 20) // Filter out socket IDs
        .map(k => ({ userId: k, count: rooms.get(k).size }));
    res.json(connections);
});

// --- SOCKET.IO REAL-TIME ---
io.on('connection', (socket) => {
    logToFile(`🔌 New Connection: ${socket.id}`);

    socket.on('join_chat', (chatId) => {
        socket.join(chatId);
        console.log(`📡 User ${socket.id} joined room: ${chatId}`);
    });

    socket.on('register', (userId) => {
        logToFile(`📝 Register Request: ${userId} from ${socket.id}`);
        console.log(`📡 [DEBUG] Register Attempt: ${userId} from ${socket.id}`);
        if (!userId) {
            console.warn('⚠️ [DEBUG] Register failed: No userId provided');
            return;
        }

        // Normalize to last 10 digits for consistent room naming
        const normalized = userId.toString().replace(/\D/g, '').slice(-10);

        // Join both original and normalized rooms for compatibility
        socket.join(userId); // Original (for backward compatibility)

        if (normalized.length === 10 && normalized !== userId) {
            socket.join(normalized); // Normalized 10-digit
            logToFile(`✅ User ${userId} joined normalized room: ${normalized}`);
            console.log(`👤 [DEBUG] User joined rooms: [${userId}, ${normalized}]`);
        } else {
            console.log(`👤 User registered: ${userId}`);
        }
    });

    socket.on('send_message', async (data) => {
        logToFile(`📨 Message from ${data.sender} in ${data.chatId}: ${data.text}`);
        console.log('📨 [DEBUG] Incoming send_message:', JSON.stringify(data));
        const { chatId, sender, text, type, mediaUrl } = data;

        if (!chatId || !sender) {
            console.error('❌ [DEBUG] Message rejected: Missing chatId or sender');
            return;
        }

        const clean = (id) => id.toString().replace(/\D/g, '').slice(-10);
        const normChatId = chatId.split('_').map(clean).sort().join('_');

        try {
            const result = await db.run(
                "INSERT INTO messages (chatId, sender, text, type, mediaUrl) VALUES (?, ?, ?, ?, ?)",
                [normChatId, sender, text, type, mediaUrl]
            );

            const newMessage = {
                id: result.lastID,
                ...data,
                chatId: normChatId, // Override with normalized
                timestamp: new Date().toISOString()
            };

            // --- SMART DELIVERY: Use 10-digit normalized rooms ---
            const clean = (id) => id.toString().replace(/\D/g, '').slice(-10);
            const normSender = clean(sender);
            const parts = chatId.split('_');

            if (parts.length === 2) {
                const normParts = parts.map(clean);
                const normReceiver = normParts.find(p => p !== normSender);

                logToFile(`🚀 Dispatching msg ${newMessage.id} to Sender: ${normSender}, Receiver: ${normReceiver}`);

                // 1. Send to Chat Rooms
                io.to(chatId).emit('receive_message', newMessage);
                const reverseId = `${parts[1]}_${parts[0]}`;
                io.to(reverseId).emit('receive_message', newMessage);

                // 2. Send to Receiver's personal room (Normalized)
                if (normReceiver) {
                    io.to(normReceiver).emit('receive_message', newMessage);
                }

                // 3. Send to Sender's personal room (Normalized) for sync
                io.to(normSender).emit('receive_message', newMessage);
            }

            console.log(`📢 Sent message ${newMessage.id} in chat ${chatId}`);

        } catch (err) {
            console.error('❌ Insert Error:', err);
            logToFile(`❌ DB Insert Error: ${err.message}`);
        }
    });

    // --- DELETE CHAT (New Feature) ---
    socket.on('delete_chat', async (chatId) => {
        console.log('🗑️ Deleting chat history for:', chatId);
        try {
            await db.run("DELETE FROM messages WHERE chatId = ?", [chatId]);

            // Also try deleting reverse ID
            const parts = chatId.split('_');
            if (parts.length === 2) {
                const reverseId = `${parts[1]}_${parts[0]}`;
                await db.run("DELETE FROM messages WHERE chatId = ?", [reverseId]);
            }

            // Notify users to clear their UI
            io.to(chatId).emit('chat_deleted', chatId);
            if (parts.length === 2) {
                io.to(parts[0]).emit('chat_deleted', chatId);
                io.to(parts[1]).emit('chat_deleted', chatId);
            }
            console.log('✅ Chat deleted successfully');
        } catch (err) {
            console.error('❌ Delete Error:', err);
        }
    });

    // --- CALLING SIGNALING ---
    socket.on('register_for_calls', (userId) => {
        socket.join(userId);
        console.log(`📞 User ${userId} registered for calls. Rooms:`, Array.from(socket.rooms));
    });

    socket.on('call_user', (data) => {
        const { callerId, receiverId, channelId, type } = data;

        // Normalize to last 10 digits for consistent matching
        const clean = (id) => id.toString().replace(/\D/g, '').slice(-10);
        const normalizedReceiver = clean(receiverId);

        console.log(`📞 [SIGNAL] Call from ${callerId} to ${receiverId} → Normalized: ${normalizedReceiver} (Type: ${type})`);

        const rooms = io.sockets.adapter.rooms;
        const receiverRoom = rooms.get(normalizedReceiver);
        const isOnline = receiverRoom && receiverRoom.size > 0;

        console.log(`📡 Receiver ${normalizedReceiver} Status: ${isOnline ? 'ONLINE' : 'OFFLINE'}`);

        if (isOnline) {
            io.to(normalizedReceiver).emit('incoming_call', data);
            console.log(`✅ Signal sent to ${normalizedReceiver}`);
        } else {
            console.log(`❌ Signal failed: ${normalizedReceiver} not found in rooms.`);
        }
    });

    socket.on('end_call', (data) => {
        const { receiverId } = data;
        io.to(receiverId).emit('call_ended', data);
        console.log(`📞 Call end signal sent to ${receiverId}`);
    });

    socket.on('reject_call', (data) => {
        const { callerId } = data;
        io.to(callerId).emit('call_rejected', data);
        console.log(`📞 Call reject signal sent to ${callerId}`);
    });

    // --- TYPING INDICATOR ---
    socket.on('typing', (data) => {
        const { chatId, userId } = data;
        socket.to(chatId).emit('typing', { chatId, userId });

        // Also emit to the receiver's private room just in case
        const targetUserId = chatId.split('_').find(id => id !== userId);
        if (targetUserId) {
            socket.to(targetUserId).emit('typing', { chatId, userId });
        }
    });

    socket.on('stop_typing', (data) => {
        const { chatId, userId } = data;
        socket.to(chatId).emit('stop_typing', { chatId, userId });

        const targetUserId = chatId.split('_').find(id => id !== userId);
        if (targetUserId) {
            socket.to(targetUserId).emit('stop_typing', { chatId, userId });
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});



