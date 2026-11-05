require('dotenv').config();
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const crypto = require('crypto');

// ---------- Firebase Admin SDK (Push Notifications) ----------
const admin = require('firebase-admin');

// ✅ Guard against missing Firebase Admin module or credentials
if (admin && admin.apps && admin.apps.length === 0) {
  try {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
    console.log('✅ Firebase Admin initialized');
  } catch (err) {
    console.error('❌ Firebase Admin init failed:', err.message);
  }
} else if (!admin) {
  console.warn('⚠️ Firebase Admin module not loaded – push notifications disabled');
}

// ================================================================
// 1. ENVIRONMENT VALIDATION – FAIL FAST
// ================================================================
const dbPassword = process.env.DB_PASSWORD;
if (!dbPassword) {
  console.error('❌ Fatal: DB_PASSWORD environment variable is not set.');
  process.exit(1);
}

if (!process.env.JWT_SECRET) {
  console.error('❌ Fatal: JWT_SECRET environment variable is not set.');
  process.exit(1);
}

if (!process.env.INTERNAL_API_KEY) {
  console.warn('⚠️ WARNING: INTERNAL_API_KEY is not set. Internal broadcast endpoints will be DISABLED.');
}

// ================================================================
// 2. DATABASE POOL & IN-MEMORY CACHE
// ================================================================
const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER || 'postgres',
  password: dbPassword,
  database: process.env.DB_NAME || 'wedding',
  port: parseInt(process.env.DB_PORT || '5432', 10),
});

// Fast In-Memory Set for blocked user IDs (global admin blocks)
const blockedUsersCache = new Set();

// ================================================================
// 3. HTTP APP & SOCKET.IO ATTACHMENT (SINGLE SERVER)
// ================================================================
const app = express();
app.use(express.json());

const server = http.createServer(app);

// ✅ Socket.IO with /api/chat path
const io = new Server(server, {
  path: '/api/chat',
  cors: {
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    credentials: true
  }
});

// ================================================================
// 4. NOTIFICATION HELPER
// ================================================================
async function saveAndEmitNotification(io, userId, type, content, relatedId = null) {
  try {
    const query = `
      INSERT INTO notifications (id, user_id, type, content, related_id, created_at)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW())
      RETURNING id, created_at;
    `;
    const res = await pool.query(query, [userId, type, content, relatedId]);

    io.to(`user_${userId}`).emit('new_notification', {
      id: res.rows[0].id,
      type,
      content,
      related_id: relatedId,
      read_at: null,
      created_at: res.rows[0].created_at,
    });
  } catch (err) {
    console.error('Failed to save notification:', err);
  }
}

