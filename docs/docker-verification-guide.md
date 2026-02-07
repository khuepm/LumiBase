# Docker Setup Verification Guide

## Mục đích

Tài liệu này hướng dẫn chi tiết cách verify Docker setup cho dự án Directus-Firebase-Supabase integration. Đây là checkpoint quan trọng để đảm bảo môi trường phát triển local hoạt động đúng trước khi tiếp tục các tasks tiếp theo.

## Yêu cầu trước khi bắt đầu

### 1. Cài đặt Docker Desktop

**Tải Docker Desktop cho Windows:**
- Truy cập: https://www.docker.com/products/docker-desktop/
- Tải phiên bản Windows
- Chạy installer và làm theo hướng dẫn
- Khởi động lại máy tính nếu được yêu cầu

**Verify Docker đã được cài đặt:**
```bash
docker --version
docker-compose --version
```

Kết quả mong đợi:
```
Docker version 24.0.0 hoặc cao hơn
Docker Compose version v2.20.0 hoặc cao hơn
```

### 2. Kiểm tra file cấu hình

Đảm bảo các files sau tồn tại trong project:
- ✅ `docker-compose.yml` - Docker Compose configuration
- ✅ `.env` - Environment variables (đã được tạo từ .env.example)
- ✅ `init-scripts/` - Database migration scripts (nếu có)

## Bước 1: Khởi động Docker Services

### 1.1 Stop các containers cũ (nếu có)

```bash
docker-compose down -v
```

Lệnh này sẽ:
- Stop tất cả containers
- Remove containers
- Remove volumes (flag `-v`) để bắt đầu fresh

### 1.2 Start services

```bash
docker-compose up -d
```

Flags:
- `-d`: Detached mode (chạy background)

Kết quả mong đợi:
```
[+] Running 4/4
 ✔ Network directus-firebase-supabase-setup_directus-network  Created
 ✔ Volume "directus-firebase-supabase-setup_postgres_data"    Created
 ✔ Container directus-postgres                                Started
 ✔ Container directus-cms                                     Started
```

### 1.3 Kiểm tra container status

```bash
docker-compose ps
```

Kết quả mong đợi - TẤT CẢ containers phải có status `Up`:
```
NAME               IMAGE                        STATUS         PORTS
directus-cms       directus/directus:10-latest  Up 30 seconds  0.0.0.0:8055->8055/tcp
directus-postgres  postgres:15-alpine           Up 30 seconds  0.0.0.0:5432->5432/tcp
```

**⚠️ Nếu có container bị `Exit` hoặc `Restarting`:**
- Xem logs để debug (xem Bước 4)
- Kiểm tra environment variables trong .env
- Kiểm tra port conflicts

## Bước 2: Verify PostgreSQL Connection

### 2.1 Kiểm tra PostgreSQL health

```bash
docker-compose exec postgres pg_isready -U directus
```

Kết quả mong đợi:
```
/var/run/postgresql:5432 - accepting connections
```

### 2.2 Connect vào PostgreSQL

```bash
docker-compose exec postgres psql -U directus -d directus
```

Bạn sẽ vào PostgreSQL prompt:
```
psql (15.x)
Type "help" for help.

directus=#
```

### 2.3 Verify database schema

Trong PostgreSQL prompt, chạy:

```sql
-- List all tables
\dt

-- Check users table structure (nếu đã chạy migrations)
\d public.users

-- Exit
\q
```

**Kết quả mong đợi (nếu migrations đã chạy):**
```
                Table "public.users"
    Column     |            Type             | Nullable
---------------+-----------------------------+----------
 firebase_uid  | character varying(128)      | not null
 email         | character varying(255)      | not null
 display_name  | character varying(255)      |
 photo_url     | text                        |
 created_at    | timestamp with time zone    | not null
 updated_at    | timestamp with time zone    | not null
Indexes:
    "users_pkey" PRIMARY KEY, btree (firebase_uid)
    "users_email_key" UNIQUE CONSTRAINT, btree (email)
    "idx_users_email" btree (email)
```

**⚠️ Nếu bảng chưa tồn tại:**
- Migrations chưa được chạy (sẽ được thực hiện trong Task 4)
- Đây là bình thường nếu bạn đang ở Task 3

## Bước 3: Verify Directus Accessibility

### 3.1 Kiểm tra Directus health endpoint

```bash
curl http://localhost:8055/server/health
```

Hoặc mở browser và truy cập: http://localhost:8055/server/health

Kết quả mong đợi:
```json
{
  "status": "ok",
  "releaseId": "...",
  "serviceId": "...",
  "checks": {
    "database": "ok",
    "storage": "ok"
  }
}
```

**✅ Quan trọng:** `"database": "ok"` xác nhận Directus đã kết nối thành công với PostgreSQL!

### 3.2 Truy cập Directus Admin UI

Mở browser và truy cập: http://localhost:8055

Bạn sẽ thấy:
- Trang login của Directus
- Hoặc setup wizard (nếu lần đầu khởi động)

**Login credentials (từ .env):**
- Email: `admin@example.com` (hoặc giá trị trong DIRECTUS_ADMIN_EMAIL)
- Password: `AdminPassword123!` (hoặc giá trị trong DIRECTUS_ADMIN_PASSWORD)

