/* eslint-disable no-prototype-builtins */
/**
 * Kamus urutan (Schema Dictionary) berdasarkan Document Code.
 * Berfungsi untuk mengurutkan kembali JSONB yang diacak oleh PostgreSQL GIN Index.
 */
const SCHEMA_ORDERS = {
  // === 1. INVOICE ===
  '380': [
    'doc_code', 'doc_name', 'confidence_score',
    'bill_to_name', 'bill_to_address',
    'seller_name', 'seller_address', 'seller_country', 'seller_country_code', 'seller_phone', 'seller_tax',
    'buyer_name', 'buyer_address', 'buyer_country', 'buyer_country_code', 'buyer_phone', 'buyer_tax', 'buyer_customs_id',
    'ship_to', 'ship_to_city',
    'payment_terms', 'payment_terms_code', 'inco_terms', 'freight_terms',
    'total', 'currency_code', 'packaging_type',
    'invoice_list', 'details_list', 'banks'
  ],

  // === 2. PACKING LIST ===
  '217': [
    'doc_code', 'doc_name', 'confidence_score',
    'packaging', 'packaging_qty_total', 'total_gross_weight', 'total_net_weight', 'total_measurements',
    'ship_by_name', 'ship_by_address',
    'sold_by_name', 'sold_by_address',
    'sold_to_name', 'sold_to_address',
    'ship_to_name', 'ship_to_address',
    'ship_date', 'due_date', 'terms_of_payment', 'total_cartons',
    'ship_via', 'route',
    'pl_list'
  ],

  // === 3. CIPL ===
  '001': [
    'doc_code', 'doc_name', 'confidence_score',
    'packing_list_number', 'packing_list_date',
    'seller_name', 'seller_address', 'seller_country', 'seller_country_code', 'seller_phone',
    'buyer_name', 'buyer_address', 'buyer_country', 'buyer_country_code', 'buyer_phone', 'buyer_tax',
    'ship_to', 'ship_to_city', 'shipment_date',
    'payment_terms', 'payment_terms_code', 'inco_terms', 'freight_terms',
    'origin', 'ultimate_dest',
    'total', 'currency_code',
    'packaging_total', 'packaging_type',
    'invoice_list', 'pl_list'
  ],

  // === 4. BILL OF LADING (BL) ===
  '705': [
    'doc_code', 'doc_name', 'confidence_score',
    'shipper_name', 'shipper_address', 'shipper_phone', 'shipper_country', 'shipper_country_code', 'shipper_tax_id',
    'consignee_name', 'consignee_address', 'consignee_tax_id',
    'on_behalf_of_name', 'on_behalf_of_address', 'on_behalf_of_tax_id',
    'notify_party_name', 'notify_party_tax_id', 'notify_party_address',
    'vessel_name', 'voyage_no', 'port_of_discharge', 'place_of_receipt', 'port_of_loading',
    'movement_type', 'date_of_loading', 'date_of_issue', 'date_of_sailing',
    'bill_loading_no',
    'weight', 'uow', 'uom', 'measurement',
    'packaging', 'containers', 'items'
  ],

  // === 5. AIR WAYBILL (AWB) / HOUSE AWB ===
  '740': [
    'doc_code', 'doc_name', 'confidence_score',
    'awb_num', 'awb_num_add', 'doc_date',
    'shipper_name', 'shipper_address', 'shipper_phone', 'shipper_tax_id', 'shipper_country', 'shipper_country_code',
    'carrier_name', 'carrier_address',
    'consignee_name', 'consignee_address', 'consignee_tax_id', 'consignee_phone', 'consignee_fax', 'consignee_notify_name',
    'departure_airport', 'departure_airport_code', 'departure_airport_country_code',
    'transit_airport', 'transit_airport_code', 'transit_airport_country_code',
    'destination_airport', 'destination_airport_code', 'destination_airport_country_code',
    'flight_num', 'flight_name', 'departure_date',
    'box_num', 'weight',
    'packs', 'items'
  ],

  // === 6. COO ===
  '861': [
    'doc_code', 'doc_name', 'confidence_score',
    'doc_date', 'doc_no', 'fta', 'packages'
  ],

  // === 7. E-COO ===
  '860': [
    'doc_code', 'doc_name', 'confidence_score',
    'doc_date', 'doc_no', 'fta', 'items'
  ],

  // === 8. LAPORAN SURVEYOR ===
  '958': [
    'doc_code', 'doc_name', 'confidence_score',
    'ls_number', 'vo_number',
    'importer_name', 'importer_address', 'importer_city', 'importer_tax_id', 'importer_API_NIB', 'importer_PI', 'importer_expiry_PI', 'date_of_expiry',
    'exporter_name', 'exporter_address', 'exporter_country',
    'transportation_mode', 'port_loading', 'port_discharge',
    'total_net_weight', 'total_net_weight_measurement',
    'place_of_verification', 'date_of_verification', 'date_of_issuance',
    'quantity', 'type_packing',
    'items', 'invoice_list_number'
  ],

  // === 10. MASTER AWB ===
  '741': [
    'doc_code', 'doc_name', 'confidence_score',
    'master_num', 'doc_date', 'flight_num', 'flight_name', 'items'
  ],

  // === 11. MASTER BL ===
  '704': [
    'doc_code', 'doc_name', 'confidence_score',
    'master_num', 'doc_date', 'vessel_name', 'voyage_no'
  ],

  '871': ['doc_code', 'doc_name', 'confidence_score', 'doc_date', 'doc_number'],
  '854': ['doc_code', 'doc_name', 'confidence_score', 'doc_date', 'doc_number'],
  '999': ['doc_code', 'doc_name', 'confidence_score', 'doc_date', 'doc_number'],
  '888': ['doc_code', 'doc_name', 'confidence_score', 'doc_date', 'doc_number'],
  '800': ['doc_code', 'doc_name', 'confidence_score', 'doc_date', 'doc_number'],
  '457': ['doc_code', 'doc_name', 'confidence_score', 'doc_date', 'doc_number'],
  '846': ['doc_code', 'doc_name', 'confidence_score', 'doc_date', 'doc_number'],
  '957': ['doc_code', 'doc_name', 'confidence_score', 'doc_date', 'doc_number'],
  '959': ['doc_code', 'doc_name', 'confidence_score', 'doc_date', 'doc_number'],
  '000': ['doc_code', 'doc_name', 'confidence_score', 'doc_date', 'doc_number'],
  '813': ['doc_code', 'doc_name', 'confidence_score', 'doc_date', 'doc_number'],
};

