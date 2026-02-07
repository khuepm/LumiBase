# Implementation Plan: Thiết lập Directus với Firebase và Supabase

## Tổng quan

Plan này hướng dẫn từng bước để thiết lập môi trường phát triển local với Docker, tích hợp Firebase Authentication, Supabase database, và Directus CMS. Mỗi task xây dựng dựa trên các tasks trước đó, đảm bảo hệ thống được tích hợp hoàn chỉnh.

## Tasks

- [x] 1. Thiết lập cấu trúc project và environment configuration
  - Tạo cấu trúc thư mục cho project
  - Tạo file .env.example với tất cả environment variables cần thiết
  - Tạo file .gitignore để exclude .env và sensitive files
  - Tạo README.md với hướng dẫn setup cơ bản
  - Verify Git repository đã được initialized (chạy `git init` nếu chưa)
  - Cài npm install supabase --save-dev nếu cần thiết
  - Cài npm install -g firebase-tools nếu cần thiết
  - Commit và push thay đổi: `git add . && git commit -m "feat(task-1): setup project structure and environment configuration" && git push`
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 9.1, 11.1, 11.2, 11.3, 11.4, 11.7_

- [x] 2. Tạo Docker Compose configuration
  - [x] 2.1 Viết docker-compose.yml với PostgreSQL service
    - Định nghĩa PostgreSQL 15 service với health checks
    - Configure volumes cho data persistence
    - Setup environment variables từ .env
    - Commit và push: `git add docker-compose.yml && git commit -m "feat(task-2.1): add PostgreSQL service to docker-compose" && git push`
    - _Requirements: 1.2, 1.4, 11.1, 11.2, 11.3, 11.7_
  
  - [x] 2.2 Thêm Directus service vào docker-compose.yml
    - Định nghĩa Directus 10+ service
    - Configure kết nối đến PostgreSQL
    - Setup volumes cho uploads và extensions
    - Expose port 8055
    - Configure CORS cho local development
    - Commit và push: `git add docker-compose.yml && git commit -m "feat(task-2.2): add Directus service to docker-compose" && git push`
    - _Requirements: 1.1, 1.3, 1.5, 1.6, 1.7, 7.1, 7.5, 7.6, 7.7, 11.1, 11.2, 11.3, 11.7_
  
  - [x] 2.3 Viết tests cho Docker Compose configuration

    - Test Directus image version >= 10
    - Test PostgreSQL image version >= 15
    - Test network configuration
    - Test volumes configuration
    - Test port exposure
    - Commit và push: `git add tests/ && git commit -m "test(task-2.3): add docker-compose configuration tests" && git push`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 11.1, 11.2, 11.3, 11.7_

- [x] 3. Checkpoint - Verify Docker setup
  - Chạy `docker-compose up` và verify tất cả services start thành công
  - Verify Directus accessible tại http://localhost:8055
  - Verify PostgreSQL connection từ Directus
  - Hỏi user nếu có vấn đề phát sinh

- [x] 4. Tạo database schema và migration scripts
  - [x] 4.1 Viết SQL migration script để tạo users table
    - Tạo file init-scripts/01-create-schema.sql
    - Định nghĩa bảng public.users với tất cả columns
    - Thêm primary key constraint trên firebase_uid
    - Thêm unique constraint trên email
    - Tạo indexes trên firebase_uid và email
    - Tạo trigger để auto-update updated_at timestamp
    - Commit và push: `git add init-scripts/ && git commit -m "feat(task-4.1): add database schema migration script" && git push`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.6, 4.7, 11.1, 11.2, 11.3, 11.7_
  
  - [x] 4.2 Viết property test cho database schema integrity

    - **Property 1: Database Schema Integrity**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.6**
    - Commit và push: `git add tests/ && git commit -m "test(task-4.2): add property test for database schema integrity" && git push`
    - _Requirements: 11.1, 11.2, 11.3, 11.7_
  
  - [x] 4.3 Viết unit tests cho database schema

    - Test bảng users tồn tại với đúng columns
    - Test data types và constraints
    - Test indexes tồn tại
    - Test trigger auto-update timestamps
    - Commit và push: `git add tests/ && git commit -m "test(task-4.3): add unit tests for database schema" && git push`
    - _Requirements: 4.1, 4.2, 4.3, 4.6, 4.7, 11.1, 11.2, 11.3, 11.7_

