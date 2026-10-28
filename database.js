const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../data');
const dbPath = path.join(dataDir, 'tasks.db');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize database
function initializeDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) return reject(err);
      
      db.serialize(() => {
        db.run(`
          CREATE TABLE IF NOT EXISTS threads (
            thread_id TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL,
            category_id TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT DEFAULT 'Open',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_message_timestamp INTEGER,
            last_reminder_timestamp INTEGER
          )
        `);

        db.all(`PRAGMA table_info(threads)`, (err, rows) => {
          if (!err && Array.isArray(rows)) {
            const hasLastMessage = rows.some(r => r.name === 'last_message_timestamp');
            const hasLastReminder = rows.some(r => r.name === 'last_reminder_timestamp');
            if (!hasLastMessage) {
              db.run(`ALTER TABLE threads ADD COLUMN last_message_timestamp INTEGER`);
            }
            if (!hasLastReminder) {
              db.run(`ALTER TABLE threads ADD COLUMN last_reminder_timestamp INTEGER`);
            }
          }
        });

        db.run(`
          CREATE TABLE IF NOT EXISTS departments (
            category_id TEXT PRIMARY KEY,
            category_name TEXT NOT NULL,
            notification_channel_id TEXT NOT NULL,
            role_id TEXT
          )`
        );

        db.all(`PRAGMA table_info(departments)`, (err, rows) => {
          if (!err) {
            const hasRoleCol = Array.isArray(rows) && rows.some(r => r.name === 'role_id');
            if (!hasRoleCol) {
              db.run(`ALTER TABLE departments ADD COLUMN role_id TEXT`);
            }
          }
        });

        db.run(`
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
          )
        `);

        db.run(`
          CREATE TABLE IF NOT EXISTS thread_assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id TEXT NOT NULL,
            assigned_user_id TEXT,
            assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(thread_id) REFERENCES threads(thread_id)
          )
        `);

        db.run(`
          CREATE TABLE IF NOT EXISTS point_awards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            user_display_name TEXT NOT NULL,
            awarded_by_id TEXT NOT NULL,
            awarded_by_name TEXT NOT NULL,
            points INTEGER NOT NULL,
            department_id TEXT,
            department_name TEXT,
            note TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        db.all(`PRAGMA table_info(point_awards)`, (err, rows) => {
          if (!err && Array.isArray(rows) && rows.some(r => r.name === 'task_count')) {
            // Older databases carry a task_count column that's no longer used; drop it.
            db.run(`ALTER TABLE point_awards DROP COLUMN task_count`, (dropErr) => {
              if (dropErr) {
                console.error('Could not drop legacy task_count column:', dropErr);
              }
            });
          }
        });

        db.run(`
          CREATE TABLE IF NOT EXISTS leaderboard_archives (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            period_key TEXT NOT NULL,
            scope TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        db.run(`CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_threads_category_status ON threads(category_id, status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_point_awards_user_dept_created ON point_awards(user_id, department_id, created_at)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_point_awards_created ON point_awards(created_at)`);
      });

      resolve(db);
    });
  });
}

// Get database connection
function getDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) return reject(err);
      resolve(db);
    });
  });
}

