import { Hono } from 'hono';
import type { AppEnv } from '../env';

export const testAuthRouter = new Hono<AppEnv>();

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LumiBase Auth Playground</title>
  <style>
    :root {
      --primary-gradient: linear-gradient(135deg, #6366f1 0%, #3b82f6 100%);
      --secondary-gradient: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%);
      --bg-color: #0b0f19;
      --panel-bg: rgba(22, 28, 45, 0.6);
      --border-color: rgba(255, 255, 255, 0.08);
      --text-primary: #f3f4f6;
      --text-secondary: #9ca3af;
      --input-bg: rgba(10, 15, 26, 0.8);
      --success-color: #10b981;
      --error-color: #ef4444;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family:
        -apple-system,
        BlinkMacSystemFont,
        'Segoe UI',
        Roboto,
        'Helvetica Neue',
        Arial,
        sans-serif;
      background-color: var(--bg-color);
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      padding: 40px 20px;
      overflow-x: hidden;
      position: relative;
    }

    /* Background Glowing Blobs */
    .glow-blob {
      position: absolute;
      width: 600px;
      height: 600px;
      border-radius: 50%;
      filter: blur(140px);
      z-index: -1;
      opacity: 0.12;
      pointer-events: none;
    }
    .blob-1 {
      top: -100px;
      left: -100px;
      background: #3b82f6;
      animation: float 25s infinite alternate;
    }
    .blob-2 {
      bottom: -100px;
      right: -100px;
      background: #c084fc;
      animation: float 30s infinite alternate-reverse;
    }

    @keyframes float {
      0% { transform: translate(0, 0) scale(1); }
      100% { transform: translate(80px, 80px) scale(1.15); }
    }

    .container {
      max-width: 1100px;
      width: 100%;
      z-index: 1;
    }

    header {
      text-align: center;
      margin-bottom: 40px;
    }

    header h1 {
      font-size: 2.8rem;
      font-weight: 800;
      background: linear-gradient(to right, #60a5fa, #c084fc);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 12px;
      letter-spacing: -0.02em;
    }

    header p {
      color: var(--text-secondary);
      font-size: 1.1rem;
      font-weight: 400;
    }

    .grid {
      display: grid;
      grid-template-columns: 1.2fr 1.8fr;
      gap: 30px;
    }

    @media (max-width: 900px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }

    .card {
      background: var(--panel-bg);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border-color);
      border-radius: 24px;
      padding: 30px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
      display: flex;
      flex-direction: column;
    }

    .tabs {
      display: flex;
      background: rgba(0, 0, 0, 0.35);
      border-radius: 12px;
      padding: 4px;
      margin-bottom: 25px;
      border: 1px solid rgba(255, 255, 255, 0.03);
    }

    .tab {
      flex: 1;
      text-align: center;
      padding: 10px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      font-size: 0.9rem;
      color: var(--text-secondary);
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      user-select: none;
    }

    .tab.active {
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
    }

    .form-group {
      margin-bottom: 18px;
    }

    label {
      display: block;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    input {
      width: 100%;
      background: var(--input-bg);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 12px 16px;
      font-family: inherit;
      color: #fff;
      font-size: 0.95rem;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }

    input:focus {
      outline: none;
      border-color: #6366f1;
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
    }

    .flex-row-gap {
      display: flex;
      gap: 12px;
    }
    .flex-row-gap > * {
      flex: 1;
    }

    .btn {
      width: 100%;
      padding: 14px;
      border-radius: 12px;
      border: none;
      font-family: inherit;
      font-weight: 600;
      font-size: 0.95rem;
      color: #fff;
      cursor: pointer;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }

    .btn-primary {
      background: var(--primary-gradient);
      box-shadow: 0 4px 14px rgba(59, 130, 246, 0.25);
    }

    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(59, 130, 246, 0.35);
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-color);
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .btn:active {
      transform: translateY(1px);
    }

    .console-panel {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .console-title {
      font-size: 1.25rem;
      font-weight: 700;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .badge {
      font-size: 0.7rem;
      padding: 4px 10px;
      border-radius: 6px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .badge-get { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.25); }
    .badge-post { background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.25); }
    .badge-status { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.25); }
    .badge-status.error { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.25); }

    .console-box {
      background: rgba(8, 12, 21, 0.95);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 20px;
      flex: 1;
      font-family:
        ui-monospace,
        SFMono-Regular,
        Menlo,
        Monaco,
        Consolas,
        'Liberation Mono',
        'Courier New',
        monospace;
      font-size: 0.85rem;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      color: #34d399;
      min-height: 380px;
      box-shadow: inset 0 2px 10px rgba(0,0,0,0.8);
    }

    .token-box {
      background: rgba(255, 255, 255, 0.02);
      border: 1px dashed var(--border-color);
      border-radius: 12px;
      padding: 16px;
      font-family:
        ui-monospace,
        SFMono-Regular,
        Menlo,
        Monaco,
        Consolas,
        'Liberation Mono',
        'Courier New',
        monospace;
      font-size: 0.8rem;
      color: var(--text-secondary);
      word-break: break-all;
      margin-bottom: 25px;
      position: relative;
    }

    .token-label {
      font-size: 0.7rem;
      color: #6366f1;
      font-weight: 700;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .token-value {
      line-height: 1.4;
      padding-right: 50px;
      user-select: all;
    }

    .copy-btn {
      position: absolute;
      top: 12px;
      right: 12px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-color);
      color: #fff;
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 0.7rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .copy-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .toast {
      position: fixed;
      bottom: 25px;
      right: 25px;
      background: #111827;
      border: 1px solid var(--border-color);
      padding: 16px 24px;
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.6);
      display: flex;
      align-items: center;
      gap: 12px;
      z-index: 100;
      transform: translateY(120px);
      opacity: 0;
      transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    .toast-icon {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 0.75rem;
    }
    .toast-icon.success { background: rgba(16, 185, 129, 0.2); color: #34d399; }
    .toast-icon.error { background: rgba(239, 68, 68, 0.2); color: #f87171; }

    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      display: none;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .hidden {
      display: none !important;
    }

    .actions-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 15px;
    }
  </style>
</head>
<body>
  <div class="glow-blob blob-1"></div>
  <div class="glow-blob blob-2"></div>

  <div class="container">
    <header>
      <h1>LumiBase Auth Playground</h1>
      <p>Interactive client to test custom user registration, login, and profile authorization</p>
    </header>

    <div class="grid">
      <!-- Left side: Login/Signup Card -->
      <div class="card">
        <div class="tabs">
          <div id="tab-login" class="tab active" onclick="switchTab('login')">Sign In</div>
          <div id="tab-register" class="tab" onclick="switchTab('register')">Sign Up</div>
        </div>

        <form id="auth-form" onsubmit="handleAuthSubmit(event)">
          <div class="form-group">
            <label for="input-site">Site ID (Tenant)</label>
            <input type="text" id="input-site" value="site_1" placeholder="e.g. site_1" required>
          </div>

          <div class="form-group">
            <label for="input-email">Email Address</label>
            <input type="email" id="input-email" placeholder="you@domain.com" required>
          </div>

          <div class="form-group">
            <label for="input-password">Password</label>
            <input type="password" id="input-password" placeholder="••••••••" required>
          </div>

          <!-- Register Specific Fields -->
          <div id="register-fields" class="hidden">
            <div class="form-group flex-row-gap">
              <div>
                <label for="input-firstname">First Name</label>
                <input type="text" id="input-firstname" placeholder="First">
              </div>
              <div>
                <label for="input-lastname">Last Name</label>
                <input type="text" id="input-lastname" placeholder="Last">
              </div>
            </div>
          </div>

          <button type="submit" id="btn-submit" class="btn btn-primary" style="margin-top: 15px;">
            <span class="spinner" id="btn-spinner"></span>
            <span id="btn-text">Sign In</span>
          </button>
        </form>
      </div>

      <!-- Right side: Console & Debug panel -->
      <div class="console-panel">
        <div class="console-title">
          <span>Active Token & Session</span>
          <span id="session-badge" class="badge badge-status error">No Active Session</span>
        </div>

        <div class="token-box">
          <div class="token-label">Access Token (JWT)</div>
          <div class="token-value" id="session-token">None</div>
          <button class="copy-btn" onclick="copyToken()">Copy</button>
        </div>

        <div class="console-title">
          <span>API Debug Logs</span>
          <span id="method-badge" class="badge badge-post">POST</span>
        </div>

        <div class="console-box" id="debug-console">// Awaiting request...
// Select Sign Up or Sign In on the left and submit to trigger API call.</div>

        <div class="actions-grid">
          <button class="btn btn-secondary" onclick="fetchProfile()" id="btn-me">
            Test /auth/me
          </button>
          <button class="btn btn-secondary" style="color: var(--error-color);" onclick="clearSession()">
            Clear Session
          </button>
        </div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast">
    <div id="toast-icon" class="toast-icon success">✓</div>
    <div id="toast-msg">Success!</div>
  </div>

  <script>
    let activeTab = 'login';
    let token = localStorage.getItem('lumi_jwt') || '';
    
    // Update initial UI if token is present
    if (token) {
      document.getElementById('session-token').innerText = token;
      const badge = document.getElementById('session-badge');
      badge.innerText = 'Active Session';
      badge.className = 'badge badge-status';
    }

    function switchTab(tab) {
      activeTab = tab;
      document.getElementById('tab-login').classList.toggle('active', tab === 'login');
      document.getElementById('tab-register').classList.toggle('active', tab === 'register');
      
      const registerFields = document.getElementById('register-fields');
      const btnText = document.getElementById('btn-text');
      
      if (tab === 'register') {
        registerFields.classList.remove('hidden');
        btnText.innerText = 'Sign Up';
      } else {
        registerFields.classList.add('hidden');
        btnText.innerText = 'Sign In';
      }
    }

    function showToast(message, isError = false) {
      const toast = document.getElementById('toast');
      const icon = document.getElementById('toast-icon');
      const msg = document.getElementById('toast-msg');

      msg.innerText = message;
      if (isError) {
        icon.innerText = '✕';
        icon.className = 'toast-icon error';
      } else {
        icon.innerText = '✓';
        icon.className = 'toast-icon success';
      }

      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 3000);
    }

    function copyToken() {
      if (!token) {
        showToast('No token to copy!', true);
        return;
      }
      navigator.clipboard.writeText(token);
      showToast('Token copied to clipboard!');
    }

    function clearSession() {
      token = '';
      localStorage.removeItem('lumi_jwt');
      document.getElementById('session-token').innerText = 'None';
      const badge = document.getElementById('session-badge');
      badge.innerText = 'No Active Session';
      badge.className = 'badge badge-status error';
      
      logToConsole('// Session cleared.\\n// Local tokens deleted.');
      showToast('Session cleared!');
    }

    function logToConsole(text, color = '#34d399', method = 'INFO') {
      const consoleBox = document.getElementById('debug-console');
      consoleBox.innerText = text;
      consoleBox.style.color = color;
      
      const methodBadge = document.getElementById('method-badge');
      methodBadge.innerText = method;
      if (method === 'GET') {
        methodBadge.className = 'badge badge-get';
      } else if (method === 'POST') {
        methodBadge.className = 'badge badge-post';
      } else {
        methodBadge.className = 'badge badge-status';
      }
    }

    async function handleAuthSubmit(event) {
      event.preventDefault();
      
      const siteId = document.getElementById('input-site').value.trim();
      const email = document.getElementById('input-email').value.trim();
      const password = document.getElementById('input-password').value;
      
      const spinner = document.getElementById('btn-spinner');
      const submitBtn = document.getElementById('btn-submit');
      
      spinner.style.display = 'inline-block';
      submitBtn.disabled = true;

      const path = activeTab === 'register' ? '/api/v1/auth/register' : '/api/v1/auth/login';
      const body = { email, password };
      
      if (activeTab === 'register') {
        body.firstName = document.getElementById('input-firstname').value.trim() || undefined;
        body.lastName = document.getElementById('input-lastname').value.trim() || undefined;
      }

      const startTime = performance.now();
      
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Lumi-Site': siteId
          },
          body: JSON.stringify(body)
        });

        const durMs = Math.round(performance.now() - startTime);
        const data = await response.json();
        
        let logText = \`// REQUEST DETAILS\\nPOST \${window.location.origin}\${path}\\nHeaders:\\n  Content-Type: application/json\\n  X-Lumi-Site: \${siteId}\\nBody: \${JSON.stringify(body, null, 2)}\\n\\n// RESPONSE DETAILS (Duration: \${durMs}ms)\\nHTTP \${response.status} \${response.statusText}\\nBody: \${JSON.stringify(data, null, 2)}\`;
        
        if (response.ok) {
          showToast(activeTab === 'register' ? 'Registration successful!' : 'Login successful!');
          
          if (activeTab === 'login') {
            token = data.data.token;
            localStorage.setItem('lumi_jwt', token);
            document.getElementById('session-token').innerText = token;
            const badge = document.getElementById('session-badge');
            badge.innerText = 'Active Session';
            badge.className = 'badge badge-status';
          }
          
          logToConsole(logText, '#34d399', 'POST');
          
          if (activeTab === 'register') {
            // Automatically switch to login tab
            switchTab('login');
            document.getElementById('input-password').value = '';
          }
        } else {
          showToast(data.errors?.[0]?.message || 'Request failed', true);
          logToConsole(logText, '#f87171', 'POST');
        }
      } catch (err) {
        showToast(err.message, true);
        logToConsole(\`// ERROR\\n\${err.stack || err.message}\`, '#f87171', 'ERROR');
      } finally {
        spinner.style.display = 'none';
        submitBtn.disabled = false;
      }
    }

    async function fetchProfile() {
      if (!token) {
        showToast('Please login or register first!', true);
        return;
      }
      
      const siteId = document.getElementById('input-site').value.trim();
      const meBtn = document.getElementById('btn-me');
      meBtn.disabled = true;
      
      const path = '/api/v1/auth/me';
      const startTime = performance.now();
      
      try {
        const response = await fetch(path, {
          method: 'GET',
          headers: {
            'Authorization': \`Bearer \${token}\`,
            'X-Lumi-Site': siteId
          }
        });

        const durMs = Math.round(performance.now() - startTime);
        const data = await response.json();
        
        let logText = \`// REQUEST DETAILS\\nGET \${window.location.origin}\${path}\\nHeaders:\\n  Authorization: Bearer \${token.slice(0, 15)}... (truncated)\\n  X-Lumi-Site: \${siteId}\\n\\n// RESPONSE DETAILS (Duration: \${durMs}ms)\\nHTTP \${response.status} \${response.statusText}\\nBody: \${JSON.stringify(data, null, 2)}\`;
        
        if (response.ok) {
          showToast('Profile loaded!');
          logToConsole(logText, '#60a5fa', 'GET');
        } else {
          showToast(data.errors?.[0]?.message || 'Request failed', true);
          logToConsole(logText, '#f87171', 'GET');
        }
      } catch (err) {
        showToast(err.message, true);
        logToConsole(\`// ERROR\\n\${err.stack || err.message}\`, '#f87171', 'ERROR');
      } finally {
        meBtn.disabled = false;
      }
    }
  </script>
</body>
</html>`;

/**
 * Interactive auth-playground surface. Developer tooling only — it must never
 * be reachable in production (OWASP API9: Improper Inventory Management —
 * shadow/debug endpoints). Return an indistinguishable 404 when the runtime is
 * production so the surface is neither served nor advertised.
 */
testAuthRouter.use('*', async (c, next) => {
  const isProduction =
    c.env?.LUMIBASE_ENV === 'production' ||
    process.env.LUMIBASE_ENV === 'production' ||
    process.env.NODE_ENV === 'production';
  if (isProduction) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Not found.' }] }, 404);
  }
  return next();
});

testAuthRouter.get('/', (c) => {
  return c.html(htmlContent);
});
