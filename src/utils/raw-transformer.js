/* eslint-disable camelcase */
// ── Helpers ────────────────────────────────────────────────────────────────
const val  = (fields, key) => fields[key] ?? null;
const num  = (fields, key) => fields[key] != null ? parseFloat(fields[key]) : null;
const arr  = (items, groupName) => items.filter((i) => i._group === groupName);

// Konversi flat fields array → object { key: value }
const toMap = (fields) => {
  const map = {};
  for (const { key, value } of fields) map[key] = value;
  return map;
};

// Konversi items array → array of objects { key: value }
const toItemObjects = (items) => items.map(({ columns, ...rest }) => {
  const obj = {};
  for (const { key, value } of (columns || [])) obj[key] = value;
  return obj;
});

// ── Transformers per doc type ──────────────────────────────────────────────

const transform380 = (fields, items) => {
  const f        = toMap(fields);
  const allItems = toItemObjects(items);

  return {
    bill_to_name:    val(f, 'bill_to_name'),
    bill_to_address: val(f, 'bill_to_address'),

    seller_name:         val(f, 'seller_name'),
    seller_address:      val(f, 'seller_address'),
    seller_country:      val(f, 'seller_country'),
    seller_country_code: val(f, 'seller_country_code'),
    seller_phone:        val(f, 'seller_phone'),
    seller_tax:          val(f, 'seller_tax'),

    buyer_name:         val(f, 'buyer_name'),
    buyer_address:      val(f, 'buyer_address'),
    buyer_country:      val(f, 'buyer_country'),
    buyer_country_code: val(f, 'buyer_country_code'),
    buyer_phone:        val(f, 'buyer_phone'),
    buyer_tax:          val(f, 'buyer_tax'),
    buyer_customs_id:   val(f, 'buyer_customs_id'),

    ship_to:      val(f, 'ship_to'),
    ship_to_city: val(f, 'ship_to_city'),

    payment_terms:      val(f, 'payment_terms'),
    payment_terms_code: val(f, 'payment_terms_code'),
    inco_terms:         val(f, 'inco_terms'),
    freight_terms:      val(f, 'freight_terms'),

    total:         num(f, 'total'),
    currency_code: val(f, 'currency_code'),
    packaging_type: val(f, 'packaging_type'),

    invoice_list: [{
      invoice_number: val(f, 'invoice_number'),
      invoice_date:   val(f, 'invoice_date'),
      items: allItems.map((i) => ({
        number:              i.number              ?? null,
        prod_number:         i.prod_number         ?? null,
        description:         i.description         ?? null,
        quantity:            i.quantity != null ? parseFloat(i.quantity) : null,
        hs_code:             i.hs_code             ?? null,
        uom:                 i.uom                 ?? null,
        origin:              i.origin              ?? null,
        origin_code:         i.origin_code         ?? null,
        vendor_name:         i.vendor_name         ?? null,
        vendor_number:       i.vendor_number       ?? null,
        unit_price:          i.unit_price  != null ? parseFloat(i.unit_price)  : null,
        amount:              i.amount      != null ? parseFloat(i.amount)      : null,
        currency:            i.currency            ?? null,
        packaging_type_item: i.packaging_type_item ?? null,
      })),
    }],

    details_list: allItems
      .filter((i) => i.brand || i.unique_identifier)
      .map((i) => ({
        number:            i.number            ?? null,
        brand:             i.brand             ?? null,
        description:       i.description       ?? null,
        quantity:          i.quantity != null ? parseFloat(i.quantity) : null,
        hs_code:           i.hs_code           ?? null,
        product_number:    i.product_number    ?? null,
        unique_identifier: i.unique_identifier ?? null,
        uom:               i.uom               ?? null,
        origin:            i.origin            ?? null,
        origin_code:       i.origin_code       ?? null,
        vendor_name:       i.vendor_name       ?? null,
        vendor_number:     i.vendor_number     ?? null,
        unit_price:        i.unit_price != null ? parseFloat(i.unit_price) : null,
        amount:            i.amount     != null ? parseFloat(i.amount)     : null,
        currency:          i.currency          ?? null,
        packaging_type_item: i.packaging_type_item ?? null,
      })),

    banks: [],
  };
};

