require('dotenv').config({ path: '../.env' });
const express = require('express');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  user: 'postgres',
  password: 'postgres',
  database: 'wedding',
  port: 5432,
});

const app = express();
app.use(express.json());

// Authentication middleware
const auth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.user_id;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Submit a complaint
app.post('/api/complaints', auth, async (req, res) => {
  const { targetUserId, vendorId, subject, description } = req.body;
  if (!targetUserId || !subject || !description) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO complaints (id, from_user_id, target_user_id, vendor_id, subject, description)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [req.userId, targetUserId, vendorId || null, subject, description]
    );
    res.status(201).json({ id: result.rows[0].id, message: 'Complaint submitted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit complaint' });
  }
});

// Admin: list all complaints
app.get('/api/admin/complaints', auth, async (req, res) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const result = await pool.query(
      `SELECT c.*, 
              u1.name as from_name, u1.email as from_email,
              u2.name as target_name, u2.email as target_email
       FROM complaints c
       LEFT JOIN users u1 ON c.from_user_id = u1.id
       LEFT JOIN users u2 ON c.target_user_id = u2.id
       ORDER BY c.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch complaints' });
  }
});

// Admin: update complaint status
app.patch('/api/admin/complaints/:id/status', auth, async (req, res) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { status } = req.body;
  if (!['resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    await pool.query(
      `UPDATE complaints SET status = $1, resolved_at = NOW() WHERE id = $2`,
      [status, req.params.id]
    );
    res.json({ message: 'Complaint updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update complaint' });
  }
});

const PORT = process.env.PORT || 3004;
app.listen(PORT, () => console.log(`Complaint service on port ${PORT}`));
