const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

let db;

async function initDB() {
    db = await open({
        filename: path.join(__dirname, 'wavechat.db'),
        driver: sqlite3.Database
    });

    console.log('✅ Connected to SQLite Database (wavechat.db)');

    // Create Tables
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT,
            phone TEXT UNIQUE,
            image TEXT,
            lastSeen DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chatId TEXT,
            sender TEXT,
            text TEXT,
            type TEXT,
            mediaUrl TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS status (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId TEXT,
            userName TEXT,
            type TEXT,
            content TEXT,
            bgColor TEXT,
            mediaUrl TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            expiresAt DATETIME
        );

        CREATE TABLE IF NOT EXISTS call_recordings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            callId TEXT,
            callerId TEXT,
            receiverId TEXT,
            startTime DATETIME DEFAULT CURRENT_TIMESTAMP,
            endTime DATETIME,
            duration INTEGER,
            recordingUrl TEXT
        );

        CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            icon TEXT,
            description TEXT,
            createdBy TEXT NOT NULL,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS group_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            groupId TEXT NOT NULL,
            userId TEXT NOT NULL,
            isAdmin INTEGER DEFAULT 0,
            joinedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (groupId) REFERENCES groups(id)
        );

        CREATE TABLE IF NOT EXISTS group_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            groupId TEXT NOT NULL,
            sender TEXT NOT NULL,
            senderName TEXT NOT NULL,
            text TEXT,
            type TEXT DEFAULT 'text',
            mediaUrl TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (groupId) REFERENCES groups(id)
        );
    `);

    return db;
}

module.exports = { initDB, getDB: () => db };