const transform217 = (fields, items) => {
  const f        = toMap(fields);
  const allItems = toItemObjects(items);

  return {
    packaging:           val(f, 'packaging'),
    packaging_qty_total: num(f, 'packaging_qty_total'),
    total_gross_weight:  num(f, 'total_gross_weight'),
    total_net_weight:    num(f, 'total_net_weight'),
    total_measurements:  num(f, 'total_measurements'),
    ship_by_name:        val(f, 'ship_by_name'),
    ship_by_address:     val(f, 'ship_by_address'),
    sold_by_name:        val(f, 'sold_by_name'),
    sold_by_address:     val(f, 'sold_by_address'),
    sold_to_name:        val(f, 'sold_to_name'),
    sold_to_address:     val(f, 'sold_to_address'),
    ship_to_name:        val(f, 'ship_to_name'),
    ship_to_address:     val(f, 'ship_to_address'),
    ship_date:           val(f, 'ship_date'),
    due_date:            val(f, 'due_date'),
    terms_of_payment:    val(f, 'terms_of_payment'),
    total_cartons:       num(f, 'total_cartons'),
    ship_via:            val(f, 'ship_via'),
    route:               val(f, 'route'),

    pl_list: [{
      invoice_number: val(f, 'invoice_number'),
      invoice_date:   val(f, 'invoice_date'),
      items: allItems.map((i) => ({
        number:        i.number        ?? null,
        description:   i.description   ?? null,
        quantity:      i.quantity      != null ? parseFloat(i.quantity)      : null,
        quantity_unit: i.quantity_unit ?? null,
        origin:        i.origin        ?? null,
        brand:         i.brand         ?? null,
        net_weight:    i.net_weight    != null ? parseFloat(i.net_weight)    : null,
        gross_weight:  i.gross_weight  != null ? parseFloat(i.gross_weight)  : null,
        amount:        i.amount        != null ? parseFloat(i.amount)        : null,
        unit_price:    i.unit_price    != null ? parseFloat(i.unit_price)    : null,
        measurement:   i.measurement   != null ? parseFloat(i.measurement)   : null,
        packaging_qty: i.packaging_qty != null ? parseFloat(i.packaging_qty) : null,
        packaging_unit: i.packaging_unit ?? null,
      })),
    }],
  };
};

const transform705 = (fields, items) => {
  const f        = toMap(fields);
  const allItems = toItemObjects(items);

  return {
    shipper_name:         val(f, 'shipper_name'),
    shipper_address:      val(f, 'shipper_address'),
    shipper_phone:        val(f, 'shipper_phone'),
    shipper_country:      val(f, 'shipper_country'),
    shipper_country_code: val(f, 'shipper_country_code'),
    shipper_tax_id:       val(f, 'shipper_tax_id'),

    consignee_name:    val(f, 'consignee_name'),
    consignee_address: val(f, 'consignee_address'),
    consignee_tax_id:  val(f, 'consignee_tax_id'),

    on_behalf_of_name:    val(f, 'on_behalf_of_name'),
    on_behalf_of_address: val(f, 'on_behalf_of_address'),
    on_behalf_of_tax_id:  val(f, 'on_behalf_of_tax_id'),

    notify_party_name:    val(f, 'notify_party_name'),
    notify_party_tax_id:  val(f, 'notify_party_tax_id'),
    notify_party_address: val(f, 'notify_party_address'),

    vessel_name:       val(f, 'vessel_name'),
    voyage_no:         val(f, 'voyage_no'),
    port_of_discharge: val(f, 'port_of_discharge'),
    place_of_receipt:  val(f, 'place_of_receipt'),
    port_of_loading:   val(f, 'port_of_loading'),
    movement_type:     val(f, 'movement_type'),
    date_of_loading:   val(f, 'date_of_loading'),
    date_of_issue:     val(f, 'date_of_issue'),
    date_of_sailing:   val(f, 'date_of_sailing'),
    bill_loading_no:   val(f, 'bill_loading_no'),
    weight:            num(f, 'weight'),
    uow:               val(f, 'uow'),
    uom:               val(f, 'uom'),
    measurement:       num(f, 'measurement'),

    packaging:  allItems.filter((i) => i.qty || i.packaging_unit).map((i) => ({
      qty:            i.qty            != null ? parseFloat(i.qty) : null,
      packaging_unit: i.packaging_unit ?? null,
      brand:          i.brand          ?? null,
    })),
    containers: allItems.filter((i) => i.container_code).map((i) => ({
      container_code:          i.container_code          ?? null,
      container_size:          i.container_size          != null ? parseFloat(i.container_size) : null,
      seal_code:               i.seal_code               ?? null,
      container_type_code:     i.container_type_code     ?? null,
      container_type:          i.container_type          ?? null,
      container_category_code: i.container_category_code ?? null,
      container_category:      i.container_category      ?? null,
    })),
    items: allItems.filter((i) => i.product_name || i.hs_code).map((i) => ({
      product_name: i.product_name ?? null,
      hs_code:      i.hs_code      ?? null,
      ctn_no:       i.ctn_no       ?? null,
      c_o:          i.c_o          ?? null,
    })),
  };
};

