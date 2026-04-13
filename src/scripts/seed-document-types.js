import 'dotenv/config';
import pool from '../config/database.js';

const seedDocumentTypes = async () => {
  const documentTypes = [
    { code: '000', name: 'Cukai' }, { code: '001', name: 'CIPL' },
    { code: '217', name: 'Packing List' }, { code: '380', name: 'Invoice' },
    { code: '457', name: 'SKB' }, { code: '704', name: 'Master Bill of Lading' },
    { code: '705', name: 'Bill of Lading' }, { code: '740', name: 'Air Way Bill' },
    { code: '741', name: 'Master AWB' }, { code: '800', name: 'POSTEL' },
    { code: '813', name: 'CK' }, { code: '846', name: 'SKEM' },
    { code: '854', name: 'BPOM' }, { code: '860', name: 'ECOO' },
    { code: '861', name: 'COO' }, { code: '871', name: 'AKL' },
    { code: '888', name: 'Pengecualian' }, { code: '957', name: 'SNI' },
    { code: '958', name: 'Lartas' }, { code: '959', name: 'PI' },
    { code: '999', name: 'Lainnya' }
  ];

  try {
    console.log('📄 SEEDING DOCUMENT TYPES...');
    for (const doc of documentTypes) {
      // Menghapus referensi updated_at sepenuhnya dari query ini
      await pool.query(
        `INSERT INTO document_types (id, code, name, created_at) 
         VALUES (gen_random_uuid(), $1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (code) 
         DO UPDATE SET name = EXCLUDED.name`,
        [doc.code, doc.name]
      );
    }
    console.log('Document Types Seeding Success!');
  } catch (error) {
    console.error('Doc Types Seeding Error:', error.message);
  } finally {
    await pool.end();
  }
};

seedDocumentTypes();