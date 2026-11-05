module.exports = (req, res, next) => {
  // Since gateway injects headers, trust them
  if (!req.headers['x-user-id']) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.userId = req.headers['x-user-id'];
  req.userRole = req.headers['x-user-role'];
  next();
};