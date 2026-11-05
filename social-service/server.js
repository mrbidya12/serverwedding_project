require('dotenv').config({ path: '../.env' });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { Sequelize, DataTypes, Op } = require('sequelize');

// ---------- Database Setup ----------
const sequelize = new Sequelize(process.env.DATABASE_URL || 'postgres://postgres:postgres@db:5432/wedding', {
  logging: false,
});

// ---------- Models (all inline) ----------
const Block = sequelize.define('Block', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  blocker_id: { type: DataTypes.UUID, allowNull: false },
  blocked_id: { type: DataTypes.UUID, allowNull: false },
}, {
  tableName: 'blocked_users',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
  indexes: [{ unique: true, fields: ['blocker_id', 'blocked_id'] }],
});

const Message = sequelize.define('Message', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  sender_id: { type: DataTypes.UUID, allowNull: false },
  receiver_id: { type: DataTypes.UUID, allowNull: false },
  message: { type: DataTypes.TEXT, allowNull: false },
  read: { type: DataTypes.BOOLEAN, defaultValue: false },
}, {
  tableName: 'messages',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
});

const Report = sequelize.define('Report', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  reporter_id: { type: DataTypes.UUID, allowNull: false },
  vendor_id: { type: DataTypes.UUID, allowNull: false },
  booking_id: { type: DataTypes.UUID, allowNull: true },
  event_name: { type: DataTypes.STRING, allowNull: false },
  event_date: { type: DataTypes.DATEONLY, allowNull: true },
  description: { type: DataTypes.TEXT, allowNull: false },
  photo_urls: { type: DataTypes.ARRAY(DataTypes.STRING), defaultValue: [] },
  status: {
    type: DataTypes.ENUM('pending', 'reviewing', 'resolved', 'dismissed'),
    defaultValue: 'pending',
  },
  admin_notes: { type: DataTypes.TEXT, allowNull: true },
  resolved_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'reports',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
});

// ✅ FIX: report_id is now nullable (allowNull: true)
const BlockChat = sequelize.define('BlockChat', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  report_id: { type: DataTypes.UUID, allowNull: true },   // ✅ Changed to true
  from_user_id: { type: DataTypes.UUID, allowNull: false },
  to_user_id: { type: DataTypes.UUID, allowNull: false },
  message: { type: DataTypes.TEXT, allowNull: false },
  is_admin: { type: DataTypes.BOOLEAN, defaultValue: false },
  read_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'block_chats',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
});

// ---------- Express & WebSocket ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('Authentication error'));
    socket.userId = decoded.user_id;
    socket.role = decoded.role;
    next();
  });
});

io.on('connection', (socket) => {
  console.log(`User ${socket.userId} connected via WebSocket`);
  socket.join(socket.userId);
  if (socket.role === 'admin') {
    socket.join('admin_monitor');
    console.log(`Admin ${socket.userId} joined admin_monitor room`);
  }
  socket.on('disconnect', () => {
    console.log(`User ${socket.userId} disconnected`);
  });
});

// ================================================================
// 1. BLOCK / UNBLOCK (user‑to‑user)
// ================================================================
app.post('/api/social/block', async (req, res) => {
  const blockerId = req.headers['x-user-id'];
  if (!blockerId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await Block.create({ blocker_id: blockerId, blocked_id: req.body.blocked_id });
    res.status(201).json({ message: 'User blocked' });
  } catch (e) {
    res.status(400).json({ error: 'Already blocked or invalid' });
  }
});

app.post('/api/social/unblock', async (req, res) => {
  const blockerId = req.headers['x-user-id'];
  if (!blockerId) return res.status(401).json({ error: 'Unauthorized' });
  const deleted = await Block.destroy({
    where: { blocker_id: blockerId, blocked_id: req.body.blocked_id }
  });
  if (deleted) res.json({ message: 'Unblocked' });
  else res.status(404).json({ error: 'Not found' });
});

app.get('/api/social/blocked', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const blocked = await Block.findAll({ where: { blocker_id: userId } });
  res.json(blocked);
});

