import http from 'k6/http';

export function createTestSite(baseUrl, siteId, siteName, adminToken) {
  const res = http.post(
    `${baseUrl}/api/v1/admin/sites`,
    JSON.stringify({ id: siteId, name: siteName }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
        'X-Lumi-Site': 'site_demo', // use existing demo site for admin request mapping
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
    `${baseUrl}/api/v1/admin/sites/${siteId}`,
    null,
    {
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'X-Lumi-Site': 'site_demo',
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
