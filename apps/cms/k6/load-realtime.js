/**
 * load-realtime.js — WebSocket realtime subscription ramp test.
 *
 * Tests the SiteRoom Durable Object's ability to handle concurrent subscribers.
 *
 * Scenario:
 *   - Ramp to 100 concurrent WebSocket connections.
 *   - Each VU subscribes to a collection, receives events for 30 s, then disconnects.
 *   - Measures: connection time, message delivery latency, error rate.
 *
 * Run:
 *   k6 run --env BASE_URL=ws://localhost:8787 \
 *          --env SITE_ID=site_test \
 *          --env TOKEN=dev:user123 \
 *          --env COLLECTION=articles \
 *          load-realtime.js
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

export const options = {
  scenarios: {
    realtime_ramp: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '20s', target: 25  },
        { duration: '40s', target: 100 },
        { duration: '20s', target: 0   },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    'ws_connecting':          ['p(95)<500'],    // connect in < 500ms
    'ws_msgs_received':       ['count>0'],
    'realtime_errors':        ['count<5'],
  },
};

const BASE_URL   = __ENV.BASE_URL   || 'ws://localhost:8787';
const SITE_ID    = __ENV.SITE_ID    || 'site_test';
const TOKEN      = __ENV.TOKEN      || 'dev:user123';
const COLLECTION = __ENV.COLLECTION || 'articles';

const realtimeErrors   = new Counter('realtime_errors');
const messageLatency   = new Trend('realtime_msg_latency_ms', true);

export default function () {
  const url = `${BASE_URL}/api/v1/realtime?token=${TOKEN}&site=${SITE_ID}`;

  const res = ws.connect(url, {}, function (socket) {
    let subscribed = false;
    let msgCount   = 0;
    let pingTime   = 0;

    socket.on('open', () => {
      // Send subscribe message
      socket.send(JSON.stringify({
        type: 'subscribe',
        collection: COLLECTION,
        event: ['create', 'update', 'delete'],
      }));
    });

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data);

        if (msg.type === 'subscription' && msg.status === 'ok') {
          subscribed = true;
          // Send a ping to measure round-trip latency
          pingTime = Date.now();
          socket.send(JSON.stringify({ type: 'ping' }));
        }

        if (msg.type === 'pong' && pingTime > 0) {
          messageLatency.add(Date.now() - pingTime);
          pingTime = 0;
        }

        if (msg.type === 'event') {
          msgCount++;
        }
      } catch {
        realtimeErrors.add(1);
      }
    });

    socket.on('error', () => {
      realtimeErrors.add(1);
    });

    // Stay connected for 30 seconds then clean up
    socket.setTimeout(() => {
      if (subscribed) {
        socket.send(JSON.stringify({ type: 'unsubscribe', collection: COLLECTION }));
      }
      socket.close();
    }, 30_000);
  });

  check(res, { 'ws connected': (r) => r && r.status === 101 });
  sleep(1);
}