// ================================================================
// 2. DIRECT MESSAGES
// ================================================================
app.post('/api/social/messages', async (req, res) => {
  const senderId = req.headers['x-user-id'];
  if (!senderId) return res.status(401).json({ error: 'Unauthorized' });
  const isBlocked = await Block.findOne({
    where: { blocker_id: req.body.receiver_id, blocked_id: senderId }
  });
  if (isBlocked) return res.status(403).json({ error: 'You are blocked by this user' });
  try {
    const msg = await Message.create({
      sender_id: senderId,
      receiver_id: req.body.receiver_id,
      message: req.body.message,
    });
    io.to(req.body.receiver_id).emit('new_message', msg);
    res.status(201).json(msg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/social/messages/:userId', async (req, res) => {
  const currentUserId = req.headers['x-user-id'];
  if (!currentUserId) return res.status(401).json({ error: 'Unauthorized' });
  const otherUserId = req.params.userId;
  const messages = await Message.findAll({
    where: {
      [Op.or]: [
        { sender_id: currentUserId, receiver_id: otherUserId },
        { sender_id: otherUserId, receiver_id: currentUserId },
      ]
    },
    order: [['created_at', 'ASC']]
  });
  await Message.update({ read: true }, {
    where: { sender_id: otherUserId, receiver_id: currentUserId, read: false }
  });
  res.json(messages);
});

// ================================================================
// 3. REPORTS (fixed with named parameters)
// ================================================================
app.post('/api/reports', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { vendorId, bookingId, eventName, eventDate, description, photoUrls } = req.body;
  if (!vendorId || !eventName || !description) {
    return res.status(400).json({ error: 'Vendor ID, event name, and description required' });
  }

  try {
    const vendor = await sequelize.query(
      'SELECT id FROM vendors WHERE id = :vendorId',
      { replacements: { vendorId }, type: sequelize.QueryTypes.SELECT }
    );
    if (vendor.length === 0) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    if (bookingId) {
      const booking = await sequelize.query(
        'SELECT id FROM bookings WHERE id = :bookingId AND client_id = :clientId AND vendor_id = :vendorId',
        { replacements: { bookingId, clientId: userId, vendorId }, type: sequelize.QueryTypes.SELECT }
      );
      if (booking.length === 0) {
        return res.status(403).json({ error: 'You must have a booking with this vendor to report them' });
      }
    }

    const report = await Report.create({
      reporter_id: userId,
      vendor_id: vendorId,
      booking_id: bookingId || null,
      event_name: eventName,
      event_date: eventDate || null,
      description,
      photo_urls: photoUrls || [],
      status: 'pending',
    });

    io.to('admin_monitor').emit('new_report', { reportId: report.id, vendorId });
    res.status(201).json({
      message: 'Report submitted successfully',
      reportId: report.id,
      createdAt: report.created_at,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/reports', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const role = req.headers['x-user-role'];
  if (role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { status } = req.query;
  const where = {};
  if (status) where.status = status;

  try {
    const reports = await Report.findAll({ where, order: [['created_at', 'DESC']] });
    res.json(reports);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/reports/:reportId/status', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const role = req.headers['x-user-role'];
  if (role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { reportId } = req.params;
  const { status, adminNotes } = req.body;

  if (!['pending', 'reviewing', 'resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const report = await Report.findByPk(reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    report.status = status;
    if (adminNotes !== undefined) report.admin_notes = adminNotes;
    if (['resolved', 'dismissed'].includes(status)) {
      report.resolved_at = new Date();
    }
    await report.save();

    io.to(report.reporter_id).emit('report_status_updated', { reportId, status });
    res.json({ message: 'Report status updated', report });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 4. BLOCK CHAT (fixed with named parameters)
// ================================================================
app.post('/api/admin/block-chat', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const role = req.headers['x-user-role'];
  if (role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { reportId, toUserId, message } = req.body;
  if (!reportId || !toUserId || !message) {
    return res.status(400).json({ error: 'Report ID, recipient, and message required' });
  }

  try {
    const report = await Report.findByPk(reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (report.status === 'resolved') {
      return res.status(400).json({ error: 'Report is already resolved' });
    }

    const chat = await BlockChat.create({
      report_id: reportId,
      from_user_id: userId,
      to_user_id: toUserId,
      message,
      is_admin: true,
    });

    io.to(toUserId).emit('block_chat_message', { reportId, from: userId, message });
    res.status(201).json({ message: 'Message sent', chatId: chat.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/block-chat/reply', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { reportId, message } = req.body;
  if (!reportId || !message) {
    return res.status(400).json({ error: 'Report ID and message required' });
  }

  try {
    const report = await Report.findByPk(reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const isReporter = report.reporter_id === userId;
    const vendor = await sequelize.query(
      'SELECT owner_id FROM vendors WHERE id = :vendorId',
      { replacements: { vendorId: report.vendor_id }, type: sequelize.QueryTypes.SELECT }
    );
    const vendorOwnerId = vendor.length > 0 ? vendor[0].owner_id : null;
    if (!isReporter && userId !== vendorOwnerId) {
      return res.status(403).json({ error: 'Not authorized to reply' });
    }

    const admin = await sequelize.query(
      'SELECT id FROM users WHERE role = :role LIMIT 1',
      { replacements: { role: 'admin' }, type: sequelize.QueryTypes.SELECT }
    );
    if (admin.length === 0) {
      return res.status(500).json({ error: 'Admin not found' });
    }
    const adminId = admin[0].id;

    const chat = await BlockChat.create({
      report_id: reportId,
      from_user_id: userId,
      to_user_id: adminId,
      message,
      is_admin: false,
    });

    io.to('admin_monitor').emit('block_chat_reply', { reportId, from: userId, message });
    res.status(201).json({ message: 'Reply sent', chatId: chat.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/block-chat/:reportId', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const role = req.headers['x-user-role'];
  if (role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { reportId } = req.params;
  try {
    const chats = await BlockChat.findAll({
      where: { report_id: reportId },
      order: [['created_at', 'ASC']],
    });
    res.json(chats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/block-chats', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const chats = await BlockChat.findAll({
      where: {
        [Op.or]: [{ from_user_id: userId }, { to_user_id: userId }],
      },
      order: [['created_at', 'DESC']],
    });
    res.json(chats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 5. ADMIN BLOCK USER – FIXED: only create BlockChat if reportId exists
// ================================================================
app.post('/api/admin/block-user', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const role = req.headers['x-user-role'];
  if (role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { targetUserId, durationHours, reason, reportId } = req.body;
  if (!targetUserId) {
    return res.status(400).json({ error: 'Target user ID required' });
  }

  const hours = durationHours || 24;
  const blockedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);

  try {
    await sequelize.query(
      `UPDATE users SET blocked_until = :blockedUntil, blocked_reason = :reason WHERE id = :targetUserId`,
      { replacements: { blockedUntil, reason: reason || 'Blocked by admin', targetUserId } }
    );

    // ✅ Only create BlockChat if reportId is provided
    if (reportId) {
      await BlockChat.create({
        report_id: reportId,
        from_user_id: userId,
        to_user_id: targetUserId,
        message: `User blocked until ${blockedUntil.toISOString()}. Reason: ${reason || 'No reason provided'}`,
        is_admin: true,
      });
    }

    io.to(targetUserId).emit('account_blocked', { blockedUntil, reason });
    res.json({
      message: 'User blocked successfully',
      blocked_until: blockedUntil,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/unblock-user', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const role = req.headers['x-user-role'];
  if (role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { targetUserId } = req.body;
  if (!targetUserId) {
    return res.status(400).json({ error: 'Target user ID required' });
  }

  try {
    await sequelize.query(
      `UPDATE users SET blocked_until = NULL, blocked_reason = NULL WHERE id = :targetUserId`,
      { replacements: { targetUserId } }
    );
    io.to(targetUserId).emit('account_unblocked');
    res.json({ message: 'User unblocked successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/blocked-users', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const role = req.headers['x-user-role'];
  if (role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const blockedUsers = await sequelize.query(
      `SELECT id, email, name, blocked_until, blocked_reason FROM users WHERE blocked_until IS NOT NULL AND blocked_until > NOW()`,
      { type: sequelize.QueryTypes.SELECT }
    );
    res.json(blockedUsers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Start Server ----------
const PORT = process.env.PORT || 4002;
server.listen(PORT, () => console.log(`Social service on port ${PORT}`));