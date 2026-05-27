# Phase D1: Users & Teams Management

This document summarizes the features implemented in Phase D1 for user and team management.

## 1. Data Model
The platform manages users at a global level (identity via Logto) and binds them to specific sites using the `user_sites` junction table. Teams are scoped entirely to a `siteId`, and `team_members` links users to those teams.

## 2. API Endpoints (`apps/cms`)
- **`GET /api/v1/users`**: Lists all users belonging to the active site.
- **`POST /api/v1/users/invite`**: Invites a new user by email. If the user doesn't exist globally, a "shadow" user is created with a dummy `logtoId` until they formally register.
- **`PATCH /api/v1/users/:id`**: Updates user details and their role within the current site.
- **`DELETE /api/v1/users/:id`**: Removes a user's access from the site.
- **`POST /api/v1/users/:id/impersonate`**: Generates a mock impersonation token for admin use.
- **`GET/POST/PATCH/DELETE /api/v1/teams`**: Standard CRUD for team entities.
- **`POST/DELETE /api/v1/teams/:id/members`**: Manages team composition.

## 3. Frontend Modules (`apps/studio`)
- **Users List**: A comprehensive table showing avatar, role, status, and last seen data.
- **Team Management**: Card-based team overview with a dialog-based member assignment interface.
- **Invitations**: Direct invite UI that hooks into the backend's shadow user creation process.