### 3.3 Verify Directus database connection

Sau khi login vào Directus:
1. Click vào Settings (⚙️) ở sidebar
2. Click vào "Data Model"
3. Bạn sẽ thấy danh sách các tables trong database

**✅ Nếu thấy interface này:** Directus đã kết nối thành công với PostgreSQL!

## Bước 4: Troubleshooting

### 4.1 Xem logs của containers

**Xem logs của tất cả services:**
```bash
docker-compose logs
```

**Xem logs của PostgreSQL:**
```bash
docker-compose logs postgres
```

**Xem logs của Directus:**
```bash
docker-compose logs directus
```

**Follow logs real-time:**
```bash
docker-compose logs -f directus
```

### 4.2 Common Issues

#### Issue 1: Port 8055 đã được sử dụng

**Error message:**
```
Error starting userland proxy: listen tcp4 0.0.0.0:8055: bind: address already in use
```

**Solution:**
```bash
# Tìm process đang sử dụng port 8055
netstat -ano | findstr :8055

# Kill process (thay <PID> bằng Process ID)
taskkill /PID <PID> /F

# Hoặc thay đổi port trong docker-compose.yml
# Sửa "8055:8055" thành "8056:8055"
```

#### Issue 2: PostgreSQL không start

**Error message trong logs:**
```
FATAL: password authentication failed for user "directus"
```

**Solution:**
1. Kiểm tra DB_USER, DB_PASSWORD trong .env
2. Stop containers và xóa volumes:
   ```bash
   docker-compose down -v
   ```
3. Start lại:
   ```bash
   docker-compose up -d
   ```

#### Issue 3: Directus không kết nối được PostgreSQL

**Error message trong logs:**
```
Error: connect ECONNREFUSED 172.x.x.x:5432
```

**Solution:**
1. Verify PostgreSQL đang chạy:
   ```bash
   docker-compose ps postgres
   ```
2. Kiểm tra DB_HOST trong docker-compose.yml phải là `postgres` (tên service)
3. Kiểm tra network configuration
4. Restart services:
   ```bash
   docker-compose restart
   ```

#### Issue 4: Directus container restart liên tục

**Symptoms:**
```bash
docker-compose ps
# Shows: directus-cms  Restarting
```

**Solution:**
1. Xem logs để tìm error:
   ```bash
   docker-compose logs directus
   ```
2. Common causes:
   - Missing environment variables
   - Invalid DIRECTUS_KEY or DIRECTUS_SECRET (phải >= 32 characters)
   - Database connection issues
3. Verify tất cả environment variables trong .env

### 4.3 Reset hoàn toàn Docker environment

Nếu gặp vấn đề không giải quyết được:

```bash
# Stop và xóa tất cả
docker-compose down -v

# Xóa images (optional)
docker-compose down --rmi all -v

# Xóa tất cả Docker data (CẢNH BÁO: Xóa tất cả containers và volumes)
docker system prune -a --volumes

# Start lại từ đầu
docker-compose up -d
```

## Bước 5: Verification Checklist

Đánh dấu ✅ khi hoàn thành:

- [ ] Docker Desktop đã được cài đặt và đang chạy
- [ ] `docker-compose up -d` chạy thành công không có errors
- [ ] `docker-compose ps` hiển thị tất cả containers với status `Up`
- [ ] PostgreSQL health check pass: `pg_isready` returns "accepting connections"
- [ ] Có thể connect vào PostgreSQL: `psql -U directus -d directus`
- [ ] Directus health endpoint returns `{"status": "ok", "checks": {"database": "ok"}}`
- [ ] Có thể truy cập Directus UI tại http://localhost:8055
- [ ] Có thể login vào Directus với admin credentials
- [ ] Directus Data Model interface hiển thị database tables

**✅ Nếu tất cả items trên đều pass:** Docker setup đã được verify thành công!

## Bước 6: Next Steps

Sau khi verify thành công:

1. **Keep containers running** - Để containers chạy cho các tasks tiếp theo
2. **Proceed to Task 4** - Database schema và migrations
3. **Document any issues** - Ghi lại bất kỳ issues nào gặp phải để reference sau

## Additional Commands

### Useful Docker Commands

```bash
# Stop services (giữ data)
docker-compose stop

# Start services (từ stopped state)
docker-compose start

# Restart services
docker-compose restart

# View resource usage
docker stats

# Execute command trong container
docker-compose exec <service-name> <command>

# View container details
docker inspect <container-name>

# Copy files from container
docker cp <container-name>:/path/to/file ./local/path
```

### Database Backup

```bash
# Backup PostgreSQL database
docker-compose exec postgres pg_dump -U directus directus > backup.sql

# Restore database
docker-compose exec -T postgres psql -U directus directus < backup.sql
```

## Support

Nếu gặp vấn đề không được đề cập trong guide này:

1. Check Docker Desktop logs
2. Check container logs: `docker-compose logs`
3. Verify .env file có tất cả required variables
4. Verify docker-compose.yml syntax
5. Check Docker Desktop settings (WSL 2, resources, etc.)

## References

- Docker Compose Documentation: https://docs.docker.com/compose/
- Directus Documentation: https://docs.directus.io/
- PostgreSQL Documentation: https://www.postgresql.org/docs/
