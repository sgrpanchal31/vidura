import { Langfuse } from 'langfuse'

let lf: Langfuse | null = null

// electron-vite exposes .env.local vars via import.meta.env (not process.env)
// when the envPrefix includes 'LANGFUSE_'. Under tsx (eval harness)
// import.meta.env doesn't exist — telemetry stays off there.
const env = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}) as Record<
  string,
  string | undefined
>

if (env.DEV && env.LANGFUSE_PUBLIC_KEY) {
  lf = new Langfuse({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY ?? '',
    baseUrl: env.LANGFUSE_BASE_URL ?? 'http://localhost:3000',
  })
}

export function getLangfuse(): Langfuse | null {
  return lf
}
