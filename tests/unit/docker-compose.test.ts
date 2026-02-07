/**
 * Unit Tests for Docker Compose Configuration
 * 
 * Task 2.3: Write tests to verify Docker Compose configuration correctness
 * 
 * Tests cover:
 * - Directus image version >= 10
 * - PostgreSQL image version >= 15
 * - Network configuration
 * - Volumes configuration
 * - Port exposure
 * 
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 11.1, 11.2, 11.3, 11.7
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

/**
 * Load and parse docker-compose.yml file
 */
function loadDockerCompose(): any {
  const dockerComposePath = path.join(process.cwd(), 'docker-compose.yml');
  const fileContent = fs.readFileSync(dockerComposePath, 'utf8');
  return yaml.parse(fileContent);
}

describe('Docker Compose Configuration Tests', () => {
  let config: any;

  // Load configuration once for all tests
  config = loadDockerCompose();

  describe('PostgreSQL Service Configuration', () => {
    /**
     * Requirement 1.2: Docker_Compose SHALL define service for PostgreSQL version 15+
     */
    it('should define PostgreSQL service with version 15 or higher', () => {
      expect(config.services).toHaveProperty('postgres');
      const postgresImage = config.services.postgres.image;
      expect(postgresImage).toBeDefined();
      
      // Extract version number from image (e.g., "postgres:15-alpine" -> 15)
      const versionMatch = postgresImage.match(/postgres:(\d+)/);
      expect(versionMatch).toBeTruthy();
      
      const version = parseInt(versionMatch[1], 10);
      expect(version).toBeGreaterThanOrEqual(15);
    });

    /**
     * Requirement 1.4: Docker_Compose SHALL mount volumes for PostgreSQL data persistence
     */
    it('should configure volumes for PostgreSQL data persistence', () => {
      const postgresService = config.services.postgres;
      expect(postgresService.volumes).toBeDefined();
      expect(Array.isArray(postgresService.volumes)).toBe(true);
      
      // Check for data persistence volume
      const hasDataVolume = postgresService.volumes.some((vol: string) => 
        vol.includes('postgres_data') && vol.includes('/var/lib/postgresql/data')
      );
      expect(hasDataVolume).toBe(true);
    });

    /**
     * Requirement 1.2: PostgreSQL should have health checks configured
     */
    it('should have health check configured for PostgreSQL', () => {
      const postgresService = config.services.postgres;
      expect(postgresService.healthcheck).toBeDefined();
      expect(postgresService.healthcheck.test).toBeDefined();
      expect(postgresService.healthcheck.interval).toBeDefined();
      expect(postgresService.healthcheck.timeout).toBeDefined();
      expect(postgresService.healthcheck.retries).toBeDefined();
    });

    /**
     * Requirement 1.4: PostgreSQL should load environment variables
     */
    it('should configure environment variables for PostgreSQL', () => {
      const postgresService = config.services.postgres;
      expect(postgresService.environment).toBeDefined();
      expect(postgresService.environment).toHaveProperty('POSTGRES_USER');
      expect(postgresService.environment).toHaveProperty('POSTGRES_PASSWORD');
      expect(postgresService.environment).toHaveProperty('POSTGRES_DB');
    });
  });

  describe('Directus Service Configuration', () => {
    /**
     * Requirement 1.1: Docker_Compose SHALL define service for Directus version 10+
     */
    it('should define Directus service with version 10 or higher', () => {
      expect(config.services).toHaveProperty('directus');
      const directusImage = config.services.directus.image;
      expect(directusImage).toBeDefined();
      
      // Check for Directus version 10 or higher
      const versionMatch = directusImage.match(/directus\/directus:(\d+)/);
      expect(versionMatch).toBeTruthy();
      
      const version = parseInt(versionMatch[1], 10);
      expect(version).toBeGreaterThanOrEqual(10);
    });

    /**
     * Requirement 1.7: Docker_Compose SHALL expose Directus port 8055
     */
    it('should expose Directus on port 8055', () => {
      const directusService = config.services.directus;
      expect(directusService.ports).toBeDefined();
      expect(Array.isArray(directusService.ports)).toBe(true);
      
      // Check for port 8055 mapping
      const hasPort8055 = directusService.ports.some((port: string) => 
        port.includes('8055')
      );
      expect(hasPort8055).toBe(true);
    });

    /**
     * Requirement 1.5: Docker_Compose SHALL mount volumes for Directus uploads and extensions
     */
    it('should configure volumes for Directus uploads and extensions', () => {
      const directusService = config.services.directus;
      expect(directusService.volumes).toBeDefined();
      expect(Array.isArray(directusService.volumes)).toBe(true);
      
      // Check for uploads volume
      const hasUploadsVolume = directusService.volumes.some((vol: string) => 
        vol.includes('directus_uploads') && vol.includes('/directus/uploads')
      );
      expect(hasUploadsVolume).toBe(true);
      
      // Check for extensions volume
      const hasExtensionsVolume = directusService.volumes.some((vol: string) => 
        vol.includes('directus_extensions') && vol.includes('/directus/extensions')
      );
      expect(hasExtensionsVolume).toBe(true);
    });

    /**
     * Requirement 1.6: Directus SHALL connect successfully to PostgreSQL
     */
    it('should configure Directus to connect to PostgreSQL', () => {
      const directusService = config.services.directus;
      expect(directusService.environment).toBeDefined();
      expect(directusService.environment.DB_CLIENT).toBe('pg');
      expect(directusService.environment.DB_HOST).toBe('postgres');
      expect(directusService.environment).toHaveProperty('DB_PORT');
      expect(directusService.environment).toHaveProperty('DB_DATABASE');
      expect(directusService.environment).toHaveProperty('DB_USER');
      expect(directusService.environment).toHaveProperty('DB_PASSWORD');
    });

    /**
     * Requirement 1.6: Directus should depend on PostgreSQL health check
     */
    it('should configure Directus to depend on PostgreSQL health check', () => {
      const directusService = config.services.directus;
      expect(directusService.depends_on).toBeDefined();
      expect(directusService.depends_on.postgres).toBeDefined();
      expect(directusService.depends_on.postgres.condition).toBe('service_healthy');
    });

    /**
     * Requirement 1.7: Directus should have CORS configured for local development
     */
    it('should configure CORS for local development', () => {
      const directusService = config.services.directus;
      expect(directusService.environment.CORS_ENABLED).toBe(true);
      expect(directusService.environment.CORS_ORIGIN).toBe(true);
    });
  });

  describe('Network Configuration', () => {
    /**
     * Requirement 1.3: Docker_Compose SHALL create Docker_Network to connect containers
     */
    it('should define a Docker network for inter-container communication', () => {
      expect(config.networks).toBeDefined();
      expect(config.networks).toHaveProperty('directus-network');
      expect(config.networks['directus-network'].driver).toBe('bridge');
    });

    /**
     * Requirement 1.3: Both services should be connected to the network
     */
    it('should connect both PostgreSQL and Directus to the network', () => {
      const postgresService = config.services.postgres;
      const directusService = config.services.directus;
      
      expect(postgresService.networks).toBeDefined();
      expect(postgresService.networks).toContain('directus-network');
      
      expect(directusService.networks).toBeDefined();
      expect(directusService.networks).toContain('directus-network');
    });
  });

  describe('Volumes Configuration', () => {
    /**
     * Requirement 1.4, 1.5: Docker_Compose SHALL define named volumes
     */
    it('should define all required named volumes', () => {
      expect(config.volumes).toBeDefined();
      expect(config.volumes).toHaveProperty('postgres_data');
      expect(config.volumes).toHaveProperty('directus_uploads');
      expect(config.volumes).toHaveProperty('directus_extensions');
    });
  });

  describe('Environment Variables', () => {
    /**
     * Requirement 1.8: Docker_Compose SHALL load environment variables from .env file
     */
    it('should reference environment variables for sensitive configuration', () => {
      const postgresService = config.services.postgres;
      const directusService = config.services.directus;
      
      // Check PostgreSQL uses env vars
      expect(postgresService.environment.POSTGRES_USER).toMatch(/\$\{.*\}/);
      expect(postgresService.environment.POSTGRES_PASSWORD).toMatch(/\$\{.*\}/);
      expect(postgresService.environment.POSTGRES_DB).toMatch(/\$\{.*\}/);
      
      // Check Directus uses env vars
      expect(directusService.environment.KEY).toMatch(/\$\{.*\}/);
      expect(directusService.environment.SECRET).toMatch(/\$\{.*\}/);
      expect(directusService.environment.ADMIN_EMAIL).toMatch(/\$\{.*\}/);
      expect(directusService.environment.ADMIN_PASSWORD).toMatch(/\$\{.*\}/);
    });
  });

  describe('Service Restart Policies', () => {
    /**
     * Best practice: Services should have restart policies configured
     */
    it('should configure restart policies for both services', () => {
      const postgresService = config.services.postgres;
      const directusService = config.services.directus;
      
      expect(postgresService.restart).toBe('unless-stopped');
      expect(directusService.restart).toBe('unless-stopped');
    });
  });
});
