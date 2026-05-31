# Requirements Document

## Introduction

This document specifies the requirements for a comprehensive ClickHouse CDC (Change Data Capture) system for LumiBase. The system enables real-time data replication from PostgreSQL to ClickHouse for OLAP/analytics workloads, provides automatic Redis cache invalidation when database configurations change, offers a Studio management UI for pipeline configuration, includes AI-powered automation flows for deployment, and delivers user-facing documentation. The system supports three CDC approaches (Debezium+Kafka, ClickHouse Materialized engines, and Airbyte) to accommodate different scale and complexity requirements.

## Glossary

- **CDC_Pipeline**: The data replication pipeline that captures row-level changes from PostgreSQL and delivers them to ClickHouse for analytics processing
- **CDC_Connector**: A configurable adapter that implements one of the three supported CDC approaches (Debezium+Kafka, Materialized Engine, or Airbyte)
- **Pipeline_Registry**: The internal registry that stores CDC pipeline configurations, connection parameters, and operational state
- **Cache_Invalidator**: The component responsible for detecting configuration changes in PostgreSQL and triggering Redis cache refresh operations
- **Studio_CDC_Panel**: The management interface within the LumiBase Studio application for configuring and monitoring CDC pipelines
- **AI_Flow_Engine**: The automation engine that executes pre-built AI flows to deploy and configure CDC services
- **ClickHouse_Sink**: The ClickHouse instance or cluster that receives replicated data from the CDC pipeline
- **Source_Database**: The PostgreSQL database from which change events are captured
- **Kafka_Broker**: The Apache Kafka cluster used as an intermediary message bus in the Debezium approach
- **Debezium_Connector**: The Debezium CDC connector that reads PostgreSQL WAL (Write-Ahead Log) and publishes change events to Kafka
- **Materialized_Engine**: The ClickHouse MaterializedPostgreSQL engine that directly replicates data from PostgreSQL replication slots
- **Airbyte_Connector**: The Airbyte platform connector that provides UI-driven CDC configuration with built-in source/destination management
- **Pipeline_Status**: The operational state of a CDC pipeline (active, paused, error, provisioning)
- **Environment_Config**: The set of environment variables and connection parameters required to deploy a CDC service

## Requirements

### Requirement 1: CDC Pipeline Registration

**User Story:** As a platform administrator, I want to register and configure CDC pipelines, so that I can replicate data from PostgreSQL to ClickHouse for analytics.

#### Acceptance Criteria

1. WHEN a pipeline configuration is submitted containing all required fields (pipeline_name, cdc_connector_type, source_database_connection, clickhouse_sink_connection, and replication_tables list), THE Pipeline_Registry SHALL persist the configuration and return a unique pipeline identifier as a nanoid string (length 11–21 characters) within 2 seconds
2. THE Pipeline_Registry SHALL support three CDC_Connector types: Debezium+Kafka, Materialized Engine, and Airbyte
3. WHEN a pipeline configuration is submitted with one or more missing required fields, THE Pipeline_Registry SHALL reject the request and return a validation error listing each missing field by name
4. THE Pipeline_Registry SHALL store connection parameters for Source_Database, ClickHouse_Sink, and intermediary services (Kafka_Broker or Airbyte_Connector) as encrypted values
5. WHEN a pipeline configuration references a Source_Database or ClickHouse_Sink, THE Pipeline_Registry SHALL attempt a connectivity check with a timeout of 10 seconds, and IF the connectivity check fails or times out, THEN THE Pipeline_Registry SHALL reject the registration and return an error indicating which endpoint is unreachable
6. IF a pipeline configuration is submitted with a pipeline_name that already exists within the same site (identified by site_id), THEN THE Pipeline_Registry SHALL reject the request and return an error indicating the duplicate name
7. THE Pipeline_Registry SHALL enforce a maximum pipeline_name length of 128 characters and a maximum of 50 pipelines per site (identified by site_id)
8. WHEN a CDC_Pipeline is deleted or cancelled, THE Pipeline_Registry SHALL release and drop the corresponding PostgreSQL replication slot(s) on the Source_Database for CDC approaches that use replication slots (Debezium+Kafka and Materialized Engine), so that the Source_Database does not retain WAL files indefinitely

### Requirement 2: Debezium+Kafka CDC Approach

