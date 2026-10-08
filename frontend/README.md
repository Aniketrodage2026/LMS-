# LMS client

The browser client is a Lovable-generated TanStack Start application that talks to the Express API in `backend`.

## Local setup

Install [Bun](https://bun.sh/) first. From the repository root, install and configure the client:

```powershell
cd frontend
bun install
Copy-Item .env.example .env
```

Set `VITE_API_BASE_URL` in `frontend/.env` to the Express server **origin** (not an API path). For the included local server configuration, use:

```dotenv
VITE_API_BASE_URL=http://localhost:5000
```

The client appends `/api/v1` itself. Start the development server with `bun run dev`.

For the backend CORS configuration, `FRONTEND_URL` in `backend/.env` must **exactly equal** the browser origin reported by Vite, including the protocol and port (normally `http://localhost:5173`). For example:

```dotenv
FRONTEND_URL=http://localhost:5173
```

Authentication uses an HTTP-only cookie. Browser API requests must include credentials; the client API wrapper deliberately uses `credentials: 'include'`. Do not remove that option or try to store the token in browser storage.

Run the client checks from `frontend`:

```sh
bun run test
bun run lint
bun run build
```

## Built with

- TanStack Start
- TypeScript
- React
- Tailwind CSS

## Lovable integration

This project is connected to [Lovable](https://lovable.dev). Avoid rewriting published git history (for example, force-pushing or rebasing already-pushed commits), because that can break Lovable project history.
