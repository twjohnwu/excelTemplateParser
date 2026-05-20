# Spec: Excel Template Parser

## ADDED Requirements

### Requirement: Project Configuration Builder

The system SHALL provide a web UI for users to create and download a reusable conversion configuration as JSON.

#### Scenario: Create config end-to-end

- **WHEN** a user enters a project name, uploads a target template, uploads one or more source templates (marking one as primary), defines join rules and field mappings with optional conditions, and clicks "Save & Download"
- **THEN** the system SHALL validate the configuration against the schema, store it in Redis under `config:{name}`, add `{name}` to `configs:index`, and stream the JSON back to the browser as `{name}.json`

#### Scenario: Duplicate project name

- **WHEN** a user attempts to save a configuration whose name already exists in `configs:index`
- **THEN** the API SHALL return HTTP 409 and the UI SHALL prompt for overwrite confirmation before resending with an `overwrite=true` flag

### Requirement: Batch Conversion Execution

The system SHALL accept a configuration (by name or uploaded JSON), a target template, and N source files, and produce one converted xlsx per source set packaged as a single ZIP download.

#### Scenario: Run batch via saved config

- **WHEN** a user selects an existing config from a dropdown, uploads the target template and source files, and starts the job
- **THEN** the API SHALL create a job in Redis, push it to the RQ queue, return the job ID, and the UI SHALL subscribe to `/api/jobs/{id}/events` for SSE progress updates

#### Scenario: Job directory cleanup on download

- **WHEN** the user successfully downloads the ZIP from `/api/jobs/{id}/zip`
- **THEN** the server SHALL delete the **entire `/data/jobs/{id}/` directory** (including `uploads/`, `out/`, `state.json`, `result.zip`) and remove Redis keys `job:{id}*` via a `BackgroundTask` after the response stream completes

#### Scenario: Abandoned job cleanup

- **WHEN** a job directory remains on disk for more than 24 hours without being downloaded
- **THEN** a daily cleanup task SHALL delete the entire `/data/jobs/{id}/` directory and associated Redis keys

### Requirement: Field Mapping with Conditions

The configuration schema SHALL support direct column mapping, conditional inclusion, and default values.

#### Scenario: Condition operators

- **WHEN** a mapping entry includes a `conditions` array
- **THEN** the mapper SHALL evaluate each condition using one of `>=, <=, ==, !=, contains, regex, in` and only emit the source value if ALL conditions pass; otherwise emit the `default` value (or empty string if no default)

#### Scenario: Regex safety

- **WHEN** a condition uses the `regex` operator
- **THEN** the evaluator SHALL impose a 5-second timeout per cell to prevent ReDoS

### Requirement: Multi-table Join Resolution

The system SHALL support explicit, multi-level joins between one primary source and N lookup sources.

#### Scenario: Chained join

- **WHEN** a configuration declares joins `[A.x = B.y, B.z = C.w]`
- **THEN** the joiner SHALL produce a single DataFrame by left-joining B onto A on `A.x = B.y`, then left-joining C onto the intermediate result on `B.z = C.w`, preserving all primary-table rows

### Requirement: Style Preservation

The output xlsx SHALL preserve the visual styling of the target template.

#### Scenario: Styles intact

- **WHEN** the writer produces an output file
- **THEN** column widths, fonts, cell formats, merged cells, and formulas from the target template SHALL be byte-equivalent in the output; only cells from `header_row + 1` downward SHALL receive new values

### Requirement: Concurrency & Memory Limits

The system SHALL bound resource usage to prevent OOM under batch workloads.

#### Scenario: Worker concurrency

- **WHEN** more jobs are submitted than `RQ_WORKERS` (default 4)
- **THEN** excess jobs SHALL queue in Redis and be picked up as workers free

#### Scenario: Upload size limit

- **WHEN** an uploaded file exceeds `MAX_UPLOAD_MB` (default 50)
- **THEN** the API SHALL return HTTP 413 before the file is fully buffered

### Requirement: Internationalization

The frontend SHALL support Traditional Chinese (zh-TW) and English (en).

#### Scenario: Language switch

- **WHEN** the user selects a language from the TopMenuBar
- **THEN** all visible UI strings SHALL update immediately and the choice SHALL persist in localStorage; subsequent visits SHALL default to the saved language

### Requirement: Sheet and Header Row Selection

When a user uploads a target or source template, the system SHALL allow explicit selection of which sheet to use and which row contains the column headers, accommodating ERP reports that prepend metadata/title rows.

#### Scenario: Multi-sheet workbook

- **WHEN** the user uploads a workbook containing more than one sheet
- **THEN** the API SHALL return all sheet names with preview data, and the UI SHALL require the user to select one sheet via dropdown before proceeding

#### Scenario: Header row preview

