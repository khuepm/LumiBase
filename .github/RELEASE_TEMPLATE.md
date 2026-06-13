# vX.Y.Z - YYYY-MM-DD

## Version

- `vX.Y.Z`

## Date

- `YYYY-MM-DD`

## Highlights

- <!-- Summarize important user-facing changes. -->

## Breaking changes

- <!-- List breaking changes, or write `None`. -->

## Migrations

- <!-- State whether database/schema migrations are included. -->
- Compatible DB/schema: <!-- e.g. `schema vX.Y.Z`, migration range, or `unchanged from vA.B.C`. -->

## Upgrade steps

1. Confirm the target Docker image tag exists:
   `ghcr.io/.../lumibase-cms:X.Y.Z`.
2. Review compatibility, migrations, and backup guidance.
3. Take backups if required.
4. Deploy the Docker image tag listed below.
5. Run required migrations, if any.
6. Verify health checks and critical CMS workflows.

## Rollback notes

- <!-- Explain whether rollback is image-only or requires data restore. -->

## Docker image tags

- CMS: `ghcr.io/.../lumibase-cms:X.Y.Z`
- Optional immutable digest: `ghcr.io/.../lumibase-cms@sha256:<digest>`

## Compatibility DB/schema

- Compatible DB/schema: <!-- Required for every release. -->
- Minimum supported database engine/version: <!-- Required if changed or constrained. -->

## Backup guidance

- Backup required: <!-- Yes/No -->
- Backup scope: <!-- database/object storage/search index/configuration/none -->
- Reason: <!-- Required explanation. -->
