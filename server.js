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
const COMPLETION_HISTORY_MONTHS = 3;

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

app.get('/', (req, res) => {
    res.redirect(BASE_PATH);
});

const DB_PATH = path.join(__dirname, 'tasks.db');
let db;

// Date helpers
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getTodayDate() {
    return formatDate(new Date());
}

function getCompletionCutoffDate() {
    const date = new Date();
    date.setMonth(date.getMonth() - COMPLETION_HISTORY_MONTHS);
    return formatDate(date);
}

// Get the start of the current period for a task based on its frequency
function getPeriodStartDate(task) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    if (task.frequency === 'daily') {
        return formatDate(today);
    } else if (task.frequency === 'weekly') {
        const resetDay = task.reset_day ?? 0;
        const currentDay = today.getDay();
        const daysSinceReset = (currentDay - resetDay + 7) % 7;
        const periodStart = new Date(today);
        periodStart.setDate(periodStart.getDate() - daysSinceReset);
        return formatDate(periodStart);
    } else if (task.frequency === 'monthly') {
        const resetDay = task.reset_day ?? 1;
        let periodStart;
        if (today.getDate() >= resetDay) {
            periodStart = new Date(today.getFullYear(), today.getMonth(), resetDay);
        } else {
            periodStart = new Date(today.getFullYear(), today.getMonth() - 1, resetDay);
        }
        return formatDate(periodStart);
    } else if (task.frequency === 'one-time') {
        return '1970-01-01'; // Any completion ever counts
    }
    return formatDate(today);
}

// Check if a task is completed for the current period
function isTaskCompleted(task, completions) {
    const periodStart = getPeriodStartDate(task);
    return completions.some(c =>
        c.task_id === task.id && c.completed_date >= periodStart
    );
}

// Check if task was completed on a specific date
function wasCompletedOnDate(taskId, date, completions) {
    return completions.some(c => c.task_id === taskId && c.completed_date === date);
}

async function initDatabase() {
    const SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
        migrateDatabase();
    } else {
        db = new SQL.Database();
        createTables();
    }

    cleanupOldCompletions();
}

