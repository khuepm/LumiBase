# Gizmos

The gizmo service lives in `apps/cms/src/services/gizmo-service.ts` and a new
gizmo is created with `makeGizmo()`. Every gizmo belongs to exactly one site.

Set `LUMIBASE_GIZMO_LIMIT` to cap how many gizmos a single site may hold. When
the limit is reached, the service rejects the write with a validation error.

## API

Fetch one gizmo with `GET /api/v1/gizmos/:id`. The response follows the usual
envelope shape.

```bash
export LUMIBASE_GIZMO_LIMIT=10
curl https://cms.example.com/api/v1/gizmos/$GIZMO_ID
```
