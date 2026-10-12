"""Qwen2-VL inference and strict ActionLens response normalization."""

from __future__ import annotations

import base64
import binascii
import io
import json
import re
from typing import Any

import torch
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from transformers import AutoProcessor, BitsAndBytesConfig, Qwen2VLForConditionalGeneration


MODEL_ID = "Qwen/Qwen2-VL-2B-Instruct"
SYSTEM_PROMPT = '''You inspect a camera image and extract one useful action. Return ONLY one valid JSON object, without markdown, comments, or extra keys, matching exactly this schema:
{"detected":true,"category":"WIFI|EVENT|CONTACT|TRACKING|RECEIPT|NONE","data":{"title":"","value":"","date":"","email":""},"bounding_box":[0,0,1,1]}
Use detected=false and category=NONE with empty data and [0,0,0,0] when no actionable item is clearly visible. Choose exactly one category. WIFI: value is the password, title may identify the network. EVENT: title is the event name, date is the visible date/time in ISO 8601 when possible, value may be venue or useful detail. CONTACT: email contains the visible email; value may contain phone or name. TRACKING: value is the tracking number. RECEIPT: value is the total amount exactly as shown, including currency when visible, title may identify merchant. Never guess unreadable information; use empty strings. bounding_box is [x1,y1,x2,y2] normalized from 0 to 1 for the main actionable item, or all zeros when not detected.'''


class ActionData(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = ""
    value: str = ""
    date: str = ""
    email: str = ""


class Extraction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    detected: bool
    category: str
    data: ActionData = Field(default_factory=ActionData)
    bounding_box: list[float] = Field(min_length=4, max_length=4)


class ActionLensVLM:
    """Loads a quantized Qwen2-VL model and runs single-image extractions."""

    def __init__(self, model_id: str = MODEL_ID) -> None:
        if not torch.cuda.is_available():
            raise RuntimeError(
                "4-bit ActionLens inference requires a CUDA GPU and bitsandbytes. "
                "Run the backend on a CUDA-enabled Linux host."
            )
        quantization = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.float16,
        )
        self.processor = AutoProcessor.from_pretrained(model_id)
        self.model = Qwen2VLForConditionalGeneration.from_pretrained(
            model_id,
            quantization_config=quantization,
            device_map="auto",
            torch_dtype=torch.float16,
        ).eval()

    @staticmethod
    def _decode_image(encoded: str) -> Image.Image:
        if not isinstance(encoded, str) or not encoded:
            raise ValueError("image must be a non-empty base64 string")
        if encoded.startswith("data:"):
            try:
                header, encoded = encoded.split(",", 1)
            except ValueError as exc:
                raise ValueError("Malformed image data URL") from exc
            if ";base64" not in header:
                raise ValueError("Image data URL must use base64 encoding")
        try:
            raw = base64.b64decode(encoded, validate=True)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError("Image exceeds the 8 MiB limit")
            with Image.open(io.BytesIO(raw)) as image:
                image.load()
                return image.convert("RGB")
        except (binascii.Error, UnidentifiedImageError, OSError) as exc:
            raise ValueError("image is not a valid supported image") from exc

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
        # Fill optional strings so every server response has a stable frontend contract.
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
        image = self._decode_image(base64_image)
        messages = [
            {"role": "system", "content": [{"type": "text", "text": SYSTEM_PROMPT}]},
            {"role": "user", "content": [
                {"type": "image", "image": image},
                {"type": "text", "text": "Extract the most actionable visible information."},
            ]},
        ]
        prompt = self.processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        inputs = self.processor(text=[prompt], images=[image], padding=True, return_tensors="pt")
        device = next(self.model.parameters()).device
        inputs = {key: value.to(device) if hasattr(value, "to") else value for key, value in inputs.items()}
        with torch.inference_mode():
            generated = self.model.generate(**inputs, max_new_tokens=256, do_sample=False)
        prompt_length = inputs["input_ids"].shape[1]
        output = self.processor.batch_decode(
            generated[:, prompt_length:], skip_special_tokens=True, clean_up_tokenization_spaces=False
        )[0]
        return self._parse_result(output)
