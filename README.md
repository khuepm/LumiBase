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

### System Architecture Diagram

```mermaid
graph TB
    Client[Client Application]
    Firebase[Firebase Auth]
    Functions[Cloud Functions]
    Supabase[Supabase PostgreSQL]
    Directus[Directus CMS]
    
    Client -->|1. Authenticate| Firebase
    Firebase -->|2. JWT Token| Client
    Client -->|3. API Request + JWT| Supabase
    Supabase -->|4. Verify JWT| Firebase
    Firebase -->|5. onCreate Trigger| Functions
    Functions -->|6. Sync User Data| Supabase
    Directus -->|7. Direct DB Connection| Supabase
    
    subgraph "Docker Environment"
        Directus
        Supabase
    end
```

### Authentication Flow

```mermaid
sequenceDiagram
    participant User
    participant Client
    participant Firebase
    participant CloudFn
    participant Supabase
    
    User->>Client: Sign in (Google/Email)
    Client->>Firebase: Authenticate
    Firebase->>Firebase: Create user
    Firebase->>CloudFn: Trigger onCreate
    CloudFn->>Supabase: INSERT INTO users
    Firebase->>Client: JWT Token
    Client->>Supabase: API Request + JWT
    Supabase->>Firebase: Verify JWT
    Firebase->>Supabase: Valid + firebase_uid
    Supabase->>Supabase: Check RLS policies
    Supabase->>Client: Data response
```

### Docker Architecture

```mermaid
graph LR
    subgraph "Docker Compose"
        Directus[Directus Container<br/>Port 8055]
        Postgres[PostgreSQL Container<br/>Port 5432]
        Network[Docker Network<br/>directus-network]
        
        Directus -.->|connects via| Network
        Postgres -.->|connects via| Network
        Directus -->|DB Connection| Postgres
    end
    
    Host[Host Machine] -->|Port Mapping| Directus
    Volumes[Docker Volumes] -->|Data Persistence| Postgres
    Volumes2[Docker Volumes] -->|Uploads/Extensions| Directus
```

### Data Model

```mermaid
erDiagram
    USERS {
        varchar firebase_uid PK
        varchar email UK
        varchar display_name
        text photo_url
        timestamp created_at
        timestamp updated_at
    }
```

### How It Works

1. **User Authentication**: Users authenticate via Firebase (Google OAuth, Email/Password)
2. **JWT Token**: Firebase issues JWT tokens with user claims
3. **Data Access**: Client sends JWT token to Supabase for data access
4. **Verification**: Supabase verifies JWT token with Firebase
5. **Auto-Sync**: Cloud Functions automatically sync user data from Firebase to Supabase
6. **Content Management**: Directus connects directly to Supabase database for content management
7. **Row Level Security**: Supabase RLS policies ensure users can only access their own data

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

⚠️ **Important:** Firebase has deprecated `functions:config` API. See [Firebase Config Migration Guide](./docs/FIREBASE-CONFIG-MIGRATION.md) for details.

**Set Supabase Configuration:**

**Method 1: Environment Variables (Recommended for Development)**

Create `functions/.env` file:

```bash
cd functions
```

Add to `functions/.env`:

```bash
SUPABASE_URL=https://xxxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**⚠️ Important:** Never commit `.env` to Git! (Already in `.gitignore`)

**Method 2: Firebase Secrets (Production)**

```bash
# Set secrets for production deployment
firebase functions:secrets:set SUPABASE_URL
# Enter URL when prompted: https://xxxxx.supabase.co

firebase functions:secrets:set SUPABASE_SERVICE_ROLE_KEY
# Enter service role key when prompted
```

**Method 3: Legacy Config (Deprecated)**

⚠️ **Warning:** This method will stop working in March 2026.

```bash
# Only use if necessary
firebase experiments:enable legacyRuntimeConfigCommands
firebase functions:config:set supabase.url="https://xxxxx.supabase.co"
firebase functions:config:set supabase.service_key="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Verify Configuration:**

