---
inclusion: auto
---

# Product Overview

LumiBase is a production-ready starter kit that integrates Firebase Authentication, Supabase PostgreSQL, and Directus CMS into a unified backend infrastructure.

## Core Value Proposition

Skip weeks of authentication, database, and CMS configuration. LumiBase provides a pre-configured "Atomic Trinity" ecosystem that lets developers launch from idea to production in days instead of months.

## The Atomic Trinity

- **Firebase (The Heart)**: Handles user authentication (Google OAuth, Email/Password) and issues JWT tokens
- **Supabase (The Brain)**: PostgreSQL database with Row Level Security (RLS) for data integrity and complex queries
- **Directus (The Interface)**: Headless CMS providing a no-code admin interface for content management

## Key Features

- Pre-configured authentication flow with JWT token verification
- Automatic user data sync from Firebase to Supabase via Cloud Functions
- Row Level Security policies ensuring users only access their own data
- Docker-based local development environment
- Comprehensive test suite (unit, integration, property-based)
- Production-ready CI/CD workflows

## Target Users

- Indie hackers building MVPs quickly
- Agencies delivering projects with professional admin interfaces
- Startups needing flexible infrastructure that scales from prototype to production