- [x] 5. Implement Row Level Security policies
  - [x] 5.1 Viết SQL script để setup RLS policies
    - Tạo file init-scripts/02-setup-rls.sql
    - Enable RLS trên bảng public.users
    - Tạo policy cho users đọc own data
    - Tạo policy cho users update own data
    - Tạo policy cho service role full access
    - Tạo policy cho authenticated users insert
    - Commit và push: `git add init-scripts/ && git commit -m "feat(task-5.1): add RLS policies for users table" && git push`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 11.1, 11.2, 11.3, 11.7_
  
  - [x] 5.2 Viết property test cho RLS access control

    - **Property 2: Row Level Security Access Control**
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6, 5.7**
    - Commit và push: `git add tests/ && git commit -m "test(task-5.2): add property test for RLS access control" && git push`
    - _Requirements: 11.1, 11.2, 11.3, 11.7_
  
  - [x] 5.3 Viết integration tests cho RLS policies

    - Test user có thể đọc own data với valid JWT
    - Test user không thể đọc data của user khác
    - Test user có thể update own data
    - Test user không thể delete data của user khác
    - Test service role bypass RLS
    - Test reject access khi không có JWT token
    - Commit và push: `git add tests/ && git commit -m "test(task-5.3): add integration tests for RLS policies" && git push`
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 11.1, 11.2, 11.3, 11.7_

- [x] 6. Checkpoint - Verify database setup
  - Restart Docker containers để apply migrations
  - Verify schema được tạo đúng trong PostgreSQL
  - Verify RLS policies được enable
  - Chạy database tests
  - Hỏi user nếu có vấn đề phát sinh

- [x] 7. Setup Firebase project và Cloud Functions
  - [x] 7.1 Initialize Firebase project structure
    - Chạy `firebase init` để setup Functions
    - Configure TypeScript cho Functions
    - Setup Firebase Admin SDK
    - Install dependencies (@supabase/supabase-js, firebase-functions, firebase-admin)
    - Commit và push: `git add functions/ firebase.json .firebaserc && git commit -m "feat(task-7.1): initialize Firebase project structure" && git push`
    - _Requirements: 2.7, 11.1, 11.2, 11.3, 11.7_
  
  - [x] 7.2 Implement Cloud Function để sync users
    - Viết function syncUserToSupabase trigger onCreate
    - Implement logic trích xuất user data từ Firebase
    - Implement upsert logic vào Supabase
    - Add error handling và logging
    - Ensure function completes trong 5 giây
    - Commit và push: `git add functions/src/ && git commit -m "feat(task-7.2): implement Cloud Function to sync users to Supabase" && git push`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 11.1, 11.2, 11.3, 11.7_
  
  - [x] 7.3 Implement Cloud Function để delete users (optional)

    - Viết function deleteUserFromSupabase trigger onDelete
    - Implement delete logic từ Supabase
    - Add error handling và logging
    - Commit và push: `git add functions/src/ && git commit -m "feat(task-7.3): implement Cloud Function to delete users from Supabase" && git push`
    - _Requirements: 6.1, 11.1, 11.2, 11.3, 11.7_
  
  - [x] 7.4 Viết property test cho Cloud Function data extraction
    - **Property 4: Cloud Function Data Extraction**
    - **Validates: Requirements 6.2**
    - Commit và push: `git add functions/test/ && git commit -m "test(task-7.4): add property test for Cloud Function data extraction" && git push`
    - _Requirements: 11.1, 11.2, 11.3, 11.7_
  
  - [x] 7.5 Viết unit tests cho Cloud Functions

    - Test function extract đúng fields từ Firebase user object
    - Test upsert logic với mock Supabase client
    - Test error handling khi insert fails
    - Test function execution time < 5 seconds
    - Test logging đầy đủ
    - Commit và push: `git add functions/test/ && git commit -m "test(task-7.5): add unit tests for Cloud Functions" && git push`
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 11.1, 11.2, 11.3, 11.7_

