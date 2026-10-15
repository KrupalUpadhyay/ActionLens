"""Google Gemini hosted vision inference and ActionLens response normalization."""

from __future__ import annotations

import base64
import binascii
import io
import json
import os
import re
from typing import Any, Literal

from google import genai
from google.genai import types
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, ValidationError


MODEL_ID = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
GEMINI_RESPONSE_SCHEMA = types.Schema(
    type=types.Type.OBJECT,
    properties={
        "detected": types.Schema(type=types.Type.BOOLEAN),
        "category": types.Schema(
            type=types.Type.STRING,
            enum=["WIFI", "EVENT", "CONTACT", "TRACKING", "RECEIPT", "NONE"],
        ),
        "data": types.Schema(
            type=types.Type.OBJECT,
            properties={
                "title": types.Schema(type=types.Type.STRING),
                "value": types.Schema(type=types.Type.STRING),
                "date": types.Schema(type=types.Type.STRING),
                "email": types.Schema(type=types.Type.STRING),
            },
            required=["title", "value", "date", "email"],
        ),
        "bounding_box": types.Schema(
            type=types.Type.ARRAY,
            items=types.Schema(type=types.Type.NUMBER),
            min_items=4,
            max_items=4,
        ),
    },
    required=["detected", "category", "data", "bounding_box"],
)
SYSTEM_PROMPT = '''Inspect the supplied camera image and extract at most one useful action. Return ONLY one valid JSON object, without markdown, comments, or extra keys, matching exactly this schema:
{"detected":true,"category":"WIFI|EVENT|CONTACT|TRACKING|RECEIPT|NONE","data":{"title":"","value":"","date":"","email":""},"bounding_box":[0,0,1,1]}
Use detected=false and category=NONE with empty data and [0,0,0,0] when no actionable item is clearly visible. Choose exactly one category. WIFI: value is the password, title may identify the network. EVENT: title is the event name, date is the visible date/time in ISO 8601 when possible, value may be venue or useful detail. CONTACT: put email in email ONLY when the text visibly contains a real email address with @ and a domain (for example name@example.com). Never put a phone number or other text in email. Put a visible phone number in value, and a person's name in title. A phone-only business card is still CONTACT with email empty and phone in value. TRACKING: value is the tracking number. RECEIPT: value is the total amount exactly as shown, including currency when visible, title may identify merchant. Never guess unreadable information; use empty strings. bounding_box is [x1,y1,x2,y2] normalized from 0 to 1 for the main actionable item, or all zeros when not detected.'''


class ActionData(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = ""
    value: str = ""
    date: str = ""
    email: str = ""


class Extraction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    detected: bool
    category: Literal["WIFI", "EVENT", "CONTACT", "TRACKING", "RECEIPT", "NONE"]
    data: ActionData = Field(default_factory=ActionData)
    bounding_box: list[float] = Field(min_length=4, max_length=4)


class ActionLensVLM:
    """Calls Gemini's hosted vision API; no local model/GPU is loaded."""

    def __init__(self, model_id: str = MODEL_ID, api_key: str | None = None) -> None:
        key = api_key or os.getenv("GEMINI_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY is not set. Create an API key in Google AI Studio.")
        self.model_id = model_id
        self.client = genai.Client(api_key=key, http_options=types.HttpOptions(timeout=90000))

    @staticmethod
    def _decode_image(encoded: str) -> tuple[str, bytes]:
        if not isinstance(encoded, str) or not encoded:
            raise ValueError("image must be a non-empty base64 string")
        mime_type = "image/jpeg"
        if encoded.startswith("data:"):
            try:
                header, encoded = encoded.split(",", 1)
            except ValueError as exc:
                raise ValueError("Malformed image data URL") from exc
            if ";base64" not in header:
                raise ValueError("Image data URL must use base64 encoding")
            mime_type = header[5:].split(";", 1)[0].lower()
            if mime_type not in {"image/jpeg", "image/png", "image/webp"}:
                raise ValueError("Only JPEG, PNG, and WebP images are supported")
        try:
            raw = base64.b64decode(encoded, validate=True)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError("Image exceeds the 8 MiB limit")
            with Image.open(io.BytesIO(raw)) as image:
                image.verify()
        except (binascii.Error, UnidentifiedImageError, OSError) as exc:
            raise ValueError("image is not a valid supported image") from exc
        return mime_type, raw

    @staticmethod
    def _parse_result(raw: str) -> dict[str, Any]:
        candidate = raw.strip()
        if candidate.startswith("```"):
            candidate = re.sub(r"^```(?:json)?\s*|\s*```$", "", candidate, flags=re.I)
        try:
            decoded = json.loads(candidate)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", candidate, flags=re.S)
            if not match:
                return ActionLensVLM._empty_result()
            try:
                decoded = json.loads(match.group(0))
            except json.JSONDecodeError:
                return ActionLensVLM._empty_result()

        if not isinstance(decoded, dict):
            return ActionLensVLM._empty_result()
        raw_data = decoded.get("data")
        if not isinstance(raw_data, dict):
            raw_data = {}
        payload = {
            "detected": decoded.get("detected", False),
            "category": decoded.get("category", "NONE"),
            "data": {
                key: raw_data.get(key, "") if isinstance(raw_data.get(key, ""), str) else ""
                for key in ("title", "value", "date", "email")
            },
            "bounding_box": decoded.get("bounding_box", [0, 0, 0, 0]),
        }
        try:
            result = Extraction.model_validate(payload)
        except ValidationError:
            return ActionLensVLM._empty_result()
        if result.category not in {"WIFI", "EVENT", "CONTACT", "TRACKING", "RECEIPT", "NONE"}:
            return ActionLensVLM._empty_result()
        if not result.detected or result.category == "NONE":
            return ActionLensVLM._empty_result()
        if result.category == "CONTACT":
            email = result.data.email.strip().strip(".,;:()[]{}<>")
            if re.fullmatch(r"[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+", email, flags=re.I):
                result.data.email = email
            else:
                # Keep a phone number as a contact value, never expose it as an email.
                phone_candidate = email
                if len(re.sub(r"\D", "", phone_candidate)) >= 7 and re.fullmatch(r"[+()\d.\-\s]+", phone_candidate):
                    if not result.data.value:
                        result.data.value = phone_candidate
                result.data.email = ""
        result.bounding_box = [min(1.0, max(0.0, float(n))) for n in result.bounding_box]
        return result.model_dump()

    @staticmethod
    def _empty_result() -> dict[str, Any]:
        return {
            "detected": False,
            "category": "NONE",
            "data": {"title": "", "value": "", "date": "", "email": ""},
            "bounding_box": [0, 0, 0, 0],
        }

    def process_frame(self, base64_image: str) -> dict[str, Any]:
        mime_type, image_bytes = self._decode_image(base64_image)
        response = self.client.models.generate_content(
            model=self.model_id,
            contents=[
                types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
                "Extract the most actionable visible information from this image.",
            ],
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                response_mime_type="application/json",
                response_schema=GEMINI_RESPONSE_SCHEMA,
                max_output_tokens=220,
                temperature=0,
            ),
        )
        content = response.text
        if not isinstance(content, str):
            return self._empty_result()
        return self._parse_result(content)