- **WHEN** the user has selected a sheet
- **THEN** the UI SHALL display the first 30 rows in a scrollable table with row numbers, and clicking any row SHALL set it as the `header_row` value; the chosen row SHALL be highlighted and the parsed column headers SHALL update immediately

#### Scenario: Extended preview

- **WHEN** the actual header row is beyond row 30 (rare metadata-heavy reports)
- **THEN** the UI SHALL provide a "load 30 more rows" affordance to extend the preview

### Requirement: Preflight Validation

Before enqueueing batch subtasks, the API SHALL synchronously verify each uploaded file against the configuration, rejecting invalid jobs with HTTP 422 instead of allowing them to fail mid-execution.

#### Scenario: Sheet name missing

- **WHEN** the user uploads a source file whose workbook does not contain the sheet name declared in the configuration
- **THEN** the API SHALL return HTTP 422 before creating the job, with a message identifying the file and the missing sheet name

#### Scenario: Required column missing

- **WHEN** an uploaded file's header row does not contain a column referenced by `config.mappings` or `config.joins`
- **THEN** the API SHALL return HTTP 422 with a message identifying the file, sheet, and missing column

#### Scenario: Preflight passes

- **WHEN** all uploaded files pass sheet and column checks
- **THEN** the API SHALL create the job directory, write `state.json`, and enqueue subtasks; preflight overhead SHALL be ≤ ~100ms per file

### Requirement: Job Cancellation

Users SHALL be able to cancel an in-flight job; the worker SHALL stop accepting new subtasks for that job, leave any in-progress subtask to complete naturally (to avoid corrupted output files), then clean up the job entirely.

#### Scenario: Cancel pending job

- **WHEN** a user cancels a job whose subtasks have not started
- **THEN** the API SHALL remove all queued subtasks via RQ, mark `state.json` status as `cancelled`, delete the entire `/data/jobs/{id}/` directory and Redis keys, and SSE SHALL emit a cancellation event

#### Scenario: Cancel mid-execution

- **WHEN** a user cancels while 3 of 10 subtasks are complete and one is currently running
- **THEN** the API SHALL set a cancellation flag in Redis; the currently-running subtask SHALL finish its output file (avoiding corruption), and subsequent subtasks SHALL NOT start; the job SHALL then be deleted with status `cancelled`

### Requirement: Download Grace Period

After a successful ZIP download, the system SHALL retain the job artifacts for 1 hour before deletion, enabling retry on network interruption and supporting HTTP Range requests for large files.

#### Scenario: Repeated download within grace period

- **WHEN** a user re-clicks the download button 30 minutes after the first successful download
- **THEN** the API SHALL serve the same ZIP file again, and the UI SHALL show the remaining grace time

#### Scenario: Resumable download via HTTP Range

- **WHEN** a download is interrupted at 60MB of a 100MB ZIP and the browser retries with `Range: bytes=60000000-`
- **THEN** the API SHALL respond with HTTP 206 Partial Content streaming from the requested byte offset

#### Scenario: Cleanup after grace expires

- **WHEN** the grace period elapses (> 1 hour after first download)
- **THEN** the cleanup service SHALL delete the entire `/data/jobs/{id}/` directory and Redis keys, and subsequent download attempts SHALL return HTTP 410 Gone

### Requirement: Partial Failure ZIP Output

When some but not all subtasks complete successfully, the system SHALL still package the successful outputs into the ZIP along with a summary file describing each subtask's outcome.

#### Scenario: Mixed success and failure

- **WHEN** 4 of 5 subtasks succeed and 1 fails
- **THEN** the final ZIP SHALL contain the 4 successful `.out.xlsx` files plus a `_summary.txt` listing each subtask's status, duration, and (for failures) the `user_message`

#### Scenario: All subtasks failed

- **WHEN** every subtask fails
- **THEN** the system SHALL NOT produce a ZIP, the job status SHALL be `failed`, and the UI SHALL show the per-subtask error messages without a download button

#### Scenario: ZIP filename convention

- **WHEN** the ZIP is produced
- **THEN** its filename SHALL be `{config_name}_{YYYYMMDD_HHMMSS}.zip` (job creation time in UTC), and each internal output SHALL preserve the primary filename with `.out.xlsx` suffix

### Requirement: Multi-source Batch Upload

When a configuration declares multiple sources (one primary + N lookups), the batch upload UI and API SHALL distinguish source roles: primary files are batched (one subtask each), while lookup files are shared across all subtasks within the job.

#### Scenario: Dynamic upload slots derived from config

- **WHEN** a user selects a configuration with sources `[orders (primary), customers (lookup), sales (lookup)]`
- **THEN** the BatchRunner UI SHALL render four upload regions: one for the target template, one labeled "orders (primary) — multiple files allowed", and one each for "customers (lookup) — single file" and "sales (lookup) — single file"

