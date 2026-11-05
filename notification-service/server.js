const express = require('express');
const { Pool } = require('pg');
const app = express();
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  user: 'postgres',
  password: process.env.DB_PASSWORD,
  database: 'wedding',
  port: 5432,
});

// Internal endpoint for other services to send notifications
app.post('/api/notifications/internal', async (req, res) => {
  const { user_id, type, message, metadata } = req.body;
  const apiKey = req.headers['x-internal-key'];
  if (apiKey !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO notifications (user_id, type, message, metadata, created_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
      [user_id, type, message, metadata]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('Notification error:', err);
    res.status(500).json({ error: 'Failed to save notification' });
  }
});

// GET /api/notifications – Get all notifications for logged-in user
app.get('/api/notifications', async (req, res) => {
  // Use authRequired middleware (simplified here)
  const userId = req.user_id;
  const notifications = await pool.query(
    'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  res.json(notifications.rows);
});

// PUT /api/notifications/:id/read – Mark as read
app.put('/api/notifications/:id/read', async (req, res) => {
  const { id } = req.params;
  await pool.query('UPDATE notifications SET read = true WHERE id = $1', [id]);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3006;
app.listen(PORT, () => console.log(`Notification service running on port ${PORT}`));