```bash
# For environment variables
cat functions/.env

# For secrets
firebase functions:secrets:access SUPABASE_URL

# For legacy config
firebase functions:config:get
```

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

   ⚠️ **Note:** Legacy `functions:config` is deprecated. Use environment variables or secrets instead.

   **Option A: Environment Variables (Development)**
   ```bash
   cd functions
   ```
   
   Create `functions/.env`:
   ```bash
   SUPABASE_URL=<your-supabase-url>
   SUPABASE_SERVICE_ROLE_KEY=<your-supabase-service-role-key>
   ```

   **Option B: Firebase Secrets (Production)**
   ```bash
   firebase functions:secrets:set SUPABASE_URL
   firebase functions:secrets:set SUPABASE_SERVICE_ROLE_KEY
   ```

   📖 **Migration Guide**: See [Firebase Config Migration Guide](./docs/FIREBASE-CONFIG-MIGRATION.md)

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

**📖 Complete Testing Guide**: See [Testing Procedures Guide](./docs/TESTING-PROCEDURES.md) for comprehensive instructions on:
- Running unit tests, property-based tests, and integration tests
- Testing authentication flow locally
- Debugging Cloud Functions locally
- Continuous integration setup

### Quick Start

```bash
# Start test environment
npm run test:env:up

# Run all tests
npm test

# Run specific test types
npm run test:unit          # Unit tests only
npm run test:property      # Property-based tests only
npm run test:integration   # Integration tests only

# Run with coverage
npm run test:coverage

# Stop test environment
npm run test:env:down
```

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

### Test Types

- **Unit Tests**: Test individual functions and components in isolation
- **Integration Tests**: Test interactions between components (database, API, etc.)
- **Property-Based Tests**: Test universal properties across many generated inputs

For detailed testing documentation, see:
- [Testing Procedures Guide](./docs/TESTING-PROCEDURES.md) - Complete testing guide
- [Test Environment Guide](./docs/TEST-ENVIRONMENT-GUIDE.md) - Test environment setup
- [Firebase Emulator Guide](./docs/FIREBASE-EMULATOR-GUIDE.md) - Local Firebase testing

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

## 🚀 Production Deployment

Ready to deploy LumiBase to production? Follow our comprehensive deployment guide.

**📖 Complete Deployment Guide**: See [Deployment Procedures Guide](./docs/DEPLOYMENT-PROCEDURES.md) for:
- Production deployment checklist
- Security best practices
- Monitoring and logging setup
- Backup and recovery procedures
- Scaling considerations
- Troubleshooting production issues

### Quick Deployment Overview

1. **Prepare Environment**
   - Set up production Firebase project
   - Create production Supabase project
   - Configure production environment variables
   - Generate strong secrets and passwords

2. **Deploy Database**
   - Apply database migrations to production
   - Enable RLS policies
   - Configure backups

3. **Deploy Cloud Functions**
   ```bash
   cd functions
   firebase use production
   firebase deploy --only functions
   ```

4. **Deploy Directus CMS**
   - Deploy to cloud platform (AWS, GCP, Azure) or VPS
   - Configure SSL/TLS certificates
   - Set up reverse proxy (nginx)

5. **Deploy Client Application**
   - Build production bundle
   - Deploy to hosting (Vercel, Netlify, Firebase Hosting)

6. **Configure Monitoring**
   - Set up error tracking (Sentry)
   - Configure uptime monitoring
   - Set up log aggregation
   - Configure alerts

7. **Verify Deployment**
   - Test authentication flow
   - Verify data sync
   - Check monitoring and alerts
   - Run smoke tests

