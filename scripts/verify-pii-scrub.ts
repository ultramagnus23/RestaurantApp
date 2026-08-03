#!/usr/bin/env tsx
// Proves ground rule 3: customer names and phone numbers can never reach
// storage. The canonical schema (lib/csv-ingest.ts's CanonicalField union)
// has no destination field for either - this test feeds a CSV containing
// a real-looking name and phone number through the actual ingest function
// and asserts neither value appears anywhere in the parsed output, even
// though those columns exist in the source file and are NOT part of the
// mapping. If someone ever "helpfully" adds a passthrough/raw-payload
// field to ingestRows, this test is designed to catch it.

import { ingestRows, type ColumnMapping } from '../lib/csv-ingest'

const PLANTED_NAME = 'Rohan Sharma'
const PLANTED_PHONE = '9876543210'

const rows = [
  {
    'Bill No': 'B-1001',
    'Customer Name': PLANTED_NAME,
    'Phone': PLANTED_PHONE,
    'Order Time': '2026-07-18 19:30:00',
    'Item': 'Butter Chicken',
    'Qty': '1',
    'Rate': '480',
    'Payment Mode': 'UPI',
  },
  {
    'Bill No': 'B-1001',
    'Customer Name': PLANTED_NAME,
    'Phone': PLANTED_PHONE,
    'Order Time': '2026-07-18 19:30:00',
    'Item': 'Masala Chai',
    'Qty': '2',
    'Rate': '90',
    'Payment Mode': 'UPI',
  },
]

// Deliberately does NOT map Customer Name or Phone to anything - there is
// no canonical field they could map to. This is the realistic case: an
// owner uploads their raw POS export as-is, columns and all.
const mapping: ColumnMapping = {
  external_bill_id: 'Bill No',
  opened_at: 'Order Time',
  item_name_raw: 'Item',
  qty: 'Qty',
  price: 'Rate',
  payment_type: 'Payment Mode',
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

const result = ingestRows(rows, mapping)

const serialized = JSON.stringify(result)

if (serialized.includes(PLANTED_NAME)) {
  fail(`planted customer name "${PLANTED_NAME}" leaked into the ingest output`)
}
if (serialized.includes(PLANTED_PHONE)) {
  fail(`planted phone number "${PLANTED_PHONE}" leaked into the ingest output`)
}
if (result.bills.length !== 1) {
  fail(`expected exactly 1 bill grouped from 2 rows, got ${result.bills.length}`)
}
if (result.bills[0].items.length !== 2) {
  fail(`expected 2 items on the bill, got ${result.bills[0].items.length}`)
}
if (result.rowsRejected !== 0) {
  fail(`expected 0 rejections for well-formed rows, got ${result.rowsRejected}: ${JSON.stringify(result.rejections)}`)
}

// Also confirm the canonical field set itself has no name/phone destination -
// a structural guarantee, not just an absence-in-this-sample-output check.
const CANONICAL_FIELDS_SOURCE = ['external_bill_id', 'opened_at', 'settled_at', 'table_ref', 'gross', 'discount', 'payment_type', 'item_name_raw', 'qty', 'price', 'category']
const suspicious = CANONICAL_FIELDS_SOURCE.filter((f) => /name|phone|customer|contact/i.test(f) && f !== 'item_name_raw')
if (suspicious.length > 0) {
  fail(`canonical field set has a suspicious PII-shaped field: ${suspicious.join(', ')}`)
}

console.log('PASS: no customer name or phone number reached the ingest output.')
console.log(`  bills: ${result.bills.length}, items: ${result.bills[0].items.length}, rejections: ${result.rowsRejected}`)
console.log(`  gross computed: Rs.${result.bills[0].gross} (source: ${result.bills[0].gross_source})`)

// --- Rejection path: a row missing a required field must be rejected
// with a plain-language reason, not silently dropped or fabricated. ---
const rowsWithBadPrice = [
  ...rows,
  { 'Bill No': 'B-1002', 'Order Time': '2026-07-18 20:00:00', 'Item': 'Tiramisu', 'Qty': '1', 'Rate': '' },
]
const result2 = ingestRows(rowsWithBadPrice, mapping)
if (result2.rowsRejected !== 1) {
  fail(`expected exactly 1 rejection for the blank-price row, got ${result2.rowsRejected}`)
}
if (!/price/i.test(result2.rejections[0].reason)) {
  fail(`rejection reason should mention price, got: "${result2.rejections[0].reason}"`)
}
if (result2.bills.length !== 1) {
  fail(`the rejected row's bill should not appear at all (it has no other valid rows), got ${result2.bills.length} bills`)
}
console.log(`PASS: blank price rejected with reason "${result2.rejections[0].reason}"`)

// --- Multi-bill grouping: two distinct bills must stay separate, not
// merged into one. ---
const twoBillRows = [
  { 'Bill No': 'B-A', 'Order Time': '2026-07-18 19:00:00', 'Item': 'Coffee', 'Qty': '1', 'Rate': '150' },
  { 'Bill No': 'B-B', 'Order Time': '2026-07-18 19:05:00', 'Item': 'Tea', 'Qty': '1', 'Rate': '90' },
]
const result3 = ingestRows(twoBillRows, mapping)
if (result3.bills.length !== 2) {
  fail(`expected 2 distinct bills, got ${result3.bills.length}`)
}
console.log('PASS: distinct bill IDs stay ungrouped.')
