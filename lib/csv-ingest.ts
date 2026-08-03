// Generic CSV ingest for POS exports - no provider-specific parsers (per
// the spec: "no real export samples exist yet; do not guess Petpooja/
// Posist formats"). One row = one bill line item; bill-level fields
// (external_bill_id, opened_at, table_ref, gross, discount, payment_type)
// are read from the first row seen for that external_bill_id, matching
// the common flat item-level POS export shape where bill fields repeat
// across every item line of the same bill.
//
// PII: customer names and phone numbers have NO destination field in the
// canonical schema at all - there is no column to map them to, and this
// module never passes through an unmapped source column. That's the
// structural guarantee; scripts/verify-pii-scrub.ts proves it end to end.

export type CanonicalField =
  | 'external_bill_id'
  | 'opened_at'
  | 'settled_at'
  | 'table_ref'
  | 'gross'
  | 'discount'
  | 'payment_type'
  | 'item_name_raw'
  | 'qty'
  | 'price'
  | 'category'

export const REQUIRED_FIELDS: CanonicalField[] = [
  'external_bill_id',
  'opened_at',
  'item_name_raw',
  'price',
]

export const OPTIONAL_FIELDS: CanonicalField[] = [
  'settled_at',
  'table_ref',
  'gross',
  'discount',
  'payment_type',
  'qty',
  'category',
]

export const ALL_FIELDS: CanonicalField[] = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]

// canonical field -> source CSV column name. Only fields the venue
// actually has get an entry; missing optional fields are simply absent.
export type ColumnMapping = Partial<Record<CanonicalField, string>>

export type Rejection = { row_number: number; reason: string }

export type ParsedBillItem = {
  item_name_raw: string
  qty: number
  price: number
  category: string | null
}

export type ParsedBill = {
  external_bill_id: string
  opened_at: string // ISO
  settled_at: string | null
  table_ref: string | null
  gross: number
  gross_source: 'mapped' | 'derived' // for evidence/audit, not stored - derived means summed from item lines
  discount: number
  payment_type: 'upi' | 'card' | 'cash' | 'other' | null
  items: ParsedBillItem[]
}

export type IngestResult = {
  bills: ParsedBill[]
  rowsIn: number
  rowsParsed: number
  rowsRejected: number
  rejections: Rejection[]
}

const UPI_KEYWORDS = ['upi', 'gpay', 'google pay', 'phonepe', 'paytm', 'bhim']
const CARD_KEYWORDS = ['card', 'credit', 'debit', 'visa', 'mastercard', 'rupay', 'pos machine', 'swipe']
const CASH_KEYWORDS = ['cash']

export function normalizePaymentType(raw: string | undefined | null): 'upi' | 'card' | 'cash' | 'other' | null {
  if (!raw) return null
  const v = raw.trim().toLowerCase()
  if (!v) return null
  if (UPI_KEYWORDS.some((k) => v.includes(k))) return 'upi'
  if (CARD_KEYWORDS.some((k) => v.includes(k))) return 'card'
  if (CASH_KEYWORDS.some((k) => v.includes(k))) return 'cash'
  return 'other'
}

function parseNumber(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null
  const cleaned = raw.replace(/[,₹$\s]/g, '')
  if (cleaned === '') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

function parseTimestamp(raw: string | undefined | null): string | null {
  if (!raw || !raw.trim()) return null
  const d = new Date(raw.trim())
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

/**
 * Pure transform: raw CSV rows (Papa Parse `header: true` output, i.e.
 * one object per row keyed by source column name) + a column mapping ->
 * grouped, normalized bills with their line items, plus rejected rows
 * with reasons. Never fabricates a value - a missing/unparseable
 * required field rejects the row instead of guessing.
 */
export function ingestRows(rows: Record<string, string>[], mapping: ColumnMapping): IngestResult {
  const rejections: Rejection[] = []
  const billGroups = new Map<string, { rows: Record<string, string>[]; rowNumbers: number[] }>()

  rows.forEach((row, idx) => {
    const rowNumber = idx + 1 // 1-based, matches what a spreadsheet user sees as the data row

    const externalBillId = mapping.external_bill_id ? row[mapping.external_bill_id]?.trim() : ''
    if (!externalBillId) {
      rejections.push({ row_number: rowNumber, reason: 'Missing bill ID - cannot group this row into a bill.' })
      return
    }

    const openedAtRaw = mapping.opened_at ? row[mapping.opened_at] : undefined
    if (!parseTimestamp(openedAtRaw)) {
      rejections.push({ row_number: rowNumber, reason: `Missing or unreadable bill open time ("${openedAtRaw ?? ''}").` })
      return
    }

    const itemName = mapping.item_name_raw ? row[mapping.item_name_raw]?.trim() : ''
    if (!itemName) {
      rejections.push({ row_number: rowNumber, reason: 'Missing item name.' })
      return
    }

    const priceRaw = mapping.price ? row[mapping.price] : undefined
    const price = parseNumber(priceRaw)
    if (price === null) {
      rejections.push({ row_number: rowNumber, reason: `Missing or unreadable price ("${priceRaw ?? ''}").` })
      return
    }

    if (!billGroups.has(externalBillId)) {
      billGroups.set(externalBillId, { rows: [], rowNumbers: [] })
    }
    billGroups.get(externalBillId)!.rows.push(row)
    billGroups.get(externalBillId)!.rowNumbers.push(rowNumber)
  })

  const bills: ParsedBill[] = []

  for (const [externalBillId, group] of billGroups) {
    const firstRow = group.rows[0]

    const openedAt = parseTimestamp(mapping.opened_at ? firstRow[mapping.opened_at] : undefined)!
    const settledAt = mapping.settled_at ? parseTimestamp(firstRow[mapping.settled_at]) : null
    const tableRef = mapping.table_ref ? firstRow[mapping.table_ref]?.trim() || null : null
    const discount = mapping.discount ? parseNumber(firstRow[mapping.discount]) ?? 0 : 0
    const paymentType = mapping.payment_type ? normalizePaymentType(firstRow[mapping.payment_type]) : null

    const items: ParsedBillItem[] = group.rows.map((row) => ({
      item_name_raw: (mapping.item_name_raw ? row[mapping.item_name_raw] : '').trim(),
      qty: (mapping.qty ? parseNumber(row[mapping.qty]) : null) ?? 1,
      price: (mapping.price ? parseNumber(row[mapping.price]) : null) ?? 0,
      category: mapping.category ? row[mapping.category]?.trim() || null : null,
    }))

    const mappedGross = mapping.gross ? parseNumber(firstRow[mapping.gross]) : null
    const derivedGross = items.reduce((sum, it) => sum + it.qty * it.price, 0)
    const gross = mappedGross ?? derivedGross

    bills.push({
      external_bill_id: externalBillId,
      opened_at: openedAt,
      settled_at: settledAt,
      table_ref: tableRef,
      gross,
      gross_source: mappedGross !== null ? 'mapped' : 'derived',
      discount,
      payment_type: paymentType,
      items,
    })
  }

  return {
    bills,
    rowsIn: rows.length,
    rowsParsed: rows.length - rejections.length,
    rowsRejected: rejections.length,
    rejections,
  }
}

export function missingRequiredFields(mapping: ColumnMapping): CanonicalField[] {
  return REQUIRED_FIELDS.filter((f) => !mapping[f])
}