const transform740 = (fields, items) => {
  const f        = toMap(fields);
  const allItems = toItemObjects(items);

  return {
    awb_num:     val(f, 'awb_num'),
    awb_num_add: val(f, 'awb_num_add'),
    doc_date:    val(f, 'doc_date'),

    shipper_name:         val(f, 'shipper_name'),
    shipper_address:      val(f, 'shipper_address'),
    shipper_phone:        val(f, 'shipper_phone'),
    shipper_tax_id:       val(f, 'shipper_tax_id'),
    shipper_country:      val(f, 'shipper_country'),
    shipper_country_code: val(f, 'shipper_country_code'),

    carrier_name:    val(f, 'carrier_name'),
    carrier_address: val(f, 'carrier_address'),

    consignee_name:         val(f, 'consignee_name'),
    consignee_address:      val(f, 'consignee_address'),
    consignee_tax_id:       val(f, 'consignee_tax_id'),
    consignee_phone:        val(f, 'consignee_phone'),
    consignee_fax:          val(f, 'consignee_fax'),
    consignee_notify_name:  val(f, 'consignee_notify_name'),

    departure_airport:              val(f, 'departure_airport'),
    departure_airport_code:         val(f, 'departure_airport_code'),
    departure_airport_country_code: val(f, 'departure_airport_country_code'),
    transit_airport:                val(f, 'transit_airport'),
    transit_airport_code:           val(f, 'transit_airport_code'),
    transit_airport_country_code:   val(f, 'transit_airport_country_code'),
    destination_airport:            val(f, 'destination_airport'),
    destination_airport_code:       val(f, 'destination_airport_code'),
    destination_airport_country_code: val(f, 'destination_airport_country_code'),

    flight_num:     val(f, 'flight_num'),
    flight_name:    val(f, 'flight_name'),
    departure_date: val(f, 'departure_date'),
    box_num:        val(f, 'box_num'),
    weight:         num(f, 'weight'),

    packs: allItems.filter((i) => i.no_pieces || i.quantity).map((i) => ({
      no_pieces:      i.no_pieces      ?? null,
      quantity:       i.quantity       != null ? parseFloat(i.quantity)       : null,
      packaging_unit: i.packaging_unit ?? null,
      uom:            i.uom            ?? null,
      prod_number:    i.prod_number    ?? null,
      weight:         i.weight         != null ? parseFloat(i.weight)         : null,
      charger_weight: i.charger_weight != null ? parseFloat(i.charger_weight) : null,
      uow:            i.uow            ?? null,
      brand:          i.brand          ?? null,
    })),
    items: allItems.filter((i) => i.description || i.hs_code).map((i) => ({
      description: i.description ?? null,
      hs_code:     i.hs_code     ?? null,
    })),
  };
};

const transform861 = (fields, items) => {
  const f        = toMap(fields);
  const allItems = toItemObjects(items);
  return {
    doc_date: val(f, 'doc_date'),
    doc_no:   val(f, 'doc_no'),
    fta:      val(f, 'fta'),
    packages: allItems.map((i) => ({
      item_number:     i.item_number     ?? null,
      number_package:  i.number_package  != null ? parseFloat(i.number_package) : null,
      type_package:    i.type_package    ?? null,
      prod_number:     i.prod_number     ?? null,
      description:     i.description     ?? null,
      hs_code:         i.hs_code         ?? null,
      origin_criteria: i.origin_criteria ?? null,
      gross_weight:    i.gross_weight    != null ? parseFloat(i.gross_weight) : null,
      unit_value:      i.unit_value      ?? null,
      date_of_invoice: i.date_of_invoice ?? null,
    })),
  };
};

