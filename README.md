# 🚀 LumiBase: The Ultimate Launchpad for Modern Apps

> **"Don't Reinvent the Wheel"**

LumiBase is not a final product. It is the **technical backbone** designed to free developers from repetitive, boring setup tasks.

It combines the flexibility of **NoSQL**, the power of **SQL**, and the practicality of a **Headless CMS** into a unified block, ready to take your idea from draft to digital space in seconds.

## 💡 Philosophy

We believe every breakthrough product deserves a solid start. LumiBase focuses on 3 pillars:

- **Velocity**: Skip weeks of Auth, DB, and CMS configuration. Set up once, use for every project.
- **Transparency**: Every data stream is clear, every query optimized thanks to the power of PostgreSQL.
- **Scalability**: From a small MVP to a system with millions of users, LumiBase's skeleton remains solid.

## 🛠 The "Atomic Trinity" Ecosystem

LumiBase is forged from the best modern technologies:

- ❤️ **Firebase (The Heart)**: Provides the "pulse" with world-class Identity and Analytics.
- 🧠 **Supabase (The Brain)**: Stores and processes data with the intelligence of PostgreSQL, ensuring integrity and complex query capabilities.
- 💎 **Directus (The Interface)**: A sophisticated content administration shell allowing anyone—even non-coders—to control the data underneath.

## 🎯 Who is LumiBase for?

- **Indie Hackers**: Turn ideas into products in days instead of months.
- **Agencies**: A standard process to deliver projects with a professional admin interface (Directus) and reliable infrastructure.
- **Startups**: A flexible launchpad, easy to pivot business models without tearing down old infrastructure.

> _"LumiBase is not just a start. It's a competitive advantage."_

## 🏗 Architecture Overview

```
┌─────────────┐
│   Client    │
│ Application │
└──────┬──────┘
       │
       ├──────────────┐
       │              │
       ▼              ▼
┌──────────┐   ┌──────────────┐
│ Firebase │   │   Supabase   │
│   Auth   │◄──┤  PostgreSQL  │
└────┬─────┘   └──────▲───────┘
     │                │
     │         ┌──────┴───────┐
     │         │   Directus   │
     │         │     CMS      │
     │         └──────────────┘
     │
     ▼
┌──────────────┐
│    Cloud     │
│  Functions   │
└──────────────┘
```

### How It Works

1. **User Authentication**: Users authenticate via Firebase (Google OAuth, Email/Password)
2. **JWT Token**: Firebase issues JWT tokens with user claims
3. **Data Access**: Client sends JWT token to Supabase for data access
4. **Verification**: Supabase verifies JWT token with Firebase
5. **Auto-Sync**: Cloud Functions automatically sync user data from Firebase to Supabase
6. **Content Management**: Directus connects directly to Supabase database for content management

## 🚀 Getting Started

### Prerequisites