// Add or update thread
function updateThread(threadId, channelId, categoryId, title, status = 'Open') {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.run(
      `INSERT INTO threads (thread_id, channel_id, category_id, title, status, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(thread_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         category_id = excluded.category_id,
         title = excluded.title,
         status = excluded.status,
         updated_at = datetime('now')`,
      [threadId, channelId, categoryId, title, status],
      (err) => {
        db.close();
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Get all threads currently marked Open
function getOpenThreads() {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.all(
      `SELECT * FROM threads WHERE status = 'Open'`,
      [],
      (err, rows) => {
        db.close();
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

// Get all open threads by category
function getOpenThreadsByCategory(categoryId) {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.all(
      `SELECT * FROM threads WHERE category_id = ? AND status = 'Open' ORDER BY created_at DESC`,
      [categoryId],
      (err, rows) => {
        db.close();
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

// Get all claimed threads by category
function getClaimedThreadsByCategory(categoryId) {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.all(
      `SELECT * FROM threads WHERE category_id = ? AND status = 'Claimed' ORDER BY created_at DESC`,
      [categoryId],
      (err, rows) => {
        db.close();
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

// Update thread status
function updateThreadStatus(threadId, status) {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.run(
      `UPDATE threads SET status = ?, updated_at = datetime('now') WHERE thread_id = ?`,
      [status, threadId],
      (err) => {
        db.close();
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Register department
function registerDepartment(categoryId, categoryName, notificationChannelId, roleId = null) {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.run(
      `INSERT OR REPLACE INTO departments (category_id, category_name, notification_channel_id, role_id)
       VALUES (?, ?, ?, ?)`,
      [categoryId, categoryName, notificationChannelId, roleId],
      (err) => {
        db.close();
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Get full department settings
function getDepartment(categoryId) {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.get(
      `SELECT * FROM departments WHERE category_id = ?`,
      [categoryId],
      (err, row) => {
        db.close();
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

// Set global notification interval
function setNotificationInterval(intervalMinutes) {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.run(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('notification_interval_minutes', ?)`,
      [intervalMinutes.toString()],
      (err) => {
        db.close();
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Get global notification interval
function getNotificationInterval() {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.get(
      `SELECT value FROM settings WHERE key = 'notification_interval_minutes'`,
      (err, row) => {
        db.close();
        if (err) reject(err);
        else resolve(parseInt(row?.value || 360));
      }
    );
  });
}

// Get all departments with their notification settings
function getAllDepartments() {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.all(
      `SELECT * FROM departments`,
      (err, rows) => {
        db.close();
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

// Check if should notify based on global interval
function shouldNotify() {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    const intervalMinutes = await getNotificationInterval();
    
    db.get(
      `SELECT value FROM settings WHERE key = 'last_notification_time'`,
      (err, row) => {
        db.close();
        if (err) reject(err);
        else {
          if (!row || !row.value) {
            resolve(true);
          } else {
            const lastTime = parseInt(row.value, 10);
            const now = Date.now();
            if (isNaN(lastTime)) {
              resolve(true);
              return;
            }
            const diffMinutes = (now - lastTime) / (1000 * 60);
            resolve(diffMinutes >= intervalMinutes);
          }
        }
      }
    );
  });
}

// Get last notification time
function getLastNotificationTime() {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.get(
      `SELECT value FROM settings WHERE key = 'last_notification_time'`,
      [],
      (err, row) => {
        db.close();
        if (err) reject(err);
        else resolve(row ? parseInt(row.value, 10) : null);
      }
    );
  });
}

// Update last notification time
function updateLastNotificationTime() {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.run(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('last_notification_time', ?)`,
      [Date.now().toString()],
      (err) => {
        db.close();
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Set logs channel
function setLogsChannel(channelId) {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.run(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('logs_channel_id', ?)`,
      [channelId],
      (err) => {
        db.close();
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Get logs channel
function getLogsChannel() {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.get(
      `SELECT value FROM settings WHERE key = 'logs_channel_id'`,
      (err, row) => {
        db.close();
        if (err) reject(err);
        else resolve(row?.value || null);
      }
    );
  });
}

// Unregister department by category ID
function unregisterDepartment(categoryId) {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.run(
      `DELETE FROM departments WHERE category_id = ?`,
      [categoryId],
      (err) => {
        db.close();
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Update last message timestamp for a thread
function updateThreadActivity(threadId) {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.run(
      `UPDATE threads SET last_message_timestamp = ? WHERE thread_id = ?`,
      [Date.now(), threadId],
      (err) => {
        db.close();
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Set initial message timestamp only if not already set
function setInitialThreadActivity(threadId) {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.run(
      `UPDATE threads SET last_message_timestamp = ? WHERE thread_id = ? AND last_message_timestamp IS NULL`,
      [Date.now(), threadId],
      (err) => {
        db.close();
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Get claimed threads inactive for more than 14 days
function getClaimedThreads() {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    
    db.all(
      `SELECT * FROM threads WHERE status = 'Claimed'`,
      [],
      (err, rows) => {
        db.close();
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

function getInactiveClaimedThreads() {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    const fourteenDaysAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
    
    db.all(
      `SELECT * FROM threads 
       WHERE status = 'Claimed' 
       AND last_message_timestamp IS NOT NULL 
       AND last_message_timestamp < ? 
       AND (last_reminder_timestamp IS NULL OR last_reminder_timestamp < ?)`,
      [fourteenDaysAgo, fourteenDaysAgo],
      (err, rows) => {
        db.close();
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

// Update last reminder timestamp for a thread
function updateThreadReminder(threadId) {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.run(
      `UPDATE threads SET last_reminder_timestamp = ? WHERE thread_id = ?`,
      [Date.now(), threadId],
      (err) => {
        db.close();
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

function getMonthBounds(referenceDate = new Date()) {
  const year = referenceDate.getUTCFullYear();
  const month = referenceDate.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  const formatSqliteTimestamp = (date) => {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  };
  return {
    startIso: formatSqliteTimestamp(start),
    endIso: formatSqliteTimestamp(end),
    periodKey: `${year}-${String(month + 1).padStart(2, '0')}`
  };
}

function getPreviousMonthBounds(referenceDate = new Date()) {
  return getMonthBounds(new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() - 1, 1, 0, 0, 0, 0)));
}

function recordPointAward({
  userId,
  userDisplayName,
  awardedById,
  awardedByName,
  points,
  departmentId = null,
  departmentName = null,
  note = null
}) {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.run(
      `INSERT INTO point_awards (
        user_id,
        user_display_name,
        awarded_by_id,
        awarded_by_name,
        points,
        department_id,
        department_name,
        note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, userDisplayName, awardedById, awardedByName, points, departmentId, departmentName, note],
      function (err) {
        db.close();
        if (err) reject(err);
        else resolve({ id: this.lastID });
      }
    );
  });
}

function getPointBalance(userId, departmentId = null, referenceDate = null) {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    const filters = ['user_id = ?'];
    const params = [userId];

    if (departmentId) {
      filters.push('department_id = ?');
      params.push(departmentId);
    }

    if (referenceDate) {
      const bounds = getMonthBounds(referenceDate);
      filters.push('created_at >= ? AND created_at < ?');
      params.push(bounds.startIso, bounds.endIso);
    }

    db.get(
      `SELECT
         CASE WHEN COALESCE(SUM(points), 0) < 0 THEN 0 ELSE COALESCE(SUM(points), 0) END AS points
       FROM point_awards
       WHERE ${filters.join(' AND ')}`,
      params,
      (err, row) => {
        db.close();
        if (err) reject(err);
        else resolve({
          points: row?.points || 0
        });
      }
    );
  });
}

function getPointLeaderboard({ scope = 'monthly', departmentId = null, limit = null, referenceDate = new Date() } = {}) {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    const bounds = scope === 'monthly' ? getMonthBounds(referenceDate) : null;
    const filters = [];
    const params = [];

    if (bounds) {
      filters.push(`created_at >= ? AND created_at < ?`);
      params.push(bounds.startIso, bounds.endIso);
    }

    if (departmentId) {
      filters.push(`department_id = ?`);
      params.push(departmentId);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const limitClause = Number.isFinite(limit) ? 'LIMIT ?' : '';
    const queryParams = [...params];

    if (Number.isFinite(limit)) {
      queryParams.push(limit);
    }

    db.all(
      `SELECT
         user_id,
         MAX(user_display_name) AS user_display_name,
         CASE WHEN COALESCE(SUM(points), 0) < 0 THEN 0 ELSE COALESCE(SUM(points), 0) END AS points
       FROM point_awards
       ${whereClause}
       GROUP BY user_id
       ORDER BY points DESC, user_display_name ASC
       ${limitClause}`,
      queryParams,
      (err, rows) => {
        db.close();
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

function getDepartmentPointLeaderboard({ scope = 'monthly', departmentId = null, referenceDate = new Date() } = {}) {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    const bounds = scope === 'monthly' ? getMonthBounds(referenceDate) : null;
    const filters = [];
    const params = [];

    if (bounds) {
      filters.push(`p.created_at >= ? AND p.created_at < ?`);
      params.push(bounds.startIso, bounds.endIso);
    }

    if (departmentId) {
      filters.push(`p.department_id = ?`);
      params.push(departmentId);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    db.all(
      `SELECT
         COALESCE(p.department_id, 'unassigned') AS department_id,
         COALESCE(d.category_name, p.department_name, 'Unassigned') AS department_name,
         p.user_id,
         MAX(p.user_display_name) AS user_display_name,
         CASE WHEN COALESCE(SUM(p.points), 0) < 0 THEN 0 ELSE COALESCE(SUM(p.points), 0) END AS points
       FROM point_awards p
       LEFT JOIN departments d ON d.category_id = p.department_id
       ${whereClause}
       GROUP BY COALESCE(p.department_id, 'unassigned'), p.user_id
       ORDER BY department_name ASC, points DESC, user_display_name ASC`,
      params,
      (err, rows) => {
        db.close();
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

function saveLeaderboardArchive(periodKey, scope, payload) {
  return new Promise(async (resolve, reject) => {
    const db = await getDatabase();
    db.run(
      `INSERT INTO leaderboard_archives (period_key, scope, payload) VALUES (?, ?, ?)`,
      [periodKey, scope, JSON.stringify(payload)],
      function (err) {
        db.close();
        if (err) reject(err);
        else resolve({ id: this.lastID });
      }
    );
  });
}

async function archivePreviousMonthLeaderboard() {
  const bounds = getPreviousMonthBounds();
  const referenceDate = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1, 0, 0, 0, 0));
  const monthly = await getPointLeaderboard({ scope: 'monthly', limit: 10, referenceDate });
  const departmentRows = await getDepartmentPointLeaderboard({ scope: 'monthly', referenceDate });

  const departments = new Map();
  for (const row of departmentRows) {
    const key = row.department_id;
    if (!departments.has(key)) {
      departments.set(key, {
        department_id: row.department_id,
        department_name: row.department_name,
        entries: []
      });
    }

    departments.get(key).entries.push({
      user_id: row.user_id,
      user_display_name: row.user_display_name,
      points: row.points
    });
  }

  const payload = {
    monthly,
    departments: Array.from(departments.values()).map((dept) => ({
      department_id: dept.department_id,
      department_name: dept.department_name,
      entries: dept.entries.slice(0, 10)
    }))
  };

  await saveLeaderboardArchive(bounds.periodKey, 'monthly', payload);
  return { periodKey: bounds.periodKey, payload };
}

module.exports = {
  initializeDatabase,
  getDatabase,
  getPointBalance,
  updateThread,
  getOpenThreadsByCategory,
  updateThreadStatus,
  registerDepartment,
  setNotificationInterval,
  getNotificationInterval,
  getAllDepartments,
  shouldNotify,
  getLastNotificationTime,
  updateLastNotificationTime,
  setLogsChannel,
  getLogsChannel,
  getDepartment,
  unregisterDepartment,
  updateThreadActivity,
  setInitialThreadActivity,
  getOpenThreads,
  getClaimedThreads,
  getClaimedThreadsByCategory,
  getInactiveClaimedThreads,
  updateThreadReminder,
  recordPointAward,
  getPointLeaderboard,
  getDepartmentPointLeaderboard,
  saveLeaderboardArchive,
  archivePreviousMonthLeaderboard,
  getMonthBounds,
  getPreviousMonthBounds
};