const transform860 = (fields, items) => {
  const f        = toMap(fields);
  const allItems = toItemObjects(items);
  return {
    doc_date: val(f, 'doc_date'),
    doc_no:   val(f, 'doc_no'),
    fta:      val(f, 'fta'),
    items: allItems.map((i) => ({
      item_number:     i.item_number     ?? null,
      number_package:  i.number_package  != null ? parseFloat(i.number_package) : null,
      type_package:    i.type_package    ?? null,
      prod_number:     i.prod_number     ?? null,
      description:     i.description     ?? null,
      hs_code:         i.hs_code         ?? null,
      origin_criteria: i.origin_criteria ?? null,
      gross_weight:    i.gross_weight    != null ? parseFloat(i.gross_weight) : null,
      unit_value:      i.unit_value      != null ? parseFloat(i.unit_value)   : null,
      date_of_invoice: i.date_of_invoice ?? null,
    })),
  };
};

const transform958 = (fields, items) => {
  const f        = toMap(fields);
  const allItems = toItemObjects(items);
  return {
    ls_number:  val(f, 'ls_number'),
    vo_number:  val(f, 'vo_number'),
    importer_name:       val(f, 'importer_name'),
    importer_address:    val(f, 'importer_address'),
    importer_city:       val(f, 'importer_city'),
    importer_tax_id:     val(f, 'importer_tax_id'),
    importer_API_NIB:    val(f, 'importer_API_NIB'),
    importer_PI:         val(f, 'importer_PI'),
    importer_expiry_PI:  val(f, 'importer_expiry_PI'),
    date_of_expiry:      val(f, 'date_of_expiry'),
    exporter_name:       val(f, 'exporter_name'),
    exporter_address:    val(f, 'exporter_address'),
    exporter_country:    val(f, 'exporter_country'),
    transportation_mode: val(f, 'transportation_mode'),
    port_loading:        val(f, 'port_loading'),
    port_discharge:      val(f, 'port_discharge'),
    total_net_weight:             val(f, 'total_net_weight'),
    total_net_weight_measurement: val(f, 'total_net_weight_measurement'),
    place_of_verification: val(f, 'place_of_verification'),
    date_of_verification:  val(f, 'date_of_verification'),
    date_of_issuance:      val(f, 'date_of_issuance'),
    quantity:     val(f, 'quantity'),
    type_packing: val(f, 'type_packing'),
    items: allItems.map((i) => ({
      number_item:          i.number_item          ?? null,
      hs_code:              i.hs_code              ?? null,
      description:          i.description          ?? null,
      quantity_goods:       i.quantity_goods        ?? null,
      unit_of_measurement:  i.unit_of_measurement  ?? null,
      origin:               i.origin               ?? null,
    })),
    invoice_list_number: allItems
      .filter((i) => i.invoice_number)
      .map((i) => ({ invoice_number: i.invoice_number })),
  };
};

const transform704 = (fields) => {
  const f = toMap(fields);
  return {
    master_num:  val(f, 'master_num'),
    doc_date:    val(f, 'doc_date'),
    vessel_name: val(f, 'vessel_name'),
    voyage_no:   val(f, 'voyage_no'),
  };
};

const transform741 = (fields) => {
  const f = toMap(fields);
  return {
    master_num:  val(f, 'master_num'),
    doc_date:    val(f, 'doc_date'),
    flight_num:  val(f, 'flight_num'),
    flight_name: val(f, 'flight_name'),
  };
};

// Dokumen dengan hanya doc_date + doc_number
const transformSimple = (fields) => {
  const f = toMap(fields);
  return {
    doc_date:   val(f, 'doc_date'),
    doc_number: val(f, 'doc_number'),
  };
};

