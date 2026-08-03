// Local buffer for the phone capture page. Plain native IndexedDB (no
// dependency - this is small enough not to need one). Readings are
// enqueued here as they're computed and drained/flushed to
// /api/capture/[token]/readings on a timer; if the flush fails (flaky
// venue Wi-Fi), rows just stay queued until the next attempt succeeds -
// nothing is lost between capture and a confirmed upload.

const DB_NAME = 'meza-capture'
const DB_VERSION = 1
const STORE = 'readings'

export type QueuedReading = {
  signal_type: string
  timestamp: string
  value: unknown
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function enqueueReading(reading: QueuedReading): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).add(reading)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// Returns up to `limit` queued readings and their IDB keys, oldest first.
// Callers should only remove the returned keys after a confirmed upload.
export async function peekQueue(
  limit = 300
): Promise<{ keys: IDBValidKey[]; readings: QueuedReading[] }> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const keys: IDBValidKey[] = []
    const readings: QueuedReading[] = []
    const cursorReq = store.openCursor()
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (cursor && readings.length < limit) {
        keys.push(cursor.primaryKey)
        readings.push(cursor.value)
        cursor.continue()
      } else {
        resolve({ keys, readings })
      }
    }
    cursorReq.onerror = () => reject(cursorReq.error)
  })
}

export async function removeFromQueue(keys: IDBValidKey[]): Promise<void> {
  if (keys.length === 0) return
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const key of keys) store.delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function queueLength(): Promise<number> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).count()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