function createTables() {
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
            reset_day INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS task_completions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            completed_date TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(task_id, completed_date),
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_completions_task_date ON task_completions(task_id, completed_date)`);

    saveDatabase();
}

function migrateDatabase() {
    // Check if categories table exists
    const tableInfo = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='categories'");
    if (tableInfo.length === 0 || tableInfo[0].values.length === 0) {
        createTables();
        return;
    }

    // Check for user_id column in categories (old schema migration)
    const categoryColumns = db.exec("PRAGMA table_info(categories)");
    const hasUserId = categoryColumns[0]?.values.some(col => col[1] === 'user_id');

    if (!hasUserId) {
        const LEGACY_USER_ID = 'legacy-user-' + uuidv4();
        console.log(`Migrating database. Existing data assigned to user: ${LEGACY_USER_ID}`);
        db.run(`ALTER TABLE categories ADD COLUMN user_id TEXT`);
        db.run(`UPDATE categories SET user_id = ? WHERE user_id IS NULL`, [LEGACY_USER_ID]);
        db.run(`ALTER TABLE tasks ADD COLUMN user_id TEXT`);
        db.run(`UPDATE tasks SET user_id = ? WHERE user_id IS NULL`, [LEGACY_USER_ID]);
        saveDatabase();
    }

    // Check for reset_day column in tasks
    const taskColumns = db.exec("PRAGMA table_info(tasks)");
    const hasResetDay = taskColumns[0]?.values.some(col => col[1] === 'reset_day');

    if (!hasResetDay) {
        console.log('Migrating database: Adding reset_day column');
        db.run('ALTER TABLE tasks ADD COLUMN reset_day INTEGER');
        db.run("UPDATE tasks SET reset_day = 0 WHERE frequency = 'weekly'");
        db.run("UPDATE tasks SET reset_day = 1 WHERE frequency = 'monthly'");
        saveDatabase();
    }

    // Check if task_completions table exists
    const completionsTable = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='task_completions'");
    if (completionsTable.length === 0 || completionsTable[0].values.length === 0) {
        console.log('Migrating database: Creating task_completions table');
        db.run(`
            CREATE TABLE task_completions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER NOT NULL,
                completed_date TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(task_id, completed_date),
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
            )
        `);
        db.run(`CREATE INDEX IF NOT EXISTS idx_completions_task_date ON task_completions(task_id, completed_date)`);

        // Migrate existing completed tasks to task_completions
        const completedTasks = queryAll("SELECT id, last_completed FROM tasks WHERE completed = 1 AND last_completed IS NOT NULL");
        for (const task of completedTasks) {
            const completedDate = task.last_completed.split('T')[0];
            try {
                db.run('INSERT OR IGNORE INTO task_completions (task_id, completed_date) VALUES (?, ?)', [task.id, completedDate]);
            } catch (e) {
                // Ignore errors
            }
        }
        saveDatabase();
    } else {
        // Remove user_id from task_completions if it exists (cleanup from old schema)
        const completionColumns = db.exec("PRAGMA table_info(task_completions)");
        const hasCompletionUserId = completionColumns[0]?.values.some(col => col[1] === 'user_id');
        if (hasCompletionUserId) {
            console.log('Migrating database: Removing user_id from task_completions');
            // SQLite doesn't support DROP COLUMN, so we recreate the table
            db.run(`CREATE TABLE task_completions_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER NOT NULL,
                completed_date TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(task_id, completed_date),
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
            )`);
            db.run(`INSERT INTO task_completions_new (id, task_id, completed_date, created_at)
                    SELECT id, task_id, completed_date, created_at FROM task_completions`);
            db.run(`DROP TABLE task_completions`);
            db.run(`ALTER TABLE task_completions_new RENAME TO task_completions`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_completions_task_date ON task_completions(task_id, completed_date)`);
            saveDatabase();
        }
    }

    // Remove completed and last_completed columns from tasks if they exist
    const hasCompleted = taskColumns[0]?.values.some(col => col[1] === 'completed');
    if (hasCompleted) {
        console.log('Migrating database: Removing completed/last_completed columns from tasks');
        db.run(`CREATE TABLE tasks_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            title TEXT NOT NULL,
            frequency TEXT NOT NULL CHECK(frequency IN ('daily', 'weekly', 'monthly', 'one-time')),
            category_id INTEGER NOT NULL,
            reset_day INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
        )`);
        db.run(`INSERT INTO tasks_new (id, user_id, title, frequency, category_id, reset_day, created_at)
                SELECT id, user_id, title, frequency, category_id, reset_day, created_at FROM tasks`);
        db.run(`DROP TABLE tasks`);
        db.run(`ALTER TABLE tasks_new RENAME TO tasks`);
        saveDatabase();
    }
}

function saveDatabase() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
}

function cleanupOldCompletions() {
    const cutoffDate = getCompletionCutoffDate();
    try {
        db.run('DELETE FROM task_completions WHERE completed_date < ?', [cutoffDate]);
        saveDatabase();
        console.log(`Cleaned up completion records older than ${cutoffDate}`);
    } catch (err) {
        console.error('Error cleaning up old completions:', err);
    }
}

// Database query helpers
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

// Get all completions for a user's tasks
function getUserCompletions(userId, startDate = null) {
    const cutoff = startDate || getCompletionCutoffDate();
    return queryAll(`
        SELECT tc.task_id, tc.completed_date
        FROM task_completions tc
        JOIN tasks t ON tc.task_id = t.id
        WHERE t.user_id = ? AND tc.completed_date >= ?
    `, [userId, cutoff]);
}

// API Routes

// Get all categories
app.get(BASE_PATH + '/api/categories', (req, res) => {
    const categories = queryAll('SELECT * FROM categories WHERE user_id = ? ORDER BY name', [req.userId]);
    res.json(categories);
});

