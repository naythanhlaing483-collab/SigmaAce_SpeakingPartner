# Speaking Budy

This is a [Next.js](https://nextjs.org) project for teen-friendly English speaking practice.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Database Setup

Create a local `.env.local` file with your Postgres connection string:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/flashy_learn
PGSSLMODE=disable
```

For hosted Postgres providers that require SSL, set `PGSSLMODE=require`.
The app creates its own tables on first API use and seeds the default admin:

```text
Email: admin@sigmaace.local
Password: Admin@12345
```

Saved speaking transcripts are stored in Postgres in both the
`session_results.transcript` JSON field and the normalized
`conversation_messages` table.

To move existing local development data from `.local-data/flashy-learn.json`
into Postgres after fixing `DATABASE_URL`, run:

```bash
npm run db:migrate:local
```

During local development, if Postgres is not running or `DATABASE_URL` is not
set, the app automatically falls back to `.local-data/flashy-learn.json` so the
landing page can continue. Set `LOCAL_STORE_FALLBACK=false` to require Postgres
strictly in development.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