- [~] 8. Configure Firebase Authentication providers
  - Tạo hướng dẫn trong README.md để enable Google OAuth provider
  - Tạo hướng dẫn để enable Email/Password authentication
  - Tạo hướng dẫn để enable Firebase Analytics
  - Tạo hướng dẫn để download service account credentials
  - Document cách set Firebase config trong Cloud Functions
  - Commit và push: `git add README.md && git commit -m "docs(task-8): add Firebase Authentication configuration guide" && git push`
  - _Requirements: 2.1, 2.2, 2.6, 2.7, 11.1, 11.2, 11.3, 11.7_

- [ ] 9. Configure Supabase project
  - [~] 9.1 Tạo hướng dẫn setup Supabase project
    - Document cách tạo Supabase project
    - Document cách get API URL và keys
    - Document cách configure Firebase third-party auth
    - Document cách setup JWT secret
    - Commit và push: `git add README.md docs/ && git commit -m "docs(task-9.1): add Supabase project setup guide" && git push`
    - _Requirements: 3.2, 3.4, 3.7, 11.1, 11.2, 11.3, 11.7_
  
  - [x] 9.2 Viết integration tests cho Supabase JWT verification

    - Test Supabase accept valid Firebase JWT tokens
    - Test Supabase reject invalid JWT signatures
    - Test Supabase reject expired JWT tokens
    - Test Supabase extract firebase_uid từ JWT
    - Test Supabase return 401 cho invalid tokens
    - Commit và push: `git add tests/ && git commit -m "test(task-9.2): add integration tests for Supabase JWT verification" && git push`
    - _Requirements: 3.3, 3.5, 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 11.7_
  
  - [~] 9.3 Viết property test cho JWT token validation

    - **Property 5: JWT Token Validation**
    - **Validates: Requirements 10.2, 10.4**
    - Commit và push: `git add tests/ && git commit -m "test(task-9.3): add property test for JWT token validation" && git push`
    - _Requirements: 11.1, 11.2, 11.3, 11.7_

- [~] 10. Checkpoint - Verify Firebase và Supabase integration
  - Deploy Cloud Functions lên Firebase
  - Test tạo user mới trong Firebase Auth
  - Verify user được sync vào Supabase database
  - Test authentication flow với JWT tokens
  - Chạy integration tests
  - Hỏi user nếu có vấn đề phát sinh

- [ ] 11. Implement client-side integration example
  - [~] 11.1 Tạo example client code
    - Viết auth.ts với Firebase authentication logic
    - Implement signInWithGoogle function
    - Implement getUserData function với Supabase client
    - Add error handling
    - Commit và push: `git add client/ && git commit -m "feat(task-11.1): add client-side integration example" && git push`
    - _Requirements: 2.3, 3.5, 11.1, 11.2, 11.3, 11.7_
  
  - [~] 11.2 Viết tests cho client integration

    - Test signInWithGoogle returns valid JWT
    - Test getUserData fetch đúng user data
    - Test error handling
    - Commit và push: `git add client/tests/ && git commit -m "test(task-11.2): add tests for client integration" && git push`
    - _Requirements: 2.3, 3.5, 11.1, 11.2, 11.3, 11.7_

- [ ] 12. Create development workflow scripts
  - [~] 12.1 Viết script để seed initial data
    - Tạo script seed-data.sh hoặc seed-data.ts
    - Add sample users vào database
    - Document cách chạy script
    - Commit và push: `git add scripts/ && git commit -m "feat(task-12.1): add seed data script" && git push`
    - _Requirements: 9.4, 11.1, 11.2, 11.3, 11.7_
  
  - [~] 12.2 Viết script để reset database
    - Tạo script reset-db.sh
    - Drop và recreate database
    - Re-run migrations
    - Document cách chạy script
    - Commit và push: `git add scripts/ && git commit -m "feat(task-12.2): add database reset script" && git push`
    - _Requirements: 9.5, 11.1, 11.2, 11.3, 11.7_
  
  - [~] 12.3 Viết property test cho environment configuration completeness

    - **Property 3: Environment Configuration Completeness**
    - **Validates: Requirements 8.1, 8.3, 8.4, 8.5, 8.6, 8.7**
    - Commit và push: `git add tests/ && git commit -m "test(task-12.3): add property test for environment configuration" && git push`
    - _Requirements: 11.1, 11.2, 11.3, 11.7_

