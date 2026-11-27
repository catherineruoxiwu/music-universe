// A key-value store in IndexedDB, for what is too large for localStorage: an imported library with
// its credits runs to several megabytes.

const DATABASE = 'music-universe';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Storage is in use by another tab'));
  });
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

/** Resolves undefined when nothing is stored, or when storage cannot be used at all. */
export async function loadValue<T>(key: string): Promise<T | undefined> {
  try {
    return await run<T | undefined>('readonly', (store) => store.get(key));
  } catch {
    // Storage can be unavailable (private browsing, blocked site data); the app then starts empty.
    return undefined;
  }
}

/** @throws when the value could not be stored, e.g. because the browser's quota is used up. */
export async function saveValue(key: string, value: unknown): Promise<void> {
  await run('readwrite', (store) => store.put(value, key));
}

export async function deleteValue(key: string): Promise<void> {
  try {
    await run('readwrite', (store) => store.delete(key));
  } catch {
    // Nothing could be stored there either, so there is nothing left behind.
  }
}
