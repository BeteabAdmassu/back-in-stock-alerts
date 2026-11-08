import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from '../src/contracts.ts';
import { emailBackoffMs, stockCheckBackoffMs } from '../src/workers/backoff.ts';
import { createPoller } from '../src/workers/poller.ts';

const LONG_INTERVAL = 60_000;

function recordingLogger() {
  const lines: { obj: object; msg?: string }[] = [];
  const logger: Logger = {
    info: () => {},
    warn: () => {},
    error: (obj, msg) => lines.push({ obj, msg }),
  };
  return { logger, lines };
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition not met in time');
    await delay(2);
  }
}

test('never exceeds concurrency, claims only free slots, and refills as slots free', async () => {
  const queue = Array.from({ length: 10 }, (_, i) => i);
  const limits: number[] = [];
  let active = 0;
  let peak = 0;
  let done = 0;
  const poller = createPoller<number>({
    name: 'test',
    claim: (limit) => {
      limits.push(limit);
      return queue.splice(0, limit);
    },
    process: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(5);
      active -= 1;
      done += 1;
    },
    concurrency: 3,
    intervalMs: LONG_INTERVAL, // The interval cannot fire: only freed slots can drain the queue.
    logger: recordingLogger().logger,
  });
  poller.start();
  await until(() => done === 10);
  await poller.stop();
  assert.equal(peak, 3);
  assert.ok(limits.every((limit) => limit >= 1 && limit <= 3));
});

test('does not call claim when no slot is free', async () => {
  const gate = deferred();
  let claims = 0;
  const poller = createPoller<number>({
    name: 'test',
    claim: () => {
      claims += 1;
      return claims === 1 ? [1] : [];
    },
    process: () => gate.promise,
    concurrency: 1,
    intervalMs: LONG_INTERVAL,
    logger: recordingLogger().logger,
  });
  poller.start();
  await until(() => claims === 1);
  poller.wake();
  await delay(10);
  assert.equal(claims, 1);
  gate.resolve();
  await poller.stop();
});

test('a throwing process or claim is logged without its message and the loop survives', async () => {
  const { logger, lines } = recordingLogger();
  const handled: number[] = [];
  let claims = 0;
  const poller = createPoller<number>({
    name: 'test',
    claim: () => {
      claims += 1;
      if (claims === 2) throw new Error('claim failed for customer@example.com');
      if (claims === 1) return [1];
      if (claims === 3) return [2];
      return [];
    },
    process: async (item) => {
      handled.push(item);
      if (item === 1) throw new Error('send failed for customer@example.com');
    },
    concurrency: 2,
    intervalMs: 5,
    logger,
  });
  poller.start();
  await until(() => handled.includes(2));
  await poller.stop();
  assert.equal(lines.length, 2);
  assert.ok(!JSON.stringify(lines).includes('customer@example.com'));
});

test('a process function that throws synchronously is contained too', async () => {
  const { logger, lines } = recordingLogger();
  let claims = 0;
  const poller = createPoller<number>({
    name: 'test',
    claim: () => {
      claims += 1;
      return claims === 1 ? [1] : [];
    },
    process: () => {
      throw new Error('boom');
    },
    concurrency: 1,
    intervalMs: LONG_INTERVAL,
    logger,
  });
  poller.start();
  await until(() => lines.length === 1);
  await poller.stop();
});

test('wake() from inside claim produces another pass, and wake() bursts coalesce', async () => {
  const queue: number[] = [];
  const handled: number[] = [];
  let claims = 0;
  const poller = createPoller<number>({
    name: 'test',
    claim: (limit) => {
      claims += 1;
      if (claims === 1) {
        queue.push(1);
        poller.wake();
        return [];
      }
      return queue.splice(0, limit);
    },
    process: async (item) => {
      handled.push(item);
    },
    concurrency: 2,
    intervalMs: LONG_INTERVAL,
    logger: recordingLogger().logger,
  });
  poller.start();
  await until(() => handled.length === 1);
  await delay(5);
  const settled = claims;
  poller.wake();
  poller.wake();
  poller.wake();
  await delay(10);
  assert.equal(claims, settled + 1);
  await poller.stop();
});

test('polls on the interval without being woken', async () => {
  let claims = 0;
  const poller = createPoller<number>({
    name: 'test',
    claim: () => {
      claims += 1;
      return [];
    },
    process: async () => {},
    concurrency: 1,
    intervalMs: 5,
    logger: recordingLogger().logger,
  });
  poller.start();
  await until(() => claims >= 3);
  await poller.stop();
});

test('stop() waits for in-flight items and stops claiming; wake() afterwards does nothing', async () => {
  const gate = deferred();
  let claims = 0;
  let started = false;
  let finished = false;
  const poller = createPoller<number>({
    name: 'test',
    claim: () => {
      claims += 1;
      return claims === 1 ? [1] : [];
    },
    process: async () => {
      started = true;
      await gate.promise;
      finished = true;
    },
    concurrency: 2,
    intervalMs: 5,
    logger: recordingLogger().logger,
  });
  poller.start();
  await until(() => started);

  let stopped = false;
  const stopping = poller.stop().then(() => {
    stopped = true;
  });
  await delay(15);
  assert.equal(stopped, false, 'stop() resolved before the in-flight item finished');
  const claimsAtStop = claims;

  gate.resolve();
  await stopping;
  assert.equal(finished, true);

  poller.wake();
  await delay(15);
  assert.equal(claims, claimsAtStop);
});

test('wake() before start and stop() without start are harmless', async () => {
  let claims = 0;
  const poller = createPoller<number>({
    name: 'test',
    claim: () => {
      claims += 1;
      return [];
    },
    process: async () => {},
    concurrency: 1,
    intervalMs: LONG_INTERVAL,
    logger: recordingLogger().logger,
  });
  poller.wake();
  await delay(5);
  assert.equal(claims, 0);
  await poller.stop();
});

test('email backoff follows the schedule, jitters by 10% and caps at one hour', () => {
  const expected = [5, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 3600];
  expected.forEach((seconds, i) => {
    assert.equal(
      emailBackoffMs(i + 1, () => 0.5),
      seconds * 1000,
    );
    assert.equal(
      emailBackoffMs(i + 1, () => 0),
      seconds * 900,
    );
    assert.equal(
      emailBackoffMs(i + 1, () => 1),
      seconds * 1100,
    );
  });
  assert.equal(
    emailBackoffMs(0, () => 0.5),
    5000,
  );
  assert.equal(
    emailBackoffMs(1000, () => 0.5),
    3_600_000,
  );
});

test('stock check backoff follows the schedule and caps at five minutes', () => {
  const expected = [5, 15, 30, 60, 120, 300, 300];
  expected.forEach((seconds, i) => {
    assert.equal(
      stockCheckBackoffMs(i + 1, () => 0.5),
      seconds * 1000,
    );
  });
  const jittered = stockCheckBackoffMs(1000);
  assert.ok(jittered >= 270_000 && jittered <= 330_000);
});