For detailed instructions, security best practices, and troubleshooting, see the [Deployment Procedures Guide](./docs/DEPLOYMENT-PROCEDURES.md).

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
- [Supabase Project Setup Guide](./docs/supabase-project-setup-guide.md) - Complete Supabase configuration guide
- [Test Environment Guide](./docs/TEST-ENVIRONMENT-GUIDE.md) - Testing infrastructure and procedures
- [Testing Procedures Guide](./docs/TESTING-PROCEDURES.md) - Comprehensive testing guide
- [Firebase Emulator Guide](./docs/FIREBASE-EMULATOR-GUIDE.md) - Local Firebase development
- [CI/CD Setup Guide](./docs/CI-CD-SETUP-GUIDE.md) - Continuous integration and deployment
- [Deployment Procedures Guide](./docs/DEPLOYMENT-PROCEDURES.md) - Production deployment, security, monitoring, and backup
- [Firebase Documentation](https://firebase.google.com/docs)
- [Supabase Documentation](https://supabase.com/docs)
- [Directus Documentation](https://docs.directus.io/)

## 🔌 API Documentation

### Supabase REST API

LumiBase uses Supabase's auto-generated REST API for database operations.

#### Base URL
```
https://your-project-id.supabase.co/rest/v1
```

#### Authentication
All requests must include JWT token in Authorization header:
```bash
Authorization: Bearer <firebase-jwt-token>
```

#### Get Current User Data

```bash
GET /users?firebase_uid=eq.<user-firebase-uid>
```

**Example Request:**
```bash
curl -X GET 'https://xxxxx.supabase.co/rest/v1/users?firebase_uid=eq.abc123' \
  -H "Authorization: Bearer <jwt-token>" \
  -H "apikey: <supabase-anon-key>"
```

**Example Response:**
```json
[
  {
    "firebase_uid": "abc123",
    "email": "user@example.com",
    "display_name": "John Doe",
    "photo_url": "https://example.com/photo.jpg",
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z"
  }
]
```

#### Update User Profile

```bash
PATCH /users?firebase_uid=eq.<user-firebase-uid>
```

**Example Request:**
```bash
curl -X PATCH 'https://xxxxx.supabase.co/rest/v1/users?firebase_uid=eq.abc123' \
  -H "Authorization: Bearer <jwt-token>" \
  -H "apikey: <supabase-anon-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "Jane Doe",
    "photo_url": "https://example.com/new-photo.jpg"
  }'
```

**Example Response:**
```json
{
  "firebase_uid": "abc123",
  "email": "user@example.com",
  "display_name": "Jane Doe",
  "photo_url": "https://example.com/new-photo.jpg",
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-02T10:30:00Z"
}
```

#### Error Responses

**401 Unauthorized** - Invalid or expired JWT token:
```json
{
  "code": "PGRST301",
  "message": "JWT expired",
  "details": null,
  "hint": null
}
```

**403 Forbidden** - RLS policy violation:
```json
{
  "code": "42501",
  "message": "new row violates row-level security policy",
  "details": null,
  "hint": null
}
```

### Directus REST API

Directus provides a comprehensive REST API for content management.

#### Base URL
```
http://localhost:8055
```

#### Authentication

**Login:**
```bash
POST /auth/login
Content-Type: application/json

{
  "email": "admin@example.com",
  "password": "your-password"
}
```

**Response:**
```json
{
  "data": {
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expires": 900000,
    "refresh_token": "abc123..."
  }
}
```

#### Get Users

```bash
GET /items/users
Authorization: Bearer <directus-access-token>
```

**Example Response:**
```json
{
  "data": [
    {
      "firebase_uid": "abc123",
      "email": "user@example.com",
      "display_name": "John Doe",
      "photo_url": "https://example.com/photo.jpg",
      "created_at": "2024-01-01T00:00:00Z",
      "updated_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

#### Create/Update User

```bash
POST /items/users
Authorization: Bearer <directus-access-token>
Content-Type: application/json

{
  "firebase_uid": "new-user-123",
  "email": "newuser@example.com",
  "display_name": "New User"
}
```

### Firebase Cloud Functions

#### syncUserToSupabase

**Trigger:** Firebase Auth onCreate
**Purpose:** Automatically sync new users to Supabase database

**Triggered automatically when:**
- User signs up with Email/Password
- User signs in with Google OAuth for the first time

**Function behavior:**
1. Extracts user data from Firebase Auth user object
2. Inserts or updates user in Supabase `public.users` table
3. Uses service role key to bypass RLS policies
4. Logs success/failure for monitoring

**No manual invocation required** - this function runs automatically.

#### deleteUserFromSupabase (Optional)

**Trigger:** Firebase Auth onDelete
**Purpose:** Remove user data from Supabase when deleted from Firebase

**Triggered automatically when:**
- User is deleted from Firebase Authentication

**Function behavior:**
1. Extracts firebase_uid from deleted user
2. Deletes corresponding row from Supabase `public.users` table
3. Logs success/failure for monitoring

### Client SDK Examples

#### Firebase Authentication

```typescript
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider } from 'firebase/auth';

const firebaseConfig = {
  apiKey: process.env.FIREBASE_WEB_API_KEY,
  authDomain: `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
  projectId: process.env.FIREBASE_PROJECT_ID,
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Sign in with Google
async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  const token = await result.user.getIdToken();
  return { user: result.user, token };
}

// Sign in with Email/Password
async function signInWithEmail(email: string, password: string) {
  const result = await signInWithEmailAndPassword(auth, email, password);
  const token = await result.user.getIdToken();
  return { user: result.user, token };
}
```

#### Supabase Client

```typescript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

// Set Firebase JWT token
async function setAuthToken(firebaseToken: string) {
  await supabase.auth.setSession({
    access_token: firebaseToken,
    refresh_token: '',
  });
}

// Get current user data
async function getUserData(firebaseUid: string) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('firebase_uid', firebaseUid)
    .single();
  
  if (error) throw error;
  return data;
}

// Update user profile
async function updateUserProfile(firebaseUid: string, updates: any) {
  const { data, error } = await supabase
    .from('users')
    .update(updates)
    .eq('firebase_uid', firebaseUid)
    .select()
    .single();
  
  if (error) throw error;
  return data;
}
```

#### Complete Authentication Flow

```typescript
// 1. Sign in with Firebase
const { user, token } = await signInWithGoogle();

// 2. Set token for Supabase
await setAuthToken(token);

// 3. Wait for Cloud Function to sync (usually < 2 seconds)
await new Promise(resolve => setTimeout(resolve, 2000));

// 4. Fetch user data from Supabase
const userData = await getUserData(user.uid);

console.log('User authenticated and synced:', userData);
```

### Rate Limits

**Supabase:**
- Free tier: 500 requests per second
- Pro tier: 1000+ requests per second

**Firebase:**
- Authentication: 10 requests per second per IP
- Cloud Functions: 1000 concurrent executions (free tier)

**Directus:**
- No built-in rate limiting (configure via reverse proxy if needed)

## 🐛 Troubleshooting

### Docker Issues

#### Port Already in Use

**Problem**: Port 8055 or 5432 already in use

**On Windows:**
```powershell
# Find process using port 8055
netstat -ano | findstr :8055

# Kill the process (replace PID with actual process ID)
taskkill /PID <PID> /F

# Or change port in docker-compose.yml
```

**On Linux/Mac:**
```bash
# Find process using port 8055
lsof -i :8055

# Kill the process
kill -9 <PID>

# Or change port in docker-compose.yml
```

**Solution**: Change port mapping in `docker-compose.yml`:
```yaml
services:
  directus:
    ports:
      - "8056:8055"  # Use different host port
```

#### PostgreSQL Won't Start

**Problem**: PostgreSQL container keeps restarting

**Diagnosis:**
```bash
# Check logs
docker-compose logs postgres

# Check container status
docker-compose ps
```

**Common causes:**
1. **Port conflict**: Port 5432 already in use
2. **Permission issues**: Volume mount permissions
3. **Corrupted data**: Previous incomplete shutdown

**Solutions:**
```bash
# Solution 1: Remove volumes and restart
docker-compose down -v
docker-compose up -d

# Solution 2: Check port availability
netstat -ano | findstr :5432  # Windows
lsof -i :5432                 # Linux/Mac

# Solution 3: Verify environment variables
docker-compose config
```

#### Directus Container Crashes

**Problem**: Directus container exits immediately after starting

**Diagnosis:**
```bash
# View detailed logs
docker-compose logs directus --tail=100

# Check environment variables
docker-compose exec directus env | grep DB_
```

**Common causes:**
1. **Database connection failure**: Wrong credentials or PostgreSQL not ready
2. **Missing environment variables**: KEY, SECRET, or ADMIN credentials
3. **Port conflict**: Port 8055 already in use

**Solutions:**
```bash
# Verify database connection
docker-compose exec postgres pg_isready -U directus

# Check environment variables in .env
cat .env | grep -E "DB_|DIRECTUS_"

# Restart with fresh logs
docker-compose down
docker-compose up
```

#### Network Issues

**Problem**: Containers can't communicate with each other

**Diagnosis:**
```bash
# List networks
docker network ls

# Inspect network
docker network inspect directus-network

# Test connectivity
docker-compose exec directus ping postgres
```

**Solution:**
```bash
# Recreate network
docker-compose down
docker network prune
docker-compose up -d
```

### Directus Issues

#### Can't Login to Directus

**Problem**: Admin credentials don't work

**Solution 1 - Reset via environment variables:**
```bash
# Update .env file with new credentials
DIRECTUS_ADMIN_EMAIL=admin@example.com
DIRECTUS_ADMIN_PASSWORD=newpassword

# Restart Directus
docker-compose restart directus
```

**Solution 2 - Create new admin user:**
```bash
docker-compose exec directus npx directus users create \
  --email admin@example.com \
  --password newpassword \
  --role administrator
```

**Solution 3 - Reset database:**
```bash
# WARNING: This deletes all data
docker-compose down -v
docker-compose up -d
```

#### Database Connection Error

**Problem**: Directus shows "Database connection failed"

**Diagnosis:**
```bash
# Check PostgreSQL is running
docker-compose ps postgres

# Test connection from Directus container
docker-compose exec directus nc -zv postgres 5432
```

**Common causes:**
1. Wrong database credentials in `.env`
2. PostgreSQL not fully started (check health)
3. Network issues between containers

**Solutions:**
```bash
# Verify environment variables
echo "DB_HOST: $DB_HOST"
echo "DB_USER: $DB_USER"
echo "DB_NAME: $DB_NAME"

# Wait for PostgreSQL health check
docker-compose up -d postgres
sleep 10
docker-compose up -d directus

# Check PostgreSQL logs
docker-compose logs postgres
```

#### CORS Errors

**Problem**: Browser shows CORS errors when accessing Directus API

**Solution**: Update `docker-compose.yml`:
```yaml
services:
  directus:
    environment:
      CORS_ENABLED: "true"
      CORS_ORIGIN: "true"  # Allow all origins (dev only)
      # For production, specify exact origins:
      # CORS_ORIGIN: "https://yourdomain.com,https://app.yourdomain.com"
```

Then restart:
```bash
docker-compose restart directus
```

### Firebase Issues

#### Cloud Functions Not Deploying

**Problem**: `firebase deploy --only functions` fails

**Diagnosis:**
```bash
# Check Firebase login status
firebase login --reauth

# Verify project
firebase projects:list
firebase use --add

# Check Node.js version
node --version  # Should be 18+
```

**Common causes:**
1. Not logged in to Firebase CLI
2. Wrong project selected
3. Build errors in TypeScript
4. Missing dependencies

**Solutions:**
```bash
# Re-authenticate
firebase login --reauth

# Select correct project
firebase use <your-project-id>

# Build and check for errors
cd functions
npm install
npm run build

# Deploy with verbose logging
firebase deploy --only functions --debug
```

#### Functions Timeout

**Problem**: Cloud Functions timeout after 60 seconds

**Diagnosis:**
```bash
# View function logs
firebase functions:log --only syncUserToSupabase

# Check function execution time
```

**Solutions:**

1. **Increase timeout** in `functions/src/index.ts`:
```typescript
export const syncUserToSupabase = functions
  .runWith({ timeoutSeconds: 120 })  // Increase to 120 seconds
  .auth.user().onCreate(async (user) => {
    // ... function code
  });
```

2. **Optimize function code**:
- Use connection pooling for Supabase client
- Reduce unnecessary API calls
- Add proper error handling

3. **Check network latency**:
```bash
# Test Supabase connection speed
curl -w "@curl-format.txt" -o /dev/null -s https://your-project.supabase.co
```

#### Function Configuration Missing

**Problem**: Functions can't access Supabase credentials

**Diagnosis:**
```bash
# Check current configuration
firebase functions:config:get

# Should show:
# {
#   "supabase": {
#     "url": "https://...",
#     "service_key": "eyJ..."
#   }
# }
```

**Solution:**
```bash
# Set configuration
firebase functions:config:set supabase.url="https://xxxxx.supabase.co"
firebase functions:config:set supabase.service_key="eyJhbGc..."

# Deploy functions
firebase deploy --only functions
```

**For local development**, create `functions/.runtimeconfig.json`:
```json
{
  "supabase": {
    "url": "https://xxxxx.supabase.co",
    "service_key": "eyJhbGc..."
  }
}
```

### Supabase Issues

#### JWT Verification Fails

**Problem**: Supabase returns 401 Unauthorized with valid Firebase token

**Diagnosis:**
```bash
# Decode JWT token to check claims
# Use https://jwt.io or:
echo "<token>" | cut -d. -f2 | base64 -d | jq
```

**Common causes:**
1. Firebase not configured as auth provider in Supabase
2. Wrong JWT secret
3. Token expired
4. Issuer mismatch

**Solutions:**

1. **Configure Firebase in Supabase Dashboard:**
   - Go to Authentication → Providers
   - Enable Firebase
   - Set Project ID: `your-firebase-project-id`
   - Set Issuer: `https://securetoken.google.com/your-firebase-project-id`

2. **Verify JWT secret matches:**
```bash
# In Supabase Dashboard: Settings → API → JWT Secret
# Should match SUPABASE_JWT_SECRET in .env
```

3. **Check token expiration:**
```typescript
// Refresh token if expired
const token = await user.getIdToken(true);  // Force refresh
```

#### RLS Policy Blocks Access

**Problem**: User can't access their own data despite valid JWT

**Diagnosis:**
```sql
-- Connect to database
docker-compose exec postgres psql -U directus -d directus

-- Check if RLS is enabled
SELECT rowsecurity FROM pg_tables WHERE tablename = 'users';

-- List policies
SELECT * FROM pg_policies WHERE tablename = 'users';

-- Test policy manually
SET request.jwt.claims = '{"sub": "test-firebase-uid"}';
SELECT * FROM public.users WHERE firebase_uid = 'test-firebase-uid';
```

**Common causes:**
1. RLS policies not created correctly
2. JWT doesn't contain firebase_uid claim
3. Policy uses wrong claim name

**Solutions:**

1. **Verify RLS policies exist:**
```sql
-- Should show policies for SELECT, UPDATE, INSERT
SELECT policyname, cmd FROM pg_policies WHERE tablename = 'users';
```

2. **Check JWT claims:**
```typescript
// Ensure Firebase token contains user_id or sub claim
const token = await user.getIdToken();
const decoded = JSON.parse(atob(token.split('.')[1]));
console.log('JWT claims:', decoded);
```

3. **Recreate policies** if needed:
```bash
# Re-run RLS setup script
docker-compose exec postgres psql -U directus -d directus -f /docker-entrypoint-initdb.d/02-setup-rls.sql
```

#### Connection Pool Exhausted

**Problem**: "remaining connection slots are reserved" error

**Diagnosis:**
```sql
-- Check active connections
SELECT count(*) FROM pg_stat_activity;

-- Check max connections
SHOW max_connections;
```

**Solutions:**

1. **Increase max connections** in `docker-compose.yml`:
```yaml
services:
  postgres:
    command: postgres -c max_connections=200
```

2. **Use connection pooling** in application code:
```typescript
import { createClient } from '@supabase/supabase-js';

// Create single client instance (reuse across requests)
const supabase = createClient(url, key, {
  db: { schema: 'public' },
  auth: { persistSession: false }
});
```

3. **Close idle connections:**
```sql
-- Kill idle connections
SELECT pg_terminate_backend(pid) 
FROM pg_stat_activity 
WHERE state = 'idle' 
AND state_change < NOW() - INTERVAL '5 minutes';
```

### Testing Issues

#### Tests Fail with "Connection Refused"

**Problem**: Tests can't connect to database

**Diagnosis:**
```bash
# Check test environment is running
npm run test:env:status

# Check test database port
docker-compose -f docker-compose.test.yml ps
```

**Solution:**
```bash
# Start test environment
npm run test:env:up

# Wait for services to be ready
sleep 10

# Run tests
npm test
```

#### Property Tests Fail Intermittently

**Problem**: Property-based tests pass sometimes, fail other times

**Diagnosis:**
- Check test logs for specific failing inputs
- Look for race conditions or timing issues

**Solutions:**

1. **Increase test timeout:**
```typescript
describe('Property Test', () => {
  it('should pass', async () => {
    // ... test code
  }, 10000);  // 10 second timeout
});
```

2. **Add proper cleanup:**
```typescript
afterEach(async () => {
  // Clean up test data
  await supabase.from('users').delete().neq('firebase_uid', '');
});
```

3. **Use deterministic seeds:**
```typescript
import fc from 'fast-check';

fc.assert(
  fc.property(/* ... */),
  { seed: 42, numRuns: 100 }  // Reproducible tests
);
```

### Environment Variable Issues

#### Missing Environment Variables

**Problem**: Application fails with "undefined" errors

**Diagnosis:**
```bash
# Check .env file exists
ls -la .env

# Verify variables are loaded
docker-compose config | grep -A 20 environment
```

**Solution:**
```bash
# Copy from example
cp .env.example .env

# Edit with your values
nano .env  # or use your preferred editor

# Restart services to load new variables
docker-compose down
docker-compose up -d
```

#### Environment Variables Not Loading

**Problem**: Docker Compose doesn't load .env file

**Common causes:**
1. `.env` file in wrong location (must be in same directory as `docker-compose.yml`)
2. Syntax errors in `.env` file
3. Variables with spaces not quoted

**Solutions:**

1. **Verify file location:**
```bash
# .env should be in project root
ls -la .env
pwd
```

2. **Check syntax:**
```bash
# Variables should be in format: KEY=value
# No spaces around =
# Quote values with spaces: KEY="value with spaces"

# Test loading
docker-compose config
```

3. **Use explicit env_file:**
```yaml
services:
  directus:
    env_file:
      - .env
```

### Performance Issues

#### Slow Database Queries

**Problem**: Queries take too long to execute

**Diagnosis:**
```sql
-- Enable query logging
ALTER DATABASE directus SET log_statement = 'all';

-- Check slow queries
SELECT query, calls, total_time, mean_time
FROM pg_stat_statements
ORDER BY mean_time DESC
LIMIT 10;
```

**Solutions:**

1. **Add indexes:**
```sql
-- Already created in schema, but verify:
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON public.users(firebase_uid);
```

2. **Optimize queries:**
```typescript
// Use select() to fetch only needed columns
const { data } = await supabase
  .from('users')
  .select('firebase_uid, email, display_name')  // Don't use *
  .eq('firebase_uid', uid)
  .single();
```

3. **Enable connection pooling** (see Connection Pool Exhausted above)

#### High Memory Usage

**Problem**: Docker containers use too much memory

**Diagnosis:**
```bash
# Check container stats
docker stats

# Check PostgreSQL memory
docker-compose exec postgres free -h
```

**Solutions:**

1. **Limit container memory** in `docker-compose.yml`:
```yaml
services:
  postgres:
    mem_limit: 512m
  directus:
    mem_limit: 256m
```

2. **Optimize PostgreSQL:**
```yaml
services:
  postgres:
    command: |
      postgres
      -c shared_buffers=256MB
      -c effective_cache_size=512MB
      -c work_mem=16MB
```

### Getting More Help

If you're still experiencing issues:

1. **Check logs** for detailed error messages:
   ```bash
   docker-compose logs --tail=100 -f
   ```

2. **Search existing issues**: [GitHub Issues](https://github.com/khuepm/LumiBase/issues)

3. **Create a new issue** with:
   - Detailed description of the problem
   - Steps to reproduce
   - Error messages and logs
   - Environment details (OS, Docker version, Node version)

4. **Join discussions**: [GitHub Discussions](https://github.com/khuepm/LumiBase/discussions)

5. **Check documentation**:
   - [Firebase Docs](https://firebase.google.com/docs)
   - [Supabase Docs](https://supabase.com/docs)
   - [Directus Docs](https://docs.directus.io/)
   - [Docker Docs](https://docs.docker.com/)

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
