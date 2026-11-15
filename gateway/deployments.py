"""Model deployments shared by inference routing and model discovery."""

from dataclasses import dataclass
from gateway.settings import settings


@dataclass(frozen=True)
class ModelDeployment:
    name: str
    service: str
    upstream: str
    paths: tuple[str, ...]
    input_modalities: tuple[str, ...]
    output_modalities: tuple[str, ...]
    reasoning_metadata: bool = False


MODEL_DEPLOYMENTS = (
    ModelDeployment(
        name="chat",
        service="qwen",
        upstream=settings.llm_url,
        paths=("/v1/chat/completions", "/v1/completions"),
        input_modalities=("text",),
        output_modalities=("text",),
        reasoning_metadata=True,
    ),
    ModelDeployment(
        name="embedding",
        service="qwen",
        upstream=settings.embedding_url,
        paths=("/v1/embeddings",),
        input_modalities=("text",),
        output_modalities=("embeddings",),
    ),
)
