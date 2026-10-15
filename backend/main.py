"""FastAPI WebSocket service for real-time ActionLens frame extraction."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, ValidationError

from vlm_engine import ActionLensVLM

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("actionlens")


class FrameMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    image: str


@asynccontextmanager
async def lifespan(app: FastAPI):
    # The hosted model is initialized as a lightweight API client; no weights are downloaded.
    try:
        app.state.engine = ActionLensVLM()
    except RuntimeError as exc:
        logger.warning("Gemini inference is not configured: %s", exc)
        app.state.engine = None
    app.state.model_busy = False
    yield


app = FastAPI(title="ActionLens API", version="1.0.0", lifespan=lifespan)
allowed_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "inference": "ready" if app.state.engine else "needs GEMINI_API_KEY",
        "model": os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite"),
    }


@app.websocket("/ws/stream")
async def stream(websocket: WebSocket) -> None:
    await websocket.accept()
    engine = app.state.engine
    if engine is None:
        await websocket.send_json({"error": "Backend is missing GEMINI_API_KEY. Configure it and restart the backend."})
        await websocket.close(code=1013)
        return

    inference_task: asyncio.Task[None] | None = None

    async def run_inference(encoded: str) -> None:
        try:
            result: dict[str, Any] = await asyncio.to_thread(engine.process_frame, encoded)
            await websocket.send_json(result)
        except ValueError as exc:
            await websocket.send_json({"error": str(exc)})
        except WebSocketDisconnect:
            return
        except Exception:
            logger.exception("Frame inference failed")
            try:
                await websocket.send_json({
                    "error": "Gemini inference failed. Check GEMINI_API_KEY, model availability, and Gemini API quota."
                })
            except Exception:
                pass
        finally:
            app.state.model_busy = False

    try:
        while True:
            message = await websocket.receive_json()
            try:
                frame = FrameMessage.model_validate(message)
            except ValidationError:
                await websocket.send_json({"error": "Expected a JSON object with an image base64 string."})
                continue
            if app.state.model_busy:
                # Tell the sender to release its in-flight slot; another request is not being processed.
                await websocket.send_json({"busy": True})
                continue
            app.state.model_busy = True
            inference_task = asyncio.create_task(run_inference(frame.image))
    except WebSocketDisconnect:
        # Let an in-flight GPU call finish before another client can use the model.
        # Its send will fail on the closed socket and the inference task clears model_busy.
        pass

