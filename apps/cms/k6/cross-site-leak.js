import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { createTestSite, deleteTestSite, createCollection, createScimToken } from './helpers/setup-tenants.js';

// Setup phase: run once before the test starts
export function setup() {
  const BASE_URL = __ENV.BASE_URL || 'http://localhost:1989';
  const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || 'dev:admin@lumibase.dev:admin';

  const siteA = 'site_leak_test_a';
  const siteB = 'site_leak_test_b';

  console.log(`Setting up test tenants: ${siteA}, ${siteB}`);

  // Create sites
  createTestSite(BASE_URL, siteA, 'Tenant A', ADMIN_TOKEN);
  createTestSite(BASE_URL, siteB, 'Tenant B', ADMIN_TOKEN);

  // Create collection 'posts' in both sites
  createCollection(BASE_URL, siteA, 'posts', ADMIN_TOKEN);
  createCollection(BASE_URL, siteB, 'posts', ADMIN_TOKEN);

  // Create SCIM tokens for both sites
  const scimA = createScimToken(BASE_URL, siteA, 'SCIM A', ADMIN_TOKEN);
  const scimB = createScimToken(BASE_URL, siteB, 'SCIM B', ADMIN_TOKEN);

  return {
    baseUrl: BASE_URL,
    siteA,
    siteB,
    adminToken: ADMIN_TOKEN,
    tokenA: `dev:user_a@lumibase.dev:admin`,
    tokenB: `dev:user_b@lumibase.dev:admin`,
    scimTokenA: scimA.token,
    scimTokenB: scimB.token,
  };
}

export default function (data) {
  const { baseUrl, siteA, siteB, tokenA, tokenB, scimTokenA, scimTokenB } = data;

  const headersA = {
    'Authorization': `Bearer ${tokenA}`,
    'X-Lumi-Site': siteA,
    'Content-Type': 'application/json',
  };

  const headersB = {
    'Authorization': `Bearer ${tokenB}`,
    'X-Lumi-Site': siteB,
    'Content-Type': 'application/json',
  };

  // ---------------------------------------------------------------------------
  // Scenario 1: Data isolation
  // Create item in site_a, read list from site_b -> verify 0 results.
  // ---------------------------------------------------------------------------
  const createRes = http.post(
    `${baseUrl}/api/v1/items/posts`,
    JSON.stringify({ data: { title: 'Secret Post in Tenant A' }, status: 'published' }),
    { headers: headersA }
  );
  check(createRes, { 'item created in site_a': (r) => r.status === 201 });
  const itemIdA = createRes.json()?.data?.id;

  // Query site_b posts
  const listB = http.get(`${baseUrl}/api/v1/items/posts`, { headers: headersB });
  check(listB, {
    'site_b cannot see site_a data': (r) => {
      const items = r.json()?.data || [];
      return items.filter((item) => item.id === itemIdA).length === 0;
    },
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: Auth isolation
  // site_a token calls site_b endpoints -> verify 403.
  // ---------------------------------------------------------------------------
  const crossSiteRes = http.get(
    `${baseUrl}/api/v1/items/posts`,
    {
      headers: {
        'Authorization': `Bearer ${tokenA}`,
        'X-Lumi-Site': siteB,
      },
    }
  );
  // In Lumibase, if token does not have access to siteB (no userSites row), it returns 403.
  check(crossSiteRes, {
    'site_a token rejected on site_b': (r) => r.status === 403,
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: SCIM isolation
  // SCIM token site_a -> provision user site_b -> verify rejected or scopes to site_a
  // ---------------------------------------------------------------------------
  const scimHeaders = {
    'Authorization': `Bearer ${scimTokenA}`,
    'X-Lumi-Site': siteB, // Attempt to spoof siteB
    'Content-Type': 'application/json',
  };
  const scimRes = http.post(
    `${baseUrl}/scim/v2/Groups`,
    JSON.stringify({ displayName: 'Spoofed Team' }),
    { headers: scimHeaders }
  );
  // SCIM middleware automatically resolves siteId from token, overriding headers.
  // So the group is created on siteA, NOT siteB.
  check(scimRes, {
    'scim request succeeded (coerced)': (r) => r.status === 201,
  });

  if (scimRes.status === 201) {
    const groupId = scimRes.json()?.id;
    // Verify it does NOT exist on siteB
    const getGroupB = http.get(
      `${baseUrl}/api/v1/teams/${groupId}`,
      { headers: headersB }
    );
    check(getGroupB, {
      'spoofed group is not created on site_b': (r) => r.status === 404,
    });
  }

  // ---------------------------------------------------------------------------
  // Scenario 4: Search isolation
  // Search items site_a -> verify no items from site_b
  // ---------------------------------------------------------------------------
  // First, create a post in site_b
  const createB = http.post(
    `${baseUrl}/api/v1/items/posts`,
    JSON.stringify({ data: { title: 'Tenant B Search Post' }, status: 'published' }),
    { headers: headersB }
  );
  check(createB, { 'item created in site_b': (r) => r.status === 201 });
  const itemIdB = createB.json()?.data?.id;

  // Search site_a
  const searchA = http.get(
    `${baseUrl}/api/v1/search?q=Search`,
    { headers: headersA }
  );
  check(searchA, {
    'search site_a does not leak site_b': (r) => {
      const results = r.json()?.data || [];
      return results.filter((res) => res.id === itemIdB).length === 0;
    },
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: Realtime isolation
  // ws subscribe site_a -> create item site_b -> verify no event received
  // ---------------------------------------------------------------------------
  const wsUrl = baseUrl.replace(/^http/, 'ws') + `/api/v1/realtime?token=${tokenA}&site=${siteA}`;
  
  let wsEventLeaked = false;
  
  const wsRes = ws.connect(wsUrl, {}, function (socket) {
    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'subscribe',
        collection: 'posts',
        event: ['create'],
      }));

      // Trigger mutation on site_b after subscription starts
      socket.setTimeout(() => {
        http.post(
          `${baseUrl}/api/v1/items/posts`,
          JSON.stringify({ data: { title: 'Tenant B Realtime Post' }, status: 'published' }),
          { headers: headersB }
        );
      }, 500);
    });

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'event' && msg.payload?.title === 'Tenant B Realtime Post') {
          wsEventLeaked = true;
        }
      } catch (err) {}
    });

    socket.setTimeout(() => {
      socket.close();
    }, 2000);
  });

  check(wsRes, { 'ws connected': (r) => r && r.status === 101 });
  
  // Wait for WS connection to complete
  sleep(2.5);
  
  check(wsEventLeaked, {
    'no realtime leak from site_b to site_a': (l) => l === false,
  });
}

// Teardown phase: runs once after all VUs finish
export function teardown(data) {
  const { baseUrl, siteA, siteB, adminToken } = data;
  console.log(`Cleaning up test tenants: ${siteA}, ${siteB}`);
  deleteTestSite(baseUrl, siteA, adminToken);
  deleteTestSite(baseUrl, siteB, adminToken);
}
