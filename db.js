const mysql = require('mysql2/promise');
require('dotenv').config();

let pool;

// Wrapper class to mimic SQLite API for MySQL
class MySQLWrapper {
    constructor(pool) {
        this.pool = pool;
    }

    async exec(sql) {
        // Handle multiple statements if needed, or just execute
        return await this.pool.query(sql);
    }

    async run(sql, params = []) {
        const [result] = await this.pool.execute(sql, params);
        return {
            lastID: result.insertId,
            changes: result.affectedRows
        };
    }

    async get(sql, params = []) {
        const [rows] = await this.pool.execute(sql, params);
        return rows[0];
    }

    async all(sql, params = []) {
        const [rows] = await this.pool.execute(sql, params);
        return rows;
    }
}

async function initDB() {
    // Check if MySQL credentials are provided
    if (process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME) {
        console.log('🔌 Connecting to Hostinger MySQL Database...');
        try {
            pool = mysql.createPool({
                host: process.env.DB_HOST,
                user: process.env.DB_USER,
                password: process.env.DB_PASSWORD,
                database: process.env.DB_NAME,
                waitForConnections: true,
                connectionLimit: 10,
                queueLimit: 0,
                multipleStatements: true, // Allow multiple queries in exec
                connectTimeout: 10000 // 10s timeout
            });

            // Verify connection strictly before proceeding
            const connection = await pool.getConnection(); // Try to get a connection
            await connection.ping(); // Ping to ensure it's alive
            connection.release(); // Release it back

            const db = new MySQLWrapper(pool);
            console.log('✅ Connected to Hostinger MySQL Database (Verified)!');

            // Create Tables (MySQL syntax compatible)
            // Note: INT PRIMARY KEY AUTO_INCREMENT is slightly different from SQLite INTEGER PRIMARY KEY AUTOINCREMENT
            // But we will use IF NOT EXISTS
            await createTables(db);

            return db;
        } catch (err) {
            console.error('❌ MySQL Connection Failed:', err.message);
            console.log('⚠️ Falling back to Local SQLite...'); // Explicit fallback log
        }
    }

    // Fallback to SQLite if MySQL fails or variables missing
    const sqlite3 = require('sqlite3');
    const { open } = require('sqlite');
    const path = require('path');

    console.log('📂 Using Local SQLite Database...');
    const db = await open({
        filename: path.join(__dirname, 'wavechat.db'),
        driver: sqlite3.Database
    });

    await createTables(db);
    return db;
}

// Helper to create tables (Works for both mostly, but adjustments might be needed for AUTO_INCREMENT)
async function createTables(db) {
    // MySQL uses AUTO_INCREMENT, SQLite uses AUTOINCREMENT
    // We try to catch errors or assume setup is done via phpMyAdmin mainly
    // But let's try a compatible schema

    const isMySQL = db instanceof MySQLWrapper;
    const autoInc = isMySQL ? 'AUTO_INCREMENT' : 'AUTOINCREMENT';
    const primaryKey = isMySQL ? `INT PRIMARY KEY ${autoInc}` : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    const textType = isMySQL ? 'TEXT' : 'TEXT';

    // Users
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id VARCHAR(255) PRIMARY KEY,
            name TEXT,
            phone VARCHAR(255) UNIQUE,
            image TEXT,
            lastSeen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Messages
    await db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id ${primaryKey},
            chatId VARCHAR(255),
            sender VARCHAR(255),
            text TEXT,
            type VARCHAR(50),
            mediaUrl TEXT,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Status
    await db.exec(`
         CREATE TABLE IF NOT EXISTS status (
            id ${primaryKey},
            userId VARCHAR(255),
            userName TEXT,
            type VARCHAR(50),
            content TEXT,
            bgColor VARCHAR(50),
            mediaUrl TEXT,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expiresAt DATETIME
        );
    `);

    // Groups
    await db.exec(`
        CREATE TABLE IF NOT EXISTS groups_table (
            id VARCHAR(255) PRIMARY KEY,
            name TEXT,
            icon TEXT,
            description TEXT,
            createdBy VARCHAR(255),
            admins TEXT, -- JSON array of admin IDs
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Group Members
    await db.exec(`
        CREATE TABLE IF NOT EXISTS group_members (
            id ${primaryKey},
            groupId VARCHAR(255),
            userId VARCHAR(255),
            role VARCHAR(50) DEFAULT 'member',
            joinedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

module.exports = { initDB, getDB: () => pool ? new MySQLWrapper(pool) : require('sqlite').open() };
