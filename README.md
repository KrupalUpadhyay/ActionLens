# ActionLens

ActionLens streams compressed camera frames to a FastAPI service and returns normalized, structured actions. The model runs once per backend process; frames received during an active inference are discarded to keep GPU memory bounded.

## Backend

The backend requires a CUDA-enabled Linux host with a compatible NVIDIA driver for 4-bit bitsandbytes inference. Install dependencies from `backend/requirements.txt`, then run:

```bash
cd backend
python -m pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

The first startup downloads `Qwen/Qwen2-VL-2B-Instruct` from Hugging Face. Set `CORS_ORIGINS` to a comma-separated list of frontend origins (for example `https://your-site.netlify.app`). `ACTIONLENS_LOAD_MODEL=0` starts the API without loading the model for health checks; the WebSocket route then returns an explanatory error. `GET /health` reports service and model status.

Build the container from the repository root with `docker build -t actionlens-backend ./backend`. The runtime must have GPU access configured by the container platform.

## Frontend

```bash
cd frontend
npm install
npm run dev
```

Set `VITE_WS_URL` at build time to the backend WebSocket URL, such as `wss://api.example.com/ws/stream`. Without it, the app connects to port 8000 on the current hostname. Camera access requires HTTPS outside localhost. Netlify build settings are included in `frontend/netlify.toml`.

## WebSocket contract

The client sends `{"image":"data:image/jpeg;base64,..."}` to `/ws/stream`. Each completed extraction returns:

```json
{
  "detected": true,
  "category": "WIFI",
  "data": {"title": "Home Wi-Fi", "value": "example-password", "date": "", "email": ""},
  "bounding_box": [0.1, 0.2, 0.8, 0.7]
}
```

Categories are `WIFI`, `EVENT`, `CONTACT`, `TRACKING`, `RECEIPT`, and `NONE`. `data` always contains `title`, `value`, `date`, and `email`; each is an empty string when not applicable. Bounding box coordinates are normalized to the image dimensions.