// Add category
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
            return res.status(400).json({ error: 'Category already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

// Delete category
app.delete(BASE_PATH + '/api/categories/:id', (req, res) => {
    const { id } = req.params;
    const category = queryOne('SELECT * FROM categories WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!category) {
        return res.status(404).json({ error: 'Category not found' });
    }
    runQuery('DELETE FROM tasks WHERE category_id = ? AND user_id = ?', [id, req.userId]);
    runQuery('DELETE FROM categories WHERE id = ? AND user_id = ?', [id, req.userId]);
    res.json({ success: true });
});

// Get all tasks with computed completion status
app.get(BASE_PATH + '/api/tasks', (req, res) => {
    const { category_id, include_history } = req.query;

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

    const completions = getUserCompletions(req.userId);

    // Add computed completion status
    const tasksWithStatus = tasks.map(task => ({
        ...task,
        completed: isTaskCompleted(task, completions) ? 1 : 0
    }));

    // If history requested, include completion dates
    if (include_history === 'true') {
        const completionMap = {};
        completions.forEach(c => {
            if (!completionMap[c.task_id]) completionMap[c.task_id] = [];
            completionMap[c.task_id].push(c.completed_date);
        });

        res.json({
            tasks: tasksWithStatus,
            completions: completionMap
        });
    } else {
        res.json(tasksWithStatus);
    }
});

// Add task
app.post(BASE_PATH + '/api/tasks', (req, res) => {
    const { title, frequency, category_id, reset_day } = req.body;
    if (!title || !frequency || !category_id) {
        return res.status(400).json({ error: 'Title, frequency, and category_id are required' });
    }

    const category = queryOne('SELECT * FROM categories WHERE id = ? AND user_id = ?', [category_id, req.userId]);
    if (!category) {
        return res.status(404).json({ error: 'Category not found' });
    }

    let finalResetDay = reset_day;
    if (finalResetDay === undefined || finalResetDay === null) {
        if (frequency === 'weekly') finalResetDay = 0;
        else if (frequency === 'monthly') finalResetDay = 1;
        else finalResetDay = null;
    }

    try {
        const result = runQuery(
            'INSERT INTO tasks (user_id, title, frequency, category_id, reset_day) VALUES (?, ?, ?, ?, ?)',
            [req.userId, title, frequency, category_id, finalResetDay]
        );
        const task = queryOne(`
            SELECT tasks.*, categories.name as category_name
            FROM tasks
            JOIN categories ON tasks.category_id = categories.id
            WHERE tasks.id = ?
        `, [result.lastInsertRowid]);
        res.json({ ...task, completed: 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Toggle task completion for today
app.patch(BASE_PATH + '/api/tasks/:id/toggle', (req, res) => {
    const { id } = req.params;
    const task = queryOne('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }

    const today = getTodayDate();
    const existingCompletion = queryOne(
        'SELECT * FROM task_completions WHERE task_id = ? AND completed_date = ?',
        [id, today]
    );

    if (existingCompletion) {
        // Remove completion for today
        runQuery('DELETE FROM task_completions WHERE task_id = ? AND completed_date = ?', [id, today]);
    } else {
        // Add completion for today
        runQuery('INSERT OR IGNORE INTO task_completions (task_id, completed_date) VALUES (?, ?)', [id, today]);
    }

    // Return updated completion status
    const completions = getUserCompletions(req.userId);
    const completed = isTaskCompleted(task, completions) ? 1 : 0;

    res.json({ ...task, completed });
});

// Edit task
app.patch(BASE_PATH + '/api/tasks/:id', (req, res) => {
    const { id } = req.params;
    const { title, frequency, reset_day } = req.body;

    const task = queryOne('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }

    const updates = [];
    const params = [];

    if (title !== undefined) {
        updates.push('title = ?');
        params.push(title);
    }
    if (frequency !== undefined) {
        updates.push('frequency = ?');
        params.push(frequency);
    }
    if (reset_day !== undefined) {
        updates.push('reset_day = ?');
        params.push(reset_day);
    }

    if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(id, req.userId);
    runQuery(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);

    const updatedTask = queryOne(`
        SELECT tasks.*, categories.name as category_name
        FROM tasks
        JOIN categories ON tasks.category_id = categories.id
        WHERE tasks.id = ?
    `, [id]);

    const completions = getUserCompletions(req.userId);
    const completed = isTaskCompleted(updatedTask, completions) ? 1 : 0;

    res.json({ ...updatedTask, completed });
});

// Delete task
app.delete(BASE_PATH + '/api/tasks/:id', (req, res) => {
    const { id } = req.params;
    const task = queryOne('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }
    // Completions are deleted via CASCADE
    runQuery('DELETE FROM tasks WHERE id = ? AND user_id = ?', [id, req.userId]);
    res.json({ success: true });
});

// Start server
initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}${BASE_PATH}`);
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
