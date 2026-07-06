"""Publisher interface — add new targets (Instagram, X, ...) by implementing this.

The default Telegram-channel target does NOT go through this layer: it is
published instantly by the Cloudflare Worker via Telegram's copyMessages call.
This layer exists for future targets that need server-side work. The Worker
routes any non-telegram target to a GitHub workflow_dispatch, which would call
`get_publisher(target).publish(...)` here.
"""

from abc import ABC, abstractmethod


class Publisher(ABC):
    @abstractmethod
    def publish(self, user_cfg: dict, caption: str, media_paths: list[str]) -> str:
        """Publish a post. Returns the URL of the published post."""


def get_publisher(target: str) -> Publisher:
    if target == "instagram":
        from .instagram_graph import InstagramGraphPublisher
        return InstagramGraphPublisher()
    raise ValueError(f"unknown publish target: {target}")