/**
 * Fungsi untuk mentransformasi urutan object JSONB (Raw Data) kembali ke urutan Schema asli.
 * Mengembalikan objek JSON yang sudah diurutkan.
 * * @param {Object} rawObj - Objek JSON mentah dari database (JSONB)
 * @param {String} docCode - Kode dokumen (contoh: '380')
 * @returns {Object} Objek JSON yang diurutkan
 */
export const transformRawData = (rawObj, docCode) => {
  if (!rawObj || typeof rawObj !== 'object' || Array.isArray(rawObj)) {
    return rawObj;
  }

  delete rawObj.doc_code;
  delete rawObj.doc_name;
  delete rawObj.confidence_score;

  const orderReference = SCHEMA_ORDERS[docCode];

  // Jika schema belum didefinisikan di kamus (misal ada doc_code baru di masa depan),
  // kembalikan apa adanya agar aplikasi tidak crash
  if (!orderReference) return rawObj;

  const orderedObj = {};

  // 1. Masukkan key yang ada di kamus sesuai dengan urutan mutlaknya
  for (const key of orderReference) {
    if (rawObj[key] !== undefined) {
      orderedObj[key] = rawObj[key];
    }
  }

  // 2. Fallback Safety: Masukkan sisa key (jika AI "berhalusinasi" memunculkan key baru
  // yang tidak ada di dalam schema/kamus, kita pastikan data tersebut tidak hilang)
  for (const key of Object.keys(rawObj)) {
    if (!orderedObj.hasOwnProperty(key)) {
      orderedObj[key] = rawObj[key];
    }
  }

  return orderedObj;
};