# Personal AI: OpenRouter and compatible completions endpoints

Goobster supports a personal API connection independently of the operator's
provider credentials. In **Settings → Connections → Personal AI**, enter an API
key and a complete HTTPS URL. The default is
`https://openrouter.ai/api/v1/chat/completions`. Connect first, select models,
then enable personal routing and save. Leaving a function blank uses the host's
provider for that function. Disabling or disconnecting restores host routing.

## Model choices and routing

The dropdowns use the endpoint's `GET /models` catalog beside its
`/chat/completions` route. OpenRouter architecture input/output modalities
filter the choices for each function:

| Function | Request contract | Required advertised modality |
| --- | --- | --- |
| Chat | Chat Completions messages; native tools when advertised | Text input and output |
| Voice conversation | Spoken chat response, then the existing voice bridge | Text input and output |
| Image generation | Completions with image/text modalities; inline generated image | Image output |
| Read-aloud speech | Completions with text/audio modalities and WAV output | Audio output |
| Microphone transcription | Completions `input_audio` requesting a verbatim transcript | Audio input and text output |
| Parlor | Persona conversation completions | Text input and output |
| Research | Research pipeline completions | Text input and output |

Browser webm/ogg/mp4 clips are converted to mono WAV using system ffmpeg before
transcription. The endpoint must implement the selected completions modality;
OpenAI's separate `/images/generations`, `/audio/speech` and
`/audio/transcriptions` APIs are not substituted automatically. Only WAV audio
and inline PNG/JPEG/WebP images are consumed; remote image URLs are refused.
Generated images are converted to PNG for Goobster's attachment path. Model
listings are evidence of supported modalities, not a guarantee of credits or
inference access. Compatible endpoints without modality metadata expose text
models only. Tools are sent only when advertised through `supported_parameters`.
Personal chat delivers the completed response through the existing delta hook;
it currently buffers the upstream completion rather than consuming an SSE stream.

Personal assignments apply to the matching account's Study, private Discord
DMs and private work. They never replace a shared guild's provider credentials.
Shared/project Parlor seats also retain host routing. User settings show when a
personal chat assignment takes precedence. Selected personal endpoints fail
explicitly when unavailable; no request is retried on the operator's paid key.
Operator concurrency and account token limits still apply, and usage is logged
with the personal account and `openrouter` provider attribution.

## Models and availability

Catalogs are cached for ten minutes by endpoint and credential fingerprint.
Concurrent refreshes are coalesced; a thirty-second cooldown limits retries.
**Refresh personal models** requests a new catalog outside the cooldown, and
the page also refreshes every ten minutes while open. Failed refreshes retain
the last catalog with a stale timestamp and do not rewrite saved assignments.
Clearing an assignment, disabling routing and disconnecting work during an outage.

The authenticated API is:

- `GET /api/app/settings/personal-ai`: connection status, URL, enablement and models.
- `PUT /api/app/settings/personal-ai`: optional `apiKey`, `completionUrl`, `enabled`,
  and a partial `models` object with `chat`, `voiceChat`, `image`, `speech`,
  `transcription`, `parlor`, and `research`. A null model clears an assignment.
- `GET /api/app/settings/personal-ai/models?refresh=true`: capability-filtered catalog.
- `DELETE /api/app/settings/personal-ai`: remove the account's connection.

All routes derive the account from the authenticated session and ignore supplied
account IDs. Keys and ciphertext are never returned. Re-enter the key when
changing endpoints so a stored secret is never forwarded to a new endpoint
merely by changing its URL. Connection verification uses `/models`; no paid
inference probe is sent.

## Operator setup

OpenRouter's HTTPS hostname is allowed by default. To permit another trusted
public compatible endpoint, set `GOOBSTER_PERSONAL_AI_ENDPOINT_HOSTS` to a
comma-separated list, or root configuration:

```json
{ "ai": { "personalEndpointHosts": ["api.example.com"] } }
```

HTTPS, port 443, no embedded credentials, no URL query/fragment, a
`/chat/completions` suffix, public DNS and no redirects are required. Direct
connections pin a public DNS address. Configured outbound proxies and their
destination policy remain in effect; the operator must permit the endpoint
in that policy too. Keys are sent only to the explicitly selected allowed
host. Upstream errors are sanitized before reaching logs or clients.

Personal keys are AES-256-GCM encrypted in `user_ai_connections`. A lite host
automatically creates a random, owner-readable `data/user-ai.key` when the first
connection is stored. For separate workers or hosts, configure the same
`GOOBSTER_USER_AI_ENCRYPTION_KEY` everywhere: a base64-encoded random 32-byte key.
Supply it through your host's secret manager; do not commit it.

Back up the encryption key separately alongside the database: the ordinary
backup file sets do not include `user-ai.key`. Restoring the database without
the original key requires users to reconnect. Full backups contain encrypted
credential rows; protect the database and encryption key as secrets. Host
operators control the server and can decrypt stored credentials; encryption
protects database-only copies, not access by the host operator.

Account exports include URL/model preferences but exclude encrypted credentials.
**Forget me** removes the connection, key ciphertext and assignments for that
account. Another account's connection is preserved.
