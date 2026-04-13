import 'dotenv/config'; // Pastikan bisa membaca .env
import bcrypt from 'bcrypt';
import pool from '../config/database.js';

const seedAdmin = async () => {
  console.log('=========================================');
  console.log('MEMULAI DATABASE SEEDING...');
  console.log('=========================================');

  try {
    console.log('[1/3] Menyiapkan Master Data Roles...');
    const roles = ['admin', 'operator'];

    for (const roleName of roles) {
      await pool.query(
        `INSERT INTO roles (id, name, created_at, updated_at) 
         VALUES (gen_random_uuid(), $1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) 
         ON CONFLICT (name) DO NOTHING`,
        [roleName]
      );
    }
    console.log('Roles berhasil disiapkan.');

    const roleResult = await pool.query('SELECT id FROM roles WHERE name = \'admin\'');
    if (roleResult.rowCount === 0) {
      throw new Error('Gagal mengambil ID Role Admin');
    }
    const adminRoleId = roleResult.rows[0].id;

    const adminEmail = 'admin@dev.com';
    const checkAdmin = await pool.query('SELECT id FROM users WHERE email = $1', [adminEmail]);

    if (checkAdmin.rowCount > 0) {
      console.log(`[2/3] ⚠️ Akun Admin (${adminEmail}) sudah ada. Melewati pembuatan user.`);
    } else {
      console.log('[2/3] Membuat akun Super Admin...');

      const adminPassword = 'Admin@12345';
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(adminPassword, saltRounds);

      await pool.query(
        `INSERT INTO users (id, name, email, password, role_id, created_at, updated_at) 
         VALUES (gen_random_uuid(), $1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        ['Super Admin', adminEmail, hashedPassword, adminRoleId]
      );

      console.log('Akun Admin berhasil dibuat!');
      console.log(`Email: ${adminEmail}`);
      console.log(`Password: ${adminPassword}`);
    }

    console.log('[3/3] Seeding Selesai!');
  } catch (error) {
    console.error('❌ Gagal melakukan seeding:', error.message);
  } finally {
    // Putuskan koneksi pool agar script bisa berhenti (exit) dengan otomatis
    await pool.end();
    console.log('=========================================');
  }
};

seedAdmin();