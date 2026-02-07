# Deployment Procedures Guide

This guide provides comprehensive instructions for deploying LumiBase to production, including security best practices, monitoring setup, and backup/recovery procedures.

## Table of Contents

- [Production Deployment Checklist](#production-deployment-checklist)
- [Security Best Practices](#security-best-practices)
- [Deployment Steps](#deployment-steps)
- [Monitoring and Logging Setup](#monitoring-and-logging-setup)
- [Backup and Recovery Procedures](#backup-and-recovery-procedures)
- [Scaling Considerations](#scaling-considerations)
- [Troubleshooting Production Issues](#troubleshooting-production-issues)

## Production Deployment Checklist

Use this checklist before deploying to production:

### Pre-Deployment

- [ ] **Environment Variables**
  - [ ] All production environment variables configured
  - [ ] No development/test credentials in production `.env`
  - [ ] Strong passwords and secrets generated
  - [ ] API keys and tokens secured in secret manager

- [ ] **Security**
  - [ ] Firebase Authentication configured with production settings
  - [ ] Supabase RLS policies tested and verified
  - [ ] CORS configured for production domains only
  - [ ] SSL/TLS certificates configured
  - [ ] Rate limiting configured
  - [ ] Security headers configured

- [ ] **Database**
  - [ ] Production database created and configured
  - [ ] Database migrations tested
  - [ ] Database backups configured
  - [ ] Connection pooling configured
  - [ ] Indexes optimized for production queries

- [ ] **Firebase**
  - [ ] Production Firebase project created
  - [ ] Authentication providers configured
  - [ ] Cloud Functions deployed and tested
  - [ ] Function quotas and limits reviewed
  - [ ] Billing alerts configured

- [ ] **Supabase**
  - [ ] Production Supabase project created
  - [ ] Database schema deployed
  - [ ] RLS policies enabled and tested
  - [ ] API keys secured
  - [ ] Realtime subscriptions configured (if needed)

- [ ] **Directus**
  - [ ] Production Directus instance deployed
  - [ ] Admin users created
  - [ ] Roles and permissions configured
  - [ ] File storage configured
  - [ ] Email settings configured

- [ ] **Testing**
  - [ ] All tests passing in CI/CD
  - [ ] Integration tests run against staging
  - [ ] Load testing completed
  - [ ] Security scanning completed
  - [ ] End-to-end authentication flow tested

- [ ] **Monitoring**
  - [ ] Application monitoring configured
  - [ ] Error tracking configured
  - [ ] Log aggregation configured
  - [ ] Uptime monitoring configured
  - [ ] Alerts configured for critical issues

- [ ] **Documentation**
  - [ ] API documentation updated
  - [ ] Deployment runbook created
  - [ ] Rollback procedures documented
  - [ ] Team trained on production procedures

### Post-Deployment

- [ ] **Verification**
  - [ ] All services accessible
  - [ ] Authentication flow working
  - [ ] Database connections working
  - [ ] Cloud Functions triggering correctly
  - [ ] Monitoring and alerts working

- [ ] **Performance**
  - [ ] Response times acceptable
  - [ ] Database query performance acceptable
  - [ ] No memory leaks detected
  - [ ] Resource usage within limits

- [ ] **Security**
  - [ ] Security scan passed
  - [ ] No exposed secrets
  - [ ] HTTPS enforced
  - [ ] Rate limiting working

## Security Best Practices

### 1. Environment Variables and Secrets

**Never commit secrets to Git:**

```bash
# .gitignore should include:
.env
.env.production
.env.local
*.key
*.pem
service-account-*.json
```

**Use Secret Managers:**

- **Firebase**: Use Firebase Functions config
  ```bash
  firebase functions:config:set supabase.service_key="<key>"
  ```

- **GitHub Actions**: Use GitHub Secrets
  - Go to Settings → Secrets and variables → Actions
  - Add secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, etc.

- **Cloud Providers**: Use native secret managers
  - AWS: AWS Secrets Manager
  - GCP: Secret Manager
  - Azure: Key Vault

**Rotate secrets regularly:**

```bash
# Rotate every 90 days
# 1. Generate new secret
openssl rand -base64 32

# 2. Update in all environments
# 3. Deploy with new secret
# 4. Verify everything works
# 5. Revoke old secret
```

### 2. Authentication and Authorization

**Firebase Authentication:**

- Enable only required authentication providers
- Configure OAuth consent screen properly
- Enable email verification for new accounts
- Set up password requirements:
  - Minimum 12 characters
  - Require uppercase, lowercase, numbers, symbols
- Enable multi-factor authentication (MFA) for admin accounts
- Set up account recovery procedures

**Supabase RLS Policies:**

```sql
-- Verify RLS is enabled on all tables
SELECT tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public' AND rowsecurity = false;

-- Should return no rows (all tables should have RLS enabled)
```

**Test RLS policies thoroughly:**

```bash
# Run RLS integration tests
npm run test:integration tests/integration/rls-policies.integration.test.ts
```

### 3. API Security

**Rate Limiting:**

Configure rate limiting in Directus:

```yaml
# docker-compose.yml
services:
  directus:
    environment:
      RATE_LIMITER_ENABLED: "true"
      RATE_LIMITER_POINTS: 50
      RATE_LIMITER_DURATION: 1
```

**CORS Configuration:**

```yaml
# Production CORS - specify exact origins
services:
  directus:
    environment:
      CORS_ENABLED: "true"
      CORS_ORIGIN: "https://yourdomain.com,https://app.yourdomain.com"
      CORS_CREDENTIALS: "true"
```

**Security Headers:**

Add security headers via reverse proxy (nginx example):

```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Content-Security-Policy "default-src 'self'" always;
```

### 4. Database Security

**Connection Security:**

- Use SSL/TLS for all database connections
- Restrict database access to specific IP addresses
- Use strong passwords (minimum 32 characters)
- Enable connection pooling to prevent exhaustion

**PostgreSQL Configuration:**

```sql
-- Require SSL connections
ALTER SYSTEM SET ssl = on;

-- Set strong password encryption
ALTER SYSTEM SET password_encryption = 'scram-sha-256';

-- Limit connections per user
ALTER ROLE directus CONNECTION LIMIT 20;

-- Enable audit logging
ALTER SYSTEM SET log_connections = on;
ALTER SYSTEM SET log_disconnections = on;
ALTER SYSTEM SET log_statement = 'ddl';
```

**Regular Security Audits:**

```bash
# Check for weak passwords
# Check for unused users
# Review access logs
# Verify RLS policies
# Check for SQL injection vulnerabilities
```

### 5. Cloud Functions Security

**Secure Configuration:**

```typescript
// functions/src/index.ts
import * as functions from 'firebase-functions';

export const syncUserToSupabase = functions
  .runWith({
    timeoutSeconds: 60,
    memory: '256MB',
    // Restrict to specific regions
    region: 'us-central1',
    // Set max instances to prevent runaway costs
    maxInstances: 10,
  })
  .auth.user().onCreate(async (user) => {
    // Validate input
    if (!user.email || !user.uid) {
      throw new Error('Invalid user data');
    }
    
    // Use service account with minimal permissions
    // Log security events
    // Handle errors gracefully
  });
```

**Function Permissions:**

- Use service accounts with minimal required permissions
- Don't expose service role keys in client code
- Validate all inputs
- Sanitize data before database operations
- Log security-relevant events

### 6. Network Security

**Firewall Rules:**

```bash
# Allow only necessary ports
# PostgreSQL: 5432 (internal only)
# Directus: 8055 (via reverse proxy only)
# HTTPS: 443
# SSH: 22 (restricted IPs only)
```

**VPC Configuration:**

- Place database in private subnet
- Use VPC peering for service communication
- Configure security groups properly
- Enable VPC flow logs

### 7. Monitoring and Alerting

**Security Monitoring:**

- Monitor failed authentication attempts
- Alert on unusual database access patterns
- Track API rate limit violations
- Monitor for SQL injection attempts
- Alert on configuration changes

**Log Security Events:**

```typescript
// Log security events
console.log({
  event: 'authentication_failed',
  user: email,
  ip: request.ip,
  timestamp: new Date().toISOString(),
});
```

## Deployment Steps

### 1. Deploy Database (Supabase)

#### Option A: Supabase Cloud (Recommended)

1. **Create Production Project:**
   ```bash
   # Go to https://app.supabase.com/
   # Click "New project"
   # Select organization
   # Enter project name: "lumibase-production"
   # Choose region (closest to users)
   # Generate strong database password
   # Click "Create new project"
   ```

2. **Apply Database Schema:**
   ```bash
   # Install Supabase CLI
   npm install -g supabase

   # Login
   supabase login

   # Link to production project
   supabase link --project-ref <your-project-ref>

   # Push migrations
   supabase db push
   ```

3. **Configure RLS Policies:**
   ```bash
   # RLS policies are included in migrations
   # Verify they're applied:
   supabase db remote exec "SELECT * FROM pg_policies WHERE tablename = 'users';"
   ```

4. **Get Production Credentials:**
   ```bash
   # Go to Project Settings → API
   # Copy:
   # - Project URL (SUPABASE_URL)
   # - anon public key (SUPABASE_ANON_KEY)
   # - service_role secret key (SUPABASE_SERVICE_ROLE_KEY)
   # - JWT Secret (SUPABASE_JWT_SECRET)
   ```

#### Option B: Self-Hosted PostgreSQL

1. **Provision Database Server:**
   ```bash
   # Use managed service (AWS RDS, GCP Cloud SQL, Azure Database)
   # Or self-host with Docker/Kubernetes
   ```

2. **Apply Migrations:**
   ```bash
   # Connect to production database
   psql -h <host> -U <user> -d <database>

   # Run migration scripts
   \i init-scripts/01-create-schema.sql
   \i init-scripts/02-setup-rls.sql
   ```

3. **Configure Backups:**
   ```bash
   # Set up automated backups
   # Configure point-in-time recovery
   # Test restore procedures
   ```

### 2. Deploy Firebase Cloud Functions

1. **Build Functions:**
   ```bash
   cd functions
   npm install
   npm run build
   ```

2. **Set Production Configuration:**
   ```bash
   # Select production project
   firebase use production

   # Set Supabase credentials
   firebase functions:config:set \
     supabase.url="https://your-project.supabase.co" \
     supabase.service_key="<service-role-key>"

   # Verify configuration
   firebase functions:config:get
   ```

3. **Deploy Functions:**
   ```bash
   # Deploy all functions
   firebase deploy --only functions

   # Or deploy specific function
   firebase deploy --only functions:syncUserToSupabase

   # Verify deployment
   firebase functions:list
   ```

4. **Test Functions:**
   ```bash
   # Create test user in Firebase Console
   # Check function logs
   firebase functions:log --only syncUserToSupabase

   # Verify user synced to Supabase
   ```

### 3. Deploy Directus CMS

#### Option A: Docker Deployment

1. **Prepare Production docker-compose.yml:**
   ```yaml
   version: '3.8'

   services:
     directus:
       image: directus/directus:10-latest
       restart: always
       ports:
         - "8055:8055"
       environment:
         KEY: ${DIRECTUS_KEY}
         SECRET: ${DIRECTUS_SECRET}
         ADMIN_EMAIL: ${DIRECTUS_ADMIN_EMAIL}
         ADMIN_PASSWORD: ${DIRECTUS_ADMIN_PASSWORD}
         DB_CLIENT: pg
         DB_HOST: ${DB_HOST}
         DB_PORT: ${DB_PORT}
         DB_DATABASE: ${DB_NAME}
         DB_USER: ${DB_USER}
         DB_PASSWORD: ${DB_PASSWORD}
         DB_SSL: "true"
         PUBLIC_URL: https://cms.yourdomain.com
         CORS_ENABLED: "true"
         CORS_ORIGIN: "https://yourdomain.com"
         RATE_LIMITER_ENABLED: "true"
       volumes:
         - directus_uploads:/directus/uploads
         - directus_extensions:/directus/extensions
       healthcheck:
         test: ["CMD", "curl", "-f", "http://localhost:8055/server/health"]
         interval: 30s
         timeout: 10s
         retries: 3

   volumes:
     directus_uploads:
     directus_extensions:
   ```

2. **Deploy:**
   ```bash
   # Copy production .env
   scp .env.production server:/opt/lumibase/.env

   # SSH to server
   ssh server

   # Pull latest image
   docker-compose pull

   # Start services
   docker-compose up -d

   # Check logs
   docker-compose logs -f directus
   ```

#### Option B: Cloud Platform Deployment

**AWS ECS:**
```bash
# Create ECS task definition
# Configure load balancer
# Deploy service
# Configure auto-scaling
```

**Google Cloud Run:**
```bash
# Build container
docker build -t gcr.io/project-id/directus .

# Push to registry
docker push gcr.io/project-id/directus

# Deploy
gcloud run deploy directus \
  --image gcr.io/project-id/directus \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated
```

### 4. Configure Domain and SSL

1. **Set up DNS:**
   ```
   # A records
   yourdomain.com        → <server-ip>
   cms.yourdomain.com    → <server-ip>
   api.yourdomain.com    → <server-ip>

   # CNAME records (if using CDN)
   www.yourdomain.com    → yourdomain.com
   ```

2. **Configure SSL with Let's Encrypt:**
   ```bash
   # Install certbot
   sudo apt-get install certbot python3-certbot-nginx

   # Get certificate
   sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

   # Auto-renewal
   sudo certbot renew --dry-run
   ```

3. **Configure Nginx Reverse Proxy:**
   ```nginx
   # /etc/nginx/sites-available/lumibase
   server {
       listen 443 ssl http2;
       server_name cms.yourdomain.com;

       ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

       location / {
           proxy_pass http://localhost:8055;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```

### 5. Deploy Client Application

1. **Build Client:**
   ```bash
   cd client
   npm install
   npm run build
   ```

2. **Deploy to Hosting:**

   **Vercel:**
   ```bash
   npm install -g vercel
   vercel --prod
   ```

   **Netlify:**
   ```bash
   npm install -g netlify-cli
   netlify deploy --prod
   ```

   **Firebase Hosting:**
   ```bash
   firebase deploy --only hosting
   ```

## Monitoring and Logging Setup

### 1. Application Monitoring

#### Firebase Monitoring

**Enable Performance Monitoring:**
```typescript
// client/src/index.ts
import { getPerformance } from 'firebase/performance';

const perf = getPerformance(app);
```

**Monitor Cloud Functions:**
```bash
# View function metrics in Firebase Console
# Go to Functions → Dashboard
# Monitor:
# - Invocations
# - Execution time
# - Memory usage
# - Error rate
```

#### Supabase Monitoring

**Database Metrics:**
```bash
# Go to Supabase Dashboard → Database → Metrics
# Monitor:
# - Active connections
# - Query performance
# - Database size
# - Cache hit rate
```

**API Metrics:**
```bash
# Go to Supabase Dashboard → API → Metrics
# Monitor:
# - Request rate
# - Response time
# - Error rate
# - Bandwidth usage
```

### 2. Error Tracking

#### Sentry Integration

```bash
# Install Sentry
npm install @sentry/node @sentry/browser

# Configure for Cloud Functions
# functions/src/index.ts
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: 'production',
});

export const syncUserToSupabase = functions.auth.user().onCreate(async (user) => {
  try {
    // ... function code
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
});
```

### 3. Log Aggregation

#### CloudWatch (AWS)

```bash
# Configure CloudWatch agent
# Aggregate logs from:
# - Application logs
# - Database logs
# - System logs
# - Security logs
```

#### Google Cloud Logging

```bash
# Logs automatically collected for:
# - Cloud Functions
# - Cloud Run
# - GKE
```

#### Self-Hosted (ELK Stack)

```yaml
# docker-compose.yml
services:
  elasticsearch:
    image: elasticsearch:8.11.0
    environment:
      - discovery.type=single-node
    ports:
      - "9200:9200"

  logstash:
    image: logstash:8.11.0
    volumes:
      - ./logstash.conf:/usr/share/logstash/pipeline/logstash.conf

  kibana:
    image: kibana:8.11.0
    ports:
      - "5601:5601"
```

### 4. Uptime Monitoring

**UptimeRobot:**
```bash
# Monitor endpoints:
# - https://yourdomain.com (every 5 minutes)
# - https://cms.yourdomain.com (every 5 minutes)
# - https://api.yourdomain.com/health (every 5 minutes)

# Alert channels:
# - Email
# - Slack
# - SMS (for critical)
```

**Pingdom:**
```bash
# Configure checks for:
# - HTTP/HTTPS availability
# - Response time
# - SSL certificate expiration
# - DNS resolution
```

### 5. Alerting

**Critical Alerts (immediate notification):**
- Service down
- Database connection failure
- High error rate (>5%)
- Security breach attempt
- SSL certificate expiring soon

**Warning Alerts (notify within 1 hour):**
- High response time (>2s)
- High memory usage (>80%)
- High CPU usage (>80%)
- Disk space low (<20%)

**Info Alerts (daily digest):**
- Daily usage statistics
- Performance trends
- Cost reports

## Backup and Recovery Procedures

### 1. Database Backups

#### Automated Backups (Supabase Cloud)

```bash
# Supabase automatically backs up your database
# Point-in-time recovery available for Pro plan
# Backups retained for 7 days (Pro) or 30 days (Enterprise)

# Manual backup
supabase db dump -f backup.sql

# Restore from backup
supabase db reset
psql -h <host> -U <user> -d <database> -f backup.sql
```

#### Self-Hosted PostgreSQL Backups

```bash
# Create backup script: /opt/scripts/backup-db.sh
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/opt/backups/postgres"
DB_NAME="directus"

# Create backup
docker-compose exec -T postgres pg_dump -U directus $DB_NAME | gzip > $BACKUP_DIR/backup_$DATE.sql.gz

# Keep only last 30 days
find $BACKUP_DIR -name "backup_*.sql.gz" -mtime +30 -delete

# Upload to S3
aws s3 cp $BACKUP_DIR/backup_$DATE.sql.gz s3://your-bucket/backups/
```

**Schedule with cron:**
```bash
# Edit crontab
crontab -e

# Add daily backup at 2 AM
0 2 * * * /opt/scripts/backup-db.sh
```

### 2. File Backups (Directus Uploads)

```bash
# Backup Directus uploads
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/opt/backups/directus"

# Backup uploads volume
docker run --rm \
  -v directus_uploads:/data \
  -v $BACKUP_DIR:/backup \
  alpine tar czf /backup/uploads_$DATE.tar.gz /data

# Upload to S3
aws s3 cp $BACKUP_DIR/uploads_$DATE.tar.gz s3://your-bucket/uploads/

# Keep only last 30 days
find $BACKUP_DIR -name "uploads_*.tar.gz" -mtime +30 -delete
```

### 3. Configuration Backups

```bash
# Backup configuration files
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/opt/backups/config"

# Backup important configs
tar czf $BACKUP_DIR/config_$DATE.tar.gz \
  /opt/lumibase/.env \
  /opt/lumibase/docker-compose.yml \
  /etc/nginx/sites-available/lumibase \
  /opt/lumibase/init-scripts/

# Upload to S3
aws s3 cp $BACKUP_DIR/config_$DATE.tar.gz s3://your-bucket/config/
```

### 4. Recovery Procedures

#### Database Recovery

```bash
# 1. Stop application
docker-compose down

# 2. Download backup
aws s3 cp s3://your-bucket/backups/backup_20240101_020000.sql.gz .

# 3. Restore database
gunzip backup_20240101_020000.sql.gz
docker-compose up -d postgres
sleep 10
docker-compose exec -T postgres psql -U directus -d directus < backup_20240101_020000.sql

# 4. Verify data
docker-compose exec postgres psql -U directus -d directus -c "SELECT COUNT(*) FROM public.users;"

# 5. Restart application
docker-compose up -d
```

#### File Recovery

```bash
# 1. Download backup
aws s3 cp s3://your-bucket/uploads/uploads_20240101_020000.tar.gz .

# 2. Stop Directus
docker-compose stop directus

# 3. Restore files
docker run --rm \
  -v directus_uploads:/data \
  -v $(pwd):/backup \
  alpine sh -c "cd /data && tar xzf /backup/uploads_20240101_020000.tar.gz --strip-components=1"

# 4. Restart Directus
docker-compose start directus
```

#### Disaster Recovery

**Complete System Recovery:**

1. **Provision new infrastructure**
2. **Restore database from backup**
3. **Restore file uploads from backup**
4. **Restore configuration files**
5. **Deploy application**
6. **Update DNS records**
7. **Verify all services**
8. **Monitor for issues**

**Recovery Time Objective (RTO):** 4 hours
**Recovery Point Objective (RPO):** 24 hours

### 5. Backup Testing

**Monthly Backup Test:**

```bash
# 1. Create test environment
docker-compose -f docker-compose.test.yml up -d

# 2. Restore latest backup to test environment
# 3. Verify data integrity
# 4. Test application functionality
# 5. Document any issues
# 6. Clean up test environment
```

## Scaling Considerations

### 1. Database Scaling

**Vertical Scaling:**
- Increase CPU and memory
- Upgrade to larger instance type
- Monitor query performance

**Horizontal Scaling:**
- Set up read replicas for read-heavy workloads
- Use connection pooling (PgBouncer)
- Implement caching layer (Redis)

**Supabase Scaling:**
```bash
# Upgrade to Pro plan for:
# - More concurrent connections
# - Better performance
# - Larger database size
# - Point-in-time recovery
```

### 2. Application Scaling

**Directus Scaling:**
```yaml
# docker-compose.yml
services:
  directus:
    deploy:
      replicas: 3
      resources:
        limits:
          cpus: '1'
          memory: 512M
```

**Load Balancing:**
```nginx
upstream directus_backend {
    least_conn;
    server directus1:8055;
    server directus2:8055;
    server directus3:8055;
}

server {
    location / {
        proxy_pass http://directus_backend;
    }
}
```

### 3. Cloud Functions Scaling

**Firebase Functions Auto-Scaling:**
```typescript
export const syncUserToSupabase = functions
  .runWith({
    minInstances: 1,      // Keep warm
    maxInstances: 100,    // Scale up to 100
    memory: '256MB',
    timeoutSeconds: 60,
  })
  .auth.user().onCreate(async (user) => {
    // ... function code
  });
```

### 4. CDN and Caching

**CloudFlare Setup:**
```bash
# Add site to CloudFlare
# Configure DNS
# Enable CDN
# Set cache rules
# Enable DDoS protection
```

**Cache Strategy:**
- Static assets: Cache for 1 year
- API responses: Cache for 5 minutes
- User-specific data: No cache

## Troubleshooting Production Issues

### 1. Service Down

**Diagnosis:**
```bash
# Check service status
docker-compose ps

# Check logs
docker-compose logs --tail=100

# Check system resources
top
df -h
free -h
```

**Common Causes:**
- Out of memory
- Disk space full
- Database connection exhausted
- Network issues

**Resolution:**
```bash
# Restart services
docker-compose restart

# If that doesn't work, full restart
docker-compose down
docker-compose up -d

# Check health
curl http://localhost:8055/server/health
```

### 2. High Response Time

**Diagnosis:**
```bash
# Check database queries
# Enable slow query log
ALTER SYSTEM SET log_min_duration_statement = 1000;  # Log queries > 1s

# Check active connections
SELECT count(*) FROM pg_stat_activity;

# Check long-running queries
SELECT pid, now() - query_start as duration, query 
FROM pg_stat_activity 
WHERE state = 'active' 
ORDER BY duration DESC;
```

**Resolution:**
- Add database indexes
- Optimize slow queries
- Increase connection pool size
- Scale up resources

### 3. Authentication Failures

**Diagnosis:**
```bash
# Check Firebase logs
firebase functions:log --only syncUserToSupabase

# Check Supabase logs
# Go to Supabase Dashboard → Logs

# Test JWT verification
curl -H "Authorization: Bearer <token>" \
  https://your-project.supabase.co/rest/v1/users
```

**Common Causes:**
- Expired JWT tokens
- Wrong JWT secret
- RLS policy blocking access
- Firebase configuration mismatch

### 4. Data Sync Issues

**Diagnosis:**
```bash
# Check if Cloud Function is triggering
firebase functions:log

# Check if user exists in Firebase
# Firebase Console → Authentication

# Check if user exists in Supabase
docker-compose exec postgres psql -U directus -d directus \
  -c "SELECT * FROM public.users WHERE firebase_uid = '<uid>';"
```

**Resolution:**
- Manually trigger sync
- Check function configuration
- Verify Supabase credentials
- Check network connectivity

## Additional Resources

- [Firebase Production Best Practices](https://firebase.google.com/docs/functions/best-practices)
- [Supabase Production Checklist](https://supabase.com/docs/guides/platform/going-into-prod)
- [Directus Deployment Guide](https://docs.directus.io/self-hosted/deployment.html)
- [PostgreSQL Performance Tuning](https://wiki.postgresql.org/wiki/Performance_Optimization)
- [Docker Production Best Practices](https://docs.docker.com/develop/dev-best-practices/)

---

**Need help with deployment?** Open an issue on [GitHub](https://github.com/khuepm/LumiBase/issues) or contact the team.
