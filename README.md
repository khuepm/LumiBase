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

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Create a new project or select existing one
3. Enable **Authentication** → Enable **Google** and **Email/Password** providers
4. Go to **Project Settings** → **Service Accounts**
5. Click **Generate New Private Key** and download the JSON file
6. Extract these values to your `.env` file:
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_CLIENT_EMAIL`
   - `FIREBASE_PRIVATE_KEY` (keep the `\n` characters)
7. Go to **Project Settings** → **General** → **Web API Key**
8. Copy the API Key to `FIREBASE_WEB_API_KEY` in `.env`

### Step 3: Configure Supabase

1. Go to [Supabase Dashboard](https://app.supabase.com/)
2. Create a new project
3. Go to **Settings** → **API**
4. Copy these values to your `.env` file:
   - `SUPABASE_URL` (Project URL)
   - `SUPABASE_ANON_KEY` (anon public key)
   - `SUPABASE_SERVICE_ROLE_KEY` (service_role secret key)
5. Generate a JWT secret:
   ```bash
   openssl rand -base64 32
   ```
6. Add it to `SUPABASE_JWT_SECRET` in `.env`

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
```

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

```bash
# Seed initial data
./scripts/seed-data.sh

# Reset database
./scripts/reset-db.sh

# Access PostgreSQL shell
docker-compose exec postgres psql -U directus -d directus
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