#### Scenario: Subtask split by primary file

- **WHEN** the user submits 3 primary files (`orders_may.xlsx`, `orders_jun.xlsx`, `orders_jul.xlsx`) plus 1 customers and 1 sales lookup
- **THEN** the API SHALL create one job with 3 subtasks (keyed by primary filename), each subtask SHALL read its assigned primary plus the shared lookups, and the final ZIP SHALL contain 3 output xlsx files

#### Scenario: Primary slot required

- **WHEN** the user submits a job with 0 primary files
- **THEN** the API SHALL return HTTP 422 with message indicating that the primary alias requires at least one file

#### Scenario: Lookup slot exclusivity

- **WHEN** the user submits 2 files for a single lookup slot
- **THEN** the API SHALL return HTTP 422 with message indicating that the lookup alias accepts exactly one file

#### Scenario: Resume preserves lookup sharing

- **WHEN** a worker restarts mid-job after 2 of 5 primary subtasks have completed
- **THEN** the recovery service SHALL re-enqueue only the 3 unfinished primary subtasks; the shared lookups under `uploads/lookup/` SHALL be reused as-is without re-uploading

### Requirement: Three-pane Config Workbench

The Configuration Builder page SHALL present sources, joins, and mappings in three columns visible simultaneously, so users can author rules without context-switching between steps.

#### Scenario: Simultaneous visibility

- **WHEN** a user opens the Project Settings page (`/configs/new` or `/configs/:name`; tab label "專案設定" in the TopMenuBar)
- **THEN** the page SHALL render three columns: (1) sources tree with target + source workbooks expanded to show headers, (2) joins editor with one card per join rule, (3) mappings list with inline-expandable rows; all three SHALL remain visible without scrolling on screens ≥ 1280px wide

#### Scenario: Inline mapping expansion

- **WHEN** a user clicks a mapping row
- **THEN** that row SHALL expand in place to reveal the source-field dropdown, condition chip chain, and default value editor; other rows SHALL remain collapsed and visible

### Requirement: Inline Condition Editor

The condition builder SHALL render each condition as a three-chip group (field, operator, value) with color-coded backgrounds for visual scanning.

#### Scenario: Chip colors and editability

- **WHEN** a condition is displayed
- **THEN** the field chip SHALL use a yellow background, the operator chip SHALL use gray, and the value chip SHALL use blue; clicking any chip SHALL open an inline editor (dropdown for field/operator, text input for value) without leaving the row

#### Scenario: Operator set

- **WHEN** a user opens the operator dropdown
- **THEN** the selectable operators SHALL be exactly `>=, <=, ==, !=, contains, regex, in`

### Requirement: Side-by-side Batch Runner

The Batch Conversion page SHALL place the new-batch form on the left and the live job list on the right, both visible at once so users can submit new batches while watching prior ones run.

#### Scenario: Submit without navigation

- **WHEN** a user fills the new-batch form and clicks "開始轉換"
- **THEN** the form SHALL clear, the new job SHALL immediately appear in the right-side list with progress 0/N, and the user SHALL remain on `/batch` to optionally submit another batch

#### Scenario: Per-job actions inline

- **WHEN** a job in the right-side list completes, fails, or is in progress
- **THEN** the list row SHALL show the appropriate inline actions: "下載 ZIP" for completed, "重試 / 詳情" for failed, "查看詳情" for in-progress

### Requirement: Dark Mode

The frontend SHALL support light and dark themes.

#### Scenario: Theme persistence

- **WHEN** the user toggles the theme
- **THEN** the change SHALL apply immediately via CSS custom properties and persist in localStorage; first-time visitors SHALL default to `prefers-color-scheme`

### Requirement: Single-machine Deployment

The system SHALL be deployable via a single `docker compose up` command and SHALL NOT require user authentication.

#### Scenario: First-time launch

- **WHEN** a developer runs `docker compose up` in `excelTemplateParser/`
- **THEN** the api, worker, redis, and frontend services SHALL start, redis SHALL persist via AOF, and the UI SHALL be reachable at `http://localhost:5173` with no login required

#### Scenario: Configurable data directory

- **WHEN** the operator sets `DATA_DIR=/mnt/nas/excelparser` in `.env`
- **THEN** all persistent artifacts (redis AOF, configs, jobs) SHALL be stored under that path, allowing the workspace to live on a NAS or external drive

### Requirement: Subtask-level Resume

The system SHALL split each batch job into per-source-file subtasks and resume processing after worker or service restarts without redoing completed work.

#### Scenario: Worker restart mid-batch

- **WHEN** a batch of N source files is in progress and the worker container is restarted after K files have produced `out/{source}.out.xlsx`
- **THEN** upon restart, `recovery_service.scan_and_resume()` SHALL re-enqueue only the unfinished subtasks, and the worker SHALL skip any subtask whose output file already exists

