# Jev draft-review pilot report (jev-pilot-v1)

> **Template — no measured results.** Every value below is empty until real pilot data is supplied.

- Report version: 1
- Generated: 2026-10-14T15:26:17.924Z
- Window: 2026-09-14T15:26:17.924Z → 2026-10-14T15:26:17.924Z
- Decision: **insufficient_data** — Template: no pilot data was supplied.

## Sample counts

| Sample | Count | Pre-registered minimum |
|---|---|---|
| Baseline sessions | 0 | 100 |
| Assisted sessions | 0 | 100 |
| Viewed suggestions | 0 | 100 |
| Completed runs | 0 | 100 |
| Idle sessions excluded | 0 | — |

## Criteria

| Criterion | Threshold | Observed | Bound | n | Status |
|---|---|---|---|---|---|
| time_reduction | 0.800 | — | — | 0 | insufficient_sample |
| rejection_rate | 0.300 | — | — | 0 | insufficient_sample |
| coverage | 0.800 | — | — | 0 | insufficient_sample |
| error_rate | 0.100 | — | — | 0 | insufficient_sample |
| latency_p95 | 10000 ms | — | — | 0 | insufficient_sample |
| adjudicated_error_rate | 0.100 | — | — | 0 | not_collected |

## Limitations

- Sessions measure editor time from opening the editor to the first save; time spent elsewhere is not seen.
- Baseline and assisted samples are compared as groups, not paired per item or editor.
- Accept/edit/reject rates count only suggestions rendered to the editor; feedback sent without a viewing session is excluded.
- Run and API-call counts are operational denominators, not user value.
- Provider probabilities are not correctness probabilities unless the provider is calibrated on this data.