- **Node.js** 18+ ([Download](https://nodejs.org/))
- **Docker Desktop** ([Download](https://www.docker.com/products/docker-desktop/))
- **Git** ([Download](https://git-scm.com/))
- **Firebase Account** ([Sign up](https://firebase.google.com/))
- **Supabase Account** ([Sign up](https://supabase.com/))

### Step 1: Clone and Setup Environment

```bash
# Clone the repository
git clone https://github.com/khuepm/LumiBase.git
cd LumiBase

# Copy environment template
cp .env.example .env
```

### Step 2: Configure Firebase

#### 2.1 Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click **Add project** or select an existing project
3. Enter your project name (e.g., "LumiBase")
4. (Optional) Enable Google Analytics for your project
5. Click **Create project** and wait for setup to complete

#### 2.2 Enable Google OAuth Provider

1. In Firebase Console, go to **Authentication** → **Sign-in method**
2. Click on **Google** provider
3. Toggle **Enable** switch to ON
4. Configure OAuth consent screen:
   - **Project support email**: Select your email
   - **Project public-facing name**: Enter your app name (e.g., "LumiBase")
5. Click **Save**

**Important Notes:**
- Google OAuth requires a valid OAuth consent screen configuration
- For production, you'll need to verify your domain
- Users will see the app name during Google sign-in

#### 2.3 Enable Email/Password Authentication

1. In Firebase Console, go to **Authentication** → **Sign-in method**
2. Click on **Email/Password** provider
3. Toggle **Enable** switch to ON
4. (Optional) Enable **Email link (passwordless sign-in)** if needed
5. Click **Save**

**Security Recommendations:**
- Enable email verification for new accounts
- Set password requirements in Firebase Console
- Consider enabling multi-factor authentication (MFA) for production

#### 2.4 Enable Firebase Analytics (Optional but Recommended)

1. In Firebase Console, go to **Project Settings** (gear icon)
2. Click on **Integrations** tab
3. Find **Google Analytics** and click **Enable**
4. Select an existing Analytics account or create a new one
5. Configure Analytics settings:
   - **Analytics location**: Select your region
   - **Data sharing settings**: Configure as needed
6. Click **Enable Analytics**

**Benefits of Firebase Analytics:**
- Track user authentication events
- Monitor user engagement
- Analyze user demographics
- Debug authentication issues

#### 2.5 Download Service Account Credentials

Service account credentials are required for server-side operations (Cloud Functions).

1. Go to **Project Settings** → **Service Accounts** tab
2. Click **Generate New Private Key**
3. A dialog will appear warning about keeping the key secure
4. Click **Generate Key** - a JSON file will be downloaded

**⚠️ Security Warning:**
- **NEVER commit this file to Git**
- Store it securely (use environment variables or secret managers)
- Rotate keys regularly (every 90 days recommended)

5. Open the downloaded JSON file and extract these values to your `.env` file:
   ```json
   {
     "project_id": "your-project-id",
     "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
     "client_email": "firebase-adminsdk-xxxxx@your-project-id.iam.gserviceaccount.com"
   }
   ```

6. Add to `.env`:
   ```bash
   FIREBASE_PROJECT_ID=your-project-id
   FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project-id.iam.gserviceaccount.com
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   ```

**Important:** Keep the `\n` characters in the private key - they represent line breaks.

#### 2.6 Get Web API Key

The Web API Key is used for client-side Firebase SDK initialization.

1. Go to **Project Settings** → **General** tab
2. Scroll down to **Your apps** section
3. If you haven't added a web app yet:
   - Click the **</>** (Web) icon
   - Register your app with a nickname (e.g., "LumiBase Web")
   - (Optional) Set up Firebase Hosting
   - Click **Register app**
4. Copy the **Web API Key** from the Firebase SDK snippet
5. Add to `.env`:
   ```bash
   FIREBASE_WEB_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
   ```

#### 2.7 Configure Firebase for Cloud Functions

After setting up authentication, you'll need to configure Firebase Functions to sync user data to Supabase.

**Set Supabase Configuration:**

```bash
# Login to Firebase CLI
firebase login

# Select your project
firebase use <your-project-id>

# Set Supabase URL
firebase functions:config:set supabase.url="https://xxxxxxxxxxxxx.supabase.co"

# Set Supabase Service Role Key
firebase functions:config:set supabase.service_key="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Verify Configuration:**

```bash
# View current configuration
firebase functions:config:get
```

**For Local Development:**

Create `functions/.runtimeconfig.json` (this file is gitignored):

```json
{
  "supabase": {
    "url": "https://xxxxxxxxxxxxx.supabase.co",
    "service_key": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

**⚠️ Important:** Never commit `.runtimeconfig.json` to Git!

#### 2.8 Firebase Configuration Summary

After completing all steps, your `.env` file should have:

```bash
# Firebase Configuration
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project-id.iam.gserviceaccount.com
FIREBASE_WEB_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

And Firebase Functions should be configured with:
- ✅ Supabase URL
- ✅ Supabase Service Role Key

**Next Steps:**
- Proceed to Step 3 to configure Supabase
- After completing all setup, deploy Cloud Functions (Step 10)

**📖 Detailed Guide:** For comprehensive Firebase Authentication setup instructions, troubleshooting, and security best practices, see [Firebase Authentication Guide](docs/firebase-authentication-guide.md)

### Step 3: Configure Supabase

**📖 Detailed Guide**: For comprehensive Supabase setup instructions, see [Supabase Project Setup Guide](docs/supabase-project-setup-guide.md)

#### Quick Setup Steps:

1. Go to [Supabase Dashboard](https://app.supabase.com/)
2. Create a new project
3. Go to **Settings** → **API**
4. Copy these values to your `.env` file:
   - `SUPABASE_URL` (Project URL)
   - `SUPABASE_ANON_KEY` (anon public key)
   - `SUPABASE_SERVICE_ROLE_KEY` (service_role secret key)
   - `SUPABASE_JWT_SECRET` (JWT Secret from Settings → API)
5. Configure Firebase as third-party auth provider:
   - Go to **Authentication** → **Providers**
   - Enable **Firebase** provider
   - Enter your Firebase Project ID
   - Set Issuer URL: `https://securetoken.google.com/your-firebase-project-id`

**⚠️ Security Warning**: Never expose `SUPABASE_SERVICE_ROLE_KEY` in client-side code! It bypasses all Row Level Security policies.

### Step 4: Configure Directus

1. Generate random keys for Directus:
   ```bash
   openssl rand -base64 32
   ```
2. Add them to `.env`:
   - `DIRECTUS_KEY`
   - `DIRECTUS_SECRET`
3. Set your admin credentials:
   - `DIRECTUS_ADMIN_EMAIL`
   - `DIRECTUS_ADMIN_PASSWORD`

### Step 5: Configure Database

1. Set database credentials in `.env`:
   - `DB_USER=directus`
   - `DB_PASSWORD` (choose a secure password)
   - `DB_NAME=directus`

### Step 6: Install Dependencies

```bash
# Install project dependencies
npm install

# Install Supabase CLI (for local development)
npm install supabase --save-dev

# Install Firebase CLI (for Cloud Functions)
npm install -g firebase-tools
```

### Step 7: Start Docker Services

```bash
# Start PostgreSQL and Directus
docker-compose up -d

# Check services are running
docker-compose ps

# View logs
docker-compose logs -f
```

### Step 8: Verify Setup (Task 3 Checkpoint)

**📋 Quick Verification Checklist**: See [docs/task-3-checkpoint-checklist.md](docs/task-3-checkpoint-checklist.md)

**📖 Detailed Verification Guide**: See [docs/docker-verification-guide.md](docs/docker-verification-guide.md)

#### Quick Verification Steps:

1. **Check Docker Services**:
   ```bash
   docker-compose ps
   ```
   Both `directus-cms` and `directus-postgres` should show status `Up`

2. **Check PostgreSQL Connection**: 
   ```bash
   docker-compose exec postgres pg_isready -U directus
   ```
   Should return: `/var/run/postgresql:5432 - accepting connections`

3. **Check Directus Health**:
   ```bash
   curl http://localhost:8055/server/health
   ```
   Should return: `{"status": "ok", "checks": {"database": "ok"}}`

4. **Check Directus UI**: Open [http://localhost:8055](http://localhost:8055)
   - Login with your admin credentials
   - You should see the Directus admin panel

5. **View Logs** (if needed):
   ```bash
   # All services
   docker-compose logs
   
   # Specific service
   docker-compose logs directus
   docker-compose logs postgres
   ```

**✅ All checks passed?** You're ready to proceed to Task 4 (Database Schema)!

**❌ Having issues?** Check the [Docker Verification Guide](docs/docker-verification-guide.md) for detailed troubleshooting.

### Step 9: Verify Database Setup (Task 6 Checkpoint)

After creating database schema and RLS policies (Tasks 4-5), verify the database setup:

**📋 Quick Checklist**: See [docs/TASK-6-CHECKLIST.md](docs/TASK-6-CHECKLIST.md)

**📖 Detailed Guide**: See [docs/TASK-6-DATABASE-VERIFICATION.md](docs/TASK-6-DATABASE-VERIFICATION.md)

#### Automated Verification (Recommended):

**On Linux/Mac:**
```bash
# Make script executable
chmod +x scripts/verify-database-setup.sh

# Run verification
./scripts/verify-database-setup.sh
```

**On Windows PowerShell:**
```powershell
# Run verification
.\scripts\verify-database-setup.ps1
```

The script will automatically verify:
- ✅ Database schema (tables, columns, constraints, indexes)
- ✅ RLS policies (enabled and correctly configured)
- ✅ Trigger functionality (auto-update timestamps)
- ✅ Container health and connectivity

#### Manual Verification:

```bash
# 1. Restart containers to apply migrations
docker-compose down && docker-compose up -d

# 2. Connect to PostgreSQL
docker-compose exec postgres psql -U directus -d directus

# 3. Verify schema
\d public.users

# 4. Verify RLS is enabled
SELECT rowsecurity FROM pg_tables WHERE tablename = 'users';

# 5. List RLS policies
SELECT policyname, cmd FROM pg_policies WHERE tablename = 'users';

# 6. Exit
\q
```

**✅ All checks passed?** Database setup is complete! Proceed to Task 7 (Firebase Setup).

**❌ Having issues?** Check the [Database Verification Guide](docs/TASK-6-DATABASE-VERIFICATION.md) for troubleshooting.

### Step 10: Setup Firebase Cloud Functions (Task 7)

Firebase Cloud Functions automatically sync user data from Firebase Authentication to Supabase database.

#### Prerequisites:

1. **Firebase CLI installed** (already done in Step 6)
2. **Firebase project created** (already done in Step 2)
3. **Firebase login**:
   ```bash
   firebase login
   ```

#### Configure Firebase Project:

1. **Update `.firebaserc` with your project ID**:
   ```bash
   # Edit .firebaserc and replace "your-firebase-project-id" with your actual project ID
   ```

2. **Set Firebase project**:
   ```bash
   firebase use <your-project-id>
   ```

3. **Configure Supabase credentials for Cloud Functions**:
   ```bash
   firebase functions:config:set supabase.url="<your-supabase-url>"
   firebase functions:config:set supabase.service_key="<your-supabase-service-role-key>"
   ```

#### Install Dependencies and Build:

```bash
cd functions
npm install
npm run build
cd ..
```

#### Test Locally (Optional):

```bash
cd functions
npm run serve
```

This starts the Firebase emulator suite:
- Functions: http://localhost:5001
- Auth: http://localhost:9099
- Emulator UI: http://localhost:4000

#### Deploy to Firebase:

```bash
cd functions
npm run deploy
```

#### Verify Functions:

1. **Check deployed functions**:
   ```bash
   firebase functions:list
   ```

2. **View function logs**:
   ```bash
   firebase functions:log
   ```

3. **Test the sync**:
   - Go to Firebase Console → Authentication
   - Create a test user (Email/Password or Google)
   - Check Supabase database to verify user was synced:
     ```bash
     docker-compose exec postgres psql -U directus -d directus -c "SELECT * FROM public.users;"
     ```

**✅ Functions deployed successfully?** Your Firebase-Supabase integration is complete!

**❌ Having issues?** Check the [Firebase Functions README](functions/README.md) for detailed troubleshooting.

## 📁 Project Structure

```
LumiBase/
├── .kiro/                      # Kiro specs and documentation
│   └── specs/
│       └── directus-firebase-supabase-setup/
├── client/                     # Client-side integration examples
│   └── auth.ts                # Firebase & Supabase auth integration
├── functions/                  # Firebase Cloud Functions
│   ├── src/
│   │   └── index.ts           # User sync functions
│   └── package.json
├── init-scripts/              # Database initialization scripts
│   ├── 01-create-schema.sql  # Create users table and indexes
│   └── 02-setup-rls.sql      # Row Level Security policies
├── scripts/                   # Development utility scripts
│   ├── verify-database-setup.sh   # Verify database setup (Bash)
│   ├── verify-database-setup.ps1  # Verify database setup (PowerShell)
│   ├── seed-data.sh          # Seed initial data
│   └── reset-db.sh           # Reset database
├── tests/                     # Test suites
│   ├── unit/                 # Unit tests
│   ├── integration/          # Integration tests
│   └── property/             # Property-based tests
├── docker-compose.yml         # Docker services configuration
├── .env.example              # Environment variables template
├── .gitignore               # Git ignore rules
├── package.json             # Node.js dependencies
└── README.md               # This file
```

## 🧪 Testing

LumiBase includes comprehensive testing infrastructure with isolated test environment.

### Test Environment

The test environment runs on separate ports to avoid conflicts with development:

```bash
# Start test environment
npm run test:env:up

# Check test environment status
npm run test:env:status

# View test environment logs
npm run test:env:logs

# Stop test environment
npm run test:env:down

# Clean test environment (remove all data)
npm run test:env:clean
```

**Test Environment Ports:**
- PostgreSQL: `5433` (dev: 5432)
- Directus: `8056` (dev: 8055)

### Running Tests

```bash
# Run all tests
npm test

# Run unit tests
npm run test:unit

# Run integration tests
npm run test:integration

# Run property-based tests
npm run test:property

# Run with coverage
npm run test:coverage

# Run tests with automatic environment setup/teardown
npm run test:with-env
```

### Test Types

- **Unit Tests**: Test individual functions and components in isolation
- **Integration Tests**: Test interactions between components (database, API, etc.)
- **Property-Based Tests**: Test universal properties across many generated inputs

For detailed testing documentation, see [Test Environment Guide](./docs/TEST-ENVIRONMENT-GUIDE.md).

## 🔄 CI/CD Pipeline

LumiBase includes automated CI/CD workflows using GitHub Actions for continuous integration and deployment.

### Automated Workflows

**Test Suite** (runs on every push and PR):
- ✅ Unit, integration, and property-based tests
- ✅ Docker configuration validation
- ✅ TypeScript type checking
- ✅ Security vulnerability scanning
- ✅ Test coverage reporting

**Deploy Firebase Functions** (runs on push to main):
- ✅ Builds and tests Cloud Functions
- ✅ Deploys to Firebase automatically
- ✅ Can be triggered manually

### Setup CI/CD

1. **Configure GitHub Secrets**:
   - Go to repository **Settings** → **Secrets and variables** → **Actions**
   - Add required secrets:
     - `SUPABASE_URL`
     - `SUPABASE_ANON_KEY`
     - `SUPABASE_SERVICE_ROLE_KEY`
     - `FIREBASE_TOKEN` (get with `firebase login:ci`)
     - `FIREBASE_PROJECT_ID`
     - `CODECOV_TOKEN` (optional)

2. **Push to GitHub**:
   ```bash
   git push origin main
   ```

3. **Monitor Workflows**:
   - Go to **Actions** tab in GitHub
   - View workflow runs and logs

### Workflow Status Badges

Add these to your README to show build status:

```markdown
![Test Suite](https://github.com/YOUR_USERNAME/YOUR_REPO/workflows/Test%20Suite/badge.svg)
![Deploy Functions](https://github.com/YOUR_USERNAME/YOUR_REPO/workflows/Deploy%20Firebase%20Functions/badge.svg)
```

For detailed CI/CD setup instructions, see [CI/CD Setup Guide](./docs/CI-CD-SETUP-GUIDE.md).

## 🔧 Development Workflow

### Starting Development

```bash
# Start all services
docker-compose up -d

# Watch logs
docker-compose logs -f

# Start Firebase emulator (optional)
cd functions
firebase emulators:start
```

### Stopping Services

```bash
# Stop all services
docker-compose down

# Stop and remove volumes (clean slate)
docker-compose down -v
```

### Database Management

#### Seed Initial Data

Add sample users to the database for development and testing:

**On Linux/Mac:**
```bash
# Make script executable
chmod +x scripts/seed-data.sh

# Run seed script
./scripts/seed-data.sh
```

**On Windows PowerShell:**
```powershell
# Run seed script
.\scripts\seed-data.ps1
```

**Using TypeScript (Cross-platform):**
```bash
# Install tsx if not already installed
npm install -g tsx

# Run seed script
npx tsx scripts/seed-data.ts
```

The seed script will:
- ✅ Load environment variables from `.env`
- ✅ Connect to PostgreSQL database
- ✅ Insert 5 sample users (or update if they already exist)
- ✅ Display all users in the database

**Sample Users Created:**
1. alice@example.com (Alice Johnson)
2. bob@example.com (Bob Smith)
3. charlie@example.com (Charlie Brown)
4. diana@example.com (Diana Prince)
5. eve@example.com (Eve Wilson)

**⚠️ Note**: These are test users for development only. In production, users should be created via Firebase Authentication and synced automatically by Cloud Functions.

#### Reset Database

```bash
# Reset database (coming soon)
./scripts/reset-db.sh
```

#### Access PostgreSQL Shell

```bash
# Access PostgreSQL shell
docker-compose exec postgres psql -U directus -d directus

# View all users
SELECT * FROM public.users;

# Exit shell
\q
```

### Firebase Cloud Functions

```bash
cd functions

# Install dependencies
npm install

# Login to Firebase
firebase login

# Select project
firebase use <your-project-id>

# Deploy functions
npm run deploy

# Test locally with emulator
npm run serve
```

## 🔐 Security Best Practices

1. **Never commit `.env` file** - It contains sensitive credentials
2. **Use strong passwords** - Minimum 16 characters with mixed case, numbers, and symbols
3. **Rotate keys regularly** - Change JWT secrets and API keys periodically
4. **Enable 2FA** - On Firebase and Supabase accounts
5. **Use service accounts** - For production deployments
6. **Monitor logs** - Set up alerts for suspicious activities
7. **Keep dependencies updated** - Run `npm audit` regularly

## 📚 Documentation

- [Project Specifications](./project_specs.md) - Detailed project requirements
- [Architecture Design](./.kiro/specs/directus-firebase-supabase-setup/design.md) - System architecture and design decisions
- [Implementation Tasks](./.kiro/specs/directus-firebase-supabase-setup/tasks.md) - Step-by-step implementation guide
- [Firebase Authentication Guide](./docs/firebase-authentication-guide.md) - Complete Firebase Authentication setup guide
- [Firebase Documentation](https://firebase.google.com/docs)
- [Supabase Documentation](https://supabase.com/docs)
- [Directus Documentation](https://docs.directus.io/)

## 🐛 Troubleshooting

### Docker Issues

**Problem**: Port 8055 already in use
```bash
# Find process using port
netstat -ano | findstr :8055

# Kill the process or change port in docker-compose.yml
```

**Problem**: PostgreSQL won't start
```bash
# Check logs
docker-compose logs postgres

# Remove volumes and restart
docker-compose down -v
docker-compose up -d
```

### Directus Issues

**Problem**: Can't login to Directus
```bash
# Reset admin password
docker-compose exec directus npx directus users create --email admin@example.com --password newpassword --role administrator
```

**Problem**: Database connection error
- Verify `DB_USER`, `DB_PASSWORD`, `DB_NAME` in `.env`
- Ensure PostgreSQL is running: `docker-compose ps`

### Firebase Issues

**Problem**: Cloud Functions not deploying
```bash
# Check Firebase login
firebase login --reauth

# Verify project
firebase projects:list
firebase use <project-id>

# Check functions logs
firebase functions:log
```

### Supabase Issues

**Problem**: JWT verification fails
- Verify `SUPABASE_JWT_SECRET` matches Firebase configuration
- Check JWT token expiration
- Ensure Firebase public keys are accessible

## 🤝 Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the ISC License - see the LICENSE file for details.

## 🙏 Acknowledgments

- Firebase team for excellent authentication services
- Supabase team for the amazing PostgreSQL platform
- Directus team for the powerful headless CMS
- All contributors who help improve this project

## 📧 Support

- **Issues**: [GitHub Issues](https://github.com/khuepm/LumiBase/issues)
- **Discussions**: [GitHub Discussions](https://github.com/khuepm/LumiBase/discussions)
- **Email**: khuepm@example.com

---

Made with ❤️ by [Khue Pham](https://github.com/khuepm)
