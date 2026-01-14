const express = require('express');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;
const BASE_PATH = '/tasks';
const COOKIE_NAME = 'task_tracker_user';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // 1 year
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Trust proxy for reverse proxy setups (nginx, etc.)
if (IS_PRODUCTION) {
    app.set('trust proxy', 1);
}

app.use(express.json());
app.use(cookieParser());

// Middleware to ensure user has a cookie
app.use((req, res, next) => {
    if (!req.cookies[COOKIE_NAME]) {
        const userId = uuidv4();
        res.cookie(COOKIE_NAME, userId, {
            maxAge: COOKIE_MAX_AGE,
            httpOnly: true,
            sameSite: 'lax',
            secure: IS_PRODUCTION
        });
        req.userId = userId;
    } else {
        req.userId = req.cookies[COOKIE_NAME];
    }
    next();
});

app.use(BASE_PATH, express.static(path.join(__dirname, 'public')));

// Redirect root to /tasks
app.get('/', (req, res) => {
    res.redirect(BASE_PATH);
});

const DB_PATH = path.join(__dirname, 'tasks.db');
let db;

async function initDatabase() {
    const SQL = await initSqlJs();

    // Load existing database or create new one
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    // Check if tables exist and need migration
    const tableInfo = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='categories'");
    const tablesExist = tableInfo.length > 0 && tableInfo[0].values.length > 0;

    if (tablesExist) {
        // Check if user_id column exists in categories
        const categoryColumns = db.exec("PRAGMA table_info(categories)");
        const hasUserId = categoryColumns[0]?.values.some(col => col[1] === 'user_id');

        if (!hasUserId) {
            // Migrate existing tables - add user_id column
            const LEGACY_USER_ID = 'legacy-user-' + uuidv4();
            console.log(`Migrating database. Existing data assigned to user: ${LEGACY_USER_ID}`);

            // Add user_id to categories
            db.run(`ALTER TABLE categories ADD COLUMN user_id TEXT`);
            db.run(`UPDATE categories SET user_id = ? WHERE user_id IS NULL`, [LEGACY_USER_ID]);

            // Add user_id to tasks
            db.run(`ALTER TABLE tasks ADD COLUMN user_id TEXT`);
            db.run(`UPDATE tasks SET user_id = ? WHERE user_id IS NULL`, [LEGACY_USER_ID]);

            saveDatabase();
        }
    } else {
        // Create tables with user_id support
        db.run(`
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, name)
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                title TEXT NOT NULL,
                frequency TEXT NOT NULL CHECK(frequency IN ('daily', 'weekly', 'monthly', 'one-time')),
                category_id INTEGER NOT NULL,
                completed INTEGER DEFAULT 0,
                last_completed DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
            )
        `);

        saveDatabase();
    }
}

function saveDatabase() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
}

// Helper to convert sql.js results to array of objects
function queryAll(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

function queryOne(sql, params = []) {
    const results = queryAll(sql, params);
    return results.length > 0 ? results[0] : null;
}

function runQuery(sql, params = []) {
    db.run(sql, params);
    saveDatabase();
    return { lastInsertRowid: db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] };
}

// API Routes

// Get all categories for current user
app.get(BASE_PATH + '/api/categories', (req, res) => {
    const categories = queryAll('SELECT * FROM categories WHERE user_id = ? ORDER BY name', [req.userId]);
    res.json(categories);
});