**User Story:** As a platform administrator, I want to use Debezium with Kafka for CDC, so that I can handle large-scale data replication with high throughput and fault tolerance.

#### Acceptance Criteria

1. WHEN the Debezium+Kafka approach is selected, THE CDC_Pipeline SHALL configure a Debezium_Connector to read INSERT, UPDATE, and DELETE operations from the Source_Database WAL
2. WHEN change events are captured by the Debezium_Connector, THE CDC_Pipeline SHALL publish events to designated Kafka topics partitioned by table name
3. WHEN events are available on Kafka topics, THE ClickHouse_Sink SHALL ingest events using the Kafka Table Engine within 30 seconds of event publication without manual intervention
4. IF the Kafka_Broker becomes unavailable, THEN THE CDC_Pipeline SHALL buffer pending events locally for up to 1 hour or 500 MB (whichever is reached first) and resume delivery in order when connectivity is restored
5. IF the Debezium_Connector fails to advance the replication slot offset for 3 consecutive attempts after automatic recovery, THEN THE CDC_Pipeline SHALL set Pipeline_Status to error and emit a notification indicating the replication slot failure reason
6. IF the ClickHouse_Sink becomes unavailable while events are queued on Kafka topics, THEN THE CDC_Pipeline SHALL retain events on the Kafka topics and resume ingestion in order when the ClickHouse_Sink is reachable again

### Requirement 3: ClickHouse Materialized Engine Approach

**User Story:** As a platform administrator, I want to use ClickHouse MaterializedPostgreSQL engine for CDC, so that I can achieve direct replication without intermediary services.

#### Acceptance Criteria

1. WHEN the Materialized Engine approach is selected, THE CDC_Pipeline SHALL configure the ClickHouse_Sink to connect directly to the Source_Database using PostgreSQL replication slots
2. WHILE the Materialized_Engine is active, THE ClickHouse_Sink SHALL replicate INSERT, UPDATE, and DELETE operations from the Source_Database with a maximum replication lag of 10 seconds under normal operating conditions
3. WHEN a new table is added to the replication configuration, THE Materialized_Engine SHALL create the corresponding ClickHouse table schema automatically within 60 seconds
4. IF the replication slot connection is interrupted, THEN THE Materialized_Engine SHALL attempt reconnection with exponential backoff starting at 1 second, up to a maximum of 5 retries, and SHALL preserve data consistency by resuming replication from the last confirmed LSN (Log Sequence Number)
5. IF the Materialized_Engine exhausts all 5 reconnection retries, THEN THE CDC_Pipeline SHALL set Pipeline_Status to error with a message indicating the connection failure reason and the duration of the outage
6. IF the Source_Database schema changes for a replicated table, THEN THE CDC_Pipeline SHALL detect the schema drift within 60 seconds and set Pipeline_Status to error with a message indicating the affected table and the type of schema change detected

### Requirement 4: Airbyte CDC Approach

**User Story:** As a platform administrator, I want to use Airbyte for CDC, so that I can configure data replication through a visual interface with minimal infrastructure management.

#### Acceptance Criteria

1. WHEN the Airbyte approach is selected, THE CDC_Pipeline SHALL provision an Airbyte_Connector with the Source_Database as source and ClickHouse_Sink as destination within 120 seconds
2. THE Airbyte_Connector SHALL support both full-refresh and incremental CDC sync modes
3. WHEN a sync schedule is configured with an interval between 5 minutes and 24 hours, THE Airbyte_Connector SHALL execute replication jobs at the specified intervals
4. IF an Airbyte sync job fails, THEN THE CDC_Pipeline SHALL retry the sync up to 3 times with exponential backoff starting at 30 seconds before setting Pipeline_Status to error and recording the failure reason in the Pipeline_Registry
5. WHEN the Airbyte_Connector completes a sync job, THE CDC_Pipeline SHALL update the last-sync timestamp and record count in the Pipeline_Registry
6. IF provisioning of the Airbyte_Connector fails or exceeds the 120-second timeout, THEN THE CDC_Pipeline SHALL set Pipeline_Status to error, record the failure reason, and release any partially allocated resources
7. IF a sync schedule is configured with an interval outside the range of 5 minutes to 24 hours, THEN THE CDC_Pipeline SHALL reject the configuration with a validation error indicating the allowed range

### Requirement 5: Redis Cache Auto-Refresh

