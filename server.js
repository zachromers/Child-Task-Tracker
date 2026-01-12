const express = require('express');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

    // Create tables (using new naming: categories instead of children)
    db.run(`
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
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

// Get all categories
app.get('/api/categories', (req, res) => {
    const categories = queryAll('SELECT * FROM categories ORDER BY name');
    res.json(categories);
});

// Add a new category
app.post('/api/categories', (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Name is required' });
    }
    try {
        const result = runQuery('INSERT INTO categories (name) VALUES (?)', [name]);
        res.json({ id: result.lastInsertRowid, name });
    } catch (err) {
        if (err.message.includes('UNIQUE constraint')) {
            return res.status(400).json({ error: 'Category name already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

// Delete a category
app.delete('/api/categories/:id', (req, res) => {
    const { id } = req.params;
    runQuery('DELETE FROM tasks WHERE category_id = ?', [id]);
    runQuery('DELETE FROM categories WHERE id = ?', [id]);
    res.json({ success: true });
});

// Get all tasks (optionally filtered by category)
app.get('/api/tasks', (req, res) => {
    const { category_id } = req.query;
    let tasks;
    if (category_id) {
        tasks = queryAll(`
            SELECT tasks.*, categories.name as category_name
            FROM tasks
            JOIN categories ON tasks.category_id = categories.id
            WHERE category_id = ?
            ORDER BY tasks.created_at DESC
        `, [category_id]);
    } else {
        tasks = queryAll(`
            SELECT tasks.*, categories.name as category_name
            FROM tasks
            JOIN categories ON tasks.category_id = categories.id
            ORDER BY categories.name, tasks.created_at DESC
        `);
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
                runQuery('UPDATE tasks SET completed = 0 WHERE id = ?', [task.id]);
                task.completed = 0;
            }
        }
        return task;
    });

    res.json(tasks);
});

// Add a new task
app.post('/api/tasks', (req, res) => {
    const { title, frequency, category_id } = req.body;
    if (!title || !frequency || !category_id) {
        return res.status(400).json({ error: 'Title, frequency, and category_id are required' });
    }
    try {
        const result = runQuery('INSERT INTO tasks (title, frequency, category_id) VALUES (?, ?, ?)', [title, frequency, category_id]);
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

// Toggle task completion
app.patch('/api/tasks/:id/toggle', (req, res) => {
    const { id } = req.params;
    const task = queryOne('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }
    const newCompleted = task.completed ? 0 : 1;
    const lastCompleted = newCompleted ? new Date().toISOString() : null;
    runQuery('UPDATE tasks SET completed = ?, last_completed = ? WHERE id = ?', [newCompleted, lastCompleted, id]);
    res.json({ ...task, completed: newCompleted, last_completed: lastCompleted });
});

// Delete a task
app.delete('/api/tasks/:id', (req, res) => {
    const { id } = req.params;
    runQuery('DELETE FROM tasks WHERE id = ?', [id]);
    res.json({ success: true });
});

// Start server after database initialization
initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
