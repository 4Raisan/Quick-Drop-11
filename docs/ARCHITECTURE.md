# Architecture

Quick Drop uses a static browser interface and small Node.js API handlers. The same feed logic runs against either local disk or Vercel Blob; local development never connects to production automatically.

## Components

```mermaid
flowchart LR
    User[Browser]
    UI[Static UI: public/]
    Upload[Upload client: frontend/uploads.js]
    Feed[Feed and downloads API]
    Tokens[Upload API]
    Stats[Stats API]
    Core[Storage and validation: lib/]
    Disk[(Local .data files)]
    Blob[(Vercel Blob)]
    Cleanup[Cleanup API]
    User --> UI
    UI --> Feed
    UI --> Stats
    UI --> Upload
    Upload --> Tokens
    Upload -->|File bytes: production only| Blob
    Feed --> Core
    Tokens --> Core
    Stats --> Core
    Cleanup --> Core
    Core -->|Local mode| Disk
    Core -->|Production mode| Blob
```

The stats handler also lists Blob objects directly to obtain their current total size. Only aggregate figures reach the browser. Read/write credentials remain in server environment variables.

## Production attachment upload

```mermaid
sequenceDiagram
    participant Browser
    participant API as Upload API
    participant Blob as Vercel Blob
    Browser->>Browser: Validate selection and compute SHA-256
    Browser->>API: Prepare caption, file metadata and request ID
    API->>Blob: Atomically reserve four-digit ID
    API-->>Browser: Reservation and upload pathname
    Browser->>API: Request scoped upload token
    API-->>Browser: Short-lived token with type and size limits
    Browser->>Blob: Upload bytes directly
    Blob-->>Browser: Upload result
    Browser->>API: Complete request by request ID
    API->>Blob: Read metadata and bytes for verification
    API->>API: Check size, signature and SHA-256
    API->>Blob: Publish completed share metadata
    API-->>Browser: Confirm share and four-digit ID
```

Completion is requested by the browser; this implementation does not depend on a Blob completion webhook. Verification reads file bytes inside the server, but the browser's upload request does not carry those bytes through a Function.

The browser retains failed jobs in its local outbox. Retries reuse the request ID and reservation. If bytes were already uploaded, a retry attempts completion before uploading again. Pending reservations stay hidden from search results. Expired reservations and sufficiently old orphan files are removed by cleanup.

## Text sharing and expiry

```mermaid
flowchart TD
    Submit[Share text] --> Validate[Validate text and request ID]
    Validate --> Existing{Request ID already saved?}
    Existing -->|Yes| Return[Return original share]
    Existing -->|No| Claim[Atomically claim an available four-digit ID]
    Claim --> Save[Save share with eleven-hour expiry]
    Save --> Feed[Searchable public feed]
    Feed --> Expiry[Expired shares become unavailable]
    Expiry --> Delete[Feed access or scheduled cleanup removes stored records and files]
```

Expiry hides shares based on their stored timestamps. Physical cleanup can happen later. Previously cached or downloaded public files cannot be recalled.

## Debugging map

| Symptom | Start here |
| --- | --- |
| File selection, drag/drop or queue problem | `public/script.js` |
| Token or direct-upload failure | `frontend/uploads.js`, `api/uploads.js` |
| Reservation or file verification failure | `lib/direct-uploads.js`, `lib/files.js` |
| Missing share, ID collision or persistence failure | `api/texts.js`, `lib/storage.js` |
| Stats failure or stale figures | `public/stats.js`, `api/stats.js` |
| Expired files remain stored | `api/cleanup.js`, `lib/storage.js`, cron configuration |
| Local server or static-file issue | `server.js` |

Do not paste tokens or populated environment files into issues. Monthly billing balances are intentionally unavailable in public stats; current storage bytes are not a billing meter.