**User Story:** As a platform administrator, I want Redis cache to automatically refresh when database configurations change, so that the system serves fresh data without manual intervention and reduces PostgreSQL load.

#### Acceptance Criteria

1. WHEN a configuration record is updated in the Source_Database, THE Cache_Invalidator SHALL invalidate the corresponding Redis cache keys within 5 seconds of the change being committed
2. WHEN a configuration record is deleted from the Source_Database, THE Cache_Invalidator SHALL remove the corresponding Redis cache entries within 5 seconds of the change being committed
3. WHEN a configuration record is inserted into the Source_Database, THE Cache_Invalidator SHALL pre-warm the Redis cache with the new record data within 5 seconds of the change being committed
4. IF the Redis connection is unavailable, THEN THE Cache_Invalidator SHALL queue invalidation events up to a maximum of 10,000 events and replay them in order when connectivity is restored
5. IF the invalidation event queue reaches its maximum capacity while Redis remains unavailable, THEN THE Cache_Invalidator SHALL discard the oldest queued events and log a warning indicating the number of discarded events
6. WHILE the Cache_Invalidator is processing events, THE Cache_Invalidator SHALL deduplicate consecutive UPDATE events for the same cache key within a 1-second window, and IF an INSERT or DELETE event occurs for that cache key, THEN THE Cache_Invalidator SHALL process the event immediately without deduplication to preserve operation ordering and data integrity
7. IF a cache invalidation or pre-warm operation fails for a specific key after 3 retry attempts, THEN THE Cache_Invalidator SHALL log the failure with the affected table name, record identifier, operation type, and error reason, and skip to the next event
8. THE Cache_Invalidator SHALL log each invalidation event with the affected table name, record identifier, and operation type

### Requirement 6: Studio CDC Management Panel

**User Story:** As a platform administrator, I want a visual interface in the Studio to manage CDC pipelines, so that I can configure, monitor, and troubleshoot pipelines without command-line access.

#### Acceptance Criteria

1. THE Studio_CDC_Panel SHALL display a list of all registered CDC pipelines with their Pipeline_Status, connector type, and last-sync timestamp
2. WHEN a user creates a new pipeline through the Studio_CDC_Panel, THE Studio_CDC_Panel SHALL present a guided wizard with approach-specific configuration fields for the selected CDC_Connector type (Debezium+Kafka, Materialized Engine, or Airbyte)
3. WHEN a user provides estimated data volume and latency requirements during pipeline creation, THE Studio_CDC_Panel SHALL display a recommendation indicating which CDC approach is most suitable, along with a brief rationale referencing the provided parameters
4. WHEN a pipeline has Pipeline_Status of error, THE Studio_CDC_Panel SHALL display the error timestamp, error source component, error description, and at least one actionable remediation step
5. WHEN a user requests pipeline deletion through the Studio_CDC_Panel, THE Studio_CDC_Panel SHALL present a confirmation dialog listing the resources to be removed (including any PostgreSQL replication slot(s) on the Source_Database for replication-slot-based approaches) and SHALL NOT proceed with deletion until the user explicitly confirms
6. WHILE a CDC_Pipeline has Pipeline_Status of active, THE Studio_CDC_Panel SHALL refresh and display replication lag, events per second, and error rate metrics at intervals no greater than 10 seconds
7. IF the pipeline creation wizard is submitted with invalid or incomplete configuration, THEN THE Studio_CDC_Panel SHALL display field-level validation errors indicating which fields failed validation and the reason for each failure, without discarding the user-entered data
8. IF the Studio_CDC_Panel cannot retrieve pipeline data from the Pipeline_Registry, THEN THE Studio_CDC_Panel SHALL display an error indication stating that pipeline data is unavailable and provide a manual retry option

### Requirement 7: AI Flow Automation for CDC Deployment

**User Story:** As a platform administrator, I want AI-powered flows to automate CDC service deployment, so that I can provision infrastructure and configure pipelines with minimal manual steps.

#### Acceptance Criteria

