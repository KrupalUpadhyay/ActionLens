# ActionLens

ActionLens starts an 8-second scan when you tap **Scan now**. It captures up to one camera frame every two seconds (up to four images per session), sends at most one inference request at a time to a FastAPI backend, and displays an action extracted by Google's hosted Gemini vision model. The backend does not download model weights or need a GPU.

## Gemini API key

1. Create an API key in [Google AI Studio](https://aistudio.google.com/app/apikey).
2. The default model is `gemini-3.5-flash-lite`, a current multimodal model for new projects. Check [model availability](https://ai.google.dev/gemini-api/docs/models) and [current pricing and free-tier limits](https://ai.google.dev/gemini-api/docs/pricing) for your account and region.
3. The Gemini free tier is subject to quotas and availability. Google states that content sent on the free tier may be used to improve its products. Do not scan identity cards, passwords, receipts, or other sensitive material unless you are comfortable sending that image to Google's API under its applicable terms. Keep the key in the backend environment; never put it in a `VITE_*` variable or frontend code.

## Run the backend locally

Python 3.10 or newer is required. In PowerShell:

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:GEMINI_API_KEY = "your_google_ai_studio_key"
$env:CORS_ORIGINS = "http://localhost:5173"
uvicorn main:app --host 0.0.0.0 --port 8000
```

Optionally set `GEMINI_MODEL` before starting Uvicorn to use another Gemini model that accepts image input and structured output. `GET http://localhost:8000/health` reports whether the API key is configured. The key is read only by the backend.

## Run the frontend locally

In another terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open the Vite URL, allow camera access, point at an item, and tap **Scan now**. The frontend sends compressed JPEG frames during the 8-second session. Camera access requires HTTPS outside localhost; a local-network address such as `http://192.168.x.x:5173` is not a secure origin. Use the HTTPS deployed frontend from an external device and configure `VITE_WS_URL` to point it to a reachable secure backend.

For a deployed frontend, set `VITE_WS_URL` at build time to the backend WebSocket URL, such as `wss://api.example.com/ws/stream`. Set `CORS_ORIGINS` on the backend to the exact frontend origin. The repository-root `netlify.toml` contains the Netlify build settings.

## Docker

Build from the repository root:

```bash
docker build -t actionlens-backend ./backend
```

Run the container with `GEMINI_API_KEY` and `CORS_ORIGINS` set as environment variables. The container only runs the API client; inference happens through Google's hosted Gemini API.

## WebSocket contract

The client sends `{"image":"data:image/jpeg;base64,..."}` to `/ws/stream`. The backend returns one JSON object:

```json
{
  "detected": true,
  "category": "WIFI",
  "data": {"title": "Home Wi-Fi", "value": "example-password", "date": "", "email": ""},
  "bounding_box": [0.1, 0.2, 0.8, 0.7]
}
```

Categories are `WIFI`, `EVENT`, `CONTACT`, `TRACKING`, `RECEIPT`, and `NONE`. `data` always contains `title`, `value`, `date`, and `email`; inapplicable values are empty strings. Bounding-box coordinates are normalized from 0 to 1.
