const { Sequelize, DataTypes } = require('sequelize');
const sequelize = new Sequelize(process.env.DATABASE_URL || 'postgres://postgres:postgres@db:5432/wedding', {
  logging: false,
});

const Complaint = sequelize.define('Complaint', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  complainant_id: { type: DataTypes.UUID, allowNull: false },
  respondent_id: { type: DataTypes.UUID, allowNull: false },
  reason: { type: DataTypes.TEXT, allowNull: false },
  status: { type: DataTypes.STRING, defaultValue: 'pending' },
  resolution_note: { type: DataTypes.TEXT },
  resolved_at: { type: DataTypes.DATE },
}, {
  tableName: 'complaints',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = { sequelize, Complaint };