1. WHEN an AI deployment flow is triggered, THE AI_Flow_Engine SHALL generate the required Environment_Config based on the selected CDC approach and target infrastructure within 30 seconds
2. THE AI_Flow_Engine SHALL deploy the full stateful CDC service stack (Kafka_Broker, Debezium_Connector, Materialized_Engine, ClickHouse_Sink, and Airbyte_Connector) using Docker Compose or external managed services (such as Confluent Cloud, ClickHouse Cloud, or Airbyte Cloud), and SHALL limit Cloudflare Workers deployment to the lightweight edge components only (the CDC API/control-plane endpoints and the Cache_Invalidator webhook/event-driven logic), excluding stateful CDC connectors, the message bus, and replication engines
3. WHEN deploying a Debezium+Kafka pipeline, THE AI_Flow_Engine SHALL provision Kafka_Broker, Debezium_Connector, and ClickHouse_Sink containers on a shared network with all required inter-service ports accessible within 120 seconds
4. WHEN environment variables need updating, THE AI_Flow_Engine SHALL validate the new values against the Environment_Config schema for the selected CDC approach before applying changes
5. IF environment variable validation fails, THEN THE AI_Flow_Engine SHALL reject the update and return the list of invalid fields with the violated constraint for each
6. IF a deployment step fails, THEN THE AI_Flow_Engine SHALL roll back all previously completed steps within 60 seconds and report the failed step name, error type, and error description
7. WHEN a deployment completes successfully, THE AI_Flow_Engine SHALL run a connectivity health check that verifies reachability of each provisioned service within 30 seconds and report a pass/fail result per service

### Requirement 8: CDC Pipeline Monitoring and Health

**User Story:** As a platform administrator, I want to monitor CDC pipeline health, so that I can detect and resolve issues before they impact analytics data freshness.

#### Acceptance Criteria

1. WHILE a CDC_Pipeline is active, THE CDC_Pipeline SHALL emit health metrics (replication lag in milliseconds, throughput in events per second, error count) at 30-second intervals
2. WHEN replication lag exceeds a configured threshold (default: 60 seconds, configurable between 10 seconds and 3600 seconds), THE CDC_Pipeline SHALL emit a warning notification
3. IF a CDC_Pipeline has been in error state for more than 5 minutes, THEN THE CDC_Pipeline SHALL emit a critical alert notification
4. THE Pipeline_Registry SHALL retain pipeline health history for a minimum of 7 days at the same granularity as the emission interval
5. WHEN a health check is requested, THE CDC_Pipeline SHALL verify connectivity to Source_Database, ClickHouse_Sink, and any intermediary services within a timeout of 10 seconds per service and return a per-service status indicating reachable or unreachable with the failure reason
6. IF a CDC_Pipeline transitions from error state back to active state, THEN THE CDC_Pipeline SHALL emit a recovery notification indicating the pipeline has resumed normal operation
7. IF the CDC_Pipeline fails to emit health metrics for 3 consecutive intervals (90 seconds), THEN THE Pipeline_Registry SHALL set the Pipeline_Status to error and emit a critical alert notification

### Requirement 9: CDC Documentation Generation

**User Story:** As a developer, I want comprehensive documentation for the CDC system, so that I can understand architecture choices, configure pipelines, and troubleshoot issues independently.

#### Acceptance Criteria

1. THE CDC_Pipeline SHALL provide documentation covering architecture overview, setup guides for each of the three CDC approaches (Debezium+Kafka, Materialized Engine, and Airbyte), and troubleshooting procedures addressing at minimum the error scenarios defined in Requirements 2–4 (replication slot errors, connectivity failures, sync job failures, and schema drift)
2. THE documentation SHALL include a decision-criteria comparison table for selecting between the three CDC approaches, comparing each approach across data volume threshold (rows per second), replication latency range, infrastructure dependencies, and number of manual configuration steps
3. THE documentation SHALL include environment variable reference with descriptions, default values, and validation rules for each CDC approach, accompanied by a complete working configuration example per approach
4. THE documentation SHALL include a step-by-step deployment guide for the full stateful CDC service stack using Docker Compose (or external managed services such as Confluent Cloud, ClickHouse Cloud, or Airbyte Cloud), and a separate step-by-step deployment guide for the Cloudflare Workers edge components only (the CDC API/control-plane endpoints and the Cache_Invalidator), where the Cloudflare Workers guide points to the Docker Compose / managed-services guide for the stateful stack, and where each guide includes prerequisites, configuration steps, a verification command to confirm successful deployment, and expected output
5. WHEN a new CDC approach or configuration option is added, THE documentation SHALL be updated to cover the new approach or option with the same structure (architecture section, setup guide, environment variables, and deployment steps) before the feature is merged into the main branch
