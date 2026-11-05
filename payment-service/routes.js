// ================================================================
//  ADD TO payment-service/server.js
// ================================================================

// GET /api/payments/transactions – List transactions with status filter
app.get('/api/payments/transactions', authRequired, async (req, res) => {
  const { status } = req.query;
  const vendorId = req.user_id;

  let query = 'SELECT * FROM payment_requests WHERE vendor_id = $1';
  const params = [vendorId];
  if (status && status !== 'all') {
    query += ' AND payout_status = $2';
    params.push(status);
  }
  query += ' ORDER BY created_at DESC';

  const transactions = await pool.query(query, params);
  res.json(transactions.rows);
});

// GET /api/payments/transactions/client – Client transaction history
app.get('/api/payments/transactions/client', authRequired, async (req, res) => {
  const clientId = req.user_id;
  const transactions = await pool.query(
    `SELECT pr.*, v.name as vendor_name
     FROM payment_requests pr
     JOIN vendors v ON pr.vendor_id = v.id
     WHERE pr.client_id = $1
     ORDER BY pr.created_at DESC`,
    [clientId]
  );
  res.json(transactions.rows);
});
