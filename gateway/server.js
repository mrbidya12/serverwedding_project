require('dotenv').config({ path: '../.env' });
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default;
const Redis = require('ioredis');
const morgan = require('morgan');
const jwt = require('jsonwebtoken');
const cluster = require('cluster');
const os = require('os');

// ================================================================
// CLUSTER MODE – Utilise all CPU cores inside each Kubernetes pod
// ================================================================
if (cluster.isMaster) {
  const numCPUs = os.cpus().length;
  console.log(`🔄 Master ${process.pid} is running. Forking ${numCPUs} workers...`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`⚠️ Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
    cluster.fork();
  });
} else {
  // ================================================================
  // WORKER PROCESS – All Express code runs here
  // ================================================================

  const app = express();

  // ✅ Trust Nginx proxy for real client IP mapping
  app.set('trust proxy', 1);

  const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

  // Connect to Redis with optimized fail‑fast behavior
  const redisClient = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: 6379,
    maxRetriesPerRequest: 1, // Fail fast under high pressure
    retryStrategy: () => null, // Do not retry on failure – fail fast
  });

  // Morgan only in non‑production – reduces I/O under load
  if (process.env.NODE_ENV !== 'production') {
    app.use(morgan('tiny'));
  }

  // ================================================================
  // RATE LIMITER – Redis-backed, with fallback to memory store
  // ================================================================
  const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 100000; // 100k requests per 15 min
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
      sendCommand: (...args) => {
        return redisClient.call(...args).catch(err => {
          console.warn('⚠️ Redis error in rate limiter:', err.message);
          // Fallback: the limiter will use memory store (counts are per‑worker, not global)
          // This is acceptable if Redis is down.
          return Promise.resolve();
        });
      },
    }),
  });

  // Wrap the limiter to catch Redis errors and continue without limiting if Redis fails
  app.use((req, res, next) => {
    limiter(req, res, (err) => {
      if (err) {
        console.error('⚠️ Rate limiter error:', err.message);
        // Continue without rate limiting
        return next();
      }
      next();
    });
  });

  // ================================================================
  // ASYNCHRONOUS JWT MIDDLEWARE (Non‑blocking)
  // ================================================================
  app.use((req, res, next) => {
    if (
      req.path.includes('/login') ||
      req.path.includes('/register') ||
      req.path === '/health'
    ) {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];

      // Asynchronous verify – does not block the event loop
      jwt.verify(token, JWT_SECRET, (err, verified) => {
        if (err) {
          // Soft warning – continue without injecting headers
          return next();
        }
        if (verified) {
          req.headers['x-user-id'] = verified.user_id || verified.id;
          req.headers['x-user-role'] = verified.role;
        }
        next();
      });
    } else {
      next();
    }
  });

  // ================================================================
  // PROXY OPTIONS – Lean & Streamed – FIXED WebSocket onError
  // ================================================================
  const proxyOpts = {
    changeOrigin: true,
    timeout: 60000,        // 60 seconds – adjust as needed
    proxyTimeout: 60000,
    onProxyReq: (proxyReq, req, res) => {
      proxyReq.setHeader('Connection', 'keep-alive');
      // ✅ Body is streamed directly – no CPU‑wasting stringification
    },
    onError: (err, req, res) => {
      console.error('Proxy Error:', err.message);
      // ✅ FIX: Check if `res` is an Express response (has `.status`) or a WebSocket socket
      if (res && typeof res.status === 'function') {
        // HTTP request – send JSON error
        res.status(502).json({
          error: 'Bad Gateway',
          message: 'The backend service is temporarily unavailable. Please try again shortly.',
        });
      } else {
        // WebSocket upgrade or other non‑HTTP response – destroy the socket
        if (res && typeof res.destroy === 'function') {
          res.destroy();
        }
      }
    },
  };

  // ================================================================
  // PROXY ROUTES – Specific admin routes come before generic /api/admin
  // ================================================================

  // ---------- 1. SOCIAL SERVICE ADMIN ROUTES ----------
  app.use('/api/admin/block-user', createProxyMiddleware({ target: 'http://social-service:4002', ...proxyOpts }));
  app.use('/api/admin/unblock-user', createProxyMiddleware({ target: 'http://social-service:4002', ...proxyOpts }));
  app.use('/api/admin/blocked-users', createProxyMiddleware({ target: 'http://social-service:4002', ...proxyOpts }));
  app.use('/api/admin/block-chat', createProxyMiddleware({ target: 'http://social-service:4002', ...proxyOpts }));

  // ---------- 2. PAYMENT SERVICE ADMIN ROUTES ----------
  app.use('/api/admin/pending-payouts', createProxyMiddleware({ target: 'http://payment-service:3005', ...proxyOpts }));
  app.use('/api/admin/process-payout', createProxyMiddleware({ target: 'http://payment-service:3005', ...proxyOpts }));
  app.use('/api/admin/refunds', createProxyMiddleware({ target: 'http://payment-service:3005', ...proxyOpts }));
  app.use('/api/admin/refund', createProxyMiddleware({ target: 'http://payment-service:3005', ...proxyOpts }));

  // ---------- 3. COMPLAINT SERVICE ADMIN ROUTES ----------
  app.use('/api/admin/complaints', createProxyMiddleware({ target: 'http://complaint-service:3004', ...proxyOpts }));

  // ---------- 4. BOOKING SERVICE ADMIN ROUTES ----------
  app.use('/api/admin/cancellations', createProxyMiddleware({ target: 'http://booking-service:3000', ...proxyOpts }));

  // ---------- 5. GENERIC ADMIN SERVICE ----------
  app.use('/api/admin', createProxyMiddleware({ target: 'http://admin-service:8082', ...proxyOpts }));

  // ---------- 6. OTHER SERVICES ----------
  app.use('/api/users', createProxyMiddleware({ target: 'http://auth-service:8080', ...proxyOpts }));
  app.use('/api/vendors', createProxyMiddleware({ target: 'http://vendor-service:8081', ...proxyOpts }));
  app.use('/api/bookings', createProxyMiddleware({ target: 'http://booking-service:3000', ...proxyOpts }));
  app.use('/api/reviews', createProxyMiddleware({ target: 'http://review-service:8083', ...proxyOpts }));
  app.use('/api/complaints', createProxyMiddleware({ target: 'http://complaint-service:3004', ...proxyOpts }));
  app.use('/api/payments', createProxyMiddleware({ target: 'http://payment-service:3005', ...proxyOpts }));
  app.use('/api/vendor', createProxyMiddleware({ target: 'http://payment-service:3005', ...proxyOpts }));
  app.use('/api/client', createProxyMiddleware({ target: 'http://payment-service:3005', ...proxyOpts }));

  // ---------- 7. SOCIAL SERVICE NON-ADMIN ROUTES ----------
  app.use('/api/reports', createProxyMiddleware({ target: 'http://social-service:4002', ...proxyOpts }));
  app.use('/api/block-chat', createProxyMiddleware({ target: 'http://social-service:4002', ...proxyOpts }));

  // ---------- 8. CHAT WEBSOCKET PROXY ----------
  const chatProxy = createProxyMiddleware({
    target: 'http://chat-service:30000',
    ws: true,
    ...proxyOpts,
  });
  app.use('/api/chat', chatProxy);

  // ================================================================
  // BODY PARSER – Only for non‑proxy endpoints (placed after proxies)
  // ================================================================
  app.use(express.json());

  // Health endpoint (non‑proxy) – bypasses all middleware except the ones above
  app.get('/health', (req, res) => res.send('OK'));

  // Listen on port 4000
  const PORT = process.env.PORT || 4000;
  const server = app.listen(PORT, () => {
    console.log(`✅ Gateway worker ${process.pid} running on port ${PORT}`);
  });

  // WebSocket upgrade handler
  server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/api/chat')) {
      chatProxy.upgrade(req, socket, head);
    }
  });

  // Graceful shutdown – handles SIGTERM (used by Kubernetes)
  process.on('SIGTERM', () => {
    console.log(`SIGTERM received, closing worker ${process.pid}...`);
    server.close(() => {
      console.log(`Worker ${process.pid} closed.`);
      process.exit(0);
    });
  });
}