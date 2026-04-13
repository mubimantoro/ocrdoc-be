import 'dotenv/config';
import bcrypt from 'bcrypt';
import pool from '../config/database.js';

const seedAdmin = async () => {
  try {
    console.log('🌱 SEEDING ADMIN & ROLES...');

    const roles = ['admin', 'operator'];
    for (const role of roles) {
      await pool.query(
        `INSERT INTO roles (id, name, created_at) 
         VALUES (gen_random_uuid(), $1, CURRENT_TIMESTAMP) 
         ON CONFLICT (name) DO NOTHING`,
        [role]
      );
    }

    const adminEmail = 'admin@dev.com';
    const roleRes = await pool.query("SELECT id FROM roles WHERE name = 'Admin'");

    if (roleRes.rowCount === 0) {
      throw new Error('Role Admin gagal dibuat!');
    }
    const adminRoleId = roleRes.rows[0].id;

    const hashedPassword = await bcrypt.hash('Admin@12345', 10);

    // 2. Seed User Admin (Tabel users punya updated_at)
    await pool.query(
      `INSERT INTO users (id, name, email, password, role_id, created_at, updated_at) 
       VALUES (gen_random_uuid(), $1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (email) DO NOTHING`,
      ['Super Admin', adminEmail, hashedPassword, adminRoleId]
    );

    console.log('Admin Seeding Success!');
  } catch (error) {
    console.error('Admin Seeding Error:', error.message);
  } finally {
    await pool.end();
  }
};

seedAdmin();