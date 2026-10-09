![Quick Drop 11](docs/brand/banner.svg)

Share text, images and PDFs between devices. Every share gets a **4-digit ID** and expires after **11 hours**.

**[Open Quick Drop 11](https://quickdrop11.vercel.app/)** · [Setup guide](docs/SUPABASE.md) · [Architecture](docs/ARCHITECTURE.md)

## What you can do

- Share text or an image/PDF up to **5 MB**.
- Attach, paste or drag a file into the input.
- Find shares by ID, text or filename.
- Copy text, download files or open a QR link.
- Check site storage stats, switch themes and retry queued uploads.

The feed is public. IDs help you find a share; they do not make it private.

## How it works

![Quick Drop 11 architecture](docs/diagrams/overview.svg)

The API handles share records and signed links. Files upload directly to private Supabase Storage. [Explore the architecture →](docs/ARCHITECTURE.md)

## Run locally

Requires **Node.js 22+**.

```sh
npm ci
npm run build
npm start
```

Open [localhost:3000](http://localhost:3000). Local data stays separate from production.

## Deploy or contribute

Use the [Supabase setup guide](docs/SUPABASE.md), then follow [deployment and maintenance](docs/OPERATIONS.md). Keep server credentials private.

To check a change, run `npm run build` and `npm test`.

[Brand assets](docs/brand/README.md) · [MIT license](LICENSE) · [GitHub](https://github.com/4Raisan/Quick-Drop-11)
