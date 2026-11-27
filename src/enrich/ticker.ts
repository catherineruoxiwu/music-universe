// Waiting that keeps time in a background tab.
//
// Browsers slow a hidden page's timers down to as little as one a minute, which would stretch an
// hour of lookups into days as soon as the user looked at something else. Timers in a worker are
// not slowed, so the waiting is done there.

const SOURCE = 'onmessage = (event) => setTimeout(() => postMessage(event.data.id), event.data.ms);';

let worker: Worker | null | undefined;
let nextId = 1;
const waiting = new Map<number, () => void>();

function ticker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([SOURCE], { type: 'text/javascript' })));
    worker.onmessage = (event: MessageEvent<number>) => {
      waiting.get(event.data)?.();
      waiting.delete(event.data);
    };
  } catch {
    // No workers here: wait on the page's own timer, which is right whenever the page is in view.
    worker = null;
  }
  return worker;
}

/** Resolves after `ms`. Rejects with the signal's reason if it is aborted first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const clock = ticker();
    const id = nextId++;
    let timer = 0;
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      waiting.delete(id);
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (clock) {
      waiting.set(id, finish);
      clock.postMessage({ id, ms });
    } else {
      timer = window.setTimeout(finish, ms);
    }
  });
}