// ---------- Push Notification Helper (FCM) ----------
async function sendPushNotification(userId, title, body, data = {}) {
  // ✅ Guard: skip if Firebase Admin is not initialized
  if (!admin || !admin.messaging) {
    console.warn('⚠️ Push notification skipped – Firebase Admin not available');
    return;
  }

  try {
    // Get user's FCM tokens
    const tokensResult = await pool.query(
      'SELECT token FROM fcm_tokens WHERE user_id = $1',
      [userId]
    );
    if (tokensResult.rows.length === 0) return;

    const tokens = tokensResult.rows.map(row => row.token);
    const message = {
      notification: { title, body },
      data: {
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      tokens,
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`✅ Push sent to ${response.successCount} devices`);
    if (response.failureCount > 0) {
      console.warn(`⚠️ ${response.failureCount} push failures`);
    }
  } catch (err) {
    console.error('Push notification error:', err.message);
  }
}

// ================================================================
// 5. BLOCK HELPER FUNCTIONS (User-to-User Block)
// ================================================================

// Check if userA has blocked userB
async function isBlocked(userA, userB) {
  const result = await pool.query(
    'SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2',
    [userA, userB]
  );
  return result.rows.length > 0;
}

// Create a block
async function blockUser(blockerId, blockedId) {
  await pool.query(
    'INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING',
    [blockerId, blockedId]
  );
}

// Remove a block
async function unblockUser(blockerId, blockedId) {
  await pool.query(
    'DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2',
    [blockerId, blockedId]
  );
}

// ================================================================
// 6. SOCKET.IO AUTHENTICATION & EVENT HANDLERS (FIXED + DEBUG LOGS)
// ================================================================
io.use(async (socket, next) => {
  // ✅ DEBUG: log what we receive
  console.log('🔐 Handshake auth:', socket.handshake.auth);
  console.log('🔐 Handshake headers:', socket.handshake.headers);

  // ✅ Try auth first
  let token = socket.handshake.auth?.token;
  
  // ✅ If not in auth, try extraHeaders (Authorization header)
  if (!token) {
    const authHeader = socket.handshake.headers?.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
  }

  console.log('🔐 Extracted token:', token ? token.substring(0, 20) + '...' : 'null');

  if (!token) {
    return next(new Error('Authentication error: Missing token'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.user_id;

    if (blockedUsersCache.has(userId)) {
      return next(new Error('Account is blocked'));
    }

    const userCheck = await pool.query(
      'SELECT blocked_until FROM users WHERE id = $1',
      [userId]
    );
    const blockedUntil = userCheck.rows[0]?.blocked_until;
    if (blockedUntil && new Date(blockedUntil) > new Date()) {
      blockedUsersCache.add(userId);
      return next(new Error(`Account blocked until ${new Date(blockedUntil).toISOString()}`));
    }

    socket.userId = userId;
    socket.userRole = decoded.role;
    next();
  } catch (err) {
    if (err.message && err.message.startsWith('Account')) {
      return next(err);
    }
    console.error('❌ JWT verify error:', err.message);
    next(new Error('Authentication error: Invalid or expired token'));
  }
});

io.on('connection', (socket) => {
  console.log(`User ${socket.userId} (${socket.userRole}) connected`);
  socket.join(`user_${socket.userId}`);

  if (socket.userRole === 'admin') {
    socket.join('admin_monitor');
  }

  // ========== FETCH CONVERSATION ==========
  socket.on('get_conversation', async (payload = {}) => {
    let userA, userB;

    if (socket.userRole === 'admin') {
      userA = payload.userA || socket.userId;
      userB = payload.userB || payload.withUserId;
    } else {
      userA = socket.userId;
      if (payload.withUserId) {
        userB = payload.withUserId;
      } else if (payload.userA && payload.userB) {
        if (payload.userA !== socket.userId && payload.userB !== socket.userId) {
          return socket.emit('error', 'Unauthorized access to conversation history');
        }
        userB = payload.userA === socket.userId ? payload.userB : payload.userA;
      }
    }

    if (!userA || !userB) {
      return socket.emit('error', 'Missing or invalid parameters');
    }

    try {
      const result = await pool.query(
        `SELECT id, from_user_id, to_user_id, content, type, created_at
         FROM messages
         WHERE (from_user_id = $1 AND to_user_id = $2)
            OR (from_user_id = $2 AND to_user_id = $1)
         ORDER BY created_at ASC`,
        [userA, userB]
      );
      socket.emit('conversation_history', result.rows);
    } catch (err) {
      console.error('Error fetching conversation:', err);
      socket.emit('error', 'Failed to fetch conversation');
    }
  });

  // ========== BLOCK USER (User-to-User) ==========
  socket.on('user_block', async (payload = {}) => {
    const { userIdToBlock } = payload;

    if (!userIdToBlock) {
      return socket.emit('error', 'Missing userIdToBlock parameter');
    }

    if (userIdToBlock === socket.userId) {
      return socket.emit('error', 'Cannot block yourself');
    }

    try {
      // Check if target user exists
      const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [userIdToBlock]);
      if (userCheck.rows.length === 0) {
        return socket.emit('error', 'User not found');
      }

      await blockUser(socket.userId, userIdToBlock);

      // Notify both users
      io.to(`user_${socket.userId}`).emit('blocked_user', { blockedUserId: userIdToBlock });
      io.to(`user_${userIdToBlock}`).emit('you_were_blocked', { blockedBy: socket.userId });

      console.log(`User ${socket.userId} blocked ${userIdToBlock}`);
      socket.emit('success', { message: 'User blocked successfully' });
    } catch (err) {
      console.error('Error blocking user:', err);
      socket.emit('error', 'Failed to block user');
    }
  });

  // ========== UNBLOCK USER (User-to-User) ==========
  socket.on('user_unblock', async (payload = {}) => {
    const { userIdToUnblock } = payload;

    if (!userIdToUnblock) {
      return socket.emit('error', 'Missing userIdToUnblock parameter');
    }

    try {
      await unblockUser(socket.userId, userIdToUnblock);

      io.to(`user_${socket.userId}`).emit('unblocked_user', { unblockedUserId: userIdToUnblock });
      io.to(`user_${userIdToUnblock}`).emit('you_were_unblocked', { unblockedBy: socket.userId });

      console.log(`User ${socket.userId} unblocked ${userIdToUnblock}`);
      socket.emit('success', { message: 'User unblocked successfully' });
    } catch (err) {
      console.error('Error unblocking user:', err);
      socket.emit('error', 'Failed to unblock user');
    }
  });

  // ========== SEND MESSAGE ==========
  socket.on('send_message', async (data = {}) => {
    const { toUserId, vendorId, content, type = 'text' } = data;

    if (blockedUsersCache.has(socket.userId)) {
      socket.disconnect(true);
      return;
    }

    if (!toUserId || !content || typeof content !== 'string' || content.trim().length === 0) {
      return socket.emit('error', 'Invalid message payload');
    }
    if (content.length > 5000) {
      return socket.emit('error', 'Message length exceeds 5000 limit');
    }

    // ✅ CHECK: User-to-User Block
    try {
      const blocked = await isBlocked(socket.userId, toUserId);
      if (blocked) {
        return socket.emit('error', 'You have blocked this user');
      }
      const blockedReverse = await isBlocked(toUserId, socket.userId);
      if (blockedReverse) {
        return socket.emit('error', 'You are blocked by this user');
      }
    } catch (err) {
      console.error('Error checking block status:', err);
      return socket.emit('error', 'Failed to check block status');
    }

    try {
      const messageId = crypto.randomUUID();
      const result = await pool.query(
        `INSERT INTO messages (id, from_user_id, to_user_id, vendor_id, content, type, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING created_at`,
        [messageId, socket.userId, toUserId, vendorId || null, content, type]
      );

      const message = {
        id: messageId,
        from_user_id: socket.userId,
        to_user_id: toUserId,
        vendor_id: vendorId || null,
        content,
        type,
        created_at: result.rows[0].created_at,
      };

      io.to(`user_${toUserId}`).emit('receive_message', message);
      socket.emit('message_sent', message);
      io.to('admin_monitor').emit('admin_receive_message', message);

      await saveAndEmitNotification(io, toUserId, type, content, messageId);

      // ----- Push Notification + Deep Link -----
      const deepLink = `/chat?userId=${socket.userId}&bookingId=${vendorId || ''}`;
      const pushTitle = `New message from ${socket.userId}`;
      const pushBody = content.length > 100 ? content.substring(0, 100) + '...' : content;
      await sendPushNotification(toUserId, pushTitle, pushBody, {
        deepLink,
        messageId,
        senderId: socket.userId,
      });

      // ----- If payment message, also save to chat_payment_messages -----
      if (type === 'payment') {
        const amountMatch = content.match(/₹(\d+(\.\d{1,2})?)/);
        if (amountMatch) {
          const amount = parseFloat(amountMatch[1]);
          const chatId = [socket.userId, toUserId].sort().join('_');
          await pool.query(
            `INSERT INTO chat_payment_messages (chat_id, message_id, payment_id, amount, type)
             VALUES ($1, $2, $3, $4, $5)`,
            [chatId, messageId, vendorId || null, amount, 'request']
          );
        }
      }
    } catch (err) {
      console.error('Error sending message:', err);
      socket.emit('error', 'Failed to send message');
    }
  });

  // ========== DELETE MESSAGE (ADMIN ONLY) ==========
  socket.on('delete_message', async (payload = {}) => {
    const { messageId } = payload;

    if (socket.userRole !== 'admin') {
      return socket.emit('error', 'Admin authorization required');
    }
    if (!messageId) {
      return socket.emit('error', 'Missing messageId parameter');
    }

    try {
      const check = await pool.query('SELECT type FROM messages WHERE id = $1', [messageId]);
      if (check.rows.length === 0) {
        return socket.emit('error', 'Message not found');
      }
      if (check.rows[0].type === 'payment') {
        return socket.emit('error', 'Cannot delete payment messages');
      }

      await pool.query('DELETE FROM messages WHERE id = $1', [messageId]);
      io.emit('message_deleted', messageId);
    } catch (err) {
      console.error('Error deleting message:', err);
      socket.emit('error', 'Failed to delete message');
    }
  });

  // ========== BLOCK USER (ADMIN ONLY) ==========
  socket.on('block_user', async (payload = {}) => {
    const { userIdToBlock } = payload;

    if (socket.userRole !== 'admin') {
      return socket.emit('error', 'Admin authorization required');
    }
    if (!userIdToBlock) {
      return socket.emit('error', 'Missing userIdToBlock parameter');
    }

    try {
      await pool.query(
        "UPDATE users SET blocked_until = NOW() + INTERVAL '1 year' WHERE id = $1",
        [userIdToBlock]
      );

      blockedUsersCache.add(userIdToBlock);
      io.to(`user_${userIdToBlock}`).emit('account_blocked', { duration: '1 year' });
      io.in(`user_${userIdToBlock}`).disconnectSockets(true);
      io.emit('user_blocked', userIdToBlock);
    } catch (err) {
      console.error('Error blocking user:', err);
      socket.emit('error', 'Failed to block user');
    }
  });

  // ========== UNBLOCK USER (ADMIN ONLY) ==========
  socket.on('unblock_user', async (payload = {}) => {
    const { userIdToUnblock } = payload;

    if (socket.userRole !== 'admin') {
      return socket.emit('error', 'Admin authorization required');
    }
    if (!userIdToUnblock) {
      return socket.emit('error', 'Missing userIdToUnblock parameter');
    }

    try {
      await pool.query(
        'UPDATE users SET blocked_until = NULL WHERE id = $1',
        [userIdToUnblock]
      );

      blockedUsersCache.delete(userIdToUnblock);
      io.emit('user_unblocked', userIdToUnblock);
    } catch (err) {
      console.error('Error unblocking user:', err);
      socket.emit('error', 'Failed to unblock user');
    }
  });

  socket.on('disconnect', () => {
    console.log(`User ${socket.userId} disconnected`);
  });
});

// ================================================================
// 6. HTTP API MIDDLEWARE & ROUTES
// ================================================================

// Auth Middleware for Client REST Requests
const auth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token format' });
  }

  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    req.userId = decoded.user_id;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Internal Auth Middleware (Fail Closed)
const internalAuth = (req, res, next) => {
  const apiKey = req.headers['x-internal-key'];
  if (!process.env.INTERNAL_API_KEY) {
    console.error('❌ INTERNAL_API_KEY is not set – internal endpoints are DISABLED');
    return res.status(500).json({ error: 'Server configuration error' });
  }
  if (!apiKey || apiKey !== process.env.INTERNAL_API_KEY) {
    return res.status(403).json({ error: 'Forbidden: Invalid or missing internal key' });
  }
  next();
};

// Internal Broadcast (fromUserId = null for System Messages)
app.post('/internal/broadcast', internalAuth, async (req, res) => {
  const { toUserId, content, type = 'payment', fromUserId = null } = req.body;
  if (!toUserId || !content) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const messageId = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO messages (id, from_user_id, to_user_id, vendor_id, content, type, created_at)
       VALUES ($1, $2, $3, NULL, $4, $5, NOW())
       RETURNING created_at`,
      [messageId, fromUserId, toUserId, content, type]
    );

    const message = {
      id: messageId,
      from_user_id: fromUserId,
      to_user_id: toUserId,
      vendor_id: null,
      content,
      type,
      created_at: result.rows[0].created_at,
    };

    io.to(`user_${toUserId}`).emit('receive_message', message);
    io.to('admin_monitor').emit('admin_receive_message', message);
    await saveAndEmitNotification(io, toUserId, type, content, messageId);

    // ----- Push Notification for broadcast -----
    const deepLink = `/chat?userId=${fromUserId || 'system'}`;
    await sendPushNotification(toUserId, 'System Notification', content, {
      deepLink,
      messageId,
    });

    // ----- If payment, also insert into chat_payment_messages -----
    if (type === 'payment') {
      const amountMatch = content.match(/₹(\d+(\.\d{1,2})?)/);
      if (amountMatch) {
        const amount = parseFloat(amountMatch[1]);
        const chatId = [fromUserId, toUserId].sort().join('_');
        await pool.query(
          `INSERT INTO chat_payment_messages (chat_id, message_id, payment_id, amount, type)
           VALUES ($1, $2, $3, $4, $5)`,
          [chatId, messageId, null, amount, 'request']
        );
      }
    }

    res.status(201).json({ message: 'Broadcast sent successfully' });
  } catch (err) {
    console.error('Broadcast error:', err);
    res.status(500).json({ error: 'Failed to send broadcast' });
  }
});

// ---------- FCM Token Registration ----------
app.post('/api/chat/register-token', auth, async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token required' });
  }

  try {
    await pool.query(
      `INSERT INTO fcm_tokens (user_id, token) VALUES ($1, $2)
       ON CONFLICT (token) DO UPDATE SET user_id = $1, created_at = NOW()`,
      [req.userId, token]
    );
    res.json({ message: 'Token registered successfully' });
  } catch (err) {
    console.error('Error registering FCM token:', err);
    res.status(500).json({ error: 'Failed to register token' });
  }
});

// ---------- Notification Routes (existing) ----------
app.get('/api/notifications', auth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = parseInt(req.query.offset, 10) || 0;

  try {
    const [listRes, countRes] = await Promise.all([
      pool.query(
        `SELECT id, type, content, related_id, read_at, created_at
         FROM notifications
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [req.userId, limit, offset]
      ),
      pool.query('SELECT COUNT(*) AS total FROM notifications WHERE user_id = $1', [req.userId])
    ]);

    res.json({
      notifications: listRes.rows,
      total: parseInt(countRes.rows[0].total, 10),
      limit,
      offset,
    });
  } catch (err) {
    console.error('Fetch notifications error:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.get('/api/notifications/unread-count', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT COUNT(*) AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [req.userId]
    );
    res.json({ unread: parseInt(result.rows[0].unread, 10) });
  } catch (err) {
    console.error('Get unread count error:', err);
    res.status(500).json({ error: 'Failed to retrieve unread notification count' });
  }
});

app.post('/api/notifications/:id/read', auth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Mark notification read error:', err);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

app.post('/api/notifications/read-all', auth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL',
      [req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Mark all read error:', err);
    res.status(500).json({ error: 'Failed to mark all notifications as read' });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', service: 'chat-service' });
});

// ================================================================
// 7. START UNIFIED SERVER & GRACEFUL SHUTDOWN
// ================================================================
const PORT = process.env.PORT || process.env.HTTP_PORT || 30000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Unified HTTP & WebSocket server active on port ${PORT}`);
});

// Process-level safety and graceful termination
const gracefulShutdown = async () => {
  console.log(' shutting down server...');
  server.close(async () => {
    await pool.end();
    console.log('Connections closed cleanly.');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});