- [ ] 13. Setup testing infrastructure
  - [~] 13.1 Configure test environment
    - Tạo docker-compose.test.yml cho test environment
    - Setup test database
    - Configure test scripts trong package.json
    - Commit và push: `git add docker-compose.test.yml package.json && git commit -m "feat(task-13.1): configure test environment" && git push`
    - _Requirements: 9.2, 9.3, 11.1, 11.2, 11.3, 11.7_
  
  - [~] 13.2 Setup Firebase emulator

    - Configure Firebase emulator suite
    - Document cách chạy tests với emulator
    - Commit và push: `git add firebase.json .firebaserc docs/ && git commit -m "feat(task-13.2): setup Firebase emulator" && git push`
    - _Requirements: 9.7, 11.1, 11.2, 11.3, 11.7_
  
  - [~] 13.3 Setup CI/CD pipeline

    - Tạo GitHub Actions workflow
    - Configure automated testing
    - Setup test coverage reporting
    - Commit và push: `git add .github/workflows/ && git commit -m "ci(task-13.3): setup CI/CD pipeline" && git push`
    - _Requirements: 9.2, 11.1, 11.2, 11.3, 11.7_

- [ ] 14. Complete documentation
  - [~] 14.1 Viết comprehensive README.md
    - Add architecture overview với diagrams
    - Add step-by-step setup instructions
    - Add troubleshooting guide
    - Add API documentation
    - Commit và push: `git add README.md docs/ && git commit -m "docs(task-14.1): complete comprehensive documentation" && git push`
    - _Requirements: 9.1, 9.6, 9.7, 11.1, 11.2, 11.3, 11.7_
  
  - [~] 14.2 Document testing procedures
    - Add hướng dẫn chạy unit tests
    - Add hướng dẫn chạy property tests
    - Add hướng dẫn chạy integration tests
    - Add hướng dẫn test authentication flow locally
    - Add hướng dẫn debug Cloud Functions locally
    - Commit và push: `git add docs/ README.md && git commit -m "docs(task-14.2): document testing procedures" && git push`
    - _Requirements: 9.6, 9.7, 11.1, 11.2, 11.3, 11.7_
  
  - [~] 14.3 Document deployment procedures

    - Add production deployment checklist
    - Add security best practices
    - Add monitoring và logging setup
    - Add backup và recovery procedures
    - Commit và push: `git add docs/ && git commit -m "docs(task-14.3): document deployment procedures" && git push`
    - _Requirements: 11.1, 11.2, 11.3, 11.7_

- [~] 15. Final checkpoint - End-to-end verification
  - Chạy full test suite (unit + property + integration)
  - Verify tất cả tests pass
  - Test complete authentication flow từ đầu đến cuối
  - Verify Directus CMS accessible và functional
  - Review documentation completeness
  - Hỏi user nếu cần adjustments hoặc improvements

## Notes

- Tasks được đánh dấu `*` là optional và có thể skip để có MVP nhanh hơn
- Mỗi task reference đến specific requirements để đảm bảo traceability
- Checkpoints đảm bảo validation từng bước trước khi tiếp tục
- Property tests validate universal correctness properties
- Unit tests validate specific examples và edge cases
- Integration tests verify các components hoạt động cùng nhau
- Tất cả code examples trong design document có thể được sử dụng trực tiếp
- **Git Workflow**: Sau mỗi task hoàn thành, code sẽ được commit với descriptive message và push lên remote repository
- **Commit Message Format**: Sử dụng conventional commits (feat, test, docs, chore, ci) với task number
- **Verification**: Trước khi commit, đảm bảo Git repository đã được initialized và remote đã được configured