// CIPL — khusus karena punya invoice_list + pl_list
const transform001 = (fields, items) => {
  const f = toMap(fields);
  const invoiceItems = items
    .filter((i) => i._group === 'invoice_list' || !i._group)
    .map(({ columns }) => {
      const obj = {};
      for (const { key, value } of (columns || [])) obj[key] = value;
      return obj;
    });
  const plItems = items
    .filter((i) => i._group === 'pl_list')
    .map(({ columns }) => {
      const obj = {};
      for (const { key, value } of (columns || [])) obj[key] = value;
      return obj;
    });

  return {
    packing_list_number: val(f, 'packing_list_number') ? [val(f, 'packing_list_number')] : [],
    packing_list_date:   val(f, 'packing_list_date')   ? [val(f, 'packing_list_date')]   : [],
    seller_name:         val(f, 'seller_name'),
    seller_address:      val(f, 'seller_address'),
    seller_country:      val(f, 'seller_country'),
    seller_country_code: val(f, 'seller_country_code'),
    seller_phone:        val(f, 'seller_phone'),
    buyer_name:          val(f, 'buyer_name'),
    buyer_address:       val(f, 'buyer_address'),
    buyer_country:       val(f, 'buyer_country'),
    buyer_country_code:  val(f, 'buyer_country_code'),
    buyer_phone:         val(f, 'buyer_phone'),
    buyer_tax:           val(f, 'buyer_tax'),
    ship_to:             val(f, 'ship_to'),
    ship_to_city:        val(f, 'ship_to_city'),
    shipment_date:       val(f, 'shipment_date'),
    payment_terms:       val(f, 'payment_terms'),
    payment_terms_code:  val(f, 'payment_terms_code'),
    inco_terms:          val(f, 'inco_terms'),
    freight_terms:       val(f, 'freight_terms'),
    origin:              val(f, 'origin'),
    ultimate_dest:       val(f, 'ultimate_dest'),
    total:               val(f, 'total'),
    currency_code:       val(f, 'currency_code'),
    packaging_total:     val(f, 'packaging_total'),
    packaging_type:      val(f, 'packaging_type'),
    invoice_list: [{
      invoice_number: val(f, 'invoice_number'),
      invoice_date:   val(f, 'invoice_date'),
      items: invoiceItems.map((i) => ({
        number:              i.number              ?? null,
        prod_number:         i.prod_number         ?? null,
        description:         i.description         ?? null,
        quantity:            i.quantity != null ? parseFloat(i.quantity) : null,
        hs_code:             i.hs_code             ?? null,
        uom:                 i.uom                 ?? null,
        origin:              i.origin              ?? null,
        origin_code:         i.origin_code         ?? null,
        vendor_name:         i.vendor_name         ?? null,
        vendor_number:       i.vendor_number       ?? null,
        unit_price:          i.unit_price  != null ? parseFloat(i.unit_price)  : null,
        amount:              i.amount      != null ? parseFloat(i.amount)      : null,
        currency:            i.currency            ?? null,
        packaging_type_item: i.packaging_type_item ?? null,
      })),
    }],
    pl_list: [{
      invoice_number: val(f, 'invoice_number'),
      invoice_date:   val(f, 'invoice_date'),
      items: plItems.map((i) => ({
        number:         i.number         ?? null,
        description:    i.description    ?? null,
        quantity:       i.quantity       != null ? parseFloat(i.quantity)       : null,
        quantity_unit:  i.quantity_unit  ?? null,
        origin:         i.origin         ?? null,
        brand:          i.brand          ?? null,
        net_weight:     i.net_weight     != null ? parseFloat(i.net_weight)     : null,
        gross_weight:   i.gross_weight   != null ? parseFloat(i.gross_weight)   : null,
        amount:         i.amount         != null ? parseFloat(i.amount)         : null,
        unit_price:     i.unit_price     != null ? parseFloat(i.unit_price)     : null,
        measurement:    i.measurement    != null ? parseFloat(i.measurement)    : null,
        packaging_qty:  i.packaging_qty  != null ? parseFloat(i.packaging_qty)  : null,
        packaging_unit: i.packaging_unit ?? null,
      })),
    }],
  };
};

// ── Registry ───────────────────────────────────────────────────────────────
const TRANSFORMERS = {
  '380': transform380,
  '217': transform217,
  '001': transform001,
  '705': transform705,
  '740': transform740,
  '860': transform860,
  '861': transform861,
  '958': transform958,
  '704': (f) => transform704(f),
  '741': (f) => transform741(f),
};

const SIMPLE_DOCS = ['457', '800', '813', '846', '854', '871', '888', '957', '959', '999', '000'];

/**
 * Transform EAV fields + items → structured raw object sesuai doc type
 * @param {string} docCode
 * @param {Array}  fields  - [{ key, value }]
 * @param {Array}  items   - [{ row_index, columns: [{key, value}], _group? }]
 * @returns {object}
 */
export const transformToRaw = (docCode, fields, items) => {
  if (SIMPLE_DOCS.includes(docCode)) {
    return transformSimple(fields);
  }

  const transformer = TRANSFORMERS[docCode];
  if (!transformer) {
    // Fallback untuk doc type tidak dikenal
    return transformSimple(fields);
  }

  return transformer(fields, items);
};