// Add a new category for current user
app.post(BASE_PATH + '/api/categories', (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Name is required' });
    }
    try {
        const result = runQuery('INSERT INTO categories (user_id, name) VALUES (?, ?)', [req.userId, name]);
        res.json({ id: result.lastInsertRowid, name });
    } catch (err) {
        if (err.message.includes('UNIQUE constraint')) {
            return res.status(400).json({ error: 'Category name already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

// Delete a category (only if owned by current user)
app.delete(BASE_PATH + '/api/categories/:id', (req, res) => {
    const { id } = req.params;
    // Verify ownership
    const category = queryOne('SELECT * FROM categories WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!category) {
        return res.status(404).json({ error: 'Category not found' });
    }
    runQuery('DELETE FROM tasks WHERE category_id = ? AND user_id = ?', [id, req.userId]);
    runQuery('DELETE FROM categories WHERE id = ? AND user_id = ?', [id, req.userId]);
    res.json({ success: true });
});

// Get all tasks for current user (optionally filtered by category)
app.get(BASE_PATH + '/api/tasks', (req, res) => {
    const { category_id } = req.query;
    let tasks;
    if (category_id) {
        tasks = queryAll(`
            SELECT tasks.*, categories.name as category_name
            FROM tasks
            JOIN categories ON tasks.category_id = categories.id
            WHERE tasks.user_id = ? AND category_id = ?
            ORDER BY tasks.created_at DESC
        `, [req.userId, category_id]);
    } else {
        tasks = queryAll(`
            SELECT tasks.*, categories.name as category_name
            FROM tasks
            JOIN categories ON tasks.category_id = categories.id
            WHERE tasks.user_id = ?
            ORDER BY categories.name, tasks.created_at DESC
        `, [req.userId]);
    }

    // Check if tasks need to be reset based on frequency
    const now = new Date();
    tasks = tasks.map(task => {
        if (task.completed && task.last_completed) {
            const lastCompleted = new Date(task.last_completed);
            let shouldReset = false;

            if (task.frequency === 'daily') {
                shouldReset = now.toDateString() !== lastCompleted.toDateString();
            } else if (task.frequency === 'weekly') {
                const weekAgo = new Date(now);
                weekAgo.setDate(weekAgo.getDate() - 7);
                shouldReset = lastCompleted < weekAgo;
            } else if (task.frequency === 'monthly') {
                const monthAgo = new Date(now);
                monthAgo.setMonth(monthAgo.getMonth() - 1);
                shouldReset = lastCompleted < monthAgo;
            }

            if (shouldReset && task.frequency !== 'one-time') {
                runQuery('UPDATE tasks SET completed = 0 WHERE id = ? AND user_id = ?', [task.id, req.userId]);
                task.completed = 0;
            }
        }
        return task;
    });

    res.json(tasks);
});

// Add a new task for current user
app.post(BASE_PATH + '/api/tasks', (req, res) => {
    const { title, frequency, category_id } = req.body;
    if (!title || !frequency || !category_id) {
        return res.status(400).json({ error: 'Title, frequency, and category_id are required' });
    }
    // Verify category ownership
    const category = queryOne('SELECT * FROM categories WHERE id = ? AND user_id = ?', [category_id, req.userId]);
    if (!category) {
        return res.status(404).json({ error: 'Category not found' });
    }
    try {
        const result = runQuery('INSERT INTO tasks (user_id, title, frequency, category_id) VALUES (?, ?, ?, ?)', [req.userId, title, frequency, category_id]);
        const task = queryOne(`
            SELECT tasks.*, categories.name as category_name
            FROM tasks
            JOIN categories ON tasks.category_id = categories.id
            WHERE tasks.id = ?
        `, [result.lastInsertRowid]);
        res.json(task);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Toggle task completion (only if owned by current user)
app.patch(BASE_PATH + '/api/tasks/:id/toggle', (req, res) => {
    const { id } = req.params;
    const task = queryOne('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }
    const newCompleted = task.completed ? 0 : 1;
    const lastCompleted = newCompleted ? new Date().toISOString() : null;
    runQuery('UPDATE tasks SET completed = ?, last_completed = ? WHERE id = ? AND user_id = ?', [newCompleted, lastCompleted, id, req.userId]);
    res.json({ ...task, completed: newCompleted, last_completed: lastCompleted });
});

// Delete a task (only if owned by current user)
app.delete(BASE_PATH + '/api/tasks/:id', (req, res) => {
    const { id } = req.params;
    const task = queryOne('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }
    runQuery('DELETE FROM tasks WHERE id = ? AND user_id = ?', [id, req.userId]);
    res.json({ success: true });
});

// Start server after database initialization
initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}${BASE_PATH}`);
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
