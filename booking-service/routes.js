// ================================================================
//  ADD TO booking-service/server.js
// ================================================================

// GET /api/bookings – List bookings with status filter
app.get('/api/bookings', authRequired, async (req, res) => {
  const { status } = req.query;
  const vendorId = req.user_id;

  let query = 'SELECT * FROM bookings WHERE vendor_id = $1';
  const params = [vendorId];
  if (status && status !== 'all') {
    query += ' AND status = $2';
    params.push(status);
  }
  query += ' ORDER BY created_at DESC';

  const bookings = await pool.query(query, params);
  res.json(bookings.rows);
});

// GET /api/bookings/client – Client booking history
app.get('/api/bookings/client', authRequired, async (req, res) => {
  const clientId = req.user_id;
  const bookings = await pool.query(
    `SELECT b.*, v.name as vendor_name
     FROM bookings b
     JOIN vendors v ON b.vendor_id = v.id
     WHERE b.client_id = $1
     ORDER BY b.created_at DESC`,
    [clientId]
  );
  res.json(bookings.rows);
});