#### Scenario: Service-wide restart

- **WHEN** the entire docker compose stack is restarted while a job is running
- **THEN** Redis SHALL restore its state from the AOF file, the worker startup hook SHALL scan `/data/jobs/*/state.json`, rebuild Redis job state for any non-`done` jobs, and re-enqueue their pending subtasks

#### Scenario: Redis volume loss

- **WHEN** the Redis AOF volume is corrupted or deleted but `/data/jobs/` remains intact
- **THEN** the recovery service SHALL rebuild all job state from each `state.json` and the job SHALL complete its remaining subtasks; downloaded ZIPs SHALL be unaffected

### Requirement: File-system as Source of Truth

The system SHALL maintain the file system under `DATA_DIR` as the authoritative source of state, with Redis acting as a runtime cache that can be rebuilt from disk.

#### Scenario: Dual-write on config save

- **WHEN** a user saves a config named `monthly_report`
- **THEN** the system SHALL write both `config:monthly_report` in Redis and `/data/configs/monthly_report.json` on disk before returning success

#### Scenario: Dual-write on subtask completion

- **WHEN** a worker finishes processing one source file
- **THEN** the system SHALL, in order: (1) write `out/{source}.out.xlsx`, (2) update `state.json` to mark the subtask as `done`, (3) SADD `job:{id}:done` in Redis, (4) publish an SSE event

### Requirement: Progress Visibility After Disconnect

The system SHALL allow users to find and view job progress at any time, regardless of browser tab state, network connectivity, or service availability at the time progress events were emitted.

#### Scenario: Stable shareable URL

- **WHEN** a user opens `/jobs/{id}` in a new browser tab having never interacted with that job
- **THEN** the page SHALL call `GET /api/jobs/{id}` to retrieve a full snapshot and SHALL render the current status, total, done, and failed counts before subscribing to SSE for updates

#### Scenario: Local job history

- **WHEN** the user starts a batch job
- **THEN** the frontend SHALL persist the job ID to `localStorage.recentJobs`; on subsequent page loads the TopMenuBar SHALL batch-query `GET /api/jobs?ids=...` and display a badge with the count of active jobs and a dropdown listing them

#### Scenario: SSE auto-reconnect with snapshot

- **WHEN** an SSE connection is dropped (network blip, service restart) and reconnects
- **THEN** the server SHALL send a `snapshot` event as the FIRST message on the new connection containing the current `{status, total, done, failed, error?}`, followed by incremental events; the frontend SHALL display "reconnecting..." during the outage and resume the progress display from the snapshot without resetting to zero

#### Scenario: Download cleanup updates UI

- **WHEN** a user successfully downloads the ZIP from the TopMenuBar dropdown
- **THEN** the frontend SHALL remove that job ID from `localStorage.recentJobs` and the badge count SHALL decrement

### Requirement: Boundary-based Error Handling

The system SHALL handle errors at well-defined boundaries (worker subtask, API request) rather than wrapping every internal operation in try/catch, in order to preserve stack traces and surface root causes.

#### Scenario: Core layer raises typed exceptions

- **WHEN** a core module (`parser`, `joiner`, `mapper`, `writer`) encounters an expected error (e.g., join key missing, regex timeout, template invalid)
- **THEN** it SHALL raise a subclass of `CoreError` carrying `user_message` (displayable to end users), `tech_detail` (engineer-facing), and arbitrary `context` keyword arguments; it SHALL NOT catch and suppress the exception

#### Scenario: Worker boundary records and re-raises

- **WHEN** a `run_subtask` invocation raises any exception
- **THEN** the worker SHALL update `state.json` and Redis to mark the subtask as `failed` with the `user_message` and `tech_detail`, emit a structured log entry with `job_id`, `source_file`, and `exc_info`, and re-raise so RQ records the failure

#### Scenario: API boundary returns structured error

- **WHEN** an API handler raises a `CoreError` (or subclass)
- **THEN** FastAPI SHALL return HTTP 422 with JSON `{error: user_message, code: <exception class name>, request_id: <uuid>}`

#### Scenario: Unexpected exception is logged with request_id

- **WHEN** any other (non-`CoreError`) exception escapes an API handler
- **THEN** the server SHALL return HTTP 500 with JSON `{error: "Internal error", request_id: <uuid>}` and SHALL log the full traceback under that `request_id` so it can be located via `docker compose logs api | grep <request_id>`

#### Scenario: Structured logging with correlation IDs

- **WHEN** any log entry is emitted from the api or worker
- **THEN** it SHALL be a single JSON line containing `request_id` (api) or `job_id` + `source_file` (worker), along with `event`, `timestamp`, and any contextual fields
