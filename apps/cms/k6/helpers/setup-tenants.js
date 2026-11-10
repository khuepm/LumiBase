import http from 'k6/http';

export function createTestSite(baseUrl, siteId, siteName, adminToken) {
  const res = http.post(
    `${baseUrl}/api/v1/orgs/${organizationId()}/sites`,
    JSON.stringify({ id: siteId, name: siteName }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${organizationToken(adminToken)}`,
      },
    }
  );
  if (res.status !== 201) {
    throw new Error(`Failed to create test site ${siteId}: Status ${res.status} - ${res.body}`);
  }
  return res.json().data;
}

export function deleteTestSite(baseUrl, siteId, adminToken) {
  const res = http.del(
    `${baseUrl}/api/v1/orgs/${organizationId()}/sites/${siteId}`,
    null,
    {
      headers: {
        'Authorization': `Bearer ${ownerToken()}`,
        'X-Confirm-Delete': siteId,
      },
    }
  );
  return res.status === 200;
}

export function createCollection(baseUrl, siteId, collectionName, adminToken) {
  const res = http.post(
    `${baseUrl}/api/v1/collections`,
    JSON.stringify({ name: collectionName }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
        'X-Lumi-Site': siteId,
      },
    }
  );
  if (res.status !== 201) {
    throw new Error(`Failed to create collection ${collectionName} on ${siteId}: Status ${res.status}`);
  }
  return res.json().data;
}

export function createScimToken(baseUrl, siteId, label, adminToken) {
  const res = http.post(
    `${baseUrl}/api/v1/scim-tokens`,
    JSON.stringify({ label, lifespanDays: 30 }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
        'X-Lumi-Site': siteId,
      },
    }
  );
  if (res.status !== 201) {
    throw new Error(`Failed to create SCIM token for ${siteId}: Status ${res.status}`);
  }
  return res.json().data; // Returns token object including plaintext 'token' field
}

function organizationId() {
  if (!__ENV.ORGANIZATION_ID) throw new Error('Set ORGANIZATION_ID for the test organization');
  return __ENV.ORGANIZATION_ID;
}
function organizationToken(fallback) {
  const token = __ENV.ORGANIZATION_TOKEN || fallback;
  if (!token || !token.startsWith('lbo_')) throw new Error('Set ORGANIZATION_TOKEN to an lbo_ key');
  return token;
}
function ownerToken() {
  // Org keys are admin, never owner. Destructive cleanup needs a human owner.
  if (!__ENV.ORGANIZATION_OWNER_TOKEN) throw new Error('Set ORGANIZATION_OWNER_TOKEN to a Studio owner session for cleanup');
  return __ENV.ORGANIZATION_OWNER_TOKEN